import type { ItemDef, ItemId, Resource, ResourceKind, ResourceYield, ToolTag } from './schema';

const M = (id: ItemId, name: string, maxStack: number, description: string, category: ItemDef['category'] = 'material'): ItemDef =>
  ({ id, name, category, maxStack, size: { w: 1, h: 1 }, description });
const food = (id: ItemId, name: string, maxStack: number, c: NonNullable<ItemDef['consumable']>, description: string, category: ItemDef['category'] = 'food'): ItemDef =>
  ({ id, name, category, maxStack, size: { w: 1, h: 1 }, consumable: c, description });
const kit = (id: ItemId, name: string, places: NonNullable<ItemDef['places']>, description: string): ItemDef =>
  ({ id, name, category: 'placeable', maxStack: 1, size: { w: 2, h: 2 }, places, description });

/**
 * Every item. Resources, refining products, food and stations follow ARK:
 * Survival Evolved's base game (The Island), scaled to this game's pace.
 */
const defs: ItemDef[] = [
  // ---- raw resources -------------------------------------------------------------------
  M('wood', 'Wood', 100, 'Chop trees — an axe gets far more.'),
  M('thatch', 'Thatch', 100, 'Punch trees (or pick them) for thatch.'),
  M('stone', 'Stone', 100, 'From rocks; a pickaxe gets far more.'),
  M('flint', 'Flint', 100, 'From rocks, best with a pickaxe.'),
  M('fiber', 'Plant Fiber', 100, 'From bushes and plants; a sickle triples it.'),
  { id: 'hide', name: 'Hide', category: 'material', maxStack: 20, size: { w: 2, h: 1 }, description: 'Skinned from any animal.' },
  M('pelt', 'Pelt', 20, 'Thick fur from wolves — for Fur Armor.'),
  M('keratin', 'Keratin', 50, 'Boar tusks and hooves.'),
  M('chitin', 'Chitin', 50, 'Shell fragments from the shell beds on the beach.'),
  M('metal', 'Metal Ore', 50, 'Metal rocks (shiny veins) need a pickaxe. Smelt in a forge.'),
  M('obsidian', 'Obsidian', 50, 'Black glassy rocks inland.'),
  M('crystal', 'Crystal', 50, 'Crystal clusters, mined with a pickaxe.'),
  M('oil', 'Oil', 50, 'Dark tar rocks on the beach.'),
  M('silica_pearls', 'Silica Pearls', 50, 'Shell beds along the shore.'),
  M('black_pearl', 'Black Pearl', 20, 'A rare find in shell beds.'),
  M('sulfur', 'Sulfur', 50, 'Yellow crust found on obsidian rocks.'),
  M('salt', 'Salt', 50, 'White salt crusts on the beach.'),
  M('rare_flower', 'Rare Flower', 20, 'Bright flowers in clearings.'),
  M('rare_mushroom', 'Rare Mushroom', 20, 'Red mushrooms on the damp forest floor.'),
  food('spoiled_meat', 'Spoiled Meat', 20, { hunger: 8, sideEffect: { effect: 'food_poisoning', chance: 0.9, duration: 120 } }, 'Inedible, but makes Narcotics.'),

  // ---- refined ---------------------------------------------------------------------
  M('charcoal', 'Charcoal', 100, 'Left over when wood burns in a fire or forge.', 'refined'),
  M('sparkpowder', 'Sparkpowder', 100, 'Mortar & Pestle: flint + stone.', 'refined'),
  M('gunpowder', 'Gunpowder', 100, 'Mortar & Pestle: sparkpowder + charcoal.', 'refined'),
  M('cementing_paste', 'Cementing Paste', 100, 'Mortar & Pestle: chitin or keratin + stone.', 'refined'),
  M('metal_ingot', 'Metal Ingot', 100, 'Smelted from metal ore in a Refining Forge.', 'refined'),
  M('gasoline', 'Gasoline', 50, 'Refining Forge: oil + hide. Powers the Fabricator.', 'refined'),
  M('polymer', 'Polymer', 50, 'Fabricator: obsidian + cementing paste.', 'refined'),
  M('electronics', 'Electronics', 50, 'Fabricator: metal ingot + silica pearls.', 'refined'),
  food('narcotic', 'Narcotic', 20, { energy: -15, health: 5 }, 'Numbs pain. Makes you drowsy.', 'medicine'),
  food('stimulant', 'Stimulant', 20, { energy: 25, thirst: -10 }, 'Wakes you up; makes you thirsty.', 'medicine'),

  // ---- food & drink ----------------------------------------------------------------
  food('raw_meat', 'Raw Meat', 20, { hunger: 15, sideEffect: { effect: 'food_poisoning', chance: 0.5, duration: 90 } }, 'Cook it first.'),
  food('cooked_meat', 'Cooked Meat', 20, { hunger: 40, energy: 5 }, 'Campfire or cooking pot.'),
  food('raw_prime_meat', 'Raw Prime Meat', 10, { hunger: 25, sideEffect: { effect: 'food_poisoning', chance: 0.5, duration: 90 } }, 'Choice cut from deer and boar.'),
  food('cooked_prime_meat', 'Cooked Prime Meat', 10, { hunger: 60, energy: 10, health: 10 }, 'Very filling.'),
  food('raw_fish', 'Raw Fish Meat', 20, { hunger: 10, sideEffect: { effect: 'food_poisoning', chance: 0.3, duration: 60 } }, 'Caught in fish shoals by the shore.'),
  food('cooked_fish', 'Cooked Fish Meat', 20, { hunger: 30, thirst: 3 }, 'Light and safe.'),
  food('jerky', 'Cooked Meat Jerky', 20, { hunger: 45, energy: 10, health: 5 }, 'Preserving Bin: cooked meat + oil + sparkpowder.'),
  food('prime_jerky', 'Prime Meat Jerky', 10, { hunger: 70, energy: 15, health: 15 }, 'Preserving Bin: cooked prime meat + salt + oil.'),
  food('berries', 'Mejoberry', 50, { hunger: 6, thirst: 4 }, 'Common sweet berries.'),
  food('amarberry', 'Amarberry', 50, { hunger: 4, thirst: 5 }, 'Yellow berries.'),
  food('azulberry', 'Azulberry', 50, { hunger: 4, thirst: 5 }, 'Blue berries — for Energy Brew.'),
  food('tintoberry', 'Tintoberry', 50, { hunger: 4, thirst: 5 }, 'Red berries — for Medical Brew.'),
  food('narcoberry', 'Narcoberry', 50, { hunger: 3, energy: -5 }, 'Dark berries that make you sleepy.'),
  food('stimberry', 'Stimberry', 50, { hunger: 3, energy: 6, thirst: -3 }, 'Pale berries that keep you awake.'),
  food('water_raw', 'Murky Water', 5, { thirst: 30, sideEffect: { effect: 'food_poisoning', chance: 0.25, duration: 60 } }, 'From ponds. Boil it.', 'drink'),
  food('water_boiled', 'Boiled Water', 5, { thirst: 40 }, 'Safe to drink.', 'drink'),
  food('medical_brew', 'Medical Brew', 10, { health: 40, thirst: 5 }, 'Cooking Pot: tintoberries + narcotic + water.', 'medicine'),
  food('energy_brew', 'Energy Brew', 10, { energy: 40, thirst: 5 }, 'Cooking Pot: azulberries + stimulant + water.', 'medicine'),
  food('mushroom_stew', 'Mushroom Stew', 10, { hunger: 55, thirst: 20, health: 10 }, 'Cooking Pot: rare mushroom + cooked meat + water.'),
  food('flower_tea', 'Flower Tea', 10, { thirst: 35, energy: 25 }, 'Cooking Pot: rare flower + water.', 'drink'),

  // ---- tools & weapons ---------------------------------------------------------------
  { id: 'stone_axe', name: 'Stone Hatchet', category: 'tool', maxStack: 1, size: { w: 1, h: 2 }, tool: { tags: ['axe'], gatherMultiplier: 2.5, damage: 18, maxDurability: 120 }, description: 'Chops wood.' },
  { id: 'stone_pickaxe', name: 'Stone Pick', category: 'tool', maxStack: 1, size: { w: 1, h: 2 }, tool: { tags: ['pickaxe'], gatherMultiplier: 2.5, damage: 15, maxDurability: 120 }, description: 'Mines stone, flint and ore.' },
  { id: 'metal_hatchet', name: 'Metal Hatchet', category: 'tool', maxStack: 1, size: { w: 1, h: 2 }, tool: { tags: ['axe'], gatherMultiplier: 4, damage: 28, maxDurability: 300 }, description: 'Much more wood, lasts far longer.' },
  { id: 'metal_pick', name: 'Metal Pick', category: 'tool', maxStack: 1, size: { w: 1, h: 2 }, tool: { tags: ['pickaxe'], gatherMultiplier: 4, damage: 24, maxDurability: 300 }, description: 'Much more ore, stone and crystal.' },
  { id: 'metal_sickle', name: 'Metal Sickle', category: 'tool', maxStack: 1, size: { w: 1, h: 2 }, tool: { tags: ['sickle'], gatherMultiplier: 3, damage: 22, maxDurability: 250 }, description: 'Triples fiber and berries.' },
  { id: 'torch', name: 'Torch', category: 'tool', maxStack: 1, size: { w: 1, h: 2 }, tool: { tags: [], gatherMultiplier: 1, damage: 8, maxDurability: 300 }, description: 'Lights the way at night.' },
  { id: 'stone_spear', name: 'Spear', category: 'weapon', maxStack: 1, size: { w: 1, h: 3 }, tool: { tags: ['blade'], gatherMultiplier: 2.5, damage: 35, maxDurability: 60 }, description: 'Right-click to throw. Butchers carcasses.' },
  { id: 'metal_pike', name: 'Pike', category: 'weapon', maxStack: 1, size: { w: 1, h: 3 }, tool: { tags: ['blade'], gatherMultiplier: 3.5, damage: 55, maxDurability: 200 }, description: 'Long metal-tipped spear.' },
  { id: 'wooden_club', name: 'Wooden Club', category: 'weapon', maxStack: 1, size: { w: 1, h: 2 }, tool: { tags: [], gatherMultiplier: 1, damage: 24, maxDurability: 90 }, description: 'Simple and heavy.' },
  { id: 'metal_sword', name: 'Sword', category: 'weapon', maxStack: 1, size: { w: 1, h: 2 }, tool: { tags: ['blade'], gatherMultiplier: 3, damage: 50, maxDurability: 160 }, description: 'Fast, deadly blade.' },
  { id: 'bow', name: 'Bow', category: 'weapon', maxStack: 1, size: { w: 1, h: 2 }, tool: { tags: [], gatherMultiplier: 1, damage: 32, maxDurability: 150 }, ammo: 'stone_arrow', description: 'Left-click to shoot Stone Arrows.' },
  { id: 'stone_arrow', name: 'Stone Arrow', category: 'ammo', maxStack: 50, size: { w: 1, h: 1 }, description: 'Ammunition for the bow; often recoverable.' },
  { id: 'gps', name: 'GPS', category: 'tool', maxStack: 1, size: { w: 1, h: 1 }, description: 'Shows your coordinates while you carry it.' },

  // ---- armour -----------------------------------------------------------------------
  { id: 'cloth_armor', name: 'Cloth Armor', category: 'wearable', maxStack: 1, size: { w: 2, h: 2 }, wearable: { insulation: 4, armor: 0.1 }, description: 'Light fiber clothes.' },
  { id: 'hide_armor', name: 'Hide Armor', category: 'wearable', maxStack: 1, size: { w: 2, h: 2 }, wearable: { insulation: 6, armor: 0.2 }, description: 'Leather: warm and tough.' },
  { id: 'fur_cloak', name: 'Fur Armor', category: 'wearable', maxStack: 1, size: { w: 2, h: 2 }, wearable: { insulation: 10, armor: 0.25 }, description: 'The warmest clothes.' },
  { id: 'chitin_armor', name: 'Chitin Armor', category: 'wearable', maxStack: 1, size: { w: 2, h: 2 }, wearable: { insulation: 3, armor: 0.35 }, description: 'Hard shell plates.' },
  { id: 'flak_armor', name: 'Flak Armor', category: 'wearable', maxStack: 1, size: { w: 2, h: 2 }, wearable: { insulation: 2, armor: 0.5 }, description: 'Metal plating: halves damage.' },

  // ---- placeables ---------------------------------------------------------------------
  kit('campfire_kit', 'Campfire', 'campfire', 'Warmth and light. Burns wood/thatch; cooks meat, boils water.'),
  kit('lean_to_kit', 'Lean-to Shelter', 'lean_to', 'Quick roof against cold and rain.'),
  kit('storage_box_kit', 'Storage Box', 'storage_box', 'Stores 24 slots of items.'),
  kit('large_storage_box_kit', 'Large Storage Box', 'large_storage_box', 'Stores 60 slots of items.'),
  kit('mortar_pestle_kit', 'Mortar & Pestle', 'mortar_pestle', 'Station: sparkpowder, gunpowder, paste, narcotics…'),
  kit('smithy_kit', 'Smithy', 'smithy', 'Station: metal tools, weapons and armor.'),
  kit('refining_forge_kit', 'Refining Forge', 'refining_forge', 'Smelts metal into ingots, makes gasoline. Burns wood.'),
  kit('cooking_pot_kit', 'Cooking Pot', 'cooking_pot', 'Cooks meat, brews and stews. Burns wood.'),
  kit('preserving_bin_kit', 'Preserving Bin', 'preserving_bin', 'Turns cooked meat into jerky.'),
  kit('fabricator_kit', 'Fabricator', 'fabricator', 'Station: polymer, electronics, GPS. Runs on gasoline.'),
];

