import type { Entity, World } from '../core/ecs/World';
import type { EventBus } from '../core/EventBus';
import { HeatSource, Structure, SurvivorC } from '../components';
import { itemDef } from '../data/items';
import { RECIPES, RECIPES_BY_ID, STATION_LABEL, type CraftingStation, type Recipe, type RecipeTab } from '../data/recipes';
import { STRUCTURES, processingCatalogue } from '../data/stations';
import type { ItemId, ItemStack, PlaceableKind } from '../data/schema';
import { MAX_CRAFT_QUEUE, type CraftingSystem } from '../systems/inventory/CraftingSystem';
import { InventoryGrid } from '../systems/inventory/InventoryGrid';
import type { StationSystem } from '../systems/StationSystem';
import type { SurvivalStatusManager } from '../systems/SurvivalStatusManager';

const CELL = 46;

type Tab = 'all' | RecipeTab | 'process';
const TABS: ReadonlyArray<[Tab, string]> = [
  ['all', 'All'], ['tools', 'Tools'], ['weapons', 'Weapons'], ['armor', 'Armor'], ['structures', 'Structures'],
  ['refining', 'Refining'], ['food', 'Food & Medicine'], ['process', 'Cook & Smelt'],
];

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Inventory (I) with the crafting menu, or — after E on a storage box or
 * station — the structure's own inventory next to yours.
 *
 * Crafting menu: category tabs, search, a recipe list that shows at a glance
 * what you can make and where, and a detail card (ingredients have/need,
 * station, time) with Craft ×1 / ×5. The "Cook & Smelt" tab lists what fires,
 * forges, pots and bins turn things into.
 *
 * Grid: click uses an item (eat, equip, wear, place); drag moves it;
 * right-click splits a stack. With a box open, click moves the stack across.
 */
