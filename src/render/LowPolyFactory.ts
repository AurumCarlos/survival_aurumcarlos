import * as THREE from 'three';
import { SPECIES, TREE_SPECIES, treeShape, treeSpecies } from '../world/TreeSpecies';
import { BED, STAIRS } from '../systems/building/BuildingGrid';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PropKind } from '../world/TerrainGenerator';

/**
 * Procedural low-poly meshes. These are both the default art (the game runs
 * with zero downloaded assets) and the fallback the AssetLoader substitutes
 * when a GLTF fails to load.
 *
 * Every geometry carries per-vertex colour and is drawn with ONE shared
 * flat-shaded material, which keeps draw calls and shader variants minimal.
 */

export const flatMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

export function paint(geo: THREE.BufferGeometry, hex: number, jitter = 0.06, seed = 1): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(hex);
  const n = g.attributes['position']!.count;
  const colors = new Float32Array(n * 3);
  // One colour per triangle with slight variation reads as "hand-painted facets".
  for (let tri = 0; tri < n / 3; tri++) {
    const v = 1 + (pseudo(tri * 7 + seed) - 0.5) * 2 * jitter;
    for (let k = 0; k < 3; k++) {
      const i = (tri * 3 + k) * 3;
      colors[i] = Math.min(1, c.r * v);
      colors[i + 1] = Math.min(1, c.g * v);
      colors[i + 2] = Math.min(1, c.b * v);
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.deleteAttribute('uv');
  return g;
}

export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false);
  if (!g) throw new Error('mergeGeometries failed: attribute mismatch');
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

function pseudo(n: number): number {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

/** Displace vertices deterministically by position so shared corners move together. */
export function wobble(geo: THREE.BufferGeometry, amount: number, seed: number): THREE.BufferGeometry {
  const p = geo.attributes['position']!;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const h = pseudo(Math.round(x * 100) * 3 + Math.round(y * 100) * 5 + Math.round(z * 100) * 7 + seed);
    const s = 1 + (h - 0.5) * amount;
    p.setXYZ(i, x * s, y * s, z * s);
  }
  return geo;
}

const cache = new Map<string, THREE.BufferGeometry>();
export function cached(key: string, build: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = cache.get(key);
  if (!g) {
    g = build();
    cache.set(key, g);
  }
  return g;
}

export function propGeometry(kind: PropKind, variant: number): THREE.BufferGeometry {
  return cached(`${kind}:${variant}`, () => {
    switch (kind) {
      case 'tree':
        return treeGeometry(variant, false);
      case 'rock':
        return merge([paint(wobble(new THREE.IcosahedronGeometry(0.9, 1), 0.35, variant).scale(1, 0.62, 1), 0x8a8a85, 0.12, variant)]);
      case 'berry_bush': {
        // Berry colours by variant (which berries grow on it, see BUSH_BERRIES).
        const pairs = [[0xb3263a, 0xd8434f], [0xe6c229, 0x2c58c9], [0xb3263a, 0x2a1d3a], [0xd8434f, 0xe9e2c8]] as const;
        const [c1, c2] = pairs[variant % pairs.length]!;
        const parts = [paint(wobble(new THREE.IcosahedronGeometry(0.7, 1), 0.25, variant).translate(0, 0.55, 0), 0x3d7a35)];
        for (let k = 0; k < 7; k++) {
          const a = k * 2.3, r = 0.45 + pseudo(k) * 0.2;
          parts.push(paint(new THREE.IcosahedronGeometry(0.09, 0).translate(Math.cos(a) * r, 0.45 + (k % 3) * 0.2, Math.sin(a) * r), k % 2 ? c1 : c2, 0));
        }
        return merge(parts);
      }
      case 'metal_rock': {
        const parts = [paint(wobble(new THREE.IcosahedronGeometry(0.9, 1), 0.3, variant + 3).scale(1, 0.75, 1), 0x6d6a66, 0.12, variant)];
        for (let k = 0; k < 6; k++) { // shiny ore veins
          const a = k * 1.9, h = 0.15 + (k % 3) * 0.22;
          parts.push(paint(new THREE.OctahedronGeometry(0.16, 0).scale(1.6, 0.6, 1).rotateY(a).translate(Math.cos(a) * 0.75, h, Math.sin(a) * 0.75), 0xc9b98a, 0.1, k));
        }
        return merge(parts);
      }
      case 'obsidian_rock':
        return merge([
          paint(wobble(new THREE.OctahedronGeometry(0.9, 1), 0.35, variant + 5).scale(1, 0.9, 1).translate(0, 0.25, 0), 0x1d1b24, 0.18, variant),
          paint(new THREE.IcosahedronGeometry(0.18, 0).translate(0.5, 0.55, 0.3), 0xd9c63a, 0.1), // sulfur crust
          paint(new THREE.IcosahedronGeometry(0.14, 0).translate(-0.4, 0.4, -0.45), 0xd9c63a, 0.1),
        ]);
      case 'crystal': {
        const parts = [paint(wobble(new THREE.IcosahedronGeometry(0.6, 0), 0.3, variant).scale(1.2, 0.5, 1.2), 0x77736d, 0.1)];
        for (let k = 0; k < 6; k++) {
          const a = k * 1.05 + variant, tilt = 0.25 + (k % 3) * 0.15, len = 0.9 + (k % 3) * 0.45;
          parts.push(paint(new THREE.ConeGeometry(0.16, len, 5).translate(0, len / 2, 0).rotateZ(tilt).rotateY(a).translate(0, 0.15, 0), k % 2 ? 0xbfe8ff : 0xd9c2ff, 0.12, k));
        }
        return merge(parts);
      }
      case 'oil_rock':
        return merge([
          paint(wobble(new THREE.IcosahedronGeometry(0.85, 1), 0.3, variant + 9).scale(1, 0.6, 1), 0x2a2622, 0.15, variant),
          paint(new THREE.CircleGeometry(1.1, 7).rotateX(-Math.PI / 2).translate(0, 0.03, 0), 0x14110f, 0.05), // tar pool
        ]);
      case 'shell_bed': {
        const parts: THREE.BufferGeometry[] = [];
        for (let k = 0; k < 7; k++) {
          const a = k * 0.9 + variant, r = 0.2 + (k % 3) * 0.25;
          parts.push(paint(new THREE.SphereGeometry(0.16, 6, 3, 0, Math.PI * 2, 0, Math.PI / 2).scale(1.3, 0.6, 1).rotateY(a)
            .translate(Math.cos(a) * r, 0.02, Math.sin(a) * r), k % 3 ? 0xe9d9c4 : 0xc98f7a, 0.1, k));
        }
        return merge(parts);
      }
      case 'salt_deposit':
        return merge([
          paint(wobble(new THREE.IcosahedronGeometry(0.6, 0), 0.4, variant).scale(1.4, 0.35, 1.1), 0xf3f1ea, 0.08),
          paint(new THREE.OctahedronGeometry(0.2, 0).translate(0.35, 0.22, 0.1), 0xffffff, 0.05),
          paint(new THREE.OctahedronGeometry(0.15, 0).translate(-0.3, 0.18, -0.2), 0xffffff, 0.05),
        ]);
      case 'rare_flower': {
        const parts = [paint(new THREE.CylinderGeometry(0.02, 0.025, 0.5, 4).translate(0, 0.25, 0), 0x3f7a2c)];
        for (let k = 0; k < 5; k++) {
          const a = (k / 5) * Math.PI * 2;
          parts.push(paint(new THREE.SphereGeometry(0.09, 4, 2).scale(1, 0.35, 1.8).translate(0, 0, 0.1).rotateY(a).translate(0, 0.52, 0), variant % 2 ? 0xe04f9a : 0x8f5ce6, 0.05, k));
        }
        parts.push(paint(new THREE.IcosahedronGeometry(0.05, 0).translate(0, 0.55, 0), 0xf2d64b, 0));
        return merge(parts);
      }
      case 'fish_shoal': {
        const parts: THREE.BufferGeometry[] = [];
        for (let k = 0; k < 6; k++) {
          const a = k * 1.1, r = 0.4 + (k % 2) * 0.5;
          parts.push(paint(new THREE.ConeGeometry(0.08, 0.38, 4).rotateX(Math.PI / 2).rotateY(a + Math.PI / 2)
            .translate(Math.cos(a) * r, -0.25 - (k % 3) * 0.12, Math.sin(a) * r), 0x8fa6b8, 0.1, k));
        }
        parts.push(paint(new THREE.RingGeometry(0.9, 1.15, 10).rotateX(-Math.PI / 2).translate(0, 0.02, 0), 0xd5f2f5, 0.05)); // ripples
        return merge(parts);
      }
      case 'fiber_plant': {
        const blades: THREE.BufferGeometry[] = [];
        for (let i = 0; i < 5; i++) {
          blades.push(
            paint(new THREE.ConeGeometry(0.06, 0.9, 3).rotateZ((i - 2) * 0.25).rotateY(i * 1.3).translate(0, 0.45, 0), 0x8fae4a, 0.1, i),
          );
        }
        return merge(blades);
      }
      case 'grass_tuft':
        return merge([0, 1, 2].map((i) => paint(new THREE.ConeGeometry(0.05, 0.4, 3).rotateZ((i - 1) * 0.35).translate(0, 0.2, 0), 0x5f9a40, 0.15, i)));
      case 'log':
        return merge([paint(new THREE.CylinderGeometry(0.25, 0.25, 2.4, 6).rotateZ(Math.PI / 2).translate(0, 0.25, 0), 0x5a3d25)]);
      case 'mushroom':
        return merge([
          paint(new THREE.CylinderGeometry(0.05, 0.06, 0.25, 5).translate(0, 0.12, 0), 0xe8e0cc),
          paint(new THREE.ConeGeometry(0.18, 0.14, 7).translate(0, 0.3, 0), 0xc23b2b),
          paint(new THREE.IcosahedronGeometry(0.03, 0).translate(0.08, 0.33, 0.05), 0xffffff, 0),
          paint(new THREE.IcosahedronGeometry(0.03, 0).translate(-0.07, 0.34, -0.04), 0xffffff, 0),
          paint(new THREE.CylinderGeometry(0.035, 0.04, 0.16, 5).translate(0.16, 0.08, 0.1), 0xe8e0cc),
          paint(new THREE.ConeGeometry(0.11, 0.09, 6).translate(0.16, 0.2, 0.1), 0xc23b2b),
        ]);
      case 'carcass':
        return merge([paint(new THREE.BoxGeometry(1.1, 0.35, 0.5).translate(0, 0.18, 0), 0x6e4a3a)]);
      case 'water_source':
        return merge([paint(new THREE.CircleGeometry(1, 6).rotateX(-Math.PI / 2), 0x3a7ca5)]);
    }
  });
}

