import type { ItemId } from './schema';

/**
 * Where a recipe is crafted. 'hands' = anywhere. The others are placed
 * structures the player must stand next to (the Fabricator also needs
 * gasoline and to be switched on). Cooking and smelting are NOT recipes
 * here: they happen inside fires/forges/pots, see data/stations.ts.
 */
export type CraftingStation = 'hands' | 'campfire' | 'mortar_pestle' | 'smithy' | 'fabricator';

export type RecipeTab = 'tools' | 'weapons' | 'armor' | 'structures' | 'refining' | 'food';

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
  tab: RecipeTab;
}

export const STATION_LABEL: Readonly<Record<CraftingStation, string>> = {
  hands: 'Inventory', campfire: 'Campfire', mortar_pestle: 'Mortar & Pestle', smithy: 'Smithy', fabricator: 'Fabricator',
};

type In = Array<[ItemId, number]>;
const r = (
  id: string, name: string, inputs: In, output: ItemId, qty: number, station: CraftingStation, craftTime: number, tab: RecipeTab, discoverable = false,
): Recipe => ({ id, name, inputs: inputs.map(([item, q]) => ({ item, qty: q })), output: { item: output, qty }, station, craftTime, discoverable, tab });

/**
 * Recipes are data, not code: designers can add a recipe without touching
 * the engine. Costs follow ARK's recipes, scaled down to this game's yields.
 */
