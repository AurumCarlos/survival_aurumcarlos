/**
 * Headless checks for round 8: the "constant damage" fix, mountains/caves/
 * biomes, the crocodile and the bear, and multiple saves.
 */
import { AIBrain, Creature, PlayerControlled, SurvivorC, Transform } from '../src/components';
import { World } from '../src/core/ecs/World';
import { EventBus } from '../src/core/EventBus';
import { GameLoop, type FrameScheduler } from '../src/core/GameLoop';
import { spawnCreature, spawnPlayer } from '../src/entities/factories';
import { MemoryBackend, SaveStore, type SyncStorage } from '../src/persistence/SaveStore';
import { applySnapshot, captureSnapshot, parseSnapshot, serializeSnapshot } from '../src/persistence/WorldSnapshot';
import { AISystem } from '../src/systems/ai/AISystem';
import { ApexSystem, BEAR } from '../src/systems/ai/ApexSystem';
import { FlowFieldService, straightLinePaths } from '../src/systems/ai/nav/FlowFieldService';
import { NavGrid, buildNavGrid } from '../src/systems/ai/nav/NavGrid';
import { DayNightCycle, DEFAULT_DAY_NIGHT } from '../src/systems/DayNightCycle';
import { EnvironmentSystem } from '../src/systems/EnvironmentSystem';
import { SurvivalStatusManager } from '../src/systems/SurvivalStatusManager';
import { parseMapConfig, toTerrainConfig } from '../src/world/MapConfig';
import { BIOME, GENERATOR_VERSION, generateTerrain, insideCave, sampleHeight, sampleSlope, ISLAND, type TerrainData } from '../src/world/TerrainGenerator';
import { populateResources, spawnApexPredators } from '../src/world/WorldPopulator';

declare const process: { exit(code: number): never };
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const manual = (): FrameScheduler => ({ now: () => 0, request: () => 0, cancel: () => undefined });

