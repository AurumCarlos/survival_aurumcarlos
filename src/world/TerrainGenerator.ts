import type { ResourceKind, Vec3 } from '../data/schema';
import { Perlin, hash2, mulberry32 } from './Noise';
import { SPECIES } from './TreeSpecies';

/**
 * Procedural desert island. Produces *data only* (heights + placements); the
 * render layer turns it into chunked low-poly meshes and the physics layer
 * into a Cannon Heightfield. Keeping generation pure means it can run in a
 * Web Worker and be unit-tested.
 *
 * Profile, from the open sea inward:
 *
 *   sea floor ─► shallow turquoise lagoon ─► very flat white beach ring ─►
 *   forest edge ─► dense fir forest on gentle low hills (+ freshwater ponds)
 *
 * Every zone is measured in *metres from the coastline* along the radius, so
 * the beach keeps the same width all the way round regardless of map size.
 */

export interface TerrainConfig {
  seed: number;
  /** World is size × size metres, centred on the origin. */
  size: number;
  /** Vertices per side minus one. 0.75 × size → one quad per 1.33 m. */
  resolution: number;
  /** Extra height of the inland hills above the beach (m). Kept low: a flat island. */
  maxHeight: number;
  /** Perlin frequency in 1/m — lower = broader hills. */
  baseFrequency: number;
  waterLevel: number;
  /** Radius around the spawn point kept clear of props. */
  spawnClearRadius: number;
  /** Chunk edge length for culling/instancing. */
  chunkSize: number;
  /**
   * Generator version. 1 = the flat desert island (kept so older saves
   * regenerate exactly the same world); 2 = mountains, caves and biomes.
   */
  gen?: number;
}

/** Newest generator; new worlds use it. */
export const GENERATOR_VERSION = 2;

export const BIOME = { beach: 0, forest: 1, jungle: 2, meadow: 3, highland: 4, snow: 5, cave: 6 } as const;
export type Biome = (typeof BIOME)[keyof typeof BIOME];
export const BIOME_NAME = ['Beach', 'Forest', 'Jungle', 'Meadow', 'Highlands', 'Snowy peak', 'Cave'] as const;

/**
 * A cave dug into a mountainside: a flat-floored chamber (carved into the
 * heightfield) under a rock roof (mesh + colliders). The mouth faces downhill.
 */
export interface Cave {
  /** Centre of the chamber floor. */
  x: number;
  z: number;
  /** Floor height. */
  y: number;
  /** Direction from the mouth into the mountain: (sin yaw, cos yaw). */
  yaw: number;
  length: number;
  width: number;
  /** Ceiling height above the floor. */
  height: number;
}

/** Local cave coordinates: s along the axis (0 = centre, −L/2 = mouth), w across. */
export function caveLocal(c: Cave, x: number, z: number): { s: number; w: number } {
  const dx = x - c.x, dz = z - c.z;
  const ax = Math.sin(c.yaw), az = Math.cos(c.yaw);
  return { s: dx * ax + dz * az, w: dx * az - dz * ax };
}

/** Inside the chamber footprint (ellipse), with an optional margin in metres. */
/** Length of the ramp graded in front of a cave mouth (m). */
export const CAVE_APPROACH = 8;

/** In the chamber or on the approach in front of the mouth (kept clear of trees and rocks). */
export function caveClearZone(c: Cave, x: number, z: number): boolean {
  if (insideCave(c, x, z, 3)) return true;
  const { s, w } = caveLocal(c, x, z);
  return s < -c.length / 2 && s > -c.length / 2 - CAVE_APPROACH - 2 && Math.abs(w) < c.width / 2 + 2.5;
}

export function insideCave(c: Cave, x: number, z: number, margin = 0): boolean {
  const { s, w } = caveLocal(c, x, z);
  const a = c.length / 2 + margin, b = c.width / 2 + margin;
  return (s * s) / (a * a) + (w * w) / (b * b) <= 1;
}

export const DEFAULT_TERRAIN: TerrainConfig = {
  seed: 1337, size: 256, resolution: 192, maxHeight: 6, baseFrequency: 1 / 80,
  waterLevel: 1.2, spawnClearRadius: 8, chunkSize: 32, gen: 1,
};

/**
 * Island shape. `radius` and `wobble` are fractions of the half map size; the
 * coastline radius varies by ±wobble around the angle (bays and headlands).
 */
export const ISLAND = {
  radius: 0.74,
  wobble: 0.09,
  /** Beach ring width, in metres (scaled with map size, clamped). */
  beachMin: 12,
  beachMax: 26,
  /** Metres of knee-deep turquoise water before the sea floor drops away. */
  lagoon: 9,
  seaDepth: 6,
} as const;

export type PropKind = ResourceKind | 'grass_tuft' | 'log';

