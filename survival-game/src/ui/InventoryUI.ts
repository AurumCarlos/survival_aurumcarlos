import type { Entity, World } from '../core/ecs/World';
import type { EventBus } from '../core/EventBus';
import { SurvivorC } from '../components';
import { itemDef } from '../data/items';
import { RECIPES_BY_ID } from '../data/recipes';
import type { ItemId } from '../data/schema';
import type { CraftingSystem } from '../systems/inventory/CraftingSystem';
import type { SurvivalStatusManager } from '../systems/SurvivalStatusManager';

const CELL = 52;

/**
 * Grid inventory + crafting panel (toggle with I).
 *
 * Click an item to use it (eat/drink, equip to hotbar, wear, place).
 * Drag to move; drop on a matching stack to merge. Right-click splits.
 * Rendering is a full re-draw on 'inventory:changed' — inventories are small
 * and this only happens on user action, never per frame.
 */
export class InventoryUI {
  readonly root: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly crafting: HTMLElement;
  private readonly hotbar: HTMLElement;
  private open = false;
  /** Items the player has held at least once — unlocks discoverable recipes. */
  private readonly discovered = new Set<ItemId>();
  private drag: { index: number; ghost: HTMLElement; ox: number; oy: number } | null = null;

  constructor(
    container: HTMLElement,
    private readonly world: World,
    private readonly player: () => Entity | undefined,
    private readonly crafter: CraftingSystem,
    private readonly survival: SurvivalStatusManager,
    private readonly events: EventBus,
    private readonly onPlace: (kind: 'campfire' | 'lean_to') => boolean,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'inventory';
    this.root.innerHTML = `<div class="inv-col"><h2>Inventory</h2><div class="grid"></div><p class="hint">Click: use · Drag: move · Right-click: split</p></div>
      <div class="inv-col"><h2>Crafting</h2><div class="recipes"></div></div>`;
    this.grid = this.root.querySelector('.grid')!;
    this.crafting = this.root.querySelector('.recipes')!;
    this.hotbar = document.createElement('div');
    this.hotbar.className = 'hotbar';
    container.append(this.root, this.hotbar);

    events.on('inventory:changed', () => this.render());
    events.on('crafting:completed', () => this.render());
    document.addEventListener('keydown', this.onHotkey);
    this.render();
  }

  get isOpen(): boolean {
    return this.open;
  }

  toggle(force?: boolean): void {
    this.open = force ?? !this.open;
    this.root.classList.toggle('show', this.open);
    if (this.open) this.render();
    this.events.emit('ui:inventory-toggled', { open: this.open });
  }

