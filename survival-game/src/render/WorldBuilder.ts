import * as THREE from 'three';
import type { Entity, System, World } from '../core/ecs/World';
import type { EventBus } from '../core/EventBus';
import { Creature, HeatSource, ResourceC, ShelterZone, Transform } from '../components';
import type { AssetLoader } from '../assets/AssetLoader';
import { ISLAND, type TerrainData, type PropKind } from '../world/TerrainGenerator';
import type { PopulatedWorld } from '../world/WorldPopulator';
import { campfireObject, firLowGeometry, flatMaterial, leanToObject, propGeometry } from './LowPolyFactory';
import { creatureMesh } from './CreatureModels';
import { RenderObject } from './Renderer';

const CASTS_SHADOW: ReadonlySet<PropKind> = new Set<PropKind>(['tree', 'rock', 'berry_bush', 'log']);

export interface Chunk {
  group: THREE.Group;
  /** World-space bounds of terrain + props, used for frustum culling. */
  bounds: THREE.Box3;
  center: THREE.Vector3;
  /** Tree meshes at two levels of detail; CullingSystem shows one or the other by distance. */
  lods: Array<{ high: THREE.InstancedMesh; low: THREE.InstancedMesh }>;
}

interface InstanceRef {
  /** Every mesh that draws this instance (both tree LODs share the index). */
  meshes: THREE.InstancedMesh[];
  index: number;
  matrix: THREE.Matrix4;
}

export interface BuiltWorld {
  chunks: Chunk[];
  instances: Map<Entity, InstanceRef>;
  water: THREE.Mesh;
}

export interface BuildOptions {
  /** Main-thread time allowed per frame before yielding (ms). */
  frameBudgetMs?: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

/**
 * Render side of world construction: terrain chunk meshes and per-chunk
 * instanced props. Simulation entities already exist (WorldPopulator); this
 * only creates their visuals and links harvestable entities to instances.
 *
 * Time-sliced: work is split per chunk and the builder yields to the browser
 * whenever it has used `frameBudgetMs`, so even a 512 m map (256 chunks)
 * keeps the loading screen animating at 60 FPS instead of freezing.
 *
 * Draw-call strategy: each 32 m chunk owns one terrain mesh plus one
 * InstancedMesh per prop kind/variant, which is what makes frustum culling
 * effective (Three culls an InstancedMesh as a single bounding sphere).
 */
export async function buildWorldVisuals(
  scene: THREE.Scene, terrain: TerrainData, populated: PopulatedWorld, opts: BuildOptions = {},
): Promise<BuiltWorld> {
  const budget = opts.frameBudgetMs ?? 8;
  const { cfg, chunksPerSide } = terrain;
  const total = chunksPerSide * chunksPerSide;
  const chunks: Chunk[] = [];
  const instances = new Map<Entity, InstanceRef>();

  // Group prop indices by chunk once (cheap, ~O(props)).
  const byChunk: number[][] = Array.from({ length: total }, () => []);
  terrain.props.forEach((p, i) => byChunk[p.chunk]!.push(i));

  const cellsPerChunk = Math.round(cfg.chunkSize / (cfg.size / cfg.resolution));
  let sliceStart = performance.now();
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), pos = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  for (let ci = 0; ci < total; ci++) {
    const cx = ci % chunksPerSide, cz = Math.floor(ci / chunksPerSide);
    const group = new THREE.Group();
    group.name = `chunk-${ci}`;
    const chunk: Chunk = { group, bounds: new THREE.Box3(), center: new THREE.Vector3(), lods: [] };
    chunks.push(chunk);

    const ground = terrainChunkMesh(terrain, cx * cellsPerChunk, cz * cellsPerChunk, cellsPerChunk);
    group.add(ground);
    chunk.bounds.expandByObject(ground);

    // Bucket this chunk's props by kind+variant → one InstancedMesh each.
    const buckets = new Map<string, number[]>();
    for (const i of byChunk[ci]!) {
      const p = terrain.props[i]!;
      if (p.kind === 'water_source') continue; // the pond itself is the visual
      const key = `${p.kind}|${p.kind === 'tree' || p.kind === 'rock' ? p.variant : 0}`;
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = []));
      b.push(i);
    }
    for (const [key, list] of buckets) {
      const [kind, variant] = key.split('|') as [PropKind, string];
      const mesh = new THREE.InstancedMesh(propGeometry(kind, Number(variant)), flatMaterial, list.length);
      mesh.castShadow = CASTS_SHADOW.has(kind);
      mesh.receiveShadow = true;
      const low = kind === 'tree' ? new THREE.InstancedMesh(firLowGeometry(Number(variant)), flatMaterial, list.length) : null;
      if (low) {
        low.castShadow = true;
        low.receiveShadow = true;
        low.visible = false;
        chunk.lods.push({ high: mesh, low });
      }
      list.forEach((propIndex, n) => {
        const p = terrain.props[propIndex]!;
        pos.set(p.position.x, p.position.y - 0.08, p.position.z); // sink slightly so props don't float on slopes
        q.setFromAxisAngle(up, p.rotationY);
        s.setScalar(p.scale);
        m.compose(pos, q, s);
        mesh.setMatrixAt(n, m);
        low?.setMatrixAt(n, m);
        const e = populated.stableToEntity.get(propIndex);
        if (e !== undefined) instances.set(e, { meshes: low ? [mesh, low] : [mesh], index: n, matrix: m.clone() });
      });
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
      group.add(mesh);
      if (low) {
        low.computeBoundingBox();
        low.computeBoundingSphere();
        group.add(low);
      }
      chunk.bounds.union(mesh.boundingBox!);
    }
    chunk.bounds.getCenter(chunk.center);
    scene.add(group);

    if (performance.now() - sliceStart > budget) {
      opts.onProgress?.((ci + 1) / total);
      await nextFrame();
      if (opts.signal?.aborted) throw new DOMException('World build cancelled', 'AbortError');
      sliceStart = performance.now();
    }
  }

  // Clear turquoise water: the sand under the lagoon shows through and the
  // deepening sea floor (see terrainColor) gives the shallow-to-deep gradient.
  const waterMat = new THREE.MeshLambertMaterial({ color: 0x2bb3c4, transparent: true, opacity: 0.55, depthWrite: false });
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
  const floorMat = new THREE.MeshLambertMaterial({ color: DEEP.clone().multiplyScalar(0.97) });
  floorMat.userData['owned'] = true;
  const floorGeo = new THREE.PlaneGeometry(cfg.size * 8, cfg.size * 8).rotateX(-Math.PI / 2);
  floorGeo.userData['owned'] = true;
  const seaFloor = new THREE.Mesh(floorGeo, floorMat);
  seaFloor.position.y = cfg.waterLevel - ISLAND.seaDepth - 0.05;
  scene.add(seaFloor);
  opts.onProgress?.(1);
  return { chunks, instances, water };
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

