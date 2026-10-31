import * as THREE from 'three';
import type { System, World } from '../core/ecs/World';
import { Cullable, Transform } from '../components';
import type { Chunk } from './WorldBuilder';
import type { PropBatches } from './PropBatches';
import { RenderObject } from './Renderer';

/**
 * Frustum + distance culling, layered on top of Three's per-object culling.
 *
 * Three already skips meshes outside the camera frustum, but it still
 * *traverses* every object, recomputes world matrices and tests each one.
 * Hiding a whole chunk Group removes its subtree from traversal and from the
 * shadow pass too.
 *
 *  - Terrain chunks: AABB vs frustum and distance (the fog distance: nothing
 *    past it is visible). The box is inflated by `shadowMargin`.
 *  - Props: PropBatches.update() does distance culling and tree LOD per
 *    instance (three frustum-culls each instance).
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
    private readonly props: PropBatches | null,
    /** Prop distances; `view` (the fog distance: nothing past it shows) also culls terrain chunks. */
    private readonly distances: () => { view: number; treeLod: number; smallProps: number } = () => ({ view: 170, treeLod: 32, smallProps: 50 }),
    private readonly shadowMargin = 12,
  ) {}

  update(world: World): void {
    this.camera.updateMatrixWorld();
    this.projView.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    const cam = this.camera.position;

    let chunksVisible = 0;
    const dist = this.distances();
    const maxD = dist.view;
    this.props?.update(cam.x, cam.z, dist);
    const maxD2 = maxD * maxD;
    for (const c of this.chunks) {
      this.box.copy(c.bounds).expandByScalar(this.shadowMargin);
      const visible = c.center.distanceToSquared(cam) < maxD2 && this.frustum.intersectsBox(this.box);
      c.group.visible = visible;
      if (visible) chunksVisible++;
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