export interface PropPlacement {
  kind: PropKind;
  position: Vec3;
  rotationY: number;
  scale: number;
  variant: number;
  /** Index of the chunk this prop belongs to (for per-chunk instancing + culling). */
  chunk: number;
}

export interface Spawn extends Vec3 {
  /** Facing the island's centre (the forest), with the sea behind. */
  yaw: number;
}

export interface TerrainData {
  cfg: TerrainConfig;
  /** (resolution+1)² heights, row-major, rows along +Z. */
  heights: Float32Array;
  /** Slope 0 (flat) .. 1 (vertical) per vertex. */
  slopes: Float32Array;
  props: PropPlacement[];
  chunksPerSide: number;
  /** Highest point, used by the physics heightfield and fog planes. */
  maxY: number;
  /** Where a new game starts: on the beach, like a castaway. */
  spawn: Spawn;
  /** Biome per height vertex (gen 2+). */
  biomes?: Uint8Array;
  /** Caves (gen 2+). */
  caves?: Cave[];
}

interface Pond {
  x: number;
  z: number;
  r: number;
}

/** Everything about the island that depends only on (seed, size). */
class IslandShape {
  readonly half: number;
  readonly radius: number;
  readonly beach: number;
  readonly ponds: Pond[] = [];
  /** Mountains (gen 2): centre, peak height above the lowlands, radius. */
  readonly peaks: Array<{ x: number; z: number; h: number; r: number }> = [];
  readonly caves: Cave[] = [];
  readonly gen: number;
  private readonly coastNoise: Perlin;
  private readonly hills: Perlin;
  private readonly crags: Perlin;
  private readonly moistureNoise: Perlin;

  constructor(readonly cfg: TerrainConfig) {
    this.half = cfg.size / 2;
    this.radius = this.half * ISLAND.radius;
    this.beach = clamp(this.half * 0.13, ISLAND.beachMin, ISLAND.beachMax);
    this.coastNoise = new Perlin(cfg.seed + 911);
    this.hills = new Perlin(cfg.seed);
    this.crags = new Perlin(cfg.seed + 4242);
    this.moistureNoise = new Perlin(cfg.seed + 777);
    this.gen = cfg.gen ?? 1;
  }

  /**
   * Mountain height (gen 2) at (x, z), before fading toward the coast: smooth
   * domes with ridged crags, so there are cliffs, gullies and summits.
   */
  mountain(x: number, z: number): number {
    let m = 0;
    for (const p of this.peaks) {
      const t = Math.hypot(x - p.x, z - p.z) / p.r;
      if (t >= 1) continue;
      const bump = (1 - t * t) ** 2;
      const ridge = this.crags.ridged(x / 38 + p.x, z / 38 - p.z, 4); // 0..1
      const spur = this.crags.fbm(x / 16, z / 16, 2) * 0.12;
      m = Math.max(m, p.h * bump * (0.62 + 0.55 * ridge + spur));
    }
    return m;
  }

  /** 0 on the beach and its hinterland, 1 well inland: mountains never touch the flat beach. */
  inlandFade(d: number, beach: number): number {
    return smoothstep(beach + 8, beach + 34, d);
  }

  /** 0 = dry, 1 = wet. */
  moisture(x: number, z: number): number {
    return clamp((this.moistureNoise.fbm(x / 90 + 13, z / 90 - 41, 3) + 0.8) / 1.6, 0, 1);
  }

  /** Biome at a point, given its height. */
  biomeAt(x: number, z: number, h: number): Biome {
    const W = this.cfg.waterLevel;
    for (const c of this.caves) if (insideCave(c, x, z, 0.5)) return BIOME.cave;
    const { d, beach } = this.zone(x, z);
    if (d < beach) return BIOME.beach;
    if (this.gen < 2) return BIOME.forest;
    const top = this.peaks.reduce((a, p) => Math.max(a, p.h), 0);
    if (top > 0 && h > W + 3 + top * 0.66) return BIOME.snow;
    if (h > W + 11) return BIOME.highland;
    const m = this.moisture(x, z);
    if (m > 0.62) return BIOME.jungle;
    if (m < 0.33) return BIOME.meadow;
    return BIOME.forest;
  }

  /** Coastline radius and beach width for a direction. Sampled on a circle so it is seamless. */
  coastAt(angle: number): { coast: number; beach: number } {
    const c = Math.cos(angle), s = Math.sin(angle);
    const n = this.coastNoise.fbm(c * 1.6 + 31, s * 1.6 - 17, 3); // ≈ −0.8..0.8
    const b = this.coastNoise.noise2(c * 2.2 + 80, s * 2.2 + 80);
    return { coast: this.radius * (1 + ISLAND.wobble * n), beach: this.beach * (0.85 + 0.3 * (b + 0.5)) };
  }

