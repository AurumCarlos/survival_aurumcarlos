import type { System, World } from './ecs/World';

/**
 * Abstracts the browser timing APIs so the loop can run headless (tests,
 * server-side simulation) with a manual clock.
 */
export interface FrameScheduler {
  now(): number; // milliseconds
  request(cb: (timeMs: number) => void): number;
  cancel(handle: number): void;
}

/** Frame-rate limit (FPS) for browserScheduler; 0 = unlimited. Set from the graphics settings. */
let frameLimit = 60;
export function setFrameLimit(fps: number): void {
  frameLimit = Math.max(0, fps);
}

/**
 * The browser frame scheduler, with a frame-rate limit.
 *
 * requestAnimationFrame runs at the screen's refresh rate (usually 60 Hz),
 * so on its own it caps the game there whatever the setting says. Up to 60
 * FPS frames stay on rAF (vsync: smoothest), skipping some for a 30 limit.
 * Above 60, or unlimited, frames are paced with timers instead — like
 * turning VSync off in a desktop game. On a 60 Hz screen the extra frames
 * are rendered (lower input latency) but the screen still shows 60 a second.
 * A hidden tab always falls back to rAF, which the browser throttles.
 */
class PacedScheduler implements FrameScheduler {
  private nextId = 1;
  private last = 0;
  private readonly live = new Map<number, { raf?: number; timer?: ReturnType<typeof setTimeout> }>();
  private channel: MessageChannel | null = null;
  /** Callbacks waiting for the next MessageChannel task (several loops can share this scheduler). */
  private readonly queued: Array<() => void> = [];

  now(): number {
    return performance.now();
  }

  request(cb: (timeMs: number) => void): number {
    const id = this.nextId++;
    const entry: { raf?: number; timer?: ReturnType<typeof setTimeout> } = {};
    this.live.set(id, entry);
    const fire = (t: number): void => {
      if (!this.live.delete(id)) return; // cancelled
      this.last = t;
      cb(t);
    };
    const hidden = typeof document !== 'undefined' && document.hidden;
    if (hidden || (frameLimit > 0 && frameLimit <= 60)) {
      const onFrame = (t: number): void => {
        if (!this.live.has(id)) return;
        // Below the refresh rate (a 30 limit): skip frames that come too early.
        if (!hidden && frameLimit < 55 && t - this.last < 1000 / frameLimit - 2) {
          entry.raf = requestAnimationFrame(onFrame);
          return;
        }
        fire(t);
      };
      entry.raf = requestAnimationFrame(onFrame);
      return id;
    }
    const wait = frameLimit > 0 ? this.last + 1000 / frameLimit - performance.now() : 0;
    if (wait > 1) {
      entry.timer = setTimeout(() => fire(performance.now()), wait);
    } else {
      // A MessageChannel task has no 4 ms timer clamp (needed above ~200 FPS).
      if (!this.channel) {
        this.channel = new MessageChannel();
        this.channel.port1.onmessage = () => this.queued.shift()?.();
      }
      this.queued.push(() => fire(performance.now()));
      this.channel.port2.postMessage(0);
    }
    return id;
  }

  cancel(handle: number): void {
    const e = this.live.get(handle);
    if (!e) return;
    if (e.raf !== undefined) cancelAnimationFrame(e.raf);
    if (e.timer !== undefined) clearTimeout(e.timer);
    this.live.delete(handle);
  }
}

export const browserScheduler: FrameScheduler = new PacedScheduler();

export type PauseReason = 'user' | 'hidden' | 'blur' | 'context-lost' | 'loading' | 'dead';

export interface GameLoopOptions {
  /** Simulation rate. 60 Hz matches the render target and Cannon's sweet spot. */
  fixedHz?: number;
  /**
   * Upper bound on simulated time per frame. If a frame takes 400 ms (GC
   * hitch, debugger, slow device) we simulate at most this much, trading a
   * short slow-motion moment for not entering the "spiral of death" where
   * catching up makes the next frame even slower.
   */
  maxFrameTime?: number;
  /** Hard cap on fixed steps per frame (belt-and-braces for the above). */
  maxSubSteps?: number;
  scheduler?: FrameScheduler;
  onRender?: (alpha: number, frameDt: number) => void;
}

export interface LoopStats {
  fps: number;
  frameMs: number;
  fixedStepsLastFrame: number;
  simTime: number;
}

/**
 * Fixed-timestep loop with render interpolation ("Fix Your Timestep").
 *
 *   frame ─┬─ accumulate real elapsed time
 *          ├─ while accumulator ≥ dt: fixedUpdate(dt)   ← physics, AI, survival
 *          ├─ alpha = accumulator / dt
 *          ├─ update(frameDt, alpha)                     ← input, camera, interpolation
 *          └─ render(alpha)
 *
 * Physics therefore always advances in identical 16.67 ms steps regardless
 * of monitor refresh rate (60/120/144 Hz) or frame drops, which keeps Cannon
 * stable and makes survival decay frame-rate independent.
 */
export class GameLoop {
  readonly fixedDt: number;
  private readonly maxFrameTime: number;
  private readonly maxSubSteps: number;
  private readonly scheduler: FrameScheduler;
  private readonly onRender: ((alpha: number, frameDt: number) => void) | undefined;

  private readonly systems: System[] = [];
  private accumulator = 0;
  private lastTime = -1;
  private handle: number | null = null;
  private readonly pauseReasons = new Set<PauseReason>();
  private pauseListeners: Array<(paused: boolean, reasons: ReadonlySet<PauseReason>) => void> = [];

