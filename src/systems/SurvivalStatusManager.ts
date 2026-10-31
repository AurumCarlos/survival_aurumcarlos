import { itemDef } from '../data/items';
import { SIM } from '../data/settings';
import type {
  Activity, ItemId, StatusEffect, StatusEffectId, Survivor, SurvivorModifiers, ThermalExposure, Vitals,
} from '../data/schema';
import type { DeathCause } from '../core/EventBus';

/**
 * Survival status manager: metabolism, thermoregulation, status effects and
 * health. Pure logic — no ECS, DOM, Three or Cannon — so the same code runs in
 * the browser, in a headless balance simulation (scripts/simulate-night.ts)
 * and, later, on an authoritative server.
 *
 * All rates are per *simulated* second and are applied with the loop's fixed
 * dt, so behaviour is identical at 30, 60 or 144 FPS.
 */

export type Rng = () => number;

export const SURVIVAL_TUNING = {
  /** Idle drain per second. Full → empty: hunger 45 min, thirst 30 min, energy 60 min. */
  baseDecay: { hunger: 100 / (45 * 60), thirst: 100 / (30 * 60), energy: 100 / (60 * 60) },

  /** How much harder each activity works the body, per vital. */
  activity: {
    idle:      { hunger: 1.0, thirst: 1.0, energy: 1.0, heat: 0 },
    walking:   { hunger: 1.4, thirst: 1.4, energy: 1.5, heat: 0.002 },
    crouching: { hunger: 1.2, thirst: 1.2, energy: 1.3, heat: 0.001 },
    sprinting: { hunger: 2.6, thirst: 3.0, energy: 4.0, heat: 0.008 },
    gathering: { hunger: 1.8, thirst: 1.9, energy: 2.2, heat: 0.004 },
    swimming:  { hunger: 2.2, thirst: 0.5, energy: 3.0, heat: -0.01 },
    sleeping:  { hunger: 0.6, thirst: 0.7, energy: -12, heat: -0.001 }, // negative = regenerates
  } satisfies Record<Activity, { hunger: number; thirst: number; energy: number; heat: number }>,

  stamina: { sprintDrain: 14, regen: 20, windedThreshold: 25 },

  thermal: {
    normalC: 37,
    /** Effective ambient range the body can hold 37 °C in without help. */
    comfortMinC: 12,
    comfortMaxC: 27,
    /** °C/s of core drift per °C the environment is outside the comfort band. */
    driftPerDegree: 0.0012,
    /** °C/s recovery toward normal when the environment is comfortable. */
    recoveryRate: 0.03,
    coldC: 36, hypothermiaC: 35, hotC: 37.8, hyperthermiaC: 39,
    minC: 28, maxC: 44,
    wetPenaltyC: 6,
    /** Shivering burns calories: extra hunger per °C below comfort. */
    coldHungerPerDegree: 0.03,
    /** Sweating: extra thirst per °C above comfort. */
    heatThirstPerDegree: 0.08,
  },

  damage: {
    starvation: 0.35, // hp/s at hunger 0
    dehydration: 0.7,
    hypothermiaPerDegree: 0.5, // hp/s per °C below threshold (+1)
    hyperthermiaPerDegree: 0.6,
    foodPoisoning: 0.1,
    bleedingPerStack: 0.5,
  },

  regen: { rate: 0.25, minHunger: 60, minThirst: 60, minEnergy: 20 },
} as const;

/** Effects whose presence is derived from vitals each tick. */
const CONDITION_EFFECTS: readonly StatusEffectId[] = [
  'starving', 'dehydrated', 'exhausted', 'cold', 'hypothermia', 'hot', 'hyperthermia',
  'warmed_by_fire', 'sheltered', 'well_fed',
];

export interface SurvivalTickResult {
  added: StatusEffectId[];
  removed: StatusEffectId[];
  died: DeathCause | null;
  /** Effective temperature the body felt this tick (useful for the HUD). */
  feltTempC: number;
}

export class SurvivalStatusManager {
  constructor(private readonly rng: Rng = Math.random, private readonly t = SURVIVAL_TUNING) {}

