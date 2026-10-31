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
import { BIOME, GENERATOR_VERSION, coastProfiles, generateTerrain, insideCave, islandBiomes, sampleHeight, sampleSlope, ISLAND, type TerrainData } from '../src/world/TerrainGenerator';
import { populateResources, spawnApexPredators } from '../src/world/WorldPopulator';
import { Structure } from '../src/components';
import { BuildingGrid } from '../src/systems/building/BuildingGrid';
import { InventoryGrid } from '../src/systems/inventory/InventoryGrid';
import { StationSystem } from '../src/systems/StationSystem';
import { bedSpawnPoint, chooseBed, dropBelongings, revive } from '../src/systems/Respawn';
import { BREEDING, BREED_TUNING, BreedingSystem, applyGrowth, breedState, growthScale } from '../src/systems/ai/BreedingSystem';

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
    const t = generateTerrain(toTerrainConfig(parseMapConfig({ size, seed: 777, gen: 2 })));
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

  console.log('\n── Varied coastline (generator v3) ──');
  {
    check('generator v3 still available (new worlds use v4)', GENERATOR_VERSION >= 3);
    for (const seed of [777, 42, 2024]) {
      const cfg = toTerrainConfig(parseMapConfig({ size: 256, seed, gen: 3 }));
      const ps = coastProfiles(cfg);
      const share = (f: (p: (typeof ps)[number]) => boolean): number => ps.filter(f).length / ps.length;
      const cliff = share((p) => p.cliff > 0.5), dune = share((p) => p.dune > 0.5), flat = share((p) => p.cliff < 0.1 && p.dune < 0.1);
      const t = generateTerrain(cfg);
      const W = t.cfg.waterLevel;
      // Cliffs: 6 m inland from the waterline the ground is already high; flat beaches stay low.
      let tallCliff = 0, lowBeach = 0, highDune = 0, cliffRays = 0, flatRays = 0, duneRays = 0;
      ps.forEach((p, k) => {
        if (k % 4) return;
        const a = (k / ps.length) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
        let r = t.cfg.size / 2;
        while (r > 0 && sampleHeight(t, c * r, sn * r) < W) r -= 0.25;
        const h6 = sampleHeight(t, c * (r - 6), sn * (r - 6)) - W;
        if (p.cliff > 0.9) { cliffRays++; if (h6 > 4) tallCliff++; }
        if (p.cliff < 0.05 && p.dune < 0.05) { flatRays++; if (h6 < 0.8) lowBeach++; }
        if (p.dune > 0.9) {
          duneRays++;
          let top = 0;
          for (let dd = 0; dd < p.beach; dd += 0.5) top = Math.max(top, sampleHeight(t, c * (r - dd), sn * (r - dd)) - W);
          if (top > 1.4) highDune++;
        }
      });
      // A cove: the coastline dips ≥ 8 m below its neighbours ±15° on both sides.
      const cove = ps.some((p, k) => p.coast < ps[(k + 15) % ps.length]!.coast - 8 && p.coast < ps[(k + ps.length - 15) % ps.length]!.coast - 8);
      check(`seed ${seed}: some cliffs but not too many (${(cliff * 100).toFixed(0)}%), dunes (${(dune * 100).toFixed(0)}%), mostly flat beach (${(flat * 100).toFixed(0)}%), a cove`,
        cliff > 0.08 && cliff < 0.26 && dune > 0.12 && dune < 0.38 && flat > 0.35 && !!cove);
      check(`seed ${seed}: cliffs rise steeply from the sea, flat beaches stay flat, dunes have relief`,
        tallCliff >= cliffRays * 0.8 && lowBeach >= flatRays * 0.9 && highDune >= duneRays * 0.7,
        `cliffs ${tallCliff}/${cliffRays}, flat ${lowBeach}/${flatRays}, dunes ${highDune}/${duneRays}`);
      const spawnCoast = ps[Math.round(((Math.atan2(t.spawn.z, t.spawn.x) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2) * ps.length) % ps.length]!;
      check(`seed ${seed}: you wash up on a beach, not under a cliff`, spawnCoast.cliff < 0.15 && t.spawn.y - W < 1.5, `cliff ${spawnCoast.cliff.toFixed(2)}, ${(t.spawn.y - W).toFixed(2)} m`);

      // The crocodile still patrols smoothly along cliffs and into coves.
      const nav = new NavGrid(buildNavGrid(t));
      const world = new World();
      const crocs = spawnApexPredators(world, { terrain: t, nav: buildNavGrid(t) }, parseMapConfig({ size: 256, seed, gen: 3 }), [])
        .filter((e) => world.require(e, Creature).species === 'crocodile');
      const apex = new ApexSystem({
        terrainHeight: (x, z) => sampleHeight(t, x, z), groundHeight: (x, z) => sampleHeight(t, x, z), waterLevel: W,
        paths: new FlowFieldService(nav), isNight: () => false, survival: new SurvivalStatusManager(), events: new EventBus(), half: 128,
      });
      spawnPlayer(world, { x: 0, y: 30, z: 0 });
      let maxStill = 0, flips = 0;
      for (const croc of crocs) {
        const cp = world.require(croc, Transform).position, k = world.require(croc, Creature);
        let still = 0, lastTurn = 0;
        for (let i = 0; i < 60 * 120; i++) {
          const x0 = cp.x, z0 = cp.z, h0 = k.heading;
          apex.fixedUpdate(world, 1 / 60);
          const mode = world.require(croc, AIBrain).blackboard.apex!.mode;
          still = Math.hypot(cp.x - x0, cp.z - z0) < 0.001 && mode !== 'lurk' ? still + 1 : 0;
          maxStill = Math.max(maxStill, still);
          const dh = Math.atan2(Math.sin(k.heading - h0), Math.cos(k.heading - h0));
          const turn = Math.abs(dh) < 0.004 ? 0 : Math.sign(dh);
          if (turn !== 0 && lastTurn !== 0 && turn !== lastTurn) flips++;
          if (turn !== 0) lastTurn = turn;
        }
      }
      check(`seed ${seed}: crocodiles keep swimming smoothly along the new coast`, crocs.length > 0 && maxStill < 120 && flips < 40 * crocs.length,
        `${crocs.length} crocs, stuck ≤ ${(maxStill / 60).toFixed(1)} s, ${flips} reversals in 2 min each`);
    }
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
    check('5 crocodiles on a 256 m island, in the water', crocs.length === 5 && crocs.every((e) => sampleHeight(t, world.require(e, Transform).position.x, world.require(e, Transform).position.z) < t.cfg.waterLevel - 0.5));
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
    check('it floats with only its eyes and back above the surface (or rests on a sandbank)', Math.abs(cp.y - Math.max(sampleHeight(t, cp.x, cp.z), t.cfg.waterLevel - 0.55)) < 0.15);
    // Patrolling for 3 minutes: it keeps moving (no long stops) and never jitters
    // back and forth (heading reversals tick to tick).
    {
      let still = 0, maxStill = 0, flips = 0, lastTurn = 0;
      const k = world.require(croc, Creature);
      for (let i = 0; i < 60 * 180; i++) {
        const x0 = cp.x, z0 = cp.z, h0 = k.heading;
        apex.fixedUpdate(world, 1 / 60);
        const mode = world.require(croc, AIBrain).blackboard.apex!.mode;
        if (Math.hypot(cp.x - x0, cp.z - z0) < 0.001 && mode !== 'lurk') still++;
        else still = 0;
        maxStill = Math.max(maxStill, still);
        const dh = Math.atan2(Math.sin(k.heading - h0), Math.cos(k.heading - h0));
        const turn = Math.abs(dh) < 0.004 ? 0 : Math.sign(dh); // ignore sub-0.25° corrections
        if (turn !== 0 && lastTurn !== 0 && turn !== lastTurn) flips++;
        if (turn !== 0) lastTurn = turn;
      }
      check('it keeps swimming: never stuck more than 2 s outside its lurking pauses', maxStill < 120, `${(maxStill / 60).toFixed(1)} s`);
      check('no left/right flip-flopping (the vibration)', flips < 60, `${flips} reversals in 3 min`);
    }
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

  console.log('\n── Smooth movement of the crocodile and the bear ──');
  {
    const t = t256!;
    const map = parseMapConfig({ size: 256, seed: 777, gen: 2 });
    const bundle = { terrain: t, nav: buildNavGrid(t) };
    const world = new World();
    const nav = new NavGrid(bundle.nav);
    const ents = spawnApexPredators(world, bundle, map, []);
    const apex = new ApexSystem({
      terrainHeight: (x, z) => sampleHeight(t, x, z), groundHeight: (x, z) => sampleHeight(t, x, z), waterLevel: t.cfg.waterLevel,
      paths: new FlowFieldService(nav), isNight: () => false, survival: new SurvivalStatusManager(), events: new EventBus(), half: 128,
    });
    spawnPlayer(world, { x: 0, y: 30, z: 0 });
    let stale = 0;
    for (let i = 0; i < 600; i++) {
      apex.fixedUpdate(world, 1 / 60);
      for (const e of ents) {
        const tr = world.require(e, Transform);
        // The renderer blends prevRotation → rotation: both must be fresh, and close.
        const dot = Math.abs(tr.prevRotation.x * tr.rotation.x + tr.prevRotation.y * tr.rotation.y + tr.prevRotation.z * tr.rotation.z + tr.prevRotation.w * tr.rotation.w);
        if (dot < 0.999) stale++;
      }
    }
    check('render interpolation gets a fresh previous rotation every step (no shaking, faces where it goes)', stale === 0, `${stale} stale rotations`);
    // A charging bear chasing a moving player: no left/right flip-flop.
    const bear = ents.find((e) => world.require(e, Creature).species === 'bear')!;
    const c = t.caves![0]!;
    const player = [...world.query(PlayerControlled)][0]!;
    const pp = world.require(player, Transform).position;
    const ax = Math.sin(c.yaw), az = Math.cos(c.yaw);
    world.require(bear, AIBrain).blackboard.apex!.mode = 'charge';
    let flips = 0, last = 0;
    const k = world.require(bear, Creature);
    for (let i = 0; i < 60 * 8; i++) {
      const s = i / 60;
      pp.x = c.x - ax * (c.length / 2 + 4 + s * 2) + Math.sin(s) * 3;
      pp.z = c.z - az * (c.length / 2 + 4 + s * 2) + Math.cos(s) * 3;
      pp.y = sampleHeight(t, pp.x, pp.z);
      const h0 = k.heading;
      apex.fixedUpdate(world, 1 / 60);
      const dh = Math.atan2(Math.sin(k.heading - h0), Math.cos(k.heading - h0));
      const turn = Math.abs(dh) < 0.004 ? 0 : Math.sign(dh);
      if (turn && last && turn !== last) flips++;
      if (turn) last = turn;
    }
    check('a charging bear runs in smooth curves', flips < 25, `${flips} reversals in 8 s`);
  }

  console.log('\n── Respawn at a bed ──');
  {
    const grid = new BuildingGrid({ heightAt: () => 1, staticBlocked: () => false, waterLevel: -5 });
    check('no bed → no respawn', chooseBed(grid, null) === null);
    grid.insert({ id: 1, kind: 'foundation', i: 0, j: 0, y: 1.4 });
    grid.insert({ id: 2, kind: 'bed', i: 0, j: 0, y: 1.4, side: 'n' });
    const world = new World();
    const p = spawnPlayer(world, { x: 40, y: 1, z: 40 });
    const s = world.require(p, SurvivorC);
    const inv = new InventoryGrid(s.inventory);
    inv.add('wood', 30);
    inv.add('metal_ingot', 5);
    s.hotbar[0] = { item: 'stone_axe', qty: 1, durability: 50 };
    s.equipped.body = { item: 'hide_armor', qty: 1 };
    s.vitals.health = 0;
    s.alive = false;
    const bag = dropBelongings(world, p, { x: 40, y: 1, z: 40 });
    const bagInv = new InventoryGrid(world.require(bag!, Structure).container!);
    check('dying leaves everything in a bag where you fell', bagInv.count('wood') === 30 && bagInv.count('stone_axe') === 1 && bagInv.count('hide_armor') === 1 && inv.placements.length === 0 && s.hotbar.every((h) => h === null));
    const bed = chooseBed(grid, null)!;
    const at = bedSpawnPoint(bed);
    revive(world, p, at);
    check('you wake up next to the bed, alive, with fresh vitals', s.alive && s.vitals.health === 70 && Math.abs(at.y - 1.4) < 1e-6 && Math.hypot(at.x - 1.5, at.z - 1.5) < 2.2);
    const st = new StationSystem(new EventBus());
    bagInv.remove('wood', 30); bagInv.remove('metal_ingot', 5); bagInv.remove('stone_axe', 1); bagInv.remove('hide_armor', 1);
    st.fixedUpdate(world, 0.1);
    world.flush();
    check('the empty bag disappears', !world.get(bag!, Structure));
  }

  console.log('\n── Gen 4 biomes ──');
  {
    const all = new Set<number>();
    let fewOk = true, signatureOk = true;
    const SIGNATURE: Record<string, number> = { tropical: BIOME.rainforest, arid: BIOME.desert, cold: BIOME.tundra };
    for (let seed = 1; seed <= 30; seed++) {
      const { climate, special } = islandBiomes(toTerrainConfig(parseMapConfig({ size: 256, seed, gen: 4 })));
      special.forEach((b) => all.add(b));
      if (special.length < 2 || special.length > 3) fewOk = false;
      if (!climate || special[0] !== SIGNATURE[climate]) signatureOk = false;
    }
    check('each island gets a few special biomes, never all of them', fewOk);
    check('…always including its climate’s signature biome (rainforest, desert or tundra)', signatureOk);
    check('every new biome shows up somewhere', [BIOME.mangrove, BIOME.rainforest, BIOME.savanna, BIOME.desert, BIOME.prairie, BIOME.tundra, BIOME.lake].every((b) => all.has(b)),
      [...all].sort((a, b) => a - b).join(','));
    const t = generateTerrain(toTerrainConfig(parseMapConfig({ size: 256, seed: 777, gen: 4 })));
    const desert = t.biomes!.filter((b) => b === BIOME.desert).length;
    check('an arid island has a desert with cacti in it', desert > 500 && t.props.some((p) => p.kind === 'cactus'));
    const t24 = generateTerrain(toTerrainConfig(parseMapConfig({ size: 256, seed: 24, gen: 4 })));
    const mangroves = t24.props.filter((p) => p.kind === 'tree' && Math.floor(p.variant / 4) === 8);
    check('a mangrove coast has mangrove trees, some standing in the shallows', mangroves.length > 50 && mangroves.some((p) => p.position.y < t24.cfg.waterLevel));
    const t42 = generateTerrain(toTerrainConfig(parseMapConfig({ size: 256, seed: 42, gen: 4 })));
    check('a lake has fish and reeds in it', t42.biomes!.includes(BIOME.lake) && t42.props.some((p) => p.kind === 'reeds') &&
      t42.props.filter((p) => p.kind === 'fish_shoal').length > 30);
  }

  console.log('\n── Animals breed like real ones; babies grow up ──');
  {
    const world = new World();
    const events = new EventBus();
    let seed = 3;
    const rng = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const breed = new BreedingSystem(events, () => true, () => 0, rng);
    // Even seeds are female, odd ones male.
    const d1 = spawnCreature(world, 'deer', { x: 0, y: 0, z: 0 }, 1);
    const doe = spawnCreature(world, 'deer', { x: 2, y: 0, z: 0 }, 2);
    spawnCreature(world, 'boar', { x: 30, y: 0, z: 0 }, 3); // two males side by side: no piglets
    spawnCreature(world, 'boar', { x: 31, y: 0, z: 0 }, 5);
    const sow = spawnCreature(world, 'boar', { x: 60, y: 0, z: 0 }, 4); // a sow with a boar 15 m away: he comes to her
    const boar = spawnCreature(world, 'boar', { x: 75, y: 0, z: 0 }, 7);
    spawnCreature(world, 'wolf', { x: 150, y: 0, z: 0 }, 9); // a lone wolf: can't breed
    check('animals are male or female', breedState(world, d1).sex === 'male' && breedState(world, doe).sex === 'female');
    let born = 0;
    events.on('creature:born', () => born++);
    const run = (sec: number): void => { for (let t = 0; t < sec; t += 1) breed.fixedUpdate(world, 1); };
    run(BREED_TUNING.interval * 3);
    const pregnant = breedState(world, doe).pregnant !== undefined;
    check('a male and a female close together mate; the fawn comes after a gestation', pregnant && born === 0, `pregnant ${pregnant}, ${born} born`);
    run(BREEDING.deer!.gestation + 1);
    const deer = [...world.query(Creature)].filter((e) => world.require(e, Creature).species === 'deer');
    check('…then she gives birth next to her and rests before mating again', deer.length > 2 && breedState(world, doe).rest !== undefined && breedState(world, doe).pregnant === undefined, `${deer.length} deer`);
    const boars = [...world.query(Creature)].filter((e) => world.require(e, Creature).species === 'boar');
    const wolves = [...world.query(Creature)].filter((e) => world.require(e, Creature).species === 'wolf');
    check('two males, a lone wolf, or a male too far away never have young', boars.length === 4 && wolves.length === 1);
    const sw = world.require(sow, AIBrain).blackboard.waypoints, bw = world.require(boar, AIBrain).blackboard.waypoints;
    check('a male within courtship distance follows the female (takes her patrol route)', bw.length === sw.length && bw.every((w, i) => w.x === sw[i]!.x && w.z === sw[i]!.z));
    const baby = deer.find((e) => world.require(e, Creature).growth !== undefined) ?? deer.find((e) => e !== d1)!;
    world.require(baby, Creature).growth = BREED_TUNING.birthGrowth;
    applyGrowth(world, baby);
    const small = { scale: growthScale(world.require(baby, Creature)), hp: world.require(baby, Creature).maxHealth };
    run(500);
    const mid = growthScale(world.require(baby, Creature));
    run(600);
    const kb = world.require(baby, Creature);
    check('babies are born small and grow little by little into adults', small.scale < 0.5 && mid > small.scale && mid < 1 && kb.growth === undefined && kb.maxHealth === 40,
      `scale ${small.scale.toFixed(2)} → ${mid.toFixed(2)} → 1, hp ${small.hp} → ${kb.maxHealth}`);
    const pup = spawnCreature(world, 'wolf', { x: 60, y: 0, z: 0 }, 9);
    world.require(pup, Creature).growth = 0.3;
    applyGrowth(world, pup);
    check('a wolf pup is timid and harmless until it grows', world.require(pup, Creature).attackDamage === 0 && world.require(pup, AIBrain).tree === 'prey');
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
