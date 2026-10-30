import type { System, World } from '../../core/ecs/World';
import type { EventBus } from '../../core/EventBus';
import { PlayerControlled, SurvivorC } from '../../components';
import { PlayerAnimC, isActionState, makePlayerAnim, stepAnim, type AnimInputs } from './PlayerAnimation';

/**
 * Drives the player's animation state machine once per rendered frame and
 * turns impact frames into 'player:action-impact' events.
 *
 * Must run AFTER the systems that write `anim.request` (Interaction, Combat)
 * and BEFORE the render-side ViewModel reads the pose.
 */
export class PlayerAnimationSystem implements System {
  readonly name = 'player-animation';
  private readonly inputs: AnimInputs = { wanted: null, sprinting: false, speed: 0, alive: true, request: null };

  constructor(private readonly events: EventBus) {}

  update(world: World, dt: number): void {
    for (const e of world.query(PlayerControlled, SurvivorC)) {
      const anim = world.get(e, PlayerAnimC) ?? world.add(e, PlayerAnimC, makePlayerAnim());
      const s = world.require(e, SurvivorC);
      const pc = world.require(e, PlayerControlled);
      const inp = this.inputs;
      inp.wanted = s.hotbar[s.activeHotbarSlot]?.item ?? null;
      inp.sprinting = s.activity === 'sprinting';
      inp.speed = Math.hypot(pc.desiredVelocity.x, pc.desiredVelocity.z);
      inp.alive = s.alive;
      inp.request = anim.request;
      anim.request = null;

      // Fatigue/cold slow work: action clips play at the survivor's gather speed.
      const r = stepAnim(anim, isActionState(anim.state) ? dt * s.modifiers.gatherSpeed * anim.actionSpeed : dt, inp);
      if (r.impact) this.events.emit('player:action-impact', { entity: e, action: r.impact });
    }
  }
}