  /**
   * Advance one survivor by dt seconds. Mutates `s` in place (no allocation
   * on the hot path other than the small result arrays, which are reused).
   */
  tick(s: Survivor, env: ThermalExposure, dt: number): SurvivalTickResult {
    const result = this.result;
    result.added.length = 0;
    result.removed.length = 0;
    result.died = null;

    if (!s.alive) {
      result.feltTempC = env.ambientC;
      return result;
    }

    const v = s.vitals;
    const act = this.t.activity[s.activity];
    const felt = this.feltTemperature(s, env);
    result.feltTempC = felt;

    // ---- 1. Metabolism ---------------------------------------------------
    const th = this.t.thermal;
    const coldGap = Math.max(0, th.comfortMinC - felt);
    const heatGap = Math.max(0, felt - th.comfortMaxC);
    const poisoned = this.hasEffect(s, 'food_poisoning');

    // Settings multipliers (SIM): drains only — sleep's energy regeneration is not slowed by a slower tiredness.
    const hungerRate = this.t.baseDecay.hunger * act.hunger * (1 + coldGap * th.coldHungerPerDegree) * SIM.hungerRate;
    const thirstRate =
      this.t.baseDecay.thirst * act.thirst * (1 + heatGap * th.heatThirstPerDegree) * (poisoned ? 2 : 1) * SIM.thirstRate;
    const energyRate = this.t.baseDecay.energy * act.energy * (act.energy > 0 ? SIM.energyRate : 1);

    v.hunger = clamp(v.hunger - hungerRate * dt, 0, s.maxVitals.hunger);
    v.thirst = clamp(v.thirst - thirstRate * dt, 0, s.maxVitals.thirst);
    v.energy = clamp(v.energy - energyRate * dt, 0, s.maxVitals.energy);

    // Stamina is the short-term sprint pool. Low energy slows its recovery.
    if (s.activity === 'sprinting') {
      v.stamina = Math.max(0, v.stamina - this.t.stamina.sprintDrain * dt);
    } else {
      const energyFactor = 0.3 + 0.7 * (v.energy / s.maxVitals.energy);
      v.stamina = Math.min(s.maxVitals.stamina, v.stamina + this.t.stamina.regen * SIM.staminaRegen * energyFactor * dt);
    }

    // ---- 2. Thermoregulation --------------------------------------------
    // Core temperature *drifts* toward danger rather than snapping to it, so
    // walking out of the fire's radius at night gives ~1.5–2 minutes before
    // hypothermia: enough to fetch wood, not enough to explore.
    let drift: number;
    if (coldGap > 0) drift = -coldGap * th.driftPerDegree;
    else if (heatGap > 0) drift = heatGap * th.driftPerDegree;
    else drift = towards(v.bodyTemp, th.normalC, th.recoveryRate * dt) / Math.max(dt, 1e-9);
    drift += act.heat; // exertion warms you up a little
    v.bodyTemp = clamp(v.bodyTemp + drift * dt, th.minC, th.maxC);

    // ---- 3. Timed effects ------------------------------------------------
    for (let i = s.effects.length - 1; i >= 0; i--) {
      const e = s.effects[i]!;
      if (e.remaining === Number.POSITIVE_INFINITY) continue;
      e.remaining -= dt;
      if (e.remaining <= 0) {
        s.effects.splice(i, 1);
        result.removed.push(e.id);
      }
    }

    // ---- 4. Condition effects (derived from vitals) -----------------------
    this.setCondition(s, 'starving', v.hunger <= 0, result);
    this.setCondition(s, 'dehydrated', v.thirst <= 0, result);
    this.setCondition(s, 'exhausted', v.energy <= 0, result);
    this.setCondition(s, 'hypothermia', v.bodyTemp < th.hypothermiaC, result);
    this.setCondition(s, 'cold', v.bodyTemp < th.coldC && v.bodyTemp >= th.hypothermiaC, result);
    this.setCondition(s, 'hyperthermia', v.bodyTemp > th.hyperthermiaC, result);
    this.setCondition(s, 'hot', v.bodyTemp > th.hotC && v.bodyTemp <= th.hyperthermiaC, result);
    this.setCondition(s, 'warmed_by_fire', env.fireWarmthC > 1, result);
    this.setCondition(s, 'sheltered', env.shelterInsulation > 0, result);
    const wellFed =
      v.hunger >= this.t.regen.minHunger && v.thirst >= this.t.regen.minThirst &&
      v.energy >= this.t.regen.minEnergy && v.bodyTemp >= th.coldC && v.bodyTemp <= th.hotC && !poisoned;
    this.setCondition(s, 'well_fed', wellFed, result);

    // ---- 5. Health -------------------------------------------------------
    // Track the largest damage source so the death screen can name it.
    const d = this.t.damage;
    let damage = 0;
    let worst: DeathCause | null = null;
    let worstAmount = 0;
    const hurt = (amount: number, cause: DeathCause): void => {
      if (amount <= 0) return;
      damage += amount;
      if (amount > worstAmount) {
        worstAmount = amount;
        worst = cause;
      }
    };
    if (v.hunger <= 0) hurt(d.starvation, 'starvation');
    if (v.thirst <= 0) hurt(d.dehydration, 'dehydration');
    if (v.bodyTemp < th.hypothermiaC) hurt(d.hypothermiaPerDegree * (th.hypothermiaC - v.bodyTemp + 1), 'hypothermia');
    if (v.bodyTemp > th.hyperthermiaC) hurt(d.hyperthermiaPerDegree * (v.bodyTemp - th.hyperthermiaC + 1), 'hyperthermia');
    if (poisoned) hurt(d.foodPoisoning, 'starvation');
    const bleeding = this.findEffect(s, 'bleeding');
    if (bleeding) hurt(d.bleedingPerStack * bleeding.stacks, 'combat');

    v.health -= damage * dt;
    if (damage === 0 && wellFed) v.health += this.t.regen.rate * SIM.healthRegen * dt;
    v.health = clamp(v.health, 0, s.maxVitals.health);

    if (v.health <= 0) {
      s.alive = false;
      // No environmental cause: health was taken by an animal's attack.
      result.died = worst ?? 'combat';
    }

    // ---- 6. Derived modifiers -------------------------------------------
    this.computeModifiers(s, v);
    s.stats.secondsSurvived += dt;
    return result;
  }

