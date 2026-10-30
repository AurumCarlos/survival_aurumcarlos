import type { Entity, World } from '../core/ecs/World';
import { SpatialHash } from '../core/SpatialHash';
import type { CreatureSpecies } from '../components';
import type { ResourceKind } from '../data/schema';
import { spawnCreature, spawnResource } from '../entities/factories';
import { NavGrid } from '../systems/ai/nav/NavGrid';
import { creatureBudget, type MapConfig } from './MapConfig';
import { mulberry32 } from './Noise';
import type { TerrainBundle } from './TerrainCodec';
import { sampleHeight } from './TerrainGenerator';

const HARVESTABLE: ReadonlySet<string> = new Set<ResourceKind>([
  'tree', 'rock', 'berry_bush', 'fiber_plant', 'water_source', 'mushroom', 'metal_rock', 'obsidian_rock', 'crystal',
  'oil_rock', 'shell_bed', 'salt_deposit', 'rare_flower', 'fish_shoal',
]);

export interface PopulatedWorld {
  /** Harvestables indexed by position for the interaction system. */
  resourceIndex: SpatialHash;
  /**
   * Stable IDs for generated resources: the prop's index in the (deterministic)
   * placement list. Entity numbers differ between
   * sessions; stable IDs don't, so saves reference these.
   */
  stableToEntity: Map<number, Entity>;
  entityToStable: Map<Entity, number>;
  nav: NavGrid;
}

/**
 * Engine-free world population: creates every harvestable resource entity
 * from terrain data. No meshes, no bodies — the render and physics layers
 * attach those separately, and the headless simulation uses this as-is.
 */
export function populateResources(world: World, bundle: TerrainBundle): PopulatedWorld {
  const { terrain } = bundle;
  const resourceIndex = new SpatialHash(8);
  const stableToEntity = new Map<number, Entity>();
  const entityToStable = new Map<Entity, number>();
  const link = (id: number, e: Entity, x: number, z: number): void => {
    stableToEntity.set(id, e);
    entityToStable.set(e, id);
    resourceIndex.insert(e, x, z);
  };

  terrain.props.forEach((p, i) => {
    if (!HARVESTABLE.has(p.kind)) return;
    const e = spawnResource(world, p.kind as ResourceKind, p.position, p.variant);
    link(i, e, p.position.x, p.position.z);
  });

  // Drinkable water comes from the generator's pond props (not the sea), so it is covered above.
  return { resourceIndex, stableToEntity, entityToStable, nav: new NavGrid(bundle.nav) };
}

/** Fresh-game creature placement: walkable cells only, away from spawn. */
export function spawnInitialCreatures(world: World, bundle: TerrainBundle, map: MapConfig, nav: NavGrid): Entity[] {
  const { terrain } = bundle;
  const rand = mulberry32(map.seed + 99);
  const budget = creatureBudget(map);
  const out: Entity[] = [];
  const spawnSome = (species: CreatureSpecies, count: number, minDist: number): void => {
    let placed = 0, tries = 0;
    while (placed < count && tries++ < count * 80) {
      const x = (rand() - 0.5) * terrain.cfg.size * 0.8;
      const z = (rand() - 0.5) * terrain.cfg.size * 0.8;
      const sp = terrain.spawn;
      if (Math.hypot(x - sp.x, z - sp.z) < minDist || !nav.isWalkable(x, z)) continue;
      out.push(spawnCreature(world, species, { x, y: sampleHeight(terrain, x, z), z }, Math.floor(rand() * 1e9)));
      placed++;
    }
  };
  const minDist = Math.min(45, terrain.cfg.size * 0.2);
  spawnSome('wolf', budget.wolf, minDist);
  spawnSome('deer', budget.deer, minDist * 0.6);
  spawnSome('boar', budget.boar, minDist * 0.8);
  return out;
}
