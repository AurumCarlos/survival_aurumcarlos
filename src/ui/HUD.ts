import { RESOURCE_LABEL } from '../data/items';
import type { Entity, World } from '../core/ecs/World';
import type { EventBus } from '../core/EventBus';
import type { GameLoop } from '../core/GameLoop';
import { BuilderC } from '../systems/building/BuildingSystem';
import { PIECE_COSTS, PIECE_LABEL, PIECE_ORDER } from '../systems/building/BuildingGrid';
import { InventoryGrid } from '../systems/inventory/InventoryGrid';
import { BEST_TOOL_NAME, toolEffect } from '../systems/InteractionSystem';
import { Exposure, ResourceC, StealthState, Transform, SurvivorC } from '../components';
import type { StatusEffectId } from '../data/schema';
import type { DayNightCycle } from '../systems/DayNightCycle';
import type { SurvivalStatusManager } from '../systems/SurvivalStatusManager';

const EFFECT_LABEL: Record<StatusEffectId, string> = {
  starving: 'Starving', dehydrated: 'Dehydrated', exhausted: 'Exhausted', cold: 'Cold', hypothermia: 'Hypothermia',
  hot: 'Hot', hyperthermia: 'Heatstroke', warmed_by_fire: 'Warmed', sheltered: 'Sheltered', well_fed: 'Well fed',
  food_poisoning: 'Food poisoning', bleeding: 'Bleeding',
};
const GOOD_EFFECTS: ReadonlySet<StatusEffectId> = new Set(['warmed_by_fire', 'sheltered', 'well_fed']);

/**
 * DOM overlay. Text is refreshed at 10 Hz rather than every frame: writing to
 * the DOM forces style recalculation, and doing it 60×/s for a dozen labels
 * costs more than the whole ECS update.
 */
export class HUD {
  private readonly root: HTMLElement;
  private readonly el: Record<string, HTMLElement> = {};
  private acc = 0;
  private readonly unsubscribe: Array<() => void> = [];

