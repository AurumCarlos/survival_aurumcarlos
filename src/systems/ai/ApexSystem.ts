import type { Entity, System, World } from '../../core/ecs/World';
import type { EventBus } from '../../core/EventBus';
import {
  AIBrain, Creature, PlayerControlled, SurvivorC, Transform, type ApexMode, type ApexState,
} from '../../components';
import { itemDef } from '../../data/items';
import type { Vec3 } from '../../data/schema';
import { insideCave, type Cave } from '../../world/TerrainGenerator';
import type { SurvivalStatusManager } from '../SurvivalStatusManager';
import type { PathProvider } from './nav/FlowFieldService';
import { wrapAngle } from './PerceptionSystem';

export interface ApexServices {
  /** Raw terrain height (no buildings): water depth for the crocodile. */
  terrainHeight(x: number, z: number): number;
  /** Ground the bear walks on (terrain or a low foundation). */
  groundHeight(x: number, z: number): number;
  waterLevel: number;
  paths: PathProvider;
  isNight(): boolean;
  survival: SurvivalStatusManager;
  events: EventBus;
  /** World half-size: patrol rays stop at the map edge. */
  half: number;
}

/** Crocodile tuning. */
export const CROC = {
  /** Float height: Transform.y = water − this, so only eyes, nostrils and back ridges break the surface. */
  floatDepth: 0.55,
  swimSpeed: 1.4, stalkSpeed: 2.8, lungeSpeed: 7.5, crawlSpeed: 3.2, returnSpeed: 2.6,
  /** Notices a swimmer this far away; someone at the water's edge closer. */
  noticeSwimmer: 22, noticeShore: 13,
  /** Out of the water for at most this long, and never far up the beach. */
  maxLandTime: 7, maxLandHeight: 1.3,
  lungeRange: 6, biteBleedChance: 0.6,
} as const;

/** Bear tuning. */
export const BEAR = {
  walkSpeed: 1.5, chargeSpeed: 6.8,
  /** Wakes if you come this close even outside the cave. */
  wakeDistance: 5,
  /** Gives up if you get this far from its cave mouth. */
  leash: 38,
  roarTime: 2.1, swipeTime: 0.8, swipeHitAt: 0.38,
} as const;

/**
 * Brains of the two apex predators. Not behaviour trees: their behaviour is
 * tied to the island's geography (water around it, caves in it), so each is
 * a small state machine on `blackboard.apex`, saved with the creature.
 *
 * Crocodile: patrols the lagoon around the island, lurks with only its eyes
 * above the water, stalks anyone swimming or standing at the water's edge,
 * then lunges and bites; it follows a few metres up the beach, never far,
 * and slides back into the water.
 *
 * Bear: sleeps at the back of its cave. Walk in (or get close, or hit it)
 * and it wakes, rears up and roars, then charges and swipes. It chases you
 * until you are well away from its cave, then goes home to sleep. On some
 * nights it wanders around the cave mouth.
 */
export class ApexSystem implements System {
  readonly name = 'apex';
  private readonly dir = { x: 0, z: 0 };

  constructor(private readonly s: ApexServices) {}

  fixedUpdate(world: World, dt: number): void {
    const player = world.first(PlayerControlled, SurvivorC, Transform);
    this.s.paths.beginTick();
    for (const e of world.query(AIBrain, Creature, Transform)) {
      const k = world.require(e, Creature);
      if ((k.species !== 'crocodile' && k.species !== 'bear') || k.health <= 0) continue;
      const brain = world.require(e, AIBrain);
      const a = (brain.blackboard.apex ??= defaultApex(k.species === 'crocodile' ? 'swim' : 'sleep'));
      const t = world.require(e, Transform);
      t.prevPosition.x = t.position.x;
      t.prevPosition.y = t.position.y;
      t.prevPosition.z = t.position.z;
      a.t += dt;
      a.cooldown = Math.max(0, a.cooldown - dt);
      if (k.species === 'crocodile') this.crocodile(world, e, a, player, dt);
      else this.bear(world, e, a, player, dt);
      t.rotation.x = 0;
      t.rotation.z = 0;
      t.rotation.y = Math.sin(k.heading / 2);
      t.rotation.w = Math.cos(k.heading / 2);
    }
  }

  // ---- crocodile ------------------------------------------------------------

