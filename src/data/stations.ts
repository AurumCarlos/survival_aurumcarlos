import type { CraftingStation } from './recipes';
import type { ItemId, PlaceableKind } from './schema';

/**
 * Placed structures (ARK-style): storage boxes, crafting stations, and
 * fires/forges/pots that cook or smelt whatever is put inside them while lit.
 */

export interface ProcessRecipe {
  id: string;
  name: string;
  inputs: ReadonlyArray<{ item: ItemId; qty: number }>;
  output: { item: ItemId; qty: number };
  /** Seconds per batch while the station is lit. */
  time: number;
}

export interface StructureDef {
  label: string;
  /** Storage grid (cols × rows), or null for structures without an inventory. */
  slots: { cols: number; rows: number } | null;
  /** Burnable items → seconds of fire each. Null: needs no fuel. */
  fuel: Readonly<Partial<Record<ItemId, number>>> | null;
  /** What it cooks/smelts by itself while lit (or always, when it needs no fuel). */
  processes: readonly ProcessRecipe[];
  /** Unlocks these recipes in the crafting menu when the player stands next to it. */
  craftStation: CraftingStation | null;
  /** Warmth when lit. */
  heat: { peakWarmthC: number; radius: number; scaresCreatures: boolean } | null;
  /** Collider/footprint half-size (m) and height. */
  size: { hx: number; hz: number; h: number };
  /** Item given back when picked up (null: can't be picked up). */
  kit: ItemId | null;
}

const p = (id: string, name: string, inputs: Array<[ItemId, number]>, output: ItemId, qty: number, time: number): ProcessRecipe =>
  ({ id, name, inputs: inputs.map(([item, q]) => ({ item, qty: q })), output: { item: output, qty }, time });

const COOKING: readonly ProcessRecipe[] = [
  p('cook_meat', 'Cooked Meat', [['raw_meat', 1]], 'cooked_meat', 1, 8),
  p('cook_prime', 'Cooked Prime Meat', [['raw_prime_meat', 1]], 'cooked_prime_meat', 1, 10),
  p('cook_fish', 'Cooked Fish Meat', [['raw_fish', 1]], 'cooked_fish', 1, 6),
  p('boil_water', 'Boiled Water', [['water_raw', 1]], 'water_boiled', 1, 6),
];

/** Wood leaves charcoal behind when it burns (as in ARK). */
export const CHARCOAL_FROM: Readonly<Partial<Record<ItemId, number>>> = { wood: 1 };

const FIRE_FUEL = { wood: 40, thatch: 10, sparkpowder: 60 } as const;

