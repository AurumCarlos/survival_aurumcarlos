import type { AppState } from '../app/GameStateMachine';
import type { SaveMeta } from '../persistence/SaveStore';
import { GENERATOR_VERSION } from '../world/TerrainGenerator';
import { MAP_LIMITS, MAP_PRESETS, MapConfigError, parseMapConfig, randomSeed, type MapConfig } from '../world/MapConfig';

export interface MenuHandlers {
  onNewGame(): void;
  onContinue(): void;
  onStart(config: MapConfig, name: string): void;
  /** Saves list. */
  onLoadSlot(slot: string): void;
  onDeleteSlot(slot: string): void;
  onRenameSlot(slot: string, name: string): void;
  onDuplicateSlot(slot: string): void;
  onExportSlot(slot: string): void;
  onImport(file: File): void;
  onRefreshSaves(): void;
  /** Game over with a bed: wake up next to it. */
  onRespawn(): void;
  /** Pause menu: save the current world under a new name (a separate slot). */
  onSaveAs(name: string): void;
  onBack(): void;
  onCancelLoading(): void;
  onResume(): void;
  onSave(): void;
  onQuitToMenu(): void;
}

export interface MenuModel {
  save: { day: number; size: number; minutes: number; savedAt: number; name: string } | null;
  /** Every saved world, newest first. */
  saves: SaveMeta[];
  /** World being played (name shown in the pause menu). */
  current: { slot: string; name: string } | null;
  loading: { fraction: number; label: string };
  deathCause: string | null;
  /** The dead survivor has a bed to respawn at. */
  canRespawn: boolean;
  minutesSurvived: number;
  /** True right after loading: the pause screen reads "Click to play" instead of "Paused". */
  freshSession: boolean;
  busy: boolean;
  storageKind: 'indexeddb' | 'memory' | null;
}

/**
 * All full-screen overlays (main menu, map configuration, loading, pause,
 * game over) in one DOM root, re-rendered from (state, model). It holds no
 * game state of its own: buttons call handlers, the App decides.
 */
export class MainMenu {
  private readonly root: HTMLElement;
  private readonly toasts: HTMLElement;
  private state: AppState = 'menu';
  private model: MenuModel;
  /** Config form values survive Back → New Game. */
  private form = { size: 256, seed: '', name: '' };
  /** Main menu sub-view: the title screen or the list of saved worlds. */
  private view: 'main' | 'saves' = 'main';
  private confirmDelete: string | null = null;
  private renaming: string | null = null;
  private savingAs = false;

  constructor(container: HTMLElement, private readonly h: MenuHandlers, model: MenuModel) {
    this.model = model;
    this.root = document.createElement('div');
    this.root.className = 'menu';
    this.toasts = document.createElement('div');
    this.toasts.className = 'toasts app-toasts';
    container.append(this.root, this.toasts);
    // Event delegation: one listener survives every re-render.
    this.root.addEventListener('click', this.onClick);
    this.root.addEventListener('input', this.onInput);
    this.root.addEventListener('submit', (e) => {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      if (form.dataset['form'] === 'rename') {
        const v = form.querySelector<HTMLInputElement>('input[name=newname]')?.value ?? '';
        const slot = this.renaming;
        this.renaming = null;
        if (slot) this.h.onRenameSlot(slot, v);
      } else if (form.dataset['form'] === 'save-as') {
        const v = form.querySelector<HTMLInputElement>('input[name=asname]')?.value ?? '';
        this.savingAs = false;
        this.h.onSaveAs(v);
      } else {
        this.submitConfig();
      }
    });
  }

