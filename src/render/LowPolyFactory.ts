import * as THREE from 'three';
import { FIR_HEIGHT, FIR_TRUNK_RADIUS } from '../systems/ai/nav/NavGrid';
import { BED } from '../systems/building/BuildingGrid';
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
        return firGeometry(variant, false);
      case 'rock':
        return merge([paint(wobble(new THREE.IcosahedronGeometry(0.9, 1), 0.35, variant).scale(1, 0.62, 1), 0x8a8a85, 0.12, variant)]);
      case 'berry_bush':
        return merge([
          paint(wobble(new THREE.IcosahedronGeometry(0.7, 1), 0.25, variant).translate(0, 0.55, 0), 0x3d7a35),
          paint(new THREE.IcosahedronGeometry(0.1, 0).translate(0.4, 0.8, 0.3), 0xb3263a, 0),
          paint(new THREE.IcosahedronGeometry(0.1, 0).translate(-0.3, 0.9, -0.35), 0xb3263a, 0),
        ]);
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
        ]);
      case 'carcass':
        return merge([paint(new THREE.BoxGeometry(1.1, 0.35, 0.5).translate(0, 0.18, 0), 0x6e4a3a)]);
      case 'water_source':
        return merge([paint(new THREE.CircleGeometry(1, 6).rotateX(-Math.PI / 2), 0x3a7ca5)]);
    }
  });
}

// ---------------------------------------------------------------------------
// Firs, at real-world scale. A scale-1 tree is 16 m tall with a 0.64 m trunk;
// props use scale 0.75–1.25 (12–20 m) for mature trees and 0.35–0.6 for
// young ones. Crown: narrow cone of overlapping drooping whorls starting
// 2–3.4 m up (bare lower trunk, as in a dense stand), widest ≈ 1/3 of the
// height — the classic fir silhouette.
// ---------------------------------------------------------------------------

const FIR_VARIANTS = [
  { crownBase: 2.4, crownR: 2.7, tiers: 11, dark: 0x1e472b, light: 0x2f6a3a },
  { crownBase: 3.0, crownR: 2.4, tiers: 12, dark: 0x1b4030, light: 0x2c5f3f }, // blue-green spruce-like
  { crownBase: 2.0, crownR: 2.9, tiers: 10, dark: 0x22502c, light: 0x36763c },
  { crownBase: 3.4, crownR: 2.2, tiers: 13, dark: 0x1c432a, light: 0x2a5c36 },
] as const;

function firGeometry(variant: number, low: boolean): THREE.BufferGeometry {
  return cached(`fir:${variant}:${low ? 'low' : 'high'}`, () => {
    const v = FIR_VARIANTS[variant % FIR_VARIANTS.length]!;
    const H = FIR_HEIGHT;
    const segs = low ? 6 : 8;
    const tiers = low ? 4 : v.tiers;
    const parts: THREE.BufferGeometry[] = [
      paint(new THREE.CylinderGeometry(0.05, FIR_TRUNK_RADIUS, H * 0.92, low ? 5 : 8).translate(0, H * 0.46, 0), 0x5e4532, 0.06, variant),
    ];
    if (!low) parts.push(paint(new THREE.CylinderGeometry(FIR_TRUNK_RADIUS, 0.5, 0.45, 8).translate(0, 0.22, 0), 0x55402f, 0.06)); // root flare
    const top = H - 1.6;
    const coneH = ((H - v.crownBase) / tiers) * 2.1; // each whorl overlaps the next two
    const dark = new THREE.Color(v.dark), light = new THREE.Color(v.light), c = new THREE.Color();
    for (let k = 0; k < tiers; k++) {
      const t = k / (tiers - 1); // 0 = lowest whorl, 1 = top
      const y = v.crownBase + (top - coneH * 0.6 - v.crownBase) * t;
      const r = v.crownR * Math.pow(1 - t * 0.9, 1.1) + 0.25;
      c.copy(dark).lerp(light, t * 0.8); // fresh growth is lighter near the top
      let cone: THREE.BufferGeometry = new THREE.ConeGeometry(r, coneH, segs, 1).rotateY(pseudo(variant * 31 + k) * Math.PI * 2);
      if (!low) cone = wobble(cone, 0.12, variant * 7 + k);
      parts.push(paint(cone.translate(0, y + coneH / 2, 0), c.getHex(), 0.09, k + variant * 5));
    }
    parts.push(paint(new THREE.ConeGeometry(0.3, 1.8, segs).translate(0, H - 0.9, 0), v.light, 0.05)); // leader
    return liftUndersides(merge(parts), 1.9);
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

/** Distant-LOD fir: same silhouette, ~70 % fewer triangles. */
export function firLowGeometry(variant: number): THREE.BufferGeometry {
  return firGeometry(variant, true);
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
