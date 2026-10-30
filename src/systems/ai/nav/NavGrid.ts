import { treeTrunkRadius } from '../../../world/TreeSpecies';
import type { PropPlacement, TerrainData } from '../../../world/TerrainGenerator';
import { sampleHeight, sampleSlope } from '../../../world/TerrainGenerator';

/**
 * Walkability grid for ground creatures, derived from terrain + obstacles.
 *
 * Plain typed arrays only, so it can be built inside the terrain Web Worker
 * and transferred to the main thread without copying.
 */
export interface NavGridData {
  /** World coordinates of the corner of cell (0, 0). */
  originX: number;
  originZ: number;
  cellSize: number;
  cols: number;
  rows: number;
  /** 1 = blocked by terrain (water, cliff, map border). */
  blocked: Uint8Array;
  /**
   * How many trunks/boulders cover each cell (agent-inflated). Separate from
   * `blocked` so a felled tree or mined rock can be removed again at runtime.
   * Optional for hand-built test grids.
   */
  obstacles?: Uint8Array;
  /** Extra traversal cost per cell (0..255), from slope. Added to the base step cost. */
  cost: Uint8Array;
}

/** Creature footprint radius. Obstacles are inflated by this so paths keep clearance. */
export const NAV_AGENT_RADIUS = 0.45;
const MAX_WALKABLE_SLOPE = 0.45;

/** Base trunk radius of a full-size (scale 1, 16 m) fir. Shared with the mesh and collider. */
export const FIR_TRUNK_RADIUS = 0.32;
export const FIR_HEIGHT = 16;

/** Collider sizes MUST match PhysicsWorld.addStaticProps so AI and physics agree on what's solid. */
export function obstacleRadius(p: PropPlacement): number {
  if (p.kind === 'tree') return treeTrunkRadius(p.variant) * p.scale;
  if (p.kind === 'rock' && p.scale > 1) return 0.6 * p.scale;
  if (SOLID_NODES.has(p.kind)) return 0.55 * p.scale;
  return 0;
}

/** Ore and tar rocks are always solid (plain rocks only when big). */
export const SOLID_NODES: ReadonlySet<string> = new Set(['metal_rock', 'obsidian_rock', 'crystal', 'oil_rock']);

export function buildNavGrid(t: TerrainData, cellSize = 1): NavGridData {
  const { size, waterLevel } = t.cfg;
  const cols = Math.ceil(size / cellSize);
  const rows = cols;
  const originX = -size / 2;
  const originZ = -size / 2;
  const blocked = new Uint8Array(cols * rows);
  const cost = new Uint8Array(cols * rows);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (r === 0 || c === 0 || r === rows - 1 || c === cols - 1) {
        blocked[i] = 1;
        continue;
      }
      const x = originX + (c + 0.5) * cellSize;
      const z = originZ + (r + 0.5) * cellSize;
      const slope = sampleSlope(t, x, z);
      if (sampleHeight(t, x, z) < waterLevel + 0.1 || slope > MAX_WALKABLE_SLOPE) blocked[i] = 1;
      else cost[i] = Math.min(255, Math.round(slope * 60));
    }
  }

  const data: NavGridData = { originX, originZ, cellSize, cols, rows, blocked, cost, obstacles: new Uint8Array(cols * rows) };
  for (const p of t.props) stampObstacle(data, p, 1);
  return data;
}

/** Adds (+1) or removes (−1) one trunk/boulder footprint, inflated by the agent radius. */
export function stampObstacle(d: NavGridData, p: PropPlacement, delta: 1 | -1): void {
  const r = obstacleRadius(p);
  if (r === 0 || !d.obstacles) return;
  const { originX, originZ, cellSize, cols, rows } = d;
  const reach = r + NAV_AGENT_RADIUS;
  const c0 = Math.floor((p.position.x - reach - originX) / cellSize);
  const c1 = Math.floor((p.position.x + reach - originX) / cellSize);
  const r0 = Math.floor((p.position.z - reach - originZ) / cellSize);
  const r1 = Math.floor((p.position.z + reach - originZ) / cellSize);
  for (let rr = Math.max(0, r0); rr <= Math.min(rows - 1, r1); rr++) {
    for (let cc = Math.max(0, c0); cc <= Math.min(cols - 1, c1); cc++) {
      // Closest point of the cell to the obstacle centre (circle–square overlap).
      const cx = clamp(p.position.x, originX + cc * cellSize, originX + (cc + 1) * cellSize);
      const cz = clamp(p.position.z, originZ + rr * cellSize, originZ + (rr + 1) * cellSize);
      if (Math.hypot(cx - p.position.x, cz - p.position.z) >= reach) continue;
      const i = rr * cols + cc;
      d.obstacles[i] = Math.max(0, Math.min(255, d.obstacles[i]! + delta));
    }
  }
}

/** Read-only query wrapper used by the flow-field service and AI. */
export class NavGrid {
  /**
   * Runtime obstacles (player-built walls, closed doors, tall foundations)
   * as per-cell reference counts on top of the static mask, so overlapping
   * pieces can be added and removed in any order.
   */
  private readonly dynamic: Uint16Array;
  /** Bumped on every dynamic change; path caches compare it to know they're stale. */
  version = 0;

  private readonly obstacles: Uint8Array;

  constructor(readonly d: NavGridData) {
    this.dynamic = new Uint16Array(d.cols * d.rows);
    this.obstacles = d.obstacles ?? (d.obstacles = new Uint8Array(d.cols * d.rows));
  }