// ---------------------------------------------------------------------------
// Trees, at real-world scale (see world/TreeSpecies.ts for heights/trunks).
// A tree's prop variant = species × 4 + shape. Conifers (fir, spruce,
// redwood) are stacks of drooping whorls; pines have a bare trunk and a high
// clumpy crown; oaks and birches are broadleaves made of faceted blobs; palms
// lean, with drooping fronds.
// ---------------------------------------------------------------------------

interface ConiferSpec {
  H: number; trunk: number; bark: number; crownBase: number; crownR: number; tiers: number; dark: number; light: number;
}

const FIR_VARIANTS = [
  { crownBase: 2.4, crownR: 2.7, tiers: 11, dark: 0x1e472b, light: 0x2f6a3a },
  { crownBase: 3.0, crownR: 2.4, tiers: 12, dark: 0x1b4030, light: 0x2c5f3f }, // blue-green spruce-like
  { crownBase: 2.0, crownR: 2.9, tiers: 10, dark: 0x22502c, light: 0x36763c },
  { crownBase: 3.4, crownR: 2.2, tiers: 13, dark: 0x1c432a, light: 0x2a5c36 },
] as const;

function conifer(v: ConiferSpec, seed: number, low: boolean): THREE.BufferGeometry {
  const { H } = v;
  const segs = low ? 6 : 8;
  const tiers = low ? Math.max(4, Math.round(v.tiers / 3)) : v.tiers;
  const parts: THREE.BufferGeometry[] = [
    paint(new THREE.CylinderGeometry(0.05, v.trunk, H * 0.92, low ? 5 : 8).translate(0, H * 0.46, 0), v.bark, 0.06, seed),
  ];
  if (!low) parts.push(paint(new THREE.CylinderGeometry(v.trunk, v.trunk * 1.55, 0.45, 8).translate(0, 0.22, 0), v.bark, 0.06)); // root flare
  const top = H - 1.6;
  const coneH = ((H - v.crownBase) / tiers) * 2.1; // each whorl overlaps the next two
  const dark = new THREE.Color(v.dark), light = new THREE.Color(v.light), c = new THREE.Color();
  for (let k = 0; k < tiers; k++) {
    const t = k / (tiers - 1); // 0 = lowest whorl, 1 = top
    const y = v.crownBase + (top - coneH * 0.6 - v.crownBase) * t;
    const r = v.crownR * Math.pow(1 - t * 0.9, 1.1) + 0.25;
    c.copy(dark).lerp(light, t * 0.8); // fresh growth is lighter near the top
    let cone: THREE.BufferGeometry = new THREE.ConeGeometry(r, coneH, segs, 1).rotateY(pseudo(seed * 31 + k) * Math.PI * 2);
    if (!low) cone = wobble(cone, 0.12, seed * 7 + k);
    parts.push(paint(cone.translate(0, y + coneH / 2, 0), c.getHex(), 0.09, k + seed * 5));
  }
  parts.push(paint(new THREE.ConeGeometry(0.3, 1.8, segs).translate(0, H - 0.9, 0), v.light, 0.05)); // leader
  return liftUndersides(merge(parts), 1.9);
}

/** Faceted leaf blob for broadleaf crowns. */
function blob(r: number, x: number, y: number, z: number, color: number, seed: number, low: boolean): THREE.BufferGeometry {
  return paint(wobble(new THREE.IcosahedronGeometry(r, low ? 0 : 1), 0.28, seed).scale(1, 0.82, 1).translate(x, y, z), color, 0.1, seed);
}

/** Tapered branch from (0,y0,0) out to (x,y1,z). */
function branch(x: number, y0: number, y1: number, z: number, r: number, color: number): THREE.BufferGeometry {
  const len = Math.hypot(x, y1 - y0, z);
  const g = new THREE.CylinderGeometry(r * 0.5, r, len, 5).translate(0, len / 2, 0);
  const dir = new THREE.Vector3(x, y1 - y0, z).normalize();
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
  return paint(g.translate(0, y0, 0), color, 0.06);
}

