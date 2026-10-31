/**
 * Action-based input. Gameplay code asks "is `sprint` held?", never "is Shift
 * held?", so bindings can be remapped and persisted without touching systems.
 *
 * Bindings use KeyboardEvent.code (physical key position), not .key. That
 * means the default WASD layout lands on ZQSD on a French AZERTY keyboard
 * automatically, and labels in the UI come from `navigator.keyboard.getLayoutMap()`
 * when available.
 */

export type Action =
  | 'moveForward'
  | 'moveBack'
  | 'moveLeft'
  | 'moveRight'
  | 'sprint'
  | 'crouch'
  | 'jump'
  | 'interact'
  | 'inventory'
  | 'attack'
  | 'throw'
  | 'pause'
  | 'build'
  | 'cyclePiece'
  | 'demolish'
  | 'map';

export type Binding = string; // KeyboardEvent.code, or 'Mouse0' / 'Mouse1' / 'Mouse2'

export const DEFAULT_BINDINGS: Readonly<Record<Action, readonly Binding[]>> = {
  moveForward: ['KeyW', 'ArrowUp'],
  moveBack: ['KeyS', 'ArrowDown'],
  moveLeft: ['KeyA', 'ArrowLeft'],
  moveRight: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft'],
  // Not Ctrl: Ctrl+W (crouch + walk forward) closes the browser tab and
  // cannot be intercepted; Ctrl+D/S/F also trigger browser shortcuts.
  crouch: ['KeyC'],
  jump: ['Space'],
  interact: ['KeyE'],
  inventory: ['KeyI', 'Tab'],
  attack: ['Mouse0'],
  throw: ['Mouse2'],
  pause: ['Escape', 'KeyP'],
  build: ['KeyB'],
  cyclePiece: ['KeyR'],
  demolish: ['KeyX'],
  map: ['KeyM'],
};

// v2: bindings changed (Ctrl removed from crouch); old saved maps are discarded.
const STORAGE_KEY = 'survival.bindings.v2';

/**
 * Keys whose default browser action must never run while playing:
 * - Digit row: on AZERTY, Digit4 types an apostrophe, which opens Firefox's
 *   "Quick Find (links only)" bar. The bar steals keyboard focus, so the game
 *   stops receiving input and looks frozen. Digit3 (") and others can trigger
 *   "search when you start typing" too.
 * - Quote / Slash: Firefox Quick Find on QWERTY.
 * - Space / arrows / Tab: page scroll and focus changes.
 */
const MOVEMENT_ACTIONS: ReadonlySet<Action> = new Set<Action>(['moveForward', 'moveBack', 'moveLeft', 'moveRight', 'sprint', 'crouch', 'jump']);

const ALWAYS_PREVENT = /^(Digit\d|Numpad\d|Quote|Slash|Backquote|Space|Tab|Arrow(Up|Down|Left|Right))$/;

export class InputManager {
  private bindings: Record<Action, Binding[]>;
  private readonly down = new Set<Binding>();
  private readonly pressedThisFrame = new Set<Binding>();
  private readonly releasedThisFrame = new Set<Binding>();
  private mouseDX = 0;
  private mouseDY = 0;
  private wheel = 0;
  private enabled = true;
  /** Inventory/crafting open: you can still walk, run, jump and crouch, but not act. */
  private movementOnly = false;

  mouseSensitivity = 0.0022;
  invertY = false;

  constructor(private readonly target: HTMLElement, private readonly doc: Document = document) {
    this.bindings = this.loadBindings();
    doc.addEventListener('keydown', this.onKeyDown);
    doc.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('mousedown', this.onMouseDown);
    doc.addEventListener('mouseup', this.onMouseUp);
    doc.addEventListener('mousemove', this.onMouseMove);
    target.addEventListener('contextmenu', this.preventDefault);
    target.addEventListener('wheel', this.onWheel, { passive: false });
    // Edge case: if the window loses focus while W is held, the browser never
    // delivers keyup, and the player would walk forever on return.
    window.addEventListener('blur', this.releaseAll);
  }

  // ---- Queries (call from systems) ----------------------------------------

  isDown(action: Action): boolean {
    if (!this.enabled || (this.movementOnly && !MOVEMENT_ACTIONS.has(action))) return false;
    for (const b of this.bindings[action]) if (this.down.has(b)) return true;
    return false;
  }

  /** True only on the frame the action was first pressed (edge-triggered). */
  wasPressed(action: Action): boolean {
    if (!this.enabled || (this.movementOnly && !MOVEMENT_ACTIONS.has(action))) return false;
    for (const b of this.bindings[action]) if (this.pressedThisFrame.has(b)) return true;
    return false;
  }

  wasReleased(action: Action): boolean {
    for (const b of this.bindings[action]) if (this.releasedThisFrame.has(b)) return true;
    return false;
  }

  /** -1..1 on each axis; diagonals are normalised by the movement system. */
  moveAxis(out: { x: number; y: number }): { x: number; y: number } {
    out.x = (this.isDown('moveRight') ? 1 : 0) - (this.isDown('moveLeft') ? 1 : 0);
    out.y = (this.isDown('moveForward') ? 1 : 0) - (this.isDown('moveBack') ? 1 : 0);
    return out;
  }

