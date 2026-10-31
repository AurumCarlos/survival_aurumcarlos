/**
 * Procedural sound: every sound is synthesised with Web Audio (filtered
 * noise, oscillators, envelopes) — the game still ships no audio files.
 *
 * Ambience beds run continuously and are faded by the world state each
 * frame (waves near the sea, wind, rain, birds by day inland, crickets at
 * night); effects are one-shots (footsteps, hits, a falling tree, getting
 * hurt). Browsers only allow audio after a user gesture: the context is
 * created on unlock(), which the App calls on the first click or key.
 */

export interface AudioWorldState {
  /** Metres to the nearest sea or pond water (≥ 60 = far inland). */
  waterDistance: number;
  /** Metres above sea level. */
  altitude: number;
  /** Daylight 0..1. */
  light: number;
  /** Rain strength 0..1. */
  rain: number;
  /** Under a roof or in a cave (rain muffled). */
  sheltered: boolean;
  /** Horizontal speed (m/s), for footsteps. */
  speed: number;
  grounded: boolean;
  swimming: boolean;
  /** What's underfoot. */
  ground: 'sand' | 'grass' | 'rock' | 'wood';
}

export interface Volumes {
  master: number;
  ambience: number;
  effects: number;
}

interface Bed {
  gain: GainNode;
  filter: BiquadFilterNode;
}

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private ambience!: GainNode;
  private effects!: GainNode;
  private noise!: AudioBuffer;
  private waves!: Bed;
  private wind!: Bed;
  private rain!: Bed;
  private volumes: Volumes = { master: 0.7, ambience: 0.8, effects: 0.8 };
  private time = 0;
  private stepTimer = 0;
  private birdTimer = 2;
  private cricketTimer = 0;
  private gust = 0;
  private gustTarget = 0;
  private gustTimer = 0;
  private state: AudioWorldState | null = null;

  /** Creates the audio graph (must run inside a user gesture). Safe to call repeatedly. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.ambience = ctx.createGain();
    this.effects = ctx.createGain();
    this.ambience.connect(this.master);
    this.effects.connect(this.master);
    // Two seconds of white noise, looped by every bed (each with its own filter).
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.waves = this.bed('lowpass', 420, 0.7);
    this.wind = this.bed('bandpass', 600, 0.6);
    this.rain = this.bed('highpass', 1800, 0.4);
    this.setVolumes(this.volumes);
  }

  setVolumes(v: Volumes): void {
    this.volumes = { ...v };
    if (!this.ctx) return;
    this.master.gain.value = v.master;
    this.ambience.gain.value = v.ambience;
    this.effects.gain.value = v.effects;
  }

  /** Silences the ambience (menus, game over) without stopping the context. */
  mute(muted: boolean): void {
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(muted ? 0 : this.volumes.master, this.ctx.currentTime, 0.3);
  }

  private bed(type: BiquadFilterType, freq: number, q: number): Bed {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.loopStart = Math.random() * 1.5; // beds don't share the same stretch of noise
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(this.ambience);
    src.start(0, Math.random() * 1.5);
    return { gain, filter };
  }

  /** Per frame: fades the ambience to the world state and schedules footsteps, birds, crickets. */
  update(dt: number, s: AudioWorldState): void {
    this.state = s;
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    this.time += dt;
    const now = ctx.currentTime;

    // Waves: louder near the water, swelling and ebbing every ~7 s.
    const near = Math.max(0, 1 - s.waterDistance / 55);
    const swell = 0.55 + 0.45 * Math.sin(this.time * 0.9) * Math.sin(this.time * 0.37 + 1);
    this.waves.gain.gain.setTargetAtTime(0.32 * near * near * swell, now, 0.25);
    this.waves.filter.frequency.setTargetAtTime(300 + 380 * swell, now, 0.3);

    // Wind: gusty, stronger up high and in the rain.
    this.gustTimer -= dt;
    if (this.gustTimer <= 0) {
      this.gustTarget = Math.random();
      this.gustTimer = 1.5 + Math.random() * 4;
    }
    this.gust += (this.gustTarget - this.gust) * Math.min(1, dt * 0.8);
    const windLevel = Math.min(1, 0.12 + s.altitude / 45 + s.rain * 0.4) * (0.5 + 0.5 * this.gust);
    this.wind.gain.gain.setTargetAtTime(0.13 * windLevel, now, 0.4);
    this.wind.filter.frequency.setTargetAtTime(380 + 650 * this.gust + s.altitude * 6, now, 0.5);

    // Rain: hiss, muffled under a roof.
    this.rain.gain.gain.setTargetAtTime(0.2 * s.rain * (s.sheltered ? 0.35 : 1), now, 0.5);
    this.rain.filter.frequency.setTargetAtTime(s.sheltered ? 700 : 1800, now, 0.3);

    // Birds by day, inland, not in the rain; crickets at night.
    const birds = s.light > 0.5 && s.rain < 0.2 && s.waterDistance > 12 && s.altitude < 30;
    this.birdTimer -= dt;
    if (birds && this.birdTimer <= 0) {
      this.chirp();
      this.birdTimer = 0.8 + Math.random() * 5;
    }
    const crickets = s.light < 0.3 && s.rain < 0.3 && s.altitude < 25;
    this.cricketTimer -= dt;
    if (crickets && this.cricketTimer <= 0) {
      this.cricket();
      this.cricketTimer = 0.25 + Math.random() * 0.9;
    }

    // Footsteps: cadence follows speed.
    if ((s.grounded || s.swimming) && s.speed > 0.6) {
      this.stepTimer -= dt;
      if (this.stepTimer <= 0) {
        this.footstep(s.swimming ? 'water' : s.ground);
        this.stepTimer = Math.max(0.26, 2 / (s.speed + 0.6));
      }
    } else {
      this.stepTimer = 0.05;
    }
  }

  // ---- One-shots -------------------------------------------------------------

  /** A burst of filtered noise with a fast attack and exponential decay. */
  private noiseHit(freq: number, q: number, type: BiquadFilterType, gain: number, decay: number, delay = 0, rate = 1): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = rate;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    src.connect(f).connect(g).connect(this.effects);
    src.start(t, Math.random() * 1.5);
    src.stop(t + decay + 0.05);
  }

  /** A tone sweeping from f0 to f1 (birds, crickets, grunts). */
  private tone(type: OscillatorType, f0: number, f1: number, gain: number, dur: number, delay = 0, dest?: AudioNode): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.02, dur / 3));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest ?? this.effects);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  footstep(ground: AudioWorldState['ground'] | 'water'): void {
    const v = 0.85 + Math.random() * 0.3;
    switch (ground) {
      case 'sand': this.noiseHit(900 * v, 0.7, 'lowpass', 0.09, 0.13); break;
      case 'grass': this.noiseHit(2400 * v, 0.8, 'bandpass', 0.06, 0.1); this.noiseHit(500, 0.7, 'lowpass', 0.05, 0.06); break;
      case 'rock': this.noiseHit(1500 * v, 2, 'bandpass', 0.1, 0.06); break;
      case 'wood': this.tone('triangle', 180 * v, 120, 0.1, 0.08); this.noiseHit(800, 1.5, 'bandpass', 0.05, 0.05); break;
      case 'water': this.noiseHit(1200 * v, 0.6, 'lowpass', 0.12, 0.35, 0, 0.6); break;
    }
  }

  /** Tool or fist meets wood/stone/flesh. */
  hit(heavy = false): void {
    this.noiseHit(heavy ? 300 : 650, 1.2, 'bandpass', heavy ? 0.3 : 0.2, 0.12);
    this.tone('sine', heavy ? 110 : 170, 60, heavy ? 0.25 : 0.15, 0.12);
  }

  /** Whoosh of a swing or a throw. */
  swing(): void {
    this.noiseHit(1800, 1.4, 'bandpass', 0.05, 0.18, 0, 1.4);
  }

  /** A felled tree: a creak, then the crash. */
  treeFall(): void {
    this.tone('sawtooth', 140, 70, 0.06, 0.6);
    this.noiseHit(240, 0.6, 'lowpass', 0.35, 1.2, 0.55, 0.7);
    this.noiseHit(1200, 0.8, 'bandpass', 0.12, 0.6, 0.6);
  }

  hurt(): void {
    this.tone('sawtooth', 220, 120, 0.12, 0.22);
    this.noiseHit(500, 1, 'bandpass', 0.12, 0.15);
  }

  /** Short UI-ish chime: crafting done. */
  chime(): void {
    this.tone('sine', 880, 880, 0.06, 0.25);
    this.tone('sine', 1320, 1320, 0.04, 0.3, 0.08);
  }

  private chirp(): void {
    const base = 2600 + Math.random() * 2000, notes = 2 + Math.floor(Math.random() * 4);
    const g = 0.025 * (this.state ? Math.min(1, this.state.light) : 1);
    for (let i = 0; i < notes; i++) {
      const f = base * (0.85 + Math.random() * 0.3);
      this.tone('sine', f, f * (Math.random() < 0.5 ? 1.3 : 0.75), g, 0.07 + Math.random() * 0.06, i * 0.11, this.ambience);
    }
  }

  private cricket(): void {
    const f = 4300 + Math.random() * 600;
    for (let i = 0; i < 3; i++) this.tone('sine', f, f, 0.012, 0.035, i * 0.05, this.ambience);
  }
}
