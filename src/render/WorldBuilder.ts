import * as THREE from 'three';
import type { Entity, System, World } from '../core/ecs/World';
import type { EventBus } from '../core/EventBus';
import { Creature, HeatSource, ResourceC, ShelterZone, Structure, Transform } from '../components';
import type { AssetLoader } from '../assets/AssetLoader';
import { ISLAND, TREE_HEIGHT_STRETCH, type TerrainData, type PropKind } from '../world/TerrainGenerator';
import type { PopulatedWorld } from '../world/WorldPopulator';
import { campfireObject, caveMaterial, caveShellGeometry, flatMaterial, leanToObject, propGeometry, structureObject } from './LowPolyFactory';
import { PropBatches, type PropPlacement } from './PropBatches';
import { bakeTreeImpostors } from './Impostors';
import { creatureMesh } from './CreatureModels';
import { RenderObject } from './Renderer';
import { createTerrainMaterial, createWaterMaterial } from './Materials';
import { LAYER_MEAN } from './Textures';
import { treeShape } from '../world/TreeSpecies';

/** Kinds whose variant changes the mesh. */
const VARIANT_MESH: ReadonlySet<PropKind> = new Set<PropKind>(['rock', 'berry_bush', 'metal_rock', 'obsidian_rock', 'crystal', 'rare_flower', 'cactus', 'dead_bush', 'tall_grass', 'reeds']);

export interface Chunk {
  group: THREE.Group;
  /** World-space bounds of the terrain, used for frustum culling. */
  bounds: THREE.Box3;
  center: THREE.Vector3;
  /**
   * Full-resolution meshes are built lazily: at load only near the player,
   * the rest a few per frame as the player comes closer (CullingSystem). The
   * coarse tile covers the area until then.
   */
  built: boolean;
  build(): void;
}

/**
 * Terrain level of detail: 4 × 4 chunks (128 m) as one mesh at half
 * resolution (`mid`, from TERRAIN_LOD.mid metres) and at quarter resolution
 * (`far`, from TERRAIN_LOD.far). Close to the camera the full-resolution
 * chunks of the tile are drawn instead. Skirts hide the cracks where levels meet.
 */
export interface TerrainTile {
  mid: THREE.Mesh;
  far: THREE.Mesh;
  bounds: THREE.Box3;
  /** Indices into BuiltWorld.chunks. */
  chunks: number[];
}

/** Distances (m, from the camera to the tile's edge) where terrain switches to the coarser meshes. */
export const TERRAIN_LOD = { tileChunks: 4, mid: 180, far: 420 } as const;

export interface BuiltWorld {
  chunks: Chunk[];
  tiles: TerrainTile[];
  /** All static props, drawn in two batches. */
  props: PropBatches;
  /** Harvestable entity → its prop index in `props`. */
  instances: Map<Entity, number>;
  water: THREE.Mesh;
}

export interface BuildOptions {
  /** Main-thread time allowed per frame before yielding (ms). */
  frameBudgetMs?: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
  /** Bakes far-tree impostors with it (without one, trees stay meshes up to the fog). */
  renderer?: THREE.WebGLRenderer;
  /** Where the player starts: full-resolution terrain is built around it first. */
  focus?: { x: number; z: number };
}

/** Full-resolution chunks built at load within this distance of the player (m); further ones are streamed. */
export const PRELOAD_RADIUS = TERRAIN_LOD.mid + 50;

/**
 * Render side of world construction: terrain chunk meshes and per-chunk
 * instanced props. Simulation entities already exist (WorldPopulator); this
 * only creates their visuals and links harvestable entities to instances.
 *
 * Time-sliced: work is split per chunk and the builder yields to the browser
 * whenever it has used `frameBudgetMs` (40 ms: the loading bar keeps moving,
 * without wasting most of each frame waiting), so even a 1000 m map never freezes the page.
 *
 * Draw-call strategy: each 32 m chunk owns one terrain mesh (culled per
 * chunk); every prop of the map goes into two BatchedMeshes (see
 * PropBatches), culled per instance.
 */
