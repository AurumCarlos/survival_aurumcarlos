import * as THREE from 'three';
import type { PropKind } from '../world/TerrainGenerator';
import { foliageMaterial } from './Foliage';
import { firLowGeometry, flatMaterial, propGeometry } from './LowPolyFactory';

/**
 * Every static prop of the map (trees, rocks, bushes, grass…) drawn by just
 * two BatchedMeshes: one for solid parts (bark, stone, berries — PBR detail
 * material) and one for leaves and grass (alpha-tested foliage material).
 * With WEBGL_multi_draw that is two draw calls (plus two in the shadow pass)
 * however many kinds and variants there are; one InstancedMesh per kind per
 * chunk used to cost ~700 draw calls, which alone took 40 ms of CPU per frame
 * on a laptop.
 *
 * Per-instance work is done here instead of per mesh: distance culling (fog),
 * hiding small props far away, detailed meshes for the N nearest trees only,
 * and hiding felled trees.
 * Three does the per-instance frustum culling.
 */

/** Too small to see from afar: only drawn near the player. */
const SMALL: ReadonlySet<PropKind> = new Set<PropKind>(['grass_tuft', 'fiber_plant', 'mushroom', 'rare_flower', 'shell_bed', 'salt_deposit', 'fish_shoal', 'tall_grass', 'reeds', 'dead_bush']);

interface Parts { solid: number; leaf: number }
interface Variant { high: Parts; low: Parts | null }

interface Prop {
  x: number;
  z: number;
  small: boolean;
  variant: Variant;
  solidId: number;
  leafId: number;
  depleted: boolean;
  /** Last applied state, so update() only touches what changed. */
  shown: boolean;
  low: boolean;
}

const SOLID_ATTRS = ['position', 'normal', 'color'] as const;
const LEAF_ATTRS = ['position', 'normal', 'color', 'uv'] as const;

