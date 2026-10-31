import type { System, World } from '../core/ecs/World';
import type { EventBus } from '../core/EventBus';
import { Exposure, Spectator, SurvivorC } from '../components';
import { SurvivalStatusManager } from './SurvivalStatusManager';

/** ECS adapter: feeds each survivor + its exposure through the status manager. */
export class SurvivalSystem implements System {
  readonly name = 'survival';
  readonly manager: SurvivalStatusManager;

  constructor(private readonly events: EventBus, manager?: SurvivalStatusManager) {
    this.manager = manager ?? new SurvivalStatusManager();
  }

  fixedUpdate(world: World, dt: number): void {
    for (const e of world.query(SurvivorC, Exposure)) {
      const s = world.require(e, SurvivorC);
      if (!s.alive || world.has(e, Spectator)) continue; // spectators don't get hungry or hurt
      const r = this.manager.tick(s, world.require(e, Exposure), dt);
      for (const id of r.added) this.events.emit('survivor:effect-added', { entity: e, effect: id });
      for (const id of r.removed) this.events.emit('survivor:effect-removed', { entity: e, effect: id });
      if (r.died) this.events.emit('survivor:died', { entity: e, cause: r.died });
    }
  }
}
