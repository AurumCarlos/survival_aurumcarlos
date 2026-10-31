import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import type { AssetLoader } from '../assets/AssetLoader';
import type { AudioWorldState, SoundEngine } from '../audio/SoundEngine';
import { Creature, HeatSource, PlayerControlled, ResourceC, Spectator, Structure, SurvivorC, Transform } from '../components';
import { World, type Entity } from '../core/ecs/World';
import { EventBus } from '../core/EventBus';
import { GameLoop } from '../core/GameLoop';
import type { InputManager } from '../core/Input';
import { spawnPlayer, spawnStructure } from '../entities/factories';
import { STRUCTURES } from '../data/stations';
import { itemDef } from '../data/items';
import type { PlaceableKind } from '../data/schema';
import { applySnapshot, captureSnapshot, type WorldSnapshot } from '../persistence/WorldSnapshot';
import { CombatSystem } from '../physics/CombatSystem';
import { PhysicsSystem } from '../physics/PhysicsSystem';
import { PLAYER_SHAPE, PhysicsBody, PhysicsWorld } from '../physics/PhysicsWorld';
import { placementSpot } from '../physics/Placement';
import { StructurePhysics } from '../physics/StructurePhysics';
import { obstacleRadius } from '../systems/ai/nav/NavGrid';
import { CullingSystem } from '../render/CullingSystem';
import { BuildingVisuals } from '../render/BuildingVisuals';
import { BuildingPhysics } from '../physics/BuildingPhysics';
import { BuildingGrid } from '../systems/building/BuildingGrid';
import { BuildingNav } from '../systems/building/BuildingNav';
import { BuilderC, BuildingSystem } from '../systems/building/BuildingSystem';
import { HitFlashSystem } from '../render/HitFlashSystem';
import { CreatureAnimationSystem } from '../render/CreatureAnimationSystem';
import { RenderObject, type Renderer } from '../render/Renderer';
import { RenderSyncSystem } from '../render/RenderSyncSystem';
import { ViewModel } from '../render/ViewModel';
import { ResourceVisualSystem, bindEntityVisuals, buildWorldVisuals, type BuildOptions } from '../render/WorldBuilder';
import { AILodSystem } from '../systems/ai/AILodSystem';
import { AISystem } from '../systems/ai/AISystem';
import { ApexSystem } from '../systems/ai/ApexSystem';
import { BreedingSystem } from '../systems/ai/BreedingSystem';
import { EcologySystem, deerRefuge } from '../systems/ai/Ecology';
import { ApexAnimation } from '../render/ApexAnimation';
import { FlowFieldService } from '../systems/ai/nav/FlowFieldService';
import { NoiseBus } from '../systems/ai/NoiseBus';
import { PerceptionSystem } from '../systems/ai/PerceptionSystem';
import { DayNightCycle, DEFAULT_DAY_NIGHT } from '../systems/DayNightCycle';
import { EnvironmentSystem } from '../systems/EnvironmentSystem';
import { InteractionSystem } from '../systems/InteractionSystem';
import { CraftingSystem } from '../systems/inventory/CraftingSystem';
import { PlayerAnimC, makePlayerAnim } from '../systems/player/PlayerAnimation';
import { PlayerAnimationSystem } from '../systems/player/PlayerAnimationSystem';
import { PlayerControlSystem } from '../systems/PlayerControlSystem';
import { SurvivalSystem } from '../systems/SurvivalSystem';
import { SleepSystem } from '../systems/SleepSystem';
import { StationSystem } from '../systems/StationSystem';
import { bedSpawnPoint, chooseBed, dropBelongings, revive } from '../systems/Respawn';
import { StructureInteraction } from '../systems/StructureInteraction';
import { TEST_BAG, giveTestKit } from '../systems/TestKit';
import { HUD } from '../ui/HUD';
import { InventoryUI } from '../ui/InventoryUI';
import type { MapConfig } from '../world/MapConfig';
import type { TerrainBundle } from '../world/TerrainCodec';
import { BIOME_NAME, insideCave, sampleHeight, sampleSlope, type TerrainData } from '../world/TerrainGenerator';
import { populateResources, spawnApexPredators, spawnInitialCreatures, type PopulatedWorld } from '../world/WorldPopulator';

