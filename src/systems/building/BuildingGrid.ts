import type { ItemId, Vec3 } from '../../data/schema';

/**
 * Base-building rules (Rust-style snapping), pure data — no Three, no Cannon.
 *
 * World XZ is divided into 3 m cells. Pieces:
 *  - foundation: fills a cell; top surface at `y`. Raised on a pillar to the
 *    highest ground in its footprint, or snapped to the height of a
 *    neighbouring foundation so floors line up.
 *  - wall / doorway: sit on a cell *edge*, bottom at `y`, 3 m tall. Need a
 *    floor (foundation or ceiling) at that height on either side of the edge.
 *  - ceiling: fills a cell with its top at `y`; is the floor of the next
 *    storey. Needs a wall on one of its edges reaching up to it, or a
 *    neighbouring ceiling that has one (one cell of overhang).
 *
 * Removing a piece removes everything that loses support (cascade).
 */

export const CELL = 3;
export const WALL_HEIGHT = 3;
/** Doorway: 1 m wide, 2.2 m tall opening in the middle of a 3 m wall. */
export const DOOR = { width: 1, height: 2.2 } as const;
/** Single bed: 1 m wide, 2 m long, mattress top at 0.5 m. */
export const BED = { width: 1.1, length: 2.1, height: 0.5 } as const;
const FOUNDATION_CLEARANCE = 0.35;
const MAX_PILLAR = 3.5;

export type PieceKind = 'foundation' | 'wall' | 'doorway' | 'ceiling' | 'bed';
/** Cell edges: n = −Z side, s = +Z, w = −X, e = +X. */
export type Side = 'n' | 'e' | 's' | 'w';

export interface Piece {
  /** ECS entity that owns this piece. */
  id: number;
  kind: PieceKind;
  i: number;
  j: number;
  /** Floors: top surface. Walls: bottom. */
  y: number;
  side?: Side;
  /** Doorways only. */
  open?: boolean;
}

export type Candidate = Omit<Piece, 'id'>;

export const PIECE_COSTS: Readonly<Record<PieceKind, ReadonlyArray<{ item: ItemId; qty: number }>>> = {
  foundation: [{ item: 'wood', qty: 2 }, { item: 'stone', qty: 1 }],
  wall: [{ item: 'wood', qty: 2 }],
  doorway: [{ item: 'wood', qty: 2 }, { item: 'fiber', qty: 1 }],
  ceiling: [{ item: 'wood', qty: 2 }],
  bed: [{ item: 'wood', qty: 3 }, { item: 'fiber', qty: 4 }],
};
export const PIECE_ORDER: readonly PieceKind[] = ['foundation', 'wall', 'doorway', 'ceiling', 'bed'];
export const PIECE_LABEL: Readonly<Record<PieceKind, string>> = {
  foundation: 'Foundation', wall: 'Wall', doorway: 'Doorway', ceiling: 'Ceiling / floor', bed: 'Bed',
};

export interface TerrainQuery {
  heightAt(x: number, z: number): number;
  /** Trees, rocks, water and cliffs from the static nav grid. */
  staticBlocked(x: number, z: number): boolean;
  waterLevel: number;
}

interface Edge {
  axis: 'h' | 'v';
  i: number;
  j: number;
}

const isFloor = (k: PieceKind): boolean => k === 'foundation' || k === 'ceiling';
const isWall = (k: PieceKind): boolean => k === 'wall' || k === 'doorway';
/**
 * Heights are snapped to a 5 cm lattice (foundations are placed on it) and
 * keyed by lattice index. Keying by raw floats breaks: 2.35 + 3 − 3 is
 * 2.3499999999999996, which would round to a different key than 2.35.
 */
const LATTICE = 20;
const yKey = (y: number): number => Math.round(y * LATTICE);

export function edgeOf(i: number, j: number, side: Side): Edge {
  switch (side) {
    case 'n': return { axis: 'h', i, j };
    case 's': return { axis: 'h', i, j: j + 1 };
    case 'w': return { axis: 'v', i, j };
    case 'e': return { axis: 'v', i: i + 1, j };
  }
}

