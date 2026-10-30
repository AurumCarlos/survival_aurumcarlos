import type { Entity, System, World } from '../../core/ecs/World';
import type { EventBus } from '../../core/EventBus';
import { AIBrain, Creature, Transform, type CreatureSpecies } from '../../components';
import type { Vec3 } from '../../data/schema';
import { spawnCreature, speciesStats } from '../../entities/factories';

/** Species that breed, how long a baby takes to grow up (s), and litter size. */
export const BREEDING: Readonly<Partial<Record<CreatureSpecies, { growSeconds: number; litter: [number, number] }>>> = {
  deer: { growSeconds: 600, litter: [1, 2] },
  boar: { growSeconds: 540, litter: [1, 3] },
  wolf: { growSeconds: 900, litter: [1, 2] },
};

export const BREED_TUNING = {
  /** Seconds between breeding checks (per species). */
  interval: 45,
  /** Chance a species with a pair of adults has young at a check. */
  chance: 0.4,
  /** Two adults of the same species within this distance make a pair. */
  pairDistance: 30,
  /** Population never grows past cap × the starting population. */
  capFactor: 1.4,
  /** A newborn's size/strength (0..1). */
  birthGrowth: 0.2,
  /** Young predators don't attack (they flee) until they reach this. */
  dangerousAt: 0.6,
} as const;

/**
 * Animals repopulate the island: where there are at least two adults of a
 * species close together (and the population is below its cap), babies are
 * born next to the mother. They start small, weak and timid, and grow little
 * by little into adults (size, health, speed, and for wolves the will to
 * attack). An extinct species — or one down to a single adult — never comes back.
 */
export class BreedingSystem implements System {
  readonly name = 'breeding';
  private timer = 0;

  constructor(
    private readonly events: EventBus,
    /** Starting population per species (cap = capFactor × this). */
    private readonly startCount: Readonly<Partial<Record<CreatureSpecies, number>>>,
    private readonly isWalkable: (x: number, z: number) => boolean,
    private readonly groundHeight: (x: number, z: number) => number,
    private readonly rng: () => number = Math.random,
  ) {}

  fixedUpdate(world: World, dt: number): void {
    // Growing up, every tick.
    for (const e of world.query(Creature, AIBrain)) {
      const c = world.require(e, Creature);
      if (c.growth === undefined || c.health <= 0) continue;
      const spec = BREEDING[c.species];
      c.growth = Math.min(1, c.growth + dt / (spec?.growSeconds ?? 600));
      applyGrowth(world, e);
    }

    this.timer += dt;
    if (this.timer < BREED_TUNING.interval) return;
    this.timer = 0;
    for (const species of Object.keys(BREEDING) as CreatureSpecies[]) this.tryBreed(world, species);
  }

  private tryBreed(world: World, species: CreatureSpecies): void {
    const all: Entity[] = [];
    const adults: Entity[] = [];
    for (const e of world.query(Creature, AIBrain, Transform)) {
      const c = world.require(e, Creature);
      if (c.species !== species || c.health <= 0) continue;
      all.push(e);
      if (c.growth === undefined) adults.push(e);
    }
    const cap = Math.round((this.startCount[species] ?? 0) * BREED_TUNING.capFactor);
    if (adults.length < 2 || all.length >= cap || this.rng() > BREED_TUNING.chance) return;
    // A mother with a mate nearby.
    const pos = (e: Entity): Vec3 => world.require(e, Transform).position;
    const mothers = adults.filter((a) => adults.some((b) => b !== a && Math.hypot(pos(a).x - pos(b).x, pos(a).z - pos(b).z) < BREED_TUNING.pairDistance));
    if (mothers.length === 0) return;
    const mother = mothers[Math.floor(this.rng() * mothers.length)]!;
    const spec = BREEDING[species]!;
    const n = Math.min(cap - all.length, spec.litter[0] + Math.floor(this.rng() * (spec.litter[1] - spec.litter[0] + 1)));
    for (let i = 0; i < n; i++) this.birth(world, species, mother);
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
