import { DEFAULT_TERRAIN, GENERATOR_VERSION, type TerrainConfig } from './TerrainGenerator';

/** What the player chooses on the configuration screen. Persisted in saves. */
export interface MapConfig {
  seed: number;
  /** Edge length in metres (square map). */
  size: number;
  /**
   * Terrain generator version (see TerrainGenerator.GENERATOR_VERSION). Saves
   * from before mountains and caves have none = 1, and regenerate the same
   * flat island they were made on.
   */
  gen?: number;
  /** Test mode: the survivor starts with the best gear and stacks of every resource. */
  testMode?: boolean;
  /** Spectator mode: fly freely and fast; animals never notice you; no hunger, no harm. */
  spectator?: boolean;
}

export const MAP_LIMITS = { minSize: 128, maxSize: 512, step: 32 } as const;

export const MAP_PRESETS: ReadonlyArray<{ label: string; size: number; hint: string }> = [
  { label: 'Small', size: 128, hint: 'Quick games, tight resources' },
  { label: 'Medium', size: 256, hint: 'Recommended' },
  { label: 'Large', size: 384, hint: 'More to explore' },
  { label: 'Huge', size: 512, hint: 'Longest generation time' },
];

export class MapConfigError extends Error {}

/**
 * Validates untrusted input (form fields, URL params, old save files) into a
 * MapConfig. Size is clamped to the supported range and snapped to the chunk
 * size so every chunk is complete; non-numeric input is an error rather than
 * a silent default, so the form can show it.
 */
export function parseMapConfig(raw: { seed?: unknown; size?: unknown; gen?: unknown; testMode?: unknown; spectator?: unknown }): MapConfig {
  const size = Number(raw.size);
  if (!Number.isFinite(size)) throw new MapConfigError('Map size must be a number.');
  const snapped = Math.round(size / MAP_LIMITS.step) * MAP_LIMITS.step;
  const clamped = Math.min(MAP_LIMITS.maxSize, Math.max(MAP_LIMITS.minSize, snapped));

  let seed: number;
  if (raw.seed === undefined || raw.seed === '' || raw.seed === null) {
    seed = randomSeed();
  } else if (typeof raw.seed === 'number' || /^-?\d+$/.test(String(raw.seed).trim())) {
    seed = Number(raw.seed) >>> 0;
  } else {
    // Text seeds ("my world") hash to a number, Minecraft-style.
    seed = hashString(String(raw.seed));
  }
  const gen = Number(raw.gen);
  return {
    seed, size: clamped,
    ...(Number.isInteger(gen) && gen >= 2 && gen <= GENERATOR_VERSION ? { gen } : {}),
    ...(raw.testMode === true ? { testMode: true } : {}),
    ...(raw.spectator === true ? { spectator: true } : {}),
  };
}

export function toTerrainConfig(m: MapConfig): TerrainConfig {
  return {
    ...DEFAULT_TERRAIN,
    seed: m.seed,
    size: m.size,
    // One quad per 1.33 m at every map size (24 quads per 32 m chunk).
    resolution: m.size * 0.75,
    baseFrequency: DEFAULT_TERRAIN.baseFrequency,
    gen: m.gen ?? 1,
    // Mountains: gen 2 lowlands are also a bit hillier.
    maxHeight: (m.gen ?? 1) >= 2 ? 8 : DEFAULT_TERRAIN.maxHeight,
  };
}

/** Creature counts scale with area so a Huge map isn't empty and a Small one isn't a death trap. */
export function creatureBudget(m: MapConfig): { wolf: number; deer: number; boar: number } {
  // The island covers ~half the map.
  const k = ((m.size * m.size) / (256 * 256)) * 0.65;
  // Roughly double the original population: at 256 m that's 7 wolves, 16 deer, 7 boars.
  return {
    wolf: Math.max(3, Math.round(11 * k)),
    deer: Math.max(6, Math.round(25 * k)),
    boar: Math.max(3, Math.round(11 * k)),
  };
}

export function randomSeed(): number {
  return (Math.random() * 2 ** 31) >>> 0;
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
