import type { Entity, System, World } from '../../core/ecs/World';
import type { EventBus } from '../../core/EventBus';
import { AIBrain, Creature, ResourceC, Transform, type Blackboard, type CreatureSpecies } from '../../components';
import type { SpatialHash } from '../../core/SpatialHash';
import type { Vec3 } from '../../data/schema';
import { spawnCreature, speciesStats } from '../../entities/factories';
import { ECOLOGY, ecoState, isEater } from './Ecology';

/**
 * Species that breed: how long a baby takes to grow up, gestation and the
 * mother's rest after a birth (s), and litter size.
 */
export const BREEDING: Readonly<Partial<Record<CreatureSpecies, {
  growSeconds: number; gestation: number; rest: number; litter: [number, number];
}>>> = {
  deer: { growSeconds: 1200, gestation: 180, rest: 1800, litter: [1, 2] },
  boar: { growSeconds: 1200, gestation: 180, rest: 2400, litter: [1, 2] },
  wolf: { growSeconds: 2400, gestation: 300, rest: 7200, litter: [1, 2] },
};

export const BREED_TUNING = {
  /** A newborn's size/strength (0..1). */
  birthGrowth: 0.2,
  /** Young predators don't attack (they flee) until they reach this. */
  dangerousAt: 0.6,
  /** Seconds between mating checks, and the chance per check for a pair close together. */
  interval: 45,
  chance: 0.4,
  /** A male and a female this close mate (m)… */
  mateDistance: 4,
  /** …and a male this close to a free female follows her (m). */
  courtDistance: 25,
  /**
   * Wolves hold territories: a she-wolf doesn't conceive while another
   * litter is on the way or being raised this close to her (one per pack).
   */
  wolfTerritory: 70,
  /** Density-dependent fertility (see crowded()). */
  density: {
    /** Food is counted within this radius (m)… */
    radius: 30,
    /** …and a female needs this many ripe plants per animal of her kind there. */
    foodPer: { deer: 2, boar: 4 },
    /** A she-wolf needs this many deer or piglets per wolf within wolfRadius (m). */
    preyPerWolf: 4,
    wolfRadius: 60,
  },
} as const;

/**
 * Animals repopulate the island the way real ones do. Every animal is male
 * or female (fixed the first time it is seen, saved with it). An adult,
 * well-fed female who is not pregnant or resting mates with an adult male
 * of her species standing close to her (BREED_TUNING.mateDistance), with
 * some chance at each check; a male who is near but not close enough
 * (courtDistance) starts following her (he takes her patrol route) until
 * they meet. After a gestation the mother gives birth next to her and then
 * rests before she can mate again. Babies grow little by little into adults
 * (size, health, speed, and for wolves the will to attack). Wolves keep one
 * litter per territory, and nobody breeds where food (or, for wolves, prey)
 * is already short. There is no population cap: food, predators and
 * territories keep numbers in check (Ecology.ts).
 */
export class BreedingSystem implements System {
  readonly name = 'breeding';
  private timer = 0;

  constructor(
    private readonly events: EventBus,
    private readonly isWalkable: (x: number, z: number) => boolean,
    private readonly groundHeight: (x: number, z: number) => number,
    private readonly rng: () => number = Math.random,
    /** Harvestables by position, for the food-around-her check (tests may leave it out). */
    private readonly resources?: SpatialHash,
  ) {}

