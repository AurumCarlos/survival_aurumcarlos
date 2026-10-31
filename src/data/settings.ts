/**
 * Player-adjustable settings: graphics (read by the renderer), controls &
 * audio (input, camera, sound) and simulation (read by the game systems). Engine-free: definitions, defaults and
 * validation only; the app layer persists them (app/SettingsStore.ts) and the
 * settings page (ui/SettingsPage.ts) is generated from these definitions.
 *
 * Simulation values live in one shared, mutable object, SIM. Systems read it
 * every tick, so a change on the settings page applies immediately, even in
 * the middle of a game. Every multiplier defaults to 1 and every other value
 * to what the game used before it was configurable.
 */

export type SettingKind =
  | { type: 'range'; min: number; max: number; step: number; unit?: string }
  | { type: 'select'; options: ReadonlyArray<{ value: string; label: string }> }
  | { type: 'toggle' };

export interface SettingDef {
  key: string;
  label: string;
  group: string;
  help?: string;
  kind: SettingKind;
  default: number | string | boolean;
}

const range = (min: number, max: number, step: number, unit?: string): SettingKind =>
  (unit ? { type: 'range', min, max, step, unit } : { type: 'range', min, max, step });

// ---------------------------------------------------------------------------
// Graphics
// ---------------------------------------------------------------------------

export interface GraphicsSettings {
  /** 'auto' adapts resolution and quality to hold targetFps; the others are fixed. */
  quality: 'auto' | 'high' | 'medium' | 'low';
  /** 'auto' or a fixed fraction of the native resolution, as a string ('1', '0.85'…). */
  resolution: string;
  /** How many of the nearest trees use the detailed mesh. */
  detailedTrees: number;
  /** Percent of the normal distance props (trees, rocks…) are drawn to. */
  viewDistance: number;
  targetFps: number;
  showFps: boolean;
}

export const GRAPHICS_DEFS: readonly SettingDef[] = [
  {
    key: 'quality', label: 'Quality', group: 'Display', default: 'auto',
    help: 'Auto lowers resolution, then shadows and detail, to hold the target frame rate.',
    kind: { type: 'select', options: [
      { value: 'auto', label: 'Auto' }, { value: 'high', label: 'High (shadows)' },
      { value: 'medium', label: 'Medium (light shadows)' }, { value: 'low', label: 'Low (no shadows)' },
    ] },
  },
  {
    key: 'resolution', label: 'Resolution', group: 'Display', default: 'auto',
    help: 'Fraction of the screen resolution rendered. Lower is much faster on laptops.',
    kind: { type: 'select', options: [
      { value: 'auto', label: 'Auto' }, { value: '1', label: '100 %' }, { value: '0.85', label: '85 %' },
      { value: '0.7', label: '70 %' }, { value: '0.6', label: '60 %' }, { value: '0.5', label: '50 %' }, { value: '0.4', label: '40 %' },
    ] },
  },
  {
    key: 'targetFps', label: 'Target frame rate', group: 'Display', default: 60,
    help: 'What Auto quality aims for.',
    kind: { type: 'select', options: [{ value: '30', label: '30 FPS' }, { value: '60', label: '60 FPS' }, { value: '120', label: '120 FPS' }, { value: '144', label: '144 FPS' }] },
  },
  {
    key: 'detailedTrees', label: 'Detailed trees', group: 'World detail', default: 15,
    help: 'The nearest trees drawn with full leaves; all others use the light model.',
    kind: range(0, 80, 1),
  },
  {
    key: 'viewDistance', label: 'Prop draw distance', group: 'World detail', default: 100,
    help: 'Trees, rocks and bushes beyond this are not drawn (never past the fog).',
    kind: range(40, 100, 5, '%'),
  },
  { key: 'showFps', label: 'Show FPS counter', group: 'Display', default: true, kind: { type: 'toggle' } },
];

// ---------------------------------------------------------------------------
// Controls & audio
// ---------------------------------------------------------------------------

