import type { Entity, World } from '../core/ecs/World';
import {
  AIBrain, Creature, HeatSource, PlayerControlled, ResourceC, Structure, SurvivorC, Transform,
  type AIState, type Blackboard, type CreatureSpecies,
} from '../components';
import { PLACEABLE_KINDS } from '../data/stations';
import { applyGrowth } from '../systems/ai/BreedingSystem';
import { ITEMS } from '../data/items';
import type { InventoryGridData, PlaceableKind, Survivor, Vec3 } from '../data/schema';
import { spawnCreature, spawnPlayer, spawnStructure } from '../entities/factories';
import type { DayNightCycle } from '../systems/DayNightCycle';
import { parseMapConfig, type MapConfig } from '../world/MapConfig';
import type { PopulatedWorld } from '../world/WorldPopulator';
import type { BuildingGrid, Piece } from '../systems/building/BuildingGrid';
import { spawnResource } from '../entities/factories';

/**
 * JSON world schema.
 *
 * The terrain itself is NOT stored: it is regenerated from `map` (seed +
 * size), which is deterministic. A snapshot only records what the player
 * changed, keeping saves at a few KB instead of megabytes.
 *
 * Bump SNAPSHOT_VERSION on any breaking change and add a step to migrate().
 */
export const SNAPSHOT_VERSION = 4;

export interface WorldSnapshot {
  version: 3 | typeof SNAPSHOT_VERSION;
  savedAt: number;
  map: MapConfig;
  clock: { totalHours: number };
  player: { position: Vec3; yaw: number; pitch: number; survivor: Survivor };
  /** Only resources that differ from freshly-generated: [stableId, hitPoints, respawnTimer]. */
  resources: Array<[number, number, number]>;
  carcasses: Array<{ position: Vec3; hitPoints: number; variant?: number }>;
  /** Placed structures (v4: any placeable, with yaw, contents and fire state; v3 had only campfire/lean-to). */
  structures: Array<{
    kind: PlaceableKind;
    position: Vec3;
    yaw?: number;
    fuelSeconds?: number;
    lit?: boolean;
    container?: InventoryGridData | null;
    processing?: { recipeId: string | null; progress: number };
  }>;
  creatures: Array<{
    /** Young animals (0..1); absent = adult. */
    growth?: number;
    species: CreatureSpecies;
    position: Vec3;
    heading: number;
    health: number;
    blackboard: Blackboard;
    awareness: number;
    lastKnownTargetPos: Vec3 | null;
  }>;
  /** Player-built pieces (v2+). Entity ids are reassigned on load. */
  buildings: Array<Omit<Piece, 'id'>>;
  /** Free-form summary shown on the "Continue" button. */
  summary: { day: number; secondsSurvived: number };
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export interface CaptureContext {
  map: MapConfig;
  cycle: DayNightCycle;
  populated: PopulatedWorld;
  buildings?: BuildingGrid;
}

export function captureSnapshot(world: World, ctx: CaptureContext): WorldSnapshot {
  const player = world.first(PlayerControlled, SurvivorC, Transform);
  if (player === undefined) throw new SnapshotError('No player to save');
  const pc = world.require(player, PlayerControlled);
  const survivor = world.require(player, SurvivorC);

  const resources: WorldSnapshot['resources'] = [];
  for (const [e, id] of ctx.populated.entityToStable) {
    const r = world.get(e, ResourceC);
    if (r && !r.infinite && (r.hitPoints !== r.maxHitPoints || r.respawnTimer > 0)) {
      resources.push([id, r.hitPoints, round(r.respawnTimer)]);
    }
  }

  const carcasses: WorldSnapshot['carcasses'] = [];
  for (const e of world.query(ResourceC)) {
    const r = world.require(e, ResourceC);
    if (r.kind === 'carcass' && !ctx.populated.entityToStable.has(e)) {
      carcasses.push({ position: vec(r.position), hitPoints: r.hitPoints, variant: r.variant });
    }
  }

  const structures: WorldSnapshot['structures'] = [];
  for (const e of world.query(Structure, Transform)) {
    const st = world.require(e, Structure);
    const h = world.get(e, HeatSource);
    structures.push({
      kind: st.kind, position: vec(world.require(e, Transform).position), yaw: round(st.yaw),
      container: st.container ? structuredCloneSafe(st.container) : null,
      processing: { ...st.processing },
      ...(h ? { fuelSeconds: round(h.fuelSeconds), lit: h.lit } : {}),
    });
  }

  const creatures: WorldSnapshot['creatures'] = [];
  for (const e of world.query(Creature, AIBrain, Transform)) {
    const c = world.require(e, Creature);
    if (c.health <= 0) continue;
    creatures.push({
      ...(c.growth !== undefined ? { growth: c.growth } : {}),
      species: c.species,
      position: vec(world.require(e, Transform).position),
      heading: c.heading,
      health: c.health,
      blackboard: structuredCloneSafe(world.require(e, AIBrain).blackboard),
      awareness: c.perception.awareness,
      lastKnownTargetPos: c.perception.lastKnownTargetPos ? vec(c.perception.lastKnownTargetPos) : null,
    });
  }

  return {
    version: SNAPSHOT_VERSION,
    savedAt: Date.now(),
    map: { ...ctx.map },
    clock: { totalHours: ctx.cycle.totalHours },
    player: { position: vec(world.require(player, Transform).position), yaw: pc.yaw, pitch: pc.pitch, survivor: structuredCloneSafe(survivor) },
    resources,
    carcasses,
    structures,
    creatures,
    buildings: ctx.buildings
      ? [...ctx.buildings.pieces()].map(({ id: _id, ...rest }) => ({ ...rest }))
      : [],
    summary: { day: ctx.cycle.day, secondsSurvived: survivor.stats.secondsSurvived },
  };
}

// ---------------------------------------------------------------------------
// Serialise / parse (JSON with Infinity support)
// ---------------------------------------------------------------------------

/**
 * JSON has no Infinity: JSON.stringify(Infinity) is `null`, which would turn
 * every condition-based status effect (remaining = Infinity) into an effect
 * that expires immediately on load. We encode it as a sentinel string.
 */
const INF = '__+Inf__';
const NEG_INF = '__-Inf__';

export function serializeSnapshot(s: WorldSnapshot): string {
  return JSON.stringify(s, (_k, v: unknown) =>
    v === Number.POSITIVE_INFINITY ? INF : v === Number.NEGATIVE_INFINITY ? NEG_INF : v,
  );
}

export function parseSnapshot(json: string): WorldSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(json, (_k, v: unknown) => (v === INF ? Number.POSITIVE_INFINITY : v === NEG_INF ? Number.NEGATIVE_INFINITY : v));
  } catch {
    throw new SnapshotError('Save file is not valid JSON (it may have been truncated).');
  }
  return validateSnapshot(migrate(raw));
}

