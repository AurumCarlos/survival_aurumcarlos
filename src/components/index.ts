import { defineComponent } from '../core/ecs/World';
import type { CraftingStation } from '../data/recipes';
import type { InventoryGridData, PlaceableKind, Resource, Survivor, ThermalExposure, Vec3 } from '../data/schema';

/**
 * Engine-free components. Nothing here imports three or cannon-es; the render
 * and physics layers attach their own handle components (see
 * render/components.ts and physics/components.ts).
 */

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/**
 * Authoritative simulation transform.
 *
 * `prev*` holds the state at the start of the most recent fixed step. The
 * render layer interpolates prev → current by the loop's alpha so visuals are
 * smooth even though the sim advances in discrete 1/60 s jumps.
 */
export interface Transform {
  position: Vec3;
  rotation: Quat;
  prevPosition: Vec3;
  prevRotation: Quat;
  scale: Vec3;
}

export function makeTransform(x = 0, y = 0, z = 0): Transform {
  return {
    position: { x, y, z },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    prevPosition: { x, y, z },
    prevRotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  };
}

export const Transform = defineComponent<Transform>('Transform');

/** The survival data model lives on the entity as-is. */
export const SurvivorC = defineComponent<Survivor>('Survivor');

/** Per-tick thermal context, written by EnvironmentSystem, read by SurvivalSystem. */
export const Exposure = defineComponent<ThermalExposure>('Exposure');

export interface PlayerControlled {
  yaw: number;
  pitch: number;
  eyeHeight: number;
  crouchEyeHeight: number;
  /** Planar velocity requested this tick, consumed by the physics system. */
  desiredVelocity: { x: number; z: number };
  wantsJump: boolean;
  grounded: boolean;
  /** Written by PhysicsSystem: the player is in water too deep to stand in. */
  swimming: boolean;
}
export const PlayerControlled = defineComponent<PlayerControlled>('PlayerControlled');

export const ResourceC = defineComponent<Resource>('Resource');

export interface HeatSource {
  /** Warmth at the centre, in °C added to ambient. */
  peakWarmthC: number;
  /** Beyond this distance the source contributes nothing. */
  radius: number;
  lit: boolean;
  /** Seconds of fuel left; Infinity for permanent sources. */
  fuelSeconds: number;
  /** Fires make light and noise — wolves avoid them at night. */
  scaresCreatures: boolean;
  /** Can be used as a crafting station while lit. */
  isStation: CraftingStation | null;
}
export const HeatSource = defineComponent<HeatSource>('HeatSource');

/**
 * A placed structure (campfire, storage box, forge…). Fuel-burning ones also
 * carry a HeatSource (its `lit` / `fuelSeconds` are the fire's state).
 */
export interface Structure {
  kind: PlaceableKind;
  yaw: number;
  /** Items inside (storage, fuel, things to cook/smelt). Null if it has no inventory. */
  container: InventoryGridData | null;
  /** Current cooking/smelting batch. */
  processing: { recipeId: string | null; progress: number };
}
export const Structure = defineComponent<Structure>('Structure');

export interface ShelterZone {
  /** Axis-aligned volume around the entity's Transform. */
  halfExtents: Vec3;
  /** 0..1, fraction of the gap to comfortable temperature it closes. */
  insulation: number;
  /** Shelters also block rain (sets `wet` false). */
  roof: boolean;
}
export const ShelterZone = defineComponent<ShelterZone>('ShelterZone');

export interface Interactable {
  prompt: string;
  range: number;
}
export const Interactable = defineComponent<Interactable>('Interactable');

export type CreatureSpecies = 'wolf' | 'deer' | 'boar' | 'crocodile' | 'bear';

export interface Creature {
  species: CreatureSpecies;
  health: number;
  maxHealth: number;
  walkSpeed: number;
  runSpeed: number;
  attackDamage: number;
  attackRange: number;
  attackCooldown: number;
  attackTimer: number;
  /** Predators hunt the player; prey flee on sight. */
  temperament: 'predator' | 'prey' | 'territorial';
  /** Flee below this fraction of max health. */
  fleeHealthFraction: number;
  perception: Perception;
  /** Facing angle on the XZ plane (radians). */
  heading: number;
  /** Young animals grow from ~0.2 to 1 (adult). Undefined = adult. */
  growth?: number;
}
export const Creature = defineComponent<Creature>('Creature');

