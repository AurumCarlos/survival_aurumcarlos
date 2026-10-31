import * as THREE from 'three';
import type { System, World } from '../core/ecs/World';
import { Cullable, Transform } from '../components';
import { PRELOAD_RADIUS, TERRAIN_LOD, type Chunk, type TerrainTile } from './WorldBuilder';
import type { PropBatches, PropDistances } from './PropBatches';
import { RenderObject } from './Renderer';

/**
 * Frustum + distance culling, layered on top of Three's per-object culling.
 *
 * Three already skips meshes outside the camera frustum, but it still
 * *traverses* every object, recomputes world matrices and tests each one.
 * Hiding a whole chunk Group removes its subtree from traversal and from the
 * shadow pass too.
 *
 *  - Terrain: per 128 m tile, by distance from the camera to the tile's
 *    edge — full-resolution chunks near (each frustum-culled), the half- and
 *    quarter-resolution tile meshes further out, nothing past the fog
 *    distance. Boxes are inflated by `shadowMargin`.
 *  - Props: PropBatches.update() does distance culling per instance and
 *    gives the detailed mesh to the N nearest trees (three frustum-culls
 *    each instance).
 *  - Entities with Cullable: bounding sphere vs frustum + max distance.
 *    Also exposes `visible` back to the ECS so far-away creatures can be
 *    simulated at a lower rate by AI (future LOD hook).
 */
export class CullingSystem implements System {
  readonly name = 'culling';
  private readonly frustum = new THREE.Frustum();
  private readonly projView = new THREE.Matrix4();
  private readonly box = new THREE.Box3();
  private readonly sphere = new THREE.Sphere();
  stats = { chunksVisible: 0, tilesVisible: 0, entitiesVisible: 0 };
  private readonly pending: Array<{ c: Chunk; d: number }> = [];

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly chunks: readonly Chunk[],
    private readonly tiles: readonly TerrainTile[],
    private readonly props: PropBatches | null,
    /** Prop distances; `view` (the fog distance: nothing past it shows) also culls the terrain. */
    private readonly distances: () => PropDistances,
    private readonly shadowMargin = 12,
  ) {}

  update(world: World): void {
    this.camera.updateMatrixWorld();
    this.projView.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    const cam = this.camera.position;

    let chunksVisible = 0, tilesVisible = 0;
    const dist = this.distances();
    const maxD = dist.view;
    this.props?.update(cam.x, cam.z, dist);
    const pending = this.pending;
    pending.length = 0;
    for (const tile of this.tiles) {
      // Horizontal distance from the camera to the tile's edge (0 inside it).
      const b = tile.bounds;
      const dx = Math.max(b.min.x - cam.x, 0, cam.x - b.max.x), dz = Math.max(b.min.z - cam.z, 0, cam.z - b.max.z);
      const d = Math.hypot(dx, dz);
      // Full-resolution chunks are streamed in ahead of need; until all of a
      // tile's are ready, its coarse mesh stands in (no holes, no hitch).
      let ready = true;
      if (d < PRELOAD_RADIUS) {
        for (const i of tile.chunks) {
          const c = this.chunks[i]!;
          if (c.built) continue;
          ready = false;
          pending.push({ c, d: c.center.distanceToSquared(cam) });
        }
      }
      const near = d < TERRAIN_LOD.mid && ready;
      const inView = d < maxD && this.frustum.intersectsBox(this.box.copy(b).expandByScalar(this.shadowMargin));
      tile.mid.visible = inView && !near && d < TERRAIN_LOD.far;
      tile.far.visible = inView && d >= TERRAIN_LOD.far;
      if (tile.mid.visible || tile.far.visible) tilesVisible++;
      for (const i of tile.chunks) {
        const c = this.chunks[i]!;
        const visible = near && inView && this.frustum.intersectsBox(this.box.copy(c.bounds).expandByScalar(this.shadowMargin));
        c.group.visible = visible;
        if (visible) chunksVisible++;
      }
    }

    // Build the nearest missing chunks, ~3 ms per frame at most.
    if (pending.length) {
      pending.sort((a, b) => a.d - b.d);
      const t0 = performance.now();
      for (const p of pending) {
        p.c.build();
        if (performance.now() - t0 > 3) break;
      }
    }

    let entitiesVisible = 0;
    for (const e of world.query(Cullable, Transform, RenderObject)) {
      const cu = world.require(e, Cullable);
      const p = world.require(e, Transform).position;
      this.sphere.center.set(p.x, p.y, p.z);
      this.sphere.radius = cu.radius;
      const d2 = this.sphere.center.distanceToSquared(cam);
      cu.visible = d2 < cu.maxDistance * cu.maxDistance && this.frustum.intersectsSphere(this.sphere);
      const obj = world.require(e, RenderObject).object;
      obj.visible = cu.visible;
      // Hidden objects still had every part's matrix recomputed each frame
      // (three walks the whole graph): 260 animals × ~20 parts cost ~5 ms.
      obj.matrixWorldAutoUpdate = cu.visible;
      if (cu.visible) entitiesVisible++;
    }
    this.stats = { chunksVisible, tilesVisible, entitiesVisible };
  }
}