export const ITEMS: Readonly<Record<ItemId, ItemDef>> = Object.freeze(
  Object.fromEntries(defs.map((d) => [d.id, d])) as Record<ItemId, ItemDef>,
);

export function itemDef(id: ItemId): ItemDef {
  return ITEMS[id];
}

// ---------------------------------------------------------------------------
// Resource templates. The world generator stamps these onto entities.
// ---------------------------------------------------------------------------

interface ResourceTemplate {
  maxHitPoints: number;
  yields: ResourceYield[];
  requiredTool?: ToolTag;
  allowBareHands: boolean;
  respawnSeconds: number;
  harvestNoise: number;
  infinite: boolean;
}

const y = (item: ItemId, min: number, max: number, chance = 1, favour?: ResourceYield['favour']): ResourceYield =>
  favour ? { item, min, max, chance, favour } : { item, min, max, chance };

export const RESOURCE_TEMPLATES: Readonly<Record<ResourceKind, ResourceTemplate>> = {
  tree: {
    maxHitPoints: 8,
    yields: [y('wood', 1, 2), y('thatch', 1, 2, 0.8, 'hands'), y('fiber', 0, 1, 0.3)],
    requiredTool: 'axe', allowBareHands: true, respawnSeconds: 900, harvestNoise: 14, infinite: false,
  },
  rock: {
    maxHitPoints: 6,
    yields: [y('stone', 1, 2), y('flint', 0, 1, 0.7)],
    requiredTool: 'pickaxe', allowBareHands: true, respawnSeconds: 1200, harvestNoise: 16, infinite: false,
  },
  metal_rock: {
    maxHitPoints: 10,
    yields: [y('metal', 1, 2), y('stone', 0, 1, 0.6)],
    requiredTool: 'pickaxe', allowBareHands: false, respawnSeconds: 1800, harvestNoise: 18, infinite: false,
  },
  obsidian_rock: {
    maxHitPoints: 8,
    yields: [y('obsidian', 1, 2), y('sulfur', 0, 1, 0.35), y('stone', 0, 1, 0.4)],
    requiredTool: 'pickaxe', allowBareHands: false, respawnSeconds: 1800, harvestNoise: 18, infinite: false,
  },
  crystal: {
    maxHitPoints: 6,
    yields: [y('crystal', 1, 2), y('stone', 0, 1, 0.3)],
    requiredTool: 'pickaxe', allowBareHands: false, respawnSeconds: 1800, harvestNoise: 12, infinite: false,
  },
  oil_rock: {
    maxHitPoints: 6,
    yields: [y('oil', 1, 2), y('stone', 0, 1, 0.5)],
    requiredTool: 'pickaxe', allowBareHands: true, respawnSeconds: 1500, harvestNoise: 14, infinite: false,
  },
  shell_bed: {
    maxHitPoints: 4,
    yields: [y('silica_pearls', 1, 2), y('chitin', 0, 1, 0.5), y('black_pearl', 1, 1, 0.04)],
    requiredTool: 'pickaxe', allowBareHands: true, respawnSeconds: 1200, harvestNoise: 6, infinite: false,
  },
  salt_deposit: {
    maxHitPoints: 4, yields: [y('salt', 1, 2)],
    requiredTool: 'pickaxe', allowBareHands: true, respawnSeconds: 1200, harvestNoise: 6, infinite: false,
  },
  berry_bush: {
    maxHitPoints: 3, yields: [y('berries', 1, 3), y('fiber', 1, 2, 0.6, 'sickle')],
    allowBareHands: true, respawnSeconds: 600, harvestNoise: 3, infinite: false,
  },
  fiber_plant: {
    maxHitPoints: 2, yields: [y('fiber', 1, 3, 1, 'sickle')],
    allowBareHands: true, respawnSeconds: 400, harvestNoise: 2, infinite: false,
  },
  mushroom: {
    maxHitPoints: 1, yields: [y('rare_mushroom', 1, 1)],
    allowBareHands: true, respawnSeconds: 900, harvestNoise: 1, infinite: false,
  },
  rare_flower: {
    maxHitPoints: 1, yields: [y('rare_flower', 1, 1), y('fiber', 1, 1, 0.5)],
    allowBareHands: true, respawnSeconds: 900, harvestNoise: 1, infinite: false,
  },
  fish_shoal: {
    maxHitPoints: 3, yields: [y('raw_fish', 1, 2)],
    requiredTool: 'blade', allowBareHands: true, respawnSeconds: 600, harvestNoise: 4, infinite: false,
  },
  carcass: {
    maxHitPoints: 4,
    yields: [y('raw_meat', 1, 2), y('hide', 1, 1, 0.5)],
    requiredTool: 'blade', allowBareHands: true, respawnSeconds: Number.POSITIVE_INFINITY, harvestNoise: 4, infinite: false,
  },
  water_source: {
    maxHitPoints: 1, yields: [y('water_raw', 1, 1)],
    allowBareHands: true, respawnSeconds: 0, harvestNoise: 3, infinite: true,
  },
};

