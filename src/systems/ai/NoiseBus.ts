import { ObjectPool } from '../../core/ObjectPool';
import type { Entity } from '../../core/ecs/World';

export interface NoiseEvent {
  x: number;
  y: number;
  z: number;
  /** Audible radius in metres before hearing multipliers. */
  radius: number;
  source: Entity;
}

/**
 * Per-tick noise events (footsteps, axe chops, impacts). Dozens can be
 * created per second, so they come from a pool and are all returned at the
 * end of each perception pass — zero steady-state allocation.
 */
export class NoiseBus {
  private readonly pool = new ObjectPool<NoiseEvent>({
    create: () => ({ x: 0, y: 0, z: 0, radius: 0, source: 0 }),
    reset: (n) => {
      n.radius = 0;
      n.source = 0;
    },
    prewarm: 32,
    max: 256,
    onExhausted: 'recycle-oldest',
  });
  private readonly active: NoiseEvent[] = [];

  emit(x: number, y: number, z: number, radius: number, source: Entity): void {
    if (radius <= 0) return;
    const n = this.pool.acquire();
    if (!n) return;
    n.x = x;
    n.y = y;
    n.z = z;
    n.radius = radius;
    n.source = source;
    this.active.push(n);
  }

  get events(): readonly NoiseEvent[] {
    return this.active;
  }

  clear(): void {
    for (const n of this.active) this.pool.release(n);
    this.active.length = 0;
  }
}