  /** Metres inland from the waterline (negative = out at sea) and the local beach width. */
  zone(x: number, z: number): { d: number; beach: number } {
    const { coast, beach } = this.coastAt(Math.atan2(z, x));
    return { d: coast - Math.hypot(x, z), beach };
  }

  height(x: number, z: number): number {
    const W = this.cfg.waterLevel;
    const { d, beach } = this.zone(x, z);
    let h: number;
    if (d < 0) {
      // Sea: a gentle lagoon shelf, then the floor drops to seaDepth.
      const s = -d;
      h = s <= ISLAND.lagoon
        ? W + 0.25 - s * 0.07
        : W + 0.25 - ISLAND.lagoon * 0.07 - (s - ISLAND.lagoon) * 0.3;
      h = Math.max(h, W - ISLAND.seaDepth);
    } else if (d < beach) {
      // Beach: rises only 0.45 m over its whole width — flat enough to build anywhere.
      const t = d / beach;
      h = W + 0.25 + 0.45 * t * Math.sqrt(t) + this.hills.noise2(x / 9, z / 9) * 0.04;
    } else {
      // Forest: low, broad hills that fade in from the beach edge.
      const f = this.cfg.baseFrequency;
      const inland = 1 - Math.exp(-(d - beach) / 22);
      const hills = (this.hills.fbm(x * f, z * f, 5) + 1) * 0.5;
      const outcrop = Math.max(0, this.hills.ridged(x * f * 2.6 + 40, z * f * 2.6 - 17, 3) - 0.58) * 3;
      h = W + 0.7 + inland * (0.6 + hills * this.cfg.maxHeight + outcrop);
      if (this.gen >= 2) h += this.mountain(x, z) * this.inlandFade(d, beach);
    }
    // Caves: carve the chamber floor flat into the mountainside, and keep the
    // ground in front of the mouth no higher than the floor.
    for (const c of this.caves) {
      const { s, w } = caveLocal(c, x, z);
      if (Math.abs(w) > c.width / 2 + 3 || s > c.length / 2 + 2.5 || s < -c.length / 2 - CAVE_APPROACH) continue;
      if (insideCave(c, x, z, 0.4)) {
        h = c.y + this.hills.noise2(x / 3, z / 3) * 0.05;
      } else if (s < -c.length / 2 + 2) {
        // Approach: a smooth ramp from the cave floor out to the natural ground.
        const out = smoothstep(0, CAVE_APPROACH, -(s + c.length / 2));
        const side = smoothstep(c.width / 2 - 1, c.width / 2 + 3, Math.abs(w));
        h = lerp(lerp(c.y, h, out), h, side);
      }
    }
    // Freshwater ponds sit in hollows in the forest.
    for (const p of this.ponds) {
      const dist = Math.hypot(x - p.x, z - p.z);
      const bank = 7;
      if (dist >= p.r + bank) continue;
      const pondH = dist < p.r
        ? W - 0.15 - 0.9 * (1 - (dist / p.r) ** 2)
        : lerp(W + 0.25, h, smoothstep(p.r, p.r + bank, dist));
      h = Math.min(h, pondH);
    }
    return h;
  }
}

