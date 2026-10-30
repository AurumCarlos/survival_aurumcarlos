import type { AppState } from '../app/GameStateMachine';
import { MAP_LIMITS, MAP_PRESETS, MapConfigError, parseMapConfig, randomSeed, type MapConfig } from '../world/MapConfig';

export interface MenuHandlers {
  onNewGame(): void;
  onContinue(): void;
  onStart(config: MapConfig): void;
  onBack(): void;
  onCancelLoading(): void;
  onResume(): void;
  onSave(): void;
  onQuitToMenu(): void;
}

export interface MenuModel {
  save: { day: number; size: number; minutes: number; savedAt: number } | null;
  loading: { fraction: number; label: string };
  deathCause: string | null;
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
  private form = { size: 256, seed: '' };

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
      this.submitConfig();
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
        this.root.innerHTML = `
          <div class="menu-card">
            <h1>Low-Poly Survival</h1>
            <p class="tag">Stay fed. Stay warm. Stay hidden.</p>
            <button data-act="continue" ${m.save ? '' : 'disabled'}>Continue${m.save ? `<small>Day ${m.save.day} · ${m.save.size} m map · ${m.save.minutes} min · ${timeAgo(m.save.savedAt)}</small>` : '<small>No saved game</small>'}</button>
            <button data-act="new" class="primary">New game</button>
            ${m.storageKind === 'memory' ? '<p class="warn-line">Saving is unavailable in this browser mode — progress will be lost on reload.</p>' : ''}
          </div>`;
        break;
      case 'config':
        this.root.innerHTML = `
          <form class="menu-card config" novalidate>
            <h2>New world</h2>
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
            ${m.freshSession ? '' : `<button data-act="save" ${m.busy ? 'disabled' : ''}>Save game</button>`}
            <button data-act="quit" ${m.busy ? 'disabled' : ''}>Save &amp; quit to menu</button>
            <p class="keys">WASD move · Shift sprint · C crouch · E harvest · I inventory · LMB swing · RMB throw · B build · 1–6 hotbar</p>
          </div>`;
        break;
      case 'gameover':
        this.root.innerHTML = `
          <div class="menu-card">
            <h2>You died</h2>
            <p class="tag">${escapeHtml(m.deathCause ?? 'unknown causes')} · survived ${m.minutesSurvived.toFixed(1)} minutes</p>
            <button data-act="new" class="primary">New game</button>
            <button data-act="menu">Main menu</button>
          </div>`;
        break;
      case 'playing':
        this.root.innerHTML = '';
        break;
    }
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
      case 'new': return this.h.onNewGame();
      case 'back': return this.h.onBack();
      case 'menu': return this.h.onQuitToMenu();
      case 'cancel': return this.h.onCancelLoading();
      case 'resume': return this.h.onResume();
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
    }
  };

  private submitConfig(): void {
    const err = this.root.querySelector<HTMLElement>('[data-k=error]');
    try {
      const raw = this.root.querySelector<HTMLInputElement>('input[name=size]')?.value ?? '';
      if (raw.trim() === '') throw new MapConfigError('Enter a map size.');
      const cfg = parseMapConfig({ size: raw, seed: this.form.seed.trim() });
      if (cfg.size !== Number(raw)) this.toast(`Map size adjusted to ${cfg.size} m (multiples of ${MAP_LIMITS.step}, ${MAP_LIMITS.minSize}–${MAP_LIMITS.maxSize}).`);
      this.form.size = cfg.size;
      this.h.onStart(cfg);
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
