/**
 * Headless checks for round 7: ARK resources and recipes, cooking/smelting
 * stations, storage boxes, the new tools, stairs rules and save format v4.
 */
import { HeatSource, Structure, SurvivorC, Transform } from '../src/components';
import { World } from '../src/core/ecs/World';
import { EventBus } from '../src/core/EventBus';
import { BUSH_BERRIES, CARCASS_OF, ITEMS, RESOURCE_TEMPLATES, makeResource } from '../src/data/items';
import { RECIPES } from '../src/data/recipes';
import { ITEM_IDS, type ItemId, type ItemStack, type ResourceKind } from '../src/data/schema';
import { PLACEABLE_KINDS, STRUCTURES } from '../src/data/stations';
import { spawnPlayer, spawnStructure } from '../src/entities/factories';
import { applySnapshot, captureSnapshot, parseSnapshot, serializeSnapshot } from '../src/persistence/WorldSnapshot';
import { BuildingGrid } from '../src/systems/building/BuildingGrid';
import { DayNightCycle, DEFAULT_DAY_NIGHT } from '../src/systems/DayNightCycle';
import { harvest, toolEffect } from '../src/systems/InteractionSystem';
import { CraftingSystem } from '../src/systems/inventory/CraftingSystem';
import { InventoryGrid } from '../src/systems/inventory/InventoryGrid';
import { StationSystem } from '../src/systems/StationSystem';
import { parseMapConfig, toTerrainConfig } from '../src/world/MapConfig';
import { mulberry32 } from '../src/world/Noise';
import { generateTerrain } from '../src/world/TerrainGenerator';
import { buildNavGrid } from '../src/systems/ai/nav/NavGrid';
import { populateResources } from '../src/world/WorldPopulator';

declare const process: { exit(code: number): never };
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

console.log('\n── ARK resources and recipes ──');
{
  const known = new Set<string>(ITEM_IDS);
  const bad: string[] = [];
  for (const r of RECIPES) for (const io of [...r.inputs, r.output]) if (!known.has(io.item)) bad.push(`${r.id}:${io.item}`);
  for (const k of PLACEABLE_KINDS) for (const r of STRUCTURES[k].processes) for (const io of [...r.inputs, r.output]) if (!known.has(io.item)) bad.push(`${k}:${io.item}`);
  check('every recipe uses real items', bad.length === 0, bad.join(', '));
  check('every item has a definition', ITEM_IDS.every((id) => ITEMS[id]?.id === id));

  // Where each item comes from: nodes, carcasses, recipes, station processes, burning wood.
  const sources = new Set<ItemId>();
  for (const t of Object.values(RESOURCE_TEMPLATES)) for (const y of t.yields) sources.add(y.item);
  for (const pair of BUSH_BERRIES) pair.forEach((b) => sources.add(b));
  for (const v of [0, 1, 2]) makeResource(1, 'carcass', { x: 0, y: 0, z: 0 }, v).yields.forEach((y) => sources.add(y.item));
  for (const r of RECIPES) sources.add(r.output.item);
  for (const k of PLACEABLE_KINDS) for (const r of STRUCTURES[k].processes) sources.add(r.output.item);
  sources.add('charcoal');
  const orphans = ITEM_IDS.filter((id) => !sources.has(id));
  check('every item can be obtained (gathered, butchered, crafted, cooked or smelted)', orphans.length === 0, orphans.join(', '));
  const ark: ItemId[] = ['wood', 'thatch', 'stone', 'flint', 'fiber', 'hide', 'pelt', 'keratin', 'chitin', 'metal', 'metal_ingot', 'obsidian', 'crystal', 'oil',
    'silica_pearls', 'black_pearl', 'sulfur', 'charcoal', 'sparkpowder', 'gunpowder', 'cementing_paste', 'polymer', 'electronics', 'gasoline',
    'narcotic', 'stimulant', 'raw_prime_meat', 'raw_fish', 'jerky', 'amarberry', 'azulberry', 'tintoberry', 'narcoberry', 'stimberry', 'rare_flower', 'rare_mushroom'];
  check(`ARK base resources present (${ark.length})`, ark.every((id) => known.has(id)));
  check('every placeable has a recipe', PLACEABLE_KINDS.every((k) => RECIPES.some((r) => r.output.item === STRUCTURES[k].kit)));
  check(`${RECIPES.length} crafting recipes, ${PLACEABLE_KINDS.reduce((n, k) => n + STRUCTURES[k].processes.length, 0)} cooking/smelting recipes`, RECIPES.length >= 35);
}

