import type * as THREE from 'three';
import type { Entity, System, World } from '../core/ecs/World';
import { AIBrain, Creature, Transform, type ApexState } from '../components';
import { BEAR } from '../systems/ai/ApexSystem';
import { RenderObject } from './Renderer';

interface Pose {
  /** Pivot by name, found once per model. */
  p: Map<string, THREE.Object3D>;
  phase: number;
  speed: number;
  t: number;
  /** Smoothed blend weights (sleep, rear, swim…). */
  w: Record<string, number>;
}

const CROC_PIVOTS = ['spine', 'neck', 'head', 'jaw', 'tailRoot', 'tail0', 'tail1', 'tail2', 'tail3', 'tail4', 'tail5', 'legFL', 'legFR', 'legBL', 'legBR'];
const BEAR_PIVOTS = ['spine', 'neck', 'head', 'jaw', 'tail', 'legFL', 'legFR', 'legBL', 'legBR'];
const LEGS = ['legFL', 'legFR', 'legBL', 'legBR'] as const;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (x: number): number => x * x * (3 - 2 * x);

/**
 * Procedural skeletal animation for the crocodile and the bear
 * (ApexModels.ts), driven by their behaviour mode and real ground speed.
 *
 * Crocodile: swimming is a travelling wave down the 6 tail segments with
 * the legs folded back along the body; on land it high-walks with a
 * diagonal gait and an S-bend of the spine; it lurks almost motionless,
 * opens its jaws as it lunges and snaps and shakes its head when it bites.
 *
 * Bear: lateral-sequence walk, a bounding gallop with spine flex when it
 * charges, breathing; lies down to sleep with its head on its paws; rears
 * up on its hind legs to roar (jaw open, head shaking); swipes with a paw.
 */
export class ApexAnimation implements System {
  readonly name = 'apex-animation';
  private readonly poses = new Map<Entity, Pose>();

  constructor(private readonly waterLevel: number) {}

  update(world: World, dt: number): void {
    for (const e of world.query(Creature, Transform, RenderObject)) {
      const c = world.require(e, Creature);
      if (c.species !== 'crocodile' && c.species !== 'bear') continue;
      const obj = world.require(e, RenderObject).object;
      if (!obj.visible) continue;
      let pose = this.poses.get(e);
      if (!pose) {
        const p = new Map<string, THREE.Object3D>();
        obj.traverse((o) => {
          if (o.name && !p.has(o.name)) p.set(o.name, o);
        });
        for (const n of c.species === 'crocodile' ? CROC_PIVOTS : BEAR_PIVOTS) if (!p.has(n)) console.warn(`[ApexAnimation] ${c.species}: missing pivot ${n}`);
        pose = { p, phase: e, speed: 0, t: e * 0.37, w: {} };
        this.poses.set(e, pose);
      }
      const t = world.require(e, Transform);
      const raw = Math.hypot(t.position.x - t.prevPosition.x, t.position.z - t.prevPosition.z) * 60;
      pose.speed += (raw - pose.speed) * Math.min(1, dt * 6);
      pose.t += dt;
      const apex = world.get(e, AIBrain)?.blackboard.apex;
      if (!apex) continue;
      if (c.species === 'crocodile') this.croc(pose, apex, t.position.y < this.waterLevel - 0.25, dt);
      else this.bear(pose, apex, dt);
    }
    for (const e of this.poses.keys()) if (!world.has(e, Creature)) this.poses.delete(e);
  }

  // ---- crocodile -------------------------------------------------------------