function pine(shape: number, low: boolean): THREE.BufferGeometry {
  const H = TREE_SPECIES[SPECIES.pine]!.height, R = TREE_SPECIES[SPECIES.pine]!.trunk;
  const bark = 0x8a5236;
  const parts: THREE.BufferGeometry[] = [
    paint(new THREE.CylinderGeometry(0.08, R, H * 0.9, low ? 5 : 7).translate(0, H * 0.45, 0), bark, 0.08, shape),
  ];
  const clumps = low ? 4 : 7;
  for (let k = 0; k < clumps; k++) {
    const a = (k / clumps) * Math.PI * 2 + shape;
    const t = k / clumps;
    const y = H * (0.62 + 0.3 * t), out = 1.4 + 1.2 * (1 - t) + pseudo(k + shape * 9) * 0.6;
    const x = Math.cos(a) * out, z = Math.sin(a) * out;
    if (!low) parts.push(branch(x * 0.85, y - 1.1, y - 0.2, z * 0.85, 0.09, bark));
    parts.push(paint(wobble(new THREE.IcosahedronGeometry(1.5 - t * 0.5, low ? 0 : 1), 0.25, k + shape).scale(1.25, 0.55, 1.25).translate(x, y, z),
      k % 2 ? 0x2f5a2c : 0x3a6a33, 0.1, k));
  }
  parts.push(paint(wobble(new THREE.IcosahedronGeometry(1.3, low ? 0 : 1), 0.25, 99 + shape).scale(1.1, 0.7, 1.1).translate(0, H * 0.97, 0), 0x3f7136, 0.1));
  return liftUndersides(merge(parts), 1.6);
}

function oak(shape: number, low: boolean): THREE.BufferGeometry {
  const H = TREE_SPECIES[SPECIES.oak]!.height, R = TREE_SPECIES[SPECIES.oak]!.trunk;
  const bark = 0x5b4632;
  const parts: THREE.BufferGeometry[] = [
    paint(new THREE.CylinderGeometry(R * 0.6, R, H * 0.5, low ? 5 : 8).translate(0, H * 0.25, 0), bark, 0.08, shape),
  ];
  if (!low) {
    parts.push(paint(new THREE.CylinderGeometry(R, R * 1.5, 0.5, 8).translate(0, 0.25, 0), bark, 0.06));
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + shape;
      parts.push(branch(Math.cos(a) * 2.2, H * 0.45, H * 0.68, Math.sin(a) * 2.2, R * 0.45, bark));
    }
  }
  const greens = [0x3c6e2c, 0x4a7d32, 0x355f27];
  const n = low ? 4 : 8;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + shape * 0.7;
    const ring = k % 2 ? 2.6 : 1.6;
    parts.push(blob(2.2 + pseudo(k + shape) * 0.8, Math.cos(a) * ring, H * 0.7 + (k % 3) * 0.6, Math.sin(a) * ring, greens[k % 3]!, k + shape * 11, low));
  }
  parts.push(blob(2.6, 0, H * 0.86, 0, 0x4a7d32, 77 + shape, low));
  return liftUndersides(merge(parts), 1.7);
}

function birch(shape: number, low: boolean): THREE.BufferGeometry {
  const H = TREE_SPECIES[SPECIES.birch]!.height, R = TREE_SPECIES[SPECIES.birch]!.trunk;
  const parts: THREE.BufferGeometry[] = [
    paint(new THREE.CylinderGeometry(0.06, R, H * 0.95, low ? 5 : 7).translate(0, H * 0.475, 0), 0xe8e4da, 0.04, shape),
  ];
  if (!low) {
    // Dark lenticel bands on the white bark.
    for (let k = 0; k < 7; k++) {
      const y = 0.8 + k * 1.3 + pseudo(k + shape) * 0.4;
      const r = R * (1 - y / H) + 0.07;
      parts.push(paint(new THREE.CylinderGeometry(r + 0.012, r + 0.012, 0.12, 7).translate(0, y, 0), 0x2b2a28, 0.05));
    }
  }
  const n = low ? 3 : 7;
  for (let k = 0; k < n; k++) {
    const t = k / n, a = k * 2.4 + shape;
    parts.push(blob(1.3 + (1 - t) * 0.5, Math.cos(a) * 1.0, H * (0.5 + 0.45 * t), Math.sin(a) * 1.0, k % 2 ? 0x8fae3e : 0x7ea236, k + shape * 13, low));
  }
  return liftUndersides(merge(parts), 1.5);
}

function palm(shape: number, low: boolean): THREE.BufferGeometry {
  const H = TREE_SPECIES[SPECIES.palm]!.height, R = TREE_SPECIES[SPECIES.palm]!.trunk;
  const parts: THREE.BufferGeometry[] = [];
  // Leaning, slightly curved trunk made of ringed segments.
  const segs = low ? 4 : 9;
  const lean = 0.18 + shape * 0.08;
  let px = 0, py = 0;
  for (let k = 0; k < segs; k++) {
    const t = k / segs, len = H / segs;
    const ang = lean * (0.4 + t); // bends more toward the top
    const r0 = R * (1 - t * 0.35), r1 = R * (1 - (t + 1 / segs) * 0.35);
    const g = new THREE.CylinderGeometry(r1, r0 * 1.05, len, 6).translate(0, len / 2, 0).rotateZ(-ang).translate(px, py, 0);
    parts.push(paint(g, k % 2 ? 0x8c7350 : 0x7a6244, 0.06, k));
    px += Math.sin(ang) * len;
    py += Math.cos(ang) * len;
  }
  // Fronds: long flattened leaves drooping from the crown.
  const fronds = low ? 5 : 9;
  for (let k = 0; k < fronds; k++) {
    const a = (k / fronds) * Math.PI * 2 + shape;
    const leaf = new THREE.ConeGeometry(0.45, 4.2, 4, 1).scale(1, 1, 0.18).translate(0, 2.1, 0)
      .rotateZ(-1.15 - pseudo(k + shape) * 0.35).rotateY(a).translate(px, py - 0.1, 0);
    parts.push(paint(leaf, k % 2 ? 0x4d8a34 : 0x3f7a2c, 0.1, k));
  }
  if (!low) for (let k = 0; k < 3; k++) parts.push(paint(new THREE.IcosahedronGeometry(0.17, 0).translate(px + Math.cos(k * 2.1) * 0.3, py - 0.35, Math.sin(k * 2.1) * 0.3), 0x5a4026, 0.05)); // coconuts
  return liftUndersides(merge(parts), 1.6);
}