export async function buildWorldVisuals(
  scene: THREE.Scene, terrain: TerrainData, populated: PopulatedWorld, opts: BuildOptions = {},
): Promise<BuiltWorld> {
  const budget = opts.frameBudgetMs ?? 40;
  const { cfg, chunksPerSide } = terrain;
  const total = chunksPerSide * chunksPerSide;
  const chunks: Chunk[] = [];
  const instances = new Map<Entity, number>();
  const placements: PropPlacement[] = [];

  // Group prop indices by chunk once (cheap, ~O(props)).
  const byChunk: number[][] = Array.from({ length: total }, () => []);
  terrain.props.forEach((p, i) => byChunk[p.chunk]!.push(i));

  const cellsPerChunk = Math.round(cfg.chunkSize / (cfg.size / cfg.resolution));
  let sliceStart = performance.now();
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), pos = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  const n = cfg.resolution + 1, step = cfg.size / cfg.resolution, half = cfg.size / 2;
  const focus = opts.focus ?? terrain.spawn;
  for (let ci = 0; ci < total; ci++) {
    const cx = ci % chunksPerSide, cz = Math.floor(ci / chunksPerSide);
    const group = new THREE.Group();
    group.name = `chunk-${ci}`;
    group.matrixAutoUpdate = false; // static
    const ix0 = cx * cellsPerChunk, iz0 = cz * cellsPerChunk;
    // Bounds straight from the height field (the mesh may not exist yet).
    let lo = Infinity, hi = -Infinity;
    for (let iz = iz0; iz <= Math.min(iz0 + cellsPerChunk, cfg.resolution); iz++) {
      for (let ix = ix0; ix <= Math.min(ix0 + cellsPerChunk, cfg.resolution); ix++) {
        const h = terrain.heights[iz * n + ix]!;
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
    const x0 = ix0 * step - half, z0 = iz0 * step - half;
    const chunk: Chunk = {
      group, bounds: new THREE.Box3(new THREE.Vector3(x0, lo, z0), new THREE.Vector3(x0 + cellsPerChunk * step, hi, z0 + cellsPerChunk * step)),
      center: new THREE.Vector3(), built: false,
      build() {
        if (this.built) return;
        this.built = true;
        group.add(terrainChunkMesh(terrain, ix0, iz0, cellsPerChunk));
      },
    };
    chunks.push(chunk);
    group.visible = false;
    chunk.bounds.getCenter(chunk.center);
    if (Math.hypot(chunk.center.x - focus.x, chunk.center.z - focus.z) < PRELOAD_RADIUS) chunk.build();

    for (const i of byChunk[ci]!) {
      const p = terrain.props[i]!;
      if (p.kind === 'water_source') continue; // the pond itself is the visual
      pos.set(p.position.x, p.position.y - 0.08, p.position.z); // sink slightly so props don't float on slopes
      q.setFromAxisAngle(up, p.rotationY);
      s.setScalar(p.scale);
      if (p.kind === 'tree') s.y *= TREE_HEIGHT_STRETCH; // taller, not thicker
      const variant = p.kind === 'tree' ? treeShape(p.variant) : VARIANT_MESH.has(p.kind) ? p.variant % 4 : 0;
      const e = populated.stableToEntity.get(i);
      if (e !== undefined) instances.set(e, placements.length);
      placements.push({ kind: p.kind, variant, matrix: m.compose(pos, q, s).clone(), x: p.position.x, z: p.position.z });
    }
    scene.add(group);

    if (performance.now() - sliceStart > budget) {
      opts.onProgress?.((ci + 1) / total);
      await nextFrame();
      if (opts.signal?.aborted) throw new DOMException('World build cancelled', 'AbortError');
      sliceStart = performance.now();
    }
  }

  // Coarse terrain tiles for the distance.
  const tiles: TerrainTile[] = [];
  const T = TERRAIN_LOD.tileChunks;
  for (let tz = 0; tz < chunksPerSide; tz += T) {
    for (let tx = 0; tx < chunksPerSide; tx += T) {
      const ix0 = tx * cellsPerChunk, iz0 = tz * cellsPerChunk, cells = T * cellsPerChunk;
      const mid = terrainChunkMesh(terrain, ix0, iz0, cells, 2);
      const far = terrainChunkMesh(terrain, ix0, iz0, cells, 4);
      mid.visible = far.visible = false;
      mid.matrixAutoUpdate = far.matrixAutoUpdate = false;
      // Past TERRAIN_LOD.mid there is no shadow map (it covers ±40 m): skip the lookups.
      mid.receiveShadow = far.receiveShadow = false;
      const bounds = new THREE.Box3().setFromObject(mid);
      const idx: number[] = [];
      for (let cz = tz; cz < Math.min(tz + T, chunksPerSide); cz++) {
        for (let cx = tx; cx < Math.min(tx + T, chunksPerSide); cx++) idx.push(cz * chunksPerSide + cx);
      }
      scene.add(mid, far);
      tiles.push({ mid, far, bounds, chunks: idx });
      if (performance.now() - sliceStart > budget) {
        await nextFrame();
        if (opts.signal?.aborted) throw new DOMException('World build cancelled', 'AbortError');
        sliceStart = performance.now();
      }
    }
  }

  const shapes = [...new Set(placements.filter((p) => p.kind === 'tree').map((p) => p.variant))].sort((a, b) => a - b);
  const impostors = opts.renderer && shapes.length ? bakeTreeImpostors(opts.renderer, shapes) : null;
  const props = new PropBatches(placements, impostors);
  scene.add(props.solid, props.leaves, props.impostors);

  // Caves: rock domes over the chambers carved into the mountains.
  for (const c of terrain.caves ?? []) {
    const cave = new THREE.Mesh(caveShellGeometry(c.length, c.width, c.height, Math.round(c.x * 13 + c.z * 7)), caveMaterial);
    cave.geometry.userData['owned'] = true;
    cave.position.set(c.x, c.y - 0.05, c.z);
    cave.rotation.y = c.yaw;
    cave.castShadow = true;
    cave.receiveShadow = true;
    cave.name = 'cave';
    scene.add(cave);
  }

  // Clear water reflecting the sky: the sand under the lagoon shows through and
  // the deepening sea floor (see terrainLayers) gives the shallow-to-deep gradient.
  const waterMat = createWaterMaterial();
  waterMat.userData['owned'] = true;
  // The sea extends far past the map so the island sits in an ocean that
  // reaches the (fogged) horizon in every direction.
  const waterGeo = new THREE.PlaneGeometry(cfg.size * 8, cfg.size * 8).rotateX(-Math.PI / 2);
  waterGeo.userData['owned'] = true;
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.position.y = cfg.waterLevel;
  water.receiveShadow = true;
  scene.add(water);

  // Deep sea floor out to the horizon, just under the terrain's own sea bed
  // (which covers it inside the map). Without it, the transparent water past
  // the map edge shows the sky through it — a visible light square.
  const floorMat = new THREE.MeshStandardMaterial({ color: DEEP.clone().multiplyScalar(0.97), roughness: 1 });
  floorMat.userData['owned'] = true;
  const floorGeo = new THREE.PlaneGeometry(cfg.size * 8, cfg.size * 8).rotateX(-Math.PI / 2);
  floorGeo.userData['owned'] = true;
  const seaFloor = new THREE.Mesh(floorGeo, floorMat);
  seaFloor.position.y = cfg.waterLevel - ISLAND.seaDepth - 0.05;
  scene.add(seaFloor);
  opts.onProgress?.(1);
  return { chunks, tiles, props, instances, water };
}

/**
 * Gives every simulation entity that should be visible but has no
 * RenderObject a mesh: creatures, campfires, shelters, carcasses. Called once
 * after a world is populated or a save is applied, so the persistence layer
 * never has to know about meshes.
 */
export function bindEntityVisuals(world: World, scene: THREE.Scene, assets: AssetLoader | null): void {
  const attach = (e: Entity, obj: THREE.Object3D, interpolate: boolean): void => {
    const p = world.require(e, Transform).position;
    obj.position.set(p.x, p.y, p.z);
    scene.add(obj);
    world.add(e, RenderObject, { object: obj, interpolate });
  };
  for (const e of world.query(Creature, Transform)) {
    if (world.has(e, RenderObject)) continue;
    const sp = world.require(e, Creature).species;
    attach(e, assets?.get(sp) ?? creatureMesh(sp), true);
  }
  for (const e of world.query(Structure, Transform)) {
    if (world.has(e, RenderObject)) continue;
    const st = world.require(e, Structure);
    const obj = (st.kind === 'campfire' || st.kind === 'lean_to' ? assets?.get(st.kind) : undefined) ?? structureObject(st.kind);
    obj.rotation.y = st.yaw;
    attach(e, obj, false);
  }
  for (const e of world.query(HeatSource, Transform)) {
    if (!world.has(e, RenderObject)) attach(e, assets?.get('campfire') ?? campfireObject(), false);
  }
  for (const e of world.query(ShelterZone, Transform)) {
    if (!world.has(e, RenderObject)) attach(e, assets?.get('lean_to') ?? leanToObject(), false);
  }
  for (const e of world.query(ResourceC, Transform)) {
    if (world.require(e, ResourceC).kind !== 'carcass' || world.has(e, RenderObject)) continue;
    const mesh = new THREE.Mesh(propGeometry('carcass', 0), flatMaterial);
    attach(e, mesh, false);
  }
}

/** Shared by every terrain chunk; textures are baked on first use. */
let terrainMaterial: THREE.MeshLambertMaterial | null = null;

/** How far skirts hang below a mesh's edge (m): deeper than any height step between LOD levels. */
const SKIRT_DEPTH = 3;

/**
 * Smooth textured terrain: an indexed grid per chunk. Normals come from the
 * global height field (central differences), so chunk borders don't show
 * seams. Each vertex carries five texture-layer weights and a colour tint.
 *
 * `stride` samples every n-th height vertex (2 = half resolution, for the
 * distant LOD tiles). Every mesh has a skirt: its border repeated
 * SKIRT_DEPTH lower, so the thin gaps between a fine chunk and a coarse tile
 * next to it are never see-through.
 */
function terrainChunkMesh(t: TerrainData, ix0: number, iz0: number, cells: number, stride = 1): THREE.Mesh {
  const { cfg } = t;
  const n = cfg.resolution + 1;
  const step = cfg.size / cfg.resolution;
  const half = cfg.size / 2;
  const ix1 = Math.min(ix0 + cells, cfg.resolution);
  const iz1 = Math.min(iz0 + cells, cfg.resolution);
  const xs: number[] = [], zs: number[] = [];
  for (let ix = ix0; ix < ix1; ix += stride) xs.push(ix);
  xs.push(ix1);
  for (let iz = iz0; iz < iz1; iz += stride) zs.push(iz);
  zs.push(iz1);
  const w = xs.length, d = zs.length;
  const border = 2 * (w + d) - 4;
  const count = w * d + border;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const layersA = new Float32Array(count * 4);
  const layersB = new Float32Array(count);
  const h = (ix: number, iz: number): number => t.heights[Math.min(n - 1, Math.max(0, iz)) * n + Math.min(n - 1, Math.max(0, ix))]!;
  const L = new Float32Array(5);
  const tint = new THREE.Color();
  const nv = new THREE.Vector3();

  for (let zi = 0, v = 0; zi < d; zi++) {
    for (let xi = 0; xi < w; xi++, v++) {
      const ix = xs[xi]!, iz = zs[zi]!;
      const y = h(ix, iz);
      positions[v * 3] = ix * step - half;
      positions[v * 3 + 1] = y;
      positions[v * 3 + 2] = iz * step - half;
      nv.set(h(ix - stride, iz) - h(ix + stride, iz), 2 * step * stride, h(ix, iz - stride) - h(ix, iz + stride)).normalize();
      normals[v * 3] = nv.x;
      normals[v * 3 + 1] = nv.y;
      normals[v * 3 + 2] = nv.z;
      const biome = t.biomes ? t.biomes[iz * n + ix]! : -1;
      terrainLayers(L, tint, y, t.slopes[iz * n + ix]!, cfg.waterLevel, ix * 31 + iz * 17, biome);
      layersA[v * 4] = L[0]!;
      layersA[v * 4 + 1] = L[1]!;
      layersA[v * 4 + 2] = L[2]!;
      layersA[v * 4 + 3] = L[3]!;
      layersB[v] = L[4]!;
      colors[v * 3] = tint.r;
      colors[v * 3 + 1] = tint.g;
      colors[v * 3 + 2] = tint.b;
    }
  }
  const index: number[] = [];
  for (let z = 0; z < d - 1; z++) {
    for (let x = 0; x < w - 1; x++) {
      const a = z * w + x, b = a + 1, c = a + w, e = c + 1;
      index.push(a, c, b, b, c, e);
    }
  }
  // Skirt: walk the border once round, copy each vertex SKIRT_DEPTH lower and
  // join consecutive pairs with a quad (double-sided via both windings).
  const ring: number[] = [];
  for (let x = 0; x < w; x++) ring.push(x);
  for (let z = 1; z < d; z++) ring.push(z * w + w - 1);
  for (let x = w - 2; x >= 0; x--) ring.push((d - 1) * w + x);
  for (let z = d - 2; z > 0; z--) ring.push(z * w);
  const base = w * d;
  ring.forEach((src, k) => {
    const v = base + k;
    positions[v * 3] = positions[src * 3]!;
    positions[v * 3 + 1] = positions[src * 3 + 1]! - SKIRT_DEPTH;
    positions[v * 3 + 2] = positions[src * 3 + 2]!;
    for (let c = 0; c < 3; c++) {
      normals[v * 3 + c] = normals[src * 3 + c]!;
      colors[v * 3 + c] = colors[src * 3 + c]!;
    }
    for (let c = 0; c < 4; c++) layersA[v * 4 + c] = layersA[src * 4 + c]!;
    layersB[v] = layersB[src]!;
  });
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k]!, b = ring[(k + 1) % ring.length]!, a2 = base + k, b2 = base + ((k + 1) % ring.length);
    index.push(a, b, a2, b, b2, a2, a, a2, b, b, a2, b2);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('layersA', new THREE.BufferAttribute(layersA, 4));
  geo.setAttribute('layersB', new THREE.BufferAttribute(layersB, 1));
  geo.setIndex(index);
  geo.userData['owned'] = true; // freed by Renderer.resetScene()
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, (terrainMaterial ??= createTerrainMaterial()));
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false; // static: skip per-frame matrix recompute
  mesh.updateMatrix();
  return mesh;
}

