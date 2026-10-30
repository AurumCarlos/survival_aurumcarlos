import type { NavGrid } from './NavGrid';

/** 8-neighbourhood, index 0..7; 8 = "at goal / no move". */
const DC = [1, 1, 0, -1, -1, -1, 0, 1] as const;
const DR = [0, 1, 1, 1, 0, -1, -1, -1] as const;
const STEP = [10, 14, 10, 14, 10, 14, 10, 14] as const;
const INV_SQRT2 = Math.SQRT1_2;
/** Unit direction per neighbour index, precomputed. */
const UX = DC.map((c, i) => (i % 2 ? c * INV_SQRT2 : c));
const UZ = DR.map((r, i) => (i % 2 ? r * INV_SQRT2 : r));
export const NO_DIR = 8;
const UNREACHABLE = 0x7fffffff;

/**
 * A flow field toward one goal over a square window of the nav grid.
 *
 *   1. Integration field: Dijkstra from the goal outward (step 10 straight,
 *      14 diagonal, + per-cell slope cost). Diagonals that would cut a
 *      blocked corner are forbidden, so creatures can't squeeze between two
 *      touching trunks.
 *   2. Direction field: each cell points at its cheapest neighbour.
 *
 * Any number of agents anywhere in the window can then read their next
 * heading in O(1) — which is why flow fields beat per-agent A* when a pack of
 * wolves chases the same player.
 */
export class FlowField {
  readonly c0: number;
  readonly r0: number;
  readonly w: number;
  readonly h: number;
  readonly dist: Int32Array;
  readonly dir: Uint8Array;
  readonly goalCol: number;
  readonly goalRow: number;
  /** False when the goal (and every cell near it) is blocked. */
  readonly valid: boolean;

  constructor(private readonly grid: NavGrid, goalCol: number, goalRow: number, radiusCells: number, heap: MinHeap) {
    const g = grid.d;
    this.c0 = Math.max(0, goalCol - radiusCells);
    this.r0 = Math.max(0, goalRow - radiusCells);
    this.w = Math.min(g.cols, goalCol + radiusCells + 1) - this.c0;
    this.h = Math.min(g.rows, goalRow + radiusCells + 1) - this.r0;
    this.dist = new Int32Array(this.w * this.h).fill(UNREACHABLE);
    this.dir = new Uint8Array(this.w * this.h).fill(NO_DIR);

    // A goal inside an obstacle (player hugging a tree) is snapped to the nearest free cell.
    const snapped = grid.nearestWalkable(goalCol, goalRow, 4);
    this.valid = snapped >= 0;
    this.goalCol = snapped >= 0 ? snapped % g.cols : goalCol;
    this.goalRow = snapped >= 0 ? Math.floor(snapped / g.cols) : goalRow;
    if (!this.valid || !this.inWindow(this.goalCol, this.goalRow)) return;

    this.integrate(heap);
    this.buildDirections();
  }

  private inWindow(c: number, r: number): boolean {
    return c >= this.c0 && r >= this.r0 && c < this.c0 + this.w && r < this.r0 + this.h;
  }

  private integrate(heap: MinHeap): void {
    const g = this.grid.d;
    heap.clear();
    const start = (this.goalRow - this.r0) * this.w + (this.goalCol - this.c0);
    this.dist[start] = 0;
    heap.push(start, 0);
    while (heap.size > 0) {
      const li = heap.pop();
      const d = this.dist[li]!;
      if (d !== heap.lastKey) continue; // stale heap entry
      const lc = li % this.w, lr = (li - lc) / this.w;
      const c = lc + this.c0, r = lr + this.r0;
      for (let k = 0; k < 8; k++) {
        const nc = c + DC[k]!, nr = r + DR[k]!;
        if (!this.inWindow(nc, nr) || this.grid.cellBlocked(nc, nr)) continue;
        if (k % 2 === 1 && (this.grid.cellBlocked(c + DC[k]!, r) || this.grid.cellBlocked(c, r + DR[k]!))) continue;
        const ni = (nr - this.r0) * this.w + (nc - this.c0);
        const nd = d + STEP[k]! + g.cost[nr * g.cols + nc]!;
        if (nd < this.dist[ni]!) {
          this.dist[ni] = nd;
          heap.push(ni, nd);
        }
      }
    }
  }

