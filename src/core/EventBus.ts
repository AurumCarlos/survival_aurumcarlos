import type { Entity } from './ecs/World';
import type { ItemId, StatusEffectId } from '../data/schema';

/** All cross-system events. Systems communicate through these, not through each other. */
export interface GameEvents {
  'survivor:died': { entity: Entity; cause: DeathCause };
  'survivor:effect-added': { entity: Entity; effect: StatusEffectId };
  'survivor:effect-removed': { entity: Entity; effect: StatusEffectId };
  'inventory:changed': { entity: Entity };
  'inventory:full': { entity: Entity; item: ItemId; leftover: number };
  'crafting:completed': { entity: Entity; recipeId: string };
  'crafting:failed': { entity: Entity; recipeId: string; reason: string };
  'resource:depleted': { entity: Entity };
  /** A depleted tree/rock/bush is back (its collider and nav obstacle return). */
  'resource:regrown': { entity: Entity };
  'ai:state-changed': { entity: Entity; from: string; to: string };
  'ai:detected-player': { creature: Entity; player: Entity };
  'asset:failed': { key: string; error: string; usingFallback: boolean };
  'ui:inventory-toggled': { open: boolean };
  'building:placed': { entity: Entity };
  /** Emitted before the entity is destroyed, so listeners can still read it. */
  'building:removed': { entity: Entity };
  'building:door': { entity: Entity; open: boolean };
  /** E on a bed. GameSession decides whether sleeping is allowed. */
  'player:sleep-request': { entity: Entity; bed: Entity };
  'player:slept': { entity: Entity; hours: number };
  'sleep:refused': { entity: Entity; reason: string };
  /** Tried to harvest something that can't be done by hand. */
  'harvest:blocked': { entity: Entity; tool: string };
  /** A creature took damage (melee or projectile). Drives the red flash and hit marker. */
  'creature:hit': { entity: Entity; amount: number; killed: boolean };
  /** An animation clip reached its impact frame: apply the gameplay effect now. */
  'player:action-impact': { entity: Entity; action: 'swing' | 'harvest' | 'throw' };
  /** A placed structure's contents or fire changed (UI refresh). */
  'structure:changed': { entity: Entity };
  /** E on a storage box / station: open its inventory panel. */
  'structure:open': { entity: Entity };
  'structure:placed': { entity: Entity };
  /** Emitted before the entity is destroyed. */
  'structure:removed': { entity: Entity };
  /** The player was hit (bite, claw…). Drives the red damage flash. */
  'player:damaged': { entity: Entity; amount: number; source: string };
  /** A baby animal was born (the render layer gives it a mesh). */
  'creature:born': { entity: Entity; species: string };
  /** An animal arrived from elsewhere on the island (keeps a species from dying out). */
  'creature:arrived': { entity: Entity; species: string };
  /** A creature died and became a carcass (killed by the player, a wolf, or starvation). */
  'creature:died': { entity: Entity; species: string; cause: 'player' | 'predator' | 'starvation' };
  /** Short message for the player. */
  'ui:toast': { text: string; warn?: boolean };
}

export type DeathCause = 'starvation' | 'dehydration' | 'hypothermia' | 'hyperthermia' | 'combat' | 'fall';

type Handler<T> = (payload: T) => void;

export class EventBus {
  private readonly handlers = new Map<keyof GameEvents, Set<Handler<never>>>();

  on<K extends keyof GameEvents>(type: K, h: Handler<GameEvents[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(h as Handler<never>);
    return () => set.delete(h as Handler<never>);
  }

  emit<K extends keyof GameEvents>(type: K, payload: GameEvents[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const h of set) {
      try {
        (h as Handler<GameEvents[K]>)(payload);
      } catch (err) {
        // A broken UI listener must never take down the simulation.
        console.error(`[EventBus] handler for "${type}" threw`, err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