const BABY_NAME: Record<string, string> = { deer: 'deer (fawn)', boar: 'boar (piglet)', wolf: 'wolf (pup)' };

export interface SessionDeps {
  renderer: Renderer;
  input: InputManager;
  assets: AssetLoader | null;
  uiContainer: HTMLElement;
  bundle: TerrainBundle;
  map: MapConfig;
  /** Present when continuing a saved game. */
  snapshot?: WorldSnapshot;
  signal?: AbortSignal;
  onProgress?: (fraction: number, label: string) => void;
  /** Called at the start of every rendered frame (App-level hotkeys, autosave). */
  onFrame?: (s: GameSession, dt: number) => void;
  /** Procedural sound (ambience follows the player; game events play effects). */
  sound?: SoundEngine;
}

/**
 * Everything that exists for one game: ECS world, physics, systems, loop,
 * HUD, inventory and scene contents. Created by App when loading finishes,
 * disposed on quit/death/new game. Sessions share the renderer, input and
 * asset cache but nothing else — including their EventBus, so no listener
 * from a previous game can fire into the next one.
 */
export class GameSession {
  readonly world = new World();
  readonly events = new EventBus();
  readonly loop: GameLoop;
  readonly cycle: DayNightCycle;
  readonly player: Entity;
  readonly populated: PopulatedWorld;
  readonly paths: FlowFieldService;
  readonly aiLod = new AILodSystem();
  readonly physics = new PhysicsWorld();
  private readonly hud: HUD;
  private readonly inventory: InventoryUI;
  private readonly interaction: InteractionSystem;
  private readonly crafting: CraftingSystem;
  private disposed = false;
  private spectatorBadge: HTMLElement | null = null;
  private fireTime = 0;
  readonly buildings: BuildingGrid;
  private readonly building: BuildingSystem;
  private readonly buildingPhysics: BuildingPhysics;
  private readonly buildingNav: BuildingNav;
  private readonly stations: StationSystem;
  private readonly structures: StructureInteraction;
  private structurePhysics: StructurePhysics | null = null;
  /** Bed the player last slept in (respawn point). */
  private lastBed: number | null = null;
  /** Structure the player pressed E on; App opens the inventory with it. */
  private openRequest: Entity | null = null;

  /** Async factory: world visuals are built time-sliced and the build can be aborted. */
  static async create(d: SessionDeps): Promise<GameSession> {
    const s = new GameSession(d);
    try {
      const sliceOpts: { signal?: AbortSignal; onProgress: (f: number) => void } = {
        onProgress: (f) => d.onProgress?.(0.72 + f * 0.08, 'Placing obstacles…'),
      };
      if (d.signal) sliceOpts.signal = d.signal;
      await s.physics.addStaticProps(d.bundle.terrain, sliceOpts);
      s.syncPropObstacles();
      d.onProgress?.(0.8, 'Planting trees…');
      const opts: BuildOptions = { onProgress: (f) => d.onProgress?.(0.8 + f * 0.2, 'Planting trees…') };
      if (d.signal) opts.signal = d.signal;
      const built = await buildWorldVisuals(d.renderer.scene, d.bundle.terrain, s.populated, opts);
      s.finish(built);
      return s;
    } catch (err) {
      s.dispose(); // abort mid-build: remove the half-built scene
      throw err;
    }
  }