export interface ControlSettings {
  mouseSensitivity: number;
  invertY: boolean;
  fov: number;
  masterVolume: number;
  ambienceVolume: number;
  effectsVolume: number;
}

export const CONTROL_DEFS: readonly SettingDef[] = [
  { key: 'mouseSensitivity', label: 'Mouse sensitivity', group: 'Controls', default: 1, kind: range(0.2, 3, 0.05, '×') },
  { key: 'invertY', label: 'Invert mouse Y', group: 'Controls', default: false, kind: { type: 'toggle' } },
  { key: 'fov', label: 'Field of view', group: 'Controls', default: 75, kind: range(55, 100, 1, '°') },
  { key: 'masterVolume', label: 'Master volume', group: 'Audio', default: 70, kind: range(0, 100, 5, '%') },
  { key: 'ambienceVolume', label: 'Ambience (waves, wind, rain, animals)', group: 'Audio', default: 80, kind: range(0, 100, 5, '%') },
  { key: 'effectsVolume', label: 'Effects (steps, hits)', group: 'Audio', default: 80, kind: range(0, 100, 5, '%') },
];

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

export interface SimSettings {
  dayLengthMinutes: number;
  meanTempC: number;
  tempSwingC: number;
  hungerRate: number;
  thirstRate: number;
  energyRate: number;
  healthRegen: number;
  moveSpeed: number;
  harvestYield: number;
  resourceRespawn: number;
  animalCount: number;
  breedInterval: number;
  breedChance: number;
  mateDistance: number;
  courtDistance: number;
  gestationSeconds: number;
  breedCooldownSeconds: number;
  growTime: number;
  rainFrequency: number;
  staminaRegen: number;
  craftSpeed: number;
  toolDurability: number;
  animalDamage: number;
  animalHealth: number;
  maxAnimals: number;
}

export const SIM_DEFS: readonly SettingDef[] = [
  { key: 'dayLengthMinutes', label: 'Day length', group: 'Time & weather', default: 20, kind: range(1, 120, 1, 'min'), help: 'Real minutes for a full day and night.' },
  { key: 'meanTempC', label: 'Average temperature', group: 'Time & weather', default: 22, kind: range(0, 40, 1, '°C') },
  { key: 'tempSwingC', label: 'Day/night temperature swing', group: 'Time & weather', default: 7, kind: range(0, 20, 1, '°C') },
  { key: 'hungerRate', label: 'Hunger speed', group: 'Survival', default: 1, kind: range(0, 5, 0.1, '×') },
  { key: 'thirstRate', label: 'Thirst speed', group: 'Survival', default: 1, kind: range(0, 5, 0.1, '×') },
  { key: 'energyRate', label: 'Tiredness speed', group: 'Survival', default: 1, kind: range(0, 5, 0.1, '×') },
  { key: 'healthRegen', label: 'Health regeneration', group: 'Survival', default: 1, kind: range(0, 10, 0.1, '×') },
  { key: 'moveSpeed', label: 'Movement speed', group: 'Player', default: 1, kind: range(0.5, 3, 0.1, '×') },
  { key: 'harvestYield', label: 'Harvest yield', group: 'Player', default: 1, kind: range(0.5, 10, 0.5, '×') },
  { key: 'resourceRespawn', label: 'Resource regrowth time', group: 'World', default: 1, kind: range(0.1, 10, 0.1, '×'), help: 'Trees, rocks and bushes grow back after this many times the normal delay.' },
  { key: 'animalCount', label: 'Starting animals', group: 'Animals', default: 1, kind: range(0, 5, 0.1, '×'), help: 'Applies to new worlds.' },
  { key: 'breedInterval', label: 'Mating check every', group: 'Animals', default: 45, kind: range(5, 600, 5, 's') },
  { key: 'breedChance', label: 'Mating chance per check', group: 'Animals', default: 0.4, kind: range(0, 1, 0.05) },
  { key: 'mateDistance', label: 'Mating distance', group: 'Animals', default: 4, kind: range(1, 20, 0.5, 'm'), help: 'A male and a female must be this close to mate.' },
  { key: 'courtDistance', label: 'Courtship distance', group: 'Animals', default: 25, kind: range(0, 80, 1, 'm'), help: 'A male this close to a free female follows her until they are close enough.' },
  { key: 'gestationSeconds', label: 'Gestation', group: 'Animals', default: 120, kind: range(0, 1200, 10, 's') },
  { key: 'breedCooldownSeconds', label: 'Rest after giving birth', group: 'Animals', default: 300, kind: range(0, 3600, 30, 's') },
  { key: 'growTime', label: 'Time to grow up', group: 'Animals', default: 1, kind: range(0.1, 5, 0.1, '×') },
  { key: 'maxAnimals', label: 'Animal limit', group: 'Animals', default: 0, kind: range(0, 400, 10), help: '0 = no limit. Above it, deer, boars and wolves stop mating (keeps a big herd from slowing the game down).' },
  { key: 'animalDamage', label: 'Animal bite damage', group: 'Animals', default: 1, kind: range(0, 5, 0.1, '×') },
  { key: 'animalHealth', label: 'Animal toughness', group: 'Animals', default: 1, kind: range(0.2, 5, 0.1, '×'), help: 'How many hits animals take to kill.' },
  { key: 'rainFrequency', label: 'Rain frequency', group: 'Time & weather', default: 1, kind: range(0, 3, 0.1, '×') },
  { key: 'staminaRegen', label: 'Stamina recovery', group: 'Survival', default: 1, kind: range(0.2, 5, 0.1, '×') },
  { key: 'craftSpeed', label: 'Crafting speed', group: 'Player', default: 1, kind: range(0.2, 10, 0.1, '×') },
  { key: 'toolDurability', label: 'Tool durability', group: 'Player', default: 1, kind: range(0.2, 10, 0.1, '×'), help: 'Tools and weapons last this many times longer.' },
];

