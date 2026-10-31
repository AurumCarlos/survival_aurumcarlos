/**
 * Headless checks for the test-mode loadout (New world → Test mode).
 */
import { SurvivorC } from '../src/components';
import { World } from '../src/core/ecs/World';
import { spawnPlayer } from '../src/entities/factories';
import { InventoryGrid } from '../src/systems/inventory/InventoryGrid';
import { TEST_BAG, giveTestKit } from '../src/systems/TestKit';
import { parseMapConfig } from '../src/world/MapConfig';

declare const process: { exit(code: number): never };
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

console.log('── Test mode ──');
const world = new World();
const p = spawnPlayer(world, { x: 0, y: 0, z: 0 });
const s = world.require(p, SurvivorC);
s.inventory.cols = TEST_BAG.cols;
s.inventory.rows = TEST_BAG.rows;
const bag = new InventoryGrid(s.inventory);
const lost = giveTestKit(s, bag);
check('the whole test kit fits in the bag', lost.length === 0, lost.join(', '));
check('best weapons and tools fill the hotbar', s.hotbar.every((h) => h !== null) && s.hotbar[0]?.item === 'metal_sword', s.hotbar.map((h) => h?.item).join(', '));
check('wearing the strongest armour', s.equipped.body?.item === 'flak_armor');
check('stacks of resources', bag.count('metal_ingot') >= 300 && bag.count('wood') >= 300 && bag.count('stone_arrow') >= 200);
check('every crafting station kit', ['smithy_kit', 'refining_forge_kit', 'fabricator_kit', 'cooking_pot_kit'].every((k) => bag.count(k as never) === 1));
check('test mode is kept in the map config (and so in saves)',
  parseMapConfig({ size: 256, seed: 1, testMode: true }).testMode === true && parseMapConfig({ size: 256, seed: 1 }).testMode === undefined);

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
