import type { System, World } from '../core/ecs/World';
import { Exposure, HeatSource, PlayerControlled, ShelterZone, SurvivorC, Transform } from '../components';
import type { ThermalExposure } from '../data/schema';
import type { DayNightCycle } from './DayNightCycle';

/**
 * Advances the day/night clock and works out, for every survivor, what the
 * environment is doing to them: ambient temperature, warmth from nearby
 * fires, shelter insulation and whether they are getting rained on.
 *
 * Runs before SurvivalSystem in the fixed step.
 */
export class EnvironmentSystem implements System {
  readonly name = 'environment';
  /** Fire warmth adds up across sources but is capped, so ten campfires ≠ a furnace. */
  maxFireWarmthC = 30;

  constructor(
    readonly cycle: DayNightCycle,
    /** Extra shelter source (player-built houses). Returns insulation 0..1 and whether rain is kept off. */
    private readonly shelterAt?: (feet: { x: number; y: number; z: number }) => { insulation: number; roof: boolean },
    /** Air gets colder with height: −lapse °C per metre above baseY (mountains). */
    private readonly altitude: { baseY: number; lapseCPerM: number } | null = null,
    /** Local climate: °C added to the air at (x, z) (a hot desert, a cold tundra). */
    private readonly climateAt: ((x: number, z: number) => number) | null = null,
  ) {}

  /** Air temperature at a given height (°C). */
  ambientAt(y: number): number {
    const a = this.altitude;
    return this.cycle.ambientTempC - (a ? Math.max(0, y - a.baseY) * a.lapseCPerM : 0);
  }

  fixedUpdate(world: World, dt: number): void {
    this.cycle.advance(dt);
    const ambient = this.cycle.ambientTempC;
    const raining = this.cycle.raining;

    // Burn fuel; rain slowly douses unsheltered fires.
    for (const e of world.query(HeatSource)) {
      const h = world.require(e, HeatSource);
      if (!h.lit) continue;
      h.fuelSeconds -= dt * (raining ? 1.5 : 1);
      if (h.fuelSeconds <= 0) {
        h.fuelSeconds = 0;
        h.lit = false;
      }
    }

    for (const e of world.query(SurvivorC, Transform)) {
      const p = world.require(e, Transform).position;
      let exp = world.get(e, Exposure);
      if (!exp) exp = world.add<ThermalExposure>(e, Exposure, {
        ambientC: ambient, fireWarmthC: 0, shelterInsulation: 0, clothingInsulationC: 0, wet: false,
      });

      // Fire: quadratic falloff — toasty near the flames, nothing at the edge.
      let warmth = 0;
      for (const f of world.query(HeatSource, Transform)) {
        const h = world.require(f, HeatSource);
        if (!h.lit) continue;
        const fp = world.require(f, Transform).position;
        const dx = fp.x - p.x, dy = fp.y - p.y, dz = fp.z - p.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= h.radius * h.radius) continue;
        const k = 1 - Math.sqrt(d2) / h.radius;
        warmth += h.peakWarmthC * k * k;
      }

      // Shelter: inside an AABB around the structure. Best one wins.
      let insulation = 0;
      let roofed = false;
      for (const s of world.query(ShelterZone, Transform)) {
        const z = world.require(s, ShelterZone);
        const sp = world.require(s, Transform).position;
        if (
          Math.abs(p.x - sp.x) <= z.halfExtents.x &&
          Math.abs(p.y - sp.y) <= z.halfExtents.y &&
          Math.abs(p.z - sp.z) <= z.halfExtents.z
        ) {
          insulation = Math.max(insulation, z.insulation);
          roofed ||= z.roof;
        }
      }

      if (this.shelterAt) {
        const built = this.shelterAt(p);
        insulation = Math.max(insulation, built.insulation);
        roofed ||= built.roof;
      }

      exp.ambientC = (this.altitude ? this.ambientAt(p.y) : ambient) + (this.climateAt?.(p.x, p.z) ?? 0);
      exp.fireWarmthC = Math.min(warmth, this.maxFireWarmthC);
      exp.shelterInsulation = insulation;
      // Swimming soaks you regardless of shelter; rain only if unroofed.
      exp.wet = (raining && !roofed) || (world.get(e, PlayerControlled)?.swimming ?? false);
    }
  }
}