export function generateTerrain(cfg: TerrainConfig = DEFAULT_TERRAIN): TerrainData {
  const island = new IslandShape(cfg);
  const rand = mulberry32(cfg.seed + 7);

  // ---- Spawn on the beach, and ponds inland away from it --------------------
  const spawnAngle = rand() * Math.PI * 2;
  const sc = island.coastAt(spawnAngle);
  const sr = sc.coast - sc.beach * 0.5;
  const sx = Math.cos(spawnAngle) * sr, sz = Math.sin(spawnAngle) * sr;

  if (island.gen >= 2) placeMountainsAndCaves(island, rand);

  const pondCount = cfg.size <= 192 ? 1 : cfg.size <= 384 ? 2 : 3;
  const pondR = clamp(cfg.size * 0.025, 5, 10);
  const maxPondDist = Math.max(4, island.radius * (1 - ISLAND.wobble) - island.beach - pondR - 14);
  for (let tries = 0; island.ponds.length < pondCount && tries < 200; tries++) {
    const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * maxPondDist;
    const p = { x: Math.cos(a) * r, z: Math.sin(a) * r, r: pondR * (0.8 + rand() * 0.4) };
    if (island.ponds.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < q.r + p.r + 25)) continue;
    // Ponds lie in the lowlands, not halfway up a mountain or in a cave.
    if (island.gen >= 2 && (island.mountain(p.x, p.z) > 1.5 || island.caves.some((c) => Math.hypot(c.x - p.x, c.z - p.z) < c.length + p.r + 8))) continue;
    island.ponds.push(p);
  }

  // ---- Heights ---------------------------------------------------------------
  const n = cfg.resolution + 1;
  const step = cfg.size / cfg.resolution;
  const half = cfg.size / 2;
  const heights = new Float32Array(n * n);
  let maxY = -Infinity;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const h = island.height(ix * step - half, iz * step - half);
      heights[iz * n + ix] = h;
      if (h > maxY) maxY = h;
    }
  }

  const slopes = new Float32Array(n * n);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const hL = heights[iz * n + Math.max(ix - 1, 0)]!;
      const hR = heights[iz * n + Math.min(ix + 1, n - 1)]!;
      const hD = heights[Math.max(iz - 1, 0) * n + ix]!;
      const hU = heights[Math.min(iz + 1, n - 1) * n + ix]!;
      const gx = (hR - hL) / (2 * step);
      const gz = (hU - hD) / (2 * step);
      slopes[iz * n + ix] = 1 - 1 / Math.sqrt(1 + gx * gx + gz * gz); // 1 − normal.y
    }
  }

  const data: TerrainData = {
    cfg, heights, slopes, props: [], chunksPerSide: Math.ceil(cfg.size / cfg.chunkSize), maxY,
    spawn: { x: sx, y: 0, z: sz, yaw: Math.atan2(sx, sz) },
  };
  data.spawn.y = sampleHeight(data, sx, sz);
  if (island.gen >= 2) {
    const biomes = new Uint8Array(n * n);
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) biomes[iz * n + ix] = island.biomeAt(ix * step - half, iz * step - half, heights[iz * n + ix]!);
    }
    data.biomes = biomes;
    data.caves = island.caves.map((c) => ({ ...c }));
  }
  data.props = scatterProps(data, island, rand);
  return data;
}

/**
 * Gen 2 relief: 1–3 mountains inland (taller on bigger maps), each with a
 * cave on its flank whose mouth faces downhill. Uses its own RNG so the
 * spawn point and ponds don't shift between seeds' layouts.
 */
function placeMountainsAndCaves(island: IslandShape, _rand: () => number): void {
  const cfg = island.cfg;
  const rand = mulberry32(cfg.seed + 31337);
  const count = cfg.size <= 192 ? 1 : cfg.size <= 384 ? 2 : 3;
  const maxR = Math.max(6, island.radius * (1 - ISLAND.wobble) - island.beach - 40);
  const peakH = clamp(cfg.size * 0.115, 16, 40);
  const peakR = clamp(cfg.size * 0.2, 26, 80);
  for (let tries = 0; island.peaks.length < count && tries < 300; tries++) {
    const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * maxR * 0.85;
    const p = { x: Math.cos(a) * r, z: Math.sin(a) * r, h: peakH * (0.8 + rand() * 0.35), r: peakR * (0.8 + rand() * 0.35) };
    if (island.peaks.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < (q.r + p.r) * 0.6)) continue;
    island.peaks.push(p);
  }
  // A cave on each mountain's flank: where the ground is about a third of the
  // way up, the slope is walkable, and the mouth looks downhill.
  for (const p of island.peaks) {
    let best: { c: Cave; score: number } | null = null;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2 + rand() * 0.2;
      for (const f of [0.35, 0.45, 0.55, 0.65, 0.75, 0.85]) {
        const mx = p.x + Math.cos(a) * p.r * f, mz = p.z + Math.sin(a) * p.r * f;
        const { d, beach } = island.zone(mx, mz);
        if (d - beach < 18) continue;
        const L = 15, Wd = 10;
        // Chamber axis points from the mouth toward the summit.
        const yaw = Math.atan2(p.x - mx, p.z - mz);
        const cx = mx + Math.sin(yaw) * L / 2, cz = mz + Math.cos(yaw) * L / 2;
        const floor = island.height(mx, mz);
        const back = island.height(mx + Math.sin(yaw) * L, mz + Math.cos(yaw) * L);
        const front = island.height(mx - Math.sin(yaw) * 6, mz - Math.cos(yaw) * 6);
        const depth = back - floor; // how much rock is above the back of the chamber
        const ramp = (floor - front) / 6;
        if (depth < 4 || ramp > 0.9 || ramp < -0.1) continue;
        const score = depth - Math.abs(ramp - 0.25) * 10;
        if (!best || score > best.score) best = { c: { x: cx, z: cz, y: floor, yaw, length: L, width: Wd, height: 5 }, score };
      }
    }
    if (best) island.caves.push(best.c);
  }
}

