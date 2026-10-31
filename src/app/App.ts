import { AssetLoader } from '../assets/AssetLoader';
import { ASSET_MANIFEST } from '../assets/manifest';
import { EventBus } from '../core/EventBus';
import { InputManager } from '../core/Input';
import { Lifecycle } from '../core/Lifecycle';
import { SaveStore, cleanName, newSlotId, type SlotInfo } from '../persistence/SaveStore';
import type { WorldSnapshot } from '../persistence/WorldSnapshot';
import { Renderer } from '../render/Renderer';
import { MainMenu, type MenuModel } from '../ui/MainMenu';
import { toTerrainConfig, type MapConfig } from '../world/MapConfig';
import { TerrainService } from '../world/TerrainService';
import { GameSession } from './GameSession';
import { GameStateMachine, type AppState } from './GameStateMachine';

/** sessionStorage survives a refresh but not closing the tab: exactly "resume after reload". */
const RESUME_KEY = 'survival.resume-after-reload';
const AUTOSAVE_EVERY_SIM_SECONDS = 60;

/**
 * Composition root and state orchestrator. Owns the long-lived pieces
 * (renderer + WebGL context, input, lifecycle, save store, terrain worker
 * service, asset cache) and creates/destroys a GameSession per game.
 *
 * Every user action goes through the GameStateMachine; async work holds a
 * ticket and is discarded if the state moved on while it was running.
 */
export class App {
  private readonly canvas = document.createElement('canvas');
  private readonly ui = document.createElement('div');
  private readonly renderer: Renderer;
  private readonly input: InputManager;
  private readonly lifecycle: Lifecycle;
  private readonly machine = new GameStateMachine('menu');
  private readonly terrain = new TerrainService(
    () => new Worker(new URL('../world/terrain.worker.ts', import.meta.url), { type: 'module' }),
  );
  /** App-level bus (asset warnings). Sessions have their own. */
  private readonly events = new EventBus();
  private readonly assets = new AssetLoader(this.events, { timeoutMs: 10000 });
  private assetsReady: Promise<unknown> = Promise.resolve();
  private store: SaveStore | null = null;
  private menu!: MainMenu;
  private session: GameSession | null = null;
  private loadAbort: AbortController | null = null;
  /** Serialises save/quit so a double-clicked "Save & quit" can't save twice or quit mid-save. */
  private busy = false;
  private lastAutosave = 0;
  /** Save slot of the world being played. */
  private current: SlotInfo | null = null;
  private model: MenuModel = {
    save: null, saves: [], current: null, loading: { fraction: 0, label: '' }, deathCause: null, minutesSurvived: 0,
    freshSession: true, busy: false, storageKind: null,
  };

  constructor(private readonly container: HTMLElement) {
    this.ui.className = 'ui-layer';
    container.append(this.canvas, this.ui);
    this.renderer = new Renderer(this.canvas);
    this.input = new InputManager(this.canvas);
    this.lifecycle = new Lifecycle({
      container, canvas: this.canvas, input: this.input, viewport: this.renderer,
      onContextLost: () => this.menu.toast('Graphics device lost — recovering…', true),
      onContextRestored: () => this.menu.toast('Graphics restored'),
    });
  }

