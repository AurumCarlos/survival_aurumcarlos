import * as CANNON from 'cannon-es';
import type { Entity, World } from '../core/ecs/World';
import type { EventBus } from '../core/EventBus';
import { Structure, Transform } from '../components';
import { STRUCTURES } from '../data/stations';
import { Groups, type PhysicsWorld } from './PhysicsWorld';

/** Fires and the lean-to stay walk-through, as before; boxes and stations are solid. */
const WALK_THROUGH = new Set(['campfire', 'lean_to', 'death_bag']);

/**
 * Box colliders for placed structures (storage boxes, forge, smithy…), in the
 * BUILDING group so the player can't walk through them, can step onto low
 * ones, and the step-assist/aim rays see them.
 */
export class StructurePhysics {
  private readonly bodies = new Map<Entity, CANNON.Body>();
  private readonly offs: Array<() => void>;

  constructor(private readonly world: World, private readonly physics: PhysicsWorld, events: EventBus) {
    for (const e of world.query(Structure, Transform)) this.add(e);
    this.offs = [
      events.on('structure:placed', ({ entity }) => this.add(entity)),
      events.on('structure:removed', ({ entity }) => this.remove(entity)),
    ];
  }

  private add(e: Entity): void {
    const st = this.world.get(e, Structure);
    if (!st || WALK_THROUGH.has(st.kind) || this.bodies.has(e)) return;
    const { hx, hz, h } = STRUCTURES[st.kind].size;
    const p = this.world.require(e, Transform).position;
    const body = new CANNON.Body({ mass: 0, collisionFilterGroup: Groups.BUILDING, collisionFilterMask: Groups.PLAYER | Groups.PROJECTILE });
    body.addShape(new CANNON.Box(new CANNON.Vec3(hx, h / 2, hz)));
    body.position.set(p.x, p.y + h / 2, p.z);
    body.quaternion.setFromEuler(0, st.yaw, 0);
    this.physics.world.addBody(body);
    this.bodies.set(e, body);
  }

  private remove(e: Entity): void {
    const b = this.bodies.get(e);
    if (!b) return;
    this.physics.world.removeBody(b);
    this.bodies.delete(e);
  }

  dispose(): void {
    for (const off of this.offs) off();
  }
}
