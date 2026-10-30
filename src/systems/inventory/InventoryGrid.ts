import { itemDef } from '../../data/items';
import type { InventoryGridData, ItemId, ItemStack } from '../../data/schema';

export interface Placement {
  x: number;
  y: number;
  stack: ItemStack;
}

/**
 * Grid inventory with multi-cell items (an axe is 1×2, a spear 1×3).
 *
 * The serialisable state is just the placement list (InventoryGridData);
 * occupancy is a derived Int16Array cache rebuilt after each mutation, so
 * the save format can never disagree with itself.
 */
export class InventoryGrid {
  private occupancy: Int16Array;

  constructor(readonly data: InventoryGridData) {
    this.occupancy = new Int16Array(data.cols * data.rows);
    this.rebuild();
  }

  get cols(): number {
    return this.data.cols;
  }
  get rows(): number {
    return this.data.rows;
  }
  get placements(): readonly Placement[] {
    return this.data.placements;
  }

  count(item: ItemId): number {
    let n = 0;
    for (const p of this.data.placements) if (p.stack.item === item) n += p.stack.qty;
    return n;
  }

  /** Index into placements at cell (x, y), or −1. */
  at(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return -1;
    return this.occupancy[y * this.cols + x]!;
  }

  /**
   * Adds items, topping up existing stacks first, then placing new stacks in
   * the first free spot (row-major scan). Returns what did NOT fit.
   */
  add(item: ItemId, qty: number, durability?: number): number {
    if (qty <= 0) return 0;
    const def = itemDef(item);
    let remaining = qty;

    if (def.maxStack > 1) {
      for (const p of this.data.placements) {
        if (p.stack.item !== item || p.stack.qty >= def.maxStack) continue;
        const take = Math.min(def.maxStack - p.stack.qty, remaining);
        p.stack.qty += take;
        remaining -= take;
        if (remaining === 0) return 0;
      }
    }

    while (remaining > 0) {
      const spot = this.findFreeSpot(def.size.w, def.size.h);
      if (!spot) break;
      const qtyHere = Math.min(def.maxStack, remaining);
      const stack: ItemStack = { item, qty: qtyHere };
      if (def.tool) stack.durability = durability ?? def.tool.maxDurability;
      this.data.placements.push({ x: spot.x, y: spot.y, stack });
      this.rebuild();
      remaining -= qtyHere;
    }
    return remaining;
  }

  /** Removes up to qty, draining the smallest stacks first. Returns amount removed. */
  remove(item: ItemId, qty: number): number {
    let remaining = qty;
    const candidates = this.data.placements
      .filter((p) => p.stack.item === item)
      .sort((a, b) => a.stack.qty - b.stack.qty);
    for (const p of candidates) {
      const take = Math.min(p.stack.qty, remaining);
      p.stack.qty -= take;
      remaining -= take;
      if (remaining === 0) break;
    }
    this.data.placements = this.data.placements.filter((p) => p.stack.qty > 0);
    this.rebuild();
    return qty - remaining;
  }

  /** Can an item of this footprint be put at (x, y), optionally ignoring one placement (when moving it)? */
  fits(w: number, h: number, x: number, y: number, ignoreIndex = -1): boolean {
    if (x < 0 || y < 0 || x + w > this.cols || y + h > this.rows) return false;
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        const o = this.occupancy[yy * this.cols + xx]!;
        if (o !== -1 && o !== ignoreIndex) return false;
      }
    }
    return true;
  }

  /** Drag-and-drop: move a placement. Merges into a same-item stack under the cursor. */
  move(index: number, x: number, y: number): boolean {
    const p = this.data.placements[index];
    if (!p) return false;
    const def = itemDef(p.stack.item);
    const target = this.at(x, y);
    if (target !== -1 && target !== index) {
      const t = this.data.placements[target]!;
      if (t.stack.item === p.stack.item && def.maxStack > 1) {
        const take = Math.min(def.maxStack - t.stack.qty, p.stack.qty);
        t.stack.qty += take;
        p.stack.qty -= take;
        if (p.stack.qty === 0) this.data.placements.splice(index, 1);
        this.rebuild();
        return take > 0;
      }
    }
    if (!this.fits(def.size.w, def.size.h, x, y, index)) return false;
    p.x = x;
    p.y = y;
    this.rebuild();
    return true;
  }

  /** Split half a stack into a new free spot. */
  split(index: number): boolean {
    const p = this.data.placements[index];
    if (!p || p.stack.qty < 2) return false;
    const def = itemDef(p.stack.item);
    const spot = this.findFreeSpot(def.size.w, def.size.h);
    if (!spot) return false;
    const half = Math.floor(p.stack.qty / 2);
    p.stack.qty -= half;
    this.data.placements.push({ x: spot.x, y: spot.y, stack: { item: p.stack.item, qty: half } });
    this.rebuild();
    return true;
  }

  /** Remove a whole placement (dropping it on the ground). */
  takeAt(index: number): ItemStack | null {
    const p = this.data.placements[index];
    if (!p) return null;
    this.data.placements.splice(index, 1);
    this.rebuild();
    return p.stack;
  }

  /** Deep copy for transactional operations (crafting dry-runs). */
  clone(): InventoryGrid {
    return new InventoryGrid({
      cols: this.cols,
      rows: this.rows,
      placements: this.data.placements.map((p) => ({ x: p.x, y: p.y, stack: { ...p.stack } })),
    });
  }

  /** Replace contents with another grid's (commit a successful dry-run). */
  assign(from: InventoryGrid): void {
    this.data.placements = from.data.placements.map((p) => ({ x: p.x, y: p.y, stack: { ...p.stack } }));
    this.rebuild();
  }

  private findFreeSpot(w: number, h: number): { x: number; y: number } | null {
    for (let y = 0; y <= this.rows - h; y++) {
      for (let x = 0; x <= this.cols - w; x++) {
        if (this.fits(w, h, x, y)) return { x, y };
      }
    }
    return null;
  }

  private rebuild(): void {
    if (this.occupancy.length !== this.cols * this.rows) this.occupancy = new Int16Array(this.cols * this.rows);
    this.occupancy.fill(-1);
    this.data.placements.forEach((p, i) => {
      const { w, h } = itemDef(p.stack.item).size;
      for (let yy = p.y; yy < p.y + h; yy++) {
        for (let xx = p.x; xx < p.x + w; xx++) {
          if (xx < this.cols && yy < this.rows) this.occupancy[yy * this.cols + xx] = i;
        }
      }
    });
  }
}
