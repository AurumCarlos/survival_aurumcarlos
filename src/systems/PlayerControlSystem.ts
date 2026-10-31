import type { System, World } from '../core/ecs/World';
import type { InputManager } from '../core/Input';
import { PlayerControlled, Spectator, SurvivorC } from '../components';

export const MOVEMENT = {
  walkSpeed: 4.2,
  sprintSpeed: 7.5,
  crouchSpeed: 2,
  swimSpeed: 2.4,
  jumpVelocity: 5.5,
  maxPitch: Math.PI / 2 - 0.05,
  /** Spectator flight (m/s): normal, and with Shift held. */
  flySpeed: 12,
  flyFastSpeed: 40,
} as const;

/**
 * Translates input into *intent* on the PlayerControlled component. It never
 * touches the physics body directly — PhysicsSystem applies desiredVelocity
 * during the fixed step. Runs per rendered frame so mouse-look has no added
 * latency even when a frame contains zero fixed steps.
 */
export class PlayerControlSystem implements System {
  readonly name = 'player-control';
  private readonly axis = { x: 0, y: 0 };
  private readonly look = { yaw: 0, pitch: 0 };

  constructor(private readonly input: InputManager) {}

  update(world: World): void {
    for (const e of world.query(PlayerControlled, SurvivorC)) {
      const pc = world.require(e, PlayerControlled);
      const s = world.require(e, SurvivorC);

      if (!s.alive) {
        pc.desiredVelocity.x = pc.desiredVelocity.z = 0;
        continue;
      }

      this.input.lookDelta(this.look);
      pc.yaw += this.look.yaw;
      pc.pitch = Math.max(-MOVEMENT.maxPitch, Math.min(MOVEMENT.maxPitch, pc.pitch + this.look.pitch));

      this.input.moveAxis(this.axis);
      if (world.has(e, Spectator)) {
        // Fly where you look; Space up, C down, Shift much faster.
        s.activity = 'idle';
        const speed = this.input.isDown('sprint') ? MOVEMENT.flyFastSpeed : MOVEMENT.flySpeed;
        const len = Math.hypot(this.axis.x, this.axis.y) || 1;
        const ix = this.axis.x / len, iz = this.axis.y / len;
        const sin = Math.sin(pc.yaw), cos = Math.cos(pc.yaw), cp = Math.cos(pc.pitch);
        pc.desiredVelocity.x = (ix * cos - iz * sin * cp) * speed;
        pc.desiredVelocity.z = (-ix * sin - iz * cos * cp) * speed;
        const vertical = (this.input.isDown('jump') ? 1 : 0) - (this.input.isDown('crouch') ? 1 : 0);
        pc.desiredLift = (iz * Math.sin(pc.pitch) + vertical) * speed;
        pc.wantsJump = false;
        continue;
      }
      const moving = this.axis.x !== 0 || this.axis.y !== 0;
      const crouch = this.input.isDown('crouch');
      const swim = pc.swimming;
      const sprint = !swim && moving && !crouch && this.axis.y > 0 && this.input.isDown('sprint') && s.modifiers.canSprint;

      // Activity drives metabolism (SurvivalStatusManager) and noise (PerceptionSystem).
      if (swim) s.activity = 'swimming';
      else if (s.activity !== 'gathering' && s.activity !== 'sleeping') {
        s.activity = sprint ? 'sprinting' : crouch ? 'crouching' : moving ? 'walking' : 'idle';
      }

      const base = swim ? MOVEMENT.swimSpeed : sprint ? MOVEMENT.sprintSpeed : crouch ? MOVEMENT.crouchSpeed : MOVEMENT.walkSpeed;
      const speed = base * s.modifiers.moveSpeed;
      // Normalise so diagonals are not √2 faster, then rotate into world space by yaw.
      const len = Math.hypot(this.axis.x, this.axis.y) || 1;
      const ix = this.axis.x / len, iz = this.axis.y / len;
      const sin = Math.sin(pc.yaw), cos = Math.cos(pc.yaw);
      // Camera looks down −Z at yaw 0.
      pc.desiredVelocity.x = (ix * cos - iz * sin) * speed;
      pc.desiredVelocity.z = (-ix * sin - iz * cos) * speed;

      if (this.input.wasPressed('jump') && pc.grounded && !swim) pc.wantsJump = true;
    }
  }
}
