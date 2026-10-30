import { defineComponent } from '../../core/ecs/World';
import type { ItemId } from '../../data/schema';

/**
 * First-person animation state machine for the player's hands/tool.
 *
 *                 ┌──────────── request(action) ───────────┐
 *                 │                                         ▼
 *   holstered ─► equipping ─► ready ◄──── (clip ends) ── swing / harvest / throw
 *       ▲                       │                          (impact event once,
 *       └──── unequipping ◄─────┘                           mid-clip)
 *           (sprint, UI open, hotbar change, death)
 *
 * The *tool is only drawn* in equipping / ready / action / unequipping. While
 * sprinting or with a UI panel open it is lowered and then hidden, so it can
 * never swing through terrain or poke through the camera while running —
 * the clipping bug this replaces. Gameplay effects (damage, harvest yield,
 * spear release) happen on the clip's impact frame, not on the button press,
 * so visuals and outcomes line up.
 *
 * Pure data + functions: no Three.js, fully testable headless.
 */

export type AnimState = 'holstered' | 'equipping' | 'ready' | 'unequipping' | AnimAction;
export type AnimAction = 'swing' | 'harvest' | 'throw';

export interface ClipDef {
  duration: number;
  /** Seconds into the clip when the gameplay effect lands. */
  impact?: number;
}

export const CLIPS: Readonly<Record<Exclude<AnimState, 'holstered' | 'ready'>, ClipDef>> = {
  equipping: { duration: 0.28 },
  unequipping: { duration: 0.2 },
  swing: { duration: 0.5, impact: 0.2 },
  harvest: { duration: 0.62, impact: 0.34 },
  throw: { duration: 0.55, impact: 0.24 },
};

export interface PlayerAnim {
  state: AnimState;
  /** Seconds in the current state. */
  time: number;
  /** Item model currently in hand (null = bare hand). Only changes while holstered. */
  held: ItemId | null;
  /** One buffered action request, so a click during equip isn't lost. */
  queued: AnimAction | null;
  impactFired: boolean;
  /** Walk-bob phase (radians), advanced by movement speed. */
  bob: number;
  /** Set by the UI layer while inventory/menus are open. */
  uiBlocked: boolean;
  /** Set by BuildingSystem while build mode is on (hands hold the building plan). */
  building: boolean;
  /** Speed multiplier for action clips, set with each request (e.g. the right tool swings faster). */
  actionSpeed: number;
  /**
   * Action requested by gameplay systems this frame (Interaction → harvest,
   * Combat → swing/throw). Consumed by PlayerAnimationSystem. This field is
   * the whole coupling between those systems and the animation layer.
   */
  request: AnimAction | null;
}
export const PlayerAnimC = defineComponent<PlayerAnim>('PlayerAnim');

export function makePlayerAnim(): PlayerAnim {
  return { state: 'holstered', time: 0, held: null, queued: null, impactFired: false, bob: 0, uiBlocked: false, building: false, actionSpeed: 1, request: null };
}

export interface AnimInputs {
  /** Item that *should* be in hand (active hotbar slot). */
  wanted: ItemId | null;
  sprinting: boolean;
  /** Planar speed (m/s) — drives walk bob. */
  speed: number;
  alive: boolean;
  /** Action requested this frame (attack / harvest / throw). */
  request: AnimAction | null;
}

export interface AnimStepResult {
  /** Non-null on the frame an action's impact lands. */
  impact: AnimAction | null;
  /** The state entered this frame, if it changed (for sound hooks, debug). */
  entered: AnimState | null;
}

const ACTIONS: ReadonlySet<AnimState> = new Set<AnimState>(['swing', 'harvest', 'throw']);

/** Can this action be performed with what's in hand? */
export function actionAllowed(action: AnimAction, held: ItemId | null): boolean {
  if (action === 'throw') return held === 'stone_spear';
  return true; // swing/harvest work with any tool or bare hands
}

