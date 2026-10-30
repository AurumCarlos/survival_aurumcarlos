import type { Entity, World } from '../core/ecs/World';
import {
  AIBrain, Creature, Cullable, HeatSource, Interactable, PlayerControlled, ResourceC, ShelterZone, StealthState,
  Structure, SurvivorC, Transform, makePerception, makeTransform, type CreatureSpecies,
} from '../components';
import { STRUCTURES } from '../data/stations';
import type { InventoryGridData, PlaceableKind } from '../data/schema';
import { makeResource } from '../data/items';
import type { ResourceKind, Vec3 } from '../data/schema';
import { makeBlackboard } from '../systems/ai/AISystem';
import { createSurvivor } from '../systems/SurvivalStatusManager';

/**
 * Engine-free entity templates: they create the *simulation* side of an
 * entity. The render/physics layers attach meshes and bodies afterwards
 * (see render/WorldBuilder.ts), so the same factories work headless.
 */

export function spawnPlayer(world: World, pos: Vec3, name = 'Survivor'): Entity {
  const e = world.create();
  world.add(e, Transform, makeTransform(pos.x, pos.y, pos.z));
  world.add(e, SurvivorC, createSurvivor(e, name));
  world.add(e, PlayerControlled, {
    yaw: 0, pitch: 0, eyeHeight: 1.6, crouchEyeHeight: 1.0,
    desiredVelocity: { x: 0, z: 0 }, wantsJump: false, grounded: false, swimming: false,
  });
  world.add(e, StealthState, { noiseRadius: 0, maxAwareness: 0, detected: false, pendingNoise: 0 });
  return e;
}

const SPECIES: Record<CreatureSpecies, Omit<Creature, 'perception' | 'heading'> & { perception: Parameters<typeof makePerception>[0] }> = {
  crocodile: {
    species: 'crocodile', health: 180, maxHealth: 180, walkSpeed: 1.3, runSpeed: 7.5,
    attackDamage: 28, attackRange: 2.4, attackCooldown: 2.2, attackTimer: 0,
    temperament: 'predator', fleeHealthFraction: 0.25,
    perception: { sightRange: 22, hearing: 1.2, reactionTime: 0.8, fov: (220 * Math.PI) / 180 },
  },
  bear: {
    species: 'bear', health: 320, maxHealth: 320, walkSpeed: 1.4, runSpeed: 7,
    attackDamage: 32, attackRange: 2.5, attackCooldown: 1.6, attackTimer: 0,
    temperament: 'territorial', fleeHealthFraction: 0.12,
    perception: { sightRange: 18, hearing: 1.4, reactionTime: 1.0 },
  },
  wolf: {
    species: 'wolf', health: 60, maxHealth: 60, walkSpeed: 1.5, runSpeed: 5.4,
    attackDamage: 12, attackRange: 1.6, attackCooldown: 1.2, attackTimer: 0,
    temperament: 'predator', fleeHealthFraction: 0.3,
    perception: { sightRange: 30, hearing: 1.4, reactionTime: 0.9 },
  },
  deer: {
    species: 'deer', health: 40, maxHealth: 40, walkSpeed: 1.2, runSpeed: 6.3,
    attackDamage: 0, attackRange: 0, attackCooldown: 1, attackTimer: 0,
    temperament: 'prey', fleeHealthFraction: 1,
    perception: { sightRange: 35, hearing: 1.8, reactionTime: 0.6, fov: (300 * Math.PI) / 180 },
  },
  boar: {
    species: 'boar', health: 80, maxHealth: 80, walkSpeed: 1.3, runSpeed: 4.6,
    attackDamage: 15, attackRange: 1.4, attackCooldown: 1.5, attackTimer: 0,
    temperament: 'territorial', fleeHealthFraction: 0.2,
    perception: { sightRange: 18, hearing: 1, reactionTime: 1.5 },
  },
};