  private constructor(private readonly d: SessionDeps) {
    const { world, events } = this;
    const terrain = d.bundle.terrain;
    this.cycle = new DayNightCycle({ ...DEFAULT_DAY_NIGHT, seed: d.map.seed });
    // Remove the Three object of any destroyed entity (e.g. emptied carcasses).
    world.onDestroy((e) => world.get(e, RenderObject)?.object.removeFromParent());

    // ---- Simulation world (engine-free) ---------------------------------
    this.populated = populateResources(world, d.bundle);
    if (d.snapshot) {
      this.player = applySnapshot(world, d.snapshot, this.populated, this.cycle).player;
      // Saves from before crocodiles and bears: bring them in.
      spawnApexPredators(world, d.bundle, d.map, [...world.query(Creature)].map((e) => world.require(e, Creature).species));
    } else {
      spawnInitialCreatures(world, d.bundle, d.map, this.populated.nav);
      // Castaway start: on the beach, facing the forest, the sea at your back.
      const sp = terrain.spawn;
      this.player = spawnPlayer(world, { x: sp.x, y: sp.y, z: sp.z });
      world.require(this.player, PlayerControlled).yaw = sp.yaw;
    }
    world.add(this.player, PlayerAnimC, makePlayerAnim());

    // ---- Physics ----------------------------------------------------------
    this.physics.addTerrain(terrain);
    this.physics.addWorldBounds(terrain.cfg.size);
    this.physics.addCaves(terrain.caves ?? []);
    // Static trunk/rock colliders are added time-sliced in create().
    const feet = world.require(this.player, Transform).position;
    const body = this.physics.createPlayerBody(feet);
    world.add(this.player, PhysicsBody, { body, originOffsetY: PLAYER_SHAPE.height / 2 + 0.05 });
    if (d.map.spectator) {
      // Spectator: a kinematic body that passes through everything (PhysicsSystem.fly).
      body.type = CANNON.Body.KINEMATIC;
      body.mass = 0;
      body.updateMassProperties();
      body.collisionResponse = false;
      world.add(this.player, Spectator, { ground: (x, z) => sampleHeight(terrain, x, z), half: terrain.cfg.size / 2 });
    }

    // ---- Systems ------------------------------------------------------------
    this.paths = new FlowFieldService(this.populated.nav);
    const survival = new SurvivalSystem(events);
    this.crafting = new CraftingSystem(events);
    this.interaction = new InteractionSystem(d.input, events, (w, e) => this.crafting.inventoryOf(w, e), this.populated.resourceIndex);
    if (!d.snapshot && d.map.testMode) {
      // Test mode: bigger bag (set before the grid is built), best gear, stacks of everything.
      const survivor = world.require(this.player, SurvivorC);
      survivor.inventory.cols = TEST_BAG.cols;
      survivor.inventory.rows = TEST_BAG.rows;
      const lost = giveTestKit(survivor, this.crafting.inventoryOf(world, this.player));
      if (lost.length) console.warn('Test kit: no room for', lost);
    } else if (!d.snapshot) {
      const inv = this.crafting.inventoryOf(world, this.player);
      inv.add('wood', 3);
      inv.add('stone', 2);
      inv.add('fiber', 4);
      inv.add('berries', 4);
      inv.add('water_boiled', 1);
    }

    // ---- Building ---------------------------------------------------------------
    const nav = this.populated.nav;
    this.buildings = new BuildingGrid({
      heightAt: (x, z) => sampleHeight(terrain, x, z),
      staticBlocked: (x, z) => nav.staticBlocked(x, z),
      waterLevel: terrain.cfg.waterLevel,
    });
    this.buildingPhysics = new BuildingPhysics(this.buildings, this.physics, d.renderer.camera, new THREE.Vector3(), events);
    this.buildingNav = new BuildingNav(this.buildings, nav, events, world);
    this.building = new BuildingSystem(this.buildings, d.input, events, this.buildingPhysics, (w, e) => this.crafting.inventoryOf(w, e));
    // Adapters are listening now, so restored pieces get colliders and nav blocking.
    for (const piece of d.snapshot?.buildings ?? []) this.building.spawn(world, piece);

    this.stations = new StationSystem(events);
    this.structures = new StructureInteraction(d.input, events, () => {
      const b = world.get(this.player, BuilderC);
      return !!b?.active || this.building.lookingAt !== null;
    });
    this.interaction.blocked = () => this.structures.focused !== null || !!d.map.spectator;
    this.interaction.wheelBlocked = () => !!world.get(this.player, BuilderC)?.active;
    events.on('structure:open', ({ entity }) => (this.openRequest = entity));
    // Respawn: remember the bed you last used; on death, leave your things where you fell.
    events.on('player:sleep-request', ({ bed }) => (this.lastBed = bed));
    events.on('survivor:died', ({ entity }) => {
      if (!this.canRespawn) return;
      const bag = dropBelongings(world, entity, world.require(entity, Transform).position);
      if (bag !== null) {
        bindEntityVisuals(world, d.renderer.scene, d.assets);
        events.emit('structure:placed', { entity: bag });
      }
    });
    this.structurePhysics = new StructurePhysics(world, this.physics, events);

    const caves = terrain.caves ?? [];
    const environment = new EnvironmentSystem(
      this.cycle,
      (feet) => {
        // A cave is a natural shelter: dry, and out of the wind.
        if (caves.some((c) => insideCave(c, feet.x, feet.z) && feet.y < c.y + c.height)) return { insulation: 0.55, roof: true };
        return this.buildings.shelterAt(feet);
      },
      // Mountain air: −0.4 °C per metre above the lowlands (snowy peaks freeze at night).
      { baseY: terrain.cfg.waterLevel + 6, lapseCPerM: 0.4 },
      // Gen 4 biomes: deserts are hot, the tundra is cold.
      terrain.biomes ? (x, z) => BIOME_CLIMATE_C[terrain.biomes![biomeIndex(terrain, x, z)]!] ?? 0 : null,
    );
    this.loop = new GameLoop(world, { onRender: this.onRender });
    const noise = new NoiseBus();
    this.loop
      // per-frame, in order: input → intent → action requests → animation
      .addSystem(new PlayerControlSystem(d.input))
      .addSystem(this.building)
      .addSystem(this.structures)
      .addSystem(this.interaction)
      .addSystem(new CombatSystem(this.physics, d.renderer.scene, d.input, d.renderer.camera, this.populated.resourceIndex, events,
        (x, z) => this.populated.nav.isWalkable(x, z)))
      .addSystem(new PlayerAnimationSystem(events))
      // fixed-step, in order:
      .addSystem(this.stations)
      .addSystem(environment)
      .addSystem(new PhysicsSystem(this.physics, terrain.cfg.waterLevel, (x, z, feet) => this.buildings.stairsSurfaceAt(x, z, feet)))
      .addSystem(this.aiLod) //          decides who is simulated this tick…
      .addSystem(new PerceptionSystem(this.cycle, noise, this.physics.lineOfSight, events)) // …then they sense…
      .addSystem(new AISystem({ //       …then they think and move along flow fields
        groundHeight: (x, z) => {
          // Creatures step up onto low foundations (tall ones are blocked in the nav grid).
          const ground = sampleHeight(terrain, x, z);
          const top = this.buildings.foundationTopAt(x, z);
          return top !== null && top - ground < 1.2 ? Math.max(ground, top) : ground;
        },
        paths: this.paths, cycle: this.cycle, survival: survival.manager, events, resources: this.populated.resourceIndex,
        deerRefuge: deerRefuge(terrain.props.filter((p) => p.kind === 'berry_bush').length),
      }))
      .addSystem(new ApexSystem({
        terrainHeight: (x, z) => sampleHeight(terrain, x, z),
        groundHeight: (x, z) => {
          const ground = sampleHeight(terrain, x, z);
          const top = this.buildings.foundationTopAt(x, z);
          return top !== null && top - ground < 1.2 ? Math.max(ground, top) : ground;
        },
        waterLevel: terrain.cfg.waterLevel, paths: this.paths, isNight: () => this.cycle.isNight,
        survival: survival.manager, events, half: terrain.cfg.size / 2,
      }))
      .addSystem(new BreedingSystem(events, (x, z) => this.populated.nav.isWalkable(x, z), (x, z) => sampleHeight(terrain, x, z),
        Math.random, this.populated.resourceIndex))
      .addSystem(new EcologySystem({
        events, resources: this.populated.resourceIndex, isWalkable: (x, z) => this.populated.nav.isWalkable(x, z),
        groundHeight: (x, z) => sampleHeight(terrain, x, z), half: terrain.cfg.size / 2,
      }))
      .addSystem(this.crafting)
      .addSystem(survival);
    events.on('creature:arrived', () => {
      if (!this.disposed) bindEntityVisuals(world, d.renderer.scene, d.assets);
    });
    // A dead animal's mesh stays where it fell, on its side, as the carcass.
    events.on('creature:died', ({ entity, species, cause }) => {
      const ro = world.get(entity, RenderObject);
      const t = world.get(entity, Transform);
      if (!ro || !t) return;
      const pp = world.require(this.player, Transform).position;
      if (cause === 'predator' && Math.hypot(t.position.x - pp.x, t.position.z - pp.z) < 40) {
        events.emit('ui:toast', { text: `Wolves brought down a ${species} nearby` });
      }
      ro.object.rotation.z = Math.PI / 2;
      ro.object.position.y = t.position.y + 0.25;
      ro.interpolate = false;
    });
    events.on('creature:born', ({ entity, species }) => {
      if (this.disposed) return;
      bindEntityVisuals(world, d.renderer.scene, d.assets);
      const bp = world.get(entity, Transform)?.position;
      const pp = world.require(this.player, Transform).position;
      if (bp && Math.hypot(bp.x - pp.x, bp.z - pp.z) < 45) events.emit('ui:toast', { text: `A baby ${BABY_NAME[species] ?? species} was born nearby` });
    });

    // Beds: E on a bed at night fast-forwards to morning through these systems.
    new SleepSystem(world, events, this.cycle, [this.stations, environment, this.interaction, this.crafting, survival]);

    this.hud = new HUD(d.uiContainer, events, this.cycle, survival.manager, () => d.renderer.resolutionScale);
    if (d.map.spectator) {
      d.uiContainer.classList.add('spectator');
      this.spectatorBadge = document.createElement('div');
      this.spectatorBadge.className = 'spectator-badge';
      this.spectatorBadge.innerHTML = '<strong>Spectator</strong> ZQSD/WASD fly · Space up · C down · Shift fast';
      d.uiContainer.appendChild(this.spectatorBadge);
    }
    this.hookSounds();
    this.inventory = new InventoryUI(
      d.uiContainer, world, () => this.player, this.crafting, survival.manager, events, (kind) => this.placeStructure(kind),
      this.stations, (e) => this.pickUpStructure(e),
    );
  }