  /**
   * Felt temperature = ambient + clothing (cold only) + fire, then pulled
   * toward the comfort band by shelter insulation. Wet clothes make cold worse.
   */
  feltTemperature(s: Survivor, env: ThermalExposure): number {
    const th = this.t.thermal;
    let felt = env.ambientC;
    if (felt < th.comfortMinC) {
      // Clothing can bring you up to comfortable, never above it.
      felt = Math.min(th.comfortMinC, felt + env.clothingInsulationC + this.wornInsulation(s));
      if (env.wet) felt -= th.wetPenaltyC;
    }
    felt += env.fireWarmthC;
    if (env.shelterInsulation > 0) {
      const mid = (th.comfortMinC + th.comfortMaxC) / 2;
      felt += (mid - felt) * clamp(env.shelterInsulation, 0, 1);
    }
    return felt;
  }

  /** Eat or drink. Returns false if the item is not consumable. */
  consume(s: Survivor, item: ItemId): boolean {
    const c = itemDef(item).consumable;
    if (!c || !s.alive) return false;
    const v = s.vitals;
    if (c.hunger) v.hunger = clamp(v.hunger + c.hunger, 0, s.maxVitals.hunger);
    if (c.thirst) v.thirst = clamp(v.thirst + c.thirst, 0, s.maxVitals.thirst);
    if (c.energy) v.energy = clamp(v.energy + c.energy, 0, s.maxVitals.energy);
    if (c.health) v.health = clamp(v.health + c.health, 0, s.maxVitals.health);
    if (c.sideEffect && this.rng() < c.sideEffect.chance) {
      this.applyEffect(s, c.sideEffect.effect, c.sideEffect.duration, 'consumable');
    }
    return true;
  }

