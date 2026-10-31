import * as THREE from 'three';

/**
 * Procedural, seamlessly tiling surface textures, generated once at first use.
 * The game still ships zero image files: every texel comes from tileable
 * noise (period-wrapped lattices, so the left edge matches the right one).
 *
 * Terrain layers are stored as two DataArrayTextures (one draw, two samplers):
 *   albedo  RGBA — colour, A = height (used to blend layers by height)
 *   normal  RGBA — tangent-space normal in RGB, A = roughness
 * A separate small "grain" texture (normal + height) gives every prop and
 * creature a triplanar surface detail.
 */

export const TERRAIN_LAYERS = ['sand', 'grass', 'dirt', 'rock', 'snow'] as const;
export type TerrainLayer = (typeof TERRAIN_LAYERS)[number];

const SIZE = 512;
const GRAIN_SIZE = 256;

// ---------------------------------------------------------------------------
// Tileable noise
// ---------------------------------------------------------------------------

function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Value noise on a lattice wrapping every `period` cells; u, v in [0, 1). */
function vnoise(u: number, v: number, period: number, seed: number): number {
  const x = u * period, y = v * period;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const ix0 = ((x0 % period) + period) % period, iy0 = ((y0 % period) + period) % period;
  const ix1 = (ix0 + 1) % period, iy1 = (iy0 + 1) % period;
  const a = hash2(ix0, iy0, seed), b = hash2(ix1, iy0, seed);
  const c = hash2(ix0, iy1, seed), d = hash2(ix1, iy1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function fbm(u: number, v: number, period: number, octaves: number, seed: number, gain = 0.5): number {
  let sum = 0, amp = 1, norm = 0, p = period;
  for (let o = 0; o < octaves; o++) {
    sum += vnoise(u, v, p, seed + o * 101) * amp;
    norm += amp;
    amp *= gain;
    p *= 2;
  }
  return sum / norm;
}

/** Sharp crests: cracks and rock strata. */
function ridged(u: number, v: number, period: number, octaves: number, seed: number): number {
  let sum = 0, amp = 1, norm = 0, p = period;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(vnoise(u, v, p, seed + o * 57) * 2 - 1);
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / norm;
}

/** Distance to the nearest jittered cell point (wrapping): pebbles, cells, cracks. */
function worley(u: number, v: number, period: number, seed: number): { f1: number; f2: number; id: number } {
  const x = u * period, y = v * period;
  const cx = Math.floor(x), cy = Math.floor(y);
  let f1 = 9, f2 = 9, id = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const gx = cx + i, gy = cy + j;
      const wx = ((gx % period) + period) % period, wy = ((gy % period) + period) % period;
      const px = gx + hash2(wx, wy, seed), py = gy + hash2(wx, wy, seed + 7);
      const d = Math.hypot(px - x, py - y);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = hash2(wx, wy, seed + 13);
      } else if (d < f2) f2 = d;
    }
  }
  return { f1, f2, id };
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number): number => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

type RGB = [number, number, number];
const hex = (h: number): RGB => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
const lerpRGB = (a: RGB, b: RGB, t: number): RGB => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

/** One texel: colour (linear-ish 0..1), height 0..1, roughness 0..1. */
interface Texel { c: RGB; h: number; r: number }
type LayerFn = (u: number, v: number) => Texel;

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

const SAND_A = hex(0xc4ad82), SAND_B = hex(0xa48d66), SAND_DARK = hex(0x7d6a4c);
const sand: LayerFn = (u, v) => {
  // Wind ripples: stretched, wavy bands; fine grain on top.
  const warp = fbm(u, v, 4, 3, 11) * 2.2;
  const ripple = 0.5 + 0.5 * Math.sin((v * 22 + warp) * Math.PI * 2);
  const grain = vnoise(u, v, 256, 12);
  const patch = fbm(u, v, 3, 4, 13);
  const pebble = worley(u, v, 40, 14);
  const isPebble = 1 - smooth(0.18, 0.24, pebble.f1);
  let c = lerpRGB(SAND_A, SAND_B, patch * 0.8 + grain * 0.25);
  c = lerpRGB(c, SAND_DARK, isPebble * (0.4 + pebble.id * 0.5) * (pebble.id > 0.7 ? 1 : 0));
  const h = ripple * 0.35 + grain * 0.25 + patch * 0.2 + isPebble * (pebble.id > 0.7 ? 0.3 : 0);
  return { c, h, r: 0.92 };
};