export class InventoryUI {
  readonly root: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly worn: HTMLElement;
  private readonly right: HTMLElement;
  private readonly craftPanel: HTMLElement;
  private readonly containerPanel: HTMLElement;
  private readonly tabsEl: HTMLElement;
  private readonly stationsEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly detailEl: HTMLElement;
  private readonly queueEl: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly hotbar: HTMLElement;
  private open = false;
  private tab: Tab = 'all';
  private selected: string | null = null;
  /** Structure whose inventory is shown instead of the crafting menu. */
  private container: Entity | null = null;
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
    private readonly onPlace: (kind: PlaceableKind) => string | null,
    private readonly stations: StationSystem,
    private readonly onPickUp: (e: Entity) => string | null,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'inventory';
    this.root.innerHTML = `
      <div class="inv-col inv-left"><h2>Inventory</h2><div class="grid"></div><div class="worn"></div>
        <p class="hint">Click: use / equip / place · Drag: move · Right-click: split</p></div>
      <div class="inv-col inv-right">
        <div class="craft">
          <div class="craft-head"><h2>Crafting</h2><input class="craft-search" type="search" placeholder="Search…" spellcheck="false"></div>
          <div class="craft-tabs"></div>
          <div class="craft-stations"></div>
          <div class="craft-body"><div class="craft-list"></div><div class="craft-detail"></div></div>
          <div class="queue"></div>
        </div>
        <div class="box"></div>
      </div>`;
    this.grid = this.root.querySelector('.grid')!;
    this.worn = this.root.querySelector('.worn')!;
    this.right = this.root.querySelector('.inv-right')!;
    this.craftPanel = this.root.querySelector('.craft')!;
    this.containerPanel = this.root.querySelector('.box')!;
    this.tabsEl = this.root.querySelector('.craft-tabs')!;
    this.stationsEl = this.root.querySelector('.craft-stations')!;
    this.listEl = this.root.querySelector('.craft-list')!;
    this.detailEl = this.root.querySelector('.craft-detail')!;
    this.queueEl = this.root.querySelector('.queue')!;
    this.search = this.root.querySelector('.craft-search')!;
    this.search.addEventListener('input', () => this.renderCrafting());
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.search.blur();
    });
    this.tabsEl.innerHTML = TABS.map(([t, label]) => `<button data-tab="${t}">${label}</button>`).join('');
    this.tabsEl.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => {
      this.tab = b.dataset['tab'] as Tab;
      this.renderCrafting();
    }));
    this.hotbar = document.createElement('div');
    this.hotbar.className = 'hotbar';
    container.append(this.root, this.hotbar);

    events.on('inventory:changed', () => this.render());
    events.on('crafting:completed', () => this.render());
    events.on('structure:changed', ({ entity }) => {
      if (entity === this.container) this.render();
    });
    events.on('structure:removed', ({ entity }) => {
      if (entity === this.container) this.toggle(false);
    });
    document.addEventListener('keydown', this.onHotkey);
    this.render();
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Open the inventory with a structure's contents (storage box, campfire, forge…). */
  openContainer(e: Entity): void {
    this.container = e;
    this.toggle(true);
  }

  toggle(force?: boolean): void {
    this.open = force ?? !this.open;
    if (!this.open) {
      this.container = null;
      this.search.blur();
    }
    this.root.classList.toggle('show', this.open);
    if (this.open) this.render();
    this.events.emit('ui:inventory-toggled', { open: this.open });
  }

  /** Per-frame: keeps a station's progress bar moving while its panel is open. */
  frame(): void {
    if (!this.open || this.container === null) return;
    const bar = this.containerPanel.querySelector<HTMLElement>('.proc i');
    const st = this.world.get(this.container, Structure);
    if (!bar || !st) return;
    const r = STRUCTURES[st.kind].processes.find((p) => p.id === st.processing.recipeId);
    bar.style.width = `${r ? Math.min(100, (st.processing.progress / r.time) * 100) : 0}%`;
    const fuel = this.containerPanel.querySelector<HTMLElement>('.fuel-left');
    const h = this.world.get(this.container, HeatSource);
    if (fuel && h) fuel.textContent = h.lit ? `${Math.ceil(h.fuelSeconds)} s` : 'out';
  }

  render(): void {
    const p = this.player();
    if (p === undefined) return;
    const s = this.world.require(p, SurvivorC);
    const inv = this.crafter.inventoryOf(this.world, p);
    for (const pl of inv.placements) this.discovered.add(pl.stack.item);
    for (const h of s.hotbar) if (h) this.discovered.add(h.item);

    // Hotbar is always visible.
    this.hotbar.innerHTML = s.hotbar
      .map((h, i) => `<div class="slot${i === s.activeHotbarSlot ? ' active' : ''}" data-slot="${i}"><b>${i + 1}</b>${h ? esc(itemDef(h.item).name) : ''}${h?.durability !== undefined ? `<i style="width:${(h.durability / (itemDef(h.item).tool?.maxDurability ?? 1)) * 100}%"></i>` : ''}${h && h.qty > 1 ? `<em>${h.qty}</em>` : ''}</div>`)
      .join('');
    this.hotbar.querySelectorAll<HTMLElement>('.slot').forEach((el) =>
      el.addEventListener('click', () => this.unequip(Number(el.dataset['slot']))));

    if (!this.open) return;

    if (this.container !== null && !this.world.get(this.container, Structure)) this.container = null;
    const boxOpen = this.container !== null;
    this.renderGrid(this.grid, inv, (index) => (boxOpen ? this.transfer(index, true) : this.useItem(index)), true);

    const w = s.equipped.body;
    this.worn.innerHTML = `<span>Wearing:</span> ${w ? `<button class="unwear" title="Take off">${esc(itemDef(w.item).name)} ✕</button>` : '<em>nothing</em>'}`;
    this.worn.querySelector('.unwear')?.addEventListener('click', () => {
      if (s.equipped.body && inv.add(s.equipped.body.item, 1) === 0) s.equipped.body = null;
      this.events.emit('inventory:changed', { entity: p });
    });

    this.craftPanel.style.display = boxOpen ? 'none' : '';
    this.containerPanel.style.display = boxOpen ? '' : 'none';
    this.right.classList.toggle('boxed', boxOpen);
    if (boxOpen) this.renderContainer();
    else this.renderCrafting();
  }

  // ---- grids ---------------------------------------------------------------------

  private renderGrid(el: HTMLElement, inv: InventoryGrid, onClick: (index: number) => void, draggable: boolean): void {
    el.style.width = `${inv.cols * CELL}px`;
    el.style.height = `${inv.rows * CELL}px`;
    el.style.backgroundSize = `${CELL}px ${CELL}px`;
    el.innerHTML = '';
    inv.placements.forEach((pl, index) => {
      const def = itemDef(pl.stack.item);
      const it = document.createElement('div');
      it.className = `item cat-${def.category}`;
      it.style.left = `${pl.x * CELL}px`;
      it.style.top = `${pl.y * CELL}px`;
      it.style.width = `${def.size.w * CELL - 4}px`;
      it.style.height = `${def.size.h * CELL - 4}px`;
      it.title = `${def.name}${def.description ? ` — ${def.description}` : ''}`;
      const dur = pl.stack.durability !== undefined && def.tool ? `<i style="width:${(pl.stack.durability / def.tool.maxDurability) * 100}%"></i>` : '';
      it.innerHTML = `<span>${esc(def.name)}</span>${pl.stack.qty > 1 ? `<em>${pl.stack.qty}</em>` : ''}${dur}`;
      if (draggable) it.addEventListener('pointerdown', (e) => this.startDrag(e, index, it, onClick));
      else it.addEventListener('click', () => onClick(index));
      it.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (inv.split(index)) this.render();
      });
      el.appendChild(it);
    });
  }

  /** Move a whole stack between the player and the open box. */
  private transfer(index: number, toBox: boolean): void {
    const p = this.player();
    if (p === undefined || this.container === null) return;
    const mine = this.crafter.inventoryOf(this.world, p);
    const box = this.stations.containerOf(this.world, this.container);
    if (!box) return;
    const [from, to] = toBox ? [mine, box] : [box, mine];
    const stack = from.takeAt(index);
    if (!stack) return;
    const left = to.add(stack.item, stack.qty, stack.durability);
    if (left > 0) from.add(stack.item, left, stack.durability);
    if (left === stack.qty) this.events.emit('inventory:full', { entity: p, item: stack.item, leftover: left });
    this.events.emit('inventory:changed', { entity: p });
    this.events.emit('structure:changed', { entity: this.container });
  }

  // ---- storage / station panel --------------------------------------------------------

  private renderContainer(): void {
    const e = this.container!;
    const st = this.world.require(e, Structure);
    const def = STRUCTURES[st.kind];
    const box = this.stations.containerOf(this.world, e);
    const h = this.world.get(e, HeatSource);
    const p = this.containerPanel;
    const fuelNames = def.fuel ? Object.keys(def.fuel).map((k) => itemDef(k as ItemId).name).join(', ') : '';
    const current = def.processes.find((r) => r.id === st.processing.recipeId);
    const empty = !box || box.placements.length === 0;
    p.innerHTML = `
      <h2>${esc(def.label)}</h2>
      ${def.fuel ? `<div class="fire"><button class="light">${h?.lit ? 'Put out' : def.kit === 'fabricator_kit' ? 'Power on' : 'Light'}</button>
        <span>${h?.lit ? '🔥 burning — <b class="fuel-left"></b>' : 'Cold'} · fuel: ${esc(fuelNames)}</span></div>` : ''}
      ${def.processes.length ? `<div class="proc"><span>${current ? `${def.fuel && !h?.lit ? 'Paused' : 'Making'}: ${esc(current.name)}` : 'Nothing to process'}</span><b><i></i></b></div>` : ''}
      ${box ? `<div class="grid box-grid"></div>
      <p class="hint">Click an item to move it between your inventory and the ${esc(def.label.toLowerCase())}.${def.processes.length ? ' Put ingredients and fuel inside, then light it — it works by itself.' : ''}</p>`
        : `<p class="hint">${def.craftStation ? `Crafting station: its recipes unlock in the crafting menu (I) while you stand next to it.` : 'Keeps the rain off and holds some warmth in.'}</p>`}
      ${def.processes.length ? `<details class="makes"><summary>What it makes</summary>${def.processes.map((r) =>
        `<div>${r.inputs.map((i) => `${i.qty} ${esc(itemDef(i.item).name)}`).join(' + ')} → <b>${r.output.qty > 1 ? `${r.output.qty} ` : ''}${esc(itemDef(r.output.item).name)}</b> <small>${r.time}s</small></div>`).join('')}</details>` : ''}
      <div class="box-actions"><button class="pickup" ${empty ? '' : 'disabled title="Empty it first"'}>Pick up</button></div>`;
    if (box) this.renderGrid(p.querySelector('.box-grid')!, box, (i) => this.transfer(i, false), false);
    p.querySelector('.light')?.addEventListener('click', () => {
      if (!this.stations.setLit(this.world, e, !h?.lit)) this.toast(`Put ${fuelNames.toLowerCase()} inside to light it`);
      this.render();
    });
    p.querySelector('.pickup')?.addEventListener('click', () => {
      const err = this.onPickUp(e);
      if (err) this.toast(err);
    });
    this.frame();
  }

  // ---- crafting menu ------------------------------------------------------------------

  private renderCrafting(): void {
    const p = this.player();
    if (p === undefined || !this.open) return;
    const inv = this.crafter.inventoryOf(this.world, p);
    const near = this.crafter.stationsNear(this.world, p);
    this.tabsEl.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('on', b.dataset['tab'] === this.tab));
    this.stationsEl.innerHTML = (['hands', 'campfire', 'mortar_pestle', 'smithy', 'fabricator'] as CraftingStation[])
      .map((st) => `<span class="${near.has(st) ? 'near' : ''}" title="${near.has(st) ? 'In range' : 'Stand next to one (lit) to use its recipes'}">${STATION_LABEL[st]}</span>`).join('');

    const q = this.search.value.trim().toLowerCase();
    if (this.tab === 'process') return this.renderProcessing(q);

    const list = this.crafter.engine.list(inv, { nearbyStations: near }, this.discovered)
      .filter(({ recipe, visible }) => visible && (this.tab === 'all' || recipe.tab === this.tab))
      .filter(({ recipe }) => !q || recipe.name.toLowerCase().includes(q) || recipe.inputs.some((i) => itemDef(i.item).name.toLowerCase().includes(q)));
    // Craftable first, then what's only missing a station, then the rest.
    const rank = (x: (typeof list)[number]): number => (x.check.ok ? 0 : x.check.reason === 'missing-station' && hasAll(inv, x.recipe) ? 1 : 2);
    list.sort((a, b) => rank(a) - rank(b));
    if (!this.selected || !list.some((x) => x.recipe.id === this.selected)) this.selected = list[0]?.recipe.id ?? null;

    this.listEl.innerHTML = list.length ? '' : '<p class="hint">No recipe matches.</p>';
    for (const { recipe, check } of list) {
      const b = document.createElement('button');
      const state = check.ok ? 'ok' : check.reason === 'missing-station' ? 'station' : 'missing';
      b.className = `recipe ${state}${recipe.id === this.selected ? ' sel' : ''}`;
      b.innerHTML = `<strong>${esc(recipe.name)}</strong><small>${recipe.station === 'hands' ? '' : `<u>${STATION_LABEL[recipe.station]}</u>`}${check.ok ? '<b>✓</b>' : ''}</small>`;
      b.addEventListener('click', () => {
        this.selected = recipe.id;
        this.renderCrafting();
      });
      b.addEventListener('dblclick', () => this.craft(recipe, 1));
      this.listEl.appendChild(b);
    }
    this.renderDetail(inv, near);
    this.renderQueue();
  }

  private renderDetail(inv: InventoryGrid, near: ReadonlySet<CraftingStation>): void {
    const recipe = this.selected ? RECIPES_BY_ID.get(this.selected) : undefined;
    const p = this.player();
    if (!recipe || p === undefined) {
      this.detailEl.innerHTML = '';
      return;
    }
    const out = itemDef(recipe.output.item);
    const check = this.crafter.engine.check(inv, recipe.id, { nearbyStations: near });
    const stats: string[] = [];
    if (out.tool && out.tool.damage) stats.push(`Damage ${out.tool.damage}`);
    if (out.tool) stats.push(`Durability ${out.tool.maxDurability}`);
    if (out.wearable) stats.push(`Warmth +${out.wearable.insulation}°C`, `Armor ${Math.round((out.wearable.armor ?? 0) * 100)}%`);
    if (out.consumable?.hunger) stats.push(`Food ${out.consumable.hunger > 0 ? '+' : ''}${out.consumable.hunger}`);
    if (out.consumable?.health) stats.push(`Health +${out.consumable.health}`);
    const stationOk = recipe.station === 'hands' || near.has(recipe.station);
    const queueFull = this.crafter.queueOf(p).length >= MAX_CRAFT_QUEUE;
    this.detailEl.innerHTML = `
      <h3>${esc(recipe.name)}</h3>
      <p class="desc">${esc(out.description ?? '')}</p>
      ${stats.length ? `<p class="stats">${stats.map(esc).join(' · ')}</p>` : ''}
      <ul class="needs">${recipe.inputs.map((i) => {
        const have = inv.count(i.item);
        return `<li class="${have >= i.qty ? 'have' : 'lack'}"><span>${esc(itemDef(i.item).name)}</span><b>${have}/${i.qty}</b></li>`;
      }).join('')}</ul>
      <p class="where ${stationOk ? 'have' : 'lack'}">${recipe.station === 'hands' ? 'Crafted from your inventory' : `Needs: ${STATION_LABEL[recipe.station]}${recipe.station === 'fabricator' ? ' (powered with gasoline)' : recipe.station === 'campfire' ? ' (lit)' : ''} within 3.5 m`} · ${recipe.craftTime}s</p>
      <div class="craft-btns"><button class="c1" ${check.ok && !queueFull ? '' : 'disabled'}>Craft</button><button class="c5" ${check.ok && !queueFull ? '' : 'disabled'}>×5</button></div>`;
    this.detailEl.querySelector('.c1')?.addEventListener('click', () => this.craft(recipe, 1));
    this.detailEl.querySelector('.c5')?.addEventListener('click', () => this.craft(recipe, 5));
  }

  private craft(recipe: Recipe, times: number): void {
    const p = this.player();
    if (p === undefined) return;
    for (let i = 0; i < times; i++) if (!this.crafter.start(this.world, p, recipe.id)) break;
    this.render();
  }

  private renderQueue(): void {
    const p = this.player();
    if (p === undefined) return;
    const queue = this.crafter.queueOf(p);
    if (!queue.length) {
      this.queueEl.innerHTML = '';
      return;
    }
    this.queueEl.innerHTML = `<h3>Crafting queue</h3>` + queue.map((j, i) => `
      <div class="qjob"><span>${i === 0 ? '▶ ' : ''}${esc(RECIPES_BY_ID.get(j.recipeId)?.name ?? j.recipeId)}${j.waiting ? ` <em>(needs ${STATION_LABEL[RECIPES_BY_ID.get(j.recipeId)!.station]})</em>` : ''}</span>
      <button data-cancel="${i}" title="Cancel and refund">✕</button></div>`).join('');
    this.queueEl.querySelectorAll<HTMLButtonElement>('[data-cancel]').forEach((btn) =>
      btn.addEventListener('click', () => this.crafter.cancel(this.world, p, Number(btn.dataset['cancel']))));
  }

  /** Reference tab: what fires, forges, pots and bins make by themselves. */
  private renderProcessing(q: string): void {
    const rows = processingCatalogue()
      .filter(({ recipe }) => !q || recipe.name.toLowerCase().includes(q) || recipe.inputs.some((i) => itemDef(i.item).name.toLowerCase().includes(q)));
    this.listEl.innerHTML = '';
    this.detailEl.innerHTML = `<h3>Cook &amp; Smelt</h3><p class="desc">Put ingredients and fuel inside a station (E), then light it.
      It works by itself while you do other things. Wood burnt in a fire or forge leaves Charcoal.</p>`;
    const table = document.createElement('div');
    table.className = 'proc-list';
    table.innerHTML = rows.map(({ recipe, stations }) => `
      <div class="proc-row"><b>${esc(recipe.name)}</b>
        <span>${recipe.inputs.map((i) => `${i.qty} ${esc(itemDef(i.item).name)}`).join(' + ')}</span>
        <small>${stations.map((s) => STRUCTURES[s].label).join(' / ')} · ${recipe.time}s</small></div>`).join('');
    this.listEl.appendChild(table);
    this.queueEl.innerHTML = '';
  }

  // ---- using items ---------------------------------------------------------------------

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
    } else if (def.tool || def.category === 'tool' || def.category === 'ammo') {
      const slot = s.hotbar.findIndex((h) => h === null);
      if (slot < 0) return void this.events.emit('inventory:full', { entity: p, item: def.id, leftover: 1 });
      s.hotbar[slot] = inv.takeAt(index);
    } else if (def.wearable) {
      const prev = s.equipped.body;
      s.equipped.body = inv.takeAt(index);
      if (prev) inv.add(prev.item, prev.qty);
    } else if (def.places) {
      const err = this.onPlace(def.places);
      if (err) this.toast(err);
      else inv.remove(def.id, 1);
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
    const h: ItemStack | null | undefined = s.hotbar[slot];
    if (!h) return;
    if (this.crafter.inventoryOf(this.world, p).add(h.item, h.qty, h.durability) === 0) s.hotbar[slot] = null;
    this.render();
  }

  private toast(text: string): void {
    this.events.emit('ui:toast', { text, warn: true });
  }

  private readonly onHotkey = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLInputElement) return;
    const m = /^Digit([1-6])$/.exec(e.code);
    const p = this.player();
    if (!m || p === undefined) return;
    this.world.require(p, SurvivorC).activeHotbarSlot = Number(m[1]) - 1;
    this.render();
  };

  // ---- drag & drop --------------------------------------------------------

  private startDrag(e: PointerEvent, index: number, el: HTMLElement, onClick: (index: number) => void): void {
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
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return onClick(d.index);
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

function hasAll(inv: InventoryGrid, r: Recipe | null): boolean {
  return !!r && r.inputs.every((i) => inv.count(i.item) >= i.qty);
}

/** Recipes the player could make right now with what they carry (tests/diagnostics). */
export function craftableNow(inv: InventoryGrid): string[] {
  return RECIPES.filter((r) => r.station === 'hands' && hasAll(inv, r)).map((r) => r.id);
}