  async start(): Promise<void> {
    this.menu = new MainMenu(this.ui, {
      onNewGame: () => this.machine.transition('config'),
      onBack: () => this.machine.transition('menu'),
      onStart: (cfg, name) => void this.loadGame(cfg, undefined, { slot: newSlotId(), name: cleanName(name, `Island ${cfg.seed}`) }),
      onLoadSlot: (slot) => void this.loadSlot(slot),
      onDeleteSlot: (slot) => void this.storeOp(() => this.store!.delete(slot), 'Save deleted'),
      onRenameSlot: (slot, name) => void this.storeOp(() => this.store!.rename(slot, name)),
      onDuplicateSlot: (slot) => void this.storeOp(() => this.store!.duplicate(slot, ''), 'World duplicated'),
      onExportSlot: (slot) => void this.exportSlot(slot),
      onImport: (file) => void this.importFile(file),
      onRefreshSaves: () => void this.storeOp(async () => undefined),
      onSaveAs: (name) => void this.saveAs(name),
      onContinue: () => void this.continueGame(),
      onCancelLoading: () => this.cancelLoading(),
      onResume: () => void this.resumePlay(),
      onSave: () => void this.saveNow(false),
      onQuitToMenu: () => void this.quitToMenu(),
    }, this.model);
    this.machine.onChange((from, to) => this.onStateChange(from, to));
    this.events.on('asset:failed', ({ key, usingFallback }) => {
      if (!usingFallback) this.menu.toast(`Missing asset “${key}”`, true);
    });

    this.canvas.addEventListener('click', () => {
      const s = this.session;
      // Safety net: if the loop is held by a user pause the app missed, show the pause menu.
      if (this.machine.state === 'playing' && s?.loop.activePauseReasons.has('user')) {
        this.machine.transition('paused');
        return;
      }
      if (this.machine.state === 'playing' && !this.input.pointerLocked && !s?.isInventoryOpen) {
        this.input.requestPointerLock();
      }
    });
    window.addEventListener('pagehide', this.onPageHide);
    document.addEventListener('visibilitychange', this.onVisibility);

    this.renderer.clear();
    this.menu.render('menu', this.model);

    // Optional models load in the background while the player reads the menu.
    this.assetsReady = this.assets.loadAll(ASSET_MANIFEST).catch((e: unknown) => console.warn(e));
    this.store = await SaveStore.open();
    this.model.storageKind = this.store.backend.kind;
    await this.refreshSaveSummary();

    const resume = sessionStorage.getItem(RESUME_KEY) === '1';
    sessionStorage.removeItem(RESUME_KEY);
    if (resume && this.model.save) await this.continueGame();
    else if (this.machine.state === 'menu') this.menu.render('menu', this.model);
  }

  // ---- Loading -------------------------------------------------------------

  private async continueGame(): Promise<void> {
    if (!this.store || !this.machine.can('loading')) return;
    const latest = await this.store.loadLatest();
    if (!latest) {
      this.menu.toast('No readable save found', true);
      await this.refreshSaveSummary();
      this.menu.render(this.machine.state, this.model);
      return;
    }
    await this.loadGame(latest.snapshot.map, latest.snapshot, { slot: latest.record.slot, name: latest.record.name ?? `Island ${latest.snapshot.map.seed}` });
  }

