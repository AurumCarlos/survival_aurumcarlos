import type { Entity, System, World } from '../core/ecs/World';
import type { EventBus } from '../core/EventBus';
import { AIBrain, Creature, SurvivorC, Transform } from '../components';
import type { DayNightCycle } from './DayNightCycle';

export const SLEEP = {
  /** You can go to bed from this hour… */
  fromHour: 19,
  /** …until this hour, and you wake up at wakeHour. */
  untilHour: 6,
  wakeHour: 6.5,
  /** Predators this close (and aware of you) keep you awake. */
  dangerRadius: 30,
  /** Simulated seconds per step while fast-forwarding the night. */
  step: 1,
} as const;

/** Game hours from `hour` until the next wake-up. */
export function hoursUntilMorning(hour: number): number {
  return hour >= SLEEP.wakeHour ? 24 - hour + SLEEP.wakeHour : SLEEP.wakeHour - hour;
}

/** Why the player can't sleep right now, or null if they can. */
export function sleepBlocker(world: World, player: Entity, cycle: DayNightCycle): string | null {
  const s = world.require(player, SurvivorC);
  if (!s.alive) return 'You are dead';
  const h = cycle.hour;
  if (h < SLEEP.fromHour && h >= SLEEP.untilHour) return `You can only sleep at night (from ${SLEEP.fromHour}:00)`;
  const p = world.require(player, Transform).position;
  for (const e of world.query(Creature, Transform, AIBrain)) {
    const c = world.require(e, Creature);
    if (c.temperament === 'prey' || c.health <= 0) continue;
    const cp = world.require(e, Transform).position;
    const state = world.require(e, AIBrain).blackboard.state;
    const close = Math.hypot(cp.x - p.x, cp.z - p.z) < SLEEP.dangerRadius;
    if (close && (state === 'chase' || state === 'attack' || state === 'hunt' || c.perception.awareness > 0.6)) {
      return `You can't sleep with a ${c.species} nearby`;
    }
  }
  return null;
}

/**
 * Sleeping in a bed skips the night. The world is fast-forwarded in 1 s steps
 * through the systems whose effects matter over hours — day/night clock and
 * temperature, fires burning down, resources regrowing, crafting, and the
 * survivor's metabolism with activity 'sleeping' (energy refills, hunger and
 * thirst drop slowly). Physics and AI are not run: creatures stay where they
 * were. It is honest: sleep outside in the cold, unfed, and you can die in
 * your sleep, so the bed is best placed in a roofed house.
 */
export class SleepSystem {
  constructor(
    private readonly world: World,
    private readonly events: EventBus,
    private readonly cycle: DayNightCycle,
    /** Systems advanced during the skip, in fixed-step order. */
    private readonly systems: readonly System[],
  ) {
    events.on('player:sleep-request', ({ entity }) => this.trySleep(entity));
  }

  trySleep(player: Entity): boolean {
    const reason = sleepBlocker(this.world, player, this.cycle);
    if (reason) {
      this.events.emit('sleep:refused', { entity: player, reason });
      return false;
    }
    const s = this.world.require(player, SurvivorC);
    const hours = hoursUntilMorning(this.cycle.hour);
    const seconds = (hours / 24) * this.cycle.cfg.dayLengthSeconds;
    for (let t = 0; t < seconds && s.alive; t += SLEEP.step) {
      s.activity = 'sleeping';
      for (const sys of this.systems) sys.fixedUpdate?.(this.world, SLEEP.step);
      this.world.flush();
    }
    s.activity = 'idle';
    if (s.alive) this.events.emit('player:slept', { entity: player, hours });
    return s.alive;
  }
}