  private crocodile(world: World, e: Entity, a: ApexState, player: Entity | undefined, dt: number): void {
    const k = world.require(e, Creature);
    const p = world.require(e, Transform).position;
    const W = this.s.waterLevel;
    const ground = this.s.terrainHeight(p.x, p.z);
    const inWater = ground < W - 0.25;
    const pp = player !== undefined ? world.require(player, Transform).position : null;
    const alive = player !== undefined && world.require(player, SurvivorC).alive;
    const swimming = player !== undefined && (world.get(player, PlayerControlled)?.swimming ?? false);
    const d = pp ? Math.hypot(pp.x - p.x, pp.z - p.z) : Infinity;
    const atShore = pp ? this.s.terrainHeight(pp.x, pp.z) < W + 0.55 : false;
    const prey = alive && pp && (swimming ? d < CROC.noticeSwimmer : atShore && d < CROC.noticeShore);
    const hurt = k.health < k.maxHealth * k.fleeHealthFraction;
    const set = (m: ApexMode): void => {
      if (a.mode !== m) {
        a.mode = m;
        a.t = 0;
      }
    };

    if (!inWater && a.mode !== 'return') a.landTime += dt;
    if (inWater) a.landTime = 0;
    if (hurt && a.mode !== 'return') {
      a.target = this.waterPoint(p.x, p.z, 10);
      set('return');
    }

    switch (a.mode) {
      case 'swim':
      case 'lurk': {
        if (prey) {
          set('stalk');
          break;
        }
        if (a.mode === 'lurk') {
          if (a.t > 4 + (e % 4)) {
            a.angle += 0.35 + ((e * 0.137) % 0.3);
            a.target = this.patrolPoint(a.angle, e);
            set('swim');
          }
          break;
        }
        if (!a.target) a.target = this.patrolPoint(a.angle, e);
        if (this.moveTo(k, p, a.target.x, a.target.z, CROC.swimSpeed, 1.6, dt, true) < 1.5) set('lurk');
        break;
      }
      case 'stalk': {
        if (!prey || !pp) {
          if (!inWater || d > 30) {
            a.target = this.waterPoint(p.x, p.z, 6);
            set('return');
          } else set('lurk');
          break;
        }
        this.moveTo(k, p, pp.x, pp.z, inWater ? CROC.stalkSpeed : CROC.crawlSpeed, 2.2, dt, false);
        if (d < CROC.lungeRange && a.cooldown === 0) set('lunge');
        if (!inWater) set('crawl');
        break;
      }
      case 'crawl': {
        // Out of the water after its prey: a short, fast belly-run, then back.
        if (!pp || !alive || a.landTime > CROC.maxLandTime || d > 12) {
          a.target = this.waterPoint(p.x, p.z, 6);
          set('return');
          break;
        }
        this.moveTo(k, p, pp.x, pp.z, CROC.crawlSpeed, 1.8, dt, false);
        if (d < CROC.lungeRange * 0.6 && a.cooldown === 0) set('lunge');
        if (inWater) set('stalk');
        break;
      }
      case 'lunge': {
        if (!pp) {
          set('lurk');
          break;
        }
        this.moveTo(k, p, pp.x, pp.z, CROC.lungeSpeed, 3.5, dt, false);
        if (d < k.attackRange) {
          if (Math.abs(pp.y - p.y) < 1.8) this.hurtPlayer(world, player!, k, CROC.biteBleedChance);
          a.cooldown = k.attackCooldown;
          set('bite');
        } else if (a.t > 1.3) {
          a.cooldown = 1;
          set(inWater ? 'stalk' : 'crawl');
        }
        break;
      }
      case 'bite':
        // Jaw snap and a shake of the head (animation); then keep after them.
        if (a.t > 0.7) set(inWater ? 'stalk' : 'crawl');
        break;
      case 'return': {
        if (!a.target) a.target = this.waterPoint(p.x, p.z, 8);
        const left = this.moveTo(k, p, a.target.x, a.target.z, CROC.returnSpeed, 1.8, dt, true);
        if (left < 2 || (inWater && a.t > 12)) {
          a.angle = Math.atan2(p.z, p.x);
          a.target = null;
          set(hurt ? 'lurk' : 'swim');
        }
        break;
      }
      default:
        set('swim');
    }

    // Float with only the eyes and back above the surface; walk on land.
    const g = this.s.terrainHeight(p.x, p.z);
    const targetY = Math.max(g, W - CROC.floatDepth);
    p.y += (targetY - p.y) * Math.min(1, dt * 6);
  }

