import {
  CONTROL_DEFS, DEFAULT_CONTROLS, DEFAULT_GRAPHICS, GRAPHICS_DEFS, sanitize,
  type AllSettings, type ControlSettings, type GraphicsSettings,
} from '../data/settings';

const KEY = 'survival.settings.v1';

/**
 * Settings persist in localStorage (they belong to the player, not to a
 * world). Storage can be missing or throw (private mode, blocked site data):
 * then the defaults are used and changes last until reload.
 */
export function loadSettings(): AllSettings {
  let raw: unknown = null;
  try {
    const s = localStorage.getItem(KEY);
    raw = s ? JSON.parse(s) : null;
  } catch {
    raw = null;
  }
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    graphics: sanitize<GraphicsSettings>(GRAPHICS_DEFS, o['graphics'] ?? DEFAULT_GRAPHICS),
    controls: sanitize<ControlSettings>(CONTROL_DEFS, o['controls'] ?? DEFAULT_CONTROLS),
  };
}

export function saveSettings(s: AllSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable: settings still apply for this session.
  }
}