const GRASS_A = hex(0x4f6e2a), GRASS_B = hex(0x6f8a35), GRASS_DRY = hex(0x9a9248), GRASS_DARK = hex(0x2f4a1c), SOIL = hex(0x5a4630);
const grass: LayerFn = (u, v) => {
  // Blades: high-frequency noise stretched along a slowly varying direction.
  const dir = fbm(u, v, 3, 2, 21) * Math.PI;
  const bu = u * Math.cos(dir) - v * Math.sin(dir), bv = u * Math.sin(dir) + v * Math.cos(dir);
  const blades = vnoise(bu * 6 + 10, bv * 0.9 + 10, 128, 22) * 0.6 + vnoise(u, v, 192, 23) * 0.4;
  const clumps = fbm(u, v, 6, 4, 24);
  const dry = smooth(0.55, 0.8, fbm(u, v, 2, 4, 25));
  const bare = smooth(0.68, 0.8, fbm(u, v, 5, 4, 26));
  let c = lerpRGB(GRASS_DARK, GRASS_A, smooth(0.15, 0.75, blades));
  c = lerpRGB(c, GRASS_B, clumps * 0.6);
  c = lerpRGB(c, GRASS_DRY, dry * 0.55);
  c = lerpRGB(c, SOIL, bare * 0.7);
  return { c, h: blades * 0.6 + clumps * 0.3 - bare * 0.2 + 0.2, r: 0.88 };
};

const DIRT_A = hex(0x4b3a28), DIRT_B = hex(0x6a5236), NEEDLE = hex(0x7a5a2e), LEAF = hex(0x5e4a22), MOSS = hex(0x3f5222);
const dirt: LayerFn = (u, v) => {
  // Forest floor: earth, fallen needles and leaves, a little moss.
  const soil = fbm(u, v, 8, 5, 31);
  const needles = Math.max(
    smooth(0.82, 0.95, vnoise(u * 9 + v * 2, v * 0.6 - u * 0.3, 96, 32)),
    smooth(0.84, 0.96, vnoise(u * 0.5 + v * 0.4, v * 9 - u * 2.5, 96, 33)),
  );
  const leaf = worley(u, v, 24, 34);
  const isLeaf = (1 - smooth(0.25, 0.32, leaf.f1)) * (leaf.id > 0.55 ? 1 : 0);
  const moss = smooth(0.6, 0.75, fbm(u, v, 3, 4, 35));
  let c = lerpRGB(DIRT_A, DIRT_B, soil);
  c = lerpRGB(c, MOSS, moss * 0.7);
  c = lerpRGB(c, LEAF, isLeaf * (0.5 + leaf.id * 0.4));
  c = lerpRGB(c, NEEDLE, needles * 0.8);
  return { c, h: soil * 0.5 + needles * 0.3 + isLeaf * 0.25, r: 0.95 };
};

const ROCK_A = hex(0x6e6a63), ROCK_B = hex(0x8f8a80), ROCK_WARM = hex(0x86725c), ROCK_DARK = hex(0x3c3a37), LICHEN = hex(0x8c8a5a);
const rock: LayerFn = (u, v) => {
  // Strata (horizontal bands, warped) + cracks + blotchy weathering.
  const warp = fbm(u, v, 3, 3, 41);
  const strata = 0.5 + 0.5 * Math.sin((v * 9 + warp * 3) * Math.PI * 2);
  const cracks = worley(u + warp * 0.05, v, 10, 42);
  const crack = 1 - smooth(0.0, 0.07, cracks.f2 - cracks.f1);
  const rough = ridged(u, v, 8, 5, 43);
  const blot = fbm(u, v, 4, 5, 44);
  const lichen = smooth(0.66, 0.78, fbm(u, v, 6, 4, 45));
  let c = lerpRGB(ROCK_A, ROCK_B, blot * 0.8 + rough * 0.2);
  c = lerpRGB(c, ROCK_WARM, smooth(0.3, 0.9, strata) * 0.35);
  c = lerpRGB(c, LICHEN, lichen * 0.45);
  c = lerpRGB(c, ROCK_DARK, crack * 0.85);
  return { c, h: rough * 0.55 + strata * 0.2 + blot * 0.25 - crack * 0.45, r: 0.8 - lichen * 0.05 };
};

const SNOW_A = hex(0xf2f5f8), SNOW_B = hex(0xd4dde8), SNOW_BLUE = hex(0xb9c8dc);
const snow: LayerFn = (u, v) => {
  const drift = fbm(u, v, 3, 5, 51);
  const sparkle = vnoise(u, v, 256, 52);
  const wind = 0.5 + 0.5 * Math.sin((u * 7 + fbm(u, v, 2, 3, 53) * 2) * Math.PI * 2);
  let c = lerpRGB(SNOW_A, SNOW_B, drift * 0.7);
  c = lerpRGB(c, SNOW_BLUE, smooth(0.3, 0.0, drift) * 0.5);
  return { c, h: drift * 0.7 + wind * 0.2 + sparkle * 0.1, r: 0.55 + sparkle * 0.2 };
};

