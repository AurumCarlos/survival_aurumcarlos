/**
 * Headless balance + correctness run. No browser, no GPU: exercises the
 * engine-free core (ECS, game loop, survival, crafting, AI, terrain) exactly
 * as the game runs it. `npm run sim`
 */
import { AIBrain, Creature, StealthState, SurvivorC, Transform } from '../src/components';
import { World } from '../src/core/ecs/World';
import { EventBus } from '../src/core/EventBus';
import { GameLoop, type FrameScheduler } from '../src/core/GameLoop';
import { ObjectPool } from '../src/core/ObjectPool';
import type { Activity } from '../src/data/schema';
import { spawnCampfire, spawnCreature, spawnLeanTo, spawnPlayer } from '../src/entities/factories';
import { AISystem } from '../src/systems/ai/AISystem';
import { NoiseBus } from '../src/systems/ai/NoiseBus';
import { straightLinePaths } from '../src/systems/ai/nav/FlowFieldService';
import { PerceptionSystem } from '../src/systems/ai/PerceptionSystem';
import { DayNightCycle, DEFAULT_DAY_NIGHT } from '../src/systems/DayNightCycle';
import { EnvironmentSystem } from '../src/systems/EnvironmentSystem';
import { CraftingEngine } from '../src/systems/inventory/CraftingEngine';
import { InventoryGrid } from '../src/systems/inventory/InventoryGrid';
import { SurvivalSystem } from '../src/systems/SurvivalSystem';
import { generateTerrain } from '../src/world/TerrainGenerator';

declare const process: { exit(code: number): never };

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Manual clock: the loop never touches real time. */
function manualScheduler(): FrameScheduler & { t: number } {
  return { t: 0, now() { return this.t; }, request: () => 0, cancel: () => undefined };
}

/** Build a minimal survival world and run it for `seconds` of 60 FPS frames. */
function runNight(opts: { fire?: boolean; shelter?: boolean; cloak?: boolean; activity?: Activity; seconds: number; startHour?: number }) {
  const world = new World();
  const events = new EventBus();
  const cycle = new DayNightCycle({ ...DEFAULT_DAY_NIGHT, seed: 7 });
  cycle.setHour(opts.startHour ?? 21);
  const loop = new GameLoop(world, { scheduler: manualScheduler() });
  const survival = new SurvivalSystem(events, undefined);
  loop.addSystem(new EnvironmentSystem(cycle)).addSystem(survival);

  const p = spawnPlayer(world, { x: 0, y: 0, z: 0 });
  const s = world.require(p, SurvivorC);
  s.activity = opts.activity ?? 'idle';
  if (opts.fire) spawnCampfire(world, { x: 1.5, y: 0, z: 0 }, 99999);
  if (opts.shelter) spawnLeanTo(world, { x: 0, y: 0, z: 0 });
  if (opts.cloak) s.equipped.body = { item: 'fur_cloak', qty: 1 };

  // Assigned inside event callbacks; the cast stops TS narrowing them to `null`.
  let deathAt = null as number | null;
  let deathCause = '';
  let hypoAt = null as number | null;
  events.on('survivor:died', ({ cause }) => {
    deathAt = loop.stats.simTime;
    deathCause = cause;
  });
  events.on('survivor:effect-added', ({ effect }) => {
    if (effect === 'hypothermia' && hypoAt === null) hypoAt = loop.stats.simTime;
  });

  let minAmbient = Infinity;
  const frameMs = 1000 / 60;
  for (let t = 0; t <= opts.seconds * 1000; t += frameMs) {
    loop.tick(t);
    minAmbient = Math.min(minAmbient, cycle.ambientTempC);
    if (!s.alive) break;
  }
  return { s, deathAt, deathCause, hypoAt, minAmbient, simTime: loop.stats.simTime, cycle };
}

console.log('\n── Survival: one night in the forest (21:00 →, 6 real minutes ≈ 7 game hours) ──');
const exposed = runNight({ seconds: 360 });
console.log(`   coldest ambient ${exposed.minAmbient.toFixed(1)} °C; hypothermia at ${exposed.hypoAt?.toFixed(0) ?? '—'} s; death at ${exposed.deathAt?.toFixed(0) ?? '—'} s (${exposed.deathCause || 'survived'})`);
check('exposed survivor gets hypothermia', exposed.hypoAt !== null);
check('exposed survivor dies of the cold', exposed.deathCause === 'hypothermia');
check('…but not instantly (≥ 90 s grace to find warmth)', (exposed.hypoAt ?? 0) >= 90, `${exposed.hypoAt?.toFixed(0)} s`);

const byFire = runNight({ fire: true, seconds: 360 });
console.log(`   by the fire: body ${byFire.s.vitals.bodyTemp.toFixed(2)} °C, health ${byFire.s.vitals.health.toFixed(1)}`);
check('campfire keeps body temperature normal all night', byFire.s.alive && byFire.s.vitals.bodyTemp > 36);

