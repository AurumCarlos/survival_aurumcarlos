import { FlowField, MinHeap } from './FlowField';
import type { NavGrid } from './NavGrid';

/**
 * The only navigation API the AI sees. Implementations can be swapped
 * (flow fields, navmesh, "straight line" for tests) without touching AISystem.
 */
export interface PathProvider {
  /**
   * Writes a unit XZ steering direction from (fromX, fromZ) toward the goal.
   * Returns false if no route is known this tick (unreachable, or the
   * per-tick build budget is spent) — the caller should hold position.
   */
  steer(fromX: number, fromZ: number, goalX: number, goalZ: number, out: { x: number; z: number }): boolean;
  /** Ground-level walkability, used to reject moves into obstacles. */
  isWalkable(x: number, z: number): boolean;
  /** Called once per fixed step before any agent queries. */
  beginTick(): void;
}

export interface FlowFieldOptions {
  /** Window radii, in cells. A field is built with the smallest one covering the agent. */
  radii?: readonly number[];
  /** Fields kept in the LRU cache. */
  cacheSize?: number;
  /** Max fields computed per fixed step; spreads the cost of a sudden pack chase across ticks. */
  maxBuildsPerTick?: number;
  /** Fields older than this many ticks are rebuilt (cheap insurance against stale data). */
  maxAgeTicks?: number;
}

interface Entry {
  field: FlowField;
  builtAt: number;
}

/**
 * Builds and caches flow fields keyed by goal cell + window size.
 *
 * Six wolves chasing one player all hit the same cache entry; when the player
 * crosses into a new cell a single new field is built and shared again.
 * Patrol waypoints never move, so their fields are built once and reused.
 */
export class FlowFieldService implements PathProvider {
  private readonly cache = new Map<number, Entry>();
  private readonly heap = new MinHeap(8192);
  private readonly radii: readonly number[];
  private readonly cacheSize: number;
  private readonly maxBuilds: number;
  private readonly maxAge: number;
  private tick = 0;
  private buildsThisTick = 0;
  readonly stats = { builds: 0, hits: 0, direct: 0, denied: 0 };

  constructor(readonly grid: NavGrid, opts: FlowFieldOptions = {}) {
    this.radii = opts.radii ?? [32, 64, 112];
    this.cacheSize = opts.cacheSize ?? 64;
    this.maxBuilds = opts.maxBuildsPerTick ?? 3;
    this.maxAge = opts.maxAgeTicks ?? 600;
  }

  private gridVersion = 0;

  beginTick(): void {
    this.tick++;
    this.buildsThisTick = 0;
    // Walls were built or removed: every cached field may route through them.
    if (this.grid.version !== this.gridVersion) {
      this.gridVersion = this.grid.version;
      this.cache.clear();
    }
  }

  isWalkable(x: number, z: number): boolean {
    return this.grid.isWalkable(x, z);
  }

  steer(fromX: number, fromZ: number, goalX: number, goalZ: number, out: { x: number; z: number }): boolean {
    const dx = goalX - fromX, dz = goalZ - fromZ;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) {
      out.x = out.z = 0;
      return true;
    }
    // Fast path: open ground straight to the goal → no field needed, and the
    // motion is a perfect straight line instead of 8-direction stair-steps.
    if (d < 40 && this.grid.segmentClear(fromX, fromZ, goalX, goalZ)) {
      out.x = dx / d;
      out.z = dz / d;
      this.stats.direct++;
      return true;
    }

    const gc = this.grid.col(goalX), gr = this.grid.row(goalZ);
    const ac = this.grid.col(fromX), ar = this.grid.row(fromZ);
    const need = Math.max(Math.abs(ac - gc), Math.abs(ar - gr)) + 2;
    const goalKey = (gr * this.grid.d.cols + gc) * 4;

    // Reuse any cached field for this goal that already covers the agent —
    // e.g. the big window built when the chase started keeps serving as the
    // wolf closes in, instead of building a smaller one.
    let key = -1;
    let entry: Entry | undefined;
    for (let i = 0; i < this.radii.length; i++) {
      const e = this.cache.get(goalKey + i);
      if (e && this.tick - e.builtAt <= this.maxAge && e.field.covers(ac, ar)) {
        key = goalKey + i;
        entry = e;
        break;
      }
    }
    if (!entry) {
      const radius = this.radii.find((r) => r >= need) ?? this.radii[this.radii.length - 1]!;
      key = goalKey + this.radii.indexOf(radius);
      const stale = this.cache.get(key);
      if (stale && this.tick - stale.builtAt <= this.maxAge && stale.field.covers(gc, gr)) {
        // Already built this tick-window and it doesn't cover us: agent is cut off from the goal.
        return stale.field.valid && stale.field.sample(fromX, fromZ, out);
      }
      if (this.buildsThisTick >= this.maxBuilds) {
        this.stats.denied++;
        return false;
      }
      this.buildsThisTick++;
      this.stats.builds++;
      entry = { field: new FlowField(this.grid, gc, gr, radius, this.heap), builtAt: this.tick };
      this.cache.set(key, entry);
      if (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value!);
    } else {
      // Refresh LRU position.
      this.cache.delete(key);
      this.cache.set(key, entry);
      this.stats.hits++;
    }
    return entry.field.valid && entry.field.sample(fromX, fromZ, out);
  }

  get cachedFields(): number {
    return this.cache.size;
  }
}

/** Trivial provider for tests / open maps: straight line, everything walkable. */
export const straightLinePaths: PathProvider = {
  beginTick: () => undefined,
  isWalkable: () => true,
  steer(fx, fz, gx, gz, out) {
    const d = Math.hypot(gx - fx, gz - fz) || 1;
    out.x = (gx - fx) / d;
    out.z = (gz - fz) / d;
    return true;
  },
};