/** Upgrade older save formats in place, or refuse them with a clear reason. */
function migrate(raw: unknown): unknown {
  if (!isObj(raw)) throw new SnapshotError('Save file is not an object.');
  const v = raw['version'];
  if (typeof v !== 'number') throw new SnapshotError('Save file has no version.');
  if (v > SNAPSHOT_VERSION) throw new SnapshotError(`Save is from a newer game version (v${v}).`);
  // Older worlds were generated by an earlier terrain generator: regenerating
  // them from their seed now gives different terrain, so resource IDs and
  // positions would no longer match. They can't be loaded faithfully.
  if (v < 3) throw new SnapshotError('Save is from before the desert island update and can no longer be loaded.');
  // v3 → v4: structures gained yaw/contents (all optional), carcasses a species
  // variant, and the bag grew to 10×6. Nothing to rewrite here; see applySnapshot.
  return raw;
}

const SPECIES: ReadonlySet<string> = new Set<CreatureSpecies>(['wolf', 'deer', 'boar', 'crocodile', 'bear']);
// A Record, so adding an AIState without listing it here is a type error
// (the food-chain states once made every save with a grazing deer unreadable).
const AI_STATE_LIST: Readonly<Record<AIState, true>> = {
  patrol: true, chase: true, hunt: true, flee: true, attack: true, graze: true, feed: true, stalk: true,
};
const AI_STATES: ReadonlySet<string> = new Set(Object.keys(AI_STATE_LIST));

/**
 * Structural validation. A save comes from storage the user (or a bug) can
 * corrupt, so it is treated as untrusted input: every field the loader
 * relies on is checked, and the error names the bad path.
 */