export function stepAnim(a: PlayerAnim, dt: number, inp: AnimInputs): AnimStepResult {
  const res: AnimStepResult = { impact: null, entered: null };
  const enter = (s: AnimState): void => {
    a.state = s;
    a.time = 0;
    a.impactFired = false;
    res.entered = s;
  };
  // Holster when the hand must be empty or a different item is wanted.
  const mustHolster = !inp.alive || inp.sprinting || a.uiBlocked || a.building;

  if (inp.request && !mustHolster) a.queued = inp.request;
  if (mustHolster) a.queued = null;

  a.time += dt;
  if (inp.speed > 0.2 && !inp.sprinting) a.bob += dt * inp.speed * 2.2;

  switch (a.state) {
    case 'holstered':
      if (!mustHolster) {
        a.held = inp.wanted;
        enter('equipping');
      }
      break;

    case 'equipping':
      if (mustHolster || inp.wanted !== a.held) enter('unequipping');
      else if (a.time >= CLIPS.equipping.duration) enter('ready');
      break;

    case 'ready':
      if (mustHolster || inp.wanted !== a.held) {
        enter('unequipping');
      } else if (a.queued) {
        const action = a.queued;
        a.queued = null;
        if (actionAllowed(action, a.held)) enter(action);
      }
      break;

    case 'unequipping':
      if (a.time >= CLIPS.unequipping.duration) {
        a.held = null;
        enter('holstered');
      }
      break;

    default: {
      // Action clips. They run to completion (half-finished swings look
      // broken) unless the player dies; the impact fires exactly once.
      if (!inp.alive) {
        enter('unequipping');
        break;
      }
      const clip = CLIPS[a.state];
      if (!a.impactFired && clip.impact !== undefined && a.time >= clip.impact) {
        a.impactFired = true;
        res.impact = a.state as AnimAction;
      }
      if (a.time >= clip.duration) {
        if (a.state === 'throw') {
          // The spear is gone: skip 'ready' so the thrown spear never reappears in hand.
          a.held = null;
          enter('holstered');
        } else {
          enter('ready');
        }
      }
    }
  }
  return res;
}

export function isActionState(s: AnimState): s is AnimAction {
  return ACTIONS.has(s);
}

// ---------------------------------------------------------------------------
// Pose: camera-space transform of the hand/tool for the current state.
// ---------------------------------------------------------------------------

export interface ViewPose {
  visible: boolean;
  /** Camera-space offset (m). Camera looks down −Z. */
  x: number;
  y: number;
  z: number;
  /** Euler XYZ (radians). */
  rx: number;
  ry: number;
  rz: number;
}

const REST = { x: 0.3, y: -0.34, z: -0.62, rx: 0.1, ry: -0.3, rz: 0.12 };
const LOWERED_Y = -0.85; // fully below the bottom edge of the screen

export function viewModelPose(a: PlayerAnim, out: ViewPose): ViewPose {
  out.visible = a.state !== 'holstered';
  out.x = REST.x;
  out.y = REST.y;
  out.z = REST.z;
  out.rx = REST.rx;
  out.ry = REST.ry;
  out.rz = REST.rz;

  switch (a.state) {
    case 'holstered':
      out.y = LOWERED_Y;
      break;
    case 'equipping': {
      const t = easeOut(a.time / CLIPS.equipping.duration);
      out.y = lerp(LOWERED_Y, REST.y, t);
      out.rx = lerp(-0.6, REST.rx, t);
      break;
    }
    case 'unequipping': {
      const t = easeIn(a.time / CLIPS.unequipping.duration);
      out.y = lerp(REST.y, LOWERED_Y, t);
      out.rx = lerp(REST.rx, -0.6, t);
      break;
    }
    case 'ready':
      // Idle sway + walk bob.
      out.x += Math.sin(a.bob) * 0.012;
      out.y += Math.abs(Math.cos(a.bob)) * 0.014 + Math.sin(a.time * 1.6) * 0.004;
      break;
    case 'swing':
    case 'harvest': {
      const clip = CLIPS[a.state];
      const imp = clip.impact!;
      // Wind-up → strike (fast) → recover (slow).
      if (a.time < imp) {
        const t = easeOut(a.time / imp);
        out.rx = lerp(REST.rx, a.state === 'harvest' ? 1.1 : 0.9, t); // raise
        out.y = REST.y + 0.08 * t;
      } else {
        const t = clamp01((a.time - imp) / (clip.duration - imp));
        const strike = Math.min(1, t * 4); // first quarter of the recovery is the hit
        out.rx = lerp(a.state === 'harvest' ? 1.1 : 0.9, -0.9, strike) + (REST.rx + 0.9) * easeIn(Math.max(0, (t - 0.25) / 0.75));
        out.z = REST.z - 0.12 * (1 - t);
        out.x = REST.x - 0.1 * (1 - t);
      }
      break;
    }
    case 'throw': {
      const clip = CLIPS.throw;
      if (a.time < clip.impact!) {
        const t = easeOut(a.time / clip.impact!);
        out.z = REST.z + 0.18 * t; // pull back
        out.y = REST.y + 0.12 * t;
        out.rx = lerp(REST.rx, -0.3, t);
      } else {
        // Spear has left the hand: the empty hand follows through and drops.
        out.visible = false;
      }
      break;
    }
  }
  return out;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
function easeOut(t: number): number {
  const c = clamp01(t);
  return 1 - (1 - c) * (1 - c);
}
function easeIn(t: number): number {
  const c = clamp01(t);
  return c * c;
}
