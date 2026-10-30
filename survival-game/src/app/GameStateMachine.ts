/**
 * Application-level state machine (menus ↔ game). Pure: no DOM, testable.
 *
 *   menu ──► config ──► loading ──► paused ⇄ playing ──► gameover
 *    ▲  └────────────────►│  (continue)  │                  │
 *    └────────────────────┴──────────────┴──────────────────┘
 *
 * Rapid-toggle safety comes from two rules:
 *  1. Illegal or same-state transitions are ignored (a double-clicked "Start"
 *     is a no-op the second time, Esc spam can't skip states).
 *  2. Async work (terrain generation, loading a save) captures an *epoch*
 *     when it starts and must check `stillValid()` before committing. Any
 *     transition bumps the epoch, so a generation that finishes after the
 *     player went back to the menu is discarded instead of yanking them into
 *     a game.
 */
export type AppState = 'menu' | 'config' | 'loading' | 'playing' | 'paused' | 'gameover';

const ALLOWED: Readonly<Record<AppState, readonly AppState[]>> = {
  menu: ['config', 'loading'],
  config: ['menu', 'loading'],
  loading: ['paused', 'menu', 'config'],
  playing: ['paused', 'gameover'],
  paused: ['playing', 'menu', 'gameover'],
  gameover: ['menu', 'config'],
};

export interface AsyncTicket {
  readonly epoch: number;
  /** False once any transition has happened since the ticket was issued. */
  stillValid(): boolean;
}

type Listener = (from: AppState, to: AppState) => void;

export class GameStateMachine {
  private current: AppState;
  private epoch = 0;
  private readonly listeners: Listener[] = [];
  /** Recent transitions, for debugging rapid-input bugs. */
  readonly history: Array<{ from: AppState; to: AppState; at: number }> = [];

  constructor(initial: AppState = 'menu') {
    this.current = initial;
  }

  get state(): AppState {
    return this.current;
  }

  can(to: AppState): boolean {
    return to !== this.current && ALLOWED[this.current].includes(to);
  }

  /** Returns false (and does nothing) for illegal or redundant transitions. */
  transition(to: AppState): boolean {
    if (!this.can(to)) return false;
    const from = this.current;
    this.current = to;
    this.epoch++;
    this.history.push({ from, to, at: Date.now() });
    if (this.history.length > 50) this.history.shift();
    for (const l of this.listeners) l(from, to);
    return true;
  }

  ticket(): AsyncTicket {
    const epoch = this.epoch;
    return { epoch, stillValid: () => this.epoch === epoch };
  }

  onChange(l: Listener): () => void {
    this.listeners.push(l);
    return () => {
      const i = this.listeners.indexOf(l);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }
}