  /**
   * Density-dependent fertility (how real herds regulate without any cap):
   * a doe or sow conceives only if there's enough ripe food around her for
   * the animals of her kind already there; a she-wolf only if there's
   * enough prey around the pack.
   */
  private crowded(world: World, f: Entity, species: CreatureSpecies): boolean {
    const fp = world.require(f, Transform).position;
    const near = (kinds: readonly CreatureSpecies[], r: number, young?: boolean): number => {
      let n = 0;
      for (const e of world.query(Creature, Transform)) {
        const c = world.require(e, Creature);
        if (c.health <= 0 || !kinds.includes(c.species) || (young && c.species === 'boar' && c.growth === undefined)) continue;
        const p = world.require(e, Transform).position;
        if ((p.x - fp.x) ** 2 + (p.z - fp.z) ** 2 < r * r) n++;
      }
      return n;
    };
    const d = BREED_TUNING.density;
    if (species === 'wolf') {
      return near(['deer'], d.wolfRadius) + near(['boar'], d.wolfRadius, true) < d.preyPerWolf * near(['wolf'], d.wolfRadius);
    }
    if (!this.resources || (species !== 'deer' && species !== 'boar')) return false;
    const diet = ECOLOGY[species].diet;
    let ripe = 0;
    this.resources.forEachNear(fp.x, fp.z, d.radius, (id) => {
      const r = world.get(id, ResourceC);
      if (r && r.hitPoints > 0 && diet.includes(r.kind) && (r.position.x - fp.x) ** 2 + (r.position.z - fp.z) ** 2 < d.radius ** 2) ripe++;
    });
    return ripe < d.foodPer[species] * near([species], d.radius);
  }

  fixedUpdate(world: World, dt: number): void {
    for (const e of world.query(Creature, AIBrain)) {
      const c = world.require(e, Creature);
      if (c.health <= 0) continue;
      const spec = BREEDING[c.species];
      // Growing up, every tick.
      if (c.growth !== undefined) {
        c.growth = Math.min(1, c.growth + dt / (spec?.growSeconds ?? 600));
        applyGrowth(world, e);
      }
      // Pregnancy and rest.
      const b = world.require(e, AIBrain).blackboard.breed;
      if (!b) continue;
      if (b.rest !== undefined && (b.rest -= dt) <= 0) delete b.rest;
      if (b.pregnant !== undefined && (b.pregnant -= dt) <= 0) {
        delete b.pregnant;
        this.giveBirth(world, e);
      }
    }

    this.timer += dt;
    if (this.timer < BREED_TUNING.interval) return;
    this.timer = 0;
    for (const species of Object.keys(BREEDING) as CreatureSpecies[]) this.tryMate(world, species);
  }

  private tryMate(world: World, species: CreatureSpecies): void {
    const males: Entity[] = [];
    const females: Entity[] = [];
    for (const e of world.query(Creature, AIBrain, Transform)) {
      const c = world.require(e, Creature);
      if (c.species !== species || c.health <= 0 || c.growth !== undefined) continue; // adults only
      (breedState(world, e).sex === 'male' ? males : females).push(e);
    }
    const pos = (e: Entity): Vec3 => world.require(e, Transform).position;
    const courting = new Set<Entity>();
    for (const f of females) {
      const fb = breedState(world, f);
      if (fb.pregnant !== undefined || fb.rest !== undefined) continue;
      // A hungry mother doesn't conceive (only animals that eat: see Ecology.ts).
      const fc = world.require(f, Creature);
      if (isEater(fc.species) && world.require(f, AIBrain).blackboard.eco && ecoState(world, f).food < ECOLOGY.breedFood[fc.species]) continue;
      if (this.crowded(world, f, species)) continue;
      if (species === 'wolf' && females.some((o) => {
        if (o === f) return false;
        const ob = breedState(world, o);
        return (ob.pregnant !== undefined || ob.rest !== undefined) &&
          Math.hypot(pos(o).x - pos(f).x, pos(o).z - pos(f).z) < BREED_TUNING.wolfTerritory;
      })) continue;
      // Her nearest free male.
      let best: Entity | null = null, bestD = Infinity;
      for (const m of males) {
        if (courting.has(m)) continue;
        const d = Math.hypot(pos(m).x - pos(f).x, pos(m).z - pos(f).z);
        if (d < bestD) { bestD = d; best = m; }
      }
      if (best === null) continue;
      if (bestD <= BREED_TUNING.mateDistance) {
        if (this.rng() < BREED_TUNING.chance) {
          fb.pregnant = BREEDING[species]!.gestation;
          courting.add(best);
        }
      } else if (bestD <= BREED_TUNING.courtDistance) {
        // Courtship: he follows her patrol route until they are close.
        const mbb = world.require(best, AIBrain).blackboard, fbb = world.require(f, AIBrain).blackboard;
        mbb.home = { ...fbb.home };
        mbb.waypoints = fbb.waypoints.map((w) => ({ ...w }));
        mbb.waypointIndex = fbb.waypointIndex;
        courting.add(best);
      }
    }
  }