  private buildDirections(): void {
    for (let lr = 0; lr < this.h; lr++) {
      for (let lc = 0; lc < this.w; lc++) {
        const li = lr * this.w + lc;
        const d = this.dist[li]!;
        if (d === UNREACHABLE || d === 0) continue;
        const c = lc + this.c0, r = lr + this.r0;
        let best = d, bestK = NO_DIR;
        for (let k = 0; k < 8; k++) {
          const nc = c + DC[k]!, nr = r + DR[k]!;
          if (!this.inWindow(nc, nr)) continue;
          if (k % 2 === 1 && (this.grid.cellBlocked(c + DC[k]!, r) || this.grid.cellBlocked(c, r + DR[k]!))) continue;
          const nd = this.dist[(nr - this.r0) * this.w + (nc - this.c0)]!;
          if (nd < best) {
            best = nd;
            bestK = k;
          }
        }
        this.dir[li] = bestK;
      }
    }
  }

  /** True if this field can guide an agent standing at cell (c, r). */
  covers(c: number, r: number): boolean {
    return this.inWindow(c, r) && this.dist[(r - this.r0) * this.w + (c - this.c0)]! !== UNREACHABLE;
  }

  /**
   * Writes a unit steering vector for an agent at world (x, z). Returns false
   * if the agent is outside the window or cannot reach the goal from there.
   */
  sample(x: number, z: number, out: { x: number; z: number }): boolean {
    const c = this.grid.col(x), r = this.grid.row(z);
    if (!this.covers(c, r)) {
      // Standing in a blocked cell (pushed into a trunk's halo): step to the best neighbour.
      return this.escape(c, r, out);
    }
    const k = this.dir[(r - this.r0) * this.w + (c - this.c0)]!;
    if (k === NO_DIR) {
      // In the goal cell: head for the exact goal cell centre.
      const dx = this.grid.centerX(this.goalCol) - x, dz = this.grid.centerZ(this.goalRow) - z;
      const len = Math.hypot(dx, dz) || 1;
      out.x = dx / len;
      out.z = dz / len;
      return true;
    }
    // Aim at the next cell's centre (not just the raw direction) so agents
    // re-centre in corridors instead of grinding along obstacle edges.
    const tx = this.grid.centerX(c + DC[k]!) - x, tz = this.grid.centerZ(r + DR[k]!) - z;
    const len = Math.hypot(tx, tz);
    if (len < 1e-4) {
      out.x = UX[k]!;
      out.z = UZ[k]!;
    } else {
      out.x = tx / len;
      out.z = tz / len;
    }
    return true;
  }

  private escape(c: number, r: number, out: { x: number; z: number }): boolean {
    let best = UNREACHABLE, bestK = -1;
    for (let k = 0; k < 8; k++) {
      const nc = c + DC[k]!, nr = r + DR[k]!;
      if (!this.covers(nc, nr)) continue;
      const nd = this.dist[(nr - this.r0) * this.w + (nc - this.c0)]!;
      if (nd < best) {
        best = nd;
        bestK = k;
      }
    }
    if (bestK < 0) return false;
    out.x = UX[bestK]!;
    out.z = UZ[bestK]!;
    return true;
  }
}

/** Binary min-heap of (index, key) with reusable storage. */
export class MinHeap {
  private idx: Int32Array;
  private key: Int32Array;
  size = 0;
  /** Key of the most recently popped element. */
  lastKey = 0;

  constructor(capacity = 4096) {
    this.idx = new Int32Array(capacity);
    this.key = new Int32Array(capacity);
  }

  clear(): void {
    this.size = 0;
  }

  push(i: number, k: number): void {
    if (this.size === this.idx.length) this.grow();
    let n = this.size++;
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (this.key[p]! <= k) break;
      this.idx[n] = this.idx[p]!;
      this.key[n] = this.key[p]!;
      n = p;
    }
    this.idx[n] = i;
    this.key[n] = k;
  }

  pop(): number {
    const top = this.idx[0]!;
    this.lastKey = this.key[0]!;
    const li = this.idx[--this.size]!, lk = this.key[this.size]!;
    let n = 0;
    for (;;) {
      let c = 2 * n + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.key[c + 1]! < this.key[c]!) c++;
      if (this.key[c]! >= lk) break;
      this.idx[n] = this.idx[c]!;
      this.key[n] = this.key[c]!;
      n = c;
    }
    this.idx[n] = li;
    this.key[n] = lk;
    return top;
  }

  private grow(): void {
    const ni = new Int32Array(this.idx.length * 2), nk = new Int32Array(this.key.length * 2);
    ni.set(this.idx);
    nk.set(this.key);
    this.idx = ni;
    this.key = nk;
  }
}