function treeGeometry(variant: number, low: boolean): THREE.BufferGeometry {
  const v = treeShape(variant);
  return cached(`tree:${v}:${low ? 'low' : 'high'}`, () => {
    const sp = treeSpecies(v), shape = v % 4;
    const S = TREE_SPECIES[sp]!;
    switch (sp) {
      case SPECIES.spruce:
        return conifer({ H: S.height, trunk: S.trunk, bark: 0x4f3d2e, crownBase: 1.6 + shape, crownR: 2.2 - shape * 0.2, tiers: 15, dark: 0x183a35, light: 0x2c5a50 }, v, low);
      case SPECIES.redwood:
        return conifer({ H: S.height, trunk: S.trunk, bark: 0x8b4a30, crownBase: S.height * 0.42, crownR: 4 - shape * 0.4, tiers: 12, dark: 0x1f4426, light: 0x335f33 }, v, low);
      case SPECIES.pine: return pine(shape, low);
      case SPECIES.oak: return oak(shape, low);
      case SPECIES.birch: return birch(shape, low);
      case SPECIES.palm: return palm(shape, low);
      default: {
        const f = FIR_VARIANTS[shape % FIR_VARIANTS.length]!;
        return conifer({ H: S.height, trunk: S.trunk, bark: 0x5e4532, ...f }, shape, low);
      }
    }
  });
}

/**
 * Downward-facing triangles (the underside of each whorl) only receive the
 * hemisphere's dim ground light, so under a dense canopy they render almost
 * black. Brighten their vertex colour to fake light filtering through the
 * needles.
 */
function liftUndersides(g: THREE.BufferGeometry, factor: number): THREE.BufferGeometry {
  const n = g.attributes['normal']!, c = g.attributes['color']!;
  for (let i = 0; i < n.count; i++) {
    if (n.getY(i) < -0.6) c.setXYZ(i, Math.min(1, c.getX(i) * factor), Math.min(1, c.getY(i) * factor), Math.min(1, c.getZ(i) * factor));
  }
  return g;
}

/** Distant-LOD tree: same silhouette, far fewer triangles. */
export function firLowGeometry(variant: number): THREE.BufferGeometry {
  return treeGeometry(variant, true);
}

export function campfireObject(): THREE.Group {
  const g = new THREE.Group();
  const stones: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    stones.push(paint(new THREE.DodecahedronGeometry(0.18, 0).translate(Math.cos(a) * 0.55, 0.1, Math.sin(a) * 0.55), 0x77736d, 0.1, i));
  }
  stones.push(paint(new THREE.CylinderGeometry(0.07, 0.07, 0.9, 5).rotateZ(1.1).translate(0, 0.25, 0), 0x5a3d25));
  stones.push(paint(new THREE.CylinderGeometry(0.07, 0.07, 0.9, 5).rotateZ(-1.1).translate(0, 0.25, 0), 0x5a3d25));
  const base = new THREE.Mesh(merge(stones), flatMaterial);
  base.castShadow = true;
  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(0.3, 0.8, 5).translate(0, 0.55, 0),
    new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.9 }),
  );
  flame.name = 'flame';
  const light = new THREE.PointLight(0xff8a3c, 6, 14, 1.6);
  light.position.y = 1;
  light.name = 'firelight';
  g.add(base, flame, light);
  return g;
}

export function leanToObject(): THREE.Mesh {
  const parts = [
    paint(new THREE.BoxGeometry(3, 0.08, 2.6).rotateX(-0.9).translate(0, 1.05, -0.2), 0x6b4a2f, 0.15),
    paint(new THREE.CylinderGeometry(0.06, 0.06, 2.2, 5).translate(-1.4, 1.1, 0.6), 0x5a3d25),
    paint(new THREE.CylinderGeometry(0.06, 0.06, 2.2, 5).translate(1.4, 1.1, 0.6), 0x5a3d25),
  ];
  const m = new THREE.Mesh(merge(parts), flatMaterial);
  m.castShadow = m.receiveShadow = true;
  return m;
}

// ---------------------------------------------------------------------------
// Placed structures. Origin at the base centre; the front (lid, fire mouth)
// faces +Z, i.e. toward the player who placed it.
// ---------------------------------------------------------------------------

function box(w: number, h: number, d: number, x: number, y: number, z: number, color: number, j = 0.06, seed = 1): THREE.BufferGeometry {
  return paint(new THREE.BoxGeometry(w, h, d).translate(x, y, z), color, j, seed);
}

function chest(w: number, h: number, d: number): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const n = 4;
  for (let k = 0; k < n; k++) parts.push(box(w, h * 0.7 / n - 0.01, d, 0, (k + 0.5) * (h * 0.7 / n), 0, PLANK[k % 3]!, 0.05, k)); // planks
  parts.push(box(w + 0.04, h * 0.3, d + 0.04, 0, h * 0.85, 0, 0x7a5636, 0.05, 9)); // lid
  for (const x of [-w / 2 + 0.08, w / 2 - 0.08]) parts.push(box(0.05, h + 0.02, d + 0.06, x, h / 2, 0, 0x55595e, 0.08)); // iron bands
  parts.push(box(0.12, 0.14, 0.04, 0, h * 0.68, d / 2 + 0.03, 0x8b8f94, 0.05)); // latch
  return parts;
}

function flameMesh(r: number, h: number, y: number): THREE.Mesh {
  const f = new THREE.Mesh(new THREE.ConeGeometry(r, h, 5).translate(0, y, 0), new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.9 }));
  f.name = 'flame';
  return f;
}