console.log('\n── Gathering: right tool, ARK-style yields ──');
{
  const gather = (kind: ResourceKind, held: ItemStack | null, nodes = 20, variant = 0): Map<ItemId, number> => {
    const world = new World();
    const p = spawnPlayer(world, { x: 0, y: 0, z: 0 });
    const s = world.require(p, SurvivorC);
    s.inventory.cols = 20;
    s.inventory.rows = 20;
    s.hotbar[0] = held ? { ...held } : null;
    const inv = new InventoryGrid(s.inventory);
    const rng = mulberry32(5);
    for (let n = 0; n < nodes; n++) {
      const r = makeResource(1, kind, { x: 0, y: 0, z: 0 }, variant);
      if (s.hotbar[0]) s.hotbar[0].durability = 999;
      for (let k = 0; k < 40 && r.hitPoints > 0; k++) if (harvest(s, inv, r, rng).blocked) break;
    }
    const out = new Map<ItemId, number>();
    for (const pl of inv.placements) out.set(pl.stack.item, (out.get(pl.stack.item) ?? 0) + pl.stack.qty);
    return out;
  };
  const pick: ItemStack = { item: 'stone_pickaxe', qty: 1, durability: 999 };
  const mpick: ItemStack = { item: 'metal_pick', qty: 1, durability: 999 };
  const axe: ItemStack = { item: 'stone_axe', qty: 1, durability: 999 };
  const sickle: ItemStack = { item: 'metal_sickle', qty: 1, durability: 999 };
  check('metal rocks can’t be mined by hand', toolEffect(makeResource(1, 'metal_rock', { x: 0, y: 0, z: 0 }), null) === null);
  const ore = gather('metal_rock', pick).get('metal') ?? 0, ore2 = gather('metal_rock', mpick).get('metal') ?? 0;
  check('a pickaxe mines metal ore; the metal pick gets ≥ 1.4× more', ore > 0 && ore2 >= ore * 1.4, `${ore} → ${ore2}`);
  const handTree = gather('tree', null), axeTree = gather('tree', axe);
  check('thatch comes off trees by hand, wood with the axe (ARK)', (handTree.get('thatch') ?? 0) > (axeTree.get('thatch') ?? 0) * 1.5 && (axeTree.get('wood') ?? 0) > (handTree.get('wood') ?? 0) * 2,
    `hand ${handTree.get('wood')} wood/${handTree.get('thatch')} thatch, axe ${axeTree.get('wood')}/${axeTree.get('thatch')}`);
  const f1 = gather('fiber_plant', null).get('fiber') ?? 0, f2 = gather('fiber_plant', sickle).get('fiber') ?? 0;
  check('the sickle ≈ triples fiber', f2 >= f1 * 2.5, `${f1} → ${f2}`);
  const rocks = gather('rock', pick);
  check('rocks give stone and flint', (rocks.get('stone') ?? 0) > 0 && (rocks.get('flint') ?? 0) > 0);
  const shells = gather('shell_bed', pick, 60);
  check('shell beds give silica pearls and chitin (black pearls are rare)', (shells.get('silica_pearls') ?? 0) > 0 && (shells.get('chitin') ?? 0) > 0, `black pearls: ${shells.get('black_pearl') ?? 0}`);
  const wolf = gather('carcass', { item: 'stone_spear', qty: 1, durability: 999 }, 20, CARCASS_OF['wolf']!);
  const boar = gather('carcass', { item: 'stone_spear', qty: 1, durability: 999 }, 20, CARCASS_OF['boar']!);
  check('wolves give pelts, boars keratin and prime meat', (wolf.get('pelt') ?? 0) > 0 && (boar.get('keratin') ?? 0) > 0 && (boar.get('raw_prime_meat') ?? 0) > 0);
  const bushes = new Set<ItemId>();
  for (let v = 0; v < 4; v++) for (const k of gather('berry_bush', null, 5, v).keys()) bushes.add(k);
  check('berry bushes grow the six ARK berries', ['berries', 'amarberry', 'azulberry', 'tintoberry', 'narcoberry', 'stimberry'].every((b) => bushes.has(b as ItemId)));
}

