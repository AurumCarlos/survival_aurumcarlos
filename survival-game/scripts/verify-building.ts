/**
 * Headless checks for the island, building, crafting-queue and AI-speed changes.
 */
import { SurvivorC, Transform } from '../src/components';
import { World } from '../src/core/ecs/World';
import { EventBus } from '../src/core/EventBus';
import { GameLoop, type FrameScheduler } from '../src/core/GameLoop';
import { spawnCreature, spawnPlayer } from '../src/entities/factories';
import { parseSnapshot, serializeSnapshot, captureSnapshot } from '../src/persistence/WorldSnapshot';
import { FlowFieldService } from '../src/systems/ai/nav/FlowFieldService';
import { NavGrid } from '../src/systems/ai/nav/NavGrid';
import { BuildingGrid, CELL, type Candidate, type Piece } from '../src/systems/building/BuildingGrid';
import { BuildingNav } from '../src/systems/building/BuildingNav';
import { DayNightCycle, DEFAULT_DAY_NIGHT } from '../src/systems/DayNightCycle';
import { CraftingSystem } from '../src/systems/inventory/CraftingSystem';
import { MOVEMENT } from '../src/systems/PlayerControlSystem';
import { parseMapConfig, toTerrainConfig } from '../src/world/MapConfig';
import { generateTerrain, sampleHeight, ISLAND } from '../src/world/TerrainGenerator';
import { FIR_HEIGHT, FIR_TRUNK_RADIUS } from '../src/systems/ai/nav/NavGrid';
import { TerrainService } from '../src/world/TerrainService';
import { populateResources } from '../src/world/WorldPopulator';
import { Creature } from '../src/components';

declare const process: { exit(code: number): never };
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const manual = (): FrameScheduler => ({ now: () => 0, request: () => 0, cancel: () => undefined });

