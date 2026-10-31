import type { Entity, System, World } from '../../core/ecs/World';
import type { EventBus } from '../../core/EventBus';
import type { SpatialHash } from '../../core/SpatialHash';
import {
  AIBrain, Creature, Cullable, Lifetime, PlayerControlled, ResourceC, Transform,
  type CreatureSpecies, type EcoState,
} from '../../components';
import { CARCASS_OF, makeResource } from '../../data/items';
import type { ResourceKind } from '../../data/schema';
import { spawnCreature } from '../../entities/factories';
import { breedState } from './BreedingSystem';

/**
 * The island's food chain:
 *
 *   berry bushes → deer → wolves          fiber plants (roots) → boars
 *
 * Deer and boars get hungry and walk to the nearest ripe plant of their diet
 * to eat it (a bush eaten bare regrows like one the player picked). Hungry
 * wolves eat any carcass they smell, or stalk a deer (or a piglet) and run it down: a
 * healthy deer outruns them at first but tires, so wolves catch the young,
 * the starving and the unlucky. Animals that don't eat lose health and die.
 * Only well-fed females conceive (BreedingSystem).
 *
 * That loop regulates numbers without a cap: deer are limited by berries
 * and by wolves, wolves by deer. Two safety nets keep deer (and wolves) from
 * ever dying out: wolves leave deer alone when only a few are left for the
 * island's size (they're too wary and scattered to find), and if a species still
 * falls below a minimum, a pair wanders in from a far corner of the island.
 *
 * The behaviour (graze, feed, stalk, flee) lives in AISystem's trees; this
 * file holds the tuning, the shared helpers, and EcologySystem (bellies,
 * starvation, rotting carcasses, newcomers). Engine-free, runs headless.
 */
export const ECOLOGY = {
  deer: {
    diet: ['berry_bush'] as readonly ResourceKind[],
    /** Seconds for a full belly to empty. */
    drainSeconds: 1200,
    /** Goes looking for food below this… */
    hungry: 0.5,
    /** …and eats until this. */
    full: 0.95,
    biteSeconds: 2.5,
    /** Food gained per bite (one bite = one of the bush's 3 harvests). */
    perBite: 0.05,
    /** Seconds from empty belly to death. */
    starveSeconds: 360,
    /** How far it looks for food (m). */
    search: 40,
  },
  boar: {
    diet: ['fiber_plant'] as readonly ResourceKind[],
    drainSeconds: 1400, hungry: 0.5, full: 0.95, biteSeconds: 3, perBite: 0.025, starveSeconds: 480, search: 40,
  },
  wolf: {
    diet: [] as readonly ResourceKind[],
    drainSeconds: 2400, hungry: 0.5, full: 0.95, biteSeconds: 2,
    /** A carcass has 4 portions (the same ones the player butchers). */
    perBite: 0.3,
    starveSeconds: 480,
    /** Smells a carcass this far away (m). */
    search: 55,
    /** Notices a deer (or a piglet) this far away (m). */
    scent: 45,
    /** Creeps closer at walking pace, then sprints from this distance (m). */
    sprintAt: 14,
    /** Gives up a chase after this many seconds… */
    chaseSeconds: 18,
    /** …and won't start another for this long. */
    huntRest: 45,
    /** Bites hurt deer more than the player (no armour, no dodging). */
    biteVsAnimals: 1.6,
  },
  /** Prey notice a walking wolf this close, a running one this close (m). */
  notice: { walking: 11, running: 22 },
  /** Fleeing prey tire: full speed for `fresh` s, then −`fade`/s, down to `min`. */
  stamina: { fresh: 4, fade: 0.06, min: 0.65, recover: 0.5 },
  /**
   * Wolves stop hunting deer when no more than this many are left — the
   * survivors are too scattered and wary to find. It scales with the island
   * (berry bushes × refugePerBush, at least minRefuge): ≈ 14 on a medium map.
   */
  refugePerBush: 0.12,
  minRefuge: 4,
  /** Below these, a pair arrives from elsewhere (checked every `every` s, far from the player). */
  newcomers: { deer: 4, wolf: 2, boar: 2, every: 120, minDistance: 70 },
  /** Carcasses nobody eats rot away after this many seconds. */
  carcassRot: 1500,
  /** Females conceive only with at least this much food (a wolf pack needs good hunting to raise pups). */
  breedFood: { deer: 0.5, boar: 0.5, wolf: 0.7 },
} as const;