export interface Perception {
  /** Daylight sight distance (m). Scaled by light level at night. */
  sightRange: number;
  /** Full field-of-view angle (radians). */
  fov: number;
  /** Multiplier on noise radii the creature receives. */
  hearing: number;
  /**
   * Detection is not instant: awareness fills while the target is perceived
   * and drains otherwise. ≥ 1 = detected. This gives the player a window to
   * duck behind a tree, which is what makes stealth feel fair.
   */
  awareness: number;
  /** Seconds to fill awareness from 0 to 1 at full visibility. */
  reactionTime: number;
  canSeeTarget: boolean;
  lastKnownTargetPos: Vec3 | null;
  /** Seconds since lastKnownTargetPos was refreshed. */
  lastKnownAge: number;
  /** Strongest noise heard this tick (normalised 0..1), for debugging/UI. */
  heardNoise: number;
}

export function makePerception(partial: Partial<Perception> = {}): Perception {
  return {
    sightRange: 28, fov: (130 * Math.PI) / 180, hearing: 1, awareness: 0, reactionTime: 1.2,
    canSeeTarget: false, lastKnownTargetPos: null, lastKnownAge: Number.POSITIVE_INFINITY, heardNoise: 0,
    ...partial,
  };
}

/** Tag for things the culling system may hide when off-screen/far away. */
export interface Cullable {
  /** Bounding sphere radius in world units. */
  radius: number;
  /** Beyond this, the object is hidden even inside the frustum. */
  maxDistance: number;
  visible: boolean;
}
export const Cullable = defineComponent<Cullable>('Cullable');

/** Generic timed lifetime (projectiles, corpses). */
export interface Lifetime {
  remaining: number;
}
export const Lifetime = defineComponent<Lifetime>('Lifetime');

/** Player-side stealth readout, written by PerceptionSystem, shown on the HUD. */
export interface StealthState {
  /** Radius (m) of the noise the player made this tick. */
  noiseRadius: number;
  /** Highest awareness (0..1+) any creature currently has of the player. */
  maxAwareness: number;
  /** True if at least one hostile has fully detected the player. */
  detected: boolean;
  /** Extra one-shot noise to add this tick (harvesting, landing, combat). */
  pendingNoise: number;
}
export const StealthState = defineComponent<StealthState>('StealthState');

export interface AIBrain {
  /** Key into the behaviour-tree registry; trees are shared per species. */
  tree: string;
  blackboard: Blackboard;
  /**
   * Simulation level of detail, set by AILodSystem each tick. Dormant
   * creatures keep all their state but skip perception, behaviour and movement.
   */
  lod: 'active' | 'dormant';
}
export const AIBrain = defineComponent<AIBrain>('AIBrain');

export type AIState = 'patrol' | 'chase' | 'hunt' | 'flee' | 'attack';

export interface Blackboard {
  state: AIState;
  home: Vec3;
  waypoints: Vec3[];
  waypointIndex: number;
  /** Seconds to wait at the current waypoint before moving on. */
  idleTimer: number;
  /** Where the hunt is currently searching. */
  searchPoint: Vec3 | null;
  searchTimer: number;
  /** Flee persists for a minimum time so creatures don't dither at the threshold. */
  fleeTimer: number;
  fleeFrom: Vec3 | null;
  /** Deterministic per-creature RNG state (mulberry32 seed). */
  rngState: number;
  /** Seconds spent making no progress toward the current move target. */
  stuckTimer: number;
  /** Crocodile / bear behaviour (ApexSystem), saved with the blackboard. */
  apex?: ApexState;
}

/**
 * Mode of the two big predators (see systems/ai/ApexSystem.ts). The render
 * layer reads it to pick the animation (swim, lurk, lunge, sleep, roar…).
 */
export type ApexMode =
  | 'swim' | 'lurk' | 'stalk' | 'lunge' | 'bite' | 'crawl' | 'return' // crocodile
  | 'sleep' | 'wake' | 'roar' | 'charge' | 'swipe' | 'roam' | 'home'; // bear

export interface ApexState {
  mode: ApexMode;
  /** Seconds in the current mode. */
  t: number;
  /** Seconds left before the next bite/swipe. */
  cooldown: number;
  /** Crocodile: angle around the island it is patrolling toward. Bear: unused. */
  angle: number;
  /** Crocodile: seconds spent out of the water this excursion. */
  landTime: number;
  /** Where it is heading (patrol target). */
  target: Vec3 | null;
  /** Bear: its cave (chamber centre, mouth direction). */
  den: { x: number; y: number; z: number; yaw: number; length: number; width: number; height: number } | null;
}
