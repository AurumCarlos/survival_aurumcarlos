/**
 * Headless checks for the food chain (systems/ai/Ecology.ts and the graze /
 * forage / stalk behaviours in AISystem): eating, starving, hunting,
 * the safety nets, and a few weeks of a real island staying balanced.
 */
import { AIBrain, Creature, ResourceC, Transform } from '../src/components';
import { World } from '../src/core/ecs/World';
import { EventBus } from '../src/core/EventBus';
import { SpatialHash } from '../src/core/SpatialHash';
import { spawnCreature, spawnResource } from '../src/entities/factories';
import { AISystem } from '../src/systems/ai/AISystem';
import { BreedingSystem, BREED_TUNING, applyGrowth, breedState } from '../src/systems/ai/BreedingSystem';
import { ECOLOGY, EcologySystem, ecoState } from '../src/systems/ai/Ecology';
import { straightLinePaths } from '../src/systems/ai/nav/FlowFieldService';
import { DayNightCycle, DEFAULT_DAY_NIGHT } from '../src/systems/DayNightCycle';
import { SurvivalStatusManager } from '../src/systems/SurvivalStatusManager';
import { creatureBudget, parseMapConfig, toTerrainConfig } from '../src/world/MapConfig';
import { spawnPlayer } from '../src/entities/factories';
import { captureSnapshot, parseSnapshot, serializeSnapshot } from '../src/persistence/WorldSnapshot';
import { buildNavGrid } from '../src/systems/ai/nav/NavGrid';
import { generateTerrain } from '../src/world/TerrainGenerator';
import { populateResources } from '../src/world/WorldPopulator';
import { runEcology } from './simulate-ecology';

declare const process: { exit(code: number): never };
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

/** Open flat ground: AI + ecology + a resource index. */
function arena() {
  const world = new World();
  const events = new EventBus();
  const resources = new SpatialHash(8);
  const ai = new AISystem({
    groundHeight: () => 0, paths: straightLinePaths, cycle: new DayNightCycle(DEFAULT_DAY_NIGHT), survival: new SurvivalStatusManager(),
    events, resources,
  });
  const eco = new EcologySystem({ events, resources, isWalkable: () => true, groundHeight: () => 0, half: 200, rng: () => 0.5 });
  const run = (sec: number, dt = 1 / 20): void => {
    for (let t = 0; t < sec; t += dt) {
      ai.fixedUpdate(world, dt);
      eco.fixedUpdate(world, dt);
      world.flush();
    }
  };
  const resource = (kind: 'berry_bush' | 'carcass', x: number, z: number) => {
    const e = spawnResource(world, kind, { x, y: 0, z });
    resources.insert(e, x, z);
    return e;
  };
  return { world, events, resources, run, resource, eco };
}

console.log('── Eating and starving ──');
{
  const { world, run, resource, events } = arena();
  const bush = resource('berry_bush', 12, 0);
  const deer = spawnCreature(world, 'deer', { x: 0, y: 0, z: 0 }, 2, 2);
  ecoState(world, deer).food = 0.3;
  let depleted = 0;
  events.on('resource:depleted', () => depleted++);
  run(40);
  const r = world.require(bush, ResourceC);
  check('a hungry deer walks to a berry bush and eats it bite by bite', ecoState(world, deer).food > 0.4 && r.hitPoints < r.maxHitPoints,
    `food ${ecoState(world, deer).food.toFixed(2)}, bush ${r.hitPoints}/${r.maxHitPoints}`);
  run(30);
  check('…until the bush is bare (it then regrows like a picked one)', r.hitPoints === 0 && depleted === 1 && r.respawnTimer > 0);
  const home = world.require(deer, AIBrain).blackboard.home;
  check('its range drifts toward the food it found', Math.hypot(home.x - 12, home.z) < 6, `home (${home.x.toFixed(1)}, ${home.z.toFixed(1)})`);

  const starving = spawnCreature(world, 'deer', { x: 100, y: 0, z: 0 }, 4, 2);
  ecoState(world, starving).food = 0;
  let died = '';
  events.on('creature:died', ({ cause }) => (died = cause));
  run(ECOLOGY.deer.starveSeconds + 5, 0.5);
  check('with nothing to eat, an empty belly kills it and leaves a carcass',
    !world.has(starving, Creature) && world.get(starving, ResourceC)?.kind === 'carcass' && died === 'starvation');

  const fawn = spawnCreature(world, 'deer', { x: -100, y: 0, z: 0 }, 6, 2);
  world.require(fawn, Creature).growth = 0.3;
  applyGrowth(world, fawn);
  ecoState(world, fawn).food = 0;
  run(20, 0.5);
  check('the young are fed by their mother', ecoState(world, fawn).food === 1 && world.has(fawn, Creature));
}