/** Bilinear height sample at world (x, z). Used by AI ground-snapping and spawning. */
export function sampleHeight(t: TerrainData, x: number, z: number): number {
  const { size, resolution } = t.cfg;
  const n = resolution + 1;
  const gx = clamp(((x + size / 2) / size) * resolution, 0, resolution - 1e-6);
  const gz = clamp(((z + size / 2) / size) * resolution, 0, resolution - 1e-6);
  const ix = Math.floor(gx), iz = Math.floor(gz);
  const fx = gx - ix, fz = gz - iz;
  const h00 = t.heights[iz * n + ix]!, h10 = t.heights[iz * n + ix + 1]!;
  const h01 = t.heights[(iz + 1) * n + ix]!, h11 = t.heights[(iz + 1) * n + ix + 1]!;
  return lerp(lerp(h00, h10, fx), lerp(h01, h11, fx), fz);
}

export function sampleSlope(t: TerrainData, x: number, z: number): number {
  const { size, resolution } = t.cfg;
  const n = resolution + 1;
  const ix = clamp(Math.round(((x + size / 2) / size) * resolution), 0, resolution);
  const iz = clamp(Math.round(((z + size / 2) / size) * resolution), 0, resolution);
  return t.slopes[iz * n + ix]!;
}

export function chunkIndex(t: TerrainData, x: number, z: number): number {
  const cs = t.cfg.chunkSize;
  const cx = clamp(Math.floor((x + t.cfg.size / 2) / cs), 0, t.chunksPerSide - 1);
  const cz = clamp(Math.floor((z + t.cfg.size / 2) / cs), 0, t.chunksPerSide - 1);
  return cz * t.chunksPerSide + cx;
}

/** Tree grid spacing (m). Jitter keeps trunks ≥ ~1.4 m apart, so the forest stays walkable. */
const TREE_CELL = 3.4;
const UNDER_CELL = 2.2;

/**
 * Two passes over jittered grids (≈ blue noise, no clumps):
 *
 *  1. Trees: almost every cell inland gets a fir — a closed canopy — except
 *     small clearings from a density noise field. A ~10 m ramp at the forest
 *     edge thins them out toward the sand. No trees on the beach.
 *  2. Undergrowth between the trunks (bushes, fiber, grass, mushrooms,
 *     rocks), plus driftwood and the odd boulder on the beach.
 *
 * Then water sources around each pond. Order is fixed, so prop indices are
 * stable for a seed — saves rely on that.
 */