  render(): void {
    const p = this.player();
    if (p === undefined) return;
    const s = this.world.require(p, SurvivorC);
    const inv = this.crafter.inventoryOf(this.world, p);
    for (const pl of inv.placements) this.discovered.add(pl.stack.item);

    // Hotbar is always visible.
    this.hotbar.innerHTML = s.hotbar
      .map((h, i) => `<div class="slot${i === s.activeHotbarSlot ? ' active' : ''}" data-slot="${i}"><b>${i + 1}</b>${h ? itemDef(h.item).name : ''}${h?.durability !== undefined ? `<i style="width:${(h.durability / (itemDef(h.item).tool?.maxDurability ?? 1)) * 100}%"></i>` : ''}</div>`)
      .join('');
    this.hotbar.querySelectorAll<HTMLElement>('.slot').forEach((el) =>
      el.addEventListener('click', () => this.unequip(Number(el.dataset['slot']))));

    if (!this.open) return;

    this.grid.style.width = `${inv.cols * CELL}px`;
    this.grid.style.height = `${inv.rows * CELL}px`;
    this.grid.innerHTML = '';
    inv.placements.forEach((pl, index) => {
      const def = itemDef(pl.stack.item);
      const el = document.createElement('div');
      el.className = `item cat-${def.category}`;
      el.style.left = `${pl.x * CELL}px`;
      el.style.top = `${pl.y * CELL}px`;
      el.style.width = `${def.size.w * CELL - 4}px`;
      el.style.height = `${def.size.h * CELL - 4}px`;
      el.innerHTML = `<span>${def.name}</span>${pl.stack.qty > 1 ? `<em>${pl.stack.qty}</em>` : ''}`;
      el.addEventListener('pointerdown', (e) => this.startDrag(e, index, el));
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (inv.split(index)) this.render();
      });
      this.grid.appendChild(el);
    });

    const list = this.crafter.engine.list(inv, { nearbyStations: this.crafter.stationsNear(this.world, p) }, this.discovered);
    this.crafting.innerHTML = '';
    for (const { recipe, check, visible } of list) {
      if (!visible) continue;
      const b = document.createElement('button');
      b.className = `recipe${check.ok ? '' : ' disabled'}`;
      const needs = recipe.inputs.map((i) => `${i.qty}× ${itemDef(i.item).name} (${inv.count(i.item)})`).join(', ');
      b.innerHTML = `<strong>${recipe.name}</strong><small>${needs}${recipe.station !== 'hands' ? ' · needs campfire' : ''}</small>`;
      b.addEventListener('click', () => this.crafter.start(this.world, p, recipe.id));
      this.crafting.appendChild(b);
    }

    // Crafting queue: keeps running after the panel is closed; ✕ refunds.
    const queue = this.crafter.queueOf(p);
    if (queue.length) {
      const q = document.createElement('div');
      q.className = 'queue';
      q.innerHTML = `<h3>Crafting queue</h3>` + queue.map((j, i) => `
        <div class="qjob"><span>${i === 0 ? '▶ ' : ''}${RECIPES_BY_ID.get(j.recipeId)?.name ?? j.recipeId}${j.waiting ? ' <em>(needs campfire)</em>' : ''}</span>
        <button data-cancel="${i}" title="Cancel and refund">✕</button></div>`).join('');
      q.querySelectorAll<HTMLButtonElement>('[data-cancel]').forEach((btn) =>
        btn.addEventListener('click', () => this.crafter.cancel(this.world, p, Number(btn.dataset['cancel']))));
      this.crafting.appendChild(q);
    }
  }

  private useItem(index: number): void {
    const p = this.player();
    if (p === undefined) return;
    const s = this.world.require(p, SurvivorC);
    const inv = this.crafter.inventoryOf(this.world, p);
    const pl = inv.placements[index];
    if (!pl) return;
    const def = itemDef(pl.stack.item);

    if (def.consumable) {
      if (this.survival.consume(s, def.id)) inv.remove(def.id, 1);
    } else if (def.tool) {
      const slot = s.hotbar.findIndex((h) => h === null);
      if (slot < 0) return void this.events.emit('inventory:full', { entity: p, item: def.id, leftover: 1 });
      s.hotbar[slot] = inv.takeAt(index);
    } else if (def.wearable) {
      const prev = s.equipped.body;
      s.equipped.body = inv.takeAt(index);
      if (prev) inv.add(prev.item, prev.qty);
    } else if (def.places) {
      if (this.onPlace(def.places)) inv.remove(def.id, 1);
    }
    this.events.emit('inventory:changed', { entity: p });
  }

  private unequip(slot: number): void {
    const p = this.player();
    if (p === undefined) return;
    const s = this.world.require(p, SurvivorC);
    if (!this.open) {
      s.activeHotbarSlot = slot;
      return this.render();
    }
    const h = s.hotbar[slot];
    if (!h) return;
    if (this.crafter.inventoryOf(this.world, p).add(h.item, h.qty, h.durability) === 0) s.hotbar[slot] = null;
    this.render();
  }

  private readonly onHotkey = (e: KeyboardEvent): void => {
    const m = /^Digit([1-6])$/.exec(e.code);
    const p = this.player();
    if (!m || p === undefined) return;
    this.world.require(p, SurvivorC).activeHotbarSlot = Number(m[1]) - 1;
    this.render();
  };

  // ---- drag & drop --------------------------------------------------------

  private startDrag(e: PointerEvent, index: number, el: HTMLElement): void {
    if (e.button !== 0) return;
    const rect = el.getBoundingClientRect();
    const ghost = el.cloneNode(true) as HTMLElement;
    ghost.classList.add('ghost');
    document.body.appendChild(ghost);
    this.drag = { index, ghost, ox: e.clientX - rect.left, oy: e.clientY - rect.top };
    const startX = e.clientX, startY = e.clientY;
    const move = (ev: PointerEvent): void => {
      ghost.style.left = `${ev.clientX - this.drag!.ox}px`;
      ghost.style.top = `${ev.clientY - this.drag!.oy}px`;
    };
    const up = (ev: PointerEvent): void => {
      document.removeEventListener('pointermove', move);
      ghost.remove();
      const d = this.drag!;
      this.drag = null;
      // Barely moved → treat as a click.
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return this.useItem(d.index);
      const g = this.grid.getBoundingClientRect();
      const x = Math.floor((ev.clientX - d.ox + CELL / 2 - g.left) / CELL);
      const y = Math.floor((ev.clientY - d.oy + CELL / 2 - g.top) / CELL);
      const p = this.player();
      if (p !== undefined && this.crafter.inventoryOf(this.world, p).move(d.index, x, y)) this.render();
    };
    move(e);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up, { once: true });
  }

  dispose(): void {
    document.removeEventListener('keydown', this.onHotkey);
    this.root.remove();
    this.hotbar.remove();
  }
}
