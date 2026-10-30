import type { GameLoop } from './GameLoop';
import type { InputManager } from './Input';

export interface ViewportTarget {
  /** Called with CSS pixel size and the clamped device pixel ratio. */
  resize(width: number, height: number, pixelRatio: number): void;
}

export interface LifecycleOptions {
  container: HTMLElement;
  canvas: HTMLCanvasElement;
  input: InputManager;
  viewport: ViewportTarget;
  /** Rendering at DPR 3 on a phone/4K laptop costs 2.25× the fill-rate of DPR 2 for little visible gain. */
  maxPixelRatio?: number;
  onContextLost?: () => void;
  onContextRestored?: () => void;
}

/**
 * Browser edge cases in one place:
 *
 *  1. Tab switching   → `visibilitychange` pauses the sim. rAF is throttled to
 *                       ~1 Hz or stopped in background tabs anyway, but without
 *                       an explicit pause the first frame back would carry a
 *                       huge delta. The loop also discards its timestamp on resume.
 *  2. Window blur     → pause while the player is alt-tabbed but the tab is
 *                       still visible (second monitor). Stuck keys are released
 *                       by InputManager.
 *  3. Pointer lock    → losing it (Esc) opens the pause menu; regaining it
 *                       requires a user gesture, hence the click-to-resume overlay.
 *  4. Resizing        → ResizeObserver on the container (catches devtools
 *                       docking and CSS layout changes that `window.resize`
 *                       misses), coalesced to one update per animation frame.
 *  5. DPR changes     → dragging the window to a monitor with different scaling.
 *  6. WebGL context loss → GPU reset / driver crash / too many contexts. We
 *                       pause and wait for restoration instead of crashing.
 */
export class Lifecycle {
  private readonly ro: ResizeObserver;
  private resizeQueued = false;
  private dprQuery: MediaQueryList | null = null;
  private readonly maxPixelRatio: number;
  /**
   * Set while a UI panel (inventory) deliberately released pointer lock, so
   * the unlock is not mistaken for the player pressing Esc to pause.
   */
  uiOwnsPointer = false;
  /**
   * The loop of the current game session, or null in menus. Sessions come
   * and go (new game, quit to menu); the browser listeners stay registered once.
   */
  loop: GameLoop | null = null;

  constructor(private readonly o: LifecycleOptions) {
    this.maxPixelRatio = o.maxPixelRatio ?? 2;

    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('focus', this.onFocus);
    // Any input means the window has focus again, even if 'focus' never fired.
    window.addEventListener('pointerdown', this.onFocus, true);
    window.addEventListener('keydown', this.onFocus, true);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    o.canvas.addEventListener('webglcontextlost', this.onContextLost, false);
    o.canvas.addEventListener('webglcontextrestored', this.onContextRestored, false);

    this.ro = new ResizeObserver(this.queueResize);
    this.ro.observe(o.container);
    this.watchDevicePixelRatio();
    this.applyResize();
  }

  private readonly onVisibility = (): void => {
    if (document.hidden) {
      this.loop?.pause('hidden');
      this.o.input.releaseAll();
    } else {
      this.loop?.resume('hidden');
    }
  };

  private readonly onBlur = (): void => this.loop?.pause('blur');
  private readonly onFocus = (): void => this.loop?.resume('blur');

  private readonly onPointerLockChange = (): void => {
    // Leaving pointer lock while playing == player pressed Esc (browsers
    // reserve Esc for exiting lock, so we never receive that keydown).
    if (this.loop && !this.o.input.pointerLocked && !this.uiOwnsPointer && !this.loop.activePauseReasons.has('loading')) {
      this.loop.pause('user');
    }
  };

  private readonly onContextLost = (e: Event): void => {
    e.preventDefault(); // signals we will handle restoration
    this.loop?.pause('context-lost');
    this.o.onContextLost?.();
  };

  private readonly onContextRestored = (): void => {
    // Three.js re-uploads geometry/textures lazily on the next render.
    this.o.onContextRestored?.();
    this.loop?.resume('context-lost');
  };

  private readonly queueResize = (): void => {
    if (this.resizeQueued) return;
    this.resizeQueued = true;
    requestAnimationFrame(() => {
      this.resizeQueued = false;
      this.applyResize();
    });
  };

  private applyResize(): void {
    const { clientWidth: w, clientHeight: h } = this.o.container;
    // A collapsed container (display:none, minimized) reports 0×0; resizing to
    // that would produce a NaN camera aspect and an invalid framebuffer.
    if (w === 0 || h === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio);
    this.o.viewport.resize(w, h, dpr);
  }

  private watchDevicePixelRatio(): void {
    // matchMedia on the *current* DPR fires once when it changes; re-arm each time.
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    this.dprQuery.addEventListener('change', this.onDprChange);
  }

  private readonly onDprChange = (): void => {
    this.watchDevicePixelRatio();
    this.queueResize();
  };

  dispose(): void {
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('focus', this.onFocus);
    window.removeEventListener('pointerdown', this.onFocus, true);
    window.removeEventListener('keydown', this.onFocus, true);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.o.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.o.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    this.ro.disconnect();
  }
}