  constructor(
    container: HTMLElement,
    private readonly events: EventBus,
    private readonly cycle: DayNightCycle,
    private readonly survival: SurvivalStatusManager,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="vignette cold" data-k="cold"></div>
      <div class="vignette heat" data-k="heat"></div>
      <div class="vignette hurt" data-k="hurt"></div>
      <div class="crosshair"></div>
      <div class="clock" data-k="clock"></div>
      <div class="fps" data-k="fps"></div>
      <div class="stealth" data-k="stealth" title="Detection"><span data-k="stealthFill"></span></div>
      <div class="vitals">
        ${['health', 'hunger', 'thirst', 'energy', 'stamina'].map((k) => `
          <div class="bar ${k}"><label>${k}</label><div class="track"><div class="fill" data-k="${k}"></div></div></div>`).join('')}
        <div class="temp" data-k="temp"></div>
      </div>
      <div class="effects" data-k="effects"></div>
      <div class="prompt" data-k="prompt"></div>
      <div class="build" data-k="build"></div>
      <div class="progress" data-k="progressWrap"><div data-k="progress"></div></div>
      <div class="toasts" data-k="toasts"></div>
      <div class="sleep-fade" data-k="sleepFade"></div>`;
    container.appendChild(this.root);
    this.root.querySelectorAll<HTMLElement>('[data-k]').forEach((n) => (this.el[n.dataset['k']!] = n));

    setTimeout(() => this.toast('Tip: press B to build a shelter — walls and a roof keep out the cold and the wolves'), 2500);
    this.unsubscribe.push(
      events.on('crafting:completed', ({ recipeId }) => this.toast(`Crafted ${recipeId.replace(/_/g, ' ')}`)),
      events.on('crafting:failed', ({ reason }) => this.toast(`Can't craft: ${reason.replace(/-/g, ' ')}`, true)),
      events.on('ui:toast', ({ text, warn }) => this.toast(text, warn)),
      events.on('creature:hit', ({ killed }) => {
        this.hitMarker(killed);
        if (killed) this.toast('Killed! Hold E on the body for meat and hide');
      }),
      events.on('harvest:blocked', ({ tool }) => this.toast(`You need ${/^[aeiou]/.test(tool) ? 'an' : 'a'} ${tool} for this`, true)),
      events.on('sleep:refused', ({ reason }) => this.toast(reason, true)),
      events.on('player:slept', ({ hours }) => {
        this.fadeToBlack();
        this.toast(`You slept ${Math.round(hours)} h — good morning!`);
      }),
      events.on('inventory:full', () => this.toast('Inventory full', true)),
      events.on('ai:detected-player', () => this.flash('hurt', 0.25)),
    );
  }

  update(world: World, player: Entity | undefined, dt: number, loop: GameLoop, prompt: string | null, progress: number | null): void {
    this.acc += dt;
    if (this.acc < 0.1) return;
    this.acc = 0;

    const h = this.cycle.hour;
    this.el['clock']!.textContent = `Day ${this.cycle.day} · ${pad(Math.floor(h))}:${pad(Math.floor((h % 1) * 60))} · ${this.cycle.ambientTempC.toFixed(0)}°C${this.cycle.raining ? ' · rain' : ''}`;
    this.el['fps']!.textContent = `${loop.stats.fps.toFixed(0)} fps`;

    if (player === undefined) return;
    const s = world.require(player, SurvivorC);
    const v = s.vitals;
    for (const k of ['health', 'hunger', 'thirst', 'energy', 'stamina'] as const) {
      this.el[k]!.style.width = `${(v[k] / s.maxVitals[k]) * 100}%`;
    }
    const exp = world.get(player, Exposure);
    const felt = exp ? this.survival.feltTemperature(s, exp) : v.bodyTemp;
    this.el['temp']!.textContent = `Body ${v.bodyTemp.toFixed(1)}°C · feels ${felt.toFixed(0)}°C`;
    // GPS (carried anywhere): coordinates under the clock.
    const hasGps = s.hotbar.some((x) => x?.item === 'gps') || s.inventory.placements.some((x) => x.stack.item === 'gps');
    const tp = world.get(player, Transform)?.position;
    if (hasGps && tp) this.el['clock']!.textContent += ` · GPS ${tp.x.toFixed(0)}, ${tp.z.toFixed(0)}`;
    this.el['temp']!.classList.toggle('danger', v.bodyTemp < 35.5 || v.bodyTemp > 38.8);

    this.el['effects']!.innerHTML = s.effects
      .map((e) => `<span class="${GOOD_EFFECTS.has(e.id) ? 'good' : 'bad'}">${EFFECT_LABEL[e.id]}${Number.isFinite(e.remaining) ? ` ${Math.ceil(e.remaining)}s` : ''}</span>`)
      .join('');

    this.el['cold']!.style.opacity = String(s.modifiers.coldOverlay);
    this.el['heat']!.style.opacity = String(s.modifiers.heatOverlay);

    const st = world.get(player, StealthState);
    if (st) {
      this.el['stealthFill']!.style.width = `${Math.min(1, st.maxAwareness) * 100}%`;
      this.el['stealth']!.classList.toggle('detected', st.detected);
    }

    this.renderBuild(world, player);
    this.el['prompt']!.textContent = prompt ?? '';
    this.el['progressWrap']!.style.display = progress === null ? 'none' : 'block';
    if (progress !== null) this.el['progress']!.style.width = `${progress * 100}%`;
  }

  /** Builds the hold-E prompt for whatever the interaction system is looking at. */
  promptFor(world: World, target: Entity | null, player?: Entity): string | null {
    if (target === null) return null;
    const r = world.get(target, ResourceC);
    if (!r) return null;
    let hint = '';
    if (r.requiredTool && player !== undefined) {
      const s = world.require(player, SurvivorC);
      const fx = toolEffect(r, s.hotbar[s.activeHotbarSlot] ?? null);
      const best = BEST_TOOL_NAME[r.requiredTool] ?? 'tool';
      hint = fx?.fit === 'right' ? ` · ${best} ✓` : ` · much faster with ${/^[aeiou]/.test(best) ? 'an' : 'a'} ${best}`;
    }
    return `Hold E — ${RESOURCE_LABEL[r.kind]}${r.infinite ? '' : ` (${r.hitPoints}/${r.maxHitPoints})`}${hint}`;
  }

  toast(text: string, warn = false): void {
    const t = document.createElement('div');
    t.className = `toast${warn ? ' warn' : ''}`;
    t.textContent = text;
    this.el['toasts']!.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  private renderBuild(world: World, player: Entity): void {
    const el = this.el['build']!;
    const b = world.get(player, BuilderC);
    if (!b?.active) {
      el.style.display = 'none';
      return;
    }
    const inv = new InventoryGrid(world.require(player, SurvivorC).inventory);
    const cost = PIECE_COSTS[b.kind].map((c) => {
      const have = inv.count(c.item);
      return `<span class="${have >= c.qty ? '' : 'short'}">${c.qty} ${c.item} (${have})</span>`;
    }).join(' · ');
    el.style.display = 'block';
    el.innerHTML = `
      <div class="pieces">${PIECE_ORDER.map((k) => `<span class="${k === b.kind ? 'on' : ''}">${PIECE_LABEL[k]}</span>`).join('')}</div>
      <div class="cost">Cost: ${cost}</div>
      <div class="${b.blockedReason ? 'reason bad' : 'reason ok'}">${b.blockedReason ?? 'Left click to build'}</div>
      <div class="keys">R / wheel: change piece · X: demolish (½ refund) · E: door / sleep · stairs climb the way you look · B: exit</div>`;
  }

  /** Brief black fade so waking up reads as time having passed. */
  private fadeToBlack(): void {
    const f = this.el['sleepFade']!;
    f.classList.remove('on');
    void f.offsetWidth;
    f.classList.add('on');
  }

  /** Minecraft-style feedback on the crosshair: white X on hit, red on kill. */
  private hitMarker(killed: boolean): void {
    const c = this.root.querySelector<HTMLElement>('.crosshair');
    if (!c) return;
    c.classList.remove('hit', 'kill');
    void c.offsetWidth; // restart the CSS animation
    c.classList.add(killed ? 'kill' : 'hit');
    clearTimeout(this.hitTimer);
    this.hitTimer = setTimeout(() => c.classList.remove('hit', 'kill'), killed ? 450 : 260);
  }
  private hitTimer: ReturnType<typeof setTimeout> | undefined;

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.root.remove();
  }

  flash(key: 'hurt', seconds: number): void {
    const n = this.el[key]!;
    n.style.opacity = '0.6';
    setTimeout(() => (n.style.opacity = '0'), seconds * 1000);
  }
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
