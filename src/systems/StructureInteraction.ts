import type { Entity, System, World } from '../core/ecs/World';
import type { EventBus } from '../core/EventBus';
import type { InputManager } from '../core/Input';
import { HeatSource, PlayerControlled, Structure, SurvivorC, Transform } from '../components';
import { STRUCTURES } from '../data/stations';

const REACH = 2.7;

/**
 * E on a placed structure opens it (storage, fire/forge contents, or just
 * its panel with "Pick up" for crafting stations). Runs before the harvest
 * system and takes E away from it while a structure is targeted.
 */
export class StructureInteraction implements System {
  readonly name = 'structure-interaction';
  focused: Entity | null = null;

  constructor(
    private readonly input: InputManager,
    private readonly events: EventBus,
    /** True while something with higher priority owns E (door/bed in sight, build mode). */
    private readonly busy: () => boolean,
  ) {}

  update(world: World): void {
    const player = world.first(PlayerControlled, SurvivorC, Transform);
    this.focused = null;
    if (player === undefined || this.busy() || !world.require(player, SurvivorC).alive) return;
    const pc = world.require(player, PlayerControlled);
    const p = world.require(player, Transform).position;
    const fx = -Math.sin(pc.yaw), fz = -Math.cos(pc.yaw);
    let best: Entity | null = null, bestD = REACH;
    for (const e of world.query(Structure, Transform)) {
      const sp = world.require(e, Transform).position;
      const dx = sp.x - p.x, dz = sp.z - p.z, d = Math.hypot(dx, dz);
      if (d >= bestD || Math.abs(sp.y - p.y) > 2) continue;
      if (d > 0.6 && (dx * fx + dz * fz) / d < 0.55) continue;
      best = e;
      bestD = d;
    }
    this.focused = best;
    if (best !== null && this.input.wasPressed('interact')) this.events.emit('structure:open', { entity: best });
  }

  prompt(world: World): string | null {
    if (this.focused === null) return null;
    const st = world.get(this.focused, Structure);
    if (!st) return null;
    const def = STRUCTURES[st.kind];
    const h = world.get(this.focused, HeatSource);
    const state = h ? (h.lit ? ' (burning)' : ' (cold)') : '';
    return `Press E — open ${def.label}${state}`;
  }
}