  /** Second half of construction, after the async visual build. */
  private finish(built: Awaited<ReturnType<typeof buildWorldVisuals>>): void {
    const d = this.d;
    bindEntityVisuals(this.world, d.renderer.scene, d.assets);
    const renderSync = new RenderSyncSystem(d.renderer, this.cycle);
    const viewModel = new ViewModel(d.renderer);
    this.loop
      .addSystem(renderSync)
      .addSystem(new CullingSystem(d.renderer.camera, built.chunks, built.props, () => d.renderer.propDistances))
      .addSystem(new ResourceVisualSystem(built, this.events))
      .addSystem(new HitFlashSystem(this.events, this.world))
      .addSystem(new CreatureAnimationSystem())
      .addSystem(new ApexAnimation(d.bundle.terrain.cfg.waterLevel))
      .addSystem(new BuildingVisuals(this.buildings, d.renderer.scene, this.events))
      .addSystem(viewModel);
    d.renderer.overlay = viewModel;
    // While paused only onRender runs: place the camera once so the "Ready"
    // screen shows the world from the player's eyes, not from under the terrain.
    renderSync.update(this.world, 0, 1);
    this.loop.pause('user');
    this.loop.start();
  }

  /**
   * Felled trees and mined boulders stop being solid: their collider and nav
   * obstacle are removed when depleted and come back when they regrow. Also
   * applied once after loading, for resources a save marks as depleted.
   */
  private syncPropObstacles(): void {
    const terrain = this.d.bundle.terrain;
    const cleared = new Set<number>(); // guards against double add/remove of the same obstacle
    const set = (e: Entity, solid: boolean): void => {
      const idx = this.populated.entityToStable.get(e);
      const prop = idx !== undefined ? terrain.props[idx] : undefined;
      if (idx === undefined || !prop || obstacleRadius(prop) === 0) return;
      if (cleared.has(idx) === !solid) return;
      if (solid) cleared.delete(idx);
      else cleared.add(idx);
      this.physics.setPropSolid(idx, solid);
      this.populated.nav.setObstacle(prop, solid ? 1 : -1);
    };
    for (const [e] of this.populated.entityToStable) {
      const r = this.world.get(e, ResourceC);
      if (r && !r.infinite && r.hitPoints <= 0) set(e, false);
    }
    this.events.on('resource:depleted', ({ entity }) => set(entity, false));
    this.events.on('resource:regrown', ({ entity }) => set(entity, true));
  }