function defaultsOf<T>(defs: readonly SettingDef[]): T {
  return Object.fromEntries(defs.map((d) => [d.key, d.default])) as T;
}

export const DEFAULT_GRAPHICS: Readonly<GraphicsSettings> = Object.freeze(defaultsOf<GraphicsSettings>(GRAPHICS_DEFS));
export const DEFAULT_SIM: Readonly<SimSettings> = Object.freeze(defaultsOf<SimSettings>(SIM_DEFS));
export const DEFAULT_CONTROLS: Readonly<ControlSettings> = Object.freeze(defaultsOf<ControlSettings>(CONTROL_DEFS));

export interface AllSettings {
  graphics: GraphicsSettings;
  sim: SimSettings;
  controls: ControlSettings;
}

/** Current simulation settings, read by the systems every tick. */
export const SIM: SimSettings = { ...DEFAULT_SIM };

/**
 * Validates untrusted values (local storage, the settings form) against
 * `defs`: unknown keys are dropped, wrong types fall back to the default,
 * numbers are clamped to their range.
 */
export function sanitize<T>(defs: readonly SettingDef[], raw: unknown): T {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const d of defs) {
    const v = src[d.key];
    const k = d.kind;
    if (k.type === 'range') {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
      out[d.key] = Number.isFinite(n) ? Math.min(k.max, Math.max(k.min, n)) : d.default;
    } else if (k.type === 'toggle') {
      out[d.key] = typeof v === 'boolean' ? v : d.default;
    } else {
      const s = v === undefined || v === null ? '' : String(v);
      const ok = k.options.some((o) => o.value === s);
      out[d.key] = ok ? (typeof d.default === 'number' ? Number(s) : s) : d.default;
    }
  }
  return out as T;
}

/** Replaces the live simulation settings. */
export function applySim(values: Partial<SimSettings>): void {
  Object.assign(SIM, sanitize<SimSettings>(SIM_DEFS, { ...SIM, ...values }));
}
