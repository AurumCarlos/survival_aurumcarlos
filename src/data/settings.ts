/**
 * Player-adjustable settings: graphics (read by the renderer) and controls &
 * audio (input, camera, sound). Engine-free: definitions, defaults and
 * validation only; the app layer persists them (app/SettingsStore.ts) and the
 * settings page (ui/SettingsPage.ts) is generated from these definitions.
 * Gameplay itself (survival rates, animals, weather) is not adjustable: it is
 * tuned in the game's own data.
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
  /** How far you can see in daylight (m): the fog distance; far trees are impostors, far terrain coarser. */
  viewRange: number;
  /** Frame-rate limit, and what Auto quality aims for; 0 = unlimited. */
  targetFps: number;
  showFps: boolean;
  showMinimap: boolean;
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
    key: 'targetFps', label: 'Frame rate limit', group: 'Display', default: 60,
    help: 'Also what Auto quality aims for. Above your screen\'s refresh rate (usually 60 Hz) extra frames are rendered (a little less input lag) but the screen can\'t show them.',
    kind: { type: 'select', options: [
      { value: '30', label: '30 FPS' }, { value: '60', label: '60 FPS' }, { value: '120', label: '120 FPS' },
      { value: '144', label: '144 FPS' }, { value: '240', label: '240 FPS' }, { value: '0', label: 'Unlimited' },
    ] },
  },
  {
    key: 'detailedTrees', label: 'Detailed trees', group: 'World detail', default: 15,
    help: 'The nearest trees drawn with full leaves; all others use the light model.',
    kind: range(0, 80, 1),
  },
  {
    key: 'viewRange', label: 'View distance', group: 'World detail', default: 300,
    help: 'How far you see in daylight (less at night and in the rain). Distant trees and terrain use light versions, so even 1000 m stays fast.',
    kind: range(150, 1000, 50, 'm'),
  },
  { key: 'showFps', label: 'Show FPS counter', group: 'Display', default: true, kind: { type: 'toggle' } },
  { key: 'showMinimap', label: 'Show minimap', group: 'Display', default: true, help: 'The full map is always on M.', kind: { type: 'toggle' } },
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

function defaultsOf<T>(defs: readonly SettingDef[]): T {
  return Object.fromEntries(defs.map((d) => [d.key, d.default])) as T;
}

export const DEFAULT_GRAPHICS: Readonly<GraphicsSettings> = Object.freeze(defaultsOf<GraphicsSettings>(GRAPHICS_DEFS));
export const DEFAULT_CONTROLS: Readonly<ControlSettings> = Object.freeze(defaultsOf<ControlSettings>(CONTROL_DEFS));

export interface AllSettings {
  graphics: GraphicsSettings;
  controls: ControlSettings;
}

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
