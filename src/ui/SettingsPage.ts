import { CONTROL_DEFS, GRAPHICS_DEFS, type AllSettings, type SettingDef } from '../data/settings';

export type SettingsTab = 'graphics' | 'controls';

const TABS: ReadonlyArray<{ tab: SettingsTab; label: string; defs: readonly SettingDef[] }> = [
  { tab: 'graphics', label: 'Graphics', defs: GRAPHICS_DEFS },
  { tab: 'controls', label: 'Controls & audio', defs: CONTROL_DEFS },
];

/**
 * The settings page (main menu and pause menu), generated from the setting
 * definitions in data/settings.ts: one row per setting, grouped, with a live
 * value read-out. MainMenu owns the DOM and the event delegation; inputs
 * carry data-section / data-key so a change maps straight back to a setting.
 */
export function settingsHtml(tab: SettingsTab, s: AllSettings): string {
  const t = TABS.find((x) => x.tab === tab)!;
  const defs = t.defs;
  const values = s[tab] as unknown as Record<string, number | string | boolean>;
  const groups = new Map<string, SettingDef[]>();
  for (const d of defs) {
    let g = groups.get(d.group);
    if (!g) groups.set(d.group, (g = []));
    g.push(d);
  }
  const body = [...groups].map(([group, list]) => `
    <fieldset class="set-group"><legend>${esc(group)}</legend>
      ${list.map((d) => row(tab, d, values[d.key]!)).join('')}
    </fieldset>`).join('');
  return `
    <div class="menu-card settings-card">
      <h2>Settings</h2>
      <div class="set-tabs">
        ${TABS.map((x) => `<button data-act="set-tab" data-tab="${x.tab}" class="${tab === x.tab ? 'on' : ''}">${x.label}</button>`).join('')}
      </div>
      <div class="set-body">${body}</div>
      <div class="actions">
        <button data-act="settings-back">Back</button>
        <button data-act="set-reset" data-tab="${tab}">Reset ${t.label.toLowerCase()} to defaults</button>
      </div>
    </div>`;
}

function row(section: SettingsTab, d: SettingDef, v: number | string | boolean): string {
  const attrs = `data-section="${section}" data-key="${d.key}"`;
  const help = d.help ? `<small>${esc(d.help)}</small>` : '';
  const k = d.kind;
  let control: string;
  if (k.type === 'range') {
    control = `<input type="range" ${attrs} min="${k.min}" max="${k.max}" step="${k.step}" value="${v}">
      <output>${formatValue(d, v)}</output>`;
  } else if (k.type === 'toggle') {
    control = `<input type="checkbox" ${attrs} ${v ? 'checked' : ''}>`;
  } else {
    control = `<select ${attrs}>${k.options.map((o) => `<option value="${esc(o.value)}" ${String(v) === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
  }
  return `<label class="set-row"><span class="set-label">${esc(d.label)}${help}</span><span class="set-ctl">${control}</span></label>`;
}

/** Read-out next to a slider: "1.5 ×", "20 min", "0.40". */
export function formatValue(d: SettingDef, v: number | string | boolean): string {
  if (d.kind.type !== 'range' || typeof v !== 'number') return String(v);
  const decimals = d.kind.step >= 1 ? 0 : d.kind.step >= 0.1 ? 1 : 2;
  const unit = d.kind.unit ? (d.kind.unit === '%' ? '%' : ` ${d.kind.unit}`) : '';
  return `${v.toFixed(decimals)}${unit}`;
}

export function settingDef(section: SettingsTab, key: string): SettingDef | undefined {
  return TABS.find((x) => x.tab === section)?.defs.find((d) => d.key === key);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