/** The two cells an edge separates, as [cell, side-of-that-cell]. */
function cellsOfEdge(e: Edge): Array<[number, number, Side]> {
  return e.axis === 'h'
    ? [[e.i, e.j, 'n'], [e.i, e.j - 1, 's']]
    : [[e.i, e.j, 'w'], [e.i - 1, e.j, 'e']];
}

/** World-space segment of an edge (XZ). */
export function edgeSegment(e: Edge): { x0: number; z0: number; x1: number; z1: number } {
  return e.axis === 'h'
    ? { x0: e.i * CELL, z0: e.j * CELL, x1: (e.i + 1) * CELL, z1: e.j * CELL }
    : { x0: e.i * CELL, z0: e.j * CELL, x1: e.i * CELL, z1: (e.j + 1) * CELL };
}

export class BuildingGrid {
  private readonly floors = new Map<string, Piece>();
  private readonly walls = new Map<string, Piece>();
  /** Furniture: at most one bed per floor cell. Its `side` is where the headboard goes. */
  private readonly beds = new Map<string, Piece>();
  private readonly byId = new Map<number, Piece>();

  constructor(private readonly terrain: TerrainQuery) {}

  // ---- storage -------------------------------------------------------------

  private floorKey(i: number, j: number, y: number): string {
    return `${i},${j},${yKey(y)}`;
  }
  private wallKey(e: Edge, y: number): string {
    return `${e.axis},${e.i},${e.j},${yKey(y)}`;
  }

  get(id: number): Piece | undefined {
    return this.byId.get(id);
  }

  pieces(): IterableIterator<Piece> {
    return this.byId.values();
  }

  get size(): number {
    return this.byId.size;
  }

  floorAt(i: number, j: number, y: number): Piece | undefined {
    return this.floors.get(this.floorKey(i, j, y));
  }

  wallAt(e: Edge, y: number): Piece | undefined {
    return this.walls.get(this.wallKey(e, y));
  }

  /** Inserts without validation (used by place-after-validate and save loading). */
  insert(p: Piece): Piece {
    if (p.kind === 'bed') this.beds.set(this.floorKey(p.i, p.j, p.y), p);
    else if (isFloor(p.kind)) this.floors.set(this.floorKey(p.i, p.j, p.y), p);
    else this.walls.set(this.wallKey(edgeOf(p.i, p.j, p.side!), p.y), p);
    this.byId.set(p.id, p);
    return p;
  }

  /**
   * Removes a piece and everything that no longer has support.
   * Returns all removed pieces (the requested one first).
   */
  remove(id: number): Piece[] {
    const p = this.byId.get(id);
    if (!p) return [];
    this.detach(p);
    const removed = [p];
    for (let changed = true; changed;) {
      changed = false;
      for (const q of this.byId.values()) {
        if (!this.isSupported(q)) {
          this.detach(q);
          removed.push(q);
          changed = true;
        }
      }
    }
    return removed;
  }

  private detach(p: Piece): void {
    if (p.kind === 'bed') this.beds.delete(this.floorKey(p.i, p.j, p.y));
    else if (isFloor(p.kind)) this.floors.delete(this.floorKey(p.i, p.j, p.y));
    else this.walls.delete(this.wallKey(edgeOf(p.i, p.j, p.side!), p.y));
    this.byId.delete(p.id);
  }

  // ---- rules ---------------------------------------------------------------

  isSupported(p: Candidate): boolean {
    switch (p.kind) {
      case 'foundation':
        return true;
      case 'bed':
        return this.floorAt(p.i, p.j, p.y) !== undefined;
      case 'wall':
      case 'doorway': {
        const e = edgeOf(p.i, p.j, p.side!);
        return cellsOfEdge(e).some(([ci, cj]) => this.floorAt(ci, cj, p.y) !== undefined);
      }
      case 'ceiling':
        return this.ceilingHasWall(p.i, p.j, p.y) ||
          NEIGHBOURS.some(([di, dj]) => {
            const n = this.floorAt(p.i + di, p.j + dj, p.y);
            return n?.kind === 'ceiling' && this.ceilingHasWall(n.i, n.j, n.y);
          });
    }
  }

