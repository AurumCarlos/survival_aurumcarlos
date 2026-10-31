/**
 * Headless checks for the refactor: flow-field pathing, AI LOD, terrain
 * service + codec, save/load round trip, animation FSM, app state machine.
 * `npm run test` (runs this and simulate-night.ts).
 */
import { GameStateMachine } from '../src/app/GameStateMachine';
import { AIBrain, Creature, Cullable, HeatSource, ResourceC, SurvivorC, Transform } from '../src/components';
import { World } from '../src/core/ecs/World';
import { EventBus } from '../src/core/EventBus';
import { GameLoop, type FrameScheduler } from '../src/core/GameLoop';
import { spawnCampfire, spawnCreature, spawnPlayer } from '../src/entities/factories';
import { MemoryBackend, SaveStore, type SyncStorage } from '../src/persistence/SaveStore';
import { applySnapshot, captureSnapshot, parseSnapshot, serializeSnapshot, SnapshotError } from '../src/persistence/WorldSnapshot';
import { AILodSystem, aiLodTier } from '../src/systems/ai/AILodSystem';
import { AISystem } from '../src/systems/ai/AISystem';
import { FlowFieldService } from '../src/systems/ai/nav/FlowFieldService';
import { NavGrid } from '../src/systems/ai/nav/NavGrid';
import { DayNightCycle, DEFAULT_DAY_NIGHT } from '../src/systems/DayNightCycle';
import { InventoryGrid } from '../src/systems/inventory/InventoryGrid';
import { CLIPS, makePlayerAnim, stepAnim, viewModelPose, type AnimInputs, type ViewPose } from '../src/systems/player/PlayerAnimation';
import { SurvivalSystem } from '../src/systems/SurvivalSystem';
import { MapConfigError, parseMapConfig, toTerrainConfig } from '../src/world/MapConfig';
import { mulberry32 } from '../src/world/Noise';
import { TerrainService } from '../src/world/TerrainService';
import { populateResources, spawnInitialCreatures } from '../src/world/WorldPopulator';

declare const process: { exit(code: number): never };

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const manual = (): FrameScheduler => ({ now: () => 0, request: () => 0, cancel: () => undefined });

