import * as CANNON from 'cannon-es';
import { defineComponent } from '../core/ecs/World';
import type { Vec3 } from '../data/schema';
import type { TerrainData } from '../world/TerrainGenerator';
import { FIR_HEIGHT, obstacleRadius } from '../systems/ai/nav/NavGrid';
import { timeSliced } from '../core/TimeSlice';

/** Collision groups (bitmask). */
export const Groups = {
  TERRAIN: 1,
  STATIC: 2, // tree trunks, rocks, structures
  PLAYER: 4,
  PROJECTILE: 8,
  BUILDING: 16, // player-built foundations, walls, doors, ceilings
} as const;

/** Handle component: links an ECS entity to its Cannon body. */
export interface PhysicsBody {
  body: CANNON.Body;
  /** Offset from body centre to the entity's Transform origin (e.g. feet). */
  originOffsetY: number;
}
export const PhysicsBody = defineComponent<PhysicsBody>('PhysicsBody');

export const PLAYER_SHAPE = { radius: 0.38, height: 1.8 } as const;

/**
 * Owns the cannon-es world and builds static colliders from terrain data.
 */
export class PhysicsWorld {
  readonly world: CANNON.World;
  readonly groundMaterial = new CANNON.Material('ground');
  readonly playerMaterial = new CANNON.Material('player');
  private readonly rayResult = new CANNON.RaycastResult();
  private readonly rayFrom = new CANNON.Vec3();
  private readonly rayTo = new CANNON.Vec3();