  render(state: AppState, patch: Partial<MenuModel> = {}): void {
    this.state = state;
    this.model = { ...this.model, ...patch };
    const m = this.model;
    this.root.classList.toggle('show', state !== 'playing');
    this.root.dataset['state'] = state;

    switch (state) {
      case 'menu':
        if (this.view === 'saves') {
          this.root.innerHTML = this.savesHtml();
          break;
        }
        this.root.innerHTML = `
          <div class="menu-card">
            <h1>Low-Poly Survival</h1>
            <p class="tag">Stay fed. Stay warm. Stay hidden.</p>
            <button data-act="continue" ${m.save ? '' : 'disabled'}>Continue${m.save ? `<small>${escapeHtml(m.save.name)} · day ${m.save.day} · ${m.save.size} m · ${m.save.minutes} min · ${timeAgo(m.save.savedAt)}</small>` : '<small>No saved game</small>'}</button>
            <button data-act="saves">Load game<small>${m.saves.length ? `${m.saves.length} saved world${m.saves.length > 1 ? 's' : ''} — load, rename, copy, delete, import/export` : 'No saved worlds yet · import a save file'}</small></button>
            <button data-act="new" class="primary">New game</button>
            ${m.storageKind === 'memory' ? '<p class="warn-line">Saving is unavailable in this browser mode — progress will be lost on reload.</p>' : ''}
          </div>`;
        break;
      case 'config':
        this.root.innerHTML = `
          <form class="menu-card config" novalidate>
            <h2>New world</h2>
            <label class="row">Name
              <input name="wname" type="text" placeholder="My island" value="${escapeAttr(this.form.name)}" maxlength="40">
            </label>
            <fieldset><legend>Map size</legend>
              <div class="presets">${MAP_PRESETS.map((p) => `
                <label class="preset${p.size === this.form.size ? ' on' : ''}"><input type="radio" name="preset" value="${p.size}" ${p.size === this.form.size ? 'checked' : ''}>
                  <strong>${p.label}</strong><span>${p.size} × ${p.size} m</span><em>${p.hint}</em></label>`).join('')}
              </div>
              <label class="row">Custom (m)
                <input name="size" type="number" min="${MAP_LIMITS.minSize}" max="${MAP_LIMITS.maxSize}" step="${MAP_LIMITS.step}" value="${this.form.size}">
              </label>
            </fieldset>
            <label class="row">Seed
              <input name="seed" type="text" placeholder="random" value="${escapeAttr(this.form.seed)}" maxlength="40">
              <button type="button" data-act="dice" title="Random seed">🎲</button>
            </label>
            <p class="error" data-k="error"></p>
            <div class="actions">
              <button type="button" data-act="back">Back</button>
              <button type="submit" class="primary" ${m.busy ? 'disabled' : ''}>Generate world</button>
            </div>
          </form>`;
        break;
      case 'loading':
        this.root.innerHTML = `
          <div class="menu-card">
            <h2>Building world…</h2>
            <div class="bar-outer"><div class="bar-inner" style="width:${Math.round(m.loading.fraction * 100)}%"></div></div>
            <p class="tag">${escapeHtml(m.loading.label)}</p>
            <button data-act="cancel">Cancel</button>
          </div>`;
        break;
      case 'paused':
        this.root.innerHTML = `
          <div class="menu-card">
            <h2>${m.freshSession ? 'Ready' : 'Paused'}</h2>
            <button data-act="resume" class="primary">${m.freshSession ? 'Play' : 'Resume'}<small>Click to capture the mouse</small></button>
            ${m.current ? `<p class="tag">${escapeHtml(m.current.name)}</p>` : ''}
            ${m.freshSession ? '' : `<button data-act="save" ${m.busy ? 'disabled' : ''}>Save game</button>`}
            ${m.freshSession ? '' : this.savingAs
              ? `<form class="save-as" data-form="save-as"><input name="asname" type="text" maxlength="40" placeholder="New save name" value="${escapeAttr(`${m.current?.name ?? 'Island'} (2)`)}"><button type="submit" class="primary" ${m.busy ? 'disabled' : ''}>Save</button><button type="button" data-act="saveas-cancel">✕</button></form>`
              : `<button data-act="saveas" ${m.busy ? 'disabled' : ''}>Save as new…<small>Keeps this world in a separate save from now on</small></button>`}
            <button data-act="quit" ${m.busy ? 'disabled' : ''}>Save &amp; quit to menu</button>
            <p class="keys">WASD move · Shift sprint · C crouch · E harvest · I inventory · LMB swing · RMB throw · B build · 1–6 hotbar</p>
          </div>`;
        break;
      case 'gameover':
        this.root.innerHTML = `
          <div class="menu-card">
            <h2>You died</h2>
            <p class="tag">${escapeHtml(m.deathCause ?? 'unknown causes')} · survived ${m.minutesSurvived.toFixed(1)} minutes</p>
            ${m.canRespawn
              ? `<button data-act="respawn" class="primary">Respawn at your bed<small>Your belongings stay in a bag where you fell</small></button>
                 <button data-act="menu">Save &amp; main menu<small>You'll wake up at your bed next time</small></button>`
              : `<p class="tag">No bed: this world is over. Build a bed to be able to respawn.</p>
                 <button data-act="new" class="primary">New game</button>
                 <button data-act="menu">Main menu</button>`}
          </div>`;
        break;
      case 'playing':
        this.root.innerHTML = '';
        break;
    }
  }

  /** Show the title screen (not the saves list) next time the menu opens. */
  resetView(): void {
    this.view = 'main';
    this.savingAs = false;
  }

  private savesHtml(): string {
    const m = this.model;
    const rows = m.saves.map((r) => {
      const slot = escapeAttr(r.slot);
      const name = this.renaming === r.slot
        ? `<form class="rename" data-form="rename"><input name="newname" type="text" maxlength="40" value="${escapeAttr(r.name)}" autofocus><button type="submit" class="primary">OK</button><button type="button" data-act="rename-cancel">✕</button></form>`
        : `<strong>${escapeHtml(r.name)}</strong>`;
      return `<li class="save-row">
        <div class="save-info">${name}<small>Day ${r.summary.day} · ${r.summary.size} m · seed ${r.summary.seed} · ${r.summary.minutes} min played · ${timeAgo(r.savedAt)}</small></div>
        <div class="save-acts">
          <button data-act="load" data-slot="${slot}" class="primary" ${m.busy ? 'disabled' : ''}>Load</button>
          <button data-act="rename" data-slot="${slot}" title="Rename">✎</button>
          <button data-act="dup" data-slot="${slot}" title="Duplicate">⧉</button>
          <button data-act="export" data-slot="${slot}" title="Export to a file">⇩</button>
          <button data-act="del" data-slot="${slot}" class="${this.confirmDelete === r.slot ? 'danger' : ''}" title="Delete">${this.confirmDelete === r.slot ? 'Delete?' : '🗑'}</button>
        </div></li>`;
    }).join('');
    return `
      <div class="menu-card saves-card">
        <h2>Saved worlds</h2>
        ${m.saves.length ? `<ul class="save-list">${rows}</ul>` : '<p class="tag">No saved worlds yet.</p>'}
        <div class="actions">
          <button data-act="saves-back">Back</button>
          <button data-act="import">Import a save file…</button>
          <input name="importfile" type="file" accept=".json,application/json" hidden>
        </div>
      </div>`;
  }

  setLoading(fraction: number, label: string): void {
    this.model.loading = { fraction, label };
    if (this.state !== 'loading') return;
    // Patch in place rather than re-render, so the Cancel button keeps hover/focus.
    const bar = this.root.querySelector<HTMLElement>('.bar-inner');
    const tag = this.root.querySelector<HTMLElement>('.tag');
    if (bar) bar.style.width = `${Math.round(fraction * 100)}%`;
    if (tag) tag.textContent = label;
  }

  toast(text: string, warn = false): void {
    const t = document.createElement('div');
    t.className = `toast${warn ? ' warn' : ''}`;
    t.textContent = text;
    this.toasts.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

  private readonly onClick = (e: MouseEvent): void => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!target || (target as HTMLButtonElement).disabled) return;
    switch (target.dataset['act']) {
      case 'continue': return this.h.onContinue();
      case 'saves':
        this.view = 'saves';
        this.confirmDelete = this.renaming = null;
        this.h.onRefreshSaves();
        return this.render(this.state);
      case 'saves-back':
        this.view = 'main';
        return this.render(this.state);
      case 'load': return this.h.onLoadSlot(target.dataset['slot']!);
      case 'del': {
        const slot = target.dataset['slot']!;
        if (this.confirmDelete !== slot) {
          this.confirmDelete = slot;
          return this.render(this.state);
        }
        this.confirmDelete = null;
        return this.h.onDeleteSlot(slot);
      }
      case 'rename':
        this.renaming = target.dataset['slot']!;
        return this.render(this.state);
      case 'rename-cancel':
        this.renaming = null;
        return this.render(this.state);
      case 'dup': return this.h.onDuplicateSlot(target.dataset['slot']!);
      case 'export': return this.h.onExportSlot(target.dataset['slot']!);
      case 'import': return void this.root.querySelector<HTMLInputElement>('input[name=importfile]')?.click();
      case 'saveas':
        this.savingAs = true;
        this.render(this.state);
        return void this.root.querySelector<HTMLInputElement>('input[name=asname]')?.select();
      case 'saveas-cancel':
        this.savingAs = false;
        return this.render(this.state);
      case 'new': return this.h.onNewGame();
      case 'back': return this.h.onBack();
      case 'menu': return this.h.onQuitToMenu();
      case 'cancel': return this.h.onCancelLoading();
      case 'resume': return this.h.onResume();
      case 'respawn': return this.h.onRespawn();
      case 'save': return this.h.onSave();
      case 'quit': return this.h.onQuitToMenu();
      case 'dice': {
        this.form.seed = String(randomSeed());
        const input = this.root.querySelector<HTMLInputElement>('input[name=seed]');
        if (input) input.value = this.form.seed;
        return;
      }
    }
  };

  private readonly onInput = (e: Event): void => {
    const t = e.target as HTMLInputElement;
    if (t.name === 'preset') {
      this.form.size = Number(t.value);
      const size = this.root.querySelector<HTMLInputElement>('input[name=size]');
      if (size) size.value = t.value;
      this.root.querySelectorAll('.preset').forEach((p) => p.classList.toggle('on', p.contains(t)));
    } else if (t.name === 'size') {
      this.form.size = Number(t.value);
      this.root.querySelectorAll<HTMLInputElement>('input[name=preset]').forEach((r) => {
        r.checked = Number(r.value) === this.form.size;
        r.closest('.preset')?.classList.toggle('on', r.checked);
      });
    } else if (t.name === 'seed') {
      this.form.seed = t.value;
    } else if (t.name === 'wname') {
      this.form.name = t.value;
    } else if (t.name === 'importfile' && t.files?.[0]) {
      this.h.onImport(t.files[0]);
      t.value = '';
    }
  };

  private submitConfig(): void {
    const err = this.root.querySelector<HTMLElement>('[data-k=error]');
    try {
      const raw = this.root.querySelector<HTMLInputElement>('input[name=size]')?.value ?? '';
      if (raw.trim() === '') throw new MapConfigError('Enter a map size.');
      const cfg = parseMapConfig({ size: raw, seed: this.form.seed.trim(), gen: GENERATOR_VERSION });
      if (cfg.size !== Number(raw)) this.toast(`Map size adjusted to ${cfg.size} m (multiples of ${MAP_LIMITS.step}, ${MAP_LIMITS.minSize}–${MAP_LIMITS.maxSize}).`);
      this.form.size = cfg.size;
      this.h.onStart(cfg, this.form.name.trim() || `Island ${cfg.seed}`);
    } catch (e) {
      if (err) err.textContent = e instanceof Error ? e.message : String(e);
    }
  }
}

function timeAgo(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
const escapeAttr = escapeHtml;