function scatterProps(t: TerrainData, island: IslandShape, rand: () => number): PropPlacement[] {
  const cfg = t.cfg;
  const W = cfg.waterLevel;
  const out: PropPlacement[] = [];
  const noise = new Perlin(cfg.seed + 101);
  const groves = new Perlin(cfg.seed + 202);
  const half = cfg.size / 2;
  const sp = t.spawn;
  const push = (kind: PropKind, x: number, z: number, scale: number, variant = Math.floor(rand() * 4)): void => {
    out.push({ kind, position: { x, y: sampleHeight(t, x, z), z }, rotationY: rand() * Math.PI * 2, scale, variant, chunk: chunkIndex(t, x, z) });
  };
  const nearSpawn = (x: number, z: number): boolean => Math.hypot(x - sp.x, z - sp.z) < cfg.spawnClearRadius;

  // ---- 1. Trees -------------------------------------------------------------
  const trees = new Map<number, { x: number; z: number }>();
  const key = (cx: number, cz: number): number => (cx + 4096) * 8192 + (cz + 4096);
  for (let gz = -half; gz < half; gz += TREE_CELL) {
    for (let gx = -half; gx < half; gx += TREE_CELL) {
      const cx = Math.round(gx / TREE_CELL), cz = Math.round(gz / TREE_CELL);
      const x = gx + (0.2 + 0.6 * hash2(cx, cz, cfg.seed)) * TREE_CELL;
      const z = gz + (0.2 + 0.6 * hash2(cz, cx, cfg.seed + 1)) * TREE_CELL;
      const { d, beach } = island.zone(x, z);
      const depth = d - beach;
      if (depth < 0 || nearSpawn(x, z)) continue;
      if (sampleHeight(t, x, z) < W + 0.5 || sampleSlope(t, x, z) > 0.4) continue; // ponds, outcrops
      // Gen 2 biomes: bare snowy peaks, sparse highlands, open meadows, no trees in caves.
      const biome = island.gen >= 2 ? island.biomeAt(x, z, sampleHeight(t, x, z)) : BIOME.forest;
      if (biome === BIOME.cave || biome === BIOME.snow) continue;
      const keep = hash2(cx * 3 + 1, cz * 7 - 2, cfg.seed + 55);
      if (biome === BIOME.highland && keep > 0.42) continue;
      if (biome === BIOME.meadow && keep > 0.16) continue;
      if (island.gen >= 2 && island.caves.some((c) => caveClearZone(c, x, z))) continue;
      const edge = clamp(depth / 10, 0.15, 1);
      const clearing = (noise.fbm(x / 28, z / 28, 2) + 1) / 2 < 0.27;
      if (rand() > edge * (clearing ? 0.1 : 0.93)) continue;
      // 1 in 5 is a young tree, so the canopy has layers instead of one flat height.
      const young = rand() < 0.2;
      push('tree', x, z, young ? 0.35 + rand() * 0.25 : 0.75 + rand() * 0.5);
      // Species from broad noise fields (groves), with per-tree jitter so the
      // mix is patchy rather than uniform. Uses hashes, not rand(), so the
      // positions — and therefore save-file resource ids — don't change.
      const last = out[out.length - 1]!;
      const sp = biomeSpecies(biome, pickSpecies(groves, x, z, depth, cfg.seed), keep);
      last.variant = sp * 4 + (last.variant % 4);
      last.scale *= SPECIES_SCALE[sp]!;
      trees.set(key(cx, cz), { x, z });
    }
  }
  const nearTrunk = (x: number, z: number, minD: number): boolean => {
    const cx = Math.round(x / TREE_CELL), cz = Math.round(z / TREE_CELL);
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        const tr = trees.get(key(cx + a, cz + b));
        if (tr && Math.hypot(tr.x - x, tr.z - z) < minD) return true;
      }
    }
    return false;
  };

  // ---- 2. Undergrowth and beach debris ------------------------------------------
  for (let gz = -half; gz < half; gz += UNDER_CELL) {
    for (let gx = -half; gx < half; gx += UNDER_CELL) {
      const cx = Math.round(gx / UNDER_CELL), cz = Math.round(gz / UNDER_CELL);
      const x = gx + hash2(cx, cz, cfg.seed + 5) * UNDER_CELL;
      const z = gz + hash2(cz, cx, cfg.seed + 6) * UNDER_CELL;
      const { d, beach } = island.zone(x, z);
      if (d < 0.5 || nearSpawn(x, z) || sampleHeight(t, x, z) < W + 0.1) continue;
      const r = rand();
      if (d < beach) {
        if (r < 0.012) push('rock', x, z, 0.6 + rand() * 0.7);
        else if (r < 0.022) push('log', x, z, 0.8 + rand() * 0.5); // driftwood
        else if (d > beach * 0.7 && r < 0.09) push('grass_tuft', x, z, 0.8 + rand() * 0.6); // dune grass
        else if (d > beach * 0.7 && r < 0.11) push('fiber_plant', x, z, 0.7 + rand() * 0.5);
        continue;
      }
      if (nearTrunk(x, z, 1.1)) continue;
      const wet = (noise.fbm(x / 60 + 7, z / 60 - 7, 3) + 1) / 2;
      if (island.gen >= 2) {
        const biome = island.biomeAt(x, z, sampleHeight(t, x, z));
        if (biome === BIOME.cave || island.caves.some((c) => caveClearZone(c, x, z))) continue;
        if (sampleSlope(t, x, z) > 0.5) continue;
        // [rock, berry, fiber, grass, log, mushroom] cumulative thresholds per biome.
        const th = UNDERGROWTH[biome] ?? UNDERGROWTH[BIOME.forest]!;
        if (r < th[0]!) push('rock', x, z, 0.6 + rand() * 0.9);
        else if (r < th[1]!) push('berry_bush', x, z, 0.7 + rand() * 0.6);
        else if (r < th[2]!) push('fiber_plant', x, z, 0.7 + rand() * 0.6);
        else if (r < th[3]!) push('grass_tuft', x, z, 0.7 + rand() * 0.6);
        else if (r < th[4]!) push('log', x, z, 0.8 + rand() * 0.5);
        else if (r < th[5]! && (wet > 0.45 || biome === BIOME.jungle)) push('mushroom', x, z, 0.7 + rand() * 0.6);
        continue;
      }
      if (r < 0.04) push('rock', x, z, 0.6 + rand() * 0.9);
      else if (r < 0.085) push('berry_bush', x, z, 0.7 + rand() * 0.6);
      else if (r < 0.15) push('fiber_plant', x, z, 0.7 + rand() * 0.6);
      else if (r < 0.4) push('grass_tuft', x, z, 0.7 + rand() * 0.6);
      else if (r < 0.415) push('log', x, z, 0.8 + rand() * 0.5);
      else if (r < 0.43 && wet > 0.5) push('mushroom', x, z, 0.7 + rand() * 0.6);
    }
  }

  // ---- 3. Drinkable water around the ponds ------------------------------------------
  for (const p of island.ponds) {
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      const x = p.x + Math.cos(a) * p.r * 0.82, z = p.z + Math.sin(a) * p.r * 0.82;
      out.push({ kind: 'water_source', position: { x, y: W, z }, rotationY: 0, scale: 1, variant: 0, chunk: chunkIndex(t, x, z) });
    }
  }

  // ---- 4. ARK resources, palms, flowers (appended: older prop indices stay valid) ----
  scatterExtras(t, island, out, nearTrunk, noise);
  return out;
}

