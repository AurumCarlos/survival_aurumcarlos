import { RECIPES, RECIPES_BY_ID, type CraftingStation, type Recipe } from '../../data/recipes';
import type { ItemId } from '../../data/schema';
import { InventoryGrid } from './InventoryGrid';

export interface CraftContext {
  /** Stations within reach of the crafter this tick. 'hands' is always available. */
  nearbyStations: ReadonlySet<CraftingStation>;
}

export type CraftCheck =
  | { ok: true }
  | { ok: false; reason: 'unknown-recipe' | 'missing-station' | 'missing-items' | 'no-room'; missing: Array<{ item: ItemId; have: number; need: number }> };

/**
 * Stateless recipe engine. Crafting is a *transaction*: we run it against a
 * clone of the inventory first and only commit if the output fits, so a full
 * inventory can never eat your materials.
 */
export class CraftingEngine {
  constructor(private readonly recipes: readonly Recipe[] = RECIPES) {}

  check(inv: InventoryGrid, recipeId: string, ctx: CraftContext): CraftCheck {
    const recipe = RECIPES_BY_ID.get(recipeId);
    if (!recipe) return { ok: false, reason: 'unknown-recipe', missing: [] };
    if (recipe.station !== 'hands' && !ctx.nearbyStations.has(recipe.station)) {
      return { ok: false, reason: 'missing-station', missing: [] };
    }
    const missing = recipe.inputs
      .map((i) => ({ item: i.item, have: inv.count(i.item), need: i.qty }))
      .filter((m) => m.have < m.need);
    if (missing.length) return { ok: false, reason: 'missing-items', missing };

    const dry = this.dryRun(inv, recipe);
    if (!dry) return { ok: false, reason: 'no-room', missing: [] };
    return { ok: true };
  }

  /**
   * Consume inputs and produce the output atomically.
   * Returns the check result; on failure the inventory is untouched.
   */
  craft(inv: InventoryGrid, recipeId: string, ctx: CraftContext): CraftCheck {
    const check = this.check(inv, recipeId, ctx);
    if (!check.ok) return check;
    const dry = this.dryRun(inv, RECIPES_BY_ID.get(recipeId)!)!;
    inv.assign(dry);
    return check;
  }

  /** Remove inputs only — used when a timed craft starts (inputs are "in the crafter's hands"). */
  consumeInputs(inv: InventoryGrid, recipeId: string): boolean {
    const recipe = RECIPES_BY_ID.get(recipeId);
    if (!recipe) return false;
    for (const i of recipe.inputs) if (inv.count(i.item) < i.qty) return false;
    for (const i of recipe.inputs) inv.remove(i.item, i.qty);
    return true;
  }

  /** Give inputs back on cancel; returns whatever did not fit (to be dropped on the ground). */
  refundInputs(inv: InventoryGrid, recipeId: string): Array<{ item: ItemId; qty: number }> {
    const recipe = RECIPES_BY_ID.get(recipeId);
    const dropped: Array<{ item: ItemId; qty: number }> = [];
    if (!recipe) return dropped;
    for (const i of recipe.inputs) {
      const left = inv.add(i.item, i.qty);
      if (left > 0) dropped.push({ item: i.item, qty: left });
    }
    return dropped;
  }

  /** Recipes to show in the crafting panel, with craftability flags. */
  list(inv: InventoryGrid, ctx: CraftContext, discovered: ReadonlySet<ItemId>): Array<{ recipe: Recipe; check: CraftCheck; visible: boolean }> {
    return this.recipes.map((recipe) => ({
      recipe,
      check: this.check(inv, recipe.id, ctx),
      visible: !recipe.discoverable || recipe.inputs.every((i) => discovered.has(i.item)),
    }));
  }

  private dryRun(inv: InventoryGrid, recipe: Recipe): InventoryGrid | null {
    const sim = inv.clone();
    for (const i of recipe.inputs) {
      if (sim.remove(i.item, i.qty) < i.qty) return null;
    }
    // Inputs are removed first, so their freed cells can hold the output.
    const leftover = sim.add(recipe.output.item, recipe.output.qty);
    return leftover === 0 ? sim : null;
  }
}
