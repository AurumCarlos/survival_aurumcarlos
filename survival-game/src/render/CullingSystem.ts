import * as THREE from 'three';
import type { System, World } from '../core/ecs/World';
import { Cullable, Transform } from '../components';
import type { Chunk } from './WorldBuilder';
import { RenderObject } from './Renderer';

/**
 * Frustum + distance culling, layered on top of Three's per-object culling.
 *
 * Three already skips meshes outside the camera frustum, but it still
 * *traverses* every object, recomputes world matrices and tests each one.
 * Hiding a whole chunk Group removes its subtree from traversal and from the
 * shadow pass too.
 *
 *  - Chunks: AABB vs frustum. The box is inflated by `shadowMargin` so trees
 *    just behind the camera still cast shadows into view.
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
  stats = { chunksVisible: 0, entitiesVisible: 0 };

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly chunks: readonly Chunk[],
    private readonly maxChunkDistance = 170,
    private readonly shadowMargin = 12,
    /** Trees in chunks closer than this use the detailed mesh; farther ones the low-poly LOD. */
    private readonly treeLodDistance = 55,
  ) {}

  update(world: World): void {
    this.camera.updateMatrixWorld();
    this.projView.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    const cam = this.camera.position;

    let chunksVisible = 0;
    const maxD2 = this.maxChunkDistance * this.maxChunkDistance;
    for (const c of this.chunks) {
      this.box.copy(c.bounds).expandByScalar(this.shadowMargin);
      const visible = c.center.distanceToSquared(cam) < maxD2 && this.frustum.intersectsBox(this.box);
      c.group.visible = visible;
      if (visible) {
        chunksVisible++;
        const near = c.bounds.distanceToPoint(cam) < this.treeLodDistance;
        for (const l of c.lods) {
          l.high.visible = near;
          l.low.visible = !near;
        }
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
      world.require(e, RenderObject).object.visible = cu.visible;
      if (cu.visible) entitiesVisible++;
    }
    this.stats = { chunksVisible, entitiesVisible };
  }
}