  /** Global time scale (slow-mo, sleeping fast-forward). Applied to sim time only. */
  timeScale = 1;

  readonly stats: LoopStats = { fps: 0, frameMs: 0, fixedStepsLastFrame: 0, simTime: 0 };
  private fpsFrames = 0;
  private fpsWindowStart = 0;

  constructor(private readonly world: World, opts: GameLoopOptions = {}) {
    this.fixedDt = 1 / (opts.fixedHz ?? 60);
    this.maxFrameTime = opts.maxFrameTime ?? 0.25;
    this.maxSubSteps = opts.maxSubSteps ?? 8;
    this.scheduler = opts.scheduler ?? browserScheduler;
    this.onRender = opts.onRender;
  }

  addSystem(system: System): this {
    this.systems.push(system);
    return this;
  }

  getSystem<T extends System>(name: string): T | undefined {
    return this.systems.find((s) => s.name === name) as T | undefined;
  }

  start(): void {
    if (this.handle !== null) return;
    this.lastTime = -1;
    this.handle = this.scheduler.request(this.frame);
  }

  stop(): void {
    if (this.handle !== null) this.scheduler.cancel(this.handle);
    this.handle = null;
  }

  // ---- Pausing ------------------------------------------------------------
  // Several independent reasons can hold the game paused at once (tab hidden
  // AND inventory open AND WebGL context lost). The game resumes only when the
  // last reason is cleared, so e.g. returning to the tab does not unpause a
  // game the player paused manually.

  // Listeners are told about EVERY change of the reason set, not just
  // paused↔running. Firefox fires window 'blur' *before* releasing pointer
  // lock when you alt-tab: the loop was already paused (blur) when 'user'
  // arrived, so the app never heard about it, never showed the pause menu,
  // and nothing could clear 'user' again — the game stayed frozen until F5.

  pause(reason: PauseReason): void {
    if (this.pauseReasons.has(reason)) return;
    this.pauseReasons.add(reason);
    this.emitPause();
  }

  resume(reason: PauseReason): void {
    if (!this.pauseReasons.delete(reason)) return;
    if (!this.isPaused) {
      // Critical: forget the timestamp from before the pause. Otherwise the
      // first frame after a 10-minute tab switch would see dt = 600 s and
      // (even clamped) fast-forward hunger/thirst.
      this.lastTime = -1;
      this.accumulator = 0;
    }
    this.emitPause();
  }

  get isPaused(): boolean {
    return this.pauseReasons.size > 0;
  }

  get activePauseReasons(): ReadonlySet<PauseReason> {
    return this.pauseReasons;
  }

  onPauseChange(cb: (paused: boolean, reasons: ReadonlySet<PauseReason>) => void): void {
    this.pauseListeners.push(cb);
  }

  private emitPause(): void {
    for (const cb of this.pauseListeners) cb(this.isPaused, this.pauseReasons);
  }

  // ---- Frame ---------------------------------------------------------------

  /** Arrow function so it can be handed to rAF without re-binding each frame. */
  private readonly frame = (timeMs: number): void => {
    this.handle = this.scheduler.request(this.frame);
    this.tick(timeMs);
  };

  /**
   * One rendered frame. Public so headless tools can drive the loop with a
   * synthetic clock: `loop.tick(t += 16.67)`.
   */
  tick(timeMs: number): void {
    if (this.lastTime < 0) this.lastTime = timeMs;
    // Real elapsed time in seconds, clamped (see maxFrameTime). Negative
    // deltas can appear when rAF timestamps and performance.now() disagree.
    let frameDt = (timeMs - this.lastTime) / 1000;
    this.lastTime = timeMs;
    frameDt = Math.min(Math.max(frameDt, 0), this.maxFrameTime);

    this.updateFps(timeMs, frameDt);

    if (this.isPaused) {
      // Keep rendering while paused (menus, blurred background) but do not
      // advance the simulation. alpha=1 shows the latest physics state.
      this.onRender?.(1, frameDt);
      return;
    }

    this.accumulator += frameDt * this.timeScale;

    let steps = 0;
    while (this.accumulator >= this.fixedDt && steps < this.maxSubSteps) {
      for (const s of this.systems) s.fixedUpdate?.(this.world, this.fixedDt);
      this.world.flush();
      this.accumulator -= this.fixedDt;
      this.stats.simTime += this.fixedDt;
      steps++;
    }
    if (steps === this.maxSubSteps) {
      // Still behind: drop the backlog rather than carry it into next frame.
      this.accumulator = 0;
    }
    this.stats.fixedStepsLastFrame = steps;

    // How far into the *next* physics step "now" is. Render code blends the
    // previous and current physics states by this factor so motion is smooth
    // on 144 Hz displays and when a frame lands between two fixed steps.
    const alpha = this.accumulator / this.fixedDt;

    for (const s of this.systems) s.update?.(this.world, frameDt, alpha);
    this.world.flush();
    this.onRender?.(alpha, frameDt);
  }

  private updateFps(timeMs: number, frameDt: number): void {
    this.stats.frameMs = frameDt * 1000;
    this.fpsFrames++;
    if (timeMs - this.fpsWindowStart >= 500) {
      this.stats.fps = (this.fpsFrames * 1000) / (timeMs - this.fpsWindowStart || 1);
      this.fpsFrames = 0;
      this.fpsWindowStart = timeMs;
    }
  }

  dispose(): void {
    this.stop();
    for (const s of this.systems) s.dispose?.();
    this.systems.length = 0;
    this.pauseListeners = [];
  }
}
