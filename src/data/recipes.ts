import type { ItemId } from './schema';

export type CraftingStation = 'hands' | 'campfire';

export interface Recipe {
  id: string;
  name: string;
  inputs: ReadonlyArray<{ item: ItemId; qty: number }>;
  output: { item: ItemId; qty: number };
  /** Must be within range of this station (hands = anywhere). */
  station: CraftingStation;
  /** Seconds of "crafting" activity; the survivor is interruptible meanwhile. */
  craftTime: number;
  /** Shown greyed-out until the player has held every input at least once. */
  discoverable: boolean;
}

/**
 * Recipes are data, not code: designers can add a recipe without touching
 * the engine, and the list can be hot-loaded from JSON later.
 */
export const RECIPES: readonly Recipe[] = [
  { id: 'stone_axe', name: 'Stone Axe', inputs: [{ item: 'wood', qty: 2 }, { item: 'stone', qty: 2 }, { item: 'fiber', qty: 2 }], output: { item: 'stone_axe', qty: 1 }, station: 'hands', craftTime: 3, discoverable: false },
  { id: 'stone_pickaxe', name: 'Stone Pickaxe', inputs: [{ item: 'wood', qty: 2 }, { item: 'stone', qty: 3 }, { item: 'fiber', qty: 2 }], output: { item: 'stone_pickaxe', qty: 1 }, station: 'hands', craftTime: 3, discoverable: false },
  { id: 'stone_spear', name: 'Stone Spear', inputs: [{ item: 'wood', qty: 3 }, { item: 'stone', qty: 1 }, { item: 'fiber', qty: 3 }], output: { item: 'stone_spear', qty: 1 }, station: 'hands', craftTime: 4, discoverable: false },
  { id: 'torch', name: 'Torch', inputs: [{ item: 'wood', qty: 1 }, { item: 'fiber', qty: 2 }], output: { item: 'torch', qty: 1 }, station: 'hands', craftTime: 1.5, discoverable: false },
  { id: 'campfire', name: 'Campfire', inputs: [{ item: 'wood', qty: 5 }, { item: 'stone', qty: 4 }], output: { item: 'campfire_kit', qty: 1 }, station: 'hands', craftTime: 5, discoverable: false },
  { id: 'lean_to', name: 'Lean-to Shelter', inputs: [{ item: 'wood', qty: 10 }, { item: 'fiber', qty: 8 }], output: { item: 'lean_to_kit', qty: 1 }, station: 'hands', craftTime: 10, discoverable: false },
  { id: 'fur_cloak', name: 'Fur Cloak', inputs: [{ item: 'hide', qty: 3 }, { item: 'fiber', qty: 4 }], output: { item: 'fur_cloak', qty: 1 }, station: 'hands', craftTime: 8, discoverable: true },
  { id: 'cook_meat', name: 'Cook Meat', inputs: [{ item: 'raw_meat', qty: 1 }], output: { item: 'cooked_meat', qty: 1 }, station: 'campfire', craftTime: 6, discoverable: true },
  { id: 'boil_water', name: 'Boil Water', inputs: [{ item: 'water_raw', qty: 1 }], output: { item: 'water_boiled', qty: 1 }, station: 'campfire', craftTime: 5, discoverable: true },
];

export const RECIPES_BY_ID: ReadonlyMap<string, Recipe> = new Map(RECIPES.map((r) => [r.id, r]));