export const STRUCTURES: Readonly<Record<PlaceableKind, StructureDef>> = {
  campfire: {
    label: 'Campfire', slots: { cols: 6, rows: 2 }, fuel: FIRE_FUEL, processes: COOKING, craftStation: 'campfire',
    heat: { peakWarmthC: 28, radius: 6, scaresCreatures: true }, size: { hx: 0.6, hz: 0.6, h: 0.4 }, kit: 'campfire_kit',
  },
  lean_to: {
    label: 'Lean-to Shelter', slots: null, fuel: null, processes: [], craftStation: null, heat: null,
    size: { hx: 1.5, hz: 1.3, h: 2.2 }, kit: 'lean_to_kit',
  },
  storage_box: {
    label: 'Storage Box', slots: { cols: 6, rows: 4 }, fuel: null, processes: [], craftStation: null, heat: null,
    size: { hx: 0.5, hz: 0.35, h: 0.6 }, kit: 'storage_box_kit',
  },
  large_storage_box: {
    label: 'Large Storage Box', slots: { cols: 10, rows: 6 }, fuel: null, processes: [], craftStation: null, heat: null,
    size: { hx: 0.75, hz: 0.45, h: 0.85 }, kit: 'large_storage_box_kit',
  },
  mortar_pestle: {
    label: 'Mortar & Pestle', slots: null, fuel: null, processes: [], craftStation: 'mortar_pestle', heat: null,
    size: { hx: 0.3, hz: 0.3, h: 0.5 }, kit: 'mortar_pestle_kit',
  },
  smithy: {
    label: 'Smithy', slots: null, fuel: null, processes: [], craftStation: 'smithy', heat: null,
    size: { hx: 0.8, hz: 0.5, h: 1 }, kit: 'smithy_kit',
  },
  refining_forge: {
    label: 'Refining Forge', slots: { cols: 6, rows: 3 }, fuel: { wood: 30, thatch: 8, sparkpowder: 45 },
    processes: [
      p('smelt_metal', 'Metal Ingot', [['metal', 2]], 'metal_ingot', 1, 10),
      p('gasoline', 'Gasoline ×2', [['oil', 2], ['hide', 1]], 'gasoline', 2, 15),
    ],
    craftStation: null, heat: { peakWarmthC: 16, radius: 4, scaresCreatures: true }, size: { hx: 0.7, hz: 0.7, h: 1.6 }, kit: 'refining_forge_kit',
  },
  cooking_pot: {
    label: 'Cooking Pot', slots: { cols: 6, rows: 3 }, fuel: FIRE_FUEL,
    processes: [
      p('medical_brew', 'Medical Brew', [['tintoberry', 10], ['narcotic', 1], ['water_raw', 1]], 'medical_brew', 1, 15),
      p('energy_brew', 'Energy Brew', [['azulberry', 10], ['stimulant', 1], ['water_raw', 1]], 'energy_brew', 1, 15),
      p('mushroom_stew', 'Mushroom Stew', [['rare_mushroom', 1], ['cooked_meat', 1], ['water_raw', 1]], 'mushroom_stew', 1, 15),
      p('flower_tea', 'Flower Tea', [['rare_flower', 1], ['water_raw', 1]], 'flower_tea', 1, 10),
      ...COOKING,
    ],
    craftStation: null, heat: { peakWarmthC: 14, radius: 4, scaresCreatures: true }, size: { hx: 0.6, hz: 0.6, h: 0.9 }, kit: 'cooking_pot_kit',
  },
  preserving_bin: {
    label: 'Preserving Bin', slots: { cols: 6, rows: 2 }, fuel: null,
    processes: [
      p('jerky', 'Cooked Meat Jerky', [['cooked_meat', 1], ['oil', 1], ['sparkpowder', 1]], 'jerky', 1, 20),
      p('prime_jerky', 'Prime Meat Jerky', [['cooked_prime_meat', 1], ['salt', 1], ['oil', 1]], 'prime_jerky', 1, 25),
    ],
    craftStation: null, heat: null, size: { hx: 0.5, hz: 0.4, h: 0.8 }, kit: 'preserving_bin_kit',
  },
  death_bag: {
    label: 'Your belongings', slots: { cols: 10, rows: 9 }, fuel: null, processes: [], craftStation: null, heat: null,
    size: { hx: 0.35, hz: 0.3, h: 0.5 }, kit: null,
  },
  fabricator: {
    label: 'Fabricator', slots: { cols: 4, rows: 2 }, fuel: { gasoline: 120 }, processes: [], craftStation: 'fabricator',
    heat: null, size: { hx: 0.7, hz: 0.5, h: 1.3 }, kit: 'fabricator_kit',
  },
};

export const PLACEABLE_KINDS = Object.keys(STRUCTURES) as PlaceableKind[];

/** Every process recipe with the stations that run it (for the crafting panel's reference tab). */
export function processingCatalogue(): Array<{ recipe: ProcessRecipe; stations: PlaceableKind[] }> {
  const out = new Map<string, { recipe: ProcessRecipe; stations: PlaceableKind[] }>();
  for (const kind of PLACEABLE_KINDS) {
    for (const r of STRUCTURES[kind].processes) {
      const e = out.get(r.id) ?? { recipe: r, stations: [] };
      e.stations.push(kind);
      out.set(r.id, e);
    }
  }
  return [...out.values()];
}