/** Faceted terrain: non-indexed triangles, one colour per face. */
function terrainChunkMesh(t: TerrainData, ix0: number, iz0: number, cells: number): THREE.Mesh {
  const { cfg } = t;
  const n = cfg.resolution + 1;
  const step = cfg.size / cfg.resolution;
  const half = cfg.size / 2;
  const ix1 = Math.min(ix0 + cells, cfg.resolution);
  const iz1 = Math.min(iz0 + cells, cfg.resolution);
  const quads = Math.max(0, ix1 - ix0) * Math.max(0, iz1 - iz0);
  const positions = new Float32Array(quads * 6 * 3);
  const colors = new Float32Array(quads * 6 * 3);
  const c = new THREE.Color();
  let o = 0;

  const h = (ix: number, iz: number): number => t.heights[iz * n + ix]!;
  const pushTri = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number): void => {
    const avgH = (h(ax, az) + h(bx, bz) + h(cx, cz)) / 3;
    const slope = (t.slopes[az * n + ax]! + t.slopes[bz * n + bx]! + t.slopes[cz * n + cx]!) / 3;
    terrainColor(c, avgH, slope, cfg.waterLevel, cfg.maxHeight, ax * 31 + az * 17);
    for (const [ix, iz] of [[ax, az], [bx, bz], [cx, cz]] as const) {
      positions[o] = ix * step - half;
      positions[o + 1] = h(ix, iz);
      positions[o + 2] = iz * step - half;
      colors[o] = c.r;
      colors[o + 1] = c.g;
      colors[o + 2] = c.b;
      o += 3;
    }
  };

  for (let iz = iz0; iz < iz1; iz++) {
    for (let ix = ix0; ix < ix1; ix++) {
      // Alternate the diagonal for a less regular, more "hand-made" look.
      if ((ix + iz) % 2 === 0) {
        pushTri(ix, iz, ix, iz + 1, ix + 1, iz);
        pushTri(ix + 1, iz, ix, iz + 1, ix + 1, iz + 1);
      } else {
        pushTri(ix, iz, ix, iz + 1, ix + 1, iz + 1);
        pushTri(ix, iz, ix + 1, iz + 1, ix + 1, iz);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals(); // non-indexed → per-face normals → flat shading
  geo.userData['owned'] = true; // freed by Renderer.resetScene()
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, flatMaterial);
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false; // static: skip per-frame matrix recompute
  mesh.updateMatrix();
  return mesh;
}

const SAND = new THREE.Color(0xf0e4bf);
const WET_SAND = new THREE.Color(0xdccb9c);
const DEEP = new THREE.Color(0x14606e);
const FOREST = new THREE.Color(0x4f7d35);
const NEEDLES = new THREE.Color(0x6b6a3a);

function terrainColor(out: THREE.Color, h: number, slope: number, water: number, _maxH: number, seed: number): void {
  const v = 0.94 + Math.abs((Math.sin(seed * 12.9898) * 43758.5453) % 1) * 0.06;
  if (h < water) out.copy(WET_SAND).lerp(DEEP, Math.min(1, (water - h) / 4)); // sea floor darkens with depth
  else if (h < water + 0.32) out.copy(WET_SAND); // wet sand at the waterline
  else if (h < water + 0.72) out.copy(SAND); // the beach
  else if (slope > 0.3) out.setHex(0x7d7a72); // rock outcrop
  else out.copy(FOREST).lerp(NEEDLES, Math.abs((Math.sin(seed * 7.13) * 9871.3) % 1) * 0.35); // needle-strewn forest floor
  out.multiplyScalar(v);
}

/**
 * Keeps harvestable instances in sync with Resource state: shrinks a tree's
 * instance to zero scale when depleted and restores it when it regrows. On
 * the first frame it also hides anything a loaded save marks as depleted.
 */
export class ResourceVisualSystem implements System {
  readonly name = 'resource-visuals';
  private readonly hidden = new Set<Entity>();
  private readonly zero = new THREE.Matrix4().makeScale(0, 0, 0);
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
    const ref = this.built.instances.get(e);
    if (!ref) return;
    for (const mesh of ref.meshes) {
      mesh.setMatrixAt(ref.index, visible ? ref.matrix : this.zero);
      mesh.instanceMatrix.needsUpdate = true;
    }
    if (visible) this.hidden.delete(e);
    else this.hidden.add(e);
  }
}

/** Yield to the browser. rAF never fires in a hidden tab, so loading would hang there; use a macrotask instead. */
function nextFrame(): Promise<void> {
  return new Promise((r) => (document.hidden ? setTimeout(r, 0) : requestAnimationFrame(() => r())));
}