  constructor() {
    this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -20, 0) }); // snappier than 9.82 for game feel
    // Sweep-and-prune: far better than the default naive broadphase once
    // there are hundreds of static trunks.
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.world.allowSleep = true;
    (this.world.solver as CANNON.GSSolver).iterations = 8;
    // The player is moved by setting velocity, so ground friction would only
    // fight the controller and make slopes sticky.
    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.groundMaterial, this.playerMaterial, { friction: 0, restitution: 0 }),
    );
    // Bodies created without a material (buildings, map bounds) use the default
    // contact material, whose friction of 0.3 dragged the player down to a
    // crawl on foundations and while brushing past walls.
    this.world.defaultContactMaterial.friction = 0;
    this.world.defaultContactMaterial.restitution = 0;
  }

  addTerrain(t: TerrainData): CANNON.Body {
    const { resolution, size } = t.cfg;
    const n = resolution + 1;
    const step = size / resolution;
    const half = size / 2;
    // Cannon's Heightfield lies in its local XY plane with height along +Z.
    // We rotate it −90° about X so local (x, y, z) → world (x, z, −y), which
    // means data[i][j] must hold the height at world x = i·step − half,
    // world z = half − j·step.
    const data: number[][] = [];
    for (let i = 0; i < n; i++) {
      const col: number[] = [];
      for (let j = 0; j < n; j++) col.push(t.heights[(resolution - j) * n + i]!);
      data.push(col);
    }
    const shape = new CANNON.Heightfield(data, { elementSize: step });
    const body = new CANNON.Body({
      mass: 0, material: this.groundMaterial,
      collisionFilterGroup: Groups.TERRAIN, collisionFilterMask: Groups.PLAYER | Groups.PROJECTILE,
    });
    body.addShape(shape);
    body.position.set(-half, 0, half);
    body.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.world.addBody(body);
    return body;
  }

  /**
   * Colliders for every solid prop, merged into ONE compound static body per
   * terrain chunk (each trunk/boulder is a shape with an offset).
   *
   * Why not one body per tree: cannon-es keeps a collision matrix with an
   * entry for every *pair* of bodies and clears it every step, so the step
   * cost grows with bodies². 1,400 separate trunks cost ~14–34 ms per step;
   * a dense 512 m island has 6,000+. As ~60 compound bodies the matrix is
   * tiny, and narrowphase still only looks at the chunk(s) the player is in,
   * where shapes far from the player are rejected by a bounding-sphere test.
   *
   * Sizes come from the same `obstacleRadius` the nav grid uses, so "the AI
   * thinks it's blocked" and "physics thinks it's solid" can never disagree.
   */
  async addStaticProps(t: TerrainData, opts: Parameters<typeof timeSliced>[2] = {}): Promise<void> {
    const byChunk = new Map<number, number[]>();
    t.props.forEach((p, i) => {
      if (obstacleRadius(p) === 0) return;
      let list = byChunk.get(p.chunk);
      if (!list) byChunk.set(p.chunk, (list = []));
      list.push(i);
    });
    await timeSliced([...byChunk.values()], (indices) => {
      const body = new CANNON.Body({
        mass: 0, material: this.groundMaterial,
        collisionFilterGroup: Groups.STATIC, collisionFilterMask: Groups.PLAYER | Groups.PROJECTILE,
      });
      const o = t.props[indices[0]!]!.position;
      body.position.set(o.x, o.y, o.z);
      for (const i of indices) {
        const p = t.props[i]!;
        const r = obstacleRadius(p);
        let shape: CANNON.Shape;
        let offset: CANNON.Vec3;
        // One shape per prop (not shared) so a felled tree's shape can be removed.
        if (p.kind === 'tree') {
          const h = Math.min(8, FIR_HEIGHT * p.scale); // nothing gets over 8 m; no need for a 20 m shape
          shape = new CANNON.Cylinder(r, r, h, 6);
          offset = new CANNON.Vec3(p.position.x - o.x, p.position.y + h / 2 - o.y, p.position.z - o.z);
        } else {
          shape = new CANNON.Sphere(r);
          offset = new CANNON.Vec3(p.position.x - o.x, p.position.y + r * 0.4 - o.y, p.position.z - o.z);
        }
        body.addShape(shape, offset);
        this.propShapes.set(i, { body, shape, offset, active: true });
      }
      this.world.addBody(body);
      this.staticPropBodies++;
    }, opts);
  }

  /** Collider of each solid prop, by prop index (= the resource's stable id). */
  private readonly propShapes = new Map<number, { body: CANNON.Body; shape: CANNON.Shape; offset: CANNON.Vec3; active: boolean }>();

  /** Remove (felled tree, mined rock) or restore (regrown) a prop's collider. */
  setPropSolid(propIndex: number, solid: boolean): void {
    const ps = this.propShapes.get(propIndex);
    if (!ps || ps.active === solid) return;
    if (solid) ps.body.addShape(ps.shape, ps.offset);
    else ps.body.removeShape(ps.shape);
    ps.active = solid;
  }

  /** Number of compound static bodies created by addStaticProps (diagnostics). */
  staticPropBodies = 0;

  /**
   * Invisible walls at the map edge. The sea floor ends there; without
   * them a swimmer could leave the world.
   */
  addWorldBounds(size: number): void {
    const half = size / 2;
    const h = 60;
    for (const [x, z, sx, sz] of [[half + 1, 0, 1, half + 2], [-half - 1, 0, 1, half + 2], [0, half + 1, half + 2, 1], [0, -half - 1, half + 2, 1]] as const) {
      const body = new CANNON.Body({ mass: 0, collisionFilterGroup: Groups.STATIC, collisionFilterMask: Groups.PLAYER | Groups.PROJECTILE });
      body.addShape(new CANNON.Box(new CANNON.Vec3(sx, h, sz)));
      body.position.set(x, 0, z);
      this.world.addBody(body);
    }
  }

  /** Static trunk collider. Trees are only obstacles, so a cylinder is enough. */
  addTrunk(pos: Vec3, radius: number, height: number): CANNON.Body {
    const body = new CANNON.Body({
      mass: 0, material: this.groundMaterial,
      collisionFilterGroup: Groups.STATIC, collisionFilterMask: Groups.PLAYER | Groups.PROJECTILE,
    });
    body.addShape(new CANNON.Cylinder(radius, radius, height, 6));
    body.position.set(pos.x, pos.y + height / 2, pos.z);
    this.world.addBody(body);
    return body;
  }

  addBoulder(pos: Vec3, radius: number): CANNON.Body {
    const body = new CANNON.Body({
      mass: 0, material: this.groundMaterial,
      collisionFilterGroup: Groups.STATIC, collisionFilterMask: Groups.PLAYER | Groups.PROJECTILE,
    });
    body.addShape(new CANNON.Sphere(radius));
    body.position.set(pos.x, pos.y + radius * 0.4, pos.z);
    this.world.addBody(body);
    return body;
  }

  /**
   * Player: a two-sphere "capsule". Rotation is locked so the body never
   * tips over; yaw is a purely visual/camera concern.
   */
  createPlayerBody(feet: Vec3): CANNON.Body {
    const { radius, height } = PLAYER_SHAPE;
    const body = new CANNON.Body({
      mass: 70, material: this.playerMaterial, fixedRotation: true, linearDamping: 0.05,
      collisionFilterGroup: Groups.PLAYER, collisionFilterMask: Groups.TERRAIN | Groups.STATIC | Groups.BUILDING,
      allowSleep: false,
    });
    const sphere = new CANNON.Sphere(radius);
    const halfSpan = height / 2 - radius;
    body.addShape(sphere, new CANNON.Vec3(0, -halfSpan, 0));
    body.addShape(sphere, new CANNON.Vec3(0, halfSpan, 0));
    body.position.set(feet.x, feet.y + height / 2 + 0.05, feet.z);
    body.updateMassProperties();
    this.world.addBody(body);
    return body;
  }

  /** True if nothing static/terrain lies between the two points. */
  readonly lineOfSight = (from: Vec3, to: Vec3): boolean => {
    this.rayFrom.set(from.x, from.y, from.z);
    this.rayTo.set(to.x, to.y, to.z);
    this.rayResult.reset();
    return !this.world.raycastClosest(
      this.rayFrom, this.rayTo,
      { collisionFilterMask: Groups.TERRAIN | Groups.STATIC | Groups.BUILDING, skipBackfaces: true },
      this.rayResult,
    );
  };

  /** Short downward ray from the bottom of the player capsule. */
  /**
   * Step-up probe for the character controller: true when, moving along
   * (dirX, dirZ), there is a ledge at ankle height but free space at knee
   * height — i.e. a foundation edge or low step the capsule could hop onto.
   */
  canStepUp(body: CANNON.Body, dirX: number, dirZ: number): boolean {
    const feet = body.position.y - PLAYER_SHAPE.height / 2;
    const reach = PLAYER_SHAPE.radius + 0.35;
    const mask = { collisionFilterMask: Groups.STATIC | Groups.BUILDING | Groups.TERRAIN };
    const probe = (h: number): boolean => {
      this.rayFrom.set(body.position.x, feet + h, body.position.z);
      this.rayTo.set(body.position.x + dirX * reach, feet + h, body.position.z + dirZ * reach);
      this.rayResult.reset();
      return this.world.raycastClosest(this.rayFrom, this.rayTo, mask, this.rayResult);
    };
    return probe(0.12) && !probe(0.75);
  }

  isGrounded(body: CANNON.Body): boolean {
    const bottom = body.position.y - PLAYER_SHAPE.height / 2;
    this.rayFrom.set(body.position.x, bottom + 0.1, body.position.z);
    this.rayTo.set(body.position.x, bottom - 0.15, body.position.z);
    this.rayResult.reset();
    return this.world.raycastClosest(
      this.rayFrom, this.rayTo, { collisionFilterMask: Groups.TERRAIN | Groups.STATIC | Groups.BUILDING }, this.rayResult,
    );
  }
}