  /** Timed effect. Re-applying refreshes duration; bleeding stacks. */
  applyEffect(s: Survivor, id: StatusEffectId, duration: number, source: StatusEffect['source']): void {
    const existing = this.findEffect(s, id);
    if (existing) {
      existing.remaining = Math.max(existing.remaining, duration);
      if (id === 'bleeding') existing.stacks = Math.min(existing.stacks + 1, 5);
      return;
    }
    s.effects.push({ id, remaining: duration, stacks: 1, source });
  }

  hasEffect(s: Survivor, id: StatusEffectId): boolean {
    return this.findEffect(s, id) !== undefined;
  }

  // ---- internals ----------------------------------------------------------

  private readonly result: SurvivalTickResult = { added: [], removed: [], died: null, feltTempC: 0 };

  private findEffect(s: Survivor, id: StatusEffectId): StatusEffect | undefined {
    for (const e of s.effects) if (e.id === id) return e;
    return undefined;
  }

  private setCondition(s: Survivor, id: StatusEffectId, active: boolean, r: SurvivalTickResult): void {
    const idx = s.effects.findIndex((e) => e.id === id && e.source === 'condition');
    if (active && idx < 0) {
      s.effects.push({ id, remaining: Number.POSITIVE_INFINITY, stacks: 1, source: 'condition' });
      r.added.push(id);
    } else if (!active && idx >= 0) {
      s.effects.splice(idx, 1);
      r.removed.push(id);
    }
  }

  private wornInsulation(s: Survivor): number {
    const worn = s.equipped.body;
    return worn ? (itemDef(worn.item).wearable?.insulation ?? 0) : 0;
  }

  private computeModifiers(s: Survivor, v: Vitals): void {
    const th = this.t.thermal;
    const m: SurvivorModifiers = s.modifiers;
    const exhausted = v.energy <= 0;
    const hypo = v.bodyTemp < th.hypothermiaC;
    const hyper = v.bodyTemp > th.hyperthermiaC;

    let speed = 1;
    if (exhausted) speed *= 0.6;
    if (hypo) speed *= 0.75;
    if (hyper) speed *= 0.85;
    if (v.hunger < 15) speed *= 0.9;
    m.moveSpeed = speed;
    m.gatherSpeed = speed * (v.energy < 25 ? 0.8 : 1);
    m.staminaRegen = 0.3 + 0.7 * (v.energy / s.maxVitals.energy);

    // Hysteresis: once winded (stamina hit 0), sprint unlocks only after
    // recovering to the threshold — avoids flicker between sprint/walk.
    const winded = !m.canSprint && v.stamina < this.t.stamina.windedThreshold;
    m.canSprint = !exhausted && !hypo && v.stamina > 0 && !winded;

    m.coldOverlay = clamp((th.coldC + 0.5 - v.bodyTemp) / 2.5, 0, 1);
    m.heatOverlay = clamp((v.bodyTemp - th.hotC + 0.3) / 1.5, 0, 1);
  }
}

// ---------------------------------------------------------------------------

export function createSurvivor(id: number, name: string): Survivor {
  return {
    id, name,
    vitals: { health: 100, hunger: 85, thirst: 85, energy: 90, stamina: 100, bodyTemp: 37 },
    maxVitals: { health: 100, hunger: 100, thirst: 100, energy: 100, stamina: 100 },
    inventory: { cols: 10, rows: 6, placements: [] },
    hotbar: [null, null, null, null, null, null],
    activeHotbarSlot: 0,
    equipped: { body: null },
    effects: [],
    activity: 'idle',
    alive: true,
    modifiers: { moveSpeed: 1, canSprint: true, gatherSpeed: 1, staminaRegen: 1, coldOverlay: 0, heatOverlay: 0 },
    stats: { secondsSurvived: 0, distanceTravelled: 0, itemsCrafted: 0 },
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Signed step from `from` toward `to`, at most `maxStep` in magnitude. */
function towards(from: number, to: number, maxStep: number): number {
  const d = to - from;
  return Math.abs(d) <= maxStep ? d : Math.sign(d) * maxStep;
}