  /** A point in the lagoon around the island, at the given angle. */
  private patrolPoint(angle: number, seed: number): Vec3 {
    const W = this.s.waterLevel;
    const cx = Math.cos(angle), cz = Math.sin(angle);
    let first = -1;
    for (let r = this.s.half * 0.2; r < this.s.half - 3; r += 1) {
      if (this.s.terrainHeight(cx * r, cz * r) < W - 0.7) {
        first = r;
        break;
      }
    }
    const r = first < 0 ? this.s.half * 0.85 : Math.min(this.s.half - 3, first + 1 + ((seed * 7.31) % 5));
    return { x: cx * r, y: W, z: cz * r };
  }

  /** Nearest deep-enough water, searched outward from the island centre through (x, z). */
  private waterPoint(x: number, z: number, extra: number): Vec3 {
    return this.patrolPoint(Math.atan2(z, x), extra);
  }

  /**
   * Turn toward (tx, tz) and move forward. The crocodile can't climb far up
   * the beach; the water stays its home. Returns the distance left.
   */
  private moveTo(k: Creature, p: Vec3, tx: number, tz: number, speed: number, turnRate: number, dt: number, stayWet: boolean): number {
    const dist = Math.hypot(tx - p.x, tz - p.z);
    const desired = Math.atan2(tx - p.x, tz - p.z);
    const diff = wrapAngle(desired - k.heading);
    k.heading = wrapAngle(k.heading + Math.max(-turnRate * dt, Math.min(turnRate * dt, diff)));
    const s = speed * Math.max(0.3, Math.cos(Math.min(Math.abs(diff), Math.PI / 2)));
    const nx = p.x + Math.sin(k.heading) * s * dt, nz = p.z + Math.cos(k.heading) * s * dt;
    const W = this.s.waterLevel;
    const g = this.s.terrainHeight(nx, nz);
    const limit = stayWet ? W - 0.3 : W + CROC.maxLandHeight;
    if (g <= limit && Math.abs(nx) < this.s.half - 2 && Math.abs(nz) < this.s.half - 2) {
      p.x = nx;
      p.z = nz;
    }
    return dist;
  }

  // ---- bear -----------------------------------------------------------------

  private bear(world: World, e: Entity, a: ApexState, player: Entity | undefined, dt: number): void {
    const k = world.require(e, Creature);
    const p = world.require(e, Transform).position;
    const den = a.den;
    const pp = player !== undefined ? world.require(player, Transform).position : null;
    const alive = player !== undefined && world.require(player, SurvivorC).alive;
    const d = pp ? Math.hypot(pp.x - p.x, pp.z - p.z) : Infinity;
    const cave = den ? (den as Cave) : null;
    const ax = den ? Math.sin(den.yaw) : 0, az = den ? Math.cos(den.yaw) : 1;
    const home = den ? { x: den.x + ax * (den.length / 2 - 3.2), z: den.z + az * (den.length / 2 - 3.2) } : { x: p.x, z: p.z };
    const mouth = den ? { x: den.x - ax * den.length / 2, z: den.z - az * den.length / 2 } : home;
    const intruder = alive && pp !== null && (
      (cave !== null && insideCave(cave, pp.x, pp.z, 1) && Math.abs(pp.y - den!.y) < 3) ||
      (d < BEAR.wakeDistance && Math.abs(pp.y - p.y) < 2) ||
      (k.perception.awareness >= 1 && k.perception.lastKnownAge < 1 && d < 30) // just got hit or spotted you up close
    );
    const set = (m: ApexMode): void => {
      if (a.mode !== m) {
        a.mode = m;
        a.t = 0;
      }
    };

    switch (a.mode) {
      case 'sleep':
      case 'roam':
      case 'home':
        if (intruder) {
          set('wake');
          break;
        }
        if (a.mode === 'sleep') {
          // Sleeps facing the entrance; some nights it goes out to wander.
          if (den) this.faceToward(k, p, mouth.x, mouth.z, 1, dt);
          if (this.s.isNight() && a.t > 40 && ((e * 13 + Math.floor(a.t / 40)) % 3 === 0)) {
            a.target = { x: mouth.x - ax * (6 + (e % 7)), y: 0, z: mouth.z - az * (6 + (e % 7)) };
            set('roam');
          }
        } else if (a.mode === 'roam') {
          const left = a.target ? this.walk(k, p, a.target.x, a.target.z, BEAR.walkSpeed, dt) : 0;
          if (left < 1.5 || a.t > 30) {
            if (this.s.isNight() && a.t < 90) {
              const ang = (e * 1.9 + a.t) % (Math.PI * 2);
              a.target = { x: mouth.x - ax * 8 + Math.cos(ang) * 7, y: 0, z: mouth.z - az * 8 + Math.sin(ang) * 7 };
            } else set('home');
          }
        } else {
          if (this.walk(k, p, home.x, home.z, BEAR.walkSpeed, dt) < 1.2) set('sleep');
        }
        break;
      case 'wake':
        // Gets up and turns to face you.
        if (pp) this.faceToward(k, p, pp.x, pp.z, 3, dt);
        if (a.t > 0.7) set('roar');
        break;
      case 'roar':
        // Rears up on its hind legs and roars (ApexAnimation), then charges.
        if (pp) this.faceToward(k, p, pp.x, pp.z, 2.5, dt);
        if (a.t > BEAR.roarTime) set('charge');
        break;
      case 'charge': {
        if (!pp || !alive) {
          set('home');
          break;
        }
        const fromMouth = Math.hypot(pp.x - mouth.x, pp.z - mouth.z);
        if (fromMouth > BEAR.leash && !(cave && insideCave(cave, pp.x, pp.z, 1))) {
          set('home');
          break;
        }
        if (d < k.attackRange && Math.abs(pp.y - p.y) < 1.6) {
          if (a.cooldown === 0) set('swipe');
          else this.faceToward(k, p, pp.x, pp.z, 4, dt);
        } else {
          this.walk(k, p, pp.x, pp.z, BEAR.chargeSpeed, dt);
        }
        break;
      }
      case 'swipe':
        if (pp) this.faceToward(k, p, pp.x, pp.z, 3, dt);
        if (a.t >= BEAR.swipeHitAt && a.t - dt < BEAR.swipeHitAt && pp && d < k.attackRange + 0.5 && Math.abs(pp.y - p.y) < 1.6) {
          this.hurtPlayer(world, player!, k, 0.5);
        }
        if (a.t > BEAR.swipeTime) {
          a.cooldown = k.attackCooldown;
          set('charge');
        }
        break;
      default:
        set('sleep');
    }
    p.y = this.s.groundHeight(p.x, p.z);
  }