  private giveBirth(world: World, mother: Entity): void {
    const c = world.require(mother, Creature);
    const spec = BREEDING[c.species];
    if (!spec || c.health <= 0) return;
    const n = spec.litter[0] + Math.floor(this.rng() * (spec.litter[1] - spec.litter[0] + 1));
    for (let i = 0; i < n; i++) this.birth(world, c.species, mother);
    breedState(world, mother).rest = spec.rest;
  }

  private birth(world: World, species: CreatureSpecies, mother: Entity): void {
    const mp = world.require(mother, Transform).position;
    let x = mp.x, z = mp.z;
    for (let tries = 0; tries < 8; tries++) {
      const a = this.rng() * Math.PI * 2, r = 0.8 + this.rng() * 1.5;
      if (this.isWalkable(mp.x + Math.cos(a) * r, mp.z + Math.sin(a) * r)) {
        x = mp.x + Math.cos(a) * r;
        z = mp.z + Math.sin(a) * r;
        break;
      }
    }
    const mbb = world.require(mother, AIBrain).blackboard;
    const baby = spawnCreature(world, species, { x, y: this.groundHeight(x, z), z }, Math.floor(this.rng() * 1e9), 8);
    // Stays in its mother's range.
    const bb = world.require(baby, AIBrain).blackboard;
    bb.home = { ...mbb.home };
    bb.waypoints = mbb.waypoints.map((w) => ({ ...w }));
    const c = world.require(baby, Creature);
    c.growth = BREED_TUNING.birthGrowth;
    c.heading = world.require(mother, Creature).heading;
    applyGrowth(world, baby);
    c.health = c.maxHealth;
    this.events.emit('creature:born', { entity: baby, species });
  }
}

/** An animal's breeding record, created (with its sex, from its own random seed) the first time it is needed. */
export function breedState(world: World, e: Entity): NonNullable<Blackboard['breed']> {
  const bb = world.require(e, AIBrain).blackboard;
  return (bb.breed ??= { sex: bb.rngState % 2 === 0 ? 'female' : 'male' });
}

/**
 * Size-dependent stats: a newborn has ~45 % of an adult's health, is slower,
 * and a young predator is timid (flees, doesn't bite). At growth 1 the
 * animal becomes a normal adult and `growth` is cleared.
 */
export function applyGrowth(world: World, e: Entity): void {
  const c = world.require(e, Creature);
  const g = c.growth;
  if (g === undefined) return;
  const base = speciesStats(c.species);
  const brain = world.get(e, AIBrain);
  if (g >= 1) {
    const frac = c.health / c.maxHealth;
    Object.assign(c, {
      maxHealth: base.maxHealth, walkSpeed: base.walkSpeed, runSpeed: base.runSpeed,
      attackDamage: base.attackDamage, temperament: base.temperament, fleeHealthFraction: base.fleeHealthFraction,
    });
    c.health = Math.max(1, frac * c.maxHealth);
    delete c.growth;
    if (brain) brain.tree = base.temperament === 'prey' ? 'prey' : 'predator';
    return;
  }
  const frac = c.health / c.maxHealth;
  c.maxHealth = Math.round(base.maxHealth * (0.3 + 0.7 * g));
  c.health = Math.min(c.maxHealth, frac * c.maxHealth);
  c.walkSpeed = base.walkSpeed * (0.75 + 0.25 * g);
  c.runSpeed = base.runSpeed * (0.7 + 0.3 * g);
  const timid = g < BREED_TUNING.dangerousAt;
  c.attackDamage = timid ? 0 : base.attackDamage * g;
  c.temperament = timid ? 'prey' : base.temperament;
  c.fleeHealthFraction = timid ? 1 : base.fleeHealthFraction;
  if (brain) brain.tree = c.temperament === 'prey' ? 'prey' : 'predator';
}

/** Render scale of a creature: 45 % at birth, 100 % as an adult. */
export function growthScale(c: Creature): number {
  return c.growth === undefined ? 1 : 0.3 + 0.7 * c.growth;
}
