import type { Entity, System, World } from '../../core/ecs/World';
import type { EventBus } from '../../core/EventBus';
import { AIBrain, Creature, HeatSource, PlayerControlled, StealthState, SurvivorC, Transform } from '../../components';
import type { Activity, Vec3 } from '../../data/schema';
import type { DayNightCycle } from '../DayNightCycle';
import type { NoiseBus } from './NoiseBus';

/** Returns true when nothing blocks the segment from → to. */
export type LineOfSight = (from: Vec3, to: Vec3) => boolean;

/** Noise radius (m) produced each tick by the player's current activity. */
export const ACTIVITY_NOISE: Readonly<Record<Activity, number>> = {
  idle: 0,
  sleeping: 0,
  crouching: 1.5,
  walking: 7,
  gathering: 4, // + the resource's own harvestNoise via pendingNoise
  swimming: 9,
  sprinting: 18,
};

export const STEALTH_TUNING = {
  /** Sight range multiplier at full darkness (scaled up by light level). */
  nightSightFactor: 0.35,
  /** A lit torch / nearby fire makes the player visible from far away at night. */
  litPlayerSightFactor: 0.9,
  crouchVisibility: 0.55,
  /** Awareness lost per second when the creature can neither see nor hear the player. */
  awarenessDecay: 0.12,
  /** Instant awareness bump at the very centre of a noise. */
  noiseBump: 0.7,
  /** Hearing gives a *fuzzy* position: error grows with distance (m per m). */
  noisePositionError: 0.25,
  eyeHeight: 0.9,
} as const;

/**
 * Stealth: each creature builds an awareness value from two senses.
 *
 *   Sight   = in range (shrinks at night, crouching) ∧ in FOV cone ∧ line of sight.
 *             Fills awareness gradually; closer = faster.
 *   Hearing = any noise event whose radius (× creature hearing) reaches it.
 *             Bumps awareness instantly and sets a *noisy* last-known position,
 *             which is what sends a wolf into the Hunt (investigate) state.
 *
 * Awareness ≥ 1 with sight = "detected" → Chase.
 */
export class PerceptionSystem implements System {
  readonly name = 'perception';
  private wasDetected = new Set<Entity>();

  constructor(
    private readonly cycle: DayNightCycle,
    private readonly noise: NoiseBus,
    private readonly los: LineOfSight,
    private readonly events: EventBus,
    private readonly rng: () => number = Math.random,
  ) {}

  fixedUpdate(world: World, dt: number): void {
    const player = world.first(PlayerControlled, SurvivorC, Transform);
    if (player === undefined) {
      this.noise.clear();
      return;
    }
    const survivor = world.require(player, SurvivorC);
    const pPos = world.require(player, Transform).position;
    const stealth = world.get(player, StealthState) ??
      world.add<StealthState>(player, StealthState, { noiseRadius: 0, maxAwareness: 0, detected: false, pendingNoise: 0 });

    // 1. Player emits noise for this tick.
    const radius = survivor.alive ? Math.max(ACTIVITY_NOISE[survivor.activity], stealth.pendingNoise) : 0;
    stealth.noiseRadius = radius;
    stealth.pendingNoise = 0;
    this.noise.emit(pPos.x, pPos.y, pPos.z, radius, player);

    // 2. How visible is the player right now?
    const light = this.cycle.lightLevel;
    const playerLit = this.isNearLitFire(world, pPos);
    const lightFactor = playerLit
      ? STEALTH_TUNING.litPlayerSightFactor
      : STEALTH_TUNING.nightSightFactor + (1 - STEALTH_TUNING.nightSightFactor) * light;
    const stance = survivor.activity === 'crouching' ? STEALTH_TUNING.crouchVisibility : 1;

    let maxAwareness = 0;
    let anyDetected = false;

    for (const c of world.query(Creature, Transform)) {
      const cr = world.require(c, Creature);
      const per = cr.perception;
      // Dormant (LOD) creatures don't sense anything; their awareness is frozen, not reset.
      if (world.get(c, AIBrain)?.lod === 'dormant') continue;
      const cPos = world.require(c, Transform).position;

      // ---- Sight ----
      const dx = pPos.x - cPos.x, dz = pPos.z - cPos.z;
      const dist = Math.hypot(dx, dz);
      const range = per.sightRange * lightFactor * stance;
      let sees = false;
      if (survivor.alive && dist < range) {
        const angleToPlayer = Math.atan2(dx, dz);
        const delta = Math.abs(wrapAngle(angleToPlayer - cr.heading));
        // Very close (2 m) counts as "sensed" regardless of facing.
        if (delta <= per.fov / 2 || dist < 2) {
          const eye = STEALTH_TUNING.eyeHeight;
          sees = this.los(
            { x: cPos.x, y: cPos.y + eye, z: cPos.z },
            { x: pPos.x, y: pPos.y + eye, z: pPos.z },
          );
        }
      }
      per.canSeeTarget = sees;

      if (sees) {
        const closeness = 1 - dist / range; // 0 at edge, 1 point-blank
        per.awareness += ((0.25 + 0.75 * closeness) / per.reactionTime) * dt;
      }

      // ---- Hearing ----
      let heard = 0;
      for (const n of this.noise.events) {
        if (n.source === c) continue;
        const r = n.radius * per.hearing;
        const d = Math.hypot(n.x - cPos.x, n.z - cPos.z);
        if (d >= r) continue;
        const loudness = 1 - d / r;
        if (loudness > heard) heard = loudness;
        if (n.source === player) {
          // Fuzzy fix on the source: further away = less precise.
          const err = d * STEALTH_TUNING.noisePositionError;
          per.lastKnownTargetPos = {
            x: n.x + (this.rng() * 2 - 1) * err,
            y: n.y,
            z: n.z + (this.rng() * 2 - 1) * err,
          };
          per.lastKnownAge = 0;
        }
      }
      per.heardNoise = heard;
      // Noise raises awareness toward — but on its own never past — the
      // detection threshold: you can't be *seen* by sound alone.
      if (heard > 0) per.awareness = Math.max(per.awareness, Math.min(0.95, per.awareness + heard * STEALTH_TUNING.noiseBump * dt * 4));

      if (!sees && heard === 0) per.awareness -= STEALTH_TUNING.awarenessDecay * dt;
      per.awareness = Math.min(Math.max(per.awareness, 0), 1.5);

      if (sees && per.awareness >= 1) {
        per.lastKnownTargetPos = { x: pPos.x, y: pPos.y, z: pPos.z };
        per.lastKnownAge = 0;
      } else {
        per.lastKnownAge += dt;
      }

      const detected = sees && per.awareness >= 1;
      if (detected && !this.wasDetected.has(c)) this.events.emit('ai:detected-player', { creature: c, player });
      if (detected) this.wasDetected.add(c);
      else this.wasDetected.delete(c);

      if (cr.temperament !== 'prey') {
        maxAwareness = Math.max(maxAwareness, per.awareness);
        anyDetected ||= detected;
      }
    }

    stealth.maxAwareness = maxAwareness;
    stealth.detected = anyDetected;
    this.noise.clear();
  }

  private isNearLitFire(world: World, p: Vec3): boolean {
    for (const f of world.query(HeatSource, Transform)) {
      const h = world.require(f, HeatSource);
      if (!h.lit) continue;
      const fp = world.require(f, Transform).position;
      if (Math.hypot(fp.x - p.x, fp.z - p.z) < h.radius * 0.8) return true;
    }
    return false;
  }
}

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