const sheltered = runNight({ shelter: true, cloak: true, seconds: 360 });
console.log(`   lean-to + fur cloak: body ${sheltered.s.vitals.bodyTemp.toFixed(2)} °C, alive=${sheltered.s.alive}, effects=${sheltered.s.effects.map((e) => e.id).join(',')}`);
check('shelter + cloak mitigates cold without fire', sheltered.s.alive && sheltered.s.vitals.bodyTemp > exposed.s.vitals.bodyTemp);

console.log('\n── Metabolism: 5 minutes at midday, idle vs sprinting ──');
const idle = runNight({ seconds: 300, startHour: 12, activity: 'idle' });
const sprint = runNight({ seconds: 300, startHour: 12, activity: 'sprinting' });
const drop = (r: typeof idle, k: 'hunger' | 'thirst' | 'energy'): number => ({ hunger: 85, thirst: 85, energy: 90 })[k] - r.s.vitals[k];
for (const k of ['hunger', 'thirst', 'energy'] as const) {
  console.log(`   ${k.padEnd(7)} idle −${drop(idle, k).toFixed(1)}   sprint −${drop(sprint, k).toFixed(1)}`);
}
check('sprinting drains every vital faster than idling', (['hunger', 'thirst', 'energy'] as const).every((k) => drop(sprint, k) > drop(idle, k) * 2));

console.log('\n── Game loop: tab switch + frame-rate independence ──');
{
  const world = new World();
  const sched = manualScheduler();
  const loop = new GameLoop(world, { scheduler: sched });
  let steps = 0;
  loop.addSystem({ name: 'count', fixedUpdate: () => void steps++ });
  loop.tick(0);
  loop.tick(1000); // a 1 s hitch → at most maxSubSteps (8) fixed steps, backlog dropped
  const afterHitch = steps;
  loop.pause('hidden');
  loop.tick(1000 + 10 * 60_000); // 10 minutes in a background tab
  loop.resume('hidden');
  loop.tick(1000 + 10 * 60_000 + 16.667);
  check('1 s frame hitch is clamped (no spiral of death)', afterHitch === 8, `${afterHitch} steps`);
  check('10 min hidden tab adds zero simulated time', steps - afterHitch <= 1, `${steps - afterHitch} steps after resume`);

  const run = (hz: number): number => {
    const w = new World();
    const l = new GameLoop(w, { scheduler: manualScheduler() });
    l.addSystem({ name: 'n', fixedUpdate: () => undefined });
    for (let t = 0; t <= 10_000; t += 1000 / hz) l.tick(t);
    return l.stats.simTime;
  };
  const [a, b, c] = [run(30), run(60), run(144)];
  check('30/60/144 Hz displays simulate the same time', Math.abs(a - c) < 0.05 && Math.abs(b - c) < 0.05, `${a.toFixed(2)} / ${b.toFixed(2)} / ${c.toFixed(2)} s`);

  const l2 = new GameLoop(new World(), { scheduler: manualScheduler() });
  l2.pause('user');
  l2.pause('hidden');
  l2.resume('hidden');
  check('returning to the tab does not unpause a user pause', l2.isPaused);
}

console.log('\n── Inventory & crafting ──');
{
  const inv = new InventoryGrid({ cols: 4, rows: 2, placements: [] });
  check('stacks merge up to maxStack', inv.add('wood', 125) === 0 && inv.placements.length === 2);
  inv.add('stone', 2);
  inv.add('fiber', 2);
  const engine = new CraftingEngine();
  const ctx = { nearbyStations: new Set(['hands'] as const) };
  check('axe craftable with 2 wood, 2 stone, 2 fiber', engine.check(inv, 'stone_axe', ctx).ok);
  // Fill every remaining cell so the 1×2 axe can't fit even after inputs are freed.
  inv.add('berries', 50 * 4);
  const before = JSON.stringify(inv.data.placements);
  const r = engine.craft(inv, 'stone_axe', ctx);
  check('full inventory: craft refused…', !r.ok && r.reason === 'no-room', r.ok ? 'ok' : r.reason);
  check('…and no materials were consumed', JSON.stringify(inv.data.placements) === before);
  const cook = engine.check(inv, 'cook_meat', ctx);
  check('cooking requires a campfire', !cook.ok && cook.reason === 'missing-station');

  const inv2 = new InventoryGrid({ cols: 3, rows: 3, placements: [] });
  inv2.add('stone_spear', 1); // 1×3
  inv2.add('fur_cloak', 1); // 2×2
  check('multi-cell items pack into the grid', inv2.placements.length === 2 && inv2.add('lean_to_kit', 1) === 1);
}

console.log('\n── Object pool ──');
{
  let created = 0;
  const pool = new ObjectPool({ create: () => ({ id: created++ }), reset: () => undefined, prewarm: 4, max: 4, onExhausted: 'return-null' });
  const held = [pool.acquire(), pool.acquire(), pool.acquire(), pool.acquire()];
  check('pool respects max (projectiles)', pool.acquire() === null && created === 4);
  pool.release(held[0]!);
  pool.release(held[0]!); // double release must be ignored
  check('released object is reused, double-release ignored', pool.acquire() === held[0] && pool.freeCount === 0);
}