const DEEP = new THREE.Color(0x14606e);
const WHITE = new THREE.Color(1, 1, 1);
/** Tint that turns the sand texture into the deep sea floor colour. */
const DEEP_TINT = new THREE.Color(DEEP.r / LAYER_MEAN.sand.r, DEEP.g / LAYER_MEAN.sand.g, DEEP.b / LAYER_MEAN.sand.b);

/** Biome tints, relative to each texture layer's own colour (1 = untouched). */
const TINT = {
  wetSand: new THREE.Color(0.78, 0.76, 0.72),
  forest: new THREE.Color(0.92, 1.0, 0.86),
  jungle: new THREE.Color(0.78, 1.0, 0.74),
  meadow: new THREE.Color(1.12, 1.1, 0.92),
  dry: new THREE.Color(1.25, 1.12, 0.8),
  highland: new THREE.Color(1.0, 0.98, 0.9),
  cave: new THREE.Color(0.7, 0.68, 0.66),
  // Gen 4 biomes.
  mud: new THREE.Color(0.66, 0.62, 0.5),
  rainforest: new THREE.Color(0.66, 0.95, 0.6),
  savanna: new THREE.Color(1.6, 1.22, 0.55),
  desert: new THREE.Color(1.1, 0.98, 0.84),
  prairie: new THREE.Color(0.98, 1.14, 0.8),
  tundra: new THREE.Color(0.86, 0.92, 0.88),
  lakeshore: new THREE.Color(0.85, 1.02, 0.8),
};

