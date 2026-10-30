import { itemDef } from '../../data/items';
import { defineComponent, type Entity, type System, type World } from '../../core/ecs/World';
import type { EventBus } from '../../core/EventBus';
import type { InputManager } from '../../core/Input';
import { PlayerControlled, SurvivorC, Transform, makeTransform } from '../../components';
import type { Vec3 } from '../../data/schema';
import type { InventoryGrid } from '../inventory/InventoryGrid';
import { PlayerAnimC } from '../player/PlayerAnimation';
import {
  BuildingGrid, CELL, PIECE_COSTS, PIECE_ORDER, WALL_HEIGHT, edgeOf, edgeSegment,
  type Candidate, type Piece, type PieceKind,
} from './BuildingGrid';

/** One building piece = one entity carrying this component (+ Transform). */
export interface BuildPiece {
  piece: Piece;
}
export const BuildPieceC = defineComponent<BuildPiece>('BuildPiece');

export interface BuilderState {
  active: boolean;
  kind: PieceKind;
  /** Snapped placement under the crosshair, for the ghost and HUD. */
  preview: Candidate | null;
  /** Null when placeable; otherwise why not (shown in red). */
  blockedReason: string | null;
}
export const BuilderC = defineComponent<BuilderState>('Builder');

/**
 * What the crosshair is pointing at. Implemented by the physics layer with a
 * raycast; the building rules never touch Cannon directly.
 */
export interface AimProvider {
  ray(): { origin: Vec3; dir: Vec3 };
  /** Closest terrain or building surface along the view ray (within maxDistance). */
  cast(maxDistance: number): { point: Vec3; pieceId: number | null } | null;
}

const REACH = 7;
const DOOR_REACH = 3;

/**
 * Build mode (B): R or the mouse wheel cycles the piece, left click places
 * it (paying its cost), X demolishes the aimed piece (half refund, with
 * everything it was holding up). Outside build mode, E opens/closes a door.
 *
 * Emits 'building:placed' / 'building:removed' / 'building:door'; physics,
 * visuals and navigation each listen for those, so this system knows nothing
 * about colliders, meshes or flow fields.
 */
export class BuildingSystem implements System {
  readonly name = 'building';

  constructor(
    readonly grid: BuildingGrid,
    private readonly input: InputManager,
    private readonly events: EventBus,
    private readonly aim: AimProvider,
    private readonly inventoryOf: (world: World, e: Entity) => InventoryGrid,
  ) {}

  update(world: World, dt: number): void {
    void dt;
    const player = world.first(PlayerControlled, SurvivorC, Transform);
    if (player === undefined) return;
    const s = world.require(player, SurvivorC);
    const b = world.get(player, BuilderC) ?? world.add<BuilderState>(player, BuilderC, { active: false, kind: 'foundation', preview: null, blockedReason: null });

    if (this.input.wasPressed('build') && s.alive) b.active = !b.active;
    if (!s.alive) b.active = false;
    const anim = world.get(player, PlayerAnimC);
    if (anim) anim.building = b.active; // tool is put away while holding the building plan

    if (!b.active) {
      b.preview = null;
      // What usable piece (door, bed) is in front of the player, for the HUD prompt and E.
      this.lookingAt = s.alive ? this.usablePieceInSight(world.require(player, Transform).position) : null;
      if (this.input.wasPressed('interact') && this.lookingAt) {
        const p = this.lookingAt;
        if (p.kind === 'bed') {
          this.events.emit('player:sleep-request', { entity: player, bed: p.id });
        } else {
          p.open = !p.open;
          this.events.emit('building:door', { entity: p.id, open: p.open });
        }
      }
      return;
    }
    this.lookingAt = null;

    // Cycle piece type.
    let step = this.input.wasPressed('cyclePiece') ? 1 : 0;
    step += this.input.wheelDelta;
    if (step !== 0) {
      const n = PIECE_ORDER.length;
      b.kind = PIECE_ORDER[(((PIECE_ORDER.indexOf(b.kind) + step) % n) + n) % n]!;
    }

    const ray = this.aim.ray();
    const hit = this.aim.cast(REACH);
    b.preview = this.grid.resolve(b.kind, { ...ray, maxDistance: REACH }, hit);
    const feet = world.require(player, Transform).position;
    const inv = this.inventoryOf(world, player);
    b.blockedReason = !b.preview
      ? hint(b.kind)
      : this.grid.validate(b.preview, feet) ?? missingCost(b.kind, inv);

    if (this.input.wasPressed('attack') && b.preview && !b.blockedReason) {
      for (const c of PIECE_COSTS[b.kind]) inv.remove(c.item, c.qty);
      this.spawn(world, b.preview);
      this.events.emit('inventory:changed', { entity: player });
    }

    if (this.input.wasPressed('demolish') && hit?.pieceId != null && this.grid.get(hit.pieceId)) {
      const removed = this.demolish(world, hit.pieceId);
      for (const p of removed) for (const r of BuildingGrid.refund(p.kind)) inv.add(r.item, r.qty);
      this.events.emit('inventory:changed', { entity: player });
    }
  }