console.log('\n── AI: wolf behaviour tree + stealth ──');
{
  const world = new World();
  const events = new EventBus();
  const cycle = new DayNightCycle({ ...DEFAULT_DAY_NIGHT, seed: 3 });
  cycle.setHour(13);
  const noise = new NoiseBus();
  const survival = new SurvivalSystem(events);
  const loop = new GameLoop(world, { scheduler: manualScheduler() });
  let rngState = 42;
  const rng = (): number => ((rngState = (rngState * 16807) % 2147483647) / 2147483647);
  loop
    .addSystem(new EnvironmentSystem(cycle))
    .addSystem(new PerceptionSystem(cycle, noise, () => true, events, rng))
    .addSystem(new AISystem({ groundHeight: () => 0, paths: straightLinePaths, cycle, survival: survival.manager, events }))
    .addSystem(survival);

  const player = spawnPlayer(world, { x: 0, y: 0, z: 0 });
  const wolf = spawnCreature(world, 'wolf', { x: 0, y: 0, z: -20 }, 1234, 6);
  const wc = world.require(wolf, Creature);
  wc.heading = Math.PI; // facing away from the player (toward −Z... away from origin)
  const ps = world.require(player, SurvivorC);
  const transitions: string[] = [];
  events.on('ai:state-changed', ({ to }) => transitions.push(to));

  let t = 0;
  const step = (seconds: number, activity: Activity): void => {
    for (const end = t + seconds * 1000; t < end; t += 1000 / 60) {
      ps.activity = activity;
      loop.tick(t);
    }
  };
  const bb = (): string => world.require(wolf, AIBrain).blackboard.state;
  const dist = (): number => {
    const a = world.require(wolf, Transform).position;
    return Math.hypot(a.x, a.z);
  };

  step(0.05, 'idle');
  step(3, 'crouching');
  check('crouching player behind a wolf stays unnoticed', bb() === 'patrol', `state=${bb()}, awareness=${wc.perception.awareness.toFixed(2)}`);

  step(1.5, 'sprinting');
  check('sprinting noise triggers Hunt (investigate)', transitions.includes('hunt'), `transitions=${transitions.join('→')}`);

  step(8, 'idle');
  check('wolf turns, sees the player → Chase', transitions.includes('chase'), `dist=${dist().toFixed(1)} m`);
  check('wolf closes in and attacks', transitions.includes('attack') && ps.vitals.health < 100, `player hp=${ps.vitals.health.toFixed(0)}`);
  check('detected flag shown on HUD', world.require(player, StealthState).detected);

  wc.health = wc.maxHealth * 0.2;
  step(2, 'idle');
  check('badly hurt wolf flees', bb() === 'flee', `state=${bb()}`);
  console.log(`   transitions: ${transitions.join(' → ')}`);

  // Fire scares predators at night.
  const world2 = new World();
  const cyc2 = new DayNightCycle({ ...DEFAULT_DAY_NIGHT, seed: 3 });
  cyc2.setHour(23);
  const loop2 = new GameLoop(world2, { scheduler: manualScheduler() });
  loop2
    .addSystem(new EnvironmentSystem(cyc2))
    .addSystem(new PerceptionSystem(cyc2, new NoiseBus(), () => true, events, rng))
    .addSystem(new AISystem({ groundHeight: () => 0, paths: straightLinePaths, cycle: cyc2, survival: survival.manager, events }));
  spawnPlayer(world2, { x: 0, y: 0, z: 0 });
  spawnCampfire(world2, { x: 0, y: 0, z: 0 }, 9999);
  const wolf2 = spawnCreature(world2, 'wolf', { x: 0, y: 0, z: -8 }, 99, 4);
  for (let tt = 0; tt < 3000; tt += 1000 / 60) loop2.tick(tt);
  const w2 = world2.require(wolf2, Transform).position;
  check('at night wolves will not enter firelight', Math.hypot(w2.x, w2.z) > 6, `wolf at ${Math.hypot(w2.x, w2.z).toFixed(1)} m from fire`);
}

console.log('\n── World generation ──');
{
  const t0 = performance.now();
  const terrain = generateTerrain();
  const ms = performance.now() - t0;
  const counts: Record<string, number> = {};
  for (const p of terrain.props) counts[p.kind] = (counts[p.kind] ?? 0) + 1;
  console.log(`   ${terrain.cfg.size} m², ${terrain.heights.length} vertices, ${terrain.props.length} props in ${ms.toFixed(0)} ms`);
  console.log(`   ${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
  const again = generateTerrain();
  check('same seed → identical world', again.props.length === terrain.props.length && again.heights.every((h, i) => h === terrain.heights[i]));
  check('spawn area is clear of props', terrain.props.every((p) => Math.hypot(p.position.x - terrain.spawn.x, p.position.z - terrain.spawn.z) >= terrain.cfg.spawnClearRadius));
  check('no props underwater (except pond water sources)', terrain.props.every((p) => p.kind === 'water_source' || p.position.y >= terrain.cfg.waterLevel));
  check('forest is a forest (trees are the most common harvestable)', (counts['tree'] ?? 0) > (counts['rock'] ?? 0));
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
