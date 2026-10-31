import type { Entity, System, World } from '../core/ecs/World';
import { PlayerControlled, SurvivorC, Transform } from '../components';
import { MOVEMENT } from '../systems/PlayerControlSystem';
import { PLAYER_SHAPE, PhysicsBody, type PhysicsWorld } from './PhysicsWorld';

/**
 * ─── Physics → render synchronisation, part 1 (simulation side) ───────────
 *
 * Every fixed step (1/60 s):
 *
 *   1. SNAPSHOT  Transform.prev* ← Transform.position/rotation
 *                (the state the renderer will interpolate *from*)
 *   2. INTENT    write gameplay intent into Cannon (player desired velocity,
 *                jump impulse). Gameplay never writes body.position directly
 *                except for teleports, because that bypasses collision.
 *   3. STEP      cannonWorld.step(fixedDt) — the single-argument form, which
 *                advances exactly one step. We do NOT use Cannon's
 *                step(dt, timeSinceLastCall, maxSubSteps) form: our GameLoop
 *                already owns the accumulator, and running two accumulators
 *                would double-interpolate.
 *   4. WRITE-BACK Transform.position/rotation ← body.position/quaternion
 *                (the state the renderer will interpolate *to*)
 *
 * The ECS Transform is the single source of truth for every other system
 * (AI reads player position from it, never from Cannon). Part 2 lives in
 * render/RenderSyncSystem.ts.
 */
export class PhysicsSystem implements System {
  readonly name = 'physics';

  /** Feet deeper than this below the surface → swimming (eyes stay above water). */
  static readonly SWIM_DEPTH = 1.3;
  /** Where each idle, grounded player stopped (see the slope pin in fixedUpdate). */
  private readonly anchors = new Map<Entity, { x: number; z: number }>();

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly waterLevel = Number.NEGATIVE_INFINITY,
    /** Height of a staircase surface under (x, z) near feet height, if any (player-built stairs). */
    private readonly stairsAt: (x: number, z: number, feetY: number) => number | null = () => null,
  ) {}

  fixedUpdate(world: World, dt: number): void {
    // 1. Snapshot previous state for interpolation.
    for (const e of world.query(PhysicsBody, Transform)) {
      const t = world.require(e, Transform);
      t.prevPosition.x = t.position.x;
      t.prevPosition.y = t.position.y;
      t.prevPosition.z = t.position.z;
      t.prevRotation.x = t.rotation.x;
      t.prevRotation.y = t.rotation.y;
      t.prevRotation.z = t.rotation.z;
      t.prevRotation.w = t.rotation.w;
    }

    // 2. Player intent → body velocity.
    for (const e of world.query(PlayerControlled, PhysicsBody, SurvivorC)) {
      const pc = world.require(e, PlayerControlled);
      const { body } = world.require(e, PhysicsBody);
      const feet0 = body.position.y - PLAYER_SHAPE.height / 2;
      const onStairs = this.stairsAt(body.position.x, body.position.z, feet0) !== null;
      pc.grounded = onStairs || this.physics.isGrounded(body);

      // Water: below SWIM_DEPTH the player floats with their head above the
      // surface instead of walking along the sea floor.
      const feetY = body.position.y - PLAYER_SHAPE.height / 2;
      const floatY = this.waterLevel - PhysicsSystem.SWIM_DEPTH;
      // Small hysteresis band so the player doesn't flicker in/out of swimming at the float height.
      pc.swimming = feetY < floatY + 0.05 && !(pc.grounded && feetY >= floatY - 0.02);
      if (pc.swimming) {
        // Spring toward the floating height; overrides gravity while in water.
        body.velocity.y = Math.max(-2, Math.min(3, (floatY - feetY) * 4));
        pc.grounded = false;
      }

      // Planar velocity is set directly (responsive FPS feel). In the air we
      // only blend toward it so the player keeps momentum when jumping.
      const control = pc.swimming ? 0.15 : pc.grounded ? 1 : 0.08;
      body.velocity.x += (pc.desiredVelocity.x - body.velocity.x) * control;
      body.velocity.z += (pc.desiredVelocity.z - body.velocity.z) * control;

      if (pc.wantsJump && pc.grounded && world.require(e, SurvivorC).vitals.stamina > 10) {
        body.velocity.y = MOVEMENT.jumpVelocity;
        world.require(e, SurvivorC).vitals.stamina -= 10;
      }
      pc.wantsJump = false;

      // Step assist: walk up onto foundations (≤ 0.7 m ledges) without jumping,
      // instead of grinding to a halt against the edge.
      const speed = Math.hypot(pc.desiredVelocity.x, pc.desiredVelocity.z);
      if (pc.grounded && !onStairs && speed > 0.1 && body.velocity.y < 2) {
        if (this.physics.canStepUp(body, pc.desiredVelocity.x / speed, pc.desiredVelocity.z / speed)) body.velocity.y = 3.2;
      }

      // Gravity on a frictionless capsule makes it slide down slopes while
      // idle: the contact pushes it sideways during the step. Standing still
      // on the ground, the player is pinned where they stopped (restored
      // after the step below); moving, jumping or falling releases the pin.
      const idle = pc.grounded && !pc.swimming && pc.desiredVelocity.x === 0 && pc.desiredVelocity.z === 0 && body.velocity.y <= 0.1;
      if (idle) {
        body.velocity.y = Math.max(body.velocity.y, 0);
        if (!this.anchors.has(e)) this.anchors.set(e, { x: body.position.x, z: body.position.z });
      } else {
        this.anchors.delete(e);
      }
    }

    // 3. Step exactly one fixed tick.
    this.physics.world.step(dt);

    for (const [e, a] of this.anchors) {
      const pb = world.get(e, PhysicsBody);
      if (!pb) {
        this.anchors.delete(e);
        continue;
      }
      pb.body.position.x = a.x;
      pb.body.position.z = a.z;
      pb.body.velocity.x = 0;
      pb.body.velocity.z = 0;
    }

    // Stairs: keep the player's feet on the flight (up or down) unless jumping.
    for (const e of world.query(PlayerControlled, PhysicsBody)) {
      const { body } = world.require(e, PhysicsBody);
      if (body.velocity.y > 2.5) continue;
      const feet = body.position.y - PLAYER_SHAPE.height / 2;
      const h = this.stairsAt(body.position.x, body.position.z, feet);
      if (h === null || feet > h + 0.45 || feet < h - 0.9) continue;
      body.position.y = h + PLAYER_SHAPE.height / 2 + 0.02;
      if (body.velocity.y < 0) body.velocity.y = 0;
    }

    // 4. Write back to the ECS.
    for (const e of world.query(PhysicsBody, Transform)) {
      const { body, originOffsetY } = world.require(e, PhysicsBody);
      const t = world.require(e, Transform);
      t.position.x = body.position.x;
      t.position.y = body.position.y - originOffsetY;
      t.position.z = body.position.z;
      t.rotation.x = body.quaternion.x;
      t.rotation.y = body.quaternion.y;
      t.rotation.z = body.quaternion.z;
      t.rotation.w = body.quaternion.w;

      const s = world.get(e, SurvivorC);
      if (s) {
        const dx = t.position.x - t.prevPosition.x, dz = t.position.z - t.prevPosition.z;
        s.stats.distanceTravelled += Math.hypot(dx, dz);
      }
    }
  }
}
