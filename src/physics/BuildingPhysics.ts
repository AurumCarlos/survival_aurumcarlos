import * as CANNON from 'cannon-es';
import type * as THREE from 'three';
import type { EventBus } from '../core/EventBus';
import type { Vec3 } from '../data/schema';
import { BED, BuildingGrid, CELL, DOOR, STAIRS, WALL_HEIGHT, edgeOf, edgeSegment, type Piece } from '../systems/building/BuildingGrid';
import type { AimProvider } from '../systems/building/BuildingSystem';
import { Groups, type PhysicsWorld } from './PhysicsWorld';

const WALL_HALF_THICK = 0.1;
const SLAB = 0.2;

interface Bodies {
  main: CANNON.Body;
  door?: CANNON.Body;
}

/**
 * Colliders for player buildings, plus the crosshair raycast used to aim
 * placement. Walls and closed doors physically stop the player, projectiles
 * and creature line-of-sight (perception raycasts include Groups.BUILDING),
 * so being inside a closed house really hides you.
 */
export class BuildingPhysics implements AimProvider {
  private readonly bodies = new Map<number, Bodies>();
  private readonly pieceOfBody = new Map<CANNON.Body, number>();
  private readonly offs: Array<() => void>;
  private readonly from = new CANNON.Vec3();
  private readonly to = new CANNON.Vec3();
  private readonly result = new CANNON.RaycastResult();
  private readonly dir = { x: 0, y: 0, z: -1 };

  constructor(
    private readonly grid: BuildingGrid,
    private readonly physics: PhysicsWorld,
    private readonly camera: THREE.Camera & { getWorldDirection(v: THREE.Vector3): THREE.Vector3 },
    private readonly tmpDir: THREE.Vector3,
    events: EventBus,
  ) {
    for (const p of grid.pieces()) this.add(p);
    this.offs = [
      events.on('building:placed', ({ entity }) => {
        const p = grid.get(entity);
        if (p) this.add(p);
      }),
      events.on('building:removed', ({ entity }) => this.remove(entity)),
      events.on('building:door', ({ entity, open }) => {
        const door = this.bodies.get(entity)?.door;
        if (!door) return;
        if (open && door.world) this.physics.world.removeBody(door);
        if (!open && !door.world) this.physics.world.addBody(door);
      }),
    ];
  }

  // ---- AimProvider -------------------------------------------------------------

  ray(): { origin: Vec3; dir: Vec3 } {
    this.camera.getWorldDirection(this.tmpDir);
    this.dir.x = this.tmpDir.x;
    this.dir.y = this.tmpDir.y;
    this.dir.z = this.tmpDir.z;
    const o = this.camera.position;
    return { origin: { x: o.x, y: o.y, z: o.z }, dir: this.dir };
  }

  cast(maxDistance: number): { point: Vec3; pieceId: number | null } | null {
    const { origin, dir } = this.ray();
    this.from.set(origin.x, origin.y, origin.z);
    this.to.set(origin.x + dir.x * maxDistance, origin.y + dir.y * maxDistance, origin.z + dir.z * maxDistance);
    this.result.reset();
    const hit = this.physics.world.raycastClosest(this.from, this.to, {
      collisionFilterMask: Groups.TERRAIN | Groups.BUILDING, skipBackfaces: true,
    }, this.result);
    if (!hit || !this.result.body) return null;
    const p = this.result.hitPointWorld;
    return { point: { x: p.x, y: p.y, z: p.z }, pieceId: this.pieceOfBody.get(this.result.body) ?? null };
  }

  // ---- colliders -----------------------------------------------------------------