export type Eater = 'deer' | 'boar' | 'wolf';

/** How few deer wolves leave alone on an island with this many berry bushes. */
export function deerRefuge(berryBushes: number): number {
  return Math.max(ECOLOGY.minRefuge, Math.round(berryBushes * ECOLOGY.refugePerBush));
}
export const isEater = (s: CreatureSpecies): s is Eater => s === 'deer' || s === 'boar' || s === 'wolf';

/** An animal's ecology record, created (with a random, mostly full belly) the first time it is needed. */
export function ecoState(world: World, e: Entity): EcoState {
  const bb = world.require(e, AIBrain).blackboard;
  return (bb.eco ??= { food: 0.65 + (bb.rngState % 1000) / 1000 * 0.35, target: null, biteTimer: 0, chase: 0, huntRest: 0, tired: 0 });
}

/** Nearest resource of `kinds` with something left on it, within `radius`. */
export function nearestFood(
  world: World, index: SpatialHash, x: number, z: number, radius: number, kinds: readonly ResourceKind[], skip: number | null = null,
): Entity | null {
  let best: Entity | null = null, bestD = radius * radius;
  index.forEachNear(x, z, radius, (id) => {
    if (id === skip) return;
    const r = world.get(id, ResourceC);
    if (!r || r.hitPoints <= 0 || !kinds.includes(r.kind)) return;
    const d = (r.position.x - x) ** 2 + (r.position.z - z) ** 2;
    if (d < bestD) { bestD = d; best = id; }
  });
  return best;
}

/** Takes one bite out of a plant or carcass. Returns false if nothing was left. */
export function biteResource(world: World, e: Entity, events: EventBus): boolean {
  const r = world.get(e, ResourceC);
  if (!r || r.hitPoints <= 0) return false;
  r.hitPoints -= 1;
  if (r.hitPoints <= 0) {
    r.hitPoints = 0;
    // Same as a harvest: hidden until it regrows (carcasses are removed by EcologySystem).
    r.respawnTimer = r.respawnSeconds;
    events.emit('resource:depleted', { entity: e });
  }
  return true;
}

/**
 * Death: the creature becomes a carcass in place (the same entity, so its
 * mesh stays and simply tips over — see GameSession's 'creature:died').
 */
export function killCreature(
  world: World, e: Entity, index: SpatialHash, events: EventBus, cause: 'player' | 'predator' | 'starvation',
): void {
  const c = world.require(e, Creature);
  const t = world.require(e, Transform);
  c.health = 0;
  world.remove(e, AIBrain);
  world.remove(e, Creature);
  world.remove(e, Cullable);
  world.add(e, ResourceC, makeResource(e, 'carcass', { ...t.position }, CARCASS_OF[c.species] ?? -1));
  world.add(e, Lifetime, { remaining: ECOLOGY.carcassRot });
  index.insert(e, t.position.x, t.position.z);
  events.emit('creature:died', { entity: e, species: c.species, cause });
}

export interface EcologyServices {
  events: EventBus;
  resources: SpatialHash;
  isWalkable: (x: number, z: number) => boolean;
  groundHeight: (x: number, z: number) => number;
  /** Island half-size: newcomers spawn inside ±0.8 of it. */
  half: number;
  rng?: () => number;
}

/** Live-population counters, refreshed every tick (debug overlay, tests). */
export interface Census {
  deer: number;
  wolf: number;
  boar: number;
}

