import type { Entity, System, World } from '../../core/ecs/World';
import type { EventBus } from '../../core/EventBus';
import {
  AIBrain, Creature, PlayerControlled, SurvivorC, Transform, perceivablePlayer, type ApexMode, type ApexState,
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
/** Angle (rad) between successive crocodile patrol points: short hops hug the coast instead of cutting across headlands. */
const PATROL_STEP = 0.2;

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
  /** Entity being updated (for the per-creature steering memory below). */
  private current: Entity = -1;
  /** Which way each creature was turning: keeps it from flip-flopping when its target is right behind it. */
  private readonly turnSign = new Map<Entity, number>();
  /** Low-passed path direction, so following the grid-based flow field doesn't zigzag. */
  private readonly smoothDir = new Map<Entity, { x: number; z: number }>();
  /** Progress watchdog: where it was, and for how long it hasn't really moved. */
  private readonly stuck = new Map<Entity, { x: number; z: number; t: number }>();
  /** Crocodile going round a sandbank: which side, for how much longer, which way. */
  private readonly detour = new Map<Entity, { side: number; t: number; heading: number }>();
  /** Patrol points reached per crocodile: every third one it floats still for a moment. */
  private readonly hops = new Map<Entity, number>();

  constructor(private readonly s: ApexServices) {}

  fixedUpdate(world: World, dt: number): void {
    const player = perceivablePlayer(world, world.first(PlayerControlled, SurvivorC, Transform));
    this.s.paths.beginTick();
    for (const e of world.query(AIBrain, Creature, Transform)) {
      const k = world.require(e, Creature);
      if ((k.species !== 'crocodile' && k.species !== 'bear') || k.health <= 0) continue;
      const brain = world.require(e, AIBrain);
      const a = (brain.blackboard.apex ??= defaultApex(k.species === 'crocodile' ? 'swim' : 'sleep'));
      const t = world.require(e, Transform);
      // Snapshot BOTH position and rotation for render interpolation. Only the
      // position used to be copied: the renderer then blended the rotation
      // from a stale "previous" one every frame — the shaking and the wrong
      // facing direction.
      t.prevPosition.x = t.position.x;
      t.prevPosition.y = t.position.y;
      t.prevPosition.z = t.position.z;
      t.prevRotation.x = t.rotation.x;
      t.prevRotation.y = t.rotation.y;
      t.prevRotation.z = t.rotation.z;
      t.prevRotation.w = t.rotation.w;
      this.current = e;
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
          if (a.t > 2 + (e % 3)) {
            a.angle += PATROL_STEP + ((e * 0.137) % 0.15);
            a.target = this.patrolPoint(a.angle, e);
            set('swim');
          }
          break;
        }
        if (!a.target) a.target = this.patrolPoint(a.angle, e);
        const left = this.moveTo(k, p, a.target.x, a.target.z, CROC.swimSpeed, 1.6, dt, true);
        if (left < 2.5) {
          // Mostly keeps cruising along the shore; now and then floats still for a moment.
          a.angle += PATROL_STEP + ((e * 0.137) % 0.15);
          a.target = this.patrolPoint(a.angle, e);
          const hops = (this.hops.get(e) ?? e) + 1;
          this.hops.set(e, hops);
          if (hops % 3 === 0) set('lurk');
        } else if (this.isStuck(p, dt, 2.5, true)) {
          // Wedged against a sandbank: pick a point further along and further out.
          a.angle += 0.7;
          a.target = this.patrolPoint(a.angle, e + 3);
        }
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
        else if (!inWater) set('crawl');
        else if (this.isStuck(p, dt, 3, true)) {
          a.target = this.waterPoint(p.x, p.z, 6);
          set('return');
        }
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
        else if (inWater) set('stalk');
        else if (this.isStuck(p, dt, 2, true)) {
          a.target = this.waterPoint(p.x, p.z, 6);
          set('return');
        }
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
        // Back to the water: on land it may crawl (stayWet = false) until it is in.
        const left = this.moveTo(k, p, a.target.x, a.target.z, CROC.returnSpeed, 1.8, dt, inWater);
        if (this.isStuck(p, dt, 3, true)) a.target = this.patrolPoint(Math.atan2(p.z, p.x) + 0.4, e + 7);
        if (left < 2.5 || (inWater && a.t > 12)) {
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

  /**
   * A point in the lagoon around the island, at the given angle. It lies
   * past the outermost shore within ±0.25 rad, so the straight swim from one
   * patrol point to the next goes round headlands instead of into a cove
   * (where it used to get wedged and jitter).
   */
  private patrolPoint(angle: number, seed: number): Vec3 {
    const W = this.s.waterLevel;
    const firstWater = (a: number): number => {
      const cx = Math.cos(a), cz = Math.sin(a);
      for (let r = this.s.half * 0.2; r < this.s.half - 3; r += 1) {
        if (this.s.terrainHeight(cx * r, cz * r) < W - 0.8) return r;
      }
      return -1;
    };
    let first = -1;
    for (let k = -2; k <= 2; k++) first = Math.max(first, firstWater(angle + k * 0.125));
    const r = first < 0 ? this.s.half * 0.85 : Math.min(this.s.half - 3, first + 2 + ((seed * 7.31) % 4));
    return { x: Math.cos(angle) * r, y: W, z: Math.sin(angle) * r };
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
    const W = this.s.waterLevel;
    const limit = stayWet ? W - 0.3 : W + CROC.maxLandHeight;
    const ok = (x: number, z: number): boolean =>
      this.s.terrainHeight(x, z) <= limit && Math.abs(x) < this.s.half - 2 && Math.abs(z) < this.s.half - 2;
    let desired = Math.atan2(tx - p.x, tz - p.z);
    // Look 2.5 m ahead: if the shore (or the map edge) is in the way, swim
    // around it along the closest free direction instead of pushing into it.
    // Once it picks a side it sticks to it for a moment, so it follows the
    // shoreline smoothly instead of hesitating left/right.
    let det = this.detour.get(this.current);
    if (det && det.t > 0) det.t -= dt;
    if (!ok(p.x + Math.sin(desired) * 2.5, p.z + Math.cos(desired) * 2.5)) {
      const side = det?.side ?? (wrapAngle(desired - k.heading) >= 0 ? 1 : -1);
      for (const off of AVOID) {
        const h = desired + Math.abs(off) * (off > 0 ? side : -side);
        if (ok(p.x + Math.sin(h) * 2.5, p.z + Math.cos(h) * 2.5)) {
          desired = h;
          this.detour.set(this.current, (det = { side: off > 0 ? side : -side, t: 1.2, heading: h }));
          break;
        }
      }
    } else if (det && det.t > 0 && ok(p.x + Math.sin(det.heading) * 2.5, p.z + Math.cos(det.heading) * 2.5)) {
      desired = det.heading; // finish going round before heading straight again
    } else if (det) {
      this.detour.delete(this.current);
    }
    const diff = this.turn(k, desired, turnRate, dt);
    const s = speed * Math.max(0.3, Math.cos(Math.min(Math.abs(diff), Math.PI / 2)));
    const nx = p.x + Math.sin(k.heading) * s * dt, nz = p.z + Math.cos(k.heading) * s * dt;
    if (ok(nx, nz)) {
      p.x = nx;
      p.z = nz;
    } else {
      // Blocked while still turning: slide along the shore (on the side it
      // is already going round) rather than freezing against it.
      const side = this.detour.get(this.current)?.side ?? (wrapAngle(desired - k.heading) >= 0 ? 1 : -1);
      for (const off of [0.5, 1, 1.5]) {
        const h = k.heading + off * side;
        const sx = p.x + Math.sin(h) * s * 0.6 * dt, sz = p.z + Math.cos(h) * s * 0.6 * dt;
        if (ok(sx, sz)) {
          p.x = sx;
          p.z = sz;
          break;
        }
      }
    }
    return dist;
  }

  /**
   * Turn toward `desired` at `rate`. When the target is (nearly) straight
   * behind, keep turning the same way as before instead of flipping left/right
   * every tick — that flip-flop was the vibration. Returns the remaining angle.
   */
  private turn(k: Creature, desired: number, rate: number, dt: number): number {
    let diff = wrapAngle(desired - k.heading);
    const sign = this.turnSign.get(this.current) ?? 1;
    if (Math.abs(diff) > 2.6 && Math.sign(diff) !== sign) diff = sign * (Math.PI * 2 - Math.abs(diff));
    if (Math.abs(diff) > 0.05) this.turnSign.set(this.current, Math.sign(diff));
    k.heading = wrapAngle(k.heading + Math.max(-rate * dt, Math.min(rate * dt, diff)));
    return diff;
  }

  /** True if the creature hasn't moved 1 m in `seconds` (it is stuck somewhere). */
  private isStuck(p: Vec3, dt: number, seconds: number, moving: boolean): boolean {
    let s = this.stuck.get(this.current);
    if (!s) this.stuck.set(this.current, (s = { x: p.x, z: p.z, t: 0 }));
    if (!moving || Math.hypot(p.x - s.x, p.z - s.z) > 1) {
      s.x = p.x;
      s.z = p.z;
      s.t = 0;
      return false;
    }
    s.t += dt;
    if (s.t < seconds) return false;
    s.t = 0;
    return true;
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
          if (left < 1.5 || this.isStuck(p, dt, 4, true)) {
            if (this.s.isNight() && a.t < 90) {
              // Next stroll point near the entrance — only ones it can actually walk to.
              for (let tries = 0; tries < 8; tries++) {
                const ang = (e * 1.9 + a.t * 3.1 + tries * 0.9) % (Math.PI * 2);
                const x = mouth.x - ax * 8 + Math.cos(ang) * 7, z = mouth.z - az * 8 + Math.sin(ang) * 7;
                if (this.s.paths.isWalkable(x, z)) {
                  a.target = { x, y: 0, z };
                  break;
                }
              }
            } else set('home');
          }
        } else {
          const left = this.walk(k, p, home.x, home.z, BEAR.walkSpeed, dt);
          // Home, or blocked inside its own cave a few metres short: lie down where it is.
          if (left < 1.2 || (this.isStuck(p, dt, 4, true) && cave && insideCave(cave, p.x, p.z))) set('sleep');
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
          // Can't reach you (up on a roof, behind a wall): gives up after a while.
          if (this.isStuck(p, dt, 6, true)) set('home');
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
    if (!paths.steer(p.x, p.z, tx, tz, this.dir)) {
      // No flow field yet (still being built) or no route: head straight for it
      // rather than freezing on the spot.
      this.dir.x = (tx - p.x) / dist;
      this.dir.z = (tz - p.z) / dist;
    }
    // Smooth the grid-based direction so it walks in curves, not zigzags.
    let sd = this.smoothDir.get(this.current);
    if (!sd) this.smoothDir.set(this.current, (sd = { x: this.dir.x, z: this.dir.z }));
    const kk = 1 - Math.exp(-dt * 6);
    sd.x += (this.dir.x - sd.x) * kk;
    sd.z += (this.dir.z - sd.z) * kk;
    const len = Math.hypot(sd.x, sd.z) || 1;
    this.dir.x = sd.x / len;
    this.dir.z = sd.z / len;
    this.turn(k, Math.atan2(this.dir.x, this.dir.z), 3.5, dt);
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
    if (Math.hypot(tx - p.x, tz - p.z) < 0.4) return; // too close to have a direction: don't spin
    this.turn(k, Math.atan2(tx - p.x, tz - p.z), rate, dt);
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

/** Detour angles tried (in order) when the way ahead is blocked. */
const AVOID = [0.5, -0.5, 1.0, -1.0, 1.5, -1.5, 2.1, -2.1];

export function defaultApex(mode: ApexMode): ApexState {
  return { mode, t: 0, cooldown: 0, angle: 0, landTime: 0, target: null, den: null };
}
