import { itemDef } from '../../data/items';
import type { Entity, System, World } from '../../core/ecs/World';
import type { EventBus } from '../../core/EventBus';
import type { SpatialHash } from '../../core/SpatialHash';
import {
  AIBrain, Creature, HeatSource, PlayerControlled, ResourceC, SurvivorC, Transform, type AIState, type Blackboard,
} from '../../components';
import type { Vec3 } from '../../data/schema';
import type { DayNightCycle } from '../DayNightCycle';
import type { SurvivalStatusManager } from '../SurvivalStatusManager';
import { Action, Condition, Selector, Sequence, type BTContext, type BTNode, type BTStatus } from './BehaviorTree';
import { ECOLOGY, biteResource, ecoState, isEater, killCreature, nearestFood } from './Ecology';
import type { PathProvider } from './nav/FlowFieldService';
import { wrapAngle } from './PerceptionSystem';

export interface AIServices {
  groundHeight: (x: number, z: number) => number;
  /** Navigation. The AI only ever asks "which way to X?" — see nav/FlowFieldService.ts. */
  paths: PathProvider;
  cycle: DayNightCycle;
  survival: SurvivalStatusManager;
  events: EventBus;
  /** Harvestables by position: what deer and boars eat, and carcasses (tests may leave it out: no food). */
  resources?: SpatialHash;
  /** Wolves leave deer alone at or below this many (see deerRefuge()); default ECOLOGY.minRefuge. */
  deerRefuge?: number;
  /** Resolved once per tick. */
  player: Entity | undefined;
  /** Live deer, what wolves hunt (deer and piglets), piglets alone, and wolves: gathered once per tick. */
  deer: Entity[];
  prey: Entity[];
  piglets: Entity[];
  wolves: Entity[];
}

type Ctx = BTContext<AIServices>;

const TURN_RATE = 4; // rad/s
const HUNT_MEMORY = 20; // seconds a lead stays "fresh"
const SEARCH_DURATION = 8;
const FLEE_MIN_TIME = 4;
const FLEE_SAFE_DISTANCE = 35;
const FIRE_FEAR_MARGIN = 3;
const STUCK_GIVE_UP = 2.5; // seconds without progress → treat the target as reached
const EAT_REACH = 1.7;
/** Seconds of walking toward food before deciding it's out of reach. */
const TRAVEL_GIVE_UP = 25;
/** Off-screen, far-away animals think 1 tick in DORMANT_EVERY (with a longer dt), so the food chain goes on everywhere. */
const DORMANT_EVERY = 4;

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

/** A deer (or piglet) that sees a wolf coming (close, or running at it) bolts. */
const predatorNear = new Condition<AIServices>('predator-near', (c) => {
  const k = cr(c);
  if (k.species !== 'deer' && !(k.species === 'boar' && k.growth !== undefined)) return false;
  const p = pos(c);
  let best = Infinity, from: Vec3 | null = null;
  for (const w of c.services.wolves) {
    const wbb = c.world.require(w, AIBrain).blackboard;
    const wp = c.world.require(w, Transform).position;
    const d = Math.hypot(wp.x - p.x, wp.z - p.z);
    const running = wbb.state === 'stalk' && d < ECOLOGY.wolf.sprintAt + 1;
    if (d < (running ? ECOLOGY.notice.running : ECOLOGY.notice.walking) && d < best) {
      best = d;
      from = wp;
    }
  }
  if (!from) return false;
  c.bb.fleeFrom = { x: from.x, y: from.y, z: from.z };
  return true;
});

