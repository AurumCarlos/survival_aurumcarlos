/**
 * Long headless run of the island's food chain (berries → deer → wolves,
 * roots → boars) on real terrain, with the real AI, breeding and ecology
 * systems and plant regrowth. Prints the population every game day.
 *
 *   npx tsx scripts/simulate-ecology.ts [days=40] [size=256] [seed=777] [dt=0.2]
 */
import { Creature, ResourceC } from '../src/components';
import { World } from '../src/core/ecs/World';
import { EventBus } from '../src/core/EventBus';
import { AISystem } from '../src/systems/ai/AISystem';
import { BreedingSystem } from '../src/systems/ai/BreedingSystem';
import { EcologySystem, deerRefuge } from '../src/systems/ai/Ecology';
import { FlowFieldService } from '../src/systems/ai/nav/FlowFieldService';
import { DayNightCycle, DEFAULT_DAY_NIGHT } from '../src/systems/DayNightCycle';
import { InteractionSystem } from '../src/systems/InteractionSystem';
import { SurvivalStatusManager } from '../src/systems/SurvivalStatusManager';
import { parseMapConfig, toTerrainConfig } from '../src/world/MapConfig';
import { mulberry32 } from '../src/world/Noise';
import { buildNavGrid } from '../src/systems/ai/nav/NavGrid';
import { GENERATOR_VERSION, generateTerrain, sampleHeight } from '../src/world/TerrainGenerator';
import { populateResources, spawnInitialCreatures } from '../src/world/WorldPopulator';

declare const process: { argv: string[] };

export interface EcoRun {
  days: Array<{ deer: number; wolf: number; boar: number; ripeBushes: number }>;
  deaths: Record<string, number>;
  arrivals: number;
}

export function runEcology(days: number, size: number, seed: number, dt: number, log = false): EcoRun {
  const map = parseMapConfig({ size, seed, gen: GENERATOR_VERSION });
  const terrain = generateTerrain(toTerrainConfig(map));
  const bundle = { terrain, nav: buildNavGrid(terrain) };
  const world = new World();
  const events = new EventBus();
  const populated = populateResources(world, bundle);
  spawnInitialCreatures(world, bundle, map, populated.nav);
  const cycle = new DayNightCycle({ ...DEFAULT_DAY_NIGHT, seed });
  const rng = mulberry32(seed);
  const height = (x: number, z: number): number => sampleHeight(terrain, x, z);
  const walk = (x: number, z: number): boolean => populated.nav.isWalkable(x, z);
  const ai = new AISystem({
    groundHeight: height, paths: new FlowFieldService(populated.nav), cycle, survival: new SurvivalStatusManager(), events,
    resources: populated.resourceIndex, deerRefuge: deerRefuge(terrain.props.filter((p) => p.kind === 'berry_bush').length),
  });
  const breed = new BreedingSystem(events, walk, height, rng, populated.resourceIndex);
  const eco = new EcologySystem({ events, resources: populated.resourceIndex, isWalkable: walk, groundHeight: height, half: size / 2, rng });
  const regrow = new InteractionSystem({} as never, events, () => { throw new Error('no inventory'); }, populated.resourceIndex);

  const deaths: Record<string, number> = {};
  let arrivals = 0;
  events.on('creature:died', ({ species, cause }) => { const k = `${species}:${cause}`; deaths[k] = (deaths[k] ?? 0) + 1; });
  events.on('creature:arrived', () => arrivals++);

  const out: EcoRun = { days: [], deaths, arrivals: 0 };
  const logged: Record<string, number> = {};
  const daySeconds = DEFAULT_DAY_NIGHT.dayLengthSeconds;
  const ticksPerDay = Math.round(daySeconds / dt);
  for (let day = 1; day <= days; day++) {
    for (let i = 0; i < ticksPerDay; i++) {
      cycle.advance(dt);
      ai.fixedUpdate(world, dt);
      breed.fixedUpdate(world, dt);
      eco.fixedUpdate(world, dt);
      regrow.fixedUpdate(world, dt);
    }
    let ripe = 0;
    for (const e of world.query(ResourceC)) {
      const r = world.require(e, ResourceC);
      if (r.kind === 'berry_bush' && r.hitPoints > 0) ripe++;
    }
    const row = { ...eco.census, ripeBushes: ripe };
    out.days.push(row);
    if (log) {
      const today = Object.entries(deaths).map(([k, n]) => `${k}=${n - (logged[k] ?? 0)}`).filter((s) => !s.endsWith('=0')).join(' ');
      Object.assign(logged, deaths);
      console.log(`day ${String(day).padStart(3)}  deer ${String(row.deer).padStart(3)}  wolves ${String(row.wolf).padStart(3)}  boars ${String(row.boar).padStart(3)}  ripe bushes ${ripe}  deaths: ${today}`);
    }
  }
  out.arrivals = arrivals;
  void Creature;
  return out;
}

if (process.argv[1]?.endsWith('simulate-ecology.ts')) {
  const [days = 40, size = 256, seed = 777, dt = 0.2] = process.argv.slice(2).map(Number);
  const t0 = Date.now();
  const r = runEcology(days, size, seed, dt, true);
  console.log('deaths', JSON.stringify(r.deaths), 'arrivals', r.arrivals, `(${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