export function structureObject(kind: string): THREE.Object3D {
  const mesh = (g: THREE.BufferGeometry): THREE.Mesh => {
    const m = new THREE.Mesh(g, flatMaterial);
    m.castShadow = m.receiveShadow = true;
    return m;
  };
  switch (kind) {
    case 'campfire': return campfireObject();
    case 'lean_to': return leanToObject();
    case 'storage_box': return mesh(cached('st:box', () => merge(chest(1, 0.6, 0.7))));
    case 'large_storage_box': return mesh(cached('st:lbox', () => merge(chest(1.5, 0.85, 0.9))));
    case 'mortar_pestle': return mesh(cached('st:mortar', () => merge([
      paint(new THREE.CylinderGeometry(0.3, 0.22, 0.35, 8).translate(0, 0.175, 0), 0x8a8780, 0.1),
      paint(new THREE.CylinderGeometry(0.22, 0.22, 0.02, 8).translate(0, 0.351, 0), 0x3c3a36, 0.05),
      paint(new THREE.CylinderGeometry(0.05, 0.07, 0.5, 6).rotateZ(0.5).translate(0.12, 0.45, 0), 0x9a958c, 0.08),
      box(0.8, 0.1, 0.6, 0, -0.04, 0, 0x6b4a2f), // base slab
    ])));
    case 'smithy': return mesh(cached('st:smithy', () => merge([
      box(1.5, 0.08, 0.8, 0, 0.82, 0, 0x7a5636), // workbench top
      ...[[-0.65, -0.32], [0.65, -0.32], [-0.65, 0.32], [0.65, 0.32]].map(([x, z]) => box(0.09, 0.8, 0.09, x!, 0.4, z!, 0x5a3d25)),
      paint(new THREE.CylinderGeometry(0.22, 0.25, 0.5, 8).translate(0.95, 0.25, 0.35), 0x6e4e30), // anvil stump
      box(0.42, 0.12, 0.16, 0.95, 0.56, 0.35, 0x45484d, 0.05), // anvil
      paint(new THREE.ConeGeometry(0.08, 0.2, 4).rotateZ(Math.PI / 2).translate(1.26, 0.58, 0.35), 0x45484d, 0.05), // horn
      box(0.32, 0.05, 0.05, -0.3, 0.9, 0.1, 0x5a3d25), box(0.08, 0.08, 0.12, -0.12, 0.9, 0.1, 0x55595e), // hammer
      box(0.5, 0.25, 0.3, 0.3, 0.98, -0.15, 0x8b8f94, 0.08), // ingots
    ])));
    case 'refining_forge': {
      const g = new THREE.Group();
      const parts: THREE.BufferGeometry[] = [];
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2;
        for (let l = 0; l < 3; l++) parts.push(paint(new THREE.DodecahedronGeometry(0.22, 0).translate(Math.cos(a + l * 0.3) * 0.55, 0.18 + l * 0.33, Math.sin(a + l * 0.3) * 0.55), 0x77736d, 0.12, k * 3 + l));
      }
      parts.push(paint(new THREE.CylinderGeometry(0.35, 0.62, 0.5, 8).translate(0, 1.15, 0), 0x6d6a66, 0.1)); // dome
      parts.push(paint(new THREE.CylinderGeometry(0.16, 0.2, 0.8, 6).translate(0, 1.75, 0), 0x5e5b57, 0.1)); // chimney
      parts.push(box(0.5, 0.45, 0.3, 0, 0.35, 0.5, 0x221a14, 0.05)); // fire mouth
      g.add(mesh(merge(parts)), flameMesh(0.18, 0.4, 0.4).translateZ(0.42));
      return g;
    }
    case 'cooking_pot': {
      const g = new THREE.Group();
      const parts: THREE.BufferGeometry[] = [];
      for (let k = 0; k < 7; k++) {
        const a = (k / 7) * Math.PI * 2;
        parts.push(paint(new THREE.DodecahedronGeometry(0.15, 0).translate(Math.cos(a) * 0.5, 0.08, Math.sin(a) * 0.5), 0x77736d, 0.1, k));
      }
      parts.push(paint(new THREE.SphereGeometry(0.36, 9, 6, 0, Math.PI * 2, Math.PI * 0.35, Math.PI * 0.65).translate(0, 0.62, 0), 0x3a3936, 0.06)); // pot
      parts.push(paint(new THREE.TorusGeometry(0.3, 0.03, 4, 10).rotateX(Math.PI / 2).translate(0, 0.79, 0), 0x2c2b29, 0.05));
      for (let k = 0; k < 3; k++) { // tripod
        const a = (k / 3) * Math.PI * 2;
        parts.push(paint(new THREE.CylinderGeometry(0.035, 0.035, 1.5, 5).translate(0, 0.75, 0).rotateZ(0.35).rotateY(a).translate(Math.cos(a) * 0.32, 0, Math.sin(a) * 0.32), 0x5a3d25));
      }
      parts.push(paint(new THREE.CircleGeometry(0.28, 7).rotateX(-Math.PI / 2).translate(0, 0.75, 0), 0x7d5a2e, 0.05)); // stew
      g.add(mesh(merge(parts)), flameMesh(0.22, 0.45, 0.25));
      return g;
    }
    case 'preserving_bin': return mesh(cached('st:bin', () => merge([
      ...chest(1, 0.9, 0.8).map((x) => x),
      box(0.3, 0.05, 0.05, 0, 0.5, 0.42, 0x8b8f94), // handle
      paint(new THREE.CylinderGeometry(0.06, 0.06, 0.18, 6).translate(0.3, 1.0, 0), 0xe8e4da), // salt jar
    ])));
    case 'fabricator': return mesh(cached('st:fab', () => merge([
      box(1.4, 1.1, 0.9, 0, 0.55, 0, 0x6e737a, 0.04),
      box(1.2, 0.5, 0.05, 0, 0.75, 0.46, 0x2a2e33, 0.03), // window
      box(0.25, 0.1, 0.05, -0.45, 0.25, 0.46, 0x5ccf6b, 0), // status light
      box(0.25, 0.1, 0.05, 0.45, 0.25, 0.46, 0xe0a030, 0),
      box(1.45, 0.1, 0.95, 0, 1.15, 0, 0x55595e, 0.04),
      paint(new THREE.CylinderGeometry(0.08, 0.08, 0.5, 6).translate(0.5, 1.45, -0.2), 0x55595e), // exhaust
    ])));
    default: return mesh(cached('st:unknown', () => merge([box(0.6, 0.6, 0.6, 0, 0.3, 0, 0x9a8a6a)])));
  }
}

// ---------------------------------------------------------------------------
// Tools. Built in "hand space": grip at the origin, tool pointing up +Y,
// real-world sizes in metres (ViewModel scales the whole hand to fit the view).
// ---------------------------------------------------------------------------

const WOOD = 0x8a6440;
const WOOD_DARK = 0x6e4e30;
const LEATHER = 0x4a3020;
const FIBER = 0xc2a66a;
const FLINT = 0x7f8289;

/** Slightly tapered wooden shaft, bottom at y = −0.12. */
function shaft(len: number, rBottom: number, rTop: number): THREE.BufferGeometry {
  return paint(new THREE.CylinderGeometry(rTop, rBottom, len, 7).translate(0, len / 2 - 0.12, 0), WOOD, 0.08);
}
/** Leather grip wrap where the hand holds the shaft. */
function grip(r: number): THREE.BufferGeometry[] {
  return [
    paint(new THREE.CylinderGeometry(r + 0.007, r + 0.007, 0.17, 7).translate(0, 0, 0), LEATHER, 0.06),
    paint(new THREE.TorusGeometry(r + 0.008, 0.006, 3, 8).rotateX(Math.PI / 2).translate(0, 0.085, 0), WOOD_DARK, 0),
    paint(new THREE.TorusGeometry(r + 0.008, 0.006, 3, 8).rotateX(Math.PI / 2).translate(0, -0.085, 0), WOOD_DARK, 0),
  ];
}
/** Plant-fiber lashing: two crossing loops binding a head to the shaft at height y. */
function lashing(y: number, r: number): THREE.BufferGeometry[] {
  return [
    paint(new THREE.TorusGeometry(r + 0.012, 0.009, 4, 9).rotateX(Math.PI / 2).translate(0, y - 0.03, 0), FIBER, 0.05),
    paint(new THREE.TorusGeometry(r + 0.012, 0.009, 4, 9).rotateX(Math.PI / 2).translate(0, y + 0.03, 0), FIBER, 0.05),
    paint(new THREE.TorusGeometry(0.05, 0.008, 4, 9).rotateZ(Math.PI / 4).translate(0, y, 0), FIBER, 0.05),
  ];
}
/** Knapped flint: flat-shaded facets with an irregular, chipped surface. */
function knapped(g: THREE.BufferGeometry, seed: number, color = FLINT): THREE.BufferGeometry {
  return paint(wobble(g, 0.18, seed), color, 0.16, seed);
}

function axeParts(): THREE.BufferGeometry[] {
  const blade = new THREE.Shape();
  blade.moveTo(-0.035, -0.04);
  blade.lineTo(0.12, -0.085);
  blade.quadraticCurveTo(0.205, 0, 0.12, 0.085); // curved cutting edge
  blade.lineTo(-0.035, 0.04);
  blade.lineTo(-0.06, 0);
  const head = new THREE.ExtrudeGeometry(blade, { depth: 0.045, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.008, bevelSegments: 1 })
    .translate(0, 0, -0.0225);
  return [shaft(0.62, 0.024, 0.02), ...grip(0.024), knapped(head, 3).translate(0.01, 0.42, 0), ...lashing(0.42, 0.021)];
}

