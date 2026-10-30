import type { Entity, System, World } from '../../core/ecs/World';
import type { EventBus } from '../../core/EventBus';
import {
  AIBrain, Creature, HeatSource, PlayerControlled, SurvivorC, Transform, type AIState, type Blackboard,
} from '../../components';
import type { Vec3 } from '../../data/schema';
import type { DayNightCycle } from '../DayNightCycle';
import type { SurvivalStatusManager } from '../SurvivalStatusManager';
import { Action, Condition, Selector, Sequence, type BTContext, type BTNode, type BTStatus } from './BehaviorTree';
import type { PathProvider } from './nav/FlowFieldService';
import { wrapAngle } from './PerceptionSystem';

export interface AIServices {
  groundHeight: (x: number, z: number) => number;
  /** Navigation. The AI only ever asks "which way to X?" — see nav/FlowFieldService.ts. */
  paths: PathProvider;
  cycle: DayNightCycle;
  survival: SurvivalStatusManager;
  events: EventBus;
  /** Resolved once per tick. */
  player: Entity | undefined;
}

type Ctx = BTContext<AIServices>;

const TURN_RATE = 4; // rad/s
const HUNT_MEMORY = 20; // seconds a lead stays "fresh"
const SEARCH_DURATION = 8;
const FLEE_MIN_TIME = 4;
const FLEE_SAFE_DISTANCE = 35;
const FIRE_FEAR_MARGIN = 3;
const STUCK_GIVE_UP = 2.5; // seconds without progress → treat the target as reached

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

const cr = (c: Ctx): Creature => c.world.require(c.entity, Creature);
const pos = (c: Ctx): Vec3 => c.world.require(c.entity, Transform).position;
const playerPos = (c: Ctx): Vec3 | null =>
  c.services.player !== undefined ? c.world.require(c.services.player, Transform).position : null;
const playerAlive = (c: Ctx): boolean =>
  c.services.player !== undefined && c.world.require(c.services.player, SurvivorC).alive;

const isHurt = new Condition<AIServices>('hurt', (c) => cr(c).health < cr(c).maxHealth * cr(c).fleeHealthFraction);

/** Prey bolt as soon as they are reasonably sure the player is there. */
const preySpooked = new Condition<AIServices>('prey-spooked', (c) => {
  const k = cr(c);
  return k.temperament === 'prey' && k.perception.awareness > 0.5 && k.perception.lastKnownAge < 5;
});

/** At night, predators will not step into firelight. */
const nearFireAtNight = new Condition<AIServices>('fire-at-night', (c) => {
  if (cr(c).temperament !== 'predator' || !c.services.cycle.isNight) return false;
  const p = pos(c);
  for (const f of c.world.query(HeatSource, Transform)) {
    const h = c.world.require(f, HeatSource);
    if (!h.lit || !h.scaresCreatures) continue;
    const fp = c.world.require(f, Transform).position;
    if (Math.hypot(fp.x - p.x, fp.z - p.z) < h.radius + FIRE_FEAR_MARGIN) {
      c.bb.fleeFrom = { x: fp.x, y: fp.y, z: fp.z };
      return true;
    }
  }
  return false;
});

const stillFleeing = new Condition<AIServices>('still-fleeing', (c) => c.bb.fleeTimer > 0);

const seesPlayer = new Condition<AIServices>('sees-player', (c) => {
  const k = cr(c);
  return k.temperament !== 'prey' && playerAlive(c) && k.perception.canSeeTarget && k.perception.awareness >= 1;
});