console.log('\n── Stations: cooking and smelting by themselves ──');
{
  const world = new World();
  const events = new EventBus();
  const stations = new StationSystem(events);
  const run = (seconds: number): void => {
    for (let t = 0; t < seconds; t += 0.1) stations.fixedUpdate(world, 0.1);
  };
  // Campfire: raw meat + wood. (The fresh-campfire 10 min of fuel is used up first.)
  const fire = spawnStructure(world, 'campfire', { x: 0, y: 0, z: 0 }, { fuelSeconds: 0, lit: false });
  const box = stations.containerOf(world, fire)!;
  box.add('raw_meat', 3);
  check('a cold fire can’t be lit without fuel', !stations.setLit(world, fire, true));
  box.add('wood', 2);
  check('…lit once there is wood inside', stations.setLit(world, fire, true) && world.require(fire, HeatSource).lit);
  run(25);
  check('meat cooks by itself (8 s each)', box.count('cooked_meat') === 3 && box.count('raw_meat') === 0, `${box.count('cooked_meat')} cooked`);
  check('burnt wood leaves charcoal', box.count('charcoal') >= 1 && box.count('wood') <= 1, `${box.count('charcoal')} charcoal, ${box.count('wood')} wood left`);
  // Run until the fuel is gone: the fire goes out (EnvironmentSystem burns fuelSeconds).
  const h = world.require(fire, HeatSource);
  for (let t = 0; t < 200 && h.lit; t += 0.1) {
    stations.fixedUpdate(world, 0.1);
    h.fuelSeconds -= 0.1;
    if (h.fuelSeconds <= 0) h.lit = false;
  }
  check('with no fuel left the fire goes out', !h.lit && box.count('wood') === 0);

  // Forge: metal → ingots; nothing happens while cold.
  const forge = spawnStructure(world, 'refining_forge', { x: 5, y: 0, z: 0 });
  const fb = stations.containerOf(world, forge)!;
  fb.add('metal', 6);
  fb.add('wood', 5);
  run(15);
  check('a cold forge smelts nothing', fb.count('metal_ingot') === 0);
  stations.setLit(world, forge, true);
  for (let t = 0; t < 32; t += 0.1) {
    stations.fixedUpdate(world, 0.1);
    world.require(forge, HeatSource).fuelSeconds -= 0.1;
  }
  check('a lit forge turns 6 metal into 3 ingots in ~30 s', fb.count('metal_ingot') === 3 && fb.count('metal') === 0, `${fb.count('metal_ingot')} ingots`);
  fb.add('oil', 2);
  fb.add('hide', 1);
  for (let t = 0; t < 16; t += 0.1) {
    stations.fixedUpdate(world, 0.1);
    world.require(forge, HeatSource).fuelSeconds -= 0.1;
  }
  check('forge: oil + hide → gasoline', fb.count('gasoline') === 2);

  // Preserving bin: no fuel.
  const bin = spawnStructure(world, 'preserving_bin', { x: 9, y: 0, z: 0 });
  const bb = stations.containerOf(world, bin)!;
  bb.add('cooked_meat', 1);
  bb.add('oil', 1);
  bb.add('sparkpowder', 1);
  run(21);
  check('preserving bin makes jerky without fuel', bb.count('jerky') === 1);

  // Cooking pot: medical brew.
  const pot = spawnStructure(world, 'cooking_pot', { x: 12, y: 0, z: 0 });
  const pb = stations.containerOf(world, pot)!;
  pb.add('tintoberry', 10);
  pb.add('narcotic', 1);
  pb.add('water_raw', 1);
  pb.add('thatch', 5);
  stations.setLit(world, pot, true);
  for (let t = 0; t < 16; t += 0.1) {
    stations.fixedUpdate(world, 0.1);
    world.require(pot, HeatSource).fuelSeconds -= 0.1;
  }
  check('cooking pot brews Medical Brew', pb.count('medical_brew') === 1);

  // Storage box.
  const chest = spawnStructure(world, 'storage_box', { x: 0, y: 0, z: 5 });
  const cb = stations.containerOf(world, chest)!;
  check('storage box holds 24 slots', cb.cols * cb.rows === 24 && cb.add('stone', 2400) === 0 && cb.add('stone', 1) === 1);
}