  private ceilingHasWall(i: number, j: number, topY: number): boolean {
    const bottom = topY - WALL_HEIGHT;
    return SIDES.some((s) => this.wallAt(edgeOf(i, j, s), bottom) !== undefined);
  }

  /** Full validation: occupancy, support, terrain, player overlap. Returns null if OK, else a reason. */
  validate(c: Candidate, playerFeet: Vec3 | null): string | null {
    if (c.kind === 'bed') {
      if (!this.floorAt(c.i, c.j, c.y)) return 'A bed goes on a foundation or floor';
      if (this.beds.has(this.floorKey(c.i, c.j, c.y))) return 'There is already a bed here';
      return null;
    }
    if (isFloor(c.kind)) {
      // Any floor in this column within one storey overlaps.
      for (const p of this.floors.values()) {
        if (p.i === c.i && p.j === c.j && Math.abs(p.y - c.y) < WALL_HEIGHT - 0.01) return 'Something is already built here';
      }
    } else if (this.wallAt(edgeOf(c.i, c.j, c.side!), c.y)) {
      return 'There is already a wall here';
    }
    if (!this.isSupported(c)) {
      return c.kind === 'ceiling' ? 'Needs a wall underneath to rest on' : 'Needs a foundation or floor';
    }

    if (c.kind === 'foundation') {
      const { min, max, blocked, water } = this.footprint(c.i, c.j);
      if (water) return "Can't build on water";
      if (blocked) return 'A tree or rock is in the way';
      if (max > c.y - 0.05) return 'The ground is in the way';
      if (c.y - min > MAX_PILLAR) return 'Too high above the ground';
    }

    if (playerFeet && this.overlapsPlayer(c, playerFeet)) return "You're standing in the way";
    return null;
  }

  private footprint(i: number, j: number): { min: number; max: number; blocked: boolean; water: boolean } {
    let min = Infinity, max = -Infinity, blocked = false, water = false;
    for (let a = 0; a <= 4; a++) {
      for (let b = 0; b <= 4; b++) {
        const x = (i + a / 4) * CELL, z = (j + b / 4) * CELL;
        const h = this.terrain.heightAt(x, z);
        min = Math.min(min, h);
        max = Math.max(max, h);
        if (h < this.terrain.waterLevel) water = true;
        // Only the inner samples check obstacles: a trunk just outside the edge is fine.
        if (a > 0 && a < 4 && b > 0 && b < 4 && this.terrain.staticBlocked(x, z)) blocked = true;
      }
    }
    return { min, max, blocked, water };
  }

  /** Lowest ground under a foundation (its pillar goes down to here). */
  groundUnder(i: number, j: number): number {
    return this.footprint(i, j).min;
  }

  private overlapsPlayer(c: Candidate, feet: Vec3): boolean {
    const head = feet.y + 1.8;
    if (isFloor(c.kind)) {
      const inside = feet.x > c.i * CELL - 0.35 && feet.x < (c.i + 1) * CELL + 0.35 && feet.z > c.j * CELL - 0.35 && feet.z < (c.j + 1) * CELL + 0.35;
      // A slab overlaps if it would cut through the body (standing on top is fine).
      const slabBottom = c.kind === 'foundation' ? -Infinity : c.y - 0.2;
      return inside && feet.y < c.y - 0.05 && head > slabBottom;
    }
    const s = edgeSegment(edgeOf(c.i, c.j, c.side!));
    const d = distToSegment(feet.x, feet.z, s.x0, s.z0, s.x1, s.z1);
    return d < 0.5 && head > c.y && feet.y < c.y + WALL_HEIGHT;
  }