function pickaxeParts(): THREE.BufferGeometry[] {
  // Two curved prongs drooping slightly from a central block.
  const prong = (dir: 1 | -1): THREE.BufferGeometry =>
    knapped(new THREE.ConeGeometry(0.032, 0.22, 5).rotateZ(-dir * (Math.PI / 2 - 0.28)).translate(dir * 0.115, -0.03, 0), dir === 1 ? 5 : 6, 0x74777d);
  const hub = knapped(new THREE.BoxGeometry(0.075, 0.07, 0.06), 7, 0x6b6e74);
  return [shaft(0.64, 0.025, 0.021), ...grip(0.025), ...[prong(1), prong(-1), hub].map((g) => g.translate(0, 0.45, 0)), ...lashing(0.45, 0.022)];
}

function spearParts(): THREE.BufferGeometry[] {
  // Leaf-shaped flint point on a long ash shaft.
  const point = knapped(new THREE.OctahedronGeometry(0.05, 0).scale(1, 3.4, 0.42), 9).translate(0, 1.2, 0);
  return [
    shaft(1.3, 0.021, 0.016), ...grip(0.021), point,
    paint(new THREE.CylinderGeometry(0.022, 0.02, 0.07, 7).translate(0, 1.04, 0), FIBER, 0.05), // binding
    paint(new THREE.TorusGeometry(0.024, 0.007, 3, 8).rotateX(Math.PI / 2).translate(0, 1.0, 0), WOOD_DARK, 0),
  ];
}

function torchParts(): THREE.BufferGeometry[] {
  return [
    shaft(0.52, 0.024, 0.03), ...grip(0.024),
    // Resin-soaked cloth wrapped around the head, charred at the top.
    paint(new THREE.CylinderGeometry(0.05, 0.042, 0.13, 7).translate(0, 0.43, 0), 0x3b2a1e, 0.12),
    paint(new THREE.CylinderGeometry(0.044, 0.05, 0.03, 7).translate(0, 0.505, 0), 0x1d1612, 0.1),
    paint(new THREE.TorusGeometry(0.051, 0.007, 3, 8).rotateX(Math.PI / 2).translate(0, 0.39, 0), FIBER, 0),
    paint(new THREE.TorusGeometry(0.051, 0.007, 3, 8).rotateX(Math.PI / 2).translate(0, 0.46, 0), FIBER, 0),
    paint(new THREE.OctahedronGeometry(0.03, 0).translate(0.012, 0.525, 0.01), 0xff7a20, 0), // embers
  ];
}

const METAL = 0xb7bcc2;
const METAL_DARK = 0x7d8288;

function metalHatchetParts(): THREE.BufferGeometry[] {
  const blade = new THREE.Shape();
  blade.moveTo(-0.03, -0.035);
  blade.lineTo(0.1, -0.1);
  blade.quadraticCurveTo(0.2, 0, 0.1, 0.1);
  blade.lineTo(-0.03, 0.035);
  const head = new THREE.ExtrudeGeometry(blade, { depth: 0.02, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 1 }).translate(0, 0, -0.01);
  return [shaft(0.62, 0.024, 0.02), ...grip(0.024), paint(head, METAL, 0.05).translate(0.01, 0.44, 0),
    paint(new THREE.BoxGeometry(0.06, 0.07, 0.05).translate(-0.01, 0.44, 0), METAL_DARK, 0.05)];
}

function metalPickParts(): THREE.BufferGeometry[] {
  const prong = (dir: 1 | -1): THREE.BufferGeometry =>
    paint(new THREE.ConeGeometry(0.022, 0.26, 4).rotateZ(-dir * (Math.PI / 2 - 0.22)).translate(dir * 0.13, -0.02, 0), METAL, 0.06);
  return [shaft(0.64, 0.025, 0.021), ...grip(0.025), ...[prong(1), prong(-1), paint(new THREE.BoxGeometry(0.06, 0.06, 0.05), METAL_DARK, 0.05)].map((g) => g.translate(0, 0.46, 0))];
}

function sickleParts(): THREE.BufferGeometry[] {
  const blade = paint(new THREE.TorusGeometry(0.13, 0.012, 3, 12, Math.PI * 1.1).scale(1, 1, 0.4).rotateZ(-0.2).translate(0.12, 0.3, 0), METAL, 0.05);
  return [shaft(0.34, 0.022, 0.02), ...grip(0.022), blade];
}

function pikeParts(): THREE.BufferGeometry[] {
  return [
    shaft(1.4, 0.022, 0.017), ...grip(0.022),
    paint(new THREE.OctahedronGeometry(0.045, 0).scale(1, 4.2, 0.35).translate(0, 1.42, 0), METAL, 0.05),
    paint(new THREE.CylinderGeometry(0.024, 0.02, 0.1, 7).translate(0, 1.22, 0), METAL_DARK, 0.04),
  ];
}

function clubParts(): THREE.BufferGeometry[] {
  return [paint(new THREE.CylinderGeometry(0.055, 0.024, 0.62, 7).translate(0, 0.19, 0), WOOD_DARK, 0.1), ...grip(0.025),
    paint(wobble(new THREE.IcosahedronGeometry(0.06, 0), 0.3, 4).translate(0.03, 0.42, 0.02), WOOD_DARK, 0.1)];
}

function swordParts(): THREE.BufferGeometry[] {
  return [
    ...grip(0.02),
    paint(new THREE.BoxGeometry(0.16, 0.025, 0.035).translate(0, 0.1, 0), METAL_DARK, 0.04), // guard
    paint(new THREE.BoxGeometry(0.045, 0.62, 0.008).translate(0, 0.42, 0), METAL, 0.03), // blade
    paint(new THREE.ConeGeometry(0.032, 0.08, 4).scale(1, 1, 0.2).translate(0, 0.77, 0), METAL, 0.03), // tip
    paint(new THREE.IcosahedronGeometry(0.025, 0).translate(0, -0.1, 0), METAL_DARK, 0.03), // pommel
  ];
}

function bowParts(): THREE.BufferGeometry[] {
  return [
    paint(new THREE.TorusGeometry(0.45, 0.014, 4, 14, Math.PI * 0.75).rotateZ(Math.PI * 0.625).translate(0.36, 0, 0), WOOD, 0.08), // limbs
    paint(new THREE.CylinderGeometry(0.003, 0.003, 0.83, 3).translate(0.2, 0, 0), 0xe8e0cc, 0), // string
    ...grip(0.02),
  ];
}

function gpsParts(): THREE.BufferGeometry[] {
  return [paint(new THREE.BoxGeometry(0.07, 0.11, 0.025).translate(0, 0.07, 0), 0x2f3337, 0.04),
    paint(new THREE.BoxGeometry(0.05, 0.05, 0.004).translate(0, 0.09, 0.013), 0x5ccf6b, 0)];
}

/** Arrow in flight: thin shaft along +Z with a flint head and fletching. */
export function arrowGeometry(): THREE.BufferGeometry {
  return cached('arrow', () => merge([
    paint(new THREE.CylinderGeometry(0.008, 0.008, 0.75, 4).rotateX(Math.PI / 2), WOOD, 0.05),
    knapped(new THREE.OctahedronGeometry(0.025, 0).scale(1, 1, 2.2).translate(0, 0, 0.4), 11),
    paint(new THREE.BoxGeometry(0.002, 0.04, 0.1).translate(0, 0.02, -0.32), 0xe9e2c8, 0.05),
    paint(new THREE.BoxGeometry(0.04, 0.002, 0.1).translate(0.02, 0, -0.32), 0xe9e2c8, 0.05),
  ]));
}

