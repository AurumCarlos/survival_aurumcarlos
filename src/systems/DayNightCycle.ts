import { Perlin } from '../world/Noise';

export interface DayNightConfig {
  /** Real seconds per in-game day. 20 min default: ~13 min day, ~7 min night. */
  dayLengthSeconds: number;
  startHour: number;
  /** Daily mean / swing around it (°C). */
  meanTempC: number;
  amplitudeC: number;
  /** Day-to-day weather swing (± °C). */
  weatherC?: number;
  /** Hour of the daily maximum (afternoon lag behind solar noon). */
  peakHour: number;
  seed: number;
}

export const DEFAULT_DAY_NIGHT: DayNightConfig = {
  dayLengthSeconds: 20 * 60,
  startHour: 8,
  // A tropical island: mild nights (≈ 13–17 °C), warm afternoons (≈ 27–32 °C).
  // Real cold is up in the mountains (EnvironmentSystem lowers the air
  // temperature with altitude) and on rainy nights when you're soaked.
  meanTempC: 22,
  amplitudeC: 7,
  weatherC: 4,
  peakHour: 15,
  seed: 1337,
};

/**
 * Pure time-of-day model. Drives lighting (render layer), temperature
 * (EnvironmentSystem) and AI sight ranges (PerceptionSystem).
 */
export class DayNightCycle {
  /** Total elapsed in-game hours since start. */
  private hoursElapsed: number;
  private readonly weatherNoise: Perlin;

  constructor(readonly cfg: DayNightConfig = DEFAULT_DAY_NIGHT) {
    this.hoursElapsed = cfg.startHour;
    this.weatherNoise = new Perlin(cfg.seed ^ 0x5eed);
  }

  advance(dtSeconds: number): void {
    this.hoursElapsed += (dtSeconds / this.cfg.dayLengthSeconds) * 24;
  }

  /** 0..24 */
  get hour(): number {
    return this.hoursElapsed % 24;
  }

  get day(): number {
    return Math.floor(this.hoursElapsed / 24) + 1;
  }

  /** Total in-game hours since the world began. Saved/restored by the persistence layer. */
  get totalHours(): number {
    return this.hoursElapsed;
  }
  set totalHours(h: number) {
    if (Number.isFinite(h) && h >= 0) this.hoursElapsed = h;
  }

  setHour(h: number): void {
    this.hoursElapsed = Math.floor(this.hoursElapsed / 24) * 24 + h;
  }

  /** Sun elevation in radians: +π/2 at noon, −π/2 at midnight. */
  get sunElevation(): number {
    return Math.sin(((this.hour - 6) / 24) * Math.PI * 2) * (Math.PI / 2);
  }

  /** Sun azimuth around the Y axis (radians). */
  get sunAzimuth(): number {
    return ((this.hour - 6) / 24) * Math.PI * 2;
  }

  /**
   * 0 (moonless night) .. 1 (noon). Smoothstepped around the horizon so dusk
   * and dawn last a while instead of a hard switch.
   */
  get lightLevel(): number {
    const e = Math.sin(((this.hour - 6) / 24) * Math.PI * 2); // -1..1
    const t = clamp01((e + 0.15) / 0.45);
    return 0.06 + 0.94 * t * t * (3 - 2 * t);
  }

  get isNight(): boolean {
    return this.lightLevel < 0.25;
  }

  /**
   * Ambient air temperature (°C). A daily cosine around a per-day "weather"
   * offset from 1D Perlin noise, so some nights are bitter (−8 °C) and some
   * afternoons are heatwaves (≈ 34 °C).
   */
  get ambientTempC(): number {
    const c = this.cfg;
    const daily = c.amplitudeC * Math.cos(((this.hour - c.peakHour) / 24) * Math.PI * 2);
    const weather = this.weatherNoise.noise2(this.hoursElapsed / 24 / 3, 0.5) * 2 * (c.weatherC ?? 4.5); // slowly varying
    return c.meanTempC + daily + weather;
  }

  /** Simple rain model: noisy, more likely when it is mild. */
  get raining(): boolean {
    return this.weatherNoise.noise2(this.hoursElapsed / 6, 9.3) > 0.42;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