/** Berry bushes: the variant picks which two kinds of berries grow on it. */
export const BUSH_BERRIES: ReadonlyArray<readonly [ItemId, ItemId]> = [
  ['berries', 'tintoberry'], ['amarberry', 'azulberry'], ['berries', 'narcoberry'], ['tintoberry', 'stimberry'],
  ['azulberry', 'berries'], ['narcoberry', 'stimberry'],
];

/** Carcass variants by species index (deer, wolf, boar — see CARCASS_OF). */
const CARCASS_YIELDS: ReadonlyArray<ResourceYield[]> = [
  [y('raw_meat', 1, 2), y('raw_prime_meat', 1, 1, 0.3), y('hide', 1, 1, 0.6), y('spoiled_meat', 1, 1, 0.1)], // deer
  [y('raw_meat', 1, 2), y('pelt', 1, 1, 0.6), y('hide', 1, 1, 0.4), y('spoiled_meat', 1, 1, 0.15)], // wolf
  [y('raw_meat', 1, 2), y('raw_prime_meat', 1, 1, 0.25), y('hide', 1, 1, 0.5), y('keratin', 1, 2, 0.6), y('spoiled_meat', 1, 1, 0.1)], // boar
  [y('raw_meat', 2, 3), y('raw_prime_meat', 1, 2, 0.6), y('hide', 1, 2, 0.8), y('keratin', 1, 3, 0.8)], // crocodile
  [y('raw_meat', 2, 4), y('raw_prime_meat', 1, 2, 0.7), y('pelt', 1, 2, 0.9), y('hide', 1, 2, 0.7)], // bear
];
export const CARCASS_OF: Readonly<Record<string, number>> = { deer: 0, wolf: 1, boar: 2, crocodile: 3, bear: 4 };