/** Thrown spear in the world: same model, lying along +Z and centred. */
export function spearGeometry(): THREE.BufferGeometry {
  return cached('spear', () => merge(spearParts()).translate(0, -0.55, 0).rotateX(Math.PI / 2));
}

/**
 * First-person viewmodel geometry: forearm (sleeve + hand) plus the held
 * item, modelled in hand space (grip at the origin, tool pointing up +Y).
 */
export function viewModelGeometry(item: string | null): THREE.BufferGeometry {
  return cached(`vm:${item ?? 'hand'}`, () => {
    const parts: THREE.BufferGeometry[] = [
      paint(new THREE.CylinderGeometry(0.05, 0.058, 0.3, 7).rotateX(Math.PI / 2).translate(0, -0.03, 0.2), 0x6f5b45, 0.06), // sleeve
      paint(new THREE.BoxGeometry(0.085, 0.085, 0.12).translate(0, -0.02, 0.06), 0xd6a77a, 0.05), // wrist
      paint(new THREE.BoxGeometry(0.1, 0.105, 0.095).translate(0, 0, -0.01), 0xd6a77a, 0.05), // fist
      paint(new THREE.BoxGeometry(0.03, 0.03, 0.06).translate(0.045, 0.04, -0.03), 0xcf9f72, 0.05), // thumb
    ];
    switch (item) {
      case 'stone_axe': parts.push(...axeParts()); break;
      case 'stone_pickaxe': parts.push(...pickaxeParts()); break;
      case 'stone_spear': parts.push(...spearParts()); break;
      case 'torch': parts.push(...torchParts()); break;
      case 'metal_hatchet': parts.push(...metalHatchetParts()); break;
      case 'metal_pick': parts.push(...metalPickParts()); break;
      case 'metal_sickle': parts.push(...sickleParts()); break;
      case 'metal_pike': parts.push(...pikeParts()); break;
      case 'wooden_club': parts.push(...clubParts()); break;
      case 'metal_sword': parts.push(...swordParts()); break;
      case 'bow': parts.push(...bowParts()); break;
      case 'gps': parts.push(...gpsParts()); break;
      case null: break;
      default: parts.push(paint(new THREE.BoxGeometry(0.1, 0.1, 0.1).translate(0, 0.09, 0), 0x9a8a6a));
    }
    return merge(parts);
  });
}

// ---------------------------------------------------------------------------
// Building pieces. Local frame: walls run along +X centred on the origin with
// their bottom at y = 0; floors are centred with their TOP at y = 0.
// ---------------------------------------------------------------------------

const PLANK = [0x8a6440, 0x7a5636, 0x94704a] as const;

function planks(w: number, h: number, d: number, count: number, vertical: boolean, seed: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (let k = 0; k < count; k++) {
    const color = PLANK[(k + seed) % PLANK.length]!;
    if (vertical) {
      const pw = w / count;
      out.push(paint(new THREE.BoxGeometry(pw * 0.96, h, d).translate(-w / 2 + pw * (k + 0.5), 0, 0), color, 0.05, k + seed));
    } else {
      const ph = h / count;
      out.push(paint(new THREE.BoxGeometry(w, ph * 0.94, d).translate(0, -h / 2 + ph * (k + 0.5), 0), color, 0.05, k + seed));
    }
  }
  return out;
}

export function foundationGeometry(height: number): THREE.BufferGeometry {
  const h = Math.max(0.3, Math.round(height * 10) / 10);
  return cached(`b:foundation:${h}`, () => merge([
    paint(new THREE.BoxGeometry(3, h - 0.12, 3).translate(0, -0.12 - (h - 0.12) / 2, 0), 0x8d8a84, 0.08), // stone base
    ...planks(3, 0.12, 3, 6, true, 1).map((g) => g.rotateY(Math.PI / 2).translate(0, -0.06, 0)), // wooden deck
  ]));
}

export function ceilingGeometry(): THREE.BufferGeometry {
  return cached('b:ceiling', () => merge(planks(3, 0.2, 3, 6, true, 2).map((g) => g.translate(0, -0.1, 0))));
}

export function wallGeometry(): THREE.BufferGeometry {
  return cached('b:wall', () => merge([
    ...planks(3, 3, 0.18, 6, false, 0).map((g) => g.translate(0, 1.5, 0)),
    // Corner posts so adjoining walls read as a frame.
    paint(new THREE.BoxGeometry(0.22, 3, 0.26).translate(-1.45, 1.5, 0), 0x5a3d25),
    paint(new THREE.BoxGeometry(0.22, 3, 0.26).translate(1.45, 1.5, 0), 0x5a3d25),
  ]));
}

/** Doorway frame: two 1 m wall sections and a lintel over a 1 × 2.2 m opening. */
export function doorwayGeometry(): THREE.BufferGeometry {
  return cached('b:doorway', () => merge([
    ...planks(1, 3, 0.18, 6, false, 0).map((g) => g.translate(-1, 1.5, 0)),
    ...planks(1, 3, 0.18, 6, false, 3).map((g) => g.translate(1, 1.5, 0)),
    paint(new THREE.BoxGeometry(1, 0.8, 0.18).translate(0, 2.6, 0), 0x7a5636),
    paint(new THREE.BoxGeometry(0.22, 3, 0.26).translate(-1.45, 1.5, 0), 0x5a3d25),
    paint(new THREE.BoxGeometry(0.22, 3, 0.26).translate(1.45, 1.5, 0), 0x5a3d25),
    paint(new THREE.BoxGeometry(0.12, 2.2, 0.24).translate(-0.5, 1.1, 0), 0x5a3d25),
    paint(new THREE.BoxGeometry(0.12, 2.2, 0.24).translate(0.5, 1.1, 0), 0x5a3d25),
  ]));
}

/** Door leaf with its hinge at the local origin (rotate around Y to open). */
export function doorGeometry(): THREE.BufferGeometry {
  return cached('b:door', () => merge([
    ...planks(0.96, 2.18, 0.08, 4, true, 2).map((g) => g.translate(0.48, 1.09, 0)),
    paint(new THREE.BoxGeometry(0.96, 0.12, 0.1).translate(0.48, 0.5, 0), 0x4a3220),
    paint(new THREE.BoxGeometry(0.96, 0.12, 0.1).translate(0.48, 1.7, 0), 0x4a3220),
    paint(new THREE.BoxGeometry(0.06, 0.06, 0.14).translate(0.85, 1.05, 0), 0x2a2a2a),
  ]));
}

/**
 * Bed: wooden frame, straw mattress, hide blanket, pillow and a headboard.
 * Local frame: length along Z with the headboard at +Z, floor at y = 0,
 * centred on the origin.
 */