export const RECIPES: readonly Recipe[] = [
  // ---- tools ----------------------------------------------------------------------------
  r('stone_axe', 'Stone Hatchet', [['wood', 2], ['stone', 2], ['fiber', 2]], 'stone_axe', 1, 'hands', 3, 'tools'),
  r('stone_pickaxe', 'Stone Pick', [['wood', 2], ['stone', 3], ['fiber', 2]], 'stone_pickaxe', 1, 'hands', 3, 'tools'),
  r('torch', 'Torch', [['wood', 1], ['fiber', 2]], 'torch', 1, 'hands', 1.5, 'tools'),
  r('metal_hatchet', 'Metal Hatchet', [['wood', 2], ['metal_ingot', 3], ['hide', 1]], 'metal_hatchet', 1, 'smithy', 6, 'tools'),
  r('metal_pick', 'Metal Pick', [['wood', 2], ['metal_ingot', 3], ['hide', 1]], 'metal_pick', 1, 'smithy', 6, 'tools'),
  r('metal_sickle', 'Metal Sickle', [['wood', 2], ['metal_ingot', 3], ['hide', 1], ['fiber', 2]], 'metal_sickle', 1, 'smithy', 6, 'tools'),
  r('gps', 'GPS', [['electronics', 2], ['polymer', 1], ['metal_ingot', 1]], 'gps', 1, 'fabricator', 8, 'tools'),

  // ---- weapons ------------------------------------------------------------------------
  r('stone_spear', 'Spear', [['wood', 3], ['stone', 1], ['fiber', 3]], 'stone_spear', 1, 'hands', 4, 'weapons'),
  r('wooden_club', 'Wooden Club', [['wood', 4], ['fiber', 2]], 'wooden_club', 1, 'hands', 3, 'weapons'),
  r('bow', 'Bow', [['wood', 4], ['fiber', 8], ['hide', 1]], 'bow', 1, 'hands', 6, 'weapons'),
  r('stone_arrow', 'Stone Arrow ×3', [['flint', 1], ['thatch', 1], ['fiber', 2]], 'stone_arrow', 3, 'hands', 2, 'weapons'),
  r('metal_pike', 'Pike', [['wood', 3], ['metal_ingot', 4], ['hide', 2]], 'metal_pike', 1, 'smithy', 8, 'weapons'),
  r('metal_sword', 'Sword', [['metal_ingot', 4], ['hide', 1], ['fiber', 1]], 'metal_sword', 1, 'smithy', 8, 'weapons'),

  // ---- armour -------------------------------------------------------------------------
  r('cloth_armor', 'Cloth Armor', [['fiber', 12]], 'cloth_armor', 1, 'hands', 5, 'armor'),
  r('hide_armor', 'Hide Armor', [['hide', 4], ['fiber', 6]], 'hide_armor', 1, 'hands', 7, 'armor'),
  r('fur_cloak', 'Fur Armor', [['hide', 3], ['fiber', 4]], 'fur_cloak', 1, 'hands', 8, 'armor', true),
  r('chitin_armor', 'Chitin Armor', [['chitin', 6], ['hide', 2], ['fiber', 2]], 'chitin_armor', 1, 'smithy', 9, 'armor'),
  r('flak_armor', 'Flak Armor', [['metal_ingot', 6], ['hide', 2], ['fiber', 2]], 'flak_armor', 1, 'smithy', 10, 'armor'),

  // ---- structures ---------------------------------------------------------------------
  r('campfire', 'Campfire', [['wood', 5], ['stone', 4]], 'campfire_kit', 1, 'hands', 5, 'structures'),
  r('lean_to', 'Lean-to Shelter', [['wood', 10], ['fiber', 8]], 'lean_to_kit', 1, 'hands', 10, 'structures'),
  r('storage_box', 'Storage Box', [['wood', 6], ['thatch', 6], ['fiber', 4]], 'storage_box_kit', 1, 'hands', 5, 'structures'),
  r('mortar_pestle', 'Mortar & Pestle', [['stone', 6], ['hide', 1]], 'mortar_pestle_kit', 1, 'hands', 5, 'structures'),
  r('refining_forge', 'Refining Forge', [['stone', 10], ['flint', 6], ['hide', 3], ['wood', 4], ['fiber', 3]], 'refining_forge_kit', 1, 'hands', 10, 'structures'),
  r('cooking_pot', 'Cooking Pot', [['stone', 8], ['flint', 4], ['sparkpowder', 2], ['wood', 4]], 'cooking_pot_kit', 1, 'hands', 8, 'structures'),
  r('preserving_bin', 'Preserving Bin', [['stone', 6], ['wood', 6], ['thatch', 4], ['fiber', 2]], 'preserving_bin_kit', 1, 'hands', 8, 'structures'),
  r('smithy', 'Smithy', [['metal_ingot', 2], ['stone', 8], ['wood', 8], ['hide', 3]], 'smithy_kit', 1, 'hands', 10, 'structures'),
  r('large_storage_box', 'Large Storage Box', [['wood', 12], ['thatch', 12], ['fiber', 6]], 'large_storage_box_kit', 1, 'smithy', 8, 'structures'),
  r('fabricator', 'Fabricator', [['metal_ingot', 6], ['cementing_paste', 3], ['sparkpowder', 4], ['crystal', 3], ['oil', 2]], 'fabricator_kit', 1, 'smithy', 14, 'structures'),

  // ---- refining (stations) ---------------------------------------------------------
  r('sparkpowder', 'Sparkpowder', [['flint', 2], ['stone', 1]], 'sparkpowder', 1, 'mortar_pestle', 2, 'refining'),
  r('gunpowder', 'Gunpowder', [['sparkpowder', 1], ['charcoal', 1]], 'gunpowder', 1, 'mortar_pestle', 2, 'refining'),
  r('cementing_paste', 'Cementing Paste (chitin)', [['chitin', 2], ['stone', 4]], 'cementing_paste', 1, 'mortar_pestle', 3, 'refining'),
  r('cementing_paste_k', 'Cementing Paste (keratin)', [['keratin', 2], ['stone', 4]], 'cementing_paste', 1, 'mortar_pestle', 3, 'refining'),
  r('polymer', 'Polymer ×2', [['obsidian', 2], ['cementing_paste', 2]], 'polymer', 2, 'fabricator', 5, 'refining'),
  r('electronics', 'Electronics', [['metal_ingot', 1], ['silica_pearls', 3]], 'electronics', 1, 'fabricator', 5, 'refining'),

  // ---- food & medicine -------------------------------------------------------------
  r('narcotic', 'Narcotic', [['narcoberry', 5], ['spoiled_meat', 1]], 'narcotic', 1, 'mortar_pestle', 3, 'food'),
  r('stimulant', 'Stimulant', [['stimberry', 5], ['sparkpowder', 2]], 'stimulant', 1, 'mortar_pestle', 3, 'food'),
  r('cook_meat', 'Cook Meat', [['raw_meat', 1]], 'cooked_meat', 1, 'campfire', 6, 'food', true),
  r('boil_water', 'Boil Water', [['water_raw', 1]], 'water_boiled', 1, 'campfire', 5, 'food', true),
];

export const RECIPES_BY_ID: ReadonlyMap<string, Recipe> = new Map(RECIPES.map((x) => [x.id, x]));
