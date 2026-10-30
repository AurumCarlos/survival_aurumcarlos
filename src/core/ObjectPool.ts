/**
 * Generic object pool. Hot-path objects (projectiles, noise events, particles,
 * temporary vectors) are recycled instead of allocated so the GC never has a
 * large young generation to sweep mid-fight, which is what causes the
 * periodic 5–20 ms hitches that break a 60 FPS budget.
 */
export interface PoolOptions<T> {
  create: () => T;
  /** Return the object to a pristine state. Must not allocate. */
  reset: (obj: T) => void;
  /** Objects created up front (e.g. during the loading screen). */
  prewarm?: number;
  /**
   * Hard ceiling. When exhausted, acquire() either recycles the oldest live
   * object (good for cosmetic things like leaves) or returns null (projectiles,
   * where silently stealing one would look like a bug).
   */
  max?: number;
  onExhausted?: 'recycle-oldest' | 'return-null' | 'grow';
}

export class ObjectPool<T extends object> {
  private readonly free: T[] = [];
  /** Insertion-ordered so "oldest" is the first key. */
  private readonly live = new Set<T>();
  private readonly opts: Required<Omit<PoolOptions<T>, 'prewarm'>> & { prewarm: number };
  private created = 0;

  constructor(options: PoolOptions<T>) {
    this.opts = {
      prewarm: options.prewarm ?? 0,
      max: options.max ?? Number.POSITIVE_INFINITY,
      onExhausted: options.onExhausted ?? 'grow',
      create: options.create,
      reset: options.reset,
    };
    for (let i = 0; i < this.opts.prewarm; i++) {
      this.free.push(this.opts.create());
      this.created++;
    }
  }

  acquire(): T | null {
    let obj = this.free.pop();
    if (!obj) {
      if (this.created < this.opts.max || this.opts.onExhausted === 'grow') {
        obj = this.opts.create();
        this.created++;
      } else if (this.opts.onExhausted === 'recycle-oldest') {
        const oldest = this.live.values().next().value as T | undefined;
        if (!oldest) return null;
        this.live.delete(oldest);
        this.opts.reset(oldest);
        obj = oldest;
      } else {
        return null;
      }
    }
    this.live.add(obj);
    return obj;
  }

  release(obj: T): void {
    // Guard against double-release, which would hand one object to two owners.
    if (!this.live.delete(obj)) return;
    this.opts.reset(obj);
    this.free.push(obj);
  }

  /** Iterate live objects without allocating an array. */
  forEachLive(fn: (obj: T) => void): void {
    for (const o of this.live) fn(o);
  }

  releaseAll(): void {
    for (const o of this.live) {
      this.opts.reset(o);
      this.free.push(o);
    }
    this.live.clear();
  }

  get liveCount(): number {
    return this.live.size;
  }
  get freeCount(): number {
    return this.free.length;
  }
  get totalCreated(): number {
    return this.created;
  }
}
