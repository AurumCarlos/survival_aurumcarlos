import * as CANNON from 'cannon-es';
import * as THREE from 'three';
import type { Entity, System, World } from '../core/ecs/World';
import type { InputManager } from '../core/Input';
import type { EventBus } from '../core/EventBus';
import { PlayerAnimC } from '../systems/player/PlayerAnimation';
import { BuilderC } from '../systems/building/BuildingSystem';
import { ObjectPool } from '../core/ObjectPool';
import type { SpatialHash } from '../core/SpatialHash';
import {
  AIBrain, Creature, Cullable, PlayerControlled, ResourceC, StealthState, SurvivorC, Transform,
} from '../components';
import { itemDef, makeResource } from '../data/items';
import { MELEE_REACH } from '../data/combat';
import type { ItemStack } from '../data/schema';
import { flatMaterial, spearGeometry } from '../render/LowPolyFactory';
import { RenderObject } from '../render/Renderer';
import { Groups, type PhysicsWorld } from './PhysicsWorld';

interface Projectile {
  mesh: THREE.Mesh;
  body: CANNON.Body;
  stack: ItemStack | null;
  /** Seconds until it is returned to the pool (spear lost). */
  life: number;
  /** Landed and waiting to be picked up. */
  resting: boolean;
  hitEntities: Set<Entity>;
}

const THROW_SPEED = 26;
const PROJECTILE_LIFE = 60;

const FIST_DAMAGE = 5;
const KNOCKBACK = 0.4; // metres — small, so a follow-up hit is still in reach

/**
 * Melee + thrown spears.
 *
 * Projectiles come from an ObjectPool of (mesh, body) pairs created once at
 * load time. Throwing acquires a pair, adds the body to the Cannon world and
 * shows the mesh; landing/expiring removes the body and hides the mesh. No
 * THREE.Mesh, BufferGeometry or CANNON.Body is ever allocated mid-game.
 */