  private async loadSlot(slot: string): Promise<void> {
    if (!this.store || !this.machine.can('loading')) return;
    try {
      const loaded = await this.store.load(slot);
      if (!loaded) throw new Error('That save no longer exists');
      await this.loadGame(loaded.snapshot.map, loaded.snapshot, { slot, name: loaded.record.name ?? slot });
    } catch (err) {
      this.menu.toast(`Can't load this save: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  /** Run a save-list operation, then refresh the list. */
  private async storeOp(op: () => Promise<unknown>, done?: string): Promise<void> {
    if (!this.store) return;
    try {
      await op();
      if (done) this.menu.toast(done);
    } catch (err) {
      this.menu.toast(err instanceof Error ? err.message : String(err), true);
    }
    await this.refreshSaveSummary();
    if (this.machine.state === 'menu') this.menu.render('menu', this.model);
  }

  private async exportSlot(slot: string): Promise<void> {
    const text = await this.store?.exportJson(slot);
    if (!text) return;
    const name = (JSON.parse(text) as { name: string }).name.replace(/[^\w\- ]+/g, '').trim() || 'island';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = `${name}.survival.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  private async importFile(file: File): Promise<void> {
    const text = await file.text();
    await this.storeOp(async () => {
      const meta = await this.store!.importJson(text);
      this.menu.toast(`Imported “${meta.name}”`);
    });
  }

  /** Pause menu: keep playing this world in a new, separate save slot. */
  private async saveAs(name: string): Promise<void> {
    if (!this.session) return;
    this.current = { slot: newSlotId(), name: cleanName(name, `${this.current?.name ?? 'Island'} (2)`) };
    this.model.current = this.current;
    await this.saveNow(false);
  }

  private async loadGame(map: MapConfig, snapshot?: WorldSnapshot, slot?: SlotInfo): Promise<void> {
    if (!this.machine.transition('loading')) return; // double-click / wrong state → ignored
    this.current = slot ?? { slot: newSlotId(), name: `Island ${map.seed}` };
    this.model.current = this.current;
    const ticket = this.machine.ticket();
    const abort = new AbortController();
    this.loadAbort = abort;
    const progress = (f: number, label: string): void => {
      if (ticket.stillValid()) this.menu.setLoading(f, label);
    };

    try {
      progress(0.02, 'Preparing…');
      await this.assetsReady;
      const bundle = await this.terrain.generate(toTerrainConfig(map), {
        signal: abort.signal,
        onProgress: (f, phase) => progress(0.05 + f * 0.65, phase === 'nav' ? 'Mapping paths…' : 'Shaping terrain…'),
      });
      if (!ticket.stillValid()) return; // cancelled while the worker was finishing

      const session = await GameSession.create({
        renderer: this.renderer, input: this.input, assets: this.assets, uiContainer: this.ui,
        bundle, map, ...(snapshot ? { snapshot } : {}),
        signal: abort.signal, onProgress: progress, onFrame: this.onFrame,
      });
      if (!ticket.stillValid()) {
        session.dispose();
        return;
      }
      this.attach(session);
      this.model.freshSession = true;
      this.lastAutosave = 0;
      this.machine.transition('paused');
    } catch (err) {
      if (abort.signal.aborted || !ticket.stillValid()) return; // user cancelled: not an error
      console.error(err);
      this.menu.toast(`Could not start the game: ${err instanceof Error ? err.message : String(err)}`, true);
      this.machine.transition('menu');
    } finally {
      if (this.loadAbort === abort) this.loadAbort = null;
    }
  }

  private cancelLoading(): void {
    this.loadAbort?.abort();
    this.machine.transition('menu');
  }

  // ---- Session -------------------------------------------------------------

  private attach(s: GameSession): void {
    this.session = s;
    this.lifecycle.loop = s.loop;
    s.loop.onPauseChange((paused, reasons) => {
      this.input.setGameplayEnabled(!paused && !s.isInventoryOpen);
      // Esc (pointer-lock exit) pauses the loop; mirror that in the app state.
      if (reasons.has('user') && this.machine.state === 'playing') this.machine.transition('paused');
    });
    s.events.on('survivor:died', ({ cause }) => this.onDeath(cause));
  }

  private detach(): void {
    if (!this.session) return;
    this.session.dispose();
    this.session = null;
    this.lifecycle.loop = null;
    this.lifecycle.uiOwnsPointer = false;
    this.renderer.clear();
  }

  private async resumePlay(): Promise<void> {
    const s = this.session;
    if (!s || this.machine.state !== 'paused') return;
    const locked = await this.capturePointer();
    if (this.machine.state !== 'paused' || this.session !== s) return; // state changed while waiting
    if (!locked) this.menu.toast('Mouse capture unavailable — click the game to capture it');
    this.model.freshSession = false;
    // Clear stale focus pauses too: some browsers don't always send 'focus'
    // when you come back, and a leftover 'blur' would keep the game frozen.
    if (document.hasFocus()) s.loop.resume('blur');
    if (!document.hidden) s.loop.resume('hidden');
    s.loop.resume('user');
    this.machine.transition('playing');
  }

  /**
   * Pointer lock needs a user gesture and Chrome refuses re-locking for ~1 s
   * after an Esc. Resolve true/false instead of throwing so a fast
   * Esc → Resume double-tap still resumes (keyboard works; one more click
   * on the canvas captures the mouse).
   */
  private capturePointer(): Promise<boolean> {
    if (this.input.pointerLocked) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok: boolean): void => {
        document.removeEventListener('pointerlockchange', onChange);
        document.removeEventListener('pointerlockerror', onError);
        clearTimeout(timer);
        resolve(ok);
      };
      const onChange = (): void => done(this.input.pointerLocked);
      const onError = (): void => done(false);
      const timer = setTimeout(() => done(this.input.pointerLocked), 600);
      document.addEventListener('pointerlockchange', onChange);
      document.addEventListener('pointerlockerror', onError);
      this.input.requestPointerLock();
    });
  }

  private async quitToMenu(): Promise<void> {
    if (this.busy) return;
    if (this.machine.state === 'paused' && this.session?.survivorAlive && !this.model.freshSession) {
      await this.saveNow(true);
    }
    if (this.machine.transition('menu')) await this.refreshSaveSummary();
    this.menu.render(this.machine.state, this.model);
  }

