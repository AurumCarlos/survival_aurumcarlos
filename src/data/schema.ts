/**
 * Data schema for the survival simulation. Everything here is plain,
 * serialisable data (no class instances, no Three.js types) so a Survivor can
 * be saved to IndexedDB, sent over the network, or asserted on in tests.
 */

export type EntityId = number;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// ---------------------------------------------------------------------------
// Items & resources
// ---------------------------------------------------------------------------

export type ItemId =
  | 'wood'
  | 'stone'
  | 'fiber'
  | 'raw_meat'
  | 'cooked_meat'
  | 'berries'
  | 'water_raw'
  | 'water_boiled'
  | 'hide'
  | 'stone_axe'
  | 'stone_pickaxe'
  | 'stone_spear'
  | 'torch'
  | 'campfire_kit'
  | 'lean_to_kit'
  | 'fur_cloak';

export type ItemCategory = 'material' | 'food' | 'drink' | 'tool' | 'weapon' | 'placeable' | 'wearable';

export type ToolTag = 'axe' | 'pickaxe' | 'blade';

export interface ItemDef {
  id: ItemId;
  name: string;
  category: ItemCategory;
  maxStack: number;
  /** Footprint in the inventory grid (Tarkov/Resident Evil style). */
  size: { w: number; h: number };
  /** Applied when consumed. Negative values are allowed (raw meat → sickness risk). */
  consumable?: {
    hunger?: number;
    thirst?: number;
    energy?: number;
    health?: number;
    /** Chance (0..1) to apply an effect on consumption, e.g. food poisoning. */
    sideEffect?: { effect: StatusEffectId; chance: number; duration: number };
  };
  tool?: {
    tags: ToolTag[];
    /** Multiplier on yields from matching resources. */
    gatherMultiplier: number;
    damage: number;
    maxDurability: number;
  };
  wearable?: {
    /** °C added to effective ambient temperature when cold. */
    insulation: number;
  };
  /** For placeables: which structure entity to spawn. */
  places?: 'campfire' | 'lean_to';
}

/** A stack living in an inventory. Durability only applies to tools. */
export interface ItemStack {
  item: ItemId;
  qty: number;
  durability?: number;
}

export type ResourceKind = 'tree' | 'rock' | 'berry_bush' | 'fiber_plant' | 'carcass' | 'water_source';

export interface ResourceYield {
  item: ItemId;
  min: number;
  max: number;
  /** 0..1, rolled per harvest action. */
  chance: number;
}

/**
 * A harvestable world object. Lives as a component on a world entity; the
 * render layer reads `kind` and `variant` to pick a low-poly mesh.
 */
export interface Resource {
  id: EntityId;
  kind: ResourceKind;
  /** Visual variation index (e.g. 0..3 tree shapes). */
  variant: number;
  position: Vec3;
  /** Each harvest action consumes 1 (or tool power) of this. 0 = depleted. */
  hitPoints: number;
  maxHitPoints: number;
  yields: ResourceYield[];
  /** Harvesting without this tool is slower (bare hands) or impossible. */
  requiredTool?: ToolTag;
  allowBareHands: boolean;
  /** Seconds until it regrows after depletion. Infinity = never (carcasses). */
  respawnSeconds: number;
  /** Counts down while depleted. */
  respawnTimer: number;
  /** Noise radius (m) produced when harvested — chopping a tree is loud. */
  harvestNoise: number;
  /** Infinite resources (rivers) ignore hitPoints. */
  infinite: boolean;
}

// ---------------------------------------------------------------------------
// Survivor
// ---------------------------------------------------------------------------

export interface Vitals {
  health: number; // 0..max
  hunger: number; // 100 = full, 0 = starving
  thirst: number; // 100 = hydrated, 0 = dehydrated
  energy: number; // 100 = rested, 0 = exhausted
  stamina: number; // short-term sprint pool, regenerates quickly
  /** Core body temperature in °C. 37 = normal. */
  bodyTemp: number;
}

export type StatusEffectId =
  | 'starving'
  | 'dehydrated'
  | 'exhausted'
  | 'cold'
  | 'hypothermia'
  | 'hot'
  | 'hyperthermia'
  | 'warmed_by_fire'
  | 'sheltered'
  | 'well_fed'
  | 'food_poisoning'
  | 'bleeding';

export interface StatusEffect {
  id: StatusEffectId;
  /**
   * Seconds remaining. `Infinity` for condition-driven effects (e.g. "cold")
   * that the status manager adds and removes based on the vitals.
   */
  remaining: number;
  /** Intensity for stackable effects (bleeding). */
  stacks: number;
  source: 'condition' | 'consumable' | 'combat' | 'environment';
}

export type Activity = 'idle' | 'walking' | 'sprinting' | 'crouching' | 'gathering' | 'swimming' | 'sleeping';

export interface InventoryGridData {
  cols: number;
  rows: number;
  /** Top-left anchored placements. Occupancy is derived, not stored. */
  placements: Array<{ x: number; y: number; stack: ItemStack }>;
}

export interface Survivor {
  id: EntityId;
  name: string;
  vitals: Vitals;
  maxVitals: Pick<Vitals, 'health' | 'hunger' | 'thirst' | 'energy' | 'stamina'>;
  inventory: InventoryGridData;
  /** Indices into a separate 1×N hotbar; null = empty slot. */
  hotbar: Array<ItemStack | null>;
  activeHotbarSlot: number;
  equipped: { body: ItemStack | null };
  effects: StatusEffect[];
  activity: Activity;
  alive: boolean;
  /** Read by movement/combat systems; recomputed by the status manager each tick. */
  modifiers: SurvivorModifiers;
  /** Lifetime counters, used for score screen and achievements. */
  stats: { secondsSurvived: number; distanceTravelled: number; itemsCrafted: number };
}

export interface SurvivorModifiers {
  moveSpeed: number; // multiplier, 1 = normal
  canSprint: boolean;
  gatherSpeed: number;
  staminaRegen: number;
  /** 0..1 screen-space effects the HUD can use (frost vignette, heat shimmer). */
  coldOverlay: number;
  heatOverlay: number;
}

/** Thermal context computed by EnvironmentSystem for each survivor every tick. */
export interface ThermalExposure {
  ambientC: number;
  /** °C contributed by nearby heat sources (campfires, torches), after falloff. */
  fireWarmthC: number;
  /** 0..1 — how much of the ambient extreme the shelter blocks. */
  shelterInsulation: number;
  /** °C from worn clothing; only counters cold. */
  clothingInsulationC: number;
  wet: boolean;
}