  private croc(P: Pose, a: ApexState, swimming: boolean, dt: number): void {
    const p = P.p;
    const k = 1 - Math.exp(-dt * 10);
    const ease = (o: THREE.Object3D | undefined, axis: 'x' | 'y' | 'z', v: number, kk = k): void => {
      if (o) o.rotation[axis] += (v - o.rotation[axis]) * kk;
    };
    const w = P.w;
    w['swim'] = (w['swim'] ?? 1) + ((swimming ? 1 : 0) - (w['swim'] ?? 1)) * Math.min(1, dt * 4);
    const sw = w['swim'];
    const v = P.speed;

    // Tail wave frequency rises with speed; on land the stride drives it.
    P.phase += dt * (swimming ? 1.2 + v * 1.6 : 0.5 + v * 3.2);
    const ph = P.phase;
    const lurk = a.mode === 'lurk' ? 1 : 0;
    const intensity = swimming ? Math.min(1, 0.2 + v / 2.5) * (1 - lurk * 0.7) : Math.min(1, v / 2);

    // ---- spine S-curve and tail wave
    ease(p.get('spine'), 'y', Math.sin(ph) * (0.05 * sw + 0.12 * (1 - sw)) * intensity);
    ease(p.get('neck'), 'y', -Math.sin(ph) * (0.06 * sw + 0.1 * (1 - sw)) * intensity); // keeps the head steady
    for (let i = 0; i < 6; i++) {
      const amp = (0.1 + 0.075 * i) * (0.4 + 0.6 * sw) * intensity + (a.mode === 'lunge' ? 0.08 * i : 0);
      ease(p.get(`tail${i}`), 'y', Math.sin(ph - (i + 1) * 0.7) * amp);
      ease(p.get(`tail${i}`), 'x', swimming ? 0 : 0.02 * i); // on land the tail drags, curving down a little
    }

    // ---- legs: tucked along the body when swimming, diagonal high-walk on land
    LEGS.forEach((name, i) => {
      const leg = p.get(name);
      const knee = leg?.children.find((o) => o.name === 'knee');
      const side = name.endsWith('L') ? 1 : -1;
      const front = i < 2;
      const lp = i === 0 || i === 3 ? 0 : Math.PI;
      const swing = Math.sin(ph + lp) * 0.55 * Math.min(1, v / 1.5 + 0.05);
      const lift = Math.max(0, Math.cos(ph + lp)) * 0.4 * Math.min(1, v / 1.5);
      const tuckY = (front ? 1.15 : 1.3) * side;
      ease(leg, 'y', (side * swing) * (1 - sw) + tuckY * sw);
      ease(leg, 'z', side * (lift * (1 - sw) + 0.25 * sw - 0.05));
      ease(knee, 'x', 1.3 * sw + 0.15 * (1 - sw));
    });

    // ---- head and jaw
    let jaw = 0, headX = 0, headY = 0;
    if (a.mode === 'lunge') {
      jaw = 0.75 * smooth(clamp01(a.t / 0.35));
      headX = -0.22;
    } else if (a.mode === 'bite') {
      jaw = a.t < 0.08 ? 0.75 * (1 - a.t / 0.08) : 0; // SNAP
      headY = Math.sin(a.t * 26) * 0.35 * (1 - clamp01(a.t / 0.7)); // shake
      headX = -0.1;
    } else if (a.mode === 'stalk') {
      jaw = 0.04;
    } else if (a.mode === 'lurk') {
      headX = Math.sin(P.t * 0.6) * 0.03;
      jaw = Math.max(0, Math.sin(P.t * 0.21) - 0.92) * 2.5; // the odd lazy gape
    } else if (!swimming && v < 0.2) {
      jaw = 0.35 + Math.sin(P.t * 0.4) * 0.05; // basking with its mouth open
    }
    ease(p.get('jaw'), 'x', jaw, a.mode === 'bite' ? 1 : k);
    ease(p.get('head'), 'x', headX);
    ease(p.get('head'), 'y', headY, a.mode === 'bite' ? 1 : k);
  }

  // ---- bear -------------------------------------------------------------------