const sstep = (a: number, b: number, v: number): number => {
  const x = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

/**
 * Texture-layer weights (sand, grass, dirt, rock, snow) and tint for one
 * terrain vertex, from height above the sea, slope and biome. Blends are
 * smooth so neighbouring vertices fade into each other.
 */
function terrainLayers(L: Float32Array, tint: THREE.Color, h: number, slope: number, water: number, seed: number, biome = -1): void {
  L.fill(0);
  tint.copy(WHITE);
  const r2 = Math.abs((Math.sin(seed * 7.13) * 9871.3) % 1);
  const above = h - water;
  // Sand everywhere near and under the sea; it fades into the biome above.
  // Beach biome (incl. gen 3 dunes, which rise well above the usual beach
  // height) stays sand; only the dune crests get a little beach grass.
  // Steep beach-biome ground is the foot of a gen 3 cliff: rock, not sand.
  const beach = biome === 6 || biome === 7 ? 0
    : biome === 0 ? (1 - sstep(1.6, 2.8, above) * 0.35) * (1 - sstep(0.22, 0.38, slope))
    : biome === 10 ? 1 - sstep(0.22, 0.38, slope) // desert: sand dunes, rock only on steep ground
    : 1 - sstep(0.55, 0.95, above);
  const rock = Math.max(sstep(0.22, 0.38, slope), biome === 4 ? 0.2 + r2 * 0.25 : 0);
  let snow = 0, grass = 0, dirt = 0;
  switch (biome) {
    case 6: dirt = 1; tint.copy(TINT.cave); break;
    case 0: grass = 1; tint.copy(TINT.dry); break; // beach grass on dune crests
    case 5: snow = 1; break;
    case 4: grass = 0.75; dirt = 0.25; tint.copy(TINT.highland); break;
    case 3: grass = 1; tint.copy(TINT.meadow).lerp(TINT.dry, r2 * 0.5); break;
    case 2: grass = 0.55; dirt = 0.45; tint.copy(TINT.jungle); break;
    case 7: dirt = 0.85; grass = 0.15; tint.copy(TINT.mud); break;
    case 8: grass = 0.5; dirt = 0.5; tint.copy(TINT.rainforest); break;
    case 9: grass = 0.7; dirt = 0.3; tint.copy(TINT.savanna).lerp(TINT.dry, r2 * 0.3); break;
    case 10: tint.copy(TINT.desert); break;
    case 11: grass = 1; tint.copy(TINT.prairie).lerp(TINT.meadow, r2 * 0.4); break;
    case 12: grass = 0.55; dirt = 0.2; snow = r2 < 0.45 ? 0.25 + r2 : 0.05; tint.copy(TINT.tundra); break;
    case 13: grass = 0.6; dirt = 0.4; tint.copy(TINT.lakeshore); break;
    default: grass = 0.45; dirt = 0.55; tint.copy(TINT.forest); break;
  }
  const land = 1 - beach;
  const soft = land * (1 - rock);
  L[0] = beach;
  L[1] = grass * soft;
  L[2] = dirt * soft;
  L[3] = rock * land;
  L[4] = snow * soft;
  if (biome === 5 && rock > 0) L[4] += rock * land * 0.25; // snow lingers on ledges
  if (above < 0.32 && biome !== 7) tint.lerp(TINT.wetSand, sstep(0.32, -0.1, above)); // wet sand at the waterline
  if (above < 0) tint.lerp(DEEP_TINT, Math.min(1, -above / 4) * 0.85); // sea floor darkens with depth
  const v = 0.94 + Math.abs((Math.sin(seed * 12.9898) * 43758.5453) % 1) * 0.08;
  tint.multiplyScalar(v);
}

/**
 * Keeps harvestable props in sync with Resource state: hides a felled tree
 * or mined rock when depleted and shows it again when it regrows. On
 * the first frame it also hides anything a loaded save marks as depleted.
 */
export class ResourceVisualSystem implements System {
  readonly name = 'resource-visuals';
  private readonly hidden = new Set<Entity>();
  private initialSyncDone = false;

  constructor(private readonly built: BuiltWorld, events: EventBus) {
    events.on('resource:depleted', ({ entity }) => this.setVisible(entity, false));
  }

  update(world: World): void {
    if (!this.initialSyncDone) {
      this.initialSyncDone = true;
      for (const e of this.built.instances.keys()) {
        const r = world.get(e, ResourceC);
        if (r && !r.infinite && r.hitPoints <= 0) this.setVisible(e, false);
      }
    }
    for (const e of this.hidden) {
      const r = world.get(e, ResourceC);
      if (!r) {
        this.hidden.delete(e);
        continue;
      }
      if (r.hitPoints > 0) this.setVisible(e, true);
    }
  }

  private setVisible(e: Entity, visible: boolean): void {
    const prop = this.built.instances.get(e);
    if (prop === undefined) return;
    this.built.props.setDepleted(prop, !visible);
    if (visible) this.hidden.delete(e);
    else this.hidden.add(e);
  }
}

/** Yield to the browser. rAF never fires in a hidden tab, so loading would hang there; use a macrotask instead. */
function nextFrame(): Promise<void> {
  return new Promise((r) => (document.hidden ? setTimeout(r, 0) : requestAnimationFrame(() => r())));
}
