import type { ItemDef, ItemId, Resource, ResourceKind, ResourceYield, ToolTag } from './schema';

const defs: ItemDef[] = [
  { id: 'wood', name: 'Wood', category: 'material', maxStack: 20, size: { w: 1, h: 1 } },
  { id: 'stone', name: 'Stone', category: 'material', maxStack: 20, size: { w: 1, h: 1 } },
  { id: 'fiber', name: 'Plant Fiber', category: 'material', maxStack: 30, size: { w: 1, h: 1 } },
  { id: 'hide', name: 'Hide', category: 'material', maxStack: 5, size: { w: 2, h: 1 } },
  {
    id: 'raw_meat', name: 'Raw Meat', category: 'food', maxStack: 5, size: { w: 1, h: 1 },
    consumable: { hunger: 15, sideEffect: { effect: 'food_poisoning', chance: 0.5, duration: 90 } },
  },
  { id: 'cooked_meat', name: 'Cooked Meat', category: 'food', maxStack: 5, size: { w: 1, h: 1 }, consumable: { hunger: 40, energy: 5 } },
  { id: 'berries', name: 'Berries', category: 'food', maxStack: 15, size: { w: 1, h: 1 }, consumable: { hunger: 6, thirst: 4 } },
  {
    id: 'water_raw', name: 'Murky Water', category: 'drink', maxStack: 3, size: { w: 1, h: 1 },
    consumable: { thirst: 30, sideEffect: { effect: 'food_poisoning', chance: 0.25, duration: 60 } },
  },
  { id: 'water_boiled', name: 'Boiled Water', category: 'drink', maxStack: 3, size: { w: 1, h: 1 }, consumable: { thirst: 40 } },
  {
    id: 'stone_axe', name: 'Stone Axe', category: 'tool', maxStack: 1, size: { w: 1, h: 2 },
    tool: { tags: ['axe'], gatherMultiplier: 2.5, damage: 18, maxDurability: 120 },
  },
  {
    id: 'stone_pickaxe', name: 'Stone Pickaxe', category: 'tool', maxStack: 1, size: { w: 1, h: 2 },
    tool: { tags: ['pickaxe'], gatherMultiplier: 2.5, damage: 15, maxDurability: 120 },
  },
  {
    id: 'stone_spear', name: 'Stone Spear', category: 'weapon', maxStack: 1, size: { w: 1, h: 3 },
    tool: { tags: ['blade'], gatherMultiplier: 2.5, damage: 35, maxDurability: 60 },
  },
  { id: 'torch', name: 'Torch', category: 'tool', maxStack: 1, size: { w: 1, h: 2 }, tool: { tags: [], gatherMultiplier: 1, damage: 8, maxDurability: 300 } },
  { id: 'campfire_kit', name: 'Campfire', category: 'placeable', maxStack: 1, size: { w: 2, h: 2 }, places: 'campfire' },
  { id: 'lean_to_kit', name: 'Lean-to Shelter', category: 'placeable', maxStack: 1, size: { w: 2, h: 2 }, places: 'lean_to' },
  { id: 'fur_cloak', name: 'Fur Cloak', category: 'wearable', maxStack: 1, size: { w: 2, h: 2 }, wearable: { insulation: 8 } },
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

export const RESOURCE_TEMPLATES: Readonly<Record<ResourceKind, ResourceTemplate>> = {
  tree: {
    maxHitPoints: 8,
    yields: [{ item: 'wood', min: 1, max: 2, chance: 1 }, { item: 'fiber', min: 0, max: 1, chance: 0.3 }],
    requiredTool: 'axe', allowBareHands: true, respawnSeconds: 900, harvestNoise: 14, infinite: false,
  },
  rock: {
    maxHitPoints: 6,
    yields: [{ item: 'stone', min: 1, max: 2, chance: 1 }],
    requiredTool: 'pickaxe', allowBareHands: true, respawnSeconds: 1200, harvestNoise: 16, infinite: false,
  },
  berry_bush: {
    maxHitPoints: 3, yields: [{ item: 'berries', min: 1, max: 3, chance: 1 }],
    allowBareHands: true, respawnSeconds: 600, harvestNoise: 3, infinite: false,
  },
  fiber_plant: {
    maxHitPoints: 2, yields: [{ item: 'fiber', min: 1, max: 3, chance: 1 }],
    allowBareHands: true, respawnSeconds: 400, harvestNoise: 2, infinite: false,
  },
  carcass: {
    maxHitPoints: 4,
    yields: [{ item: 'raw_meat', min: 1, max: 2, chance: 1 }, { item: 'hide', min: 1, max: 1, chance: 0.5 }],
    requiredTool: 'blade', allowBareHands: true, respawnSeconds: Number.POSITIVE_INFINITY, harvestNoise: 4, infinite: false,
  },
  water_source: {
    maxHitPoints: 1, yields: [{ item: 'water_raw', min: 1, max: 1, chance: 1 }],
    allowBareHands: true, respawnSeconds: 0, harvestNoise: 3, infinite: true,
  },
};

export function makeResource(id: number, kind: ResourceKind, position: Resource['position'], variant = 0): Resource {
  const t = RESOURCE_TEMPLATES[kind];
  const r: Resource = {
    id, kind, variant, position,
    hitPoints: t.maxHitPoints, maxHitPoints: t.maxHitPoints,
    yields: t.yields, allowBareHands: t.allowBareHands,
    respawnSeconds: t.respawnSeconds, respawnTimer: 0,
    harvestNoise: t.harvestNoise, infinite: t.infinite,
  };
  if (t.requiredTool) r.requiredTool = t.requiredTool;
  return r;
}