/** Hungry, or already eating and not full yet (so it doesn't stop after one bite). */
const hungry = new Condition<AIServices>('hungry', (c) => {
  const k = cr(c);
  if (!isEater(k.species) || !c.services.resources) return false;
  const tune = ECOLOGY[k.species];
  const food = ecoState(c.world, c.entity).food;
  const busy = c.bb.state === 'graze' || c.bb.state === 'feed' || c.bb.state === 'stalk';
  return food < (busy ? tune.full : tune.hungry);
});

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
  // Prey tire: a sprint can't last (that's how wolves catch deer).
  let speed = k.runSpeed;
  if (isEater(k.species)) {
    const eco = ecoState(c.world, c.entity), st = ECOLOGY.stamina;
    eco.tired += c.dt;
    speed *= Math.max(st.min, 1 - Math.max(0, eco.tired - st.fresh) * st.fade) * (eco.food === 0 ? 0.8 : 1);
  }
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
      steer(c, tx, tz, speed);
      return 'running';
    }
  }
  steer(c, p.x + ax * 10, p.z + az * 10, speed);
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

  // Vertical gap too: a wolf under the floor of your house can't bite you through it.
  if (d <= k.attackRange && Math.abs(target.y - p.y) < 1.6) {
    setState(c, 'attack');
    face(c, target.x, target.z);
    if (k.attackTimer === 0) {
      k.attackTimer = k.attackCooldown;
      const s = c.world.require(c.services.player, SurvivorC);
      // Armour absorbs part of the bite (Flak halves it) and makes bleeding rarer.
      const armor = s.equipped.body ? (itemDef(s.equipped.body.item).wearable?.armor ?? 0) : 0;
      const dmg = k.attackDamage * (1 - armor);
      s.vitals.health = Math.max(0, s.vitals.health - dmg);
      c.services.events.emit('player:damaged', { entity: c.services.player, amount: dmg, source: k.species });
      // Bites have a chance to cause bleeding; the status manager owns the effect.
      if (rand(c.bb) < 0.35 * (1 - armor)) c.services.survival.applyEffect(s, 'bleeding', 20, 'combat');
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

/**
 * Deer and boars: walk to the nearest ripe plant of their diet and eat it,
 * bite by bite, until full or it's bare. With nothing in reach they wander
 * off to look elsewhere. Their patrol range follows the food they find.
 */
const graze = new Action<AIServices>('graze', (c) => {
  const k = cr(c);
  if (k.species !== 'deer' && k.species !== 'boar') return 'failure';
  const tune = ECOLOGY[k.species];
  const eco = ecoState(c.world, c.entity);
  const p = pos(c);
  const r = eco.target !== null ? c.world.get(eco.target, ResourceC) : undefined;
  if (!r || r.hitPoints <= 0 || !tune.diet.includes(r.kind)) {
    if (c.bb.state === 'graze' && c.bb.searchPoint && !lookAround(c)) return wander(c, k.walkSpeed);
    eco.target = nearestFood(c.world, c.services.resources!, p.x, p.z, tune.search, tune.diet, eco.skip ?? null);
    if (eco.target === null) return wander(c, k.walkSpeed);
    c.bb.stuckTimer = 0;
    c.bb.searchPoint = null;
    eco.biteTimer = 0;
    return 'running';
  }
  return eatAt(c, r.position, k.walkSpeed, tune.biteSeconds, tune.perBite, tune.full);
});

/**
 * Hungry wolves: eat a carcass they can smell; otherwise pick the nearest
 * deer, creep up at walking pace and sprint the last stretch. A chase that
 * drags on is abandoned (the deer got away) and the wolf rests before the
 * next one. A deer killed becomes a carcass, which the wolf then eats —
 * and so can the rest of the pack, or the player.
 */
const forage = new Action<AIServices>('forage', (c) => {
  const k = cr(c);
  if (k.species !== 'wolf') return 'failure'; // boars share the predator tree but graze
  const tune = ECOLOGY.wolf;
  const eco = ecoState(c.world, c.entity);
  const p = pos(c);
  eco.huntRest = Math.max(0, eco.huntRest - c.dt);
  k.attackTimer = Math.max(0, k.attackTimer - c.dt);

  // Current target still good?
  const t = eco.target;
  const carcass = t !== null ? c.world.get(t, ResourceC) : undefined;
  if (carcass && carcass.kind === 'carcass' && carcass.hitPoints > 0) {
    return eatAt(c, carcass.position, k.walkSpeed * 1.6, tune.biteSeconds, tune.perBite, tune.full);
  }
  const prey = t !== null ? c.world.get(t, Creature) : undefined;
  if (prey && (prey.species === 'deer' || prey.species === 'boar') && prey.health > 0 && eco.huntRest === 0) return stalk(c, t!);

  // New target: food first, then a deer (if there are enough of them to find).
  eco.chase = 0;
  if (c.bb.state === 'graze' && c.bb.searchPoint && !lookAround(c)) return wander(c, k.walkSpeed * 1.2);
  eco.target = nearestFood(c.world, c.services.resources!, p.x, p.z, tune.search, CARCASS_DIET, eco.skip ?? null);
  eco.biteTimer = 0;
  if (eco.target === null && eco.huntRest === 0) {
    let best: number = tune.scent;
    for (const d of c.services.deer.length > (c.services.deerRefuge ?? ECOLOGY.minRefuge) ? c.services.prey : c.services.piglets) {
      const dp = c.world.require(d, Transform).position;
      const dist = Math.hypot(dp.x - p.x, dp.z - p.z);
      if (dist < best) { best = dist; eco.target = d; }
    }
  }
  if (eco.target === null) return wander(c, k.walkSpeed * 1.2);
  c.bb.searchPoint = null;
  return 'running';
});
const CARCASS_DIET = ['carcass'] as const;

function stalk(c: Ctx, deer: Entity): BTStatus { // deer, or a piglet
  const k = cr(c);
  const tune = ECOLOGY.wolf;
  const eco = ecoState(c.world, c.entity);
  const p = pos(c);
  const dp = c.world.require(deer, Transform).position;
  const d = Math.hypot(dp.x - p.x, dp.z - p.z);
  setState(c, 'stalk');
  if (d > tune.scent * 1.5) {
    eco.target = null; // lost it
    return 'running';
  }
  if (d > tune.sprintAt && eco.chase === 0) {
    steer(c, dp.x, dp.z, k.walkSpeed * 1.3); // creeping up
    return 'running';
  }
  eco.chase += c.dt;
  if (eco.chase > tune.chaseSeconds) {
    eco.target = null;
    eco.chase = 0;
    eco.huntRest = tune.huntRest;
    return 'running';
  }
  if (d <= k.attackRange + 0.3) {
    face(c, dp.x, dp.z);
    if (k.attackTimer === 0) {
      k.attackTimer = k.attackCooldown;
      const prey = c.world.require(deer, Creature);
      prey.health -= k.attackDamage * tune.biteVsAnimals;
      c.services.events.emit('creature:hit', { entity: deer, amount: k.attackDamage * tune.biteVsAnimals, killed: prey.health <= 0 });
      if (prey.health <= 0) {
        killCreature(c.world, deer, c.services.resources!, c.services.events, 'predator');
        eco.target = deer; // the same entity is now its carcass
        eco.chase = 0;
      }
    }
  }
  steer(c, dp.x, dp.z, k.runSpeed);
  return 'running';
}

/** Walk to `at`, then eat one bite every `biteSeconds` until `full` (or nothing is left). */
function eatAt(c: Ctx, at: Vec3, speed: number, biteSeconds: number, perBite: number, full: number): BTStatus {
  const eco = ecoState(c.world, c.entity);
  const p = pos(c);
  const d = Math.hypot(at.x - p.x, at.z - p.z);
  if (d > EAT_REACH) {
    eco.biteTimer += c.dt; // time spent getting there
    if (c.bb.stuckTimer < STUCK_GIVE_UP && eco.biteTimer < TRAVEL_GIVE_UP) {
      setState(c, 'graze');
      steer(c, at.x, at.z, speed);
      return 'running';
    }
    if (d > EAT_REACH + 1.5) {
      // Can't get there (up a cliff, across water, jittering against a
      // rock): forget it and go look somewhere else.
      eco.skip = eco.target;
      eco.target = null;
      c.bb.stuckTimer = 0;
      c.bb.searchPoint = null;
      return wander(c, speed);
    }
  }
  if (c.bb.state !== 'feed') eco.biteTimer = 0;
  setState(c, 'feed');
  face(c, at.x, at.z);
  eco.biteTimer += c.dt;
  if (eco.biteTimer < biteSeconds) return 'running';
  eco.biteTimer = 0;
  if (eco.target === null || !biteResource(c.world, eco.target, c.services.events)) {
    eco.target = null;
    return 'running';
  }
  eco.food = Math.min(1, eco.food + perBite);
  // Its range drifts toward where the food is.
  const home = c.bb.home, dx = (at.x - home.x) * 0.5, dz = (at.z - home.z) * 0.5;
  home.x += dx;
  home.z += dz;
  for (const w of c.bb.waypoints) {
    w.x += dx;
    w.z += dz;
  }
  if (eco.food >= full) {
    eco.target = null;
    return 'success';
  }
  return 'running';
}

/** While roaming for food, look around about twice a second (searches aren't free). */
function lookAround(c: Ctx): boolean {
  return rand(c.bb) < c.dt * 2;
}

/** Nothing to eat in reach: head somewhere new and look again on arrival. */
function wander(c: Ctx, speed: number): BTStatus {
  setState(c, 'graze');
  const p = pos(c);
  const sp = c.bb.searchPoint;
  if (!sp || Math.hypot(sp.x - p.x, sp.z - p.z) < 2 || c.bb.stuckTimer > STUCK_GIVE_UP) {
    c.bb.stuckTimer = 0;
    for (let i = 0; i < 6; i++) {
      const a = rand(c.bb) * Math.PI * 2, r = 20 + rand(c.bb) * 25;
      const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
      if (c.services.paths.isWalkable(x, z)) {
        c.bb.searchPoint = { x, y: p.y, z };
        break;
      }
    }
    return 'running';
  }
  steer(c, sp.x, sp.z, speed);
  return 'running';
}

// ---------------------------------------------------------------------------
// Trees (shared, stateless). Priority order = top to bottom.
// ---------------------------------------------------------------------------

export const BEHAVIOR_TREES: Readonly<Record<string, BTNode<AIServices>>> = {
  predator: new Selector('root', [
    new Sequence('flee', [new Selector('flee?', [isHurt, nearFireAtNight, stillFleeing]), flee]),
    new Sequence('chase', [seesPlayer, chase]),
    new Sequence('forage', [hungry, forage]),
    new Sequence('graze', [hungry, graze]),
    new Sequence('hunt', [hasFreshLead, hunt]),
    patrol,
  ]),
  prey: new Selector('root', [
    new Sequence('flee', [new Selector('flee?', [isHurt, preySpooked, predatorNear, stillFleeing]), flee]),
    new Sequence('graze', [hungry, graze]),
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

  private tick = 0;
  private readonly deer: Entity[] = [];
  private readonly prey: Entity[] = [];
  private readonly piglets: Entity[] = [];
  private readonly wolves: Entity[] = [];

  constructor(private readonly services: Omit<AIServices, 'player' | 'deer' | 'prey' | 'piglets' | 'wolves'>) {}

  fixedUpdate(world: World, dt: number): void {
    this.deer.length = this.prey.length = this.piglets.length = this.wolves.length = 0;
    for (const e of world.query(AIBrain, Creature, Transform)) {
      const k = world.require(e, Creature);
      if (k.health <= 0) continue;
      if (k.species === 'deer') {
        this.deer.push(e);
        this.prey.push(e);
      } else if (k.species === 'boar' && k.growth !== undefined) {
        this.piglets.push(e); // grown boars fight back; wolves leave them be
        this.prey.push(e);
      } else if (k.species === 'wolf' && k.temperament === 'predator') this.wolves.push(e);
    }
    const services: AIServices = {
      ...this.services, player: world.first(PlayerControlled, SurvivorC, Transform),
      deer: this.deer, prey: this.prey, piglets: this.piglets, wolves: this.wolves,
    };
    services.paths.beginTick();
    this.tick++;
    for (const e of world.query(AIBrain, Creature, Transform)) {
      const brain = world.require(e, AIBrain);
      const k = world.require(e, Creature);
      const t = world.require(e, Transform);
      if (k.health <= 0) continue;
      let step = dt;
      if (brain.lod === 'dormant') {
        // Keep prev == current so the renderer doesn't keep blending a stale step.
        copyVec(t.prevPosition, t.position);
        // Off-screen and far: think at a quarter of the rate (staggered), so
        // animals still eat, hunt and wander where the player isn't looking.
        if ((this.tick + e) % DORMANT_EVERY !== 0) continue;
        step = dt * DORMANT_EVERY;
      }
      const tree = BEHAVIOR_TREES[brain.tree];
      if (!tree) continue;
      const eco = brain.blackboard.eco;
      if (eco && brain.blackboard.state !== 'flee') eco.tired = Math.max(0, eco.tired - step * ECOLOGY.stamina.recover);

      // Snapshot for render interpolation (see RenderSyncSystem).
      copyVec(t.prevPosition, t.position);
      t.prevRotation.x = t.rotation.x;
      t.prevRotation.y = t.rotation.y;
      t.prevRotation.z = t.rotation.z;
      t.prevRotation.w = t.rotation.w;

      const ctx: Ctx = { world, entity: e, bb: brain.blackboard, dt: step, services };
      const before = brain.blackboard.state;
      tree.tick(ctx);
      if (!world.has(e, Creature)) continue; // starved or killed this tick
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