console.log('\n── Crafting stations ──');
{
  const world = new World();
  const events = new EventBus();
  const crafting = new CraftingSystem(events);
  const p = spawnPlayer(world, { x: 0, y: 0, z: 0 });
  const inv = crafting.inventoryOf(world, p);
  inv.add('flint', 4);
  inv.add('stone', 2);
  const ctx = (): { nearbyStations: ReturnType<CraftingSystem['stationsNear']> } => ({ nearbyStations: crafting.stationsNear(world, p) });
  const far = crafting.engine.check(inv, 'sparkpowder', ctx());
  check('sparkpowder needs a Mortar & Pestle', !far.ok && far.reason === 'missing-station');
  spawnStructure(world, 'mortar_pestle', { x: 1.5, y: 0, z: 0 });
  check('…and can be made standing next to one', crafting.engine.check(inv, 'sparkpowder', ctx()).ok);
  const fab = spawnStructure(world, 'fabricator', { x: -1.5, y: 0, z: 0 });
  check('the Fabricator only works when powered', !ctx().nearbyStations.has('fabricator'));
  const st = new StationSystem(events);
  st.containerOf(world, fab)!.add('gasoline', 1);
  st.setLit(world, fab, true);
  check('…with gasoline it is', ctx().nearbyStations.has('fabricator'));
  const fp = world.require(fab, Transform).position;
  fp.y = 3.2; // one storey up: no longer "next to" it
  check('a station on another floor does not count', !ctx().nearbyStations.has('fabricator'));
}

console.log('\n── Stairs ──');
{
  const g = new BuildingGrid({ heightAt: () => 1, staticBlocked: () => false, waterLevel: -5 });
  let id = 1;
  g.insert({ id: id++, kind: 'foundation', i: 0, j: 0, y: 1.4 });
  g.insert({ id: id++, kind: 'foundation', i: 1, j: 0, y: 1.4 });
  check('stairs need a floor', g.validate({ kind: 'stairs', i: 5, j: 5, y: 1.4, side: 'e' }, null) !== null);
  check('stairs on a foundation are valid', g.validate({ kind: 'stairs', i: 0, j: 0, y: 1.4, side: 'e' }, null) === null);
  g.insert({ id: id++, kind: 'stairs', i: 0, j: 0, y: 1.4, side: 'e' });
  check('a bed can’t share the stairs’ cell', g.validate({ kind: 'bed', i: 0, j: 0, y: 1.4, side: 'n' }, null) !== null);
  check('a wall can’t block the top of the stairs', g.validate({ kind: 'wall', i: 0, j: 0, y: 1.4, side: 'e' }, null) !== null);
  check('the landing at the top is supported by the stairs (no wall needed)', g.validate({ kind: 'ceiling', i: 1, j: 0, y: 4.4 }, null) === null);
  check('no ceiling over the stairwell', g.validate({ kind: 'ceiling', i: 0, j: 0, y: 4.4 }, null) !== null);
  const bottom = g.stairsSurfaceAt(0.2, 1.5, 1.4), mid = g.stairsSurfaceAt(1.5, 1.5, 3), top = g.stairsSurfaceAt(2.95, 1.5, 4.4);
  check('stairs surface climbs one storey (1.4 → 4.4)', bottom !== null && mid !== null && top !== null && bottom < 1.8 && Math.abs(mid - 2.9) < 0.3 && top > 4.2,
    `${bottom?.toFixed(2)} / ${mid?.toFixed(2)} / ${top?.toFixed(2)}`);
  check('beside the flight there is no stairs surface', g.stairsSurfaceAt(1.5, 0.2, 3) === null);
}