  /** Mouse delta in radians since last endFrame(). Only non-zero while pointer-locked. */
  lookDelta(out: { yaw: number; pitch: number }): { yaw: number; pitch: number } {
    out.yaw = -this.mouseDX * this.mouseSensitivity;
    out.pitch = -this.mouseDY * this.mouseSensitivity * (this.invertY ? -1 : 1);
    return out;
  }

  get pointerLocked(): boolean {
    return this.doc.pointerLockElement === this.target;
  }

  requestPointerLock(): void {
    // Returns a promise in modern Chrome; rejected if called too soon after an
    // exit (Chrome enforces ~1 s cooldown). Swallow — the overlay will ask again.
    try {
      const r = this.target.requestPointerLock() as unknown;
      if (r instanceof Promise) r.catch(() => undefined);
    } catch {
      /* ignore */
    }
  }

  /** Gameplay input is ignored while UI (inventory, pause menu) has focus. */
  setGameplayEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.mouseDX = this.mouseDY = 0;
  }

  /**
   * While a panel (inventory, crafting, a storage box) is open the player can
   * keep moving: only movement actions are live, clicks go to the UI.
   */
  setMovementOnly(on: boolean): void {
    this.movementOnly = on;
  }

  /** UI-level check that works even while gameplay input is disabled. */
  wasPressedRaw(action: Action): boolean {
    for (const b of this.bindings[action]) if (this.pressedThisFrame.has(b)) return true;
    return false;
  }

  /** Must be called exactly once per rendered frame, after all systems ran. */
  endFrame(): void {
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
    this.mouseDX = this.mouseDY = 0;
    this.wheel = 0;
  }

  // ---- Rebinding ----------------------------------------------------------

  rebind(action: Action, bindings: Binding[]): void {
    this.bindings[action] = [...bindings];
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.bindings));
    } catch {
      /* storage disabled (private mode) — bindings still apply this session */
    }
  }

  getBindings(action: Action): readonly Binding[] {
    return this.bindings[action];
  }

  private loadBindings(): Record<Action, Binding[]> {
    const base = Object.fromEntries(
      Object.entries(DEFAULT_BINDINGS).map(([k, v]) => [k, [...v]]),
    ) as Record<Action, Binding[]>;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return base;
      const parsed = JSON.parse(raw) as Partial<Record<Action, unknown>>;
      for (const action of Object.keys(base) as Action[]) {
        const v = parsed[action];
        if (Array.isArray(v) && v.every((x) => typeof x === 'string')) base[action] = v as string[];
      }
    } catch {
      /* corrupt or unavailable storage: fall back to defaults */
    }
    return base;
  }

  // ---- DOM handlers ---------------------------------------------------------

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (isTypingInField(e)) return;
    // Leave real browser shortcuts (Ctrl/Cmd+R, F5, F12…) alone; block every
    // other default action for keys the game uses (see ALWAYS_PREVENT).
    if (!e.ctrlKey && !e.metaKey && !e.altKey && (ALWAYS_PREVENT.test(e.code) || this.isBound(e.code))) e.preventDefault();
    if (e.repeat) return; // OS key-repeat must not re-trigger wasPressed()
    this.down.add(e.code);
    this.pressedThisFrame.add(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.down.delete(e.code);
    this.releasedThisFrame.add(e.code);
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    const b = `Mouse${e.button}`;
    this.down.add(b);
    this.pressedThisFrame.add(b);
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    const b = `Mouse${e.button}`;
    this.down.delete(b);
    this.releasedThisFrame.add(b);
  };

  private isBound(code: string): boolean {
    for (const list of Object.values(this.bindings)) if (list.includes(code)) return true;
    return false;
  }

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.enabled) return;
    this.wheel += Math.sign(e.deltaY);
    if (this.pointerLocked) e.preventDefault();
  };

  /** Mouse-wheel notches since last endFrame() (+1 = scrolled down). */
  get wheelDelta(): number {
    return this.wheel;
  }

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.pointerLocked || !this.enabled) return;
    // Firefox/Chrome occasionally report a huge spike on the first event after
    // locking; clamp to avoid the camera snapping around.
    this.mouseDX += clamp(e.movementX, -300, 300);
    this.mouseDY += clamp(e.movementY, -300, 300);
  };

  private readonly preventDefault = (e: Event): void => e.preventDefault();

  readonly releaseAll = (): void => {
    for (const b of this.down) this.releasedThisFrame.add(b);
    this.down.clear();
    this.mouseDX = this.mouseDY = 0;
  };

  dispose(): void {
    this.doc.removeEventListener('keydown', this.onKeyDown);
    this.doc.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('mousedown', this.onMouseDown);
    this.doc.removeEventListener('mouseup', this.onMouseUp);
    this.doc.removeEventListener('mousemove', this.onMouseMove);
    this.target.removeEventListener('contextmenu', this.preventDefault);
    this.target.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('blur', this.releaseAll);
  }
}

function isTypingInField(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
