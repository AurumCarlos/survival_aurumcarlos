/**
 * Checks for: felled trees losing their collider and nav obstacle, walking
 * speed on/near buildings, step-up onto foundations, beds and sleeping,
 * animal counts. Uses the real cannon-es physics.
 */
import * as CANNON from 'cannon-es';
import { AIBrain, Creature, Exposure, PlayerControlled, Spectator, SurvivorC, Transform } from '../src/components';
import { MOVEMENT } from '../src/systems/PlayerControlSystem';
import { AISystem } from '../src/systems/ai/AISystem';
import { straightLinePaths } from '../src/systems/ai/nav/FlowFieldService';
import { World } from '../src/core/ecs/World';
import { EventBus } from '../src/core/EventBus';
import { GameLoop, type FrameScheduler } from '../src/core/GameLoop';
import { spawnCreature, spawnLeanTo, spawnPlayer, spawnStructure } from '../src/entities/factories';
import { placementSpot } from '../src/physics/Placement';
import { StructurePhysics } from '../src/physics/StructurePhysics';
import { BuildingPhysics } from '../src/physics/BuildingPhysics';
import { PhysicsSystem } from '../src/physics/PhysicsSystem';
import { PLAYER_SHAPE, PhysicsBody, PhysicsWorld } from '../src/physics/PhysicsWorld';
import { NavGrid } from '../src/systems/ai/nav/NavGrid';
import { BuildingGrid, type Candidate, type Piece } from '../src/systems/building/BuildingGrid';
import { DayNightCycle, DEFAULT_DAY_NIGHT } from '../src/systems/DayNightCycle';
import { EnvironmentSystem } from '../src/systems/EnvironmentSystem';
import { SleepSystem } from '../src/systems/SleepSystem';
import { SurvivalSystem } from '../src/systems/SurvivalSystem';
import { creatureBudget, parseMapConfig, toTerrainConfig } from '../src/world/MapConfig';
import { generateTerrain, type TerrainData } from '../src/world/TerrainGenerator';
import { buildNavGrid } from '../src/systems/ai/nav/NavGrid';

declare const process: { exit(code: number): never };
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const manual = (): FrameScheduler => ({ now: () => 0, request: () => 0, cancel: () => undefined });

/** Flat 64 m test ground at height 1, with one tree prop at (5, 0). */
function flatTerrain(): TerrainData {
  const size = 64, res = 48, n = res + 1;
  const heights = new Float32Array(n * n).fill(1);
  return {
    cfg: { seed: 1, size, resolution: res, maxHeight: 0, baseFrequency: 0.01, waterLevel: -5, spawnClearRadius: 0, chunkSize: 32 },
    heights, slopes: new Float32Array(n * n), chunksPerSide: 2, maxY: 1,
    spawn: { x: 0, y: 1, z: 0, yaw: 0 },
    props: [
      { kind: 'tree', position: { x: 5, y: 1, z: 0 }, rotationY: 0, scale: 1, variant: 0, chunk: 3 },
      { kind: 'tree', position: { x: 5, y: 1, z: 6 }, rotationY: 0, scale: 1, variant: 1, chunk: 3 },
    ],
  };
}

/** A player walking with a fixed desired velocity for `seconds`; returns the distance covered. */
async function walk(physics: PhysicsWorld, world: World, player: number, vx: number, vz: number, seconds: number): Promise<{ dx: number; dz: number; y: number }> {
  const loop = new GameLoop(world, { scheduler: manual() });
  loop.addSystem({ name: 'intent', fixedUpdate: () => { const pc = world.require(player, PlayerControlled); pc.desiredVelocity.x = vx; pc.desiredVelocity.z = vz; } });
  loop.addSystem(new PhysicsSystem(physics, -5));
  const start = { ...world.require(player, Transform).position };
  for (let t = 0; t <= seconds * 1000; t += 1000 / 60) loop.tick(t);
  const p = world.require(player, Transform).position;
  return { dx: p.x - start.x, dz: p.z - start.z, y: p.y };
}