console.log('\n── Save v4: structures with contents ──');
{
  const map = parseMapConfig({ size: 128, seed: 4 });
  const terrain = generateTerrain(toTerrainConfig(map));
  const bundle = { terrain, nav: buildNavGrid(terrain) };
  const A = new World();
  const pop = populateResources(A, bundle);
  spawnPlayer(A, { x: 0, y: 2, z: 0 });
  const chest = spawnStructure(A, 'large_storage_box', { x: 3, y: 2, z: 1 }, { yaw: 1.2 });
  const st = new StationSystem(new EventBus());
  st.containerOf(A, chest)!.add('metal_ingot', 42);
  const forge = spawnStructure(A, 'refining_forge', { x: 6, y: 2, z: 1 }, { lit: true, fuelSeconds: 33 });
  A.require(forge, Structure).processing = { recipeId: 'smelt_metal', progress: 4.5 };
  const json = serializeSnapshot(captureSnapshot(A, { map, cycle: new DayNightCycle(DEFAULT_DAY_NIGHT), populated: pop }));
  const B = new World();
  const popB = populateResources(B, bundle);
  applySnapshot(B, parseSnapshot(json), popB, new DayNightCycle(DEFAULT_DAY_NIGHT));
  const boxes = [...B.query(Structure)].map((e) => ({ e, s: B.require(e, Structure) }));
  const lb = boxes.find((b) => b.s.kind === 'large_storage_box');
  const fg = boxes.find((b) => b.s.kind === 'refining_forge');
  check('storage box restored with its items and rotation', !!lb && new InventoryGrid(lb.s.container!).count('metal_ingot') === 42 && Math.abs(lb.s.yaw - 1.2) < 1e-6);
  check('forge restored lit, with fuel and smelting progress', !!fg && B.require(fg.e, HeatSource).lit && B.require(fg.e, HeatSource).fuelSeconds === 33 && fg.s.processing.progress === 4.5);
  // A v3 save (old campfire format, 8×5 bag) still loads.
  const v3 = JSON.parse(json) as Record<string, unknown> & { structures: unknown[]; player: { survivor: { inventory: { cols: number; rows: number } } } };
  v3['version'] = 3;
  v3.structures = [{ kind: 'campfire', position: { x: 1, y: 2, z: 1 }, fuelSeconds: 120, lit: true }, { kind: 'lean_to', position: { x: 4, y: 2, z: 4 } }];
  v3.player.survivor.inventory.cols = 8;
  v3.player.survivor.inventory.rows = 5;
  const C = new World();
  const popC = populateResources(C, bundle);
  const res = applySnapshot(C, parseSnapshot(JSON.stringify(v3)), popC, new DayNightCycle(DEFAULT_DAY_NIGHT));
  const inv = C.require(res.player, SurvivorC).inventory;
  check('v3 saves load: campfire and lean-to come back, bag grows to 10×6', [...C.query(Structure)].length === 2 && [...C.query(HeatSource)].length === 1 && inv.cols === 10 && inv.rows === 6);
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