/**
 * Trees are drawn 25 % taller than their base scale (mature firs 15–25 m)
 * without thickening trunks, so the forest stays as walkable as before.
 * Applied by the renderer; colliders only care about trunk radius.
 */
export const TREE_HEIGHT_STRETCH = 1.25;
/** Per-species size spread on top of the base scale. */
const SPECIES_SCALE = [1, 1, 1, 1.1, 0.95, 1.05, 1];

/** Undergrowth per biome: cumulative thresholds for rock, berry bush, fiber, grass, log, mushroom. */
const UNDERGROWTH: Partial<Record<Biome, readonly number[]>> = {
  [BIOME.forest]: [0.04, 0.085, 0.15, 0.4, 0.415, 0.43],
  [BIOME.jungle]: [0.02, 0.08, 0.2, 0.5, 0.52, 0.57],
  [BIOME.meadow]: [0.02, 0.1, 0.2, 0.7, 0.705, 0.71],
  [BIOME.highland]: [0.1, 0.12, 0.16, 0.36, 0.37, 0.37],
  [BIOME.snow]: [0.05, 0.05, 0.05, 0.06, 0.06, 0.06],
};

/** Biomes bias the species mix (gen 2); `roll` is a 0..1 hash. */
function biomeSpecies(biome: Biome, picked: number, roll: number): number {
  switch (biome) {
    case BIOME.highland: return roll < 0.2 ? SPECIES.spruce : SPECIES.pine;
    case BIOME.meadow: return roll < 0.09 ? SPECIES.birch : SPECIES.oak;
    case BIOME.jungle: {
      const k = (roll * 997) % 1;
      return k < 0.4 ? SPECIES.oak : k < 0.62 ? SPECIES.palm : k < 0.75 ? SPECIES.redwood : picked;
    }
    default: return picked;
  }
}

/**
 * Picks a species from three slow noise fields. Each species has a preferred
 * "climate"; the strongest wins, plus random jitter, so groves of one
 * species blend at their edges and the odd tree of another kind grows inside.
 */
function pickSpecies(groves: Perlin, x: number, z: number, depth: number, seed: number): number {
  const a = groves.fbm(x / 70 + 300, z / 70 - 120, 2); // ≈ −0.8..0.8
  const b = groves.fbm(x / 55 - 77, z / 55 + 410, 2);
  const c = groves.fbm(x / 38 + 911, z / 38 + 37, 2);
  const edge = Math.max(0, 1 - depth / 14); // forest edge: broadleaves and birch
  const w = [
    0.62 + 1.2 * a, // fir — still the most common
    0.5 + 1.5 * b, // spruce
    0.42 - 1.4 * a, // pine
    0.45 - 1.4 * b + edge * 0.7, // oak
    0.38 + 1.2 * (b - a) + edge * 0.8, // birch
    c > 0.32 ? 1.4 + c : -9, // redwood: only in a few grove cores
  ];
  let best = 0, bestW = -Infinity;
  for (let i = 0; i < w.length; i++) {
    const jitter = hash2(Math.round(x * 7) + i * 131, Math.round(z * 7) - i * 71, seed + 33) * 0.55;
    if (w[i]! + jitter > bestW) {
      bestW = w[i]! + jitter;
      best = i;
    }
  }
  return best;
}

/**
 * Second, independent pass (own RNG): palms on the beach, ARK resource nodes
 * (metal/obsidian/crystal outcrops inland; oil rocks, salt, shell beds and
 * fish along the shore), and rare flowers in clearings.
 */