export class EcologySystem implements System {
  readonly name = 'ecology';
  readonly census: Census = { deer: 0, wolf: 0, boar: 0 };
  private newcomerTimer = 0;
  private scanned = false;
  private readonly rng: () => number;

  constructor(private readonly s: EcologyServices) {
    this.rng = s.rng ?? Math.random;
  }

  fixedUpdate(world: World, dt: number): void {
    const census = { deer: 0, wolf: 0, boar: 0 };
    const starved: Entity[] = [];
    for (const e of world.query(Creature, AIBrain)) {
      const c = world.require(e, Creature);
      if (c.health <= 0 || !isEater(c.species)) continue;
      census[c.species]++;
      const tune = ECOLOGY[c.species];
      const eco = ecoState(world, e);
      if (c.growth !== undefined) {
        eco.food = 1; // the young are fed by their mother
        continue;
      }
      eco.food = Math.max(0, eco.food - dt / tune.drainSeconds);
      if (eco.food === 0) {
        c.health -= (c.maxHealth / tune.starveSeconds) * dt;
        if (c.health <= 0) starved.push(e);
      } else if (eco.food > 0.3 && c.health < c.maxHealth) {
        // A fed animal heals slowly (wolves bitten by boars, deer that escaped).
        c.health = Math.min(c.maxHealth, c.health + c.maxHealth * dt / 600);
      }
    }
    for (const e of starved) killCreature(world, e, this.s.resources, this.s.events, 'starvation');
    Object.assign(this.census, census);

    // Carcasses rot; emptied ones (eaten or butchered) go at once. Every
    // carcass carries a Lifetime (killCreature), so only those are visited.
    if (!this.scanned) {
      this.scanned = true; // carcasses from a save: give them one
      for (const e of world.query(ResourceC)) {
        if (world.require(e, ResourceC).kind === 'carcass' && !world.has(e, Lifetime)) world.add(e, Lifetime, { remaining: ECOLOGY.carcassRot });
      }
    }
    const gone: Entity[] = [];
    for (const e of world.query(Lifetime, ResourceC)) {
      const r = world.require(e, ResourceC);
      if (r.kind !== 'carcass') continue;
      const life = world.require(e, Lifetime);
      life.remaining -= dt;
      if (r.hitPoints <= 0 || life.remaining <= 0) gone.push(e);
    }
    for (const e of gone) {
      this.s.resources.remove(e);
      world.destroy(e);
    }

    this.newcomerTimer += dt;
    if (this.newcomerTimer >= ECOLOGY.newcomers.every) {
      this.newcomerTimer = 0;
      if (census.deer < ECOLOGY.newcomers.deer) this.arrive(world, 'deer');
      if (census.wolf < ECOLOGY.newcomers.wolf) this.arrive(world, 'wolf');
      if (census.boar < ECOLOGY.newcomers.boar) this.arrive(world, 'boar');
    }
  }

  /** A male and a female walk in from a spot far from the player. */
  private arrive(world: World, species: Eater): void {
    const pl = world.first(PlayerControlled, Transform);
    const pp = pl !== undefined ? world.require(pl, Transform).position : null;
    const span = this.s.half * 1.6;
    for (let tries = 0; tries < 200; tries++) {
      const x = (this.rng() - 0.5) * span, z = (this.rng() - 0.5) * span;
      if (!this.s.isWalkable(x, z)) continue;
      if (pp && Math.hypot(x - pp.x, z - pp.z) < ECOLOGY.newcomers.minDistance) continue;
      for (const sex of ['female', 'male'] as const) {
        const ox = x + (sex === 'male' ? 1.5 : 0);
        const e = spawnCreature(world, species, { x: ox, y: this.s.groundHeight(ox, z), z }, Math.floor(this.rng() * 1e9));
        breedState(world, e).sex = sex;
        ecoState(world, e).food = 0.9;
        this.s.events.emit('creature:arrived', { entity: e, species });
      }
      return;
    }
  }
}