  // ---- Public API used by App ----------------------------------------------

  get isInventoryOpen(): boolean {
    return this.inventory.isOpen;
  }

  /** A bed exists: death isn't the end of this world. */
  get canRespawn(): boolean {
    return chooseBed(this.buildings, this.lastBed) !== null;
  }

  /** Wake up next to your bed after dying. Returns false if there is no bed any more. */
  respawn(): boolean {
    const bed = chooseBed(this.buildings, this.lastBed);
    if (!bed) return false;
    const at = bedSpawnPoint(bed);
    revive(this.world, this.player, at);
    const { body } = this.world.require(this.player, PhysicsBody);
    body.position.set(at.x, at.y + PLAYER_SHAPE.height / 2 + 0.05, at.z);
    body.velocity.set(0, 0, 0);
    this.events.emit('inventory:changed', { entity: this.player });
    this.events.emit('ui:toast', { text: 'You wake up in your bed. Your belongings are where you fell.' });
    this.loop.resume('dead');
    return true;
  }

  /** E was pressed on a structure: the App opens the inventory showing it. */
  takeOpenRequest(): Entity | null {
    const e = this.openRequest;
    this.openRequest = null;
    return e !== null && this.world.get(e, Structure) ? e : null;
  }

  setInventoryOpen(open: boolean, container?: Entity): void {
    if (open && container !== undefined) this.inventory.openContainer(container);
    else this.inventory.toggle(open);
    const anim = this.world.get(this.player, PlayerAnimC);
    if (anim) anim.uiBlocked = open; // tool is put away while the bag is open
  }