export function makeResource(id: number, kind: ResourceKind, position: Resource['position'], variant = 0): Resource {
  const t = RESOURCE_TEMPLATES[kind];
  let yields = t.yields;
  if (kind === 'berry_bush') {
    const [a, b] = BUSH_BERRIES[variant % BUSH_BERRIES.length]!;
    yields = [y(a, 1, 3, 1, 'sickle'), y(b, 1, 2, 0.8, 'sickle'), y('fiber', 1, 2, 0.6, 'sickle')];
  } else if (kind === 'carcass' && CARCASS_YIELDS[variant]) {
    yields = CARCASS_YIELDS[variant]!;
  }
  const r: Resource = {
    id, kind, variant, position,
    hitPoints: t.maxHitPoints, maxHitPoints: t.maxHitPoints,
    yields, allowBareHands: t.allowBareHands,
    respawnSeconds: t.respawnSeconds, respawnTimer: 0,
    harvestNoise: t.harvestNoise, infinite: t.infinite,
  };
  if (t.requiredTool) r.requiredTool = t.requiredTool;
  return r;
}

/** Display names for resource nodes (HUD prompt). */
export const RESOURCE_LABEL: Readonly<Record<ResourceKind, string>> = {
  tree: 'Tree', rock: 'Rock', berry_bush: 'Berry bush', fiber_plant: 'Fiber plant', carcass: 'Carcass', water_source: 'Pond water',
  mushroom: 'Rare mushroom', metal_rock: 'Metal rock', obsidian_rock: 'Obsidian', crystal: 'Crystal', oil_rock: 'Oil rock',
  shell_bed: 'Shell bed', salt_deposit: 'Salt crust', rare_flower: 'Rare flower', fish_shoal: 'Fish shoal',
};