const hasFreshLead = new Condition<AIServices>('has-lead', (c) => {
  const k = cr(c);
  return k.temperament === 'predator' && k.perception.lastKnownTargetPos !== null && k.perception.lastKnownAge < HUNT_MEMORY;
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const flee = new Action<AIServices>('flee', (c) => {
  setState(c, 'flee');
  const k = cr(c);
  const p = pos(c);
  const threat = c.bb.fleeFrom ?? k.perception.lastKnownTargetPos ?? playerPos(c);
  if (c.bb.fleeTimer <= 0) c.bb.fleeTimer = FLEE_MIN_TIME;
  c.bb.fleeTimer -= c.dt;
  if (!threat) return 'success';
  const dx = p.x - threat.x, dz = p.z - threat.z;
  const d = Math.hypot(dx, dz) || 1;
  if (d > FLEE_SAFE_DISTANCE && c.bb.fleeTimer <= 0) {
    c.bb.fleeFrom = null;
    return 'success';
  }
  // Run away from the threat; if that direction is blocked (cliff, lake,
  // trunk wall), try progressively wider angles so prey doesn't pin itself.
  const ax = dx / d, az = dz / d;
  for (const ang of FLEE_ANGLES) {
    const cos = Math.cos(ang), sin = Math.sin(ang);
    const tx = p.x + (ax * cos - az * sin) * 10, tz = p.z + (ax * sin + az * cos) * 10;
    if (c.services.paths.isWalkable(tx, tz)) {
      steer(c, tx, tz, k.runSpeed);
      return 'running';
    }
  }
  steer(c, p.x + ax * 10, p.z + az * 10, k.runSpeed);
  return 'running';
});
const FLEE_ANGLES = [0, 0.6, -0.6, 1.2, -1.2, 1.9, -1.9] as const;

const chase = new Action<AIServices>('chase', (c) => {
  const k = cr(c);
  const p = pos(c);
  const target = playerPos(c);
  if (!target || c.services.player === undefined) return 'failure';
  const d = Math.hypot(target.x - p.x, target.z - p.z);
  k.attackTimer = Math.max(0, k.attackTimer - c.dt);

  if (d <= k.attackRange) {
    setState(c, 'attack');
    face(c, target.x, target.z);
    if (k.attackTimer === 0) {
      k.attackTimer = k.attackCooldown;
      const s = c.world.require(c.services.player, SurvivorC);
      s.vitals.health = Math.max(0, s.vitals.health - k.attackDamage);
      // Bites have a chance to cause bleeding; the status manager owns the effect.
      if (rand(c.bb) < 0.35) c.services.survival.applyEffect(s, 'bleeding', 20, 'combat');
    }
    return 'running';
  }
  setState(c, 'chase');
  steer(c, target.x, target.z, k.runSpeed);
  return 'running';
});

/**
 * Hunt = investigate. Walk (quietly, at stalking speed) to the last known
 * position, then search random points around it until the lead goes stale.
 */
const hunt = new Action<AIServices>('hunt', (c) => {
  setState(c, 'hunt');
  const k = cr(c);
  const p = pos(c);
  const lead = k.perception.lastKnownTargetPos!;
  if (!c.bb.searchPoint) {
    c.bb.searchPoint = { ...lead };
    c.bb.searchTimer = SEARCH_DURATION;
    c.bb.stuckTimer = 0;
  }
  const sp = c.bb.searchPoint;
  const arrived = Math.hypot(sp.x - p.x, sp.z - p.z) < 1.5 || c.bb.stuckTimer > STUCK_GIVE_UP;
  if (!arrived) {
    steer(c, sp.x, sp.z, (k.walkSpeed + k.runSpeed) * 0.4);
    return 'running';
  }
  c.bb.stuckTimer = 0;
  c.bb.searchTimer -= c.dt;
  if (c.bb.searchTimer <= 0) {
    // Lead exhausted: forget it and fall back to patrol.
    k.perception.lastKnownTargetPos = null;
    c.bb.searchPoint = null;
    return 'failure';
  }
  // Sniff around: pick a new nearby point every couple of seconds.
  if (c.bb.searchTimer % 2.5 < c.dt) {
    const a = rand(c.bb) * Math.PI * 2;
    c.bb.searchPoint = { x: lead.x + Math.cos(a) * 6, y: lead.y, z: lead.z + Math.sin(a) * 6 };
  }
  return 'running';
});

const patrol = new Action<AIServices>('patrol', (c) => {
  setState(c, 'patrol');
  const k = cr(c);
  const p = pos(c);
  const bb = c.bb;
  bb.searchPoint = null;
  if (bb.waypoints.length === 0) return 'success';
  if (bb.idleTimer > 0) {
    bb.idleTimer -= c.dt;
    return 'running';
  }
  const wp = bb.waypoints[bb.waypointIndex % bb.waypoints.length]!;
  if (Math.hypot(wp.x - p.x, wp.z - p.z) < 1 || bb.stuckTimer > STUCK_GIVE_UP) {
    bb.stuckTimer = 0;
    bb.waypointIndex = (bb.waypointIndex + 1) % bb.waypoints.length;
    bb.idleTimer = 1 + rand(bb) * 3;
    return 'running';
  }
  steer(c, wp.x, wp.z, k.walkSpeed);
  return 'running';
});

// ---------------------------------------------------------------------------
// Trees (shared, stateless). Priority order = top to bottom.
// ---------------------------------------------------------------------------

export const BEHAVIOR_TREES: Readonly<Record<string, BTNode<AIServices>>> = {
  predator: new Selector('root', [
    new Sequence('flee', [new Selector('flee?', [isHurt, nearFireAtNight, stillFleeing]), flee]),
    new Sequence('chase', [seesPlayer, chase]),
    new Sequence('hunt', [hasFreshLead, hunt]),
    patrol,
  ]),
  prey: new Selector('root', [
    new Sequence('flee', [new Selector('flee?', [isHurt, preySpooked, stillFleeing]), flee]),
    patrol,
  ]),
};

/**
 * Runs each creature's tree, then snaps it to the terrain. Creatures are
 * kinematic (no Cannon body) but never move into a cell the nav grid marks
 * blocked, so they path around trunks instead of clipping through them.
 * Dormant creatures (AILodSystem) are skipped entirely, state intact.
 */
export class AISystem implements System {
  readonly name = 'ai';

  constructor(private readonly services: Omit<AIServices, 'player'>) {}

  fixedUpdate(world: World, dt: number): void {
    const services: AIServices = { ...this.services, player: world.first(PlayerControlled, SurvivorC, Transform) };
    services.paths.beginTick();
    for (const e of world.query(AIBrain, Creature, Transform)) {
      const brain = world.require(e, AIBrain);
      const k = world.require(e, Creature);
      const t = world.require(e, Transform);
      if (k.health <= 0) continue;
      if (brain.lod === 'dormant') {
        // Keep prev == current so the renderer doesn't keep blending a stale step.
        copyVec(t.prevPosition, t.position);
        continue;
      }
      const tree = BEHAVIOR_TREES[brain.tree];
      if (!tree) continue;

      // Snapshot for render interpolation (see RenderSyncSystem).
      copyVec(t.prevPosition, t.position);
      t.prevRotation.x = t.rotation.x;
      t.prevRotation.y = t.rotation.y;
      t.prevRotation.z = t.rotation.z;
      t.prevRotation.w = t.rotation.w;

      const ctx: Ctx = { world, entity: e, bb: brain.blackboard, dt, services };
      const before = brain.blackboard.state;
      tree.tick(ctx);
      if (brain.blackboard.state !== before) {
        services.events.emit('ai:state-changed', { entity: e, from: before, to: brain.blackboard.state });
      }

      t.position.y = services.groundHeight(t.position.x, t.position.z);
      // Yaw-only quaternion from heading.
      t.rotation.x = 0;
      t.rotation.z = 0;
      t.rotation.y = Math.sin(k.heading / 2);
      t.rotation.w = Math.cos(k.heading / 2);
    }
  }
}

export function makeBlackboard(home: Vec3, waypoints: Vec3[], seed: number): Blackboard {
  return {
    state: 'patrol', home, waypoints, waypointIndex: 0, idleTimer: 0,
    searchPoint: null, searchTimer: 0, fleeTimer: 0, fleeFrom: null, rngState: seed >>> 0, stuckTimer: 0,
  };
}

// ---------------------------------------------------------------------------

function setState(c: Ctx, s: AIState): void {
  c.bb.state = s;
}

function face(c: Ctx, tx: number, tz: number): void {
  const k = cr(c);
  const p = pos(c);
  const desired = Math.atan2(tx - p.x, tz - p.z);
  const diff = wrapAngle(desired - k.heading);
  const maxTurn = TURN_RATE * c.dt;
  k.heading = wrapAngle(k.heading + Math.max(-maxTurn, Math.min(maxTurn, diff)));
}

const steerDir = { x: 0, z: 0 };

/**
 * Ask the path provider which way to go, turn toward that direction, then
 * move along the current heading (no strafing). The move is rejected — or
 * slid along one axis — if it would enter a blocked nav cell.
 */
function steer(c: Ctx, tx: number, tz: number, speed: number): BTStatus {
  const p = pos(c);
  const k = cr(c);
  if (!c.services.paths.steer(p.x, p.z, tx, tz, steerDir)) {
    // No route this tick (unreachable, or field build deferred): hold position.
    c.bb.stuckTimer += c.dt;
    return 'running';
  }
  face(c, p.x + steerDir.x, p.z + steerDir.z);
  // Slow down while turning sharply so creatures arc instead of sliding.
  const diff = Math.abs(wrapAngle(Math.atan2(steerDir.x, steerDir.z) - k.heading));
  const s = speed * Math.max(0.25, Math.cos(Math.min(diff, Math.PI / 2)));
  const nx = p.x + Math.sin(k.heading) * s * c.dt;
  const nz = p.z + Math.cos(k.heading) * s * c.dt;
  const paths = c.services.paths;
  const before = Math.hypot(tx - p.x, tz - p.z);
  if (paths.isWalkable(nx, nz)) {
    p.x = nx;
    p.z = nz;
  } else if (paths.isWalkable(nx, p.z)) {
    p.x = nx;
  } else if (paths.isWalkable(p.x, nz)) {
    p.z = nz;
  }
  // Progress tracking lets patrol/hunt give up on unreachable points.
  const progressed = before - Math.hypot(tx - p.x, tz - p.z);
  c.bb.stuckTimer = progressed > s * c.dt * 0.1 ? 0 : c.bb.stuckTimer + c.dt;
  return 'running';
}

/** Deterministic per-creature RNG stored on the blackboard. */
function rand(bb: Blackboard): number {
  // Inline mulberry32 step: no closure allocation on the AI hot path.
  bb.rngState = (bb.rngState + 0x6d2b79f5) >>> 0;
  let t = bb.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function copyVec(out: Vec3, v: Vec3): void {
  out.x = v.x;
  out.y = v.y;
  out.z = v.z;
}

export type { BTStatus };