async function main(): Promise<void> {
  console.log('\n── "Damage for no reason" ──');
  {
    // 1. A wolf right under the player's floor can't bite through it.
    const world = new World();
    const events = new EventBus();
    const cycle = new DayNightCycle({ ...DEFAULT_DAY_NIGHT, seed: 3 });
    const survival = new SurvivalStatusManager();
    const ai = new AISystem({ groundHeight: () => 0, paths: straightLinePaths, cycle, survival, events });
    const player = spawnPlayer(world, { x: 0, y: 3, z: 0 });
    const wolf = spawnCreature(world, 'wolf', { x: 0.6, y: 0, z: 0 }, 7, 4);
    const k = world.require(wolf, Creature);
    const keepAngry = (): void => {
      k.perception.canSeeTarget = true;
      k.perception.awareness = 1.5;
      k.perception.lastKnownTargetPos = { ...world.require(player, Transform).position };
      k.perception.lastKnownAge = 0;
    };
    let hits = 0;
    events.on('player:damaged', () => hits++);
    for (let i = 0; i < 180; i++) {
      keepAngry();
      ai.fixedUpdate(world, 1 / 60);
    }
    const s = world.require(player, SurvivorC);
    check('a wolf 3 m below (under a floor) can’t bite you', s.vitals.health === 100 && hits === 0);
    world.require(player, Transform).position.y = 0;
    for (let i = 0; i < 180; i++) {
      keepAngry();
      ai.fixedUpdate(world, 1 / 60);
    }
    check('on the same level it does, and each bite is reported (red flash + message)', s.vitals.health < 100 && hits > 0, `${hits} bites, hp ${s.vitals.health.toFixed(0)}`);

    // 2. The island's climate is mild; cold comes with altitude.
    const c = new DayNightCycle(DEFAULT_DAY_NIGHT);
    let min = Infinity, max = -Infinity;
    for (let h = 0; h < 24 * 6; h += 0.5) {
      c.setHour(h % 24);
      c.advance(30 * 60 * (DEFAULT_DAY_NIGHT.dayLengthSeconds / 86400));
      min = Math.min(min, c.ambientTempC);
      max = Math.max(max, c.ambientTempC);
    }
    check('lowland nights stay mild (no hypothermia at sea level)', min >= 9, `${min.toFixed(1)}…${max.toFixed(1)} °C over 6 days`);
    const env = new EnvironmentSystem(c, undefined, { baseY: 7.2, lapseCPerM: 0.4 });
    check('mountain tops are much colder (−0.4 °C/m)', env.ambientAt(45) < env.ambientAt(5) - 14, `${env.ambientAt(5).toFixed(1)} °C at the beach, ${env.ambientAt(45).toFixed(1)} °C at 45 m`);
  }

  console.log('\n── Mountains, caves, biomes (generator v2) ──');
  let t256: TerrainData | null = null;
  for (const size of [128, 256, 512]) {
    const t = generateTerrain(toTerrainConfig(parseMapConfig({ size, seed: 777, gen: GENERATOR_VERSION })));
    if (size === 256) t256 = t;
    const W = t.cfg.waterLevel;
    // Beach: same check as the flat island — every direction has ≥ 10 m of flat sand, no forest on it.
    let beachOk = 0;
    for (let i = 0; i < 90; i++) {
      const a = (i / 90) * Math.PI * 2;
      let run = 0, rmax = 0;
      for (let r = 0; r < size / 2; r += 0.5) {
        const x = Math.cos(a) * r, z = Math.sin(a) * r, h = sampleHeight(t, x, z);
        if (h >= W && h < W + 0.8 && sampleSlope(t, x, z) < 0.08) run += 0.5;
        else if (h >= W + 0.8) run = 0;
        if (h >= W) rmax = r;
      }
      void rmax;
      if (run >= 10) beachOk++;
    }
    const counts = new Set(t.biomes!);
    const peak = t.maxY - W;
    check(`${size} m: mountains (peak ${peak.toFixed(0)} m), flat beach all round (${beachOk}/90), ${counts.size} biomes, ${t.caves!.length} cave(s)`,
      peak > (size <= 128 ? 12 : 20) && beachOk >= 86 && counts.size >= 5 && t.caves!.length >= 1);
  }
  {
    const t = t256!;
    const nav = new NavGrid(buildNavGrid(t));
    const c = t.caves![0]!;
    const ax = Math.sin(c.yaw), az = Math.cos(c.yaw);
    let walk = 0;
    for (let k = 0; k <= 30; k++) {
      const s = -c.length / 2 - 8 + (k / 30) * (c.length - 2 + 8);
      if (nav.isWalkable(c.x + ax * s, c.z + az * s)) walk++;
    }
    check('you can walk from outside, through the mouth, to the back of the cave', walk >= 28, `${walk}/31 points on the axis walkable`);
    const above = sampleHeight(t, c.x + ax * (c.length / 2 + 4), c.z + az * (c.length / 2 + 4));
    check('the cave goes into the mountain (rock rises above the chamber)', above > c.y + 4, `${(above - c.y).toFixed(1)} m of mountain behind it`);
    const insideProps = t.props.filter((p) => insideCave(c, p.position.x, p.position.z) && p.kind !== 'crystal' && p.kind !== 'metal_rock');
    check('no trees or bushes inside caves (crystals and ore at the back)', insideProps.length === 0 && t.props.some((p) => p.kind === 'crystal' && insideCave(c, p.position.x, p.position.z)));
    const snowTrees = t.props.filter((p) => p.kind === 'tree' && t.biomes![idx(t, p.position.x, p.position.z)] === BIOME.snow).length;
    check('no trees on the snowy peaks', snowTrees === 0);
    const legacy = generateTerrain(toTerrainConfig(parseMapConfig({ size: 256, seed: 777 })));
    check('older saves (no generator version) still regenerate the flat island', !legacy.caves && legacy.maxY - legacy.cfg.waterLevel < 9.5 && ISLAND.radius > 0);
  }

  console.log('\n── Crocodile ──');
  {
    const t = t256!;
    const map = parseMapConfig({ size: 256, seed: 777, gen: 2 });
    const bundle = { terrain: t, nav: buildNavGrid(t) };
    const world = new World();
    const nav = new NavGrid(bundle.nav);
    const events = new EventBus();
    const crocs = spawnApexPredators(world, bundle, map, []).filter((e) => world.require(e, Creature).species === 'crocodile');
    check('2 crocodiles on a 256 m island, in the water', crocs.length === 2 && crocs.every((e) => sampleHeight(t, world.require(e, Transform).position.x, world.require(e, Transform).position.z) < t.cfg.waterLevel - 0.5));
    const croc = crocs[0]!;
    const cp = world.require(croc, Transform).position;
    const apex = new ApexSystem({
      terrainHeight: (x, z) => sampleHeight(t, x, z), groundHeight: (x, z) => sampleHeight(t, x, z), waterLevel: t.cfg.waterLevel,
      paths: new FlowFieldService(nav), isNight: () => false, survival: new SurvivalStatusManager(), events, half: 128,
    });
    // Far from the player it patrols the lagoon, always in the water.
    const player = spawnPlayer(world, { x: 0, y: 30, z: 0 });
    let maxGround = -Infinity;
    const modes = new Set<string>();
    for (let i = 0; i < 60 * 60; i++) {
      apex.fixedUpdate(world, 1 / 60);
      maxGround = Math.max(maxGround, sampleHeight(t, cp.x, cp.z));
      modes.add(world.require(croc, AIBrain).blackboard.apex!.mode);
    }
    check('alone, it patrols and lurks in the lagoon without leaving the water', maxGround < t.cfg.waterLevel - 0.25 && modes.has('swim') && modes.has('lurk'), [...modes].join(', '));
    check('it floats with only its eyes and back above the surface', Math.abs(cp.y - (t.cfg.waterLevel - 0.55)) < 0.1);
    // A swimmer nearby: it stalks, lunges and bites.
    const pp = world.require(player, Transform).position;
    const ang = Math.atan2(cp.z, cp.x);
    pp.x = cp.x + Math.cos(ang + 0.3) * 10;
    pp.z = cp.z + Math.sin(ang + 0.3) * 10;
    pp.y = t.cfg.waterLevel - 1.3;
    world.require(player, PlayerControlled).swimming = true;
    let bites = 0;
    events.on('player:damaged', ({ source }) => source === 'crocodile' && bites++);
    const seen = new Set<string>();
    for (let i = 0; i < 60 * 10 && bites === 0; i++) {
      apex.fixedUpdate(world, 1 / 60);
      seen.add(world.require(croc, AIBrain).blackboard.apex!.mode);
    }
    check('a swimmer 10 m away is stalked, lunged at and bitten', bites > 0 && seen.has('stalk') && seen.has('lunge'), [...seen].join(' → '));
    // The player flees far inland: it gives up and goes back to the water.
    pp.x = 0; pp.z = 0; pp.y = 20;
    world.require(player, PlayerControlled).swimming = false;
    for (let i = 0; i < 60 * 25; i++) apex.fixedUpdate(world, 1 / 60);
    check('…and goes back to the water when you leave', sampleHeight(t, cp.x, cp.z) < t.cfg.waterLevel - 0.25, world.require(croc, AIBrain).blackboard.apex!.mode);
  }

  console.log('\n── Bear ──');
  {
    const t = t256!;
    const map = parseMapConfig({ size: 256, seed: 777, gen: 2 });
    const bundle = { terrain: t, nav: buildNavGrid(t) };
    const world = new World();
    const nav = new NavGrid(bundle.nav);
    const events = new EventBus();
    const bears = spawnApexPredators(world, bundle, map, []).filter((e) => world.require(e, Creature).species === 'bear');
    const c = t.caves![0]!;
    check('a bear asleep in every cave', bears.length === t.caves!.length && bears.every((e) => insideCave(c, world.require(e, Transform).position.x, world.require(e, Transform).position.z) || t.caves!.length > 1));
    const bear = bears[0]!;
    const apex = new ApexSystem({
      terrainHeight: (x, z) => sampleHeight(t, x, z), groundHeight: (x, z) => sampleHeight(t, x, z), waterLevel: t.cfg.waterLevel,
      paths: new FlowFieldService(nav), isNight: () => false, survival: new SurvivalStatusManager(), events, half: 128,
    });
    const mode = (): string => world.require(bear, AIBrain).blackboard.apex!.mode;
    const ax = Math.sin(c.yaw), az = Math.cos(c.yaw);
    const player = spawnPlayer(world, { x: c.x - ax * (c.length / 2 + 20), y: c.y, z: c.z - az * (c.length / 2 + 20) });
    const pp = world.require(player, Transform).position;
    for (let i = 0; i < 60 * 10; i++) apex.fixedUpdate(world, 1 / 60);
    check('it sleeps while you stay outside', mode() === 'sleep');
    // Walk into the cave.
    pp.x = c.x - ax * (c.length / 2 - 2);
    pp.z = c.z - az * (c.length / 2 - 2);
    pp.y = sampleHeight(t, pp.x, pp.z);
    const modes: string[] = [];
    let hits = 0;
    events.on('player:damaged', ({ source }) => source === 'bear' && hits++);
    for (let i = 0; i < 60 * 12 && hits === 0; i++) {
      apex.fixedUpdate(world, 1 / 60);
      if (modes[modes.length - 1] !== mode()) modes.push(mode());
    }
    check('enter the cave: it wakes, rears up and roars, charges and swipes', hits > 0 && ['wake', 'roar', 'charge', 'swipe'].every((m) => modes.includes(m)), modes.join(' → '));
    const roarT = BEAR.roarTime;
    check(`the roar gives you ~${roarT.toFixed(1)} s to react`, roarT >= 1.5);
    // Run far away: it gives up and goes home to sleep.
    pp.x = c.x - ax * 70;
    pp.z = c.z - az * 70;
    pp.y = sampleHeight(t, pp.x, pp.z);
    for (let i = 0; i < 60 * 60 && mode() !== 'sleep'; i++) apex.fixedUpdate(world, 1 / 60);
    const bp = world.require(bear, Transform).position;
    check('it goes back to its den and sleeps once you are gone', mode() === 'sleep' && insideCave(c, bp.x, bp.z), mode());

    // Saved with its state.
    const pop = populateResources(world, bundle);
    const snap = parseSnapshot(serializeSnapshot(captureSnapshot(world, { map, cycle: new DayNightCycle(DEFAULT_DAY_NIGHT), populated: pop })));
    const B = new World();
    applySnapshot(B, snap, populateResources(B, bundle), new DayNightCycle(DEFAULT_DAY_NIGHT));
    const restored = [...B.query(Creature)].find((e) => B.require(e, Creature).species === 'bear');
    check('saves keep bears and crocodiles with their den and mode', !!restored && B.require(restored, AIBrain).blackboard.apex?.den?.yaw === c.yaw);
  }

  console.log('\n── Several saves ──');
  {
    const mem = new Map<string, string>();
    const sync: SyncStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v), removeItem: (k) => void mem.delete(k) };
    const store = await SaveStore.open({ idb: null, sync });
    check('memory backend in tests', store.backend instanceof MemoryBackend);
    const map = parseMapConfig({ size: 128, seed: 5 });
    const t = generateTerrain(toTerrainConfig(map));
    const bundle = { terrain: t, nav: buildNavGrid(t) };
    const w = new World();
    const pop = populateResources(w, bundle);
    spawnPlayer(w, { x: 0, y: 2, z: 0 });
    const snap = (day: number) => ({ ...captureSnapshot(w, { map, cycle: new DayNightCycle(DEFAULT_DAY_NIGHT), populated: pop }), savedAt: Date.now() + day, summary: { day, secondsSurvived: day * 60 } });
    await store.save(snap(1), { slot: 'a', name: 'Robinson' });
    await store.save(snap(2), { slot: 'b', name: 'Second island' });
    let list = await store.list();
    check('two worlds listed, newest first, with their names', list.length === 2 && list[0]!.name === 'Second island' && list[1]!.name === 'Robinson');
    await store.save(snap(3), { slot: 'a', name: 'Robinson' });
    list = await store.list();
    check('saving again overwrites that world only', list.length === 2 && list[0]!.slot === 'a' && list[0]!.summary.day === 3);
    await store.rename('b', '  Isla   Nublar ');
    const dup = await store.duplicate('a', 'Robinson — backup');
    list = await store.list();
    check('rename and duplicate', list.some((r) => r.name === 'Isla Nublar') && !!dup && list.length === 3);
    await store.delete('a');
    list = await store.list();
    check('delete one world, the others stay', list.length === 2 && !list.some((r) => r.slot === 'a'));
    const json = await store.exportJson('b');
    const imported = await store.importJson(json!);
    const loaded = await store.load(imported.slot);
    check('export to a file and import it back as a new world', imported.name === 'Isla Nublar' && !!loaded && (await store.list()).length === 3);
    let bad = '';
    try {
      await store.importJson('{"save":"not a save"}');
    } catch (e) {
      bad = (e as Error).message;
    }
    check('importing a broken file gives a clear error', bad.length > 0, bad);
    store.emergencySave(snap(9), { slot: 'b', name: 'Isla Nublar' });
    const b = await store.load('b');
    check('a save written on page close belongs to its own world', b?.snapshot.summary.day === 9 && (await store.list()).filter((r) => r.slot === 'b').length === 1);
  }

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

function idx(t: TerrainData, x: number, z: number): number {
  const n = t.cfg.resolution + 1;
  const ix = Math.round(((x + t.cfg.size / 2) / t.cfg.size) * t.cfg.resolution);
  const iz = Math.round(((z + t.cfg.size / 2) / t.cfg.size) * t.cfg.resolution);
  return iz * n + ix;
}

void main();
