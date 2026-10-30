import type { Entity, System, World } from '../core/ecs/World';
import type { EventBus } from '../core/EventBus';
import { HeatSource, Structure } from '../components';
import { CHARCOAL_FROM, STRUCTURES, type ProcessRecipe } from '../data/stations';
import type { ItemId } from '../data/schema';
import { InventoryGrid } from './inventory/InventoryGrid';

/** Refuel this long before the fire would go out, so the order of systems never matters. */
const REFUEL_MARGIN = 1;

/**
 * ARK-style stations: what's put inside a lit campfire, forge or cooking pot
 * cooks/smelts by itself, one batch at a time, burning fuel items from the
 * same inventory (wood leaves charcoal). Preserving bins need no fuel.
 * Runs headless — no Three, no DOM.
 */
export class StationSystem implements System {
  readonly name = 'stations';
  private readonly grids = new Map<Entity, InventoryGrid>();

  constructor(private readonly events: EventBus) {}

  /** Wrapper over a structure's container (cached, rebuilt if the data object was replaced). */
  containerOf(world: World, e: Entity): InventoryGrid | null {
    const st = world.get(e, Structure);
    if (!st?.container) return null;
    let g = this.grids.get(e);
    if (!g || g.data !== st.container) {
      g = new InventoryGrid(st.container);
      this.grids.set(e, g);
    }
    return g;
  }

  /** Light or put out a fire/forge. Lighting needs fuel inside (or some still burning). */
  setLit(world: World, e: Entity, lit: boolean): boolean {
    const h = world.get(e, HeatSource);
    if (!h) return false;
    if (lit && h.fuelSeconds <= 0 && !this.refuel(world, e)) return false;
    h.lit = lit;
    this.events.emit('structure:changed', { entity: e });
    return true;
  }

  /** Recipe the station would run next with its current contents, if any. */
  nextRecipe(world: World, e: Entity): ProcessRecipe | null {
    const st = world.get(e, Structure);
    const inv = this.containerOf(world, e);
    if (!st || !inv) return null;
    const cur = st.processing.recipeId ? STRUCTURES[st.kind].processes.find((r) => r.id === st.processing.recipeId) : undefined;
    if (cur && this.canRun(inv, cur)) return cur;
    return STRUCTURES[st.kind].processes.find((r) => this.canRun(inv, r)) ?? null;
  }

  fixedUpdate(world: World, dt: number): void {
    for (const e of world.query(Structure)) {
      const st = world.require(e, Structure);
      const def = STRUCTURES[st.kind];
      if (!st.container) continue;
      const h = world.get(e, HeatSource);
      if (def.fuel && h?.lit && h.fuelSeconds < REFUEL_MARGIN) this.refuel(world, e);

      const active = def.fuel ? !!h?.lit : true;
      if (!active || def.processes.length === 0) continue;
      const recipe = this.nextRecipe(world, e);
      if (!recipe) {
        if (st.processing.recipeId !== null) {
          st.processing.recipeId = null;
          st.processing.progress = 0;
        }
        continue;
      }
      if (st.processing.recipeId !== recipe.id) {
        st.processing.recipeId = recipe.id;
        st.processing.progress = 0;
      }
      st.processing.progress += dt;
      if (st.processing.progress < recipe.time) continue;
      st.processing.progress = 0;
      const inv = this.containerOf(world, e)!;
      for (const i of recipe.inputs) inv.remove(i.item, i.qty);
      inv.add(recipe.output.item, recipe.output.qty);
      this.events.emit('structure:changed', { entity: e });
    }
  }

  /** Burn one fuel item. Returns false if there is nothing to burn. */
  private refuel(world: World, e: Entity): boolean {
    const st = world.require(e, Structure);
    const h = world.get(e, HeatSource);
    const fuel = STRUCTURES[st.kind].fuel;
    const inv = this.containerOf(world, e);
    if (!fuel || !h || !inv) return false;
    for (const [item, secs] of Object.entries(fuel) as Array<[ItemId, number]>) {
      if (inv.count(item) <= 0) continue;
      inv.remove(item, 1);
      h.fuelSeconds += secs;
      const coal = CHARCOAL_FROM[item];
      if (coal) inv.add('charcoal', coal); // dropped if the box is full, like ARK
      this.events.emit('structure:changed', { entity: e });
      return true;
    }
    return false;
  }

  /** Inputs present, and the output fits once they're taken out. Fuel needed to keep burning is not used as an ingredient. */
  private canRun(inv: InventoryGrid, r: ProcessRecipe): boolean {
    for (const i of r.inputs) if (inv.count(i.item) < i.qty) return false;
    const sim = inv.clone();
    for (const i of r.inputs) sim.remove(i.item, i.qty);
    return sim.add(r.output.item, r.output.qty) === 0;
  }
}