  private add(p: Piece): void {
    const main = new CANNON.Body({ mass: 0, collisionFilterGroup: Groups.BUILDING, collisionFilterMask: Groups.PLAYER | Groups.PROJECTILE });
    let door: CANNON.Body | undefined;

    if (p.kind === 'stairs') {
      // No walkable collider: the player is snapped onto the stairs surface
      // (PhysicsSystem) so they never slide down a ramp. This sloped slab
      // only answers the aim raycast (to demolish it) and projectiles.
      main.collisionFilterMask = Groups.PROJECTILE;
      const ex = p.side === 'e' || p.side === 'w';
      const L = (Math.SQRT2 * CELL) / 2;
      main.addShape(new CANNON.Box(ex ? new CANNON.Vec3(L, 0.1, STAIRS.width / 2) : new CANNON.Vec3(STAIRS.width / 2, 0.1, L)));
      main.position.set((p.i + 0.5) * CELL, p.y + WALL_HEIGHT / 2 - 0.15, (p.j + 0.5) * CELL);
      const a = Math.PI / 4;
      if (p.side === 'e') main.quaternion.setFromEuler(0, 0, a);
      else if (p.side === 'w') main.quaternion.setFromEuler(0, 0, -a);
      else if (p.side === 's') main.quaternion.setFromEuler(-a, 0, 0);
      else main.quaternion.setFromEuler(a, 0, 0);
    } else if (p.kind === 'bed') {
      const b = BuildingGrid.bedPlacement(p);
      main.addShape(new CANNON.Box(b.alongX
        ? new CANNON.Vec3(BED.length / 2, BED.height / 2, BED.width / 2)
        : new CANNON.Vec3(BED.width / 2, BED.height / 2, BED.length / 2)));
      main.position.set(b.x, p.y + BED.height / 2, b.z);
    } else if (p.kind === 'foundation' || p.kind === 'ceiling') {
      const bottom = p.kind === 'foundation' ? this.grid.groundUnder(p.i, p.j) - 0.5 : p.y - SLAB;
      const h = p.y - bottom;
      main.addShape(new CANNON.Box(new CANNON.Vec3(CELL / 2, h / 2, CELL / 2)));
      main.position.set((p.i + 0.5) * CELL, bottom + h / 2, (p.j + 0.5) * CELL);
    } else {
      const s = edgeSegment(edgeOf(p.i, p.j, p.side!));
      const alongX = s.z0 === s.z1;
      const cx = (s.x0 + s.x1) / 2, cz = (s.z0 + s.z1) / 2;
      const box = (halfAlong: number, halfH: number, offAlong: number, offY: number): void => {
        const half = alongX ? new CANNON.Vec3(halfAlong, halfH, WALL_HALF_THICK) : new CANNON.Vec3(WALL_HALF_THICK, halfH, halfAlong);
        const off = alongX ? new CANNON.Vec3(offAlong, offY, 0) : new CANNON.Vec3(0, offY, offAlong);
        main.addShape(new CANNON.Box(half), off);
      };
      main.position.set(cx, p.y, cz);
      if (p.kind === 'wall') {
        box(CELL / 2, WALL_HEIGHT / 2, 0, WALL_HEIGHT / 2);
      } else {
        const post = (CELL - DOOR.width) / 2;
        box(post / 2, WALL_HEIGHT / 2, -(DOOR.width / 2 + post / 2), WALL_HEIGHT / 2);
        box(post / 2, WALL_HEIGHT / 2, DOOR.width / 2 + post / 2, WALL_HEIGHT / 2);
        const lintel = WALL_HEIGHT - DOOR.height;
        box(DOOR.width / 2, lintel / 2, 0, DOOR.height + lintel / 2);
        door = new CANNON.Body({ mass: 0, collisionFilterGroup: Groups.BUILDING, collisionFilterMask: Groups.PLAYER | Groups.PROJECTILE });
        door.addShape(new CANNON.Box(alongX
          ? new CANNON.Vec3(DOOR.width / 2, DOOR.height / 2, WALL_HALF_THICK / 2)
          : new CANNON.Vec3(WALL_HALF_THICK / 2, DOOR.height / 2, DOOR.width / 2)));
        door.position.set(cx, p.y + DOOR.height / 2, cz);
        this.pieceOfBody.set(door, p.id);
        if (!p.open) this.physics.world.addBody(door);
      }
    }
    this.physics.world.addBody(main);
    this.pieceOfBody.set(main, p.id);
    this.bodies.set(p.id, door ? { main, door } : { main });
  }

  private remove(id: number): void {
    const b = this.bodies.get(id);
    if (!b) return;
    for (const body of [b.main, b.door]) {
      if (!body) continue;
      if (body.world) this.physics.world.removeBody(body);
      this.pieceOfBody.delete(body);
    }
    this.bodies.delete(id);
  }

  dispose(): void {
    for (const off of this.offs) off();
  }
}