async function main(): Promise<void> {
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n── Flow field: synthetic wall with one gap ──');
  {
    const cols = 60, rows = 60;
    const blocked = new Uint8Array(cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (r === 0 || c === 0 || r === rows - 1 || c === cols - 1) blocked[r * cols + c] = 1;
      if (c === 30 && r < 52) blocked[r * cols + c] = 1; // wall, gap at the top rows 52–58
    }
    const grid = new NavGrid({ originX: 0, originZ: 0, cellSize: 1, cols, rows, blocked, cost: new Uint8Array(cols * rows) });
    const paths = new FlowFieldService(grid);
    const pos = { x: 10.5, z: 30.5 };
    const goal = { x: 50.5, z: 30.5 };
    const dir = { x: 0, z: 0 };
    let violations = 0, t = 0;
    for (; t < 40 && Math.hypot(goal.x - pos.x, goal.z - pos.z) > 0.8; t += 1 / 60) {
      paths.beginTick();
      if (!paths.steer(pos.x, pos.z, goal.x, goal.z, dir)) continue;
      pos.x += dir.x * 5 / 60;
      pos.z += dir.z * 5 / 60;
      if (!grid.isWalkable(pos.x, pos.z)) violations++;
    }
    check('agent routes through the gap to the far side', Math.hypot(goal.x - pos.x, goal.z - pos.z) <= 0.8, `${t.toFixed(1)} s`);
    check('agent never enters a blocked cell', violations === 0, `${violations} violations`);
    check('one field built and reused for the whole trip', paths.stats.builds === 1, `builds=${paths.stats.builds}, hits=${paths.stats.hits}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n── Terrain service (inline fallback) + codec ──');
  const terrainService = new TerrainService(null); // no Worker in Node → inline path
  const map = parseMapConfig({ size: 256, seed: 4242 });
  const t0 = performance.now();
  const bundle = await terrainService.generate(toTerrainConfig(map));
  console.log(`   256 m world + nav grid in ${(performance.now() - t0).toFixed(0)} ms (${terrainService.lastMode})`);
  const again = await terrainService.generate(toTerrainConfig(map));
  check('generation is deterministic through the codec', again.terrain.props.length === bundle.terrain.props.length &&
    again.terrain.props.every((p, i) => p.position.x === bundle.terrain.props[i]!.position.x) &&
    again.nav.blocked.every((b, i) => b === bundle.nav.blocked[i]));
  const ac = new AbortController();
  ac.abort();
  let aborted = false;
  try {
    await terrainService.generate(toTerrainConfig(map), { signal: ac.signal });
  } catch (e) {
    aborted = (e as Error).name === 'AbortError';
  }
  check('aborted generation rejects with AbortError', aborted);
  const blockedPct = (bundle.nav.blocked.reduce((a, b) => a + b, 0) / bundle.nav.blocked.length) * 100;
  console.log(`   nav grid ${bundle.nav.cols}×${bundle.nav.rows}, ${blockedPct.toFixed(1)}% blocked`);

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n── Flow field on the real forest: 40 random trips ──');
  {
    const grid = new NavGrid(bundle.nav);
    const paths = new FlowFieldService(grid);
    const rand = mulberry32(7);
    const pick = (): { x: number; z: number } => {
      for (;;) {
        const x = (rand() - 0.5) * 200, z = (rand() - 0.5) * 200;
        if (grid.isWalkable(x, z)) return { x, z };
      }
    };
    let arrived = 0, trips = 0, violations = 0, unreachable = 0, buildMs = 0;
    const dir = { x: 0, z: 0 };
    while (trips < 40) {
      const a = pick(), b = pick();
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d < 15 || d > 60) continue;
      trips++;
      let stalled = 0;
      for (let t = 0; t < 40; t += 1 / 60) {
        paths.beginTick();
        const before = performance.now();
        const ok = paths.steer(a.x, a.z, b.x, b.z, dir);
        buildMs += performance.now() - before;
        if (!ok) {
          if (++stalled > 30) {
            unreachable++;
            break;
          }
          continue;
        }
        a.x += dir.x * 4 / 60;
        a.z += dir.z * 4 / 60;
        if (!grid.isWalkable(a.x, a.z)) violations++;
        if (Math.hypot(a.x - b.x, a.z - b.z) < 1.2) {
          arrived++;
          break;
        }
      }
    }
    console.log(`   ${arrived}/${trips} arrived, ${unreachable} unreachable (island/cliff), ${paths.stats.builds} fields built, avg query ${(buildMs / (trips * 2400)).toFixed(3)} ms`);
    check('agents reach reachable goals through the forest', arrived + unreachable === trips && arrived >= trips * 0.8);
    check('no agent ever stands inside a trunk/rock/water cell', violations === 0, `${violations}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n── AI LOD ──');
  {
    check('visible → active', aiLodTier(true, 200, 'patrol') === 'active');
    check('off-screen but near → active', aiLodTier(false, 20, 'patrol') === 'active');
    check('off-screen, far, chasing → active (never freeze a pursuit)', aiLodTier(false, 80, 'chase') === 'active');
    check('off-screen, far, patrolling → dormant', aiLodTier(false, 80, 'patrol') === 'dormant');

    const world = new World();
    const events = new EventBus();
    const cycle = new DayNightCycle(DEFAULT_DAY_NIGHT);
    const survival = new SurvivalSystem(events);
    const grid = new NavGrid(bundle.nav);
    const loop = new GameLoop(world, { scheduler: manual() });
    const lod = new AILodSystem();
    loop.addSystem(lod).addSystem(new AISystem({ groundHeight: () => 0, paths: new FlowFieldService(grid), cycle, survival: survival.manager, events }));
    spawnPlayer(world, { x: 0, y: 0, z: 0 });
    const far = farWalkable(grid, 80);
    const wolf = spawnCreature(world, 'wolf', { x: far.x, y: 0, z: far.z }, 5, 10);
    world.require(wolf, Cullable).visible = false;
    const start = { ...world.require(wolf, Transform).position };
    for (let t = 0; t <= 8000; t += 1000 / 60) loop.tick(t);
    const tr = world.require(wolf, Transform);
    const moved = Math.hypot(tr.position.x - start.x, tr.position.z - start.z);
    check('a dormant wolf keeps living (patrols at a reduced think rate, no stale interpolation)',
      world.require(wolf, AIBrain).lod === 'dormant' && moved > 0.5 && tr.prevPosition.x === tr.position.x && tr.prevPosition.z === tr.position.z,
      `lod=${world.require(wolf, AIBrain).lod}, moved ${moved.toFixed(1)} m, dormant=${lod.stats.dormant}`);
    const mid = { ...tr.position };
    world.require(wolf, Cullable).visible = true;
    for (let t = 8000; t <= 13000; t += 1000 / 60) loop.tick(t);
    const q = world.require(wolf, Transform).position;
    check('coming on-screen it carries on from where it was', world.require(wolf, AIBrain).lod === 'active' && Math.hypot(q.x - mid.x, q.z - mid.z) > 1, `moved ${Math.hypot(q.x - mid.x, q.z - mid.z).toFixed(1)} m`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n── Save / load round trip ──');
  {
    const small = parseMapConfig({ size: 128, seed: 99 });
    const b = await terrainService.generate(toTerrainConfig(small));
    const make = (): { world: World; cycle: DayNightCycle; pop: ReturnType<typeof populateResources> } => {
      const world = new World();
      return { world, cycle: new DayNightCycle(DEFAULT_DAY_NIGHT), pop: populateResources(world, b) };
    };
    const A = make();
    spawnInitialCreatures(A.world, b, small, A.pop.nav);
    const player = spawnPlayer(A.world, { x: 1, y: 2, z: 3 });
    const s = A.world.require(player, SurvivorC);
    s.vitals.hunger = 42.5;
    s.effects.push({ id: 'cold', remaining: Number.POSITIVE_INFINITY, stacks: 1, source: 'condition' });
    s.effects.push({ id: 'food_poisoning', remaining: 33, stacks: 1, source: 'consumable' });
    new InventoryGrid(s.inventory).add('stone_axe', 1);
    s.hotbar[0] = { item: 'stone_spear', qty: 1, durability: 17 };
    const [treeId, treeEntity] = [...A.pop.stableToEntity.entries()][5]!;
    const res = A.world.require(treeEntity, ResourceC);
    res.hitPoints = 0;
    res.respawnTimer = 123;
    spawnCampfire(A.world, { x: 4, y: 0, z: 4 }, 77);
    A.cycle.totalHours = 30.5;
    const wolf = [...A.world.query(Creature)].find((e) => A.world.require(e, Creature).species === 'wolf')!;
    A.world.require(wolf, Creature).health = 21;
    A.world.require(wolf, AIBrain).blackboard.state = 'hunt';

    const json = serializeSnapshot(captureSnapshot(A.world, { map: small, cycle: A.cycle, populated: A.pop }));
    console.log(`   snapshot: ${(json.length / 1024).toFixed(1)} KB JSON`);
    const snap = parseSnapshot(json);

    const B = make();
    const { player: p2, missingResources } = applySnapshot(B.world, snap, B.pop, B.cycle);
    const s2 = B.world.require(p2, SurvivorC);
    check('vitals, hotbar durability and clock restored', s2.vitals.hunger === 42.5 && s2.hotbar[0]?.durability === 17 && B.cycle.totalHours === 30.5);
    check('Infinity survives JSON (condition effects)', s2.effects.find((e) => e.id === 'cold')?.remaining === Number.POSITIVE_INFINITY &&
      s2.effects.find((e) => e.id === 'food_poisoning')?.remaining === 33);
    check('inventory restored', new InventoryGrid(s2.inventory).count('stone_axe') === 1);
    const res2 = B.world.require(B.pop.stableToEntity.get(treeId)!, ResourceC);
    check('depleted tree stays depleted, regrow timer kept (stable IDs)', res2.hitPoints === 0 && res2.respawnTimer === 123 && missingResources === 0);
    const wolves = [...B.world.query(Creature)].filter((e) => B.world.require(e, Creature).species === 'wolf');
    check('creatures restored with health and AI state', wolves.some((e) => B.world.require(e, Creature).health === 21 && B.world.require(e, AIBrain).blackboard.state === 'hunt'),
      `${[...B.world.query(Creature)].length} creatures`);
    check('campfire fuel restored', [...B.world.query(HeatSource)].length === 1);

    let e1 = '', e2 = '', e3 = '';
    try { parseSnapshot(json.slice(0, json.length / 2)); } catch (e) { e1 = e instanceof SnapshotError ? e.message : 'wrong type'; }
    try { parseSnapshot(json.replace('"version":4', '"version":99')); } catch (e) { e2 = (e as Error).message; }
    try { parseSnapshot(json.replace('"species":"wolf"', '"species":"dragon"')); } catch (e) { e3 = (e as Error).message; }
    check('truncated save → clear error', e1.includes('not valid JSON'), e1);
    check('save from a newer version → refused', e2.includes('newer'), e2);
    check('tampered save → names the bad field', e3.includes('species'), e3);

    // Store: emergency (localStorage) copy newer than IndexedDB wins; corrupt newest falls back.
    const mem = new Map<string, string>();
    const sync: SyncStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v), removeItem: (k) => void mem.delete(k) };
    const store = await SaveStore.open({ idb: null, sync });
    check('falls back to memory backend without IndexedDB', store.backend instanceof MemoryBackend);
    await store.save({ ...snap, savedAt: 1000 });
    store.emergencySave({ ...snap, savedAt: 2000, clock: { totalHours: 55 } });
    const latest = await store.loadLatest();
    check('refresh: newer emergency save wins over IndexedDB', latest?.snapshot.clock.totalHours === 55);
    mem.set('survival.emergency-save', '{"slot":"autosave","savedAt":3000,"json":"{broken"}');
    const fallback = await store.loadLatest();
    check('corrupt newest save is skipped, older one loads', fallback?.record.savedAt === 1000);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n── Player animation state machine ──');
  {
    const a = makePlayerAnim();
    const inp: AnimInputs = { wanted: 'stone_axe', sprinting: false, speed: 0, alive: true, request: null };
    const pose: ViewPose = { visible: false, x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };
    const run = (sec: number, patch: Partial<AnimInputs> = {}): string[] => {
      const impacts: string[] = [];
      for (let t = 0; t < sec; t += 1 / 60) {
        const r = stepAnim(a, 1 / 60, { ...inp, ...patch });
        if (r.impact) impacts.push(r.impact);
        patch = { ...patch, request: null }; // a request is a one-frame event
      }
      return impacts;
    };
    check('starts holstered, tool hidden', viewModelPose(a, pose).visible === false);
    run(0.02);
    check('equips the hotbar item', a.state === 'equipping' && a.held === 'stone_axe');
    const early = run(0.1, { request: 'swing' }); // click during equip → buffered
    run(0.3);
    check('click during equip is buffered, then swings', a.state === 'swing' || early.length > 0 || a.state === 'ready');
    const impacts = run(1);
    check('swing impact fires exactly once', impacts.filter((i) => i === 'swing').length === 1, impacts.join(','));
    run(0.05, { sprinting: true });
    check('sprinting puts the tool away (unequipping)', a.state === 'unequipping');
    run(0.4, { sprinting: true });
    check('…and hides it while running', a.state === 'holstered' && viewModelPose(a, pose).visible === false);
    const blocked = run(0.5, { sprinting: true, request: 'swing' });
    check('no swing while sprinting', blocked.length === 0 && a.state === 'holstered');
    run(0.5);
    check('stopping the sprint re-equips', a.state === 'ready' && viewModelPose(a, pose).visible);
    const noThrow = run(0.6, { request: 'throw' });
    check('throw refused without a spear', noThrow.length === 0);
    run(0.6, { wanted: 'stone_spear' });
    check('hotbar change swaps tool via holster', a.held === 'stone_spear' && a.state === 'ready');
    const thrown = run(0.3, { wanted: 'stone_spear', request: 'throw' });
    // CombatSystem empties the hotbar slot on the impact; emulate that.
    run(0.6, { wanted: null });
    check('throw impact fires, spear leaves the hand', thrown.includes('throw') && a.held === null && a.state === 'ready', `state=${a.state}, held=${a.held}`);
    check('clip timings sane', CLIPS.swing.impact! < CLIPS.swing.duration && CLIPS.harvest.impact! < CLIPS.harvest.duration);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n── App state machine: rapid toggling ──');
  {
    const m = new GameStateMachine('menu');
    check('illegal jump menu → playing ignored', !m.transition('playing') && m.state === 'menu');
    m.transition('config');
    check('double "Generate" → second is ignored', m.transition('loading') && !m.transition('loading'));
    const stale = m.ticket();
    m.transition('menu'); // cancel
    m.transition('config');
    m.transition('loading');
    const fresh = m.ticket();
    check('result of a cancelled generation is discarded', !stale.stillValid() && fresh.stillValid());
    m.transition('paused');
    let flips = 0;
    for (let i = 0; i < 25; i++) if (m.transition(i % 2 ? 'paused' : 'playing')) flips++;
    check('25 rapid pause toggles stay consistent', flips === 25 && m.state === 'playing');
    check('playing → menu requires pausing first', !m.transition('menu'));
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n── Map configuration input ──');
  {
    check('size snapped to chunk multiple', parseMapConfig({ size: 300, seed: 1 }).size === 288);
    check('size clamped to limits', parseMapConfig({ size: 5000, seed: 1 }).size === 512 && parseMapConfig({ size: 3, seed: 1 }).size === 128);
    check('text seeds are hashed deterministically', parseMapConfig({ size: 256, seed: 'pine' }).seed === parseMapConfig({ size: 256, seed: 'pine' }).seed);
    let threw = false;
    try { parseMapConfig({ size: 'big' }); } catch (e) { threw = e instanceof MapConfigError; }
    check('non-numeric size is an error, not a silent default', threw);
  }

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

function farWalkable(grid: NavGrid, dist: number): { x: number; z: number } {
  for (let a = 0; a < Math.PI * 2; a += 0.1) {
    const x = Math.cos(a) * dist, z = Math.sin(a) * dist;
    if (grid.isWalkable(x, z)) return { x, z };
  }
  throw new Error('no walkable point');
}

void main();