  private onDeath(cause: string): void {
    const s = this.session;
    if (!s) return;
    s.loop.pause('dead');
    document.exitPointerLock();
    this.model.deathCause = cause;
    this.model.minutesSurvived = s.secondsSurvived / 60;
    // Permadeath: this world's save would just reload a corpse. Other worlds are kept.
    const slot = this.current?.slot;
    if (slot) void this.store?.delete(slot).then(() => this.refreshSaveSummary());
    this.machine.transition('gameover');
  }

  // ---- Persistence -----------------------------------------------------------

  private async saveNow(silent: boolean): Promise<void> {
    const s = this.session;
    if (!s || !this.store || this.busy || !s.survivorAlive) return;
    this.busy = true;
    this.model.busy = true;
    try {
      await this.store.save(s.capture(), this.current ?? undefined);
      this.lastAutosave = s.loop.stats.simTime;
      if (!silent) this.menu.toast('Game saved');
    } catch (err) {
      console.error(err);
      this.menu.toast('Saving failed — storage may be full', true);
    } finally {
      this.busy = false;
      this.model.busy = false;
      if (this.machine.state === 'paused') this.menu.render('paused', this.model);
    }
  }

  private async refreshSaveSummary(): Promise<void> {
    this.model.save = this.store ? await this.store.latestSummary() : null;
    this.model.saves = this.store ? await this.store.list() : [];
  }

  /** Refresh/close: IndexedDB can't be trusted to commit now, so write synchronously. */
  private readonly onPageHide = (): void => {
    const s = this.session;
    const st = this.machine.state;
    if (!s || !this.store || (st !== 'playing' && st !== 'paused') || !s.survivorAlive || this.model.freshSession) return;
    if (this.store.emergencySave(s.capture(), this.current ?? undefined)) sessionStorage.setItem(RESUME_KEY, '1');
  };

  /** Tab hidden (often the step before closing it): take a normal async save while we still can. */
  private readonly onVisibility = (): void => {
    if (document.hidden && this.machine.state === 'playing') void this.saveNow(true);
  };

  // ---- Per-frame hooks -------------------------------------------------------

  private readonly onFrame = (s: GameSession): void => {
    const state = this.machine.state;
    if (state === 'playing') {
      const box = s.takeOpenRequest();
      if (box !== null && !s.isInventoryOpen) this.toggleInventory(s, true, box);
      else if (this.input.wasPressedRaw('inventory')) this.toggleInventory(s, !s.isInventoryOpen);
      else if (this.input.wasPressedRaw('pause')) {
        // Esc normally arrives as a pointer-lock exit; this path covers playing
        // without lock (lock refused) and closing the inventory with Esc.
        if (s.isInventoryOpen) this.toggleInventory(s, false);
        else s.loop.pause('user');
      }
      if (s.loop.stats.simTime - this.lastAutosave > AUTOSAVE_EVERY_SIM_SECONDS) {
        this.lastAutosave = s.loop.stats.simTime;
        void this.saveNow(true);
      }
    }
  };

  private toggleInventory(s: GameSession, open: boolean, container?: number): void {
    if (s.isInventoryOpen === open) return;
    this.lifecycle.uiOwnsPointer = open;
    s.setInventoryOpen(open, container);
    this.input.setGameplayEnabled(!open);
    if (open) document.exitPointerLock();
    else this.input.requestPointerLock();
  }

  // ---- State changes -----------------------------------------------------------

  private onStateChange(from: AppState, to: AppState): void {
    // Leaving the game for a menu tears the session down.
    if ((to === 'menu' || to === 'config') && this.session) this.detach();
    if (to === 'menu' && from !== 'menu') this.menu.resetView();
    if (to === 'loading') this.model.loading = { fraction: 0, label: 'Preparing…' };
    if (to === 'paused') {
      this.input.setGameplayEnabled(false);
      if (this.session?.isInventoryOpen) this.toggleInventory(this.session, false);
      if (from === 'playing') void this.saveNow(true); // pausing is a natural checkpoint
    }
    if (to === 'playing') this.input.setGameplayEnabled(true);
    // Any menu needs a visible cursor. Pausing with P (or the window losing
    // focus) does NOT release pointer lock by itself, and a locked pointer
    // would make the menu buttons unclickable.
    else if (this.input.pointerLocked) document.exitPointerLock();
    this.menu.render(to, this.model);
  }
}