  private bear(P: Pose, a: ApexState, dt: number): void {
    const p = P.p;
    const k = 1 - Math.exp(-dt * 9);
    const w = P.w;
    const blend = (name: string, target: number, rate: number): number => {
      w[name] = (w[name] ?? 0) + (target - (w[name] ?? 0)) * Math.min(1, dt * rate);
      return w[name]!;
    };
    const sleep = blend('sleep', a.mode === 'sleep' ? 1 : 0, 1.5);
    let rearT = 0;
    if (a.mode === 'roar') {
      const t = a.t;
      rearT = t < 0.5 ? smooth(t / 0.5) : t < BEAR.roarTime - 0.45 ? 1 : smooth(clamp01((BEAR.roarTime - t) / 0.45));
    }
    const rear = blend('rear', rearT, 14);
    const v = P.speed;
    const run = clamp01((v - 2.2) / 3);
    const walk = clamp01(v / 1.2) * (1 - run);
    P.phase += dt * (v / (1.1 + run * 0.7)) * Math.PI;
    const ph = P.phase;

    const set = (name: string, axis: 'x' | 'y' | 'z', val: number, kk = k): void => {
      const o = p.get(name);
      if (o) o.rotation[axis] += (val - o.rotation[axis]) * kk;
    };
    const spine = p.get('spine');

    // ---- body: breathing, gallop flex, rearing up, lying down
    const breathe = Math.sin(P.t * (sleep > 0.5 ? 0.9 : 1.8)) * (sleep > 0.5 ? 0.035 : 0.015);
    if (spine) {
      spine.scale.set(1 + breathe * 0.6, 1 + breathe, 1);
      spine.position.y = 0.86 - sleep * 0.42 + Math.abs(Math.sin(ph)) * 0.05 * run;
    }
    set('spine', 'x', -rear * 1.08 + Math.sin(ph * 2) * 0.07 * run + sleep * 0.08);

    // ---- legs
    const gait = run > 0.5 ? { legFL: 0, legFR: 0.35, legBL: Math.PI, legBR: Math.PI + 0.35 } : { legBL: 0, legFL: Math.PI / 2, legBR: Math.PI, legFR: Math.PI * 1.5 };
    const swipe = a.mode === 'swipe' ? a.t / BEAR.swipeTime : -1;
    for (const name of LEGS) {
      const front = name.startsWith('legF');
      const lp = gait[name];
      const amp = 0.45 * walk + 0.75 * run;
      let upper = Math.sin(ph + lp) * amp;
      let lower = Math.max(0, Math.sin(ph + lp + Math.PI / 2)) * amp * 1.3;
      // Lying down: forelegs stretched forward on the ground, hind legs folded under.
      upper = upper * (1 - sleep) + (front ? -1.35 : 1.25) * sleep;
      lower = lower * (1 - sleep) + (front ? 0.2 : -2.0) * sleep;
      if (front && rear > 0) {
        // Reared up: forelegs reach forward, paws curled, flailing a little.
        upper = upper * (1 - rear) + rear * (1.0 + Math.sin(P.t * 5 + (name === 'legFL' ? 0 : 1.7)) * 0.25);
        lower = lower * (1 - rear) + rear * 0.9;
      }
      if (!front && rear > 0) {
        upper = upper * (1 - rear) - rear * 0.35; // hind legs bend to take the weight
        lower = lower * (1 - rear) + rear * 0.45;
      }
      if (swipe >= 0 && name === 'legFL') {
        // Raise the paw high and forward, then strike down and across.
        const s = swipe < 0.45 ? smooth(swipe / 0.45) : 1 - smooth(clamp01((swipe - 0.45) / 0.3));
        upper = -1.6 * s + (swipe > 0.45 ? 0.5 * (1 - s) : 0);
        lower = 0.6 * s;
        set(name, 'z', -0.35 * s);
      } else set(name, 'z', 0);
      set(name, 'x', upper, swipe >= 0 && name === 'legFL' ? 1 - Math.exp(-dt * 30) : k);
      if (!front) { const hip = p.get(name); if (hip) hip.position.y = 0.82 - sleep * 0.4; } // hips drop when lying down
      const lo = p.get(name)?.children.find((o) => o.name === 'lower');
      if (lo) lo.rotation.x += (lower - lo.rotation.x) * k;
    }

    // ---- neck, head, jaw
    let neckX = -run * 0.15 + Math.sin(ph * 2) * 0.05 * (walk + run);
    let headX = 0, headY = 0, jaw = 0;
    if (sleep > 0) {
      neckX = neckX * (1 - sleep) + 0.55 * sleep; // chin down on the paws
      headX = 0.25 * sleep;
    }
    if (rear > 0) {
      neckX = neckX * (1 - rear) + 0.85 * rear; // keep looking at you while upright
      const roaring = a.mode === 'roar' && a.t > 0.4 && a.t < BEAR.roarTime - 0.3;
      jaw = roaring ? 0.75 + Math.sin(P.t * 9) * 0.08 : 0;
      headY = roaring ? Math.sin(P.t * 7) * 0.22 : 0;
      headX = -0.25 * rear;
    }
    if (a.mode === 'charge') jaw = 0.25 + Math.sin(P.t * 6) * 0.05;
    if (a.mode === 'swipe') jaw = 0.55;
    if (a.mode === 'wake') headY = Math.sin(P.t * 3) * 0.2;
    if (a.mode === 'sleep' || a.mode === 'home' || a.mode === 'roam') headY = Math.sin(P.t * 0.5) * 0.12 * (1 - sleep);
    set('neck', 'x', neckX);
    set('head', 'x', headX);
    set('head', 'y', headY);
    set('jaw', 'x', jaw);
    set('tail', 'y', Math.sin(P.t * 2) * 0.1 * (walk + run));
  }
}