  capture(): WorldSnapshot {
    return captureSnapshot(this.world, { map: this.d.map, cycle: this.cycle, populated: this.populated, buildings: this.buildings });
  }

  get survivorAlive(): boolean {
    return this.world.require(this.player, SurvivorC).alive;
  }

  get secondsSurvived(): number {
    return this.world.require(this.player, SurvivorC).stats.secondsSurvived;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loop.dispose(); // also disposes systems (BuildingVisuals, HitFlash…)
    this.buildingPhysics.dispose();
    this.buildingNav.dispose();
    this.structurePhysics?.dispose();
    this.hud.dispose();
    this.inventory.dispose();
    this.spectatorBadge?.remove();
    this.d.uiContainer.classList.remove('spectator');
    this.d.renderer.resetScene();
    this.events.clear();
  }

  // ---- Frame -----------------------------------------------------------------

  private readonly onRender = (_alpha: number, dt: number): void => {
    if (this.disposed) return;
    this.d.onFrame?.(this, dt);
    this.animateFires(dt);
    if (this.d.sound && !this.loop.isPaused) this.d.sound.update(dt, this.audioState(dt));
    this.inventory.frame();
    if (!this.loop.isPaused) this.announceBiome(dt);
    const prompt = this.building.prompt() ?? this.structures.prompt(this.world) ?? this.hud.promptFor(this.world, this.interaction.focused, this.player);
    this.hud.update(this.world, this.player, dt, this.loop, prompt, this.crafting.progress(this.player));
    this.d.renderer.render();
    this.d.input.endFrame();
  };