console.log('\n── Wolves hunt ──');
{
  const { world, run, resource } = arena();
  const carcass = resource('carcass', 10, 0);
  const wolf = spawnCreature(world, 'wolf', { x: 0, y: 0, z: 0 }, 5, 2);
  ecoState(world, wolf).food = 0.2;
  run(30);
  const left = world.get(carcass, ResourceC)?.hitPoints ?? 0;
  check('a hungry wolf smells a carcass and eats its fill (leftovers stay for the pack)', ecoState(world, wolf).food > 0.9 && left < 4,
    `food ${ecoState(world, wolf).food.toFixed(2)}, ${left}/4 portions left`);
}
{
  const { world, run, events } = arena();
  for (let i = 0; i < ECOLOGY.minRefuge; i++) spawnCreature(world, 'deer', { x: 200 + i * 3, y: 0, z: 200 }, 100 + i * 2, 2);
  const fawn = spawnCreature(world, 'deer', { x: 20, y: 0, z: 0 }, 8, 2);
  world.require(fawn, Creature).growth = 0.3; // slow and weak
  applyGrowth(world, fawn);
  const wolf = spawnCreature(world, 'wolf', { x: 0, y: 0, z: 0 }, 5, 2);
  ecoState(world, wolf).food = 0.2;
  let killed = false;
  events.on('creature:died', ({ cause, species }) => (killed ||= cause === 'predator' && species === 'deer'));
  run(60);
  check('a hungry wolf stalks a deer, runs it down, kills it and eats the carcass', killed && ecoState(world, wolf).food > 0.4,
    `killed ${killed}, wolf food ${ecoState(world, wolf).food.toFixed(2)}`);
}
{
  const { world, run, events } = arena();
  for (let i = 0; i < ECOLOGY.minRefuge; i++) spawnCreature(world, 'deer', { x: 300 + i * 3, y: 0, z: 300 }, 100 + i * 2, 2);
  const stag = spawnCreature(world, 'deer', { x: 18, y: 0, z: 0 }, 9, 2);
  ecoState(world, stag).food = 1;
  const wolf = spawnCreature(world, 'wolf', { x: 0, y: 0, z: 0 }, 5, 2);
  ecoState(world, wolf).food = 0.3;
  let killed = false;
  events.on('creature:died', () => (killed = true));
  run(40);
  check('a healthy adult deer with a head start outruns a lone wolf (the chase is abandoned)',
    !killed && world.has(stag, Creature) && ecoState(world, wolf).huntRest > 0);
}
{
  const { world, run, events } = arena();
  for (let i = 0; i < ECOLOGY.minRefuge; i++) spawnCreature(world, 'deer', { x: 15 + i * 3, y: 0, z: 0 }, 100 + i * 2, 2);
  const wolf = spawnCreature(world, 'wolf', { x: 0, y: 0, z: 0 }, 5, 2);
  ecoState(world, wolf).food = 0.2;
  let killed = false;
  events.on('creature:died', ({ cause }) => (killed ||= cause === 'predator'));
  run(30);
  check(`with only ${ECOLOGY.minRefuge} deer left, wolves leave them alone`, !killed && ecoState(world, wolf).target === null);
}

