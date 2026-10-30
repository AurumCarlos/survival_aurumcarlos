/**
 * Uniform-grid spatial hash on the XZ plane for static or rarely-moving
 * things (trees, rocks, structures). Turns "what's within 3 m of me?" from
 * O(all resources) into O(things in ~4 cells).
 */
export class SpatialHash {
  private readonly cells = new Map<number, number[]>();
  private readonly where = new Map<number, number>();

  constructor(private readonly cellSize = 8) {}

  private key(cx: number, cz: number): number {
    // Pack two 16-bit signed cell coords into one number key.
    return ((cx + 32768) << 16) | ((cz + 32768) & 0xffff);
  }

  insert(id: number, x: number, z: number): void {
    this.remove(id);
    const k = this.key(Math.floor(x / this.cellSize), Math.floor(z / this.cellSize));
    let c = this.cells.get(k);
    if (!c) {
      c = [];
      this.cells.set(k, c);
    }
    c.push(id);
    this.where.set(id, k);
  }

  remove(id: number): void {
    const k = this.where.get(id);
    if (k === undefined) return;
    const c = this.cells.get(k);
    if (c) {
      const i = c.indexOf(id);
      if (i >= 0) c.splice(i, 1);
    }
    this.where.delete(id);
  }

  /** Calls fn for every id in cells overlapping the circle. Caller does the exact distance test. */
  forEachNear(x: number, z: number, radius: number, fn: (id: number) => void): void {
    const s = this.cellSize;
    const x0 = Math.floor((x - radius) / s), x1 = Math.floor((x + radius) / s);
    const z0 = Math.floor((z - radius) / s), z1 = Math.floor((z + radius) / s);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const c = this.cells.get(this.key(cx, cz));
        if (c) for (const id of c) fn(id);
      }
    }
  }
}