  // ---- placement resolution (aiming) -----------------------------------------

  /**
   * Turns "what the crosshair hits" into a snapped candidate for `kind`.
   * `hit.pieceId` is the building piece under the crosshair, if any.
   */
  resolve(
    kind: PieceKind,
    ray: { origin: Vec3; dir: Vec3; maxDistance: number },
    hit: { point: Vec3; pieceId: number | null } | null,
  ): Candidate | null {
    const hitPiece = hit?.pieceId != null ? this.byId.get(hit.pieceId) : undefined;
    const onTopOf = (p: Piece | undefined): p is Piece => !!p && isFloor(p.kind) && !!hit && Math.abs(hit.point.y - p.y) < 0.35;

    if (kind === 'foundation') {
      if (!hit) return null;
      if (onTopOf(hitPiece) && hitPiece.kind === 'foundation') {
        // Extend the platform: the neighbour across the edge nearest the crosshair.
        const side = nearestSide(hitPiece.i, hitPiece.j, hit.point);
        const [di, dj] = SIDE_DIR[side];
        return { kind, i: hitPiece.i + di, j: hitPiece.j + dj, y: hitPiece.y };
      }
      const i = Math.floor(hit.point.x / CELL), j = Math.floor(hit.point.z / CELL);
      // Next to an existing foundation? Match its height so floors line up.
      for (const [di, dj] of NEIGHBOURS) {
        for (const p of this.floors.values()) {
          if (p.kind === 'foundation' && p.i === i + di && p.j === j + dj) return { kind, i, j, y: p.y };
        }
      }
      return { kind, i, j, y: snapY(this.footprint(i, j).max + FOUNDATION_CLEARANCE) };
    }

    if (kind === 'bed') {
      if (!hit || !onTopOf(hitPiece)) return null;
      // Headboard against the edge nearest the crosshair (usually a wall).
      return { kind, i: hitPiece.i, j: hitPiece.j, y: hitPiece.y, side: nearestSide(hitPiece.i, hitPiece.j, hit.point) };
    }

    if (kind === 'wall' || kind === 'doorway') {
      if (!hit || !onTopOf(hitPiece)) return null;
      return { kind, i: hitPiece.i, j: hitPiece.j, y: hitPiece.y, side: nearestSide(hitPiece.i, hitPiece.j, hit.point) };
    }

    // Ceiling: intersect the view ray with every height a ceiling could sit at
    // (tops of nearby walls) and take the closest cell that is supported.
    const heights = new Set<number>();
    for (const w of this.walls.values()) {
      if (Math.hypot(w.i * CELL - ray.origin.x, w.j * CELL - ray.origin.z) < 18) heights.add(w.y + WALL_HEIGHT);
    }
    let best: { c: Candidate; t: number; ok: boolean } | null = null;
    for (const h of heights) {
      if (Math.abs(ray.dir.y) < 1e-4) continue;
      const t = (h - ray.origin.y) / ray.dir.y;
      if (t <= 0.3 || t > ray.maxDistance) continue;
      if (hit && t > hitDistance(ray.origin, hit.point) + 0.3) continue; // behind something solid
      const x = ray.origin.x + ray.dir.x * t, z = ray.origin.z + ray.dir.z * t;
      const c: Candidate = { kind, i: Math.floor(x / CELL), j: Math.floor(z / CELL), y: h };
      const ok = this.isSupported(c) && !this.floorAt(c.i, c.j, h);
      if (!best || (ok && !best.ok) || (ok === best.ok && t < best.t)) best = { c, t, ok };
    }
    return best?.c ?? null;
  }

  // ---- queries for other systems ------------------------------------------------

  /** Top of a ground-level foundation under (x, z), if any. AI walks on these. */
  foundationTopAt(x: number, z: number): number | null {
    const i = Math.floor(x / CELL), j = Math.floor(z / CELL);
    let top: number | null = null;
    for (const p of this.floors.values()) {
      if (p.kind === 'foundation' && p.i === i && p.j === j) top = Math.max(top ?? -Infinity, p.y);
    }
    return top;
  }

