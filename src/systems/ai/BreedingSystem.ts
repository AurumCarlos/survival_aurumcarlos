import type { Entity, System, World } from '../../core/ecs/World';
import type { EventBus } from '../../core/EventBus';
import { AIBrain, Creature, Transform, type Blackboard, type CreatureSpecies } from '../../components';
import { SIM } from '../../data/settings';
import type { Vec3 } from '../../data/schema';
import { spawnCreature, speciesStats } from '../../entities/factories';

/** Species that breed, how long a baby takes to grow up (s), and litter size. */
export const BREEDING: Readonly<Partial<Record<CreatureSpecies, { growSeconds: number; litter: [number, number] }>>> = {
  deer: { growSeconds: 600, litter: [1, 2] },
  boar: { growSeconds: 540, litter: [1, 3] },
  wolf: { growSeconds: 900, litter: [1, 2] },
};

export const BREED_TUNING = {
  /** A newborn's size/strength (0..1). */
  birthGrowth: 0.2,
  /** Young predators don't attack (they flee) until they reach this. */
  dangerousAt: 0.6,
} as const;

/**
 * Animals repopulate the island the way real ones do. Every animal is male
 * or female (fixed the first time it is seen, saved with it). An adult
 * female who is not pregnant or resting mates with an adult male of her
 * species standing close to her (SIM.mateDistance), with some chance at
 * each check; a male who is near but not close enough (SIM.courtDistance)
 * starts following her (he takes her patrol route) until they meet. After a
 * gestation the mother gives birth next to her and then rests before she
 * can mate again. Babies grow little by little into adults (size, health,
 * speed, and for wolves the will to attack). There is no population cap
 * unless the player sets one (SIM.maxAnimals): hunting keeps numbers down. An extinct species, or one with no pair left,
 * never comes back. All timings come from the simulation settings (SIM).
 */
export class BreedingSystem implements System {
  readonly name = 'breeding';
  private timer = 0;

  constructor(
    private readonly events: EventBus,
    private readonly isWalkable: (x: number, z: number) => boolean,
    private readonly groundHeight: (x: number, z: number) => number,
    private readonly rng: () => number = Math.random,
  ) {}

  fixedUpdate(world: World, dt: number): void {
    for (const e of world.query(Creature, AIBrain)) {
      const c = world.require(e, Creature);
      if (c.health <= 0) continue;
      const spec = BREEDING[c.species];
      // Growing up, every tick.
      if (c.growth !== undefined) {
        c.growth = Math.min(1, c.growth + dt / ((spec?.growSeconds ?? 600) * SIM.growTime));
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
    if (this.timer < SIM.breedInterval) return;
    this.timer = 0;
    if (SIM.maxAnimals > 0) {
      // Optional limit (settings; 0 = none): a full island stops mating.
      let n = 0;
      for (const e of world.query(Creature)) {
        const c = world.require(e, Creature);
        if (c.health > 0 && BREEDING[c.species]) n++;
      }
      if (n >= SIM.maxAnimals) return;
    }
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
      // Her nearest free male.
      let best: Entity | null = null, bestD = Infinity;
      for (const m of males) {
        if (courting.has(m)) continue;
        const d = Math.hypot(pos(m).x - pos(f).x, pos(m).z - pos(f).z);
        if (d < bestD) { bestD = d; best = m; }
      }
      if (best === null) continue;
      if (bestD <= SIM.mateDistance) {
        if (this.rng() < SIM.breedChance) {
          fb.pregnant = SIM.gestationSeconds;
          courting.add(best);
          if (fb.pregnant <= 0) {
            delete fb.pregnant;
            this.giveBirth(world, f);
          }
        }
      } else if (bestD <= SIM.courtDistance) {
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
    breedState(world, mother).rest = SIM.breedCooldownSeconds;
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