  /** Creates the entity + grid entry and announces it. Also used when loading a save. */
  spawn(world: World, c: Candidate): Entity {
    const e = world.create();
    const piece = this.grid.insert({ ...c, id: e, ...(c.kind === 'doorway' ? { open: c.open ?? false } : {}) });
    const centre = pieceCentre(piece);
    world.add(e, Transform, makeTransform(centre.x, centre.y, centre.z));
    world.add(e, BuildPieceC, { piece });
    this.events.emit('building:placed', { entity: e });
    return e;
  }

  /** Removes a piece and anything that collapses with it. Returns removed pieces. */
  demolish(world: World, id: number): Piece[] {
    const removed = this.grid.remove(id);
    for (const p of removed) {
      this.events.emit('building:removed', { entity: p.id });
      world.destroy(p.id);
    }
    return removed;
  }

  /** Door or bed the player is aiming at (null in build mode). */
  lookingAt: Piece | null = null;

  /** HUD prompt for the piece in sight, if any. */
  prompt(): string | null {
    const p = this.lookingAt;
    if (!p) return null;
    if (p.kind === 'bed') return 'Press E — sleep until morning';
    return p.open ? 'Press E — close door' : 'Press E — open door';
  }

  /**
   * The raycast finds a closed door, a door frame or a bed; an *open* door
   * has no collider in the opening, so we also accept the nearest doorway
   * or bed within reach in front of the player.
   */
  private usablePieceInSight(feet: Vec3): Piece | null {
    const hit = this.aim.cast(DOOR_REACH);
    const direct = hit?.pieceId != null ? this.grid.get(hit.pieceId) : undefined;
    if (direct && (direct.kind === 'doorway' || direct.kind === 'bed')) return direct;
    const { dir } = this.aim.ray();
    let best = DOOR_REACH;
    let found: Piece | null = null;
    for (const q of this.grid.pieces()) {
      if (q.kind !== 'doorway' && q.kind !== 'bed') continue;
      const c = pieceCentre(q);
      const dx = c.x - feet.x, dz = c.z - feet.z, d = Math.hypot(dx, dz);
      if (d < best && Math.abs(c.y - (feet.y + 1)) < 2 && (dx * dir.x + dz * dir.z) / (d || 1) > 0.3) {
        best = d;
        found = q;
      }
    }
    return found;
  }
}

/** World-space centre of a piece (used for its Transform). */
export function pieceCentre(p: Piece): Vec3 {
  if (p.kind === 'bed') {
    const b = BuildingGrid.bedPlacement(p);
    return { x: b.x, y: p.y + 0.3, z: b.z };
  }
  if (p.kind === 'foundation' || p.kind === 'ceiling') return { x: (p.i + 0.5) * CELL, y: p.y, z: (p.j + 0.5) * CELL };
  if (p.kind === 'stairs') return { x: (p.i + 0.5) * CELL, y: p.y + WALL_HEIGHT / 2, z: (p.j + 0.5) * CELL };
  const s = edgeSegment(edgeOf(p.i, p.j, p.side!));
  return { x: (s.x0 + s.x1) / 2, y: p.y + WALL_HEIGHT / 2, z: (s.z0 + s.z1) / 2 };
}

function missingCost(kind: PieceKind, inv: InventoryGrid): string | null {
  const missing = PIECE_COSTS[kind].filter((c) => inv.count(c.item) < c.qty);
  return missing.length ? `Need ${missing.map((m) => `${m.qty - inv.count(m.item)} more ${itemDef(m.item).name}`).join(', ')}` : null;
}

function hint(kind: PieceKind): string {
  if (kind === 'wall' || kind === 'doorway' || kind === 'bed') return 'Aim at the top of a foundation or floor';
  if (kind === 'stairs') return 'Aim at a floor — they climb the way you look';
  if (kind === 'ceiling') return 'Aim above your walls';
  return 'Aim at the ground';
}