console.log('\n── Safety nets and breeding ──');
{
  const { world, run, eco } = arena();
  run(ECOLOGY.newcomers.every + 1, 0.5);
  const deer = [...world.query(Creature)].filter((e) => world.require(e, Creature).species === 'deer');
  check('if deer nearly die out, a pair (male and female) arrives', deer.length === 2 && eco.census.deer === 2 &&
    new Set(deer.map((e) => breedState(world, e).sex)).size === 2);
}
{
  const world = new World();
  const events = new EventBus();
  const breed = new BreedingSystem(events, () => true, () => 0, () => 0);
  const buck = spawnCreature(world, 'deer', { x: 0, y: 0, z: 0 }, 1);
  const doe = spawnCreature(world, 'deer', { x: 1, y: 0, z: 0 }, 2);
  void buck;
  ecoState(world, doe).food = 0.2;
  for (let t = 0; t < BREED_TUNING.interval * 3; t++) breed.fixedUpdate(world, 1);
  const hungryPregnant = breedState(world, doe).pregnant !== undefined;
  ecoState(world, doe).food = 0.9;
  for (let t = 0; t < BREED_TUNING.interval * 3; t++) breed.fixedUpdate(world, 1);
  check('a hungry doe doesn’t conceive; a well-fed one does', !hungryPregnant && breedState(world, doe).pregnant !== undefined);
}

console.log('\n── Saves ──');
{
  const map = parseMapConfig({ size: 128, seed: 5, gen: 4 });
  const t = generateTerrain(toTerrainConfig(map));
  const world = new World();
  const pop = populateResources(world, { terrain: t, nav: buildNavGrid(t) });
  spawnPlayer(world, { x: 0, y: 2, z: 0 });
  const states = ['graze', 'feed', 'stalk'] as const;
  states.forEach((st, i) => {
    const e = spawnCreature(world, i === 2 ? 'wolf' : 'deer', { x: 10 + i * 3, y: 1, z: 0 }, 40 + i);
    world.require(e, AIBrain).blackboard.state = st;
    ecoState(world, e).food = 0.42;
  });
  const snap = { ...captureSnapshot(world, { map, cycle: new DayNightCycle(DEFAULT_DAY_NIGHT), populated: pop }), savedAt: 1, summary: { day: 1, secondsSurvived: 1 } };
  let ok = true, why = '';
  try {
    const back = parseSnapshot(serializeSnapshot(snap));
    ok = states.every((st) => back.creatures.some((c) => c.blackboard.state === st && c.blackboard.eco?.food === 0.42));
  } catch (e) {
    ok = false;
    why = String(e);
  }
  check('a save with animals grazing, eating and stalking loads back (with their hunger)', ok, why);
}

console.log('\n── A real island over 10 days ──');
{
  const size = 256, seed = 777;
  const budget = creatureBudget(parseMapConfig({ size, seed }));
  const r = runEcology(10, size, seed, 0.25);
  const deer = r.days.map((d) => d.deer), wolves = r.days.map((d) => d.wolf);
  const tail = deer.slice(-5);
  check('deer never die out', Math.min(...deer) >= 1, `deer per day: ${deer.join(' ')}`);
  check('and never overrun the island (no cap needed)', Math.max(...deer) <= budget.deer * 3, `max ${Math.max(...deer)} (start ${budget.deer})`);
  check('a healthy herd most of the time', tail.reduce((a, b) => a + b, 0) / tail.length >= budget.deer * 0.5, `last 5 days avg ${(tail.reduce((a, b) => a + b, 0) / tail.length).toFixed(1)}`);
  check('wolves hunt them (and live on)', (r.deaths['deer:predator'] ?? 0) > 0 && Math.min(...wolves.slice(-5)) >= 1, `wolves per day: ${wolves.join(' ')}`);
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
void Transform;
