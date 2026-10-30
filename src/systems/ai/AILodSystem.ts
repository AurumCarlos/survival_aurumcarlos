import type { System, World } from '../../core/ecs/World';
import { AIBrain, Creature, Cullable, PlayerControlled, Transform, type AIState } from '../../components';

export interface AILodPolicy {
  /**
   * Creatures closer than this to the player always simulate, even off-screen.
   * Must exceed the largest hearing radius (sprint 18 m × wolf hearing 1.4 ≈
   * 25 m) so freezing never makes a creature deaf to the player.
   */
  nearRadius: number;
  /** States that never go dormant: a wolf chasing you must not freeze when you turn around. */
  engagedStates: ReadonlySet<AIState>;
}

export const DEFAULT_AI_LOD: AILodPolicy = {
  nearRadius: 32,
  engagedStates: new Set<AIState>(['chase', 'attack', 'flee', 'hunt']),
};

/** Pure decision, unit-testable. */
export function aiLodTier(
  visible: boolean, distanceToPlayer: number, state: AIState, policy: AILodPolicy = DEFAULT_AI_LOD,
): 'active' | 'dormant' {
  if (visible) return 'active';
  if (distanceToPlayer < policy.nearRadius) return 'active';
  if (policy.engagedStates.has(state)) return 'active';
  return 'dormant';
}

/**
 * AI level of detail. Reads `Cullable.visible` (written by the render
 * layer's CullingSystem every frame) and decides per creature whether the
 * behaviour tree, perception and movement run this tick.
 *
 * Runs first in the fixed step, before PerceptionSystem and AISystem.
 * Headless (no culling system) every creature stays visible → active.
 */
export class AILodSystem implements System {
  readonly name = 'ai-lod';
  readonly stats = { active: 0, dormant: 0 };

  constructor(private readonly policy: AILodPolicy = DEFAULT_AI_LOD) {}

  fixedUpdate(world: World): void {
    const player = world.first(PlayerControlled, Transform);
    const pp = player !== undefined ? world.require(player, Transform).position : null;
    let active = 0, dormant = 0;
    for (const e of world.query(AIBrain, Creature, Transform)) {
      const brain = world.require(e, AIBrain);
      const p = world.require(e, Transform).position;
      const visible = world.get(e, Cullable)?.visible ?? true;
      const dist = pp ? Math.hypot(p.x - pp.x, p.z - pp.z) : 0;
      brain.lod = aiLodTier(visible, dist, brain.blackboard.state, this.policy);
      if (brain.lod === 'active') active++;
      else dormant++;
    }
    this.stats.active = active;
    this.stats.dormant = dormant;
  }
}