  /** Walk along the nav flow field (around trees, through the cave mouth). Returns the distance left. */
  private walk(k: Creature, p: Vec3, tx: number, tz: number, speed: number, dt: number): number {
    const dist = Math.hypot(tx - p.x, tz - p.z);
    if (dist < 0.3) return dist;
    const paths = this.s.paths;
    if (!paths.steer(p.x, p.z, tx, tz, this.dir)) return dist;
    this.faceToward(k, p, p.x + this.dir.x, p.z + this.dir.z, 3.5, dt);
    const diff = Math.abs(wrapAngle(Math.atan2(this.dir.x, this.dir.z) - k.heading));
    const s = speed * Math.max(0.25, Math.cos(Math.min(diff, Math.PI / 2)));
    const nx = p.x + Math.sin(k.heading) * s * dt, nz = p.z + Math.cos(k.heading) * s * dt;
    if (paths.isWalkable(nx, nz)) {
      p.x = nx;
      p.z = nz;
    } else if (paths.isWalkable(nx, p.z)) p.x = nx;
    else if (paths.isWalkable(p.x, nz)) p.z = nz;
    return dist;
  }

  private faceToward(k: Creature, p: Vec3, tx: number, tz: number, rate: number, dt: number): void {
    const diff = wrapAngle(Math.atan2(tx - p.x, tz - p.z) - k.heading);
    k.heading = wrapAngle(k.heading + Math.max(-rate * dt, Math.min(rate * dt, diff)));
  }

  private hurtPlayer(world: World, player: Entity, k: Creature, bleedChance: number): void {
    const s = world.require(player, SurvivorC);
    const armor = s.equipped.body ? (itemDef(s.equipped.body.item).wearable?.armor ?? 0) : 0;
    const dmg = k.attackDamage * (1 - armor);
    s.vitals.health = Math.max(0, s.vitals.health - dmg);
    if (Math.random() < bleedChance * (1 - armor)) this.s.survival.applyEffect(s, 'bleeding', 25, 'combat');
    this.s.events.emit('player:damaged', { entity: player, amount: dmg, source: k.species });
  }
}

export function defaultApex(mode: ApexMode): ApexState {
  return { mode, t: 0, cooldown: 0, angle: 0, landTime: 0, target: null, den: null };
}