/** Adult stats of a species (babies scale from these as they grow). */
export function speciesStats(species: CreatureSpecies): Readonly<Omit<Creature, 'perception' | 'heading'>> {
  return SPECIES[species];
}

export function spawnCreature(world: World, species: CreatureSpecies, home: Vec3, seed: number, patrolRadius = 14): Entity {
  const e = world.create();
  const t = SPECIES[species];
  world.add(e, Transform, makeTransform(home.x, home.y, home.z));
  world.add(e, Creature, { ...t, perception: makePerception(t.perception), heading: (seed % 628) / 100 });
  // Patrol loop: a few points on a jittered circle around home.
  const waypoints: Vec3[] = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + (seed % 7) * 0.3;
    const r = patrolRadius * (0.6 + ((seed >> i) & 3) * 0.15);
    waypoints.push({ x: home.x + Math.cos(a) * r, y: home.y, z: home.z + Math.sin(a) * r });
  }
  world.add(e, AIBrain, {
    // Crocodiles and bears have their own brains (ApexSystem); the others share behaviour trees.
    tree: species === 'crocodile' || species === 'bear' ? species : t.temperament === 'prey' ? 'prey' : 'predator',
    blackboard: makeBlackboard(home, waypoints, seed),
    lod: 'active',
  });
  world.add(e, Cullable, { radius: species === 'crocodile' ? 2.6 : species === 'bear' ? 1.8 : 1.2, maxDistance: 120, visible: true });
  return e;
}

export function spawnResource(world: World, kind: ResourceKind, pos: Vec3, variant = 0): Entity {
  const e = world.create();
  world.add(e, Transform, makeTransform(pos.x, pos.y, pos.z));
  world.add(e, ResourceC, makeResource(e, kind, pos, variant));
  world.add(e, Interactable, { prompt: `Harvest ${kind.replace('_', ' ')}`, range: 2.8 });
  return e;
}

/**
 * Any placeable structure. Fuel-burning ones get a HeatSource; the campfire
 * starts lit with 10 minutes of fuel (so a fresh fire is useful at once),
 * forges and pots start cold and empty.
 */
export function spawnStructure(
  world: World, kind: PlaceableKind, pos: Vec3,
  opts: { yaw?: number; container?: InventoryGridData | null; lit?: boolean; fuelSeconds?: number } = {},
): Entity {
  const def = STRUCTURES[kind];
  const e = world.create();
  world.add(e, Transform, makeTransform(pos.x, pos.y, pos.z));
  world.add(e, Structure, {
    kind, yaw: opts.yaw ?? 0,
    container: opts.container ?? (def.slots ? { cols: def.slots.cols, rows: def.slots.rows, placements: [] } : null),
    processing: { recipeId: null, progress: 0 },
  });
  if (def.fuel) {
    const campfire = kind === 'campfire';
    world.add(e, HeatSource, {
      peakWarmthC: def.heat?.peakWarmthC ?? 0, radius: def.heat?.radius ?? 0.01,
      lit: opts.lit ?? campfire, fuelSeconds: opts.fuelSeconds ?? (campfire ? 600 : 0),
      scaresCreatures: def.heat?.scaresCreatures ?? false,
      isStation: def.craftStation === 'campfire' || def.craftStation === 'fabricator' ? def.craftStation : null,
    });
  }
  if (kind === 'lean_to') world.add(e, ShelterZone, { halfExtents: { x: 1.6, y: 2, z: 1.4 }, insulation: 0.45, roof: true });
  world.add(e, Interactable, { prompt: def.label, range: 2.5 });
  return e;
}

export function spawnCampfire(world: World, pos: Vec3, fuelSeconds = 600): Entity {
  return spawnStructure(world, 'campfire', pos, { fuelSeconds, lit: true });
}

export function spawnLeanTo(world: World, pos: Vec3): Entity {
  return spawnStructure(world, 'lean_to', pos);
}