/** Copies one geometry group (or the whole geometry) into a compact indexed geometry with exactly `attrs`. */
function extract(g: THREE.BufferGeometry, start: number, count: number, attrs: readonly string[]): THREE.BufferGeometry {
  const index = g.index!;
  const remap = new Map<number, number>();
  const newIndex: number[] = [];
  for (let i = start; i < start + count; i++) {
    const v = index.getX(i);
    let n = remap.get(v);
    if (n === undefined) remap.set(v, (n = remap.size));
    newIndex.push(n);
  }
  const out = new THREE.BufferGeometry();
  for (const name of attrs) {
    const src = g.getAttribute(name) as THREE.BufferAttribute | undefined;
    const size = src?.itemSize ?? (name === 'uv' ? 2 : 3);
    const arr = new Float32Array(remap.size * size);
    if (src) {
      for (const [from, to] of remap) for (let k = 0; k < size; k++) arr[to * size + k] = src.array[from * size + k]!;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  out.setIndex(newIndex);
  return out;
}

/** Splits a prop geometry into its solid and leaf parts (groups 0/1 for trees and bushes). */
function split(g: THREE.BufferGeometry, kind: PropKind): { solid: THREE.BufferGeometry | null; leaf: THREE.BufferGeometry | null } {
  const total = g.index!.count;
  if (g.groups.length >= 2) {
    const [a, b] = g.groups as [THREE.GeometryGroup, THREE.GeometryGroup];
    return { solid: extract(g, a.start, a.count, SOLID_ATTRS), leaf: extract(g, b.start, b.count, LEAF_ATTRS) };
  }
  if (kind === 'grass_tuft' || kind === 'fiber_plant' || kind === 'tall_grass') return { solid: null, leaf: extract(g, 0, total, LEAF_ATTRS) };
  return { solid: extract(g, 0, total, SOLID_ATTRS), leaf: null };
}

export interface PropPlacement {
  kind: PropKind;
  /** Mesh variant (tree shape or variant % 4). */
  variant: number;
  matrix: THREE.Matrix4;
  x: number;
  z: number;
}

export class PropBatches {
  readonly solid: THREE.BatchedMesh;
  readonly leaves: THREE.BatchedMesh;
  private readonly props: Prop[] = [];

  /** Builds both batches for `placements`; prop i of the result is placements[i]. */
  constructor(placements: readonly PropPlacement[]) {
    // 1. Unique geometries, split into parts, and the space they need.
    const parts = new Map<string, { kind: PropKind; high: ReturnType<typeof split>; low: ReturnType<typeof split> | null }>();
    for (const p of placements) {
      const key = `${p.kind}|${p.variant}`;
      if (parts.has(key)) continue;
      parts.set(key, {
        kind: p.kind,
        high: split(propGeometry(p.kind, p.variant), p.kind),
        low: p.kind === 'tree' ? split(firLowGeometry(p.variant), p.kind) : null,
      });
    }
    let sv = 0, si = 0, lv = 0, li = 0, sn = 0, ln = 0;
    const size = (g: THREE.BufferGeometry | null, solid: boolean): void => {
      if (!g) return;
      if (solid) { sv += g.attributes['position']!.count; si += g.index!.count; } else { lv += g.attributes['position']!.count; li += g.index!.count; }
    };
    for (const v of parts.values()) {
      size(v.high.solid, true); size(v.high.leaf, false);
      size(v.low?.solid ?? null, true); size(v.low?.leaf ?? null, false);
    }
    for (const p of placements) {
      const v = parts.get(`${p.kind}|${p.variant}`)!;
      if (v.high.solid) sn++;
      if (v.high.leaf) ln++;
    }
    this.solid = new THREE.BatchedMesh(Math.max(1, sn), Math.max(3, sv), Math.max(3, si), flatMaterial);
    this.leaves = new THREE.BatchedMesh(Math.max(1, ln), Math.max(3, lv), Math.max(3, li), foliageMaterial());
    for (const b of [this.solid, this.leaves]) {
      b.castShadow = true;
      // Leaves are drawn in many layers: sampling the shadow map in each costs ~5 ms on an integrated GPU.
      b.receiveShadow = b === this.solid;
      b.name = b === this.solid ? 'props-solid' : 'props-leaves';
    }

    // 2. Register geometries once each.
    const ids = new Map<string, Variant>();
    const add = (b: THREE.BatchedMesh, g: THREE.BufferGeometry | null): number => (g ? b.addGeometry(g) : -1);
    for (const [key, v] of parts) {
      ids.set(key, {
        high: { solid: add(this.solid, v.high.solid), leaf: add(this.leaves, v.high.leaf) },
        low: v.low ? { solid: add(this.solid, v.low.solid), leaf: add(this.leaves, v.low.leaf) } : null,
      });
    }

    // 3. One instance per prop and part.
    for (const p of placements) {
      const variant = ids.get(`${p.kind}|${p.variant}`)!;
      const prop: Prop = {
        x: p.x, z: p.z, small: SMALL.has(p.kind), variant, solidId: -1, leafId: -1, depleted: false, shown: true, low: false,
      };
      if (variant.high.solid >= 0) {
        prop.solidId = this.solid.addInstance(variant.high.solid);
        this.solid.setMatrixAt(prop.solidId, p.matrix);
      }
      if (variant.high.leaf >= 0) {
        prop.leafId = this.leaves.addInstance(variant.high.leaf);
        this.leaves.setMatrixAt(prop.leafId, p.matrix);
      }
      this.props.push(prop);
    }
    this.solid.computeBoundingBox();
    this.solid.computeBoundingSphere();
    this.leaves.computeBoundingBox();
    this.leaves.computeBoundingSphere();
  }

  /** Felled tree / mined rock: hidden until it regrows. */
  setDepleted(prop: number, depleted: boolean): void {
    const p = this.props[prop];
    if (p) p.depleted = depleted;
  }

  /** Scratch for update(): indices of the nearest trees, sorted by distance. */
  private readonly nearest: number[] = [];
  private readonly nearestD2: number[] = [];

  /**
   * Applies distance culling and LOD for a camera at (x, z): props past
   * `d.view` are hidden, small ones past `d.smallProps`, and only the
   * `d.detailedTrees` nearest visible trees use the detailed mesh — every
   * other tree, however close, uses the low LOD. That caps the cost of
   * dense forest at a fixed number of detailed trees. Cheap: only changed
   * instances are touched.
   */
  update(x: number, z: number, d: { view: number; detailedTrees: number; smallProps: number }): void {
    const view2 = d.view * d.view;
    const small2 = d.smallProps * d.smallProps;
    const keep = Math.max(0, d.detailedTrees);
    const near = this.nearest, nearD2 = this.nearestD2;
    near.length = 0;
    nearD2.length = 0;
    for (let i = 0; i < this.props.length; i++) {
      const p = this.props[i]!;
      const dx = p.x - x, dz = p.z - z, d2 = dx * dx + dz * dz;
      const shown = !p.depleted && d2 < (p.small ? small2 : view2);
      if (shown !== p.shown) {
        p.shown = shown;
        if (p.solidId >= 0) this.solid.setVisibleAt(p.solidId, shown);
        if (p.leafId >= 0) this.leaves.setVisibleAt(p.leafId, shown);
      }
      if (!shown || !p.variant.low || keep === 0) continue;
      // Insert into the sorted list of the `keep` nearest trees.
      if (near.length === keep && d2 >= nearD2[keep - 1]!) continue;
      let j = Math.min(near.length, keep - 1);
      while (j > 0 && nearD2[j - 1]! > d2) {
        near[j] = near[j - 1]!;
        nearD2[j] = nearD2[j - 1]!;
        j--;
      }
      near[j] = i;
      nearD2[j] = d2;
    }
    for (let i = 0; i < this.props.length; i++) {
      const p = this.props[i]!;
      if (!p.variant.low) continue;
      const low = !near.includes(i);
      if (low === p.low) continue;
      p.low = low;
      const parts = low ? p.variant.low : p.variant.high;
      if (p.solidId >= 0) this.solid.setGeometryIdAt(p.solidId, parts.solid);
      if (p.leafId >= 0) this.leaves.setGeometryIdAt(p.leafId, parts.leaf);
    }
  }

  dispose(): void {
    this.solid.dispose();
    this.leaves.dispose();
  }
}