const LAYER_FNS: Record<TerrainLayer, LayerFn> = { sand, grass, dirt, rock, snow };

/** Average colour of each layer: lets vertex tints be expressed relative to it. */
export const LAYER_MEAN: Record<TerrainLayer, THREE.Color> = {
  sand: new THREE.Color(0xb6a078), grass: new THREE.Color(0x56732d), dirt: new THREE.Color(0x5a4630),
  rock: new THREE.Color(0x7a756c), snow: new THREE.Color(0xe6ecf2),
};

// ---------------------------------------------------------------------------
// Baking
// ---------------------------------------------------------------------------

/** Writes a tangent-space normal map from a wrapped height field (Sobel). */
function heightToNormal(h: Float32Array, size: number, strength: number, out: Uint8Array, offset: number, alpha: (i: number) => number): void {
  const at = (x: number, y: number): number => h[((y + size) % size) * size + ((x + size) % size)]!;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -dx * strength, ny = -dy * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const i = y * size + x, o = offset + i * 4;
      out[o] = Math.round((nx * 0.5 + 0.5) * 255);
      out[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      out[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      out[o + 3] = Math.round(clamp01(alpha(i)) * 255);
    }
  }
}

const NORMAL_STRENGTH: Record<TerrainLayer, number> = { sand: 3, grass: 4, dirt: 4, rock: 7, snow: 2 };

export interface TerrainTextures {
  albedo: THREE.DataArrayTexture;
  normal: THREE.DataArrayTexture;
}

let terrainTex: TerrainTextures | null = null;

/** Bakes the five terrain layers (≈ 0.5 s once, then cached for every session). */
export function terrainTextures(): TerrainTextures {
  if (terrainTex) return terrainTex;
  const n = TERRAIN_LAYERS.length, px = SIZE * SIZE;
  const albedo = new Uint8Array(px * 4 * n);
  const normal = new Uint8Array(px * 4 * n);
  const h = new Float32Array(px), r = new Float32Array(px);
  TERRAIN_LAYERS.forEach((name, layer) => {
    const fn = LAYER_FNS[name];
    const base = layer * px * 4;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const t = fn(x / SIZE, y / SIZE);
        const i = y * SIZE + x, o = base + i * 4;
        // Colours are authored in sRGB; the texture is flagged sRGB so the GPU linearises.
        albedo[o] = Math.round(clamp01(t.c[0]) * 255);
        albedo[o + 1] = Math.round(clamp01(t.c[1]) * 255);
        albedo[o + 2] = Math.round(clamp01(t.c[2]) * 255);
        albedo[o + 3] = Math.round(clamp01(t.h) * 255);
        h[i] = t.h;
        r[i] = t.r;
      }
    }
    heightToNormal(h, SIZE, NORMAL_STRENGTH[name], normal, base, (i) => r[i]!);
  });
  const make = (data: Uint8Array<ArrayBuffer>, srgb: boolean): THREE.DataArrayTexture => {
    const tex = new THREE.DataArrayTexture(data, SIZE, SIZE, n);
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.UnsignedByteType;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 8;
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.needsUpdate = true;
    return tex;
  };
  terrainTex = { albedo: make(albedo, true), normal: make(normal, false) };
  return terrainTex;
}

let grainTex: THREE.DataTexture | null = null;

/**
 * Generic surface detail for props, creatures and structures: RGB = normal,
 * A = height (darkens crevices). Sampled triplanar in world space, so it needs
 * no UVs and works on every procedural mesh.
 */
export function grainTexture(): THREE.DataTexture {
  if (grainTex) return grainTex;
  const S = GRAIN_SIZE, px = S * S;
  const h = new Float32Array(px);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      const cells = worley(u, v, 12, 61);
      h[y * S + x] = fbm(u, v, 8, 5, 62) * 0.55 + ridged(u, v, 6, 4, 63) * 0.3 + smooth(0, 0.25, cells.f2 - cells.f1) * 0.15;
    }
  }
  const data = new Uint8Array(px * 4);
  heightToNormal(h, S, 5, data, 0, (i) => h[i]!);
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  grainTex = tex;
  return tex;
}

let waterTex: THREE.DataTexture | null = null;

/** Tileable small-wave normal map for the sea (scrolled in two directions by the water shader). */
export function waterNormalTexture(): THREE.DataTexture {
  if (waterTex) return waterTex;
  const S = 256, px = S * S;
  const h = new Float32Array(px);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      h[y * S + x] = fbm(u, v, 4, 5, 71, 0.55) * 0.7 + (1 - worley(u, v, 6, 72).f1) * 0.3;
    }
  }
  const data = new Uint8Array(px * 4);
  heightToNormal(h, S, 6, data, 0, () => 1);
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  waterTex = tex;
  return tex;
}
