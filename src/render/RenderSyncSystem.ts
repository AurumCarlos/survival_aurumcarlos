import * as THREE from 'three';
import type { System, World } from '../core/ecs/World';
import { PlayerControlled, SurvivorC, Transform } from '../components';
import type { DayNightCycle } from '../systems/DayNightCycle';
import { RenderObject, type Renderer } from './Renderer';

/**
 * ─── Physics → render synchronisation, part 2 (presentation side) ─────────
 *
 * The simulation advances in fixed 1/60 s steps, but frames arrive whenever
 * the display wants them (e.g. every 6.9 ms at 144 Hz). If we drew
 * Transform.position directly, objects would visibly "stutter": some frames
 * would show the same physics state twice, others would skip one.
 *
 * Instead, the GameLoop passes `alpha` = (leftover accumulator / fixedDt),
 * i.e. how far real time has progressed into the *next* fixed step. We draw:
 *
 *     renderPos = lerp(prevPosition, position, alpha)
 *     renderRot = slerp(prevRotation, rotation, alpha)
 *
 * This shows the world up to one fixed step (≤ 16.7 ms) in the past, which is
 * imperceptible and buys perfectly smooth motion at any refresh rate. The
 * Three.js objects are therefore *views*: written here every frame, never
 * read by gameplay.
 *
 * The camera is the exception for rotation: mouse-look is applied with no
 * interpolation (yaw/pitch come straight from input this frame) so aiming
 * stays 1:1 with the mouse, while camera *position* is interpolated with the
 * player body so it doesn't jitter against the world.
 */
export class RenderSyncSystem implements System {
  readonly name = 'render-sync';
  private readonly qa = new THREE.Quaternion();
  private readonly qb = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private eyeHeight = 1.6;
  readonly cameraTarget = new THREE.Vector3();

  constructor(private readonly r: Renderer, private readonly cycle: DayNightCycle) {}

  update(world: World, dt: number, alpha: number): void {
    for (const e of world.query(RenderObject, Transform)) {
      const ro = world.require(e, RenderObject);
      if (!ro.interpolate) continue;
      const t = world.require(e, Transform);
      const p = t.position, pp = t.prevPosition;
      ro.object.position.set(
        pp.x + (p.x - pp.x) * alpha,
        pp.y + (p.y - pp.y) * alpha,
        pp.z + (p.z - pp.z) * alpha,
      );
      this.qa.set(t.prevRotation.x, t.prevRotation.y, t.prevRotation.z, t.prevRotation.w);
      this.qb.set(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w);
      ro.object.quaternion.slerpQuaternions(this.qa, this.qb, alpha);
    }

    // First-person camera.
    const player = world.first(PlayerControlled, Transform, SurvivorC);
    if (player !== undefined) {
      const pc = world.require(player, PlayerControlled);
      const t = world.require(player, Transform);
      const s = world.require(player, SurvivorC);
      const targetEye = s.activity === 'crouching' ? pc.crouchEyeHeight : pc.eyeHeight;
      // Smooth crouch transition (frame-rate independent exponential decay).
      this.eyeHeight += (targetEye - this.eyeHeight) * (1 - Math.exp(-12 * dt));
      const cam = this.r.camera;
      cam.position.set(
        t.prevPosition.x + (t.position.x - t.prevPosition.x) * alpha,
        t.prevPosition.y + (t.position.y - t.prevPosition.y) * alpha + this.eyeHeight,
        t.prevPosition.z + (t.position.z - t.prevPosition.z) * alpha,
      );
      this.euler.set(pc.pitch, pc.yaw, s.alive ? 0 : 0.6);
      cam.quaternion.setFromEuler(this.euler);
      this.cameraTarget.set(cam.position.x, t.position.y, cam.position.z);
      this.r.followShadows(this.cameraTarget, this.cycle);
    }

    this.r.applyTimeOfDay(this.cycle);
  }
}