function setup(): { world: World; physics: PhysicsWorld; player: number; t: TerrainData } {
  const t = flatTerrain();
  const world = new World();
  const physics = new PhysicsWorld();
  physics.addTerrain(t);
  const player = spawnPlayer(world, { x: 0, y: 1, z: 0 });
  const body = physics.createPlayerBody({ x: 0, y: 1, z: 0 });
  world.add(player, PhysicsBody, { body, originOffsetY: PLAYER_SHAPE.height / 2 + 0.05 });
  return { world, physics, player, t };
}

async function main(): Promise<void> {
  console.log('\n── Felled trees stop being solid ──');
  {
    const { world, physics, player, t } = setup();
    await physics.addStaticProps(t);
    const blocked = await walk(physics, world, player, 4.2, 0, 2.5);
    check('a standing tree blocks the player', blocked.dx < 5 - 0.3, `stopped after ${blocked.dx.toFixed(2)} m (trunk at 5 m)`);
    physics.setPropSolid(0, false);
    const through = await walk(physics, world, player, 4.2, 0, 2);
    check('after felling, the player walks through where it stood', through.dx > 5, `moved ${through.dx.toFixed(2)} m more`);
    physics.setPropSolid(0, true);
    physics.setPropSolid(0, true); // idempotent
    check('the other tree in the same chunk is still solid', (physics as unknown as { propShapes: Map<number, { active: boolean }> }).propShapes.get(1)!.active);

    const nav = new NavGrid(buildNavGrid(t));
    check('nav: the tree blocks creatures', !nav.isWalkable(5, 0));
    nav.setObstacle(t.props[0]!, -1);
    check('nav: felled → creatures can walk there', nav.isWalkable(5, 0) && !nav.isWalkable(5, 6));
    nav.setObstacle(t.props[0]!, 1);
    check('nav: regrown → blocked again', !nav.isWalkable(5, 0));
  }

  console.log('\n── Standing still on a slope ──');
  {
    // A 30° hillside (rising 0.58 m per metre along +X).
    const t = flatTerrain();
    const n = t.cfg.resolution + 1, step = t.cfg.size / t.cfg.resolution;
    for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) t.heights[iz * n + ix] = 10 + (ix * step - t.cfg.size / 2) * 0.58;
    t.props = [];
    const world = new World();
    const physics = new PhysicsWorld();
    physics.addTerrain(t);
    const player = spawnPlayer(world, { x: 0, y: 10.2, z: 0 });
    const body = physics.createPlayerBody({ x: 0, y: 10.2, z: 0 });
    world.add(player, PhysicsBody, { body, originOffsetY: PLAYER_SHAPE.height / 2 + 0.05 });
    await walk(physics, world, player, 0, 0, 1); // land
    const idle = await walk(physics, world, player, 0, 0, 4);
    check('an idle player does not slide down the slope', Math.hypot(idle.dx, idle.dz) < 0.02, `moved ${Math.hypot(idle.dx, idle.dz).toFixed(3)} m in 4 s`);
    const up = await walk(physics, world, player, 3, 0, 1);
    check('walking up the slope still works', up.dx > 1.5, `${up.dx.toFixed(2)} m`);
  }

  console.log('\n── Walking speed on and around buildings ──');
  {
    const { world, physics, player } = setup();
    const grid = new BuildingGrid({ heightAt: () => 1, staticBlocked: () => false, waterLevel: -5 });
    const events = new EventBus();
    const cam = { position: { x: 0, y: 0, z: 0 }, getWorldDirection: (v: { set: (a: number, b: number, c: number) => unknown }) => v.set(0, 0, -1) };
    new BuildingPhysics(grid, physics, cam as never, { x: 0, y: 0, z: 0, set() { return this; } } as never, events);
    let id = 100;
    const put = (c: Candidate): Piece => {
      const p = grid.insert({ ...c, id: id++ });
      events.emit('building:placed', { entity: p.id });
      return p;
    };
    // A 3×1 strip of foundations from x = 3 to 12 at z 0..3, 0.45 m high, with a wall along its north edge.
    for (let i = 1; i <= 3; i++) put({ kind: 'foundation', i, j: 0, y: 1.45 });
    for (let i = 1; i <= 3; i++) put({ kind: 'wall', i, j: 0, y: 1.45, side: 'n' });
    const body = world.require(player, PhysicsBody).body;
    body.position.set(1, 1 + PLAYER_SHAPE.height / 2 + 0.05, 1.5);
    const onto = await walk(physics, world, player, 4.2, 0, 1.2);
    check('walks up onto a 0.45 m foundation without jumping', onto.y > 1.3, `feet at y=${onto.y.toFixed(2)} after ${onto.dx.toFixed(2)} m`);
    const top = await walk(physics, world, player, 4.2, 0, 1);
    check('full walking speed on top of a foundation (4.2 m/s)', top.dx > 3.8, `${top.dx.toFixed(2)} m in 1 s`);
    body.position.set(4, body.position.y, 0.6); // hugging the wall (wall line z = 0, player radius 0.38)
    world.require(player, Transform).position.x = 4; // keep the ECS copy in sync for the distance measurement
    world.require(player, Transform).position.z = 0.6;
    const along = await walk(physics, world, player, 4.2, -0.6, 1);
    check('brushing along a wall barely slows you down', along.dx > 3.5, `${along.dx.toFixed(2)} m in 1 s`);
  }

  console.log('\n── Beds ──');
  {
    const g = new BuildingGrid({ heightAt: () => 1, staticBlocked: () => false, waterLevel: -5 });
    check('a bed needs a floor', g.validate({ kind: 'bed', i: 0, j: 0, y: 1.4, side: 'n' }, null) !== null);
    g.insert({ id: 1, kind: 'foundation', i: 0, j: 0, y: 1.4 });
    check('a bed fits on a foundation', g.validate({ kind: 'bed', i: 0, j: 0, y: 1.4, side: 'n' }, null) === null);
    g.insert({ id: 2, kind: 'bed', i: 0, j: 0, y: 1.4, side: 'n' });
    check('only one bed per cell', g.validate({ kind: 'bed', i: 0, j: 0, y: 1.4, side: 'e' }, null) !== null);
    check('a bed does not count as a floor (no wall/ceiling support from it)', g.floorAt(0, 0, 1.4)?.kind === 'foundation');
    const removed = g.remove(1).map((p) => p.kind).join(',');
    check('removing the foundation takes the bed with it', removed === 'foundation,bed', removed);
    const b = BuildingGrid.bedPlacement({ kind: 'bed', i: 0, j: 0, y: 0, side: 'n' });
    check('the headboard goes against the chosen edge', b.z < 1.5 && !b.alongX);
  }

  console.log('\n── Sleeping through the night ──');
  {
    const world = new World();
    const events = new EventBus();
    const cycle = new DayNightCycle({ ...DEFAULT_DAY_NIGHT, seed: 3 });
    const survival = new SurvivalSystem(events);
    const env = new EnvironmentSystem(cycle, () => ({ insulation: 0.9, roof: true })); // in a closed, roofed house
    const sleep = new SleepSystem(world, events, cycle, [env, survival]);
    const p = spawnPlayer(world, { x: 0, y: 0, z: 0 });
    const s = world.require(p, SurvivorC);
    env.fixedUpdate(world, 0);
    const refused: string[] = [];
    events.on('sleep:refused', ({ reason }) => refused.push(reason));
    let slept = 0;
    events.on('player:slept', ({ hours }) => (slept = hours));

    cycle.setHour(13);
    check('can\'t sleep in the afternoon', !sleep.trySleep(p) && refused.length === 1, refused[0]);
    cycle.setHour(22);
    const wolf = spawnCreature(world, 'wolf', { x: 8, y: 0, z: 0 }, 1);
    world.require(wolf, AIBrain).blackboard.state = 'hunt';
    check('can\'t sleep with a hunting wolf nearby', !sleep.trySleep(p), refused[1]);
    world.require(wolf, Transform).position.x = 200;
    world.require(wolf, AIBrain).blackboard.state = 'patrol';
    world.require(wolf, Creature).perception.awareness = 0;
    s.vitals.energy = 15;
    const day = cycle.day;
    const ok = sleep.trySleep(p);
    check('sleeping at 22:00 wakes you at 06:30 the next day', ok && Math.abs(cycle.hour - 6.5) < 0.05 && cycle.day === day + 1, `${slept.toFixed(1)} h, now ${cycle.hour.toFixed(2)} h`);
    check('energy is restored, hunger/thirst dropped a little', s.vitals.energy > 90 && s.vitals.hunger < 85 && s.vitals.hunger > 60 && s.alive,
      `energy ${s.vitals.energy.toFixed(0)}, hunger ${s.vitals.hunger.toFixed(0)}, thirst ${s.vitals.thirst.toFixed(0)}`);

    // Sleeping outside in the cold is dangerous.
    const w2 = new World();
    const c2 = new DayNightCycle({ ...DEFAULT_DAY_NIGHT, meanTempC: 11, amplitudeC: 15, weatherC: 4.5, seed: 7 }); // a cold night (mountains)
    const ev2 = new EventBus();
    const surv2 = new SurvivalSystem(ev2);
    const env2 = new EnvironmentSystem(c2);
    const p2 = spawnPlayer(w2, { x: 0, y: 0, z: 0 });
    c2.setHour(21);
    env2.fixedUpdate(w2, 0);
    new SleepSystem(w2, ev2, c2, [env2, surv2]).trySleep(p2);
    const s2 = w2.require(p2, SurvivorC);
    check('sleeping outside on a cold night costs health (or your life)', !s2.alive || s2.vitals.health < 100, `health ${s2.vitals.health.toFixed(0)}, alive ${s2.alive}`);
    void spawnLeanTo;
  }

  console.log('\n── Campfire / structures placed on buildings ──');
  {
    const { world, physics, player } = setup();
    const grid = new BuildingGrid({ heightAt: () => 1, staticBlocked: () => false, waterLevel: -5 });
    const events = new EventBus();
    const cam = { position: { x: 0, y: 0, z: 0 }, getWorldDirection: (v: { set: (a: number, b: number, c: number) => unknown }) => v.set(0, 0, -1) };
    new BuildingPhysics(grid, physics, cam as never, { x: 0, y: 0, z: 0, set() { return this; } } as never, events);
    let id = 300;
    const put = (c: Candidate): Piece => {
      const p = grid.insert({ ...c, id: id++ });
      events.emit('building:placed', { entity: p.id });
      return p;
    };
    for (const [i, j] of [[0, -1], [0, -2], [1, -1], [1, -2]] as const) put({ kind: 'foundation', i, j, y: 1.6 });
    put({ kind: 'wall', i: 0, j: -2, y: 1.6, side: 'n' });
    const q = (feet: { x: number; y: number; z: number }, yaw = 0) => placementSpot(physics, {
      feet, yaw, radius: 0.6, heightAt: () => 1, isWalkable: () => true, waterLevel: -5,
    });
    const onFloor = q({ x: 1.5, y: 1.6, z: -1.2 });
    check('a campfire put down on a foundation sits ON it (not buried at ground level)', !('error' in onFloor) && Math.abs(onFloor.y - 1.6) < 0.05,
      'error' in onFloor ? onFloor.error : `y ${onFloor.y.toFixed(2)} (floor 1.60, ground 1.00)`);
    const ground = q({ x: 1.5, y: 1, z: 3 });
    check('on open ground it sits on the terrain', !('error' in ground) && Math.abs(ground.y - 1) < 0.05);
    const wall = q({ x: 1.5, y: 1.6, z: -4.6 });
    check('never pushed through a wall', 'error' in wall || wall.z > -6 + 0.5, 'error' in wall ? wall.error : `z ${wall.z.toFixed(2)} (wall at −6)`);

    // A storage box is solid.
    const box = spawnStructure(world, 'storage_box', { x: 0, y: 1, z: 4 }, { yaw: 0 });
    new StructurePhysics(world, physics, events);
    void box;
    const body = world.require(player, PhysicsBody).body;
    body.position.set(0, 1 + PLAYER_SHAPE.height / 2 + 0.05, 7);
    body.velocity.set(0, 0, 0);
    world.require(player, Transform).position = { x: 0, y: 1, z: 7 };
    const w = await walk(physics, world, player, 0, -3, 2);
    check('a storage box blocks the player', w.dz > -3.0 + 0.2 && w.dz < -1.6, `moved ${w.dz.toFixed(2)} m toward it`);
  }

  console.log('\n── Stairs: up one storey and back down ──');
  {
    const { world, physics, player } = setup();
    const grid = new BuildingGrid({ heightAt: () => 1, staticBlocked: () => false, waterLevel: -5 });
    const events = new EventBus();
    const cam = { position: { x: 0, y: 0, z: 0 }, getWorldDirection: (v: { set: (a: number, b: number, c: number) => unknown }) => v.set(0, 0, -1) };
    new BuildingPhysics(grid, physics, cam as never, { x: 0, y: 0, z: 0, set() { return this; } } as never, events);
    let id = 500;
    const put = (c: Candidate): void => {
      const p = grid.insert({ ...c, id: id++ });
      events.emit('building:placed', { entity: p.id });
    };
    // Foundations at x 0..9 (cells 0..2), stairs in cell 1 climbing east, landing (ceiling) on cell 2 at +3 m.
    for (let i = 0; i <= 2; i++) put({ kind: 'foundation', i, j: 0, y: 1.4 });
    put({ kind: 'stairs', i: 1, j: 0, y: 1.4, side: 'e' });
    put({ kind: 'ceiling', i: 2, j: 0, y: 4.4 });
    const body = world.require(player, PhysicsBody).body;
    body.position.set(1.5, 1.4 + PLAYER_SHAPE.height / 2 + 0.05, 1.5);
    world.require(player, Transform).position = { x: 1.5, y: 1.4, z: 1.5 };
    const stairsAt = (x: number, z: number, f: number) => grid.stairsSurfaceAt(x, z, f);
    const walkS = (vx: number, seconds: number): { x: number; y: number } => {
      const loop = new GameLoop(world, { scheduler: manual() });
      loop.addSystem({ name: 'intent', fixedUpdate: () => { const pc = world.require(player, PlayerControlled); pc.desiredVelocity.x = vx; pc.desiredVelocity.z = 0; } });
      loop.addSystem(new PhysicsSystem(physics, -5, stairsAt));
      for (let t = 0; t <= seconds * 1000; t += 1000 / 60) loop.tick(t);
      const p = world.require(player, Transform).position;
      return { x: p.x, y: p.y };
    };
    const up = walkS(4, 1.7);
    check('walking into the stairs climbs to the landing one storey up', up.y > 4.3 && up.x > 6.5 && up.x < 9, `x ${up.x.toFixed(2)}, feet ${up.y.toFixed(2)} (landing 4.40)`);
    const idle = walkS(0, 1);
    check('standing still on the landing: no sliding', Math.abs(idle.x - up.x) < 0.1 && idle.y > 4.3);
    // Step back onto the flight and stop halfway: must not slide down.
    const half = walkS(-4, 1.2);
    const stay = walkS(0, 1.5);
    check('standing still halfway up: stays put', Math.abs(stay.x - half.x) < 0.1 && Math.abs(stay.y - half.y) < 0.1, `x ${half.x.toFixed(2)}→${stay.x.toFixed(2)}, y ${half.y.toFixed(2)}→${stay.y.toFixed(2)}`);
    const down = walkS(-4, 2);
    check('walking back down returns to the ground floor', down.y < 1.6 && down.x < 3, `x ${down.x.toFixed(2)}, feet ${down.y.toFixed(2)}`);
  }

  console.log('\n── More animals ──');
  {
    const b = creatureBudget(parseMapConfig({ size: 256, seed: 1 }));
    console.log(`   256 m map: ${b.wolf} wolves, ${b.deer} deer, ${b.boar} boars (was 4 / 7 / 3)`);
    check('about twice as many animals', b.wolf + b.deer + b.boar >= 28);
    void generateTerrain; void toTerrainConfig;
  }

  console.log('\n── Spectator mode ──');
  {
    const { world, physics, player, t } = setup();
    await physics.addStaticProps(t);
    const { body } = world.require(player, PhysicsBody);
    body.type = CANNON.Body.KINEMATIC;
    body.mass = 0;
    body.updateMassProperties();
    body.collisionResponse = false;
    world.add(player, Spectator, { ground: () => 1, half: t.cfg.size / 2 });
    const fly = (vx: number, lift: number, vz: number, seconds: number): void => {
      const loop = new GameLoop(world, { scheduler: manual() });
      loop.addSystem({ name: 'intent', fixedUpdate: () => {
        const pc = world.require(player, PlayerControlled);
        pc.desiredVelocity.x = vx;
        pc.desiredVelocity.z = vz;
        pc.desiredLift = lift;
      } });
      loop.addSystem(new PhysicsSystem(physics, -5));
      for (let ms = 0; ms <= seconds * 1000; ms += 1000 / 60) loop.tick(ms);
    };
    fly(0, MOVEMENT.flySpeed, 0, 1);
    const up = world.require(player, Transform).position.y;
    check('spectators fly up (no gravity)', up > 10, `y ${up.toFixed(1)}`);
    fly(0, 0, 0, 1);
    check('…and hover when idle', Math.abs(world.require(player, Transform).position.y - up) < 0.05);
    fly(0, -MOVEMENT.flyFastSpeed, 0, 2);
    check('never below the ground', world.require(player, Transform).position.y >= 1, `y ${world.require(player, Transform).position.y.toFixed(2)}`);
    fly(8, 0, 0, 1);
    check('fly through the tree trunk at x = 5 (no collisions)', world.require(player, Transform).position.x > 7, `x ${world.require(player, Transform).position.x.toFixed(1)}`);
    fly(MOVEMENT.flyFastSpeed, 0, 0, 3);
    check('fast flight, but never off the map', world.require(player, Transform).position.x <= t.cfg.size / 2 - 2 + 1e-6 && world.require(player, Transform).position.x > 25);

    // Animals: a wolf that "sees" the spectator next to it never chases or bites.
    const events = new EventBus();
    const cycle = new DayNightCycle(DEFAULT_DAY_NIGHT);
    const survival = new SurvivalSystem(events);
    const ai = new AISystem({ groundHeight: () => 1, paths: straightLinePaths, cycle, survival: survival.manager, events });
    const pp = world.require(player, Transform).position;
    pp.y = 1;
    const wolf = spawnCreature(world, 'wolf', { x: pp.x - 1, y: 1, z: pp.z }, 7, 3);
    const k = world.require(wolf, Creature);
    let bites = 0;
    events.on('player:damaged', () => bites++);
    for (let i = 0; i < 240; i++) {
      k.perception.canSeeTarget = true;
      k.perception.awareness = 1.5;
      k.perception.lastKnownTargetPos = { ...pp };
      k.perception.lastKnownAge = 0;
      ai.fixedUpdate(world, 1 / 60);
    }
    const st = world.require(wolf, AIBrain).blackboard.state;
    check('animals ignore a spectator (a wolf right next to you never chases or bites)', bites === 0 && st !== 'chase' && st !== 'attack', `state ${st}, ${bites} bites`);

    const s = world.require(player, SurvivorC);
    world.add(player, Exposure, { ambientC: 22, fireWarmthC: 0, shelterInsulation: 0, clothingInsulationC: 0, wet: false, feltC: 22 } as never);
    const hunger = s.vitals.hunger;
    for (let i = 0; i < 600; i++) survival.fixedUpdate(world, 1);
    check('no hunger, no harm for a spectator', s.vitals.hunger === hunger && s.alive);
    check('spectator mode is kept in the map config (and so in saves)',
      parseMapConfig({ size: 256, seed: 1, spectator: true }).spectator === true && parseMapConfig({ size: 256, seed: 1 }).spectator === undefined);
  }

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}
void main();
