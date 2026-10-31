import type { Entity, System, World } from '../core/ecs/World';
import type { EventBus } from '../core/EventBus';
import type { InputManager } from '../core/Input';
import { PlayerControlled, ResourceC, StealthState, SurvivorC, Transform } from '../components';
import { itemDef } from '../data/items';
import type { ItemId, ItemStack, Resource, Survivor } from '../data/schema';
import type { InventoryGrid } from './inventory/InventoryGrid';
import type { SpatialHash } from '../core/SpatialHash';
import { PlayerAnimC } from './player/PlayerAnimation';

export interface HarvestResult {
  gained: Array<{ item: ItemId; qty: number }>;
  overflow: Array<{ item: ItemId; qty: number }>;
  depleted: boolean;
  /** Refused: needs a tool the player doesn't hold. */
  blocked: boolean;
  toolBroke: boolean;
  noise: number;
}

export type ToolFit = 'right' | 'wrong' | 'hands' | 'any';

export interface ToolEffect {
  fit: ToolFit;
  /** Multiplier on what each hit yields. */
  yieldMult: number;
  /** Resource hit points removed per hit (fewer hits to fell a tree). */
  damage: number;
  /** Harvest animation speed multiplier. */
  speed: number;
}

/**
 * How well what's in hand works on a resource:
 *
 * | in hand                      | yield/hit | hits needed | swing speed |
 * |------------------------------|-----------|-------------|-------------|
 * | right tool (axe→tree, pickaxe→rock, spear→carcass) | ×2.5 | ÷2 | ×1.4 |
 * | another tool                 | ×0.75     | normal      | normal      |
 * | bare hands                   | ×0.5      | normal      | ×0.85       |
 *
 * So an axe gets ~2.5× more wood out of a tree, ~8× faster than punching it. Berries,
 * fiber and water don't care what you hold.
 */
export const HARVEST_TUNING = {
  right: { damage: 2, speed: 1.4 },
  wrong: { yieldMult: 0.75, damage: 1, speed: 1 },
  hands: { yieldMult: 0.5, damage: 1, speed: 0.85 },
} as const;

export function toolEffect(r: Resource, held: ItemStack | null): ToolEffect | null {
  if (!r.requiredTool) return { fit: 'any', yieldMult: 1, damage: 1, speed: 1 };
  const tool = held ? itemDef(held.item).tool : undefined;
  if (tool?.tags.includes(r.requiredTool)) {
    return { fit: 'right', yieldMult: tool.gatherMultiplier, damage: HARVEST_TUNING.right.damage, speed: HARVEST_TUNING.right.speed };
  }
  if (tool) return { fit: 'wrong', ...HARVEST_TUNING.wrong };
  if (!r.allowBareHands) return null;
  return { fit: 'hands', ...HARVEST_TUNING.hands };
}

/** Display name of the tool that suits a resource best. */
export const BEST_TOOL_NAME: Readonly<Record<string, string>> = { axe: 'axe', pickaxe: 'pickaxe', blade: 'spear', sickle: 'sickle' };

/**
 * One harvest action (one swing / one pick). Pure function over plain data.
 * See HARVEST_TUNING for how the tool in hand changes the outcome.
 */
