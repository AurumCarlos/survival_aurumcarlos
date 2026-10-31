import type { Entity, World } from '../core/ecs/World';
import { SpatialHash } from '../core/SpatialHash';
import { AIBrain, Creature, Transform, type CreatureSpecies } from '../components';
import { defaultApex } from '../systems/ai/ApexSystem';
import type { ResourceKind } from '../data/schema';
import { spawnCreature, spawnResource } from '../entities/factories';
import { NavGrid } from '../systems/ai/nav/NavGrid';
import { creatureBudget, type MapConfig } from './MapConfig';
import { mulberry32 } from './Noise';
import type { TerrainBundle } from './TerrainCodec';
import { sampleHeight } from './TerrainGenerator';

const HARVESTABLE: ReadonlySet<string> = new Set<ResourceKind>([
  'tree', 'rock', 'berry_bush', 'fiber_plant', 'water_source', 'mushroom', 'metal_rock', 'obsidian_rock', 'crystal',
  'oil_rock', 'shell_bed', 'salt_deposit', 'rare_flower', 'fish_shoal',
]);

export interface PopulatedWorld {
  /** Harvestables indexed by position for the interaction system. */
  resourceIndex: SpatialHash;
  /**
   * Stable IDs for generated resources: the prop's index in the (deterministic)
   * placement list. Entity numbers differ between
   * sessions; stable IDs don't, so saves reference these.
   */
  stableToEntity: Map<number, Entity>;
  entityToStable: Map<Entity, number>;
  nav: NavGrid;
}

/**
 * Engine-free world population: creates every harvestable resource entity
 * from terrain data. No meshes, no bodies — the render and physics layers
 * attach those separately, and the headless simulation uses this as-is.
 */
export function populateResources(world: World, bundle: TerrainBundle): PopulatedWorld {
  const { terrain } = bundle;
  const resourceIndex = new SpatialHash(8);
  const stableToEntity = new Map<number, Entity>();
  const entityToStable = new Map<Entity, number>();
  const link = (id: number, e: Entity, x: number, z: number): void => {
    stableToEntity.set(id, e);
    entityToStable.set(e, id);
    resourceIndex.insert(e, x, z);
  };

  terrain.props.forEach((p, i) => {
    if (!HARVESTABLE.has(p.kind)) return;
    const e = spawnResource(world, p.kind as ResourceKind, p.position, p.variant);
    link(i, e, p.position.x, p.position.z);
  });

  // Drinkable water comes from the generator's pond props (not the sea), so it is covered above.
  return { resourceIndex, stableToEntity, entityToStable, nav: new NavGrid(bundle.nav) };
}

/** Fresh-game creature placement: walkable cells only, away from spawn. */
export function spawnInitialCreatures(world: World, bundle: TerrainBundle, map: MapConfig, nav: NavGrid): Entity[] {
  const { terrain } = bundle;
  const rand = mulberry32(map.seed + 99);
  const budget = creatureBudget(map);
  const out: Entity[] = [];
  const spawnSome = (species: CreatureSpecies, count: number, minDist: number): void => {
    let placed = 0, tries = 0;
    while (placed < count && tries++ < count * 80) {
      const x = (rand() - 0.5) * terrain.cfg.size * 0.8;
      const z = (rand() - 0.5) * terrain.cfg.size * 0.8;
      const sp = terrain.spawn;
      if (Math.hypot(x - sp.x, z - sp.z) < minDist || !nav.isWalkable(x, z)) continue;
      out.push(spawnCreature(world, species, { x, y: sampleHeight(terrain, x, z), z }, Math.floor(rand() * 1e9)));
      placed++;
    }
  };
  const minDist = Math.min(45, terrain.cfg.size * 0.2);
  spawnSome('wolf', budget.wolf, minDist);
  spawnSome('deer', budget.deer, minDist * 0.6);
  spawnSome('boar', budget.boar, minDist * 0.8);
  out.push(...spawnApexPredators(world, bundle, map, []));
  return out;
}

/**
 * Crocodiles in the lagoon around the island (1 per 50 m of map edge, at least 3) and
 * a bear asleep in every cave. `existing` lists apex creatures already in the
 * world (a loaded save): only what's missing is added, so loading a save made
 * before they existed brings them in, and loading a newer one changes nothing.
 */
export function spawnApexPredators(world: World, bundle: TerrainBundle, map: MapConfig, existing: CreatureSpecies[]): Entity[] {
  const { terrain } = bundle;
  const W = terrain.cfg.waterLevel;
  const rand = mulberry32(map.seed + 4242);
  const out: Entity[] = [];
  const wantCrocs = Math.max(3, Math.round(map.size / 50)); // 128 m: 3 · 256 m: 5 · 512 m: 10
  const haveCrocs = existing.filter((s) => s === 'crocodile').length;
  const sp = terrain.spawn;
  for (let n = haveCrocs, tries = 0; n < wantCrocs && tries < 200; tries++) {
    const ang = rand() * Math.PI * 2;
    // Walk out from the centre to the first deep water, then a few metres more.
    let r = terrain.cfg.size * 0.1;
    while (r < terrain.cfg.size / 2 - 4 && sampleHeight(terrain, Math.cos(ang) * r, Math.sin(ang) * r) > W - 0.7) r += 1;
    r += 1 + rand() * 3;
    const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
    if (r >= terrain.cfg.size / 2 - 2 || Math.hypot(x - sp.x, z - sp.z) < 30) continue;
    const e = spawnCreature(world, 'crocodile', { x, y: W - 0.55, z }, Math.floor(rand() * 1e9), 0);
    const a = defaultApex('swim');
    a.angle = ang;
    world.require(e, AIBrain).blackboard.apex = a;
    faceHeading(world, e, ang + Math.PI / 2);
    out.push(e);
    n++;
  }
  const haveBears = existing.filter((s) => s === 'bear').length;
  (terrain.caves ?? []).slice(haveBears).forEach((c) => {
    const ax = Math.sin(c.yaw), az = Math.cos(c.yaw);
    const x = c.x + ax * (c.length / 2 - 3.2), z = c.z + az * (c.length / 2 - 3.2);
    const e = spawnCreature(world, 'bear', { x, y: c.y, z }, Math.floor(rand() * 1e9), 0);
    const a = defaultApex('sleep');
    a.den = { x: c.x, y: c.y, z: c.z, yaw: c.yaw, length: c.length, width: c.width, height: c.height };
    world.require(e, AIBrain).blackboard.apex = a;
    faceHeading(world, e, c.yaw + Math.PI); // facing the entrance
    out.push(e);
  });
  return out;
}

/** Set heading and the matching rotation (current and previous), so the first rendered frame doesn't spin. */
function faceHeading(world: World, e: Entity, heading: number): void {
  world.require(e, Creature).heading = heading;
  const t = world.require(e, Transform);
  t.rotation = { x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) };
  t.prevRotation = { ...t.rotation };
}