export class CombatSystem implements System {
  readonly name = 'combat';
  private readonly pool: ObjectPool<Projectile>;
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpDir = new THREE.Vector3();
  private readonly forward = new THREE.Vector3(0, 0, 1);

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly scene: THREE.Scene,
    private readonly input: InputManager,
    private readonly camera: THREE.Camera,
    private readonly resourceIndex: SpatialHash,
    private readonly events: EventBus,
    /** Nav query so knockback never shoves a creature into a trunk or the sea. */
    private readonly isWalkable: (x: number, z: number) => boolean = () => true,
  ) {
    events.on('player:action-impact', ({ action }) => {
      if (action === 'throw') this.pendingThrow = true;
      else if (action === 'swing') this.pendingMelee = true;
    });
    const geo = spearGeometry();
    this.pool = new ObjectPool<Projectile>({
      prewarm: 8,
      max: 16,
      onExhausted: 'recycle-oldest',
      create: () => {
        const mesh = new THREE.Mesh(geo, flatMaterial);
        mesh.castShadow = true;
        mesh.visible = false;
        scene.add(mesh);
        const body = new CANNON.Body({
          mass: 1.2, linearDamping: 0.01, angularDamping: 0.4,
          collisionFilterGroup: Groups.PROJECTILE, collisionFilterMask: Groups.TERRAIN | Groups.STATIC | Groups.BUILDING,
        });
        body.addShape(new CANNON.Box(new CANNON.Vec3(0.04, 0.04, 0.8)));
        return { mesh, body, stack: null, life: 0, resting: false, hitEntities: new Set() };
      },
      reset: (p) => {
        p.mesh.visible = false;
        if (p.body.world) this.physics.world.removeBody(p.body);
        p.body.velocity.setZero();
        p.body.angularVelocity.setZero();
        p.stack = null;
        p.resting = false;
        p.hitEntities.clear();
      },
    });
  }

  /**
   * Buttons only *request* an animation; the effect is applied on the clip's
   * impact frame ('player:action-impact'), then executed in the next fixed
   * step so physics (spear launch) stays on the fixed timeline.
   */
  private pendingThrow = false;
  private pendingMelee = false;

  update(world: World): void {
    const player = world.first(PlayerControlled, PlayerAnimC);
    if (player !== undefined) {
      const anim = world.require(player, PlayerAnimC);
      // In build mode the mouse buttons place/remove pieces instead.
      if (world.get(player, BuilderC)?.active) return void this.syncProjectiles();
      if (this.input.wasPressed('throw')) anim.request = 'throw';
      else if (this.input.wasPressed('attack')) anim.request = 'swing';
    }
    this.syncProjectiles();
  }

  /** Projectile meshes follow their bodies. They're short-lived and fast, so no interpolation (one-step lag is invisible at 26 m/s). */
  private syncProjectiles(): void {
    this.pool.forEachLive((p) => {
      p.mesh.position.set(p.body.position.x, p.body.position.y, p.body.position.z);
      p.mesh.quaternion.set(p.body.quaternion.x, p.body.quaternion.y, p.body.quaternion.z, p.body.quaternion.w);
    });
  }

  fixedUpdate(world: World, dt: number): void {
    const player = world.first(PlayerControlled, SurvivorC, Transform);
    if (player !== undefined) {
      const s = world.require(player, SurvivorC);
      if (s.alive && this.pendingThrow) this.throwSpear(world, player);
      if (s.alive && this.pendingMelee) this.melee(world, player);
    }
    this.pendingThrow = this.pendingMelee = false;

    const toRelease: Projectile[] = [];
    this.pool.forEachLive((p) => {
      p.life -= dt;
      if (p.life <= 0) {
        toRelease.push(p);
        return;
      }
      const speed = p.body.velocity.length();
      if (!p.resting && speed > 4) {
        // Point the spear along its velocity (arrows don't tumble).
        this.tmpDir.set(p.body.velocity.x, p.body.velocity.y, p.body.velocity.z).normalize();
        this.tmpQuat.setFromUnitVectors(this.forward, this.tmpDir);
        p.body.quaternion.set(this.tmpQuat.x, this.tmpQuat.y, this.tmpQuat.z, this.tmpQuat.w);
        this.hitCreatures(world, p, speed);
      } else if (!p.resting && speed < 0.5) {
        p.resting = true;
        p.body.type = CANNON.Body.STATIC; // stop simulating it
      }
      // Walk over a resting spear to pick it up.
      if (p.resting && player !== undefined && p.stack) {
        const pp = world.require(player, Transform).position;
        if (Math.hypot(pp.x - p.body.position.x, pp.z - p.body.position.z) < 1.5) {
          const s = world.require(player, SurvivorC);
          const free = s.hotbar.findIndex((h) => h === null);
          if (free >= 0) {
            s.hotbar[free] = p.stack;
            p.stack = null;
            toRelease.push(p);
          }
        }
      }
    });
    for (const p of toRelease) {
      p.body.type = CANNON.Body.DYNAMIC;
      this.pool.release(p);
    }
  }

  private throwSpear(world: World, player: Entity): void {
    const s = world.require(player, SurvivorC);
    const held = s.hotbar[s.activeHotbarSlot];
    if (!held || held.item !== 'stone_spear') return;
    const p = this.pool.acquire();
    if (!p) return;
    s.hotbar[s.activeHotbarSlot] = null;
    p.stack = held;
    p.life = PROJECTILE_LIFE;

    this.camera.getWorldDirection(this.tmpDir);
    const origin = this.camera.position;
    p.body.type = CANNON.Body.DYNAMIC;
    p.body.position.set(origin.x + this.tmpDir.x * 0.8, origin.y + this.tmpDir.y * 0.8, origin.z + this.tmpDir.z * 0.8);
    p.body.velocity.set(this.tmpDir.x * THROW_SPEED, this.tmpDir.y * THROW_SPEED + 1.5, this.tmpDir.z * THROW_SPEED);
    p.body.wakeUp();
    this.physics.world.addBody(p.body);
    p.mesh.visible = true;
    const st = world.get(player, StealthState);
    if (st) st.pendingNoise = Math.max(st.pendingNoise, 6);
  }

  private melee(world: World, player: Entity): void {
    const s = world.require(player, SurvivorC);
    const pc = world.require(player, PlayerControlled);
    const pp = world.require(player, Transform).position;
    const held = s.hotbar[s.activeHotbarSlot];
    const tool = held ? itemDef(held.item).tool : undefined;
    const damage = tool ? tool.damage : FIST_DAMAGE;
    const reach = held?.item === 'stone_spear' ? MELEE_REACH.spear : tool ? MELEE_REACH.tool : MELEE_REACH.fist;
    const target = this.meleeTarget(world, pp, pc.yaw, reach);
    if (target !== null) {
      this.damageCreature(world, target, damage, pp);
      if (held?.durability !== undefined) held.durability -= 1;
    }
    const st = world.get(player, StealthState);
    if (st) st.pendingNoise = Math.max(st.pendingNoise, 8);
  }

  /**
   * What the swing connects with: the creature under the crosshair (camera
   * ray vs a sphere around its body), like Minecraft. If nothing is exactly
   * under the crosshair, a creature very close and roughly in front still
   * counts, so point-blank fights don't need pixel aim.
   */
  private meleeTarget(world: World, feet: { x: number; y: number; z: number }, yaw: number, reach: number): Entity | null {
    this.camera.getWorldDirection(this.tmpDir);
    const o = this.camera.position;
    let best: Entity | null = null, bestT = Infinity;
    let close: Entity | null = null, closeD = Infinity;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    for (const e of world.query(Creature, Transform)) {
      if (world.require(e, Creature).health <= 0) continue;
      const cp = world.require(e, Transform).position;
      // Ray vs body sphere (centre ~0.6 m above the feet, radius 0.75 m).
      const cx = cp.x - o.x, cy = cp.y + 0.6 - o.y, cz = cp.z - o.z;
      const t = cx * this.tmpDir.x + cy * this.tmpDir.y + cz * this.tmpDir.z;
      if (t > 0 && t < reach + 0.5) {
        const perp2 = cx * cx + cy * cy + cz * cz - t * t;
        if (perp2 < 0.75 * 0.75 && t < bestT) {
          bestT = t;
          best = e;
        }
      }
      const dx = cp.x - feet.x, dz = cp.z - feet.z, d = Math.hypot(dx, dz);
      if (d < reach * 0.8 && (dx * fx + dz * fz) / (d || 1) > 0.6 && d < closeD) {
        closeD = d;
        close = e;
      }
    }
    return best ?? close;
  }

  private hitCreatures(world: World, p: Projectile, speed: number): void {
    const bp = p.body.position;
    for (const e of world.query(Creature, Transform)) {
      if (p.hitEntities.has(e)) continue;
      const c = world.require(e, Creature);
      if (c.health <= 0) continue;
      const cp = world.require(e, Transform).position;
      if (Math.hypot(cp.x - bp.x, cp.y + 0.6 - bp.y, cp.z - bp.z) > 0.9) continue;
      p.hitEntities.add(e);
      const base = p.stack ? (itemDef(p.stack.item).tool?.damage ?? 10) : 10;
      this.damageCreature(world, e, base * Math.min(1.5, speed / 18), { x: bp.x, y: bp.y, z: bp.z });
      p.body.velocity.scale(0.2, p.body.velocity); // embed / lose momentum
    }
  }

  private damageCreature(world: World, e: Entity, amount: number, from: { x: number; y: number; z: number }): void {
    const c = world.require(e, Creature);
    c.health -= amount;
    const killed = c.health <= 0;
    // Getting hit always reveals the attacker's position.
    c.perception.awareness = Math.max(c.perception.awareness, 1);
    c.perception.lastKnownTargetPos = { ...from };
    c.perception.lastKnownAge = 0;
    // Knockback: a short shove away from the hit, so a hit *reads* as a hit.
    const tp = world.require(e, Transform).position;
    const dx = tp.x - from.x, dz = tp.z - from.z;
    const d = Math.hypot(dx, dz) || 1;
    const kx = tp.x + (dx / d) * KNOCKBACK, kz = tp.z + (dz / d) * KNOCKBACK;
    if (!killed && this.isWalkable(kx, kz)) {
      tp.x = kx;
      tp.z = kz;
    }
    this.events.emit('creature:hit', { entity: e, amount, killed });
    if (!killed) return;

    // Death: the creature becomes a harvestable carcass.
    const t = world.require(e, Transform);
    world.remove(e, AIBrain);
    world.remove(e, Creature);
    world.remove(e, Cullable);
    world.add(e, ResourceC, makeResource(e, 'carcass', { ...t.position }));
    this.resourceIndex.insert(e, t.position.x, t.position.z);
    const ro = world.get(e, RenderObject);
    if (ro) {
      ro.object.rotation.z = Math.PI / 2;
      ro.object.position.y = t.position.y + 0.25;
      ro.interpolate = false;
    }
  }
}
