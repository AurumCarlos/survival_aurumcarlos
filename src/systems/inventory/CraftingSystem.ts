import type { Entity, System, World } from '../../core/ecs/World';
import type { EventBus } from '../../core/EventBus';
import { HeatSource, Structure, SurvivorC, Transform } from '../../components';
import { STRUCTURES } from '../../data/stations';
import { RECIPES_BY_ID, type CraftingStation } from '../../data/recipes';
import { itemDef } from '../../data/items';
import { CraftingEngine } from './CraftingEngine';
import { InventoryGrid } from './InventoryGrid';

export interface CraftJob {
  recipeId: string;
  elapsed: number;
  duration: number;
  /** Output still owed to the crafter (partially delivered when the bag filled up). */
  pendingQty: number;
  /** True while waiting for a station (campfire) the crafter walked away from. */
  waiting: boolean;
  /** "Inventory full" is reported once per job, not every tick. */
  reportedFull: boolean;
}

export const STATION_RANGE = 3.5;
export const MAX_CRAFT_QUEUE = 6;

/**
 * Timed crafting with a queue.
 *
 * Inputs are taken when a job is queued (so they can't be eaten or dropped
 * mid-craft) and refunded if the player cancels it. Jobs keep running while
 * the player moves and with the inventory closed — previously walking
 * cancelled the craft, which in practice meant "closing the inventory
 * cancels it", since the first thing anyone does after closing it is move.
 * Station recipes (cooking) pause, without cancelling, while the player is
 * away from a lit campfire.
 */
export class CraftingSystem implements System {
  readonly name = 'crafting';
  readonly engine = new CraftingEngine();
  private readonly queues = new Map<Entity, CraftJob[]>();
  /** One InventoryGrid wrapper per survivor, reused across ticks. */
  private readonly grids = new Map<Entity, InventoryGrid>();

  constructor(private readonly events: EventBus) {}

  inventoryOf(world: World, e: Entity): InventoryGrid {
    const s = world.require(e, SurvivorC);
    let g = this.grids.get(e);
    if (!g || g.data !== s.inventory) {
      g = new InventoryGrid(s.inventory);
      this.grids.set(e, g);
    }
    return g;
  }

  stationsNear(world: World, e: Entity): Set<CraftingStation> {
    const out = new Set<CraftingStation>(['hands']);
    const p = world.require(e, Transform).position;
    for (const f of world.query(HeatSource, Transform)) {
      const h = world.require(f, HeatSource);
      if (!h.lit || !h.isStation) continue;
      const fp = world.require(f, Transform).position;
      if (Math.hypot(fp.x - p.x, fp.z - p.z) <= STATION_RANGE && Math.abs(fp.y - p.y) < 2.5) out.add(h.isStation);
    }
    // Stations that need no fire (mortar & pestle, smithy).
    for (const f of world.query(Structure, Transform)) {
      const def = STRUCTURES[world.require(f, Structure).kind];
      if (!def.craftStation || def.fuel) continue;
      const fp = world.require(f, Transform).position;
      if (Math.hypot(fp.x - p.x, fp.z - p.z) <= STATION_RANGE && Math.abs(fp.y - p.y) < 2.5) out.add(def.craftStation);
    }
    return out;
  }

  /** Queue a craft. Returns false (and emits crafting:failed) if it can't start. */
  start(world: World, e: Entity, recipeId: string): boolean {
    const queue = this.queues.get(e) ?? [];
    if (queue.length >= MAX_CRAFT_QUEUE) {
      this.events.emit('crafting:failed', { entity: e, recipeId, reason: 'queue-full' });
      return false;
    }
    const inv = this.inventoryOf(world, e);
    const check = this.engine.check(inv, recipeId, { nearbyStations: this.stationsNear(world, e) });
    // 'no-room' is not checked at queue time: by the time the job finishes the
    // inputs have freed space, and the output waits safely if the bag is full.
    if (!check.ok && check.reason !== 'no-room') {
      this.events.emit('crafting:failed', { entity: e, recipeId, reason: check.reason });
      return false;
    }
    const recipe = RECIPES_BY_ID.get(recipeId)!;
    this.engine.consumeInputs(inv, recipeId);
    queue.push({ recipeId, elapsed: 0, duration: recipe.craftTime, pendingQty: recipe.output.qty, waiting: false, reportedFull: false });
    this.queues.set(e, queue);
    this.events.emit('inventory:changed', { entity: e });
    return true;
  }

  /** Cancel one queued job (default: the last one) and refund its inputs. */
  cancel(world: World, e: Entity, index?: number): void {
    const queue = this.queues.get(e);
    if (!queue || queue.length === 0) return;
    const i = index ?? queue.length - 1;
    const [job] = queue.splice(i, 1);
    if (!job) return;
    // A job whose output was already partly delivered can't be refunded.
    if (job.pendingQty === RECIPES_BY_ID.get(job.recipeId)?.output.qty) {
      const dropped = this.engine.refundInputs(this.inventoryOf(world, e), job.recipeId);
      for (const d of dropped) this.events.emit('inventory:full', { entity: e, item: d.item, leftover: d.qty });
    }
    this.events.emit('inventory:changed', { entity: e });
  }

  /** Read-only view of the queue, for the UI. */
  queueOf(e: Entity): readonly CraftJob[] {
    return this.queues.get(e) ?? [];
  }

  /** Progress of the job currently being worked on (0..1), or null. */
  progress(e: Entity): number | null {
    const j = this.queues.get(e)?.[0];
    return j ? Math.min(1, j.elapsed / j.duration) : null;
  }

  fixedUpdate(world: World, dt: number): void {
    for (const [e, queue] of this.queues) {
      const job = queue[0];
      if (!job) continue;
      const s = world.get(e, SurvivorC);
      if (!s || !s.alive) {
        this.queues.delete(e);
        continue;
      }
      const recipe = RECIPES_BY_ID.get(job.recipeId)!;
      job.waiting = recipe.station !== 'hands' && !this.stationsNear(world, e).has(recipe.station);
      if (job.waiting) continue;

      job.elapsed += dt * s.modifiers.gatherSpeed;
      if (job.elapsed < job.duration) continue;

      // Tools and weapons go straight into a free hotbar slot, ready to use.
      const def = itemDef(recipe.output.item);
      const freeSlot = def.tool ? s.hotbar.findIndex((h) => h === null) : -1;
      if (freeSlot >= 0 && job.pendingQty === 1) {
        s.hotbar[freeSlot] = { item: def.id, qty: 1, durability: def.tool!.maxDurability };
        job.pendingQty = 0;
      }
      const left = job.pendingQty > 0 ? this.inventoryOf(world, e).add(recipe.output.item, job.pendingQty) : 0;
      this.events.emit('inventory:changed', { entity: e });
      job.pendingQty = left;
      if (left > 0) {
        // Bag full: hold the output and retry every tick until there's room.
        if (!job.reportedFull) this.events.emit('inventory:full', { entity: e, item: recipe.output.item, leftover: left });
        job.reportedFull = true;
        job.elapsed = job.duration;
        continue;
      }
      queue.shift();
      s.stats.itemsCrafted++;
      this.events.emit('crafting:completed', { entity: e, recipeId: job.recipeId });
    }
  }
}
