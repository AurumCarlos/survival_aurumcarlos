/**
 * Headless checks for the settings: validation of stored values, and that
 * simulation settings really change the simulation.
 */
import { DEFAULT_GRAPHICS, DEFAULT_SIM, GRAPHICS_DEFS, SIM, SIM_DEFS, applySim, sanitize, type GraphicsSettings } from '../src/data/settings';
import { createSurvivor, SurvivalStatusManager } from '../src/systems/SurvivalStatusManager';
import { DayNightCycle, DEFAULT_DAY_NIGHT } from '../src/systems/DayNightCycle';
import { World } from '../src/core/ecs/World';
import { EventBus } from '../src/core/EventBus';
import { spawnCreature } from '../src/entities/factories';
import { BreedingSystem } from '../src/systems/ai/BreedingSystem';
import { InventoryGrid } from '../src/systems/inventory/InventoryGrid';
import { harvest } from '../src/systems/InteractionSystem';
import { makeResource } from '../src/data/items';

declare const process: { exit(code: number): never };
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

console.log('── Settings ──');
const g = sanitize<GraphicsSettings>(GRAPHICS_DEFS, { detailedTrees: 999, quality: 'ultra', showFps: 'yes', resolution: '0.7', bogus: 1 });
check('stored values are validated: clamped, unknown dropped, bad types reset',
  g.detailedTrees === 80 && g.quality === 'auto' && g.showFps === true && g.resolution === '0.7' && !('bogus' in g));
check('defaults keep the game as it was', DEFAULT_GRAPHICS.detailedTrees === 15 && DEFAULT_SIM.dayLengthMinutes === 20 && SIM_DEFS.every((d) => d.kind.type !== 'range' || (d.default as number) >= d.kind.min && (d.default as number) <= d.kind.max));

const hungerAfter = (rate: number): number => {
  applySim({ hungerRate: rate });
  const s = createSurvivor(1, 't');
  const m = new SurvivalStatusManager(() => 0.99);
  const env = { ambientC: 22, fireWarmthC: 0, shelterInsulation: 0, clothingInsulationC: 0, wet: false };
  for (let i = 0; i < 600; i++) m.tick(s, env, 1);
  return 85 - s.vitals.hunger;
};
const h1 = hungerAfter(1), h2 = hungerAfter(2), h0 = hungerAfter(0);
check('hunger speed ×2 empties the stomach twice as fast; ×0 not at all', Math.abs(h2 / h1 - 2) < 0.05 && h0 === 0, `${h1.toFixed(1)} vs ${h2.toFixed(1)} vs ${h0}`);

applySim({ dayLengthMinutes: 10 });
const cycle = new DayNightCycle({ ...DEFAULT_DAY_NIGHT, dayLengthSeconds: SIM.dayLengthMinutes * 60 });
cycle.advance(5 * 60);
check('a 10-minute day: 5 minutes is half a day', Math.abs(cycle.totalHours - (DEFAULT_DAY_NIGHT.startHour + 12)) < 1e-6);

// Rain frequency: share of 30 game days with rain.
const rainShare = (f: number): number => {
  applySim({ rainFrequency: f, dayLengthMinutes: 20 });
  const c = new DayNightCycle({ ...DEFAULT_DAY_NIGHT, seed: 7 });
  let wet = 0;
  for (let i = 0; i < 30 * 24; i++) { c.advance(20 * 60 / 24); if (c.raining) wet++; }
  return wet / (30 * 24);
};
const r0 = rainShare(0), r1 = rainShare(1), r3 = rainShare(3);
check('rain frequency: ×0 never rains, ×3 rains much more than ×1', r0 === 0 && r3 > r1 * 1.5 && r1 > 0, `${(r1 * 100).toFixed(0)}% → ${(r3 * 100).toFixed(0)}% of hours`);

// Animal limit: a full island stops mating.
{
  const world = new World();
  const events = new EventBus();
  const breed = new BreedingSystem(events, () => true, () => 0, () => 0);
  for (let i = 0; i < 6; i++) spawnCreature(world, 'deer', { x: i * 0.5, y: 0, z: 0 }, i);
  applySim({ maxAnimals: 6, breedChance: 1, breedInterval: 5, gestationSeconds: 0 });
  let born = 0;
  events.on('creature:born', () => born++);
  for (let t = 0; t < 30; t++) breed.fixedUpdate(world, 1);
  const capped = born;
  applySim({ maxAnimals: 0 });
  for (let t = 0; t < 30; t++) breed.fixedUpdate(world, 1);
  check('the animal limit stops mating; 0 means no limit', capped === 0 && born > 0, `${capped} born at the limit, ${born} without`);
}

// Tool durability ×2: a pick lasts twice as many hits.
{
  applySim({ toolDurability: 2, harvestYield: 1 });
  const s = createSurvivor(1, 't');
  s.hotbar[0] = { item: 'stone_pickaxe', qty: 1, durability: 10 };
  const inv = new InventoryGrid(s.inventory);
  let hits = 0;
  while (s.hotbar[0] && hits < 100) {
    harvest(s, inv, makeResource(1, 'rock', { x: 0, y: 0, z: 0 }), () => 0.5);
    hits++;
  }
  check('tool durability ×2: a 10-use pick lasts 20 hits', hits === 20, `${hits} hits`);
}
applySim(DEFAULT_SIM);

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