export function bedGeometry(): THREE.BufferGeometry {
  return cached('b:bed', () => {
    const W = BED.width, L = BED.length, H = BED.height;
    const parts: THREE.BufferGeometry[] = [];
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      parts.push(paint(new THREE.BoxGeometry(0.1, H - 0.15, 0.1).translate(x * (W / 2 - 0.05), (H - 0.15) / 2, z * (L / 2 - 0.05)), 0x5a3d25)); // legs
    }
    parts.push(
      paint(new THREE.BoxGeometry(0.08, 0.14, L).translate(-W / 2 + 0.04, H - 0.22, 0), 0x6e4e30), // side rails
      paint(new THREE.BoxGeometry(0.08, 0.14, L).translate(W / 2 - 0.04, H - 0.22, 0), 0x6e4e30),
      paint(new THREE.BoxGeometry(W - 0.12, 0.16, L - 0.1).translate(0, H - 0.08, 0), 0xd9c58f, 0.08), // straw mattress
      paint(new THREE.BoxGeometry(W - 0.06, 0.06, L * 0.62).translate(0, H + 0.02, -L * 0.17), 0x8a5a3c, 0.07), // hide blanket
      paint(new THREE.BoxGeometry(W - 0.04, 0.12, 0.05).translate(0, H - 0.04, -L * 0.48), 0x7b4f33, 0.06), // blanket fold
      paint(new THREE.BoxGeometry(W * 0.55, 0.1, 0.32).translate(0, H + 0.03, L / 2 - 0.27), 0xe8e0cc, 0.04), // pillow
      ...planks(W, 0.75, 0.07, 4, true, 1).map((g) => g.translate(0, H + 0.12, L / 2 - 0.035)), // headboard
      paint(new THREE.BoxGeometry(W + 0.04, 0.07, 0.1).translate(0, H + 0.52, L / 2 - 0.035), 0x5a3d25),
    );
    return merge(parts);
  });
}

/** Straight wooden flight climbing toward +Z: 10 solid steps (closed underneath) between two stringers. */
export function stairsGeometry(): THREE.BufferGeometry {
  return cached('stairs', () => {
    const n = STAIRS.steps, run = 3 / n, rise = 3 / n, w = STAIRS.width;
    const parts: THREE.BufferGeometry[] = [];
    for (let k = 0; k < n; k++) {
      const h = (k + 1) * rise;
      parts.push(paint(new THREE.BoxGeometry(w - 0.1, h, run).translate(0, h / 2, -1.5 + (k + 0.5) * run), PLANK[k % 3]!, 0.05, k));
      parts.push(paint(new THREE.BoxGeometry(w - 0.06, 0.04, run + 0.02).translate(0, h + 0.02, -1.5 + (k + 0.5) * run), 0x6e4e30, 0.04, k)); // tread nosing
    }
    for (const x of [-w / 2, w / 2]) {
      const len = Math.hypot(3, 3);
      parts.push(paint(new THREE.BoxGeometry(0.08, 0.32, len).rotateX(-Math.PI / 4).translate(x, 1.5 + 0.08, 0), 0x5a3d25, 0.05)); // stringer
    }
    return merge(parts);
  });
}

// ---------------------------------------------------------------------------
// Caves: a rough rock dome over the chamber carved into the mountain. Local
// frame: origin at the chamber centre on the floor, +Z into the mountain,
// the mouth (open) toward −Z. Drawn double-sided: you see it from inside.
// ---------------------------------------------------------------------------

export const caveMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });

export function caveShellGeometry(length: number, width: number, height: number, seed: number): THREE.BufferGeometry {
  const dome = new THREE.SphereGeometry(1, 18, 9, 0, Math.PI * 2, 0, Math.PI / 2).toNonIndexed();
  dome.scale(width / 2 + 0.9, height, length / 2 + 0.9);
  // Rough, uneven rock: displace by position (shared corners move together).
  const p = dome.attributes['position']!;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 1 + (pseudo(Math.round(x * 3) * 13 + Math.round(y * 3) * 7 + Math.round(z * 3) * 3 + seed) - 0.5) * 0.22;
    p.setXYZ(i, x * k, Math.max(0, y * k - 0.15), z * k);
  }
  // Cut the mouth: drop the triangles at the front, below the arch.
  const keep: number[] = [];
  const mouthZ = -(length / 2) * 0.62;
  for (let tri = 0; tri < p.count / 3; tri++) {
    let front = 0, low = 0;
    for (let k = 0; k < 3; k++) {
      if (p.getZ(tri * 3 + k) < mouthZ) front++;
      if (p.getY(tri * 3 + k) < height * 0.82) low++;
    }
    if (front >= 2 && low >= 1) continue;
    for (let k = 0; k < 9; k++) keep.push(p.array[tri * 9 + k]!);
  }
  const shell = new THREE.BufferGeometry();
  shell.setAttribute('position', new THREE.Float32BufferAttribute(keep, 3));
  shell.computeVertexNormals();
  const parts: THREE.BufferGeometry[] = [paint(shell, 0x5f5a53, 0.18, seed)];
  // Boulders framing the mouth, a lintel, and rubble on the floor.
  const mz = -length / 2 + 0.6;
  for (const [x, y, z, r] of [
    [-width / 2 + 0.6, 0.9, mz, 1.3], [width / 2 - 0.6, 1.1, mz, 1.4], [-width / 2 + 0.3, 2.6, mz + 0.4, 1.1], [width / 2 - 0.2, 2.8, mz + 0.5, 1.0],
    [-1.2, height * 0.86, mz + 0.6, 1.2], [1.4, height * 0.88, mz + 0.8, 1.1], [0, height * 0.95, mz + 1.2, 1.3],
    [-width / 2 + 1.2, 0.3, 1.5, 0.6], [width / 2 - 1.4, 0.25, -1.5, 0.5], [1.5, 0.2, length / 2 - 1.2, 0.7], [-2.5, 0.2, length / 2 - 2.5, 0.5],
  ] as const) {
    parts.push(paint(wobble(new THREE.IcosahedronGeometry(r, 0), 0.35, seed + x * 7 + z).translate(x, y, z), 0x6b665e, 0.15, seed + r * 10));
  }
  // Stalactites hanging from the roof.
  for (let k = 0; k < 9; k++) {
    const x = (pseudo(seed + k * 3) - 0.5) * width * 0.6, z = (pseudo(seed + k * 5 + 1) - 0.3) * length * 0.6;
    const u = (x / (width / 2)) ** 2 + (z / (length / 2)) ** 2;
    if (u > 0.7) continue;
    const top = height * Math.sqrt(1 - u) - 0.1, len = 0.5 + pseudo(seed + k) * 0.9;
    parts.push(paint(new THREE.ConeGeometry(0.16, len, 5).rotateX(Math.PI).translate(x, top - len / 2, z), 0x7a746b, 0.1, k));
  }
  // Bones at the back: something lives here.
  for (let k = 0; k < 5; k++) {
    const x = (pseudo(seed + k * 11) - 0.5) * 3, z = length / 2 - 3 + pseudo(seed + k * 13) * 1.5;
    parts.push(paint(new THREE.CylinderGeometry(0.04, 0.05, 0.6, 5).rotateZ(Math.PI / 2).rotateY(k * 1.3).translate(x, 0.05, z), 0xe2dccb, 0.05));
  }
  parts.push(paint(new THREE.SphereGeometry(0.16, 6, 4).scale(1, 0.8, 1.3).translate(0.8, 0.12, length / 2 - 2.2), 0xe2dccb, 0.05)); // skull
  return merge(parts);
}