function scatterExtras(
  t: TerrainData, island: IslandShape, out: PropPlacement[],
  nearTrunk: (x: number, z: number, d: number) => boolean, noise: Perlin,
): void {
  const cfg = t.cfg;
  const W = cfg.waterLevel;
  const half = cfg.size / 2;
  const rand = mulberry32(cfg.seed + 7777);
  const sp = t.spawn;
  const taken: Array<{ x: number; z: number; r: number }> = [];
  const free = (x: number, z: number, r: number, trunkGap = 0.8): boolean =>
    Math.hypot(x - sp.x, z - sp.z) > cfg.spawnClearRadius + 2 && !nearTrunk(x, z, r + trunkGap) &&
    !island.caves.some((c) => insideCave(c, x, z, r + 1.5) || caveClearZone(c, x, z)) &&
    taken.every((o) => Math.hypot(o.x - x, o.z - z) > o.r + r);
  const add = (kind: PropKind, x: number, z: number, scale: number, variant = Math.floor(rand() * 4), y?: number): void => {
    out.push({ kind, position: { x, y: y ?? sampleHeight(t, x, z), z }, rotationY: rand() * Math.PI * 2, scale, variant, chunk: chunkIndex(t, x, z) });
    taken.push({ x, z, r: Math.max(0.8, scale) });
  };
  const grid = (cell: number, f: (x: number, z: number) => void): void => {
    for (let gz = -half + cell / 2; gz < half; gz += cell) {
      for (let gx = -half + cell / 2; gx < half; gx += cell) f(gx + (rand() - 0.5) * cell * 0.8, gz + (rand() - 0.5) * cell * 0.8);
    }
  };

  // Shore: palms, oil rocks, salt crusts, shell beds; fish in the lagoon.
  grid(6, (x, z) => {
    const { d, beach } = island.zone(x, z);
    const r = rand();
    if (d < -16 || d > beach) return;
    const h = sampleHeight(t, x, z);
    if (h < W - 0.15) {
      if (d < -5 && r < 0.14) add('fish_shoal', x, z, 1, 0, W); // out in the lagoon, swim to them
      return;
    }
    if (h < W + 0.12) {
      if (r < 0.16) add('shell_bed', x, z, 0.8 + rand() * 0.5, Math.floor(rand() * 4), Math.max(W, h)); // at the waterline
      return;
    }
    if (d > beach * 0.6 && r < 0.13 && free(x, z, 0.4)) add('tree', x, z, 0.9 + rand() * 0.35, SPECIES.palm * 4 + Math.floor(rand() * 4));
    else if (r > 0.97 && free(x, z, 0.7)) add('oil_rock', x, z, 0.9 + rand() * 0.4);
    else if (r > 0.94 && d < beach * 0.6 && free(x, z, 0.6)) add('salt_deposit', x, z, 0.8 + rand() * 0.4);
  });

  // Inland mineral outcrops: small clusters of metal, obsidian, crystal and stone.
  const minHigh = W + cfg.maxHeight * 0.45;
  grid(20, (cx, cz) => {
    const { d, beach } = island.zone(cx, cz);
    const chance = island.gen >= 2 ? (island.mountain(cx, cz) > 6 ? 0.85 : 0.35) : 0.7;
    if (d - beach < 10 || rand() > chance) return;
    if (island.caves.some((c) => insideCave(c, cx, cz, 6))) return;
    const high = sampleHeight(t, cx, cz) > minHigh;
    const n = 4 + Math.floor(rand() * 4);
    for (let k = 0; k < n; k++) {
      const a = rand() * Math.PI * 2, rr = 1.5 + rand() * 4;
      const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
      const scale = 0.9 + rand() * 0.6;
      if (sampleHeight(t, x, z) < W + 0.5 || sampleSlope(t, x, z) > 0.45 || !free(x, z, 0.6 * scale, 0.5)) continue;
      const roll = rand();
      const kind: PropKind = roll < 0.42 ? 'metal_rock' : roll < 0.56 ? 'rock' : roll < (high ? 0.78 : 0.74) ? 'obsidian_rock' : high || roll > 0.86 ? 'crystal' : 'metal_rock';
      add(kind, x, z, kind === 'rock' ? 1.1 + rand() * 0.4 : scale);
    }
  });

  // Caves: crystals glitter at the back, and a vein of metal.
  for (const c of island.caves) {
    const ax = Math.sin(c.yaw), az = Math.cos(c.yaw);
    const at = (s: number, w: number): [number, number] => [c.x + ax * s + az * w, c.z + az * s - ax * w];
    for (const [s, w, kind, sc] of [[c.length / 2 - 2.2, -2.6, 'crystal', 1.2], [c.length / 2 - 1.8, 2.4, 'crystal', 1], [c.length / 2 - 4.5, 3.4, 'metal_rock', 1.1], [0.5, -3.6, 'crystal', 0.9]] as const) {
      const [x, z] = at(s, w);
      out.push({ kind, position: { x, y: c.y, z }, rotationY: rand() * Math.PI * 2, scale: sc, variant: Math.floor(rand() * 4), chunk: chunkIndex(t, x, z) });
    }
  }

  // Rare flowers, mostly in clearings.
  grid(5, (x, z) => {
    const { d, beach } = island.zone(x, z);
    if (d - beach < 4) return;
    const clearing = (noise.fbm(x / 28, z / 28, 2) + 1) / 2 < 0.3;
    if (rand() < (clearing ? 0.12 : 0.02) && sampleHeight(t, x, z) > W + 0.4 && free(x, z, 0.3, 0.2)) add('rare_flower', x, z, 0.8 + rand() * 0.5);
  });
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
