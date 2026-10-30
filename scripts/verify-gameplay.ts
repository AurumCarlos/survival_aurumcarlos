/**
 * Headless checks for: tools mattering, meat from kills, melee reach,
 * the Firefox alt-tab freeze, and building costs.
 */
import { SurvivorC } from '../src/components';
import { World } from '../src/core/ecs/World';
import { GameLoop, type FrameScheduler, type PauseReason } from '../src/core/GameLoop';
import { makeResource } from '../src/data/items';
import type { ItemStack, ResourceKind } from '../src/data/schema';
import { spawnPlayer } from '../src/entities/factories';
import { MELEE_REACH } from '../src/data/combat';
import { BuildingGrid, PIECE_COSTS } from '../src/systems/building/BuildingGrid';
import { harvest, toolEffect } from '../src/systems/InteractionSystem';
import { InventoryGrid } from '../src/systems/inventory/InventoryGrid';
import { mulberry32 } from '../src/world/Noise';

declare const process: { exit(code: number): never };
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Harvest a fresh resource until depleted; returns swings, items and seconds of animation. */
function gather(kind: ResourceKind, held: ItemStack | null, item: 'wood' | 'stone' | 'raw_meat') {
  const world = new World();
  const p = spawnPlayer(world, { x: 0, y: 0, z: 0 });
  const s = world.require(p, SurvivorC);
  s.hotbar[0] = held ? { ...held } : null;
  s.activeHotbarSlot = 0;
  const inv = new InventoryGrid(s.inventory);
  const rng = mulberry32(42);
  let swings = 0;
  // Averaged over 10 nodes: single nodes are too random to compare tools.
  const NODES = 10;
  let fx: ReturnType<typeof toolEffect> = null;
  for (let n = 0; n < NODES; n++) {
    const r = makeResource(1, kind, { x: 0, y: 0, z: 0 });
    fx = toolEffect(r, s.hotbar[0] ?? null);
    if (s.hotbar[0]?.durability !== undefined) s.hotbar[0].durability = 999;
    let k = 0;
    while (r.hitPoints > 0 && k++ < 50) {
      harvest(s, inv, r, rng);
      swings++;
    }
  }
  swings /= NODES;
  const items = inv.count(item) / NODES;
  const seconds = (swings * 0.62) / (fx?.speed ?? 1); // harvest clip is 0.62 s at speed 1
  return { swings, items, seconds, perSecond: items / seconds, fit: fx?.fit };
}

console.log('\n── Tools matter ──');
const axe: ItemStack = { item: 'stone_axe', qty: 1, durability: 120 };
const pick: ItemStack = { item: 'stone_pickaxe', qty: 1, durability: 120 };
const spear: ItemStack = { item: 'stone_spear', qty: 1, durability: 60 };
const rows: Array<[string, ReturnType<typeof gather>]> = [
  ['tree / hands', gather('tree', null, 'wood')],
  ['tree / pickaxe', gather('tree', pick, 'wood')],
  ['tree / axe', gather('tree', axe, 'wood')],
  ['rock / hands', gather('rock', null, 'stone')],
  ['rock / axe', gather('rock', axe, 'stone')],
  ['rock / pickaxe', gather('rock', pick, 'stone')],
  ['carcass / hands', gather('carcass', null, 'raw_meat')],
  ['carcass / spear', gather('carcass', spear, 'raw_meat')],
];
for (const [label, r] of rows) console.log(`   ${label.padEnd(17)} ${r.swings.toFixed(1).padStart(4)} swings → ${r.items.toFixed(1).padStart(4)} items in ${r.seconds.toFixed(1)} s (${r.perSecond.toFixed(2)}/s)`);
const get = (l: string) => rows.find(([x]) => x === l)![1];
check('pickaxe mines stone ≥ 4× faster than bare hands', get('rock / pickaxe').perSecond >= 4 * get('rock / hands').perSecond);
check('pickaxe beats the axe on rock', get('rock / pickaxe').perSecond > 2 * get('rock / axe').perSecond);
check('axe chops wood ≥ 4× faster than bare hands', get('tree / axe').perSecond >= 4 * get('tree / hands').perSecond);
check('axe beats the pickaxe on trees', get('tree / axe').perSecond > 2 * get('tree / pickaxe').perSecond);
check('the right tool needs half the swings and yields ≥ 2× more per node', get('rock / pickaxe').swings <= get('rock / hands').swings / 2 && get('tree / axe').items >= 2 * get('tree / hands').items);
{
  const r = makeResource(1, 'berry_bush', { x: 0, y: 0, z: 0 });
  check('an axe does not boost berry picking', toolEffect(r, axe)?.yieldMult === 1);
}

console.log('\n── Meat from kills ──');
check('a carcass can be butchered by hand', get('carcass / hands').items > 0, `${get('carcass / hands').items} raw meat`);
check('…and the spear yields much more', get('carcass / spear').items >= 2 * get('carcass / hands').items, `${get('carcass / spear').items} raw meat`);

console.log('\n── Melee reach ──');
check('fist ≥ 3 m, tools ≥ 3.5 m, spear ≥ 4 m (was 2.2 m for all)', MELEE_REACH.fist >= 3 && MELEE_REACH.tool >= 3.5 && MELEE_REACH.spear >= 4);

console.log('\n── Alt-tab freeze (Firefox event order) ──');
{
  const manual: FrameScheduler = { now: () => 0, request: () => 0, cancel: () => undefined };
  const loop = new GameLoop(new World(), { scheduler: manual });
  const seen: string[] = [];
  let appState = 'playing' as 'playing' | 'paused';
  // Same rule App uses: a 'user' pause while playing opens the pause menu.
  loop.onPauseChange((_p, reasons: ReadonlySet<PauseReason>) => {
    seen.push([...reasons].join('+') || 'running');
    if (reasons.has('user') && appState === 'playing') appState = 'paused';
  });
  loop.pause('blur'); // Firefox: window blur first…
  loop.pause('user'); // …then pointer lock is released
  check('the app hears about the user pause even after blur', (appState as string) === 'paused', seen.join(' → '));
  loop.resume('blur'); // come back to Firefox
  check('coming back leaves the game paused on the pause menu (not frozen)', loop.isPaused && (appState as string) === 'paused');
  loop.resume('user'); // click Resume
  check('Resume restarts the game', !loop.isPaused);
}

console.log('\n── Building costs ──');
const total = (k: keyof typeof PIECE_COSTS) => PIECE_COSTS[k].reduce((a, c) => a + c.qty, 0);
console.log(`   foundation ${PIECE_COSTS.foundation.map((c) => `${c.qty} ${c.item}`).join(' + ')}, wall ${total('wall')} wood, ceiling ${total('ceiling')} wood`);
const hut = PIECE_COSTS.foundation.concat(...Array(3).fill(PIECE_COSTS.wall), PIECE_COSTS.doorway, PIECE_COSTS.ceiling);
const hutWood = hut.filter((c) => c.item === 'wood').reduce((a, c) => a + c.qty, 0);
check('a 1-room hut (foundation, 3 walls, door, roof) costs ≤ 12 wood', hutWood <= 12, `${hutWood} wood (was 24)`);
check('demolishing refunds half, rounded up', BuildingGrid.refund('wall')[0]?.qty === 1);

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
