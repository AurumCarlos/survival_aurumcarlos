import type { ResourceKind, Vec3 } from '../data/schema';
import { Perlin, hash2, mulberry32 } from './Noise';

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
}

export const DEFAULT_TERRAIN: TerrainConfig = {
  seed: 1337, size: 256, resolution: 192, maxHeight: 6, baseFrequency: 1 / 80,
  waterLevel: 1.2, spawnClearRadius: 8, chunkSize: 32,
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

export type PropKind = ResourceKind | 'grass_tuft' | 'log' | 'mushroom';

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
  private readonly coastNoise: Perlin;
  private readonly hills: Perlin;

  constructor(readonly cfg: TerrainConfig) {
    this.half = cfg.size / 2;
    this.radius = this.half * ISLAND.radius;
    this.beach = clamp(this.half * 0.13, ISLAND.beachMin, ISLAND.beachMax);
    this.coastNoise = new Perlin(cfg.seed + 911);
    this.hills = new Perlin(cfg.seed);
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

  const pondCount = cfg.size <= 192 ? 1 : cfg.size <= 384 ? 2 : 3;
  const pondR = clamp(cfg.size * 0.025, 5, 10);
  const maxPondDist = Math.max(4, island.radius * (1 - ISLAND.wobble) - island.beach - pondR - 14);
  for (let tries = 0; island.ponds.length < pondCount && tries < 200; tries++) {
    const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * maxPondDist;
    const p = { x: Math.cos(a) * r, z: Math.sin(a) * r, r: pondR * (0.8 + rand() * 0.4) };
    if (island.ponds.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < q.r + p.r + 25)) continue;
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
  data.props = scatterProps(data, island, rand);
  return data;
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
      const edge = clamp(depth / 10, 0.15, 1);
      const clearing = (noise.fbm(x / 28, z / 28, 2) + 1) / 2 < 0.27;
      if (rand() > edge * (clearing ? 0.1 : 0.93)) continue;
      // 1 in 5 is a young fir, so the canopy has layers instead of one flat height.
      const young = rand() < 0.2;
      push('tree', x, z, young ? 0.35 + rand() * 0.25 : 0.75 + rand() * 0.5);
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
  return out;
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
