import { itemDef } from '../data/items';
import type { ItemId, Survivor } from '../data/schema';
import type { InventoryGrid } from './inventory/InventoryGrid';

/** Bag size in test mode: the kit fills ~104 cells, leaving room to gather more. */
export const TEST_BAG = { cols: 16, rows: 10 } as const;

/** Best tool or weapon of each kind, in hotbar order (keys 1–6). */
const HOTBAR: readonly ItemId[] = ['metal_sword', 'metal_pike', 'bow', 'metal_hatchet', 'metal_pick', 'metal_sickle'];

/** [item, quantity] put in the bag. Quantities above the stack size fill several stacks. */
const BAG: ReadonlyArray<readonly [ItemId, number]> = [
  // gear
  ['stone_arrow', 200], ['torch', 1], ['gps', 1], ['fur_cloak', 1],
  // raw resources
  ['wood', 300], ['thatch', 200], ['stone', 300], ['flint', 200], ['fiber', 200], ['hide', 40], ['pelt', 40],
  ['keratin', 100], ['chitin', 100], ['metal', 100], ['obsidian', 100], ['crystal', 100], ['oil', 100],
  ['silica_pearls', 100], ['black_pearl', 20], ['sulfur', 50], ['salt', 50], ['rare_flower', 20], ['rare_mushroom', 20],
  // refined
  ['metal_ingot', 300], ['charcoal', 100], ['sparkpowder', 100], ['gunpowder', 100], ['cementing_paste', 100],
  ['gasoline', 50], ['polymer', 50], ['electronics', 50],
  // food, drink & medicine
  ['cooked_prime_meat', 10], ['prime_jerky', 10], ['water_boiled', 10], ['medical_brew', 10], ['energy_brew', 10],
  // every crafting station
  ['campfire_kit', 1], ['storage_box_kit', 1], ['large_storage_box_kit', 1], ['mortar_pestle_kit', 1], ['smithy_kit', 1],
  ['refining_forge_kit', 1], ['cooking_pot_kit', 1], ['preserving_bin_kit', 1], ['fabricator_kit', 1], ['lean_to_kit', 1],
];

/**
 * Test mode loadout: the best weapons and tools in the hotbar, the strongest
 * armour worn, and a bag (enlarged to 16×10) full of resources, refined
 * materials, food and station kits. Returns the items that did not fit.
 */
export function giveTestKit(s: Survivor, bag: InventoryGrid): ItemId[] {
  HOTBAR.forEach((id, i) => {
    s.hotbar[i] = { item: id, qty: 1, durability: itemDef(id).tool!.maxDurability };
  });
  s.activeHotbarSlot = 0;
  s.equipped.body = { item: 'flak_armor', qty: 1 };
  const lost: ItemId[] = [];
  for (const [id, qty] of BAG) {
    const def = itemDef(id);
    if (bag.add(id, qty, def.tool?.maxDurability) > 0) lost.push(id);
  }
  return lost;
}