export function harvest(s: Survivor, inv: InventoryGrid, r: Resource, rng: () => number): HarvestResult {
  const res: HarvestResult = { gained: [], overflow: [], depleted: false, blocked: false, toolBroke: false, noise: r.harvestNoise };
  if (!r.infinite && r.hitPoints <= 0) {
    res.depleted = true;
    return res;
  }

  const held: ItemStack | null = s.hotbar[s.activeHotbarSlot] ?? null;
  const fx = toolEffect(r, held);
  if (!fx) {
    res.blocked = true;
    res.noise = 0;
    return res;
  }
  const mult = fx.yieldMult * s.modifiers.gatherSpeed;

  const heldTool = held ? itemDef(held.item).tool : undefined;
  for (const y of r.yields) {
    if (rng() > y.chance) continue;
    const base = y.min + Math.floor(rng() * (y.max - y.min + 1));
    // Per-yield preference (ARK-style): thatch comes off trees by hand, not
    // with the axe; a sickle multiplies fiber and berries.
    let m = mult;
    if (y.favour === 'hands') m = (fx.fit === 'right' ? 0.4 : 1.5) * s.modifiers.gatherSpeed;
    else if (y.favour && heldTool?.tags.includes(y.favour)) m = heldTool.gatherMultiplier * s.modifiers.gatherSpeed;
    // Fractional yields are resolved stochastically so 0.5× isn't always 0.
    const raw = base * m;
    const qty = Math.floor(raw) + (rng() < raw - Math.floor(raw) ? 1 : 0);
    if (qty <= 0) continue;
    const left = inv.add(y.item, qty);
    if (qty - left > 0) res.gained.push({ item: y.item, qty: qty - left });
    if (left > 0) res.overflow.push({ item: y.item, qty: left });
  }

  // Any tool used on a tool-relevant resource wears.
  if (held?.durability !== undefined && (fx.fit === 'right' || fx.fit === 'wrong')) {
    held.durability -= 1;
    if (held.durability <= 0) {
      s.hotbar[s.activeHotbarSlot] = null;
      res.toolBroke = true;
    }
  }

  if (!r.infinite) {
    r.hitPoints = Math.max(0, r.hitPoints - fx.damage);
    if (r.hitPoints <= 0) {
      r.respawnTimer = r.respawnSeconds;
      res.depleted = true;
    }
  }
  return res;
}

/**
 * E to interact: finds the closest harvestable in front of the player and,
 * while E is held, asks the animation layer for 'harvest' clips. The yield is
 * applied on each clip's impact frame (event 'player:action-impact'), so the
 * resource reacts exactly when the axe visibly lands. Also regrows depleted
 * resources.
 */
export class InteractionSystem implements System {
  readonly name = 'interaction';
  /** Impacts received since the last update (normally 0 or 1). */
  private pendingImpacts = 0;
  /** Closest valid target this frame, for the HUD prompt. */
  focused: Entity | null = null;
  /** While true (a box or station is targeted), E does not harvest. */
  blocked: () => boolean = () => false;
  /** While true (build mode: the wheel picks the piece), the wheel doesn't change hotbar slot. */
  wheelBlocked: () => boolean = () => false;

  constructor(
    private readonly input: InputManager,
    private readonly events: EventBus,
    private readonly inventoryOf: (world: World, e: Entity) => InventoryGrid,
    /** Resource entities indexed by position (built once by the world builder). */
    private readonly index: SpatialHash,
    private readonly rng: () => number = Math.random,
    private readonly reach = 3.2,
  ) {
    events.on('player:action-impact', ({ action }) => {
      if (action === 'harvest') this.pendingImpacts++;
    });
    events.on('resource:depleted', ({ entity }) => this.depleted.add(entity));
  }

  /**
   * Resources waiting to regrow (or, for carcasses, to be removed). Only these
   * are ticked: a 1000 m island has ~50,000 resources and scanning them all
   * 60 times a second cost more than everything else together.
   */
  private readonly depleted = new Set<Entity>();
  private scanned = false;