async function main(): Promise<void> {
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n── Desert island ──');
  for (const size of [128, 256, 512]) {
    const t = generateTerrain(toTerrainConfig(parseMapConfig({ size, seed: 777 })));
    const W = t.cfg.waterLevel;
    let land = 0, maxH = -Infinity;
    for (const h of t.heights) {
      if (h > W) land++;
      maxH = Math.max(maxH, h);
    }
    let edgeWater = true;
    for (let a = 0; a < Math.PI * 2; a += 0.02) {
      const R = (size / 2) * 0.97;
      if (sampleHeight(t, Math.cos(a) * R, Math.sin(a) * R) > W - 0.3) edgeWater = false;
    }
    // Walk inward from the sea along 90 rays: right after the waterline there
    // must be ≥ 10 m of flat sand (within 0.8 m of sea level) with no trees.
    const trees = t.props.filter((p) => p.kind === 'tree');
    let beachOk = 0, minBeach = Infinity;
    for (let k = 0; k < 90; k++) {
      const a = (k / 90) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
      let r = size / 2;
      while (r > 0 && sampleHeight(t, c * r, sn * r) < W) r -= 0.25;
      let run = 0;
      while (r - run > 0) {
        const h = sampleHeight(t, c * (r - run), sn * (r - run));
        if (h < W || h > W + 0.8) break;
        run += 0.25;
      }
      minBeach = Math.min(minBeach, run);
      const treeOnSand = trees.some((p) => {
        const pr = Math.hypot(p.position.x, p.position.z);
        const pa = Math.atan2(p.position.z, p.position.x);
        return Math.abs(Math.atan2(Math.sin(pa - a), Math.cos(pa - a))) * pr < 1.5 && pr < r && pr > r - Math.min(run, 10);
      });
      if (run >= 10 && !treeOnSand) beachOk++;
    }
    const forestR = (size / 2) * 0.74 - 20;
    const dense = trees.filter((p) => Math.hypot(p.position.x, p.position.z) < forestR).length / (Math.PI * forestR * forestR) * 100;
    console.log(`   ${size} m: ${((land / t.heights.length) * 100).toFixed(0)} % land, highest point ${(maxH - W).toFixed(1)} m, narrowest beach ${minBeach.toFixed(1)} m, ${dense.toFixed(1)} trees / 100 m² inland`);
    check(`${size} m: open sea all around the map edge`, edgeWater);
    check(`${size} m: flat tree-free beach ≥ 10 m wide all the way round`, beachOk === 90, `${beachOk}/90 directions`);
    check(`${size} m: low relief (< 8 m above the sea)`, maxH - W < 8);
    check(`${size} m: dense forest inland (≥ 5 firs per 100 m²)`, dense >= 5);
    const sp = t.spawn;
    check(`${size} m: you start on the beach, facing the forest`, sp.y > W && sp.y < W + 0.8 &&
      !t.props.some((p) => Math.hypot(p.position.x - sp.x, p.position.z - sp.z) < t.cfg.spawnClearRadius) &&
      // forward = (−sin yaw, −cos yaw) must point at the island centre
      Math.hypot(-Math.sin(sp.yaw) + sp.x / Math.hypot(sp.x, sp.z), -Math.cos(sp.yaw) + sp.z / Math.hypot(sp.x, sp.z)) < 0.01);
    const water = t.props.filter((p) => p.kind === 'water_source');
    check(`${size} m: freshwater ponds inland`, water.length >= 5 && water.every((w) => sampleHeight(t, w.position.x, w.position.z) < W && Math.hypot(w.position.x, w.position.z) < (size / 2) * 0.6));
  }
  {
    const t = generateTerrain(toTerrainConfig(parseMapConfig({ size: 256, seed: 777 })));
    const heights = t.props.filter((p) => p.kind === 'tree').map((p) => p.scale * FIR_HEIGHT);
    const adult = heights.filter((h) => h >= 12);
    check('firs at real scale: mature 12–20 m, young 5–10 m', Math.max(...heights) <= 20 && Math.min(...heights) >= 5.5 && adult.length > heights.length * 0.7,
      `${Math.min(...heights).toFixed(1)}–${Math.max(...heights).toFixed(1)} m, trunk Ø ${(FIR_TRUNK_RADIUS * 2).toFixed(2)} m at 16 m`);
    check('terrain resolution 1.33 m per quad', Math.abs(t.cfg.size / t.cfg.resolution - 4 / 3) < 1e-9);
  }
  check('island shape constants sane', ISLAND.radius + ISLAND.wobble < 0.9);

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n── Building rules (flat test ground at y = 2) ──');
  const flat = { heightAt: () => 2, staticBlocked: () => false, waterLevel: 0 };
  let nextId = 1;
  const g = new BuildingGrid(flat);
  const put = (c: Candidate): Piece | null => (g.validate(c, null) ? null : g.insert({ ...c, id: nextId++ }));
  const reason = (c: Candidate): string | null => g.validate(c, null);

  const Y = 2.35;
  check('wall with no floor is refused', reason({ kind: 'wall', i: 0, j: 0, y: Y, side: 'n' }) !== null, reason({ kind: 'wall', i: 0, j: 0, y: Y, side: 'n' }) ?? '');
  // 2×1 foundations: cells (0,0) and (1,0)
  const f0 = put({ kind: 'foundation', i: 0, j: 0, y: Y })!;
  const f1 = put({ kind: 'foundation', i: 1, j: 0, y: Y });
  check('foundations placed', !!f0 && !!f1);
  check('second foundation on the same cell refused', reason({ kind: 'foundation', i: 0, j: 0, y: Y }) !== null);
  check('ceiling with no wall underneath refused', reason({ kind: 'ceiling', i: 0, j: 0, y: Y + 3 }) !== null);
  // Walls all around the 2×1 room, with a doorway on the south side of cell 0.
  const ring: Candidate[] = [
    { kind: 'wall', i: 0, j: 0, y: Y, side: 'n' }, { kind: 'wall', i: 1, j: 0, y: Y, side: 'n' },
    { kind: 'wall', i: 0, j: 0, y: Y, side: 'w' }, { kind: 'wall', i: 1, j: 0, y: Y, side: 'e' },
    { kind: 'doorway', i: 0, j: 0, y: Y, side: 's', open: false }, { kind: 'wall', i: 1, j: 0, y: Y, side: 's' },
  ];
  const walls = ring.map(put);
  check('walls and doorway placed on foundation edges', walls.every(Boolean));
  check('duplicate wall on a shared edge refused', reason({ kind: 'wall', i: 0, j: -1, y: Y, side: 's' }) !== null);
  const c0 = put({ kind: 'ceiling', i: 0, j: 0, y: Y + 3 });
  const c1 = put({ kind: 'ceiling', i: 1, j: 0, y: Y + 3 });
  check('ceilings rest on the walls', !!c0 && !!c1);
  const overhang1 = reason({ kind: 'ceiling', i: 2, j: 0, y: Y + 3 });
  const overhang2 = reason({ kind: 'ceiling', i: 3, j: 0, y: Y + 3 });
  check('1-cell ceiling overhang allowed, 2 refused', overhang1 === null && overhang2 !== null, `${overhang1} / ${overhang2}`);
  check('second-storey wall can stand on the ceiling', reason({ kind: 'wall', i: 0, j: 0, y: Y + 3, side: 'n' }) === null);

  const feet = { x: 1.5, y: Y, z: 1.5 };
  const closed = g.shelterAt(feet);
  check('closed, roofed room → strong shelter + roof', closed.insulation > 0.85 && closed.roof, `insulation ${closed.insulation.toFixed(2)}`);
  const door = [...g.pieces()].find((p) => p.kind === 'doorway')!;
  door.open = true;
  const open = g.shelterAt(feet);
  check('opening the door lets the cold in', open.insulation < 0.2 && open.roof, `insulation ${open.insulation.toFixed(2)}`);
  door.open = false;
  check('outside the house → no shelter', g.shelterAt({ x: 20, y: 2, z: 20 }).insulation === 0);

  const playerInWall = g.validate({ kind: 'wall', i: 0, j: 1, y: Y, side: 'n' }, { x: 1.5, y: Y, z: 3.1 });
  check('can\'t build a wall through yourself', playerInWall !== null, playerInWall ?? '');

  // Resolve: aiming at the east half of foundation 1's top extends east.
  const ext = g.resolve('foundation', { origin: { x: 5, y: 5, z: 1 }, dir: { x: 0, y: -1, z: 0 }, maxDistance: 7 }, { point: { x: 5.8, y: Y, z: 1.5 }, pieceId: f1!.id });
  check('aiming near a foundation edge snaps the next one beside it', ext?.i === 2 && ext.j === 0 && ext.y === Y);
  const wallAim = g.resolve('wall', { origin: { x: 1.5, y: 5, z: 1 }, dir: { x: 0, y: -1, z: 0 }, maxDistance: 7 }, { point: { x: 1.5, y: Y, z: 0.2 }, pieceId: f0.id });
  check('aiming near the north edge picks the north side', wallAim?.side === 'n' && wallAim.i === 0);

  // Cascade: removing foundation 1 drops the three walls only it supported.
  // Ceiling 1 survives as a 1-cell overhang off ceiling 0, which still has walls.
  const removed = g.remove(f1!.id);
  const kinds = removed.map((p) => p.kind).join(',');
  check('demolishing a foundation collapses the walls it held up', kinds === 'foundation,wall,wall,wall', kinds);
  check('ceiling left hanging 1 cell from a supported one stays (overhang rule)', !!g.get(c1!.id));
  // Remove the last wall holding ceiling 0 up on its own side… the whole roof comes down.
  const roofDrop = g.remove(walls[0]!.id).concat(g.remove(walls[2]!.id)).concat(g.remove(door.id));
  check('…and losing every supporting wall brings the roof down', !g.get(c0!.id) && !g.get(c1!.id), roofDrop.map((p) => p.kind).join(','));
  check('foundation 0 survives everything', !!g.get(f0.id));

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n── Walls block creatures; doors control access ──');
  {
    const cols = 40, rows = 40;
    const nav = new NavGrid({ originX: -20, originZ: -20, cellSize: 1, cols, rows, blocked: new Uint8Array(cols * rows), cost: new Uint8Array(cols * rows) });
    const grid = new BuildingGrid({ heightAt: () => 0, staticBlocked: () => false, waterLevel: -5 });
    const events = new EventBus();
    const bnav = new BuildingNav(grid, nav, events, new World());
    const place = (c: Candidate): Piece => {
      const p = grid.insert({ ...c, id: nextId++ });
      events.emit('building:placed', { entity: p.id });
      return p;
    };
    const y = 0.35;
    place({ kind: 'foundation', i: 0, j: 0, y });
    for (const side of ['n', 'e', 'w'] as const) place({ kind: 'wall', i: 0, j: 0, y, side });
    const doorway = place({ kind: 'doorway', i: 0, j: 0, y, side: 's', open: false });
    const paths = new FlowFieldService(nav);
    const reach = (): boolean => {
      const pos = { x: 1.5, z: 12 };
      const dir = { x: 0, z: 0 };
      for (let t = 0; t < 20; t += 1 / 60) {
        paths.beginTick();
        if (!paths.steer(pos.x, pos.z, 1.5, 1.5, dir)) continue;
        const nx = pos.x + dir.x * 4 / 60, nz = pos.z + dir.z * 4 / 60;
        if (nav.isWalkable(nx, nz)) {
          pos.x = nx;
          pos.z = nz;
        }
        if (Math.hypot(pos.x - 1.5, pos.z - 1.5) < 0.8) return true;
      }
      return false;
    };
    check('wolf can\'t get into a closed house', !reach());
    doorway.open = true;
    events.emit('building:door', { entity: doorway.id, open: true });
    check('…but walks in through an open door', reach());
    bnav.dispose();
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n── Crafting queue survives moving / closing the inventory ──');
  {
    const world = new World();
    const events = new EventBus();
    const crafting = new CraftingSystem(events);
    const loop = new GameLoop(world, { scheduler: manual() });
    loop.addSystem(crafting);
    const p = spawnPlayer(world, { x: 0, y: 0, z: 0 });
    const inv = crafting.inventoryOf(world, p);
    inv.add('wood', 10);
    inv.add('stone', 4);
    inv.add('fiber', 8);
    const done: string[] = [];
    events.on('crafting:completed', ({ recipeId }) => done.push(recipeId));
    check('queue two crafts', crafting.start(world, p, 'stone_axe') && crafting.start(world, p, 'torch'));
    const s = world.require(p, SurvivorC);
    s.activity = 'sprinting'; // inventory closed, player running away
    for (let t = 0; t <= 6000; t += 1000 / 60) loop.tick(t);
    check('both finish while the player runs (tools land in the hotbar)', done.join(',') === 'stone_axe,torch' && s.hotbar.some((h) => h?.item === 'stone_axe') && s.hotbar.some((h) => h?.item === 'torch'), done.join(','));
    crafting.start(world, p, 'torch');
    const woodBefore = inv.count('wood');
    crafting.cancel(world, p, 0);
    check('cancelling a queued craft refunds it', inv.count('wood') === woodBefore + 1 && crafting.queueOf(p).length === 0);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n── Creature speeds ──');
  {
    const world = new World();
    const speeds = (['wolf', 'deer', 'boar'] as const).map((sp) => {
      const e = spawnCreature(world, sp, { x: 0, y: 0, z: 0 }, 1);
      return [sp, world.require(e, Creature).runSpeed] as const;
    });
    console.log(`   run speeds: ${speeds.map(([s, v]) => `${s} ${v} m/s`).join(', ')} · player walk ${MOVEMENT.walkSpeed}, sprint ${MOVEMENT.sprintSpeed}`);
    check('a sprinting player outruns every animal', speeds.every(([, v]) => v < MOVEMENT.sprintSpeed));
    check('…but a walking player can\'t outrun a wolf', speeds.find(([s]) => s === 'wolf')![1] > MOVEMENT.walkSpeed);
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n── Save/load buildings; old saves refused ──');
  {
    const map = parseMapConfig({ size: 128, seed: 5 });
    const bundle = await new TerrainService(null).generate(toTerrainConfig(map));
    const world = new World();
    const pop = populateResources(world, bundle);
    spawnPlayer(world, { x: 0, y: 5, z: 0 });
    const grid = new BuildingGrid({ heightAt: () => 0, staticBlocked: () => false, waterLevel: -5 });
    grid.insert({ id: 900, kind: 'foundation', i: 0, j: 0, y: 4.5 });
    grid.insert({ id: 901, kind: 'doorway', i: 0, j: 0, y: 4.5, side: 'e', open: true });
    const json = serializeSnapshot(captureSnapshot(world, { map, cycle: new DayNightCycle(DEFAULT_DAY_NIGHT), populated: pop, buildings: grid }));
    const snap = parseSnapshot(json);
    check('buildings saved with door state', snap.buildings.length === 2 && snap.buildings.some((b) => b.kind === 'doorway' && b.open === true && b.side === 'e'));
    let err = '';
    try {
      parseSnapshot(json.replace('"version":3', '"version":2'));
    } catch (e) {
      err = (e as Error).message;
    }
    check('pre-desert-island (v2) save refused with a clear message', err.includes('island'), err);
    void Transform;
  }

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void CELL;
void main();
