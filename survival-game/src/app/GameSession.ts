import * as THREE from 'three';
import type { AssetLoader } from '../assets/AssetLoader';
import { HeatSource, PlayerControlled, ResourceC, SurvivorC, Transform } from '../components';
import { World, type Entity } from '../core/ecs/World';
import { EventBus } from '../core/EventBus';
import { GameLoop } from '../core/GameLoop';
import type { InputManager } from '../core/Input';
import { spawnCampfire, spawnLeanTo, spawnPlayer } from '../entities/factories';
import { applySnapshot, captureSnapshot, type WorldSnapshot } from '../persistence/WorldSnapshot';
import { CombatSystem } from '../physics/CombatSystem';
import { PhysicsSystem } from '../physics/PhysicsSystem';
import { PLAYER_SHAPE, PhysicsBody, PhysicsWorld } from '../physics/PhysicsWorld';
import { CullingSystem } from '../render/CullingSystem';
import { BuildingVisuals } from '../render/BuildingVisuals';
import { BuildingPhysics } from '../physics/BuildingPhysics';
import { BuildingGrid } from '../systems/building/BuildingGrid';
import { BuildingNav } from '../systems/building/BuildingNav';
import { BuildingSystem } from '../systems/building/BuildingSystem';
import { HitFlashSystem } from '../render/HitFlashSystem';
import { CreatureAnimationSystem } from '../render/CreatureAnimationSystem';
import { RenderObject, type Renderer } from '../render/Renderer';
import { RenderSyncSystem } from '../render/RenderSyncSystem';
import { ViewModel } from '../render/ViewModel';
import { ResourceVisualSystem, bindEntityVisuals, buildWorldVisuals, type BuildOptions } from '../render/WorldBuilder';
import { AILodSystem } from '../systems/ai/AILodSystem';
import { AISystem } from '../systems/ai/AISystem';
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
import { HUD } from '../ui/HUD';
import { InventoryUI } from '../ui/InventoryUI';
import type { MapConfig } from '../world/MapConfig';
import type { TerrainBundle } from '../world/TerrainCodec';
import { sampleHeight } from '../world/TerrainGenerator';
import { populateResources, spawnInitialCreatures, type PopulatedWorld } from '../world/WorldPopulator';

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
  private fireTime = 0;
  readonly buildings: BuildingGrid;
  private readonly building: BuildingSystem;
  private readonly buildingPhysics: BuildingPhysics;
  private readonly buildingNav: BuildingNav;

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
    // Static trunk/rock colliders are added time-sliced in create().
    const feet = world.require(this.player, Transform).position;
    const body = this.physics.createPlayerBody(feet);
    world.add(this.player, PhysicsBody, { body, originOffsetY: PLAYER_SHAPE.height / 2 + 0.05 });

    // ---- Systems ------------------------------------------------------------
    this.paths = new FlowFieldService(this.populated.nav);
    const survival = new SurvivalSystem(events);
    this.crafting = new CraftingSystem(events);
    this.interaction = new InteractionSystem(d.input, events, (w, e) => this.crafting.inventoryOf(w, e), this.populated.resourceIndex);
    if (!d.snapshot) {
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

    const environment = new EnvironmentSystem(this.cycle, (feet) => this.buildings.shelterAt(feet));
    this.loop = new GameLoop(world, { onRender: this.onRender });
    const noise = new NoiseBus();
    this.loop
      // per-frame, in order: input → intent → action requests → animation
      .addSystem(new PlayerControlSystem(d.input))
      .addSystem(this.building)
      .addSystem(this.interaction)
      .addSystem(new CombatSystem(this.physics, d.renderer.scene, d.input, d.renderer.camera, this.populated.resourceIndex, events,
        (x, z) => this.populated.nav.isWalkable(x, z)))
      .addSystem(new PlayerAnimationSystem(events))
      // fixed-step, in order:
      .addSystem(environment)
      .addSystem(new PhysicsSystem(this.physics, terrain.cfg.waterLevel))
      .addSystem(this.aiLod) //          decides who is simulated this tick…
      .addSystem(new PerceptionSystem(this.cycle, noise, this.physics.lineOfSight, events)) // …then they sense…
      .addSystem(new AISystem({ //       …then they think and move along flow fields
        groundHeight: (x, z) => {
          // Creatures step up onto low foundations (tall ones are blocked in the nav grid).
          const ground = sampleHeight(terrain, x, z);
          const top = this.buildings.foundationTopAt(x, z);
          return top !== null && top - ground < 1.2 ? Math.max(ground, top) : ground;
        },
        paths: this.paths, cycle: this.cycle, survival: survival.manager, events,
      }))
      .addSystem(this.crafting)
      .addSystem(survival);

    // Beds: E on a bed at night fast-forwards to morning through these systems.
    new SleepSystem(world, events, this.cycle, [environment, this.interaction, this.crafting, survival]);

    this.hud = new HUD(d.uiContainer, events, this.cycle, survival.manager);
    this.inventory = new InventoryUI(
      d.uiContainer, world, () => this.player, this.crafting, survival.manager, events, (kind) => this.placeStructure(kind),
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
      .addSystem(new CullingSystem(d.renderer.camera, built.chunks))
      .addSystem(new ResourceVisualSystem(built, this.events))
      .addSystem(new HitFlashSystem(this.events, this.world))
      .addSystem(new CreatureAnimationSystem())
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
      if (idx === undefined || !prop || (prop.kind !== 'tree' && prop.kind !== 'rock')) return;
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

  setInventoryOpen(open: boolean): void {
    this.inventory.toggle(open);
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
    this.hud.dispose();
    this.inventory.dispose();
    this.d.renderer.resetScene();
    this.events.clear();
  }

  // ---- Frame -----------------------------------------------------------------

  private readonly onRender = (_alpha: number, dt: number): void => {
    if (this.disposed) return;
    this.d.onFrame?.(this, dt);
    this.animateFires(dt);
    const prompt = this.building.prompt() ?? this.hud.promptFor(this.world, this.interaction.focused, this.player);
    this.hud.update(this.world, this.player, dt, this.loop, prompt, this.crafting.progress(this.player));
    this.d.renderer.render();
    this.d.input.endFrame();
  };

  private placeStructure(kind: 'campfire' | 'lean_to'): boolean {
    const pc = this.world.require(this.player, PlayerControlled);
    const p = this.world.require(this.player, Transform).position;
    const x = p.x - Math.sin(pc.yaw) * 2.2;
    const z = p.z - Math.cos(pc.yaw) * 2.2;
    if (!this.populated.nav.isWalkable(x, z)) return false; // not into a trunk or the lake
    const pos = { x, y: sampleHeight(this.d.bundle.terrain, x, z), z };
    const e = kind === 'campfire' ? spawnCampfire(this.world, pos) : spawnLeanTo(this.world, pos);
    bindEntityVisuals(this.world, this.d.renderer.scene, this.d.assets);
    this.world.require(e, RenderObject).object.rotation.y = pc.yaw;
    return true;
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