  private biome = { current: -1, candidate: -1, held: 0 };

  /** "Savanna", "Tundra"…: a short message when the player walks into another biome (after 1.5 s in it). */
  private announceBiome(dt: number): void {
    const t = this.d.bundle.terrain;
    if (!t.biomes) return;
    const p = this.world.require(this.player, Transform).position;
    const b = t.biomes[biomeIndex(t, p.x, p.z)]!;
    const s = this.biome;
    if (b === s.current) return void (s.candidate = -1);
    if (b !== s.candidate) {
      s.candidate = b;
      s.held = 0;
      return;
    }
    s.held += dt;
    if (s.held < 1.5) return;
    const first = s.current === -1;
    s.current = b;
    if (!first && b !== 6) this.events.emit('ui:toast', { text: BIOME_NAME[b] ?? 'Unknown land' }); // caves have their own feel
  }

  /**
   * Put a structure down ~2 m in front of the player, on whatever is there:
   * the ground, or a foundation/floor of a house (it used to be placed at
   * terrain height, i.e. buried inside the floor). Returns an error to show,
   * or null on success.
   */
  private placeStructure(kind: PlaceableKind): string | null {
    const pc = this.world.require(this.player, PlayerControlled);
    const size = STRUCTURES[kind].size;
    const terrain = this.d.bundle.terrain;
    const spot = placementSpot(this.physics, {
      feet: this.world.require(this.player, Transform).position, yaw: pc.yaw, radius: Math.max(size.hx, size.hz),
      heightAt: (x, z) => sampleHeight(terrain, x, z), isWalkable: (x, z) => this.populated.nav.isWalkable(x, z),
      waterLevel: terrain.cfg.waterLevel,
    });
    if ('error' in spot) return spot.error;
    const e = spawnStructure(this.world, kind, spot, { yaw: pc.yaw });
    bindEntityVisuals(this.world, this.d.renderer.scene, this.d.assets);
    this.events.emit('structure:placed', { entity: e });
    return null;
  }

  /** Pick a structure back up as its kit (it must be empty). */
  private pickUpStructure(e: Entity): string | null {
    const st = this.world.get(e, Structure);
    if (!st) return null;
    if (st.container && st.container.placements.length > 0) return 'Empty it first';
    const def = STRUCTURES[st.kind];
    if (!def.kit) return "This can't be picked up";
    if (this.crafting.inventoryOf(this.world, this.player).add(def.kit, 1) > 0) return `No room for the ${itemDef(def.kit).name}`;
    this.events.emit('structure:removed', { entity: e });
    this.world.destroy(e);
    this.events.emit('inventory:changed', { entity: this.player });
    return null;
  }

  // ---- Sound ------------------------------------------------------------------

  private waterDistance = 60;
  private waterCheck = 0;

  private hookSounds(): void {
    const sound = this.d.sound;
    if (!sound) return;
    const { events, world } = this;
    const nearPlayer = (e: Entity, r: number): boolean => {
      const p = world.get(e, Transform)?.position, pp = world.require(this.player, Transform).position;
      return !!p && Math.hypot(p.x - pp.x, p.z - pp.z) < r;
    };
    events.on('player:action-impact', ({ action }) => (action === 'harvest' ? sound.hit(false) : sound.swing()));
    events.on('creature:hit', () => sound.hit(true));
    events.on('player:damaged', () => sound.hurt());
    events.on('crafting:completed', () => sound.chime());
    events.on('resource:depleted', ({ entity }) => {
      if (world.get(entity, ResourceC)?.kind === 'tree' && nearPlayer(entity, 40)) sound.treeFall();
    });
  }