  /** A tree was felled (−1) or grew back (+1). */
  setObstacle(p: PropPlacement, delta: 1 | -1): void {
    stampObstacle(this.d, p, delta);
    this.version++;
  }

  /** Adds (+1) or removes (−1) a blocking rectangle in world XZ. Inflated by the agent radius. */
  blockRect(minX: number, minZ: number, maxX: number, maxZ: number, delta: 1 | -1): void {
    const r = NAV_AGENT_RADIUS;
    const c0 = Math.max(0, this.col(minX - r)), c1 = Math.min(this.d.cols - 1, this.col(maxX + r));
    const r0 = Math.max(0, this.row(minZ - r)), r1 = Math.min(this.d.rows - 1, this.row(maxZ + r));
    for (let rr = r0; rr <= r1; rr++) {
      for (let cc = c0; cc <= c1; cc++) {
        const i = rr * this.d.cols + cc;
        this.dynamic[i] = Math.max(0, this.dynamic[i]! + delta);
      }
    }
    this.version++;
  }

  /** Static obstacles only (trees, rocks, water): what building placement checks against. */
  staticBlocked(x: number, z: number): boolean {
    const i = this.cellAt(x, z);
    return i < 0 || this.d.blocked[i] === 1 || this.obstacles[i]! > 0;
  }

  col(x: number): number {
    return Math.floor((x - this.d.originX) / this.d.cellSize);
  }
  row(z: number): number {
    return Math.floor((z - this.d.originZ) / this.d.cellSize);
  }
  /** Cell index for a world position, or −1 outside the grid. */
  cellAt(x: number, z: number): number {
    const c = this.col(x), r = this.row(z);
    if (c < 0 || r < 0 || c >= this.d.cols || r >= this.d.rows) return -1;
    return r * this.d.cols + c;
  }
  isWalkable(x: number, z: number): boolean {
    const i = this.cellAt(x, z);
    return i >= 0 && this.d.blocked[i] === 0 && this.obstacles[i] === 0 && this.dynamic[i] === 0;
  }
  cellBlocked(c: number, r: number): boolean {
    if (c < 0 || r < 0 || c >= this.d.cols || r >= this.d.rows) return true;
    const i = r * this.d.cols + c;
    return this.d.blocked[i] === 1 || this.obstacles[i]! > 0 || this.dynamic[i]! > 0;
  }
  centerX(c: number): number {
    return this.d.originX + (c + 0.5) * this.d.cellSize;
  }
  centerZ(r: number): number {
    return this.d.originZ + (r + 0.5) * this.d.cellSize;
  }

  /**
   * True if a straight walk from a to b crosses no blocked cell.
   *
   * Exact grid traversal (Amanatides & Woo DDA) rather than point sampling:
   * sampling can step over the corner of a blocked cell from one position but
   * not from a nearby one, and that inconsistency makes an agent flip between
   * "go straight" and "follow the field" every tick — visible as jitter.
   * When the line passes exactly through a cell corner, both side cells must
   * be free (no squeezing diagonally between two trunks).
   */
  segmentClear(ax: number, az: number, bx: number, bz: number): boolean {
    const cs = this.d.cellSize;
    let c = this.col(ax), r = this.row(az);
    const ec = this.col(bx), er = this.row(bz);
    if (this.cellBlocked(c, r) || this.cellBlocked(ec, er)) return false;
    const dx = bx - ax, dz = bz - az;
    const stepC = dx > 0 ? 1 : -1, stepR = dz > 0 ? 1 : -1;
    const ox = this.d.originX, oz = this.d.originZ;
    const tDeltaX = dx !== 0 ? Math.abs(cs / dx) : Infinity;
    const tDeltaZ = dz !== 0 ? Math.abs(cs / dz) : Infinity;
    let tMaxX = dx !== 0 ? (ox + (c + (stepC > 0 ? 1 : 0)) * cs - ax) / dx : Infinity;
    let tMaxZ = dz !== 0 ? (oz + (r + (stepR > 0 ? 1 : 0)) * cs - az) / dz : Infinity;
    let guard = Math.abs(ec - c) + Math.abs(er - r) + 2;
    while ((c !== ec || r !== er) && guard-- > 0) {
      if (Math.abs(tMaxX - tMaxZ) < 1e-9) {
        // Exactly through a corner: require both orthogonal neighbours free.
        if (this.cellBlocked(c + stepC, r) || this.cellBlocked(c, r + stepR)) return false;
        c += stepC;
        r += stepR;
        tMaxX += tDeltaX;
        tMaxZ += tDeltaZ;
      } else if (tMaxX < tMaxZ) {
        c += stepC;
        tMaxX += tDeltaX;
      } else {
        r += stepR;
        tMaxZ += tDeltaZ;
      }
      if (this.cellBlocked(c, r)) return false;
    }
    return true;
  }

  /** Nearest walkable cell to (c, r) within maxRadius rings, or −1. */
  nearestWalkable(c: number, r: number, maxRadius = 4): number {
    if (!this.cellBlocked(c, r)) return r * this.d.cols + c;
    for (let rad = 1; rad <= maxRadius; rad++) {
      for (let dr = -rad; dr <= rad; dr++) {
        for (let dc = -rad; dc <= rad; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
          if (!this.cellBlocked(c + dc, r + dr)) return (r + dr) * this.d.cols + (c + dc);
        }
      }
    }
    return -1;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