  /**
   * Shelter at the player's position. Flood-fills the room from the cell
   * under their feet across edges with no wall (or an open door). A room
   * that never leaks to a cell without floor is *enclosed*; insulation then
   * grows with how much of it is roofed. Roof over the player's own cell
   * keeps rain off.
   */
  shelterAt(feet: Vec3): { insulation: number; roof: boolean } {
    const i = Math.floor(feet.x / CELL), j = Math.floor(feet.z / CELL);
    let floor: Piece | undefined;
    for (const p of this.floors.values()) {
      if (p.i === i && p.j === j && feet.y >= p.y - 0.6 && feet.y <= p.y + 1.2 && (!floor || p.y > floor.y)) floor = p;
    }
    const roofOver = (ci: number, cj: number, y: number): boolean => !!this.floorAt(ci, cj, y + WALL_HEIGHT);
    if (!floor) return { insulation: 0, roof: false };

    const y = floor.y;
    const seen = new Set<string>([`${i},${j}`]);
    const stack: Array<[number, number]> = [[i, j]];
    let enclosed = true, roofed = 0;
    while (stack.length) {
      const [ci, cj] = stack.pop()!;
      if (roofOver(ci, cj, y)) roofed++;
      for (const s of SIDES) {
        const w = this.wallAt(edgeOf(ci, cj, s), y);
        if (w && !(w.kind === 'doorway' && w.open)) continue; // sealed edge
        const [di, dj] = SIDE_DIR[s];
        const ni = ci + di, nj = cj + dj, k = `${ni},${nj}`;
        if (seen.has(k)) continue;
        if (!this.floorAt(ni, nj, y) || seen.size >= 24) {
          enclosed = false;
          continue;
        }
        seen.add(k);
        stack.push([ni, nj]);
      }
    }
    const roofFrac = roofed / seen.size;
    return {
      insulation: enclosed ? 0.45 + 0.45 * roofFrac : 0.15 * roofFrac,
      roof: roofOver(i, j, y),
    };
  }

  /** World-space centre of a bed (it sits against its `side` edge) and its long axis. */
  static bedPlacement(p: Candidate): { x: number; z: number; alongX: boolean } {
    const [di, dj] = SIDE_DIR[p.side ?? 'n'];
    const inset = CELL / 2 - BED.length / 2 - 0.1;
    return { x: (p.i + 0.5) * CELL + di * inset, z: (p.j + 0.5) * CELL + dj * inset, alongX: di !== 0 };
  }

  /** Cost/refund helper. */
  static refund(kind: PieceKind): Array<{ item: ItemId; qty: number }> {
    return PIECE_COSTS[kind].map((c) => ({ item: c.item, qty: Math.ceil(c.qty / 2) }));
  }
}

const SIDES: readonly Side[] = ['n', 'e', 's', 'w'];
const NEIGHBOURS: ReadonlyArray<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const SIDE_DIR: Readonly<Record<Side, [number, number]>> = { n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] };

function nearestSide(i: number, j: number, p: Vec3): Side {
  const lx = p.x / CELL - i, lz = p.z / CELL - j; // 0..1 inside the cell
  const d = { w: lx, e: 1 - lx, n: lz, s: 1 - lz };
  return (Object.keys(d) as Side[]).reduce((a, b) => (d[b] < d[a] ? b : a));
}

function distToSegment(px: number, pz: number, x0: number, z0: number, x1: number, z1: number): number {
  const dx = x1 - x0, dz = z1 - z0;
  const t = Math.max(0, Math.min(1, ((px - x0) * dx + (pz - z0) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(px - (x0 + dx * t), pz - (z0 + dz * t));
}

function hitDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function snapY(v: number): number {
  return Math.ceil(v * LATTICE) / LATTICE;
}