  /** What the ambience needs to know about where the player is. */
  private audioState(dt: number): AudioWorldState {
    const terrain = this.d.bundle.terrain;
    const W = terrain.cfg.waterLevel;
    const feet = this.world.require(this.player, Transform).position;
    const pc = this.world.require(this.player, PlayerControlled);
    // Distance to water: rings of samples, a few times a second.
    if ((this.waterCheck -= dt) <= 0) {
      this.waterCheck = 0.3;
      this.waterDistance = 60;
      search: for (const r of [0, 5, 10, 16, 24, 34, 46, 60]) {
        for (let k = 0; k < 12; k++) {
          const a = (k / 12) * Math.PI * 2;
          if (sampleHeight(terrain, feet.x + Math.cos(a) * r, feet.z + Math.sin(a) * r) < W - 0.1) {
            this.waterDistance = r;
            break search;
          }
        }
      }
    }
    const caves = terrain.caves ?? [];
    const inCave = caves.some((c) => insideCave(c, feet.x, feet.z) && feet.y < c.y + c.height);
    const top = this.buildings.foundationTopAt(feet.x, feet.z);
    const ground = sampleHeight(terrain, feet.x, feet.z);
    const onFloor = top !== null && Math.abs(feet.y - top) < 0.3;
    let kind: AudioWorldState['ground'] = 'grass';
    if (onFloor) kind = 'wood';
    else if (inCave || sampleSlope(terrain, feet.x, feet.z) > 0.3 || ground > W + 18) kind = 'rock';
    else if (ground < W + 1.2 || (terrain.biomes && [0, 10].includes(terrain.biomes[biomeIndex(terrain, feet.x, feet.z)]!))) kind = 'sand'; // beach, desert
    const body = this.world.get(this.player, PhysicsBody)?.body;
    return {
      waterDistance: this.waterDistance,
      altitude: Math.max(0, feet.y - W),
      light: this.cycle.lightLevel,
      rain: this.cycle.rainIntensity,
      sheltered: inCave || this.buildings.shelterAt(feet).roof,
      speed: body ? Math.hypot(body.velocity.x, body.velocity.z) : 0,
      grounded: pc.grounded,
      swimming: pc.swimming,
      ground: kind,
    };
  }

  private animateFires(dt: number): void {
    this.fireTime += dt;
    for (const e of this.world.query(HeatSource, RenderObject)) {
      const h = this.world.require(e, HeatSource);
      const obj = this.world.require(e, RenderObject).object;
      const flame = obj.getObjectByName('flame');
      const light = obj.getObjectByName('firelight') as THREE.PointLight | undefined;
      const flicker = 0.85 + Math.sin(this.fireTime * 13 + e) * 0.08 + Math.sin(this.fireTime * 23.7) * 0.07;
      if (flame) {
        flame.visible = h.lit;
        flame.scale.setScalar(flicker * Math.min(1, h.fuelSeconds / 60 + 0.3));
      }
      if (light) light.intensity = h.lit ? 6 * flicker : 0;
    }
  }
}

/** °C added to the air in each biome (by BIOME id): mangrove, rainforest, savanna, desert, prairie, tundra, lake. */
const BIOME_CLIMATE_C: Readonly<Record<number, number>> = { 7: 1, 8: 1.5, 9: 3, 10: 7, 11: 0, 12: -12, 13: -0.5 };

/** Index of the height/biome vertex nearest (x, z). */
function biomeIndex(t: TerrainData, x: number, z: number): number {
  const { size, resolution } = t.cfg;
  const n = resolution + 1;
  const ix = Math.min(resolution, Math.max(0, Math.round(((x + size / 2) / size) * resolution)));
  const iz = Math.min(resolution, Math.max(0, Math.round(((z + size / 2) / size) * resolution)));
  return iz * n + ix;
}