  update(world: World): void {
    const player = world.first(PlayerControlled, SurvivorC, Transform);
    if (player === undefined) return;
    const s = world.require(player, SurvivorC);
    const pc = world.require(player, PlayerControlled);
    const p = world.require(player, Transform).position;

    // Mouse wheel: next / previous hotbar slot (wrapping), like number keys 1–6.
    const wheel = this.input.wheelDelta;
    if (wheel !== 0 && s.alive && !this.wheelBlocked()) {
      const n = s.hotbar.length;
      s.activeHotbarSlot = (((s.activeHotbarSlot + Math.sign(wheel)) % n) + n) % n;
      this.events.emit('inventory:changed', { entity: player });
    }

    this.focused = this.blocked() ? null : this.findTarget(world, p.x, p.z, pc.yaw);

    // Apply impacts from the previous frame's animation step.
    for (; this.pendingImpacts > 0; this.pendingImpacts--) {
      if (this.focused !== null && s.alive) this.harvestFocused(world, player);
    }

    const anim = world.get(player, PlayerAnimC);
    const holding = this.input.isDown('interact') && this.focused !== null && s.alive;
    const midHarvest = anim?.state === 'harvest';
    if (holding) {
      const r = world.require(this.focused!, ResourceC);
      // Take the right tool out automatically if it's on the hotbar.
      if (r.requiredTool && this.input.wasPressed('interact')) {
        const slot = s.hotbar.findIndex((h) => !!h && (itemDef(h.item).tool?.tags.includes(r.requiredTool!) ?? false));
        if (slot >= 0 && slot !== s.activeHotbarSlot) {
          s.activeHotbarSlot = slot;
          this.events.emit('inventory:changed', { entity: player });
        }
      }
      const fx = toolEffect(r, s.hotbar[s.activeHotbarSlot] ?? null);
      if (!fx) {
        if (this.input.wasPressed('interact')) {
          this.events.emit('harvest:blocked', { entity: player, tool: BEST_TOOL_NAME[r.requiredTool ?? ''] ?? 'tool' });
        }
        return;
      }
      if (anim) {
        anim.request = 'harvest';
        anim.actionSpeed = fx.speed;
      }
      s.activity = 'gathering';
    } else if (s.activity === 'gathering' && !midHarvest) {
      s.activity = 'idle';
    }
  }

  private harvestFocused(world: World, player: Entity): void {
    const s = world.require(player, SurvivorC);
    const r = world.require(this.focused!, ResourceC);
    const result = harvest(s, this.inventoryOf(world, player), r, this.rng);
    const stealth = world.get(player, StealthState);
    if (stealth) stealth.pendingNoise = Math.max(stealth.pendingNoise, result.noise);
    if (result.gained.length) this.events.emit('inventory:changed', { entity: player });
    for (const o of result.overflow) this.events.emit('inventory:full', { entity: player, item: o.item, leftover: o.qty });
    if (result.depleted) this.events.emit('resource:depleted', { entity: this.focused! });
  }

  fixedUpdate(world: World, dt: number): void {
    if (!this.scanned) {
      // Once: whatever a loaded save left depleted.
      this.scanned = true;
      for (const e of world.query(ResourceC)) {
        const r = world.require(e, ResourceC);
        if (r.hitPoints <= 0 && !r.infinite) this.depleted.add(e);
      }
    }
    for (const e of this.depleted) {
      const r = world.get(e, ResourceC);
      if (!r || r.infinite || r.hitPoints > 0) {
        this.depleted.delete(e);
        continue;
      }
      if (r.respawnSeconds === Number.POSITIVE_INFINITY) {
        world.destroy(e); // carcasses vanish when emptied
        this.index.remove(e);
        this.depleted.delete(e);
        continue;
      }
      r.respawnTimer -= dt;
      if (r.respawnTimer > 0) continue;
      // A tree or boulder must not grow back around the player; wait until they step away.
      if (r.requiredTool && this.playerNear(world, r.position.x, r.position.z, 1.6)) continue;
      r.hitPoints = r.maxHitPoints;
      this.depleted.delete(e);
      this.events.emit('resource:regrown', { entity: e });
    }
  }

  private playerNear(world: World, x: number, z: number, d: number): boolean {
    const pl = world.first(PlayerControlled, Transform);
    if (pl === undefined) return false;
    const p = world.require(pl, Transform).position;
    return Math.hypot(p.x - x, p.z - z) < d;
  }

  /** Nearest non-depleted resource within reach and within ±50° of the view direction. */
  private findTarget(world: World, px: number, pz: number, yaw: number): Entity | null {
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const minDot = Math.cos((50 * Math.PI) / 180);
    let best: Entity | null = null;
    let bestD = this.reach;
    this.index.forEachNear(px, pz, this.reach, (e) => {
      const r = world.get(e, ResourceC);
      if (!r || (!r.infinite && r.hitPoints <= 0)) return;
      const dx = r.position.x - px, dz = r.position.z - pz;
      const d = Math.hypot(dx, dz);
      if (d >= bestD || d < 1e-3) return;
      if ((dx * fx + dz * fz) / d < minDot) return;
      best = e;
      bestD = d;
    });
    return best;
  }
}