export function validateSnapshot(raw: unknown): WorldSnapshot {
  const o = obj(raw, 'snapshot');
  const map = parseMapConfig(obj(o['map'], 'map'));
  const clock = obj(o['clock'], 'clock');
  num(clock['totalHours'], 'clock.totalHours');

  const player = obj(o['player'], 'player');
  vec3(player['position'], 'player.position');
  num(player['yaw'], 'player.yaw');
  num(player['pitch'], 'player.pitch');
  const s = obj(player['survivor'], 'player.survivor');
  const vit = obj(s['vitals'], 'player.survivor.vitals');
  for (const k of ['health', 'hunger', 'thirst', 'energy', 'stamina', 'bodyTemp']) num(vit[k], `player.survivor.vitals.${k}`);
  const inv = obj(s['inventory'], 'player.survivor.inventory');
  num(inv['cols'], 'inventory.cols');
  num(inv['rows'], 'inventory.rows');
  arr(inv['placements'], 'inventory.placements').forEach((p, i) => {
    const pl = obj(p, `inventory.placements[${i}]`);
    const st = obj(pl['stack'], `inventory.placements[${i}].stack`);
    if (!(String(st['item']) in ITEMS)) throw new SnapshotError(`Unknown item "${String(st['item'])}" in inventory.`);
  });
  arr(s['effects'], 'player.survivor.effects');
  arr(s['hotbar'], 'player.survivor.hotbar');

  arr(o['resources'], 'resources').forEach((r, i) => {
    const t = arr(r, `resources[${i}]`);
    t.forEach((n, j) => num(n, `resources[${i}][${j}]`));
  });
  arr(o['carcasses'], 'carcasses').forEach((c, i) => vec3(obj(c, `carcasses[${i}]`)['position'], `carcasses[${i}].position`));
  arr(o['structures'], 'structures').forEach((st, i) => {
    const so = obj(st, `structures[${i}]`);
    if (!PLACEABLE_KINDS.includes(so['kind'] as PlaceableKind)) throw new SnapshotError(`structures[${i}].kind is invalid`);
    vec3(so['position'], `structures[${i}].position`);
    if (so['container'] != null) {
      const c = obj(so['container'], `structures[${i}].container`);
      arr(c['placements'], `structures[${i}].container.placements`).forEach((pl) => {
        const it = String(obj(obj(pl, 'placement')['stack'], 'stack')['item']);
        if (!(it in ITEMS)) throw new SnapshotError(`Unknown item "${it}" in a ${String(so['kind'])}.`);
      });
    }
  });
  arr(o['creatures'], 'creatures').forEach((c, i) => {
    const co = obj(c, `creatures[${i}]`);
    if (!SPECIES.has(String(co['species']))) throw new SnapshotError(`creatures[${i}].species is invalid`);
    vec3(co['position'], `creatures[${i}].position`);
    num(co['health'], `creatures[${i}].health`);
    const bb = obj(co['blackboard'], `creatures[${i}].blackboard`);
    if (!AI_STATES.has(String(bb['state']))) throw new SnapshotError(`creatures[${i}].blackboard.state is invalid`);
    arr(bb['waypoints'], `creatures[${i}].blackboard.waypoints`);
  });

  const KINDS = new Set(['foundation', 'wall', 'doorway', 'ceiling', 'stairs', 'bed']);
  const SIDES = new Set(['n', 'e', 's', 'w']);
  arr(o['buildings'] ?? [], 'buildings').forEach((b, i) => {
    const bo = obj(b, `buildings[${i}]`);
    if (!KINDS.has(String(bo['kind']))) throw new SnapshotError(`buildings[${i}].kind is invalid`);
    for (const k of ['i', 'j', 'y']) num(bo[k], `buildings[${i}].${k}`);
    if ((bo['kind'] === 'wall' || bo['kind'] === 'doorway' || bo['kind'] === 'bed' || bo['kind'] === 'stairs') && !SIDES.has(String(bo['side']))) {
      throw new SnapshotError(`buildings[${i}].side is invalid`);
    }
  });
  o['buildings'] = o['buildings'] ?? [];

  const snap = o as unknown as WorldSnapshot;
  snap.map = map; // normalised
  return snap;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface ApplyResult {
  player: Entity;
  /** Resource IDs in the save that no longer exist (e.g. generator changed). */
  missingResources: number;
}

/**
 * Re-creates a saved session on top of a freshly *populated* world (terrain
 * resources already spawned from the same seed). Creatures are NOT
 * pre-spawned by the caller; they come entirely from the save.
 */
export function applySnapshot(world: World, s: WorldSnapshot, populated: PopulatedWorld, cycle: DayNightCycle): ApplyResult {
  cycle.totalHours = s.clock.totalHours;

  let missingResources = 0;
  for (const [id, hp, timer] of s.resources) {
    const e = populated.stableToEntity.get(id);
    const r = e !== undefined ? world.get(e, ResourceC) : undefined;
    if (!r) {
      missingResources++;
      continue;
    }
    r.hitPoints = Math.min(Math.max(0, hp), r.maxHitPoints);
    r.respawnTimer = Math.max(0, timer);
  }

  for (const c of s.carcasses) {
    const e = spawnResource(world, 'carcass', c.position, c.variant ?? -1);
    world.require(e, ResourceC).hitPoints = c.hitPoints;
    populated.resourceIndex.insert(e, c.position.x, c.position.z);
  }

  for (const st of s.structures) {
    const opts: Parameters<typeof spawnStructure>[3] = { yaw: st.yaw ?? 0 };
    if (st.container !== undefined) opts.container = st.container;
    if (st.lit !== undefined) opts.lit = st.lit;
    if (st.fuelSeconds !== undefined) opts.fuelSeconds = st.fuelSeconds;
    const e = spawnStructure(world, st.kind, st.position, opts);
    if (st.processing) world.require(e, Structure).processing = { ...st.processing };
  }

  for (const c of s.creatures) {
    const e = spawnCreature(world, c.species, c.blackboard.home, c.blackboard.rngState);
    const t = world.require(e, Transform);
    t.position = vec(c.position);
    t.prevPosition = vec(c.position);
    const k = world.require(e, Creature);
    k.heading = c.heading;
    t.rotation = { x: 0, y: Math.sin(c.heading / 2), z: 0, w: Math.cos(c.heading / 2) };
    t.prevRotation = { ...t.rotation };
    k.health = Math.min(c.health, k.maxHealth);
    k.perception.awareness = c.awareness;
    k.perception.lastKnownTargetPos = c.lastKnownTargetPos;
    k.perception.lastKnownAge = c.lastKnownTargetPos ? 0 : Number.POSITIVE_INFINITY;
    world.require(e, AIBrain).blackboard = { ...c.blackboard, stuckTimer: c.blackboard.stuckTimer ?? 0 };
    if (typeof c.growth === 'number' && c.growth < 1) {
      k.growth = Math.max(0.05, c.growth);
      const hp = k.health;
      applyGrowth(world, e);
      k.health = Math.min(hp, k.maxHealth);
    }
  }

  const player = spawnPlayer(world, s.player.position, s.player.survivor.name);
  const survivor: Survivor = { ...s.player.survivor, id: player };
  // The bag grew from 8×5 to 10×6: existing placements still fit as they are.
  survivor.inventory.cols = Math.max(survivor.inventory.cols, 10);
  survivor.inventory.rows = Math.max(survivor.inventory.rows, 6);
  world.add(player, SurvivorC, survivor);
  const pc = world.require(player, PlayerControlled);
  pc.yaw = s.player.yaw;
  pc.pitch = s.player.pitch;
  return { player, missingResources };
}

// ---------------------------------------------------------------------------

function vec(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}
function round(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : n;
}
/** Deep copy through JSON semantics, preserving Infinity. */
function structuredCloneSafe<T>(v: T): T {
  return typeof structuredClone === 'function' ? structuredClone(v) : (JSON.parse(JSON.stringify(v)) as T);
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function obj(v: unknown, path: string): Record<string, unknown> {
  if (!isObj(v)) throw new SnapshotError(`${path} must be an object`);
  return v;
}
function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new SnapshotError(`${path} must be an array`);
  return v;
}
function num(v: unknown, path: string): number {
  if (typeof v !== 'number' || Number.isNaN(v)) throw new SnapshotError(`${path} must be a number`);
  return v;
}
function vec3(v: unknown, path: string): void {
  const o = obj(v, path);
  for (const k of ['x', 'y', 'z']) {
    const n = num(o[k], `${path}.${k}`);
    if (!Number.isFinite(n)) throw new SnapshotError(`${path}.${k} must be finite`);
  }
}
