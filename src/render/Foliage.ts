import * as THREE from 'three';
import { shaderTime, skyAmbient } from './Materials';

/**
 * Realistic foliage: crowns, bushes and grass are clouds of alpha-tested
 * "leaf cards" (small double-sided quads) textured from a procedural atlas,
 * instead of solid blobs. Card normals point away from the crown centre, so
 * a crown is lit like one soft volume while its outline stays leafy.
 *
 * Atlas regions (2×2): 0 broadleaf cluster · 1 needle spray · 2 palm frond · 3 grass blades.
 * The atlas is drawn in pale tones; vertex colours give each species its green.
 */
export const LeafRegion = { Broadleaf: 0, Needles: 1, Frond: 2, Grass: 3 } as const;
export type LeafRegion = (typeof LeafRegion)[keyof typeof LeafRegion];

const ATLAS = 1024;

function rand(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0;
    s ^= s >>> 13;
    return (s >>> 0) / 4294967296;
  };
}

function drawAtlas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = ATLAS;
  const g = c.getContext('2d')!;
  const R = ATLAS / 2;
  const r = rand(4242);
  const pale = (hue: number, light: number): string =>
    `hsl(${hue + (r() - 0.5) * 22}, ${28 + r() * 22}%, ${light + (r() - 0.5) * 18}%)`;

  // 0 — broadleaf cluster: twigs with ~90 oval leaves.
  g.save();
  g.translate(R / 2, R / 2);
  g.strokeStyle = 'hsl(30, 25%, 38%)';
  g.lineCap = 'round';
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2 + r() * 0.5;
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(0, 0);
    g.quadraticCurveTo(Math.cos(a + 0.3) * 90, Math.sin(a + 0.3) * 90, Math.cos(a) * 200, Math.sin(a) * 200);
    g.stroke();
  }
  for (let k = 0; k < 95; k++) {
    const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 205;
    const len = 34 + r() * 30, wid = len * (0.38 + r() * 0.12);
    g.save();
    g.translate(Math.cos(a) * d, Math.sin(a) * d);
    g.rotate(a + Math.PI / 2 + (r() - 0.5) * 1.4);
    g.fillStyle = pale(78, 72);
    g.beginPath();
    g.moveTo(0, -len / 2);
    g.quadraticCurveTo(wid, -len / 6, 0, len / 2);
    g.quadraticCurveTo(-wid, -len / 6, 0, -len / 2);
    g.fill();
    g.strokeStyle = 'rgba(60, 70, 30, 0.35)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(0, -len / 2);
    g.lineTo(0, len / 2);
    g.stroke();
    g.restore();
  }
  g.restore();

  // 1 — needle spray: a twig with side shoots, dense thin needles.
  g.save();
  g.translate(R + R / 2, R / 2);
  const twig = (x0: number, y0: number, x1: number, y1: number, w: number, needles: number): void => {
    g.strokeStyle = 'hsl(28, 25%, 35%)';
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy);
    for (let k = 0; k < needles; k++) {
      const t = r();
      const px = x0 + dx * t, py = y0 + dy * t;
      const side = k % 2 ? 1 : -1;
      const ang = Math.atan2(dy, dx) + side * (0.6 + r() * 0.5);
      const nl = (18 + r() * 16) * (1 - t * 0.4) * (L > 200 ? 1.3 : 1);
      g.strokeStyle = pale(95, 68);
      g.lineWidth = 2.2;
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(px + Math.cos(ang) * nl, py + Math.sin(ang) * nl);
      g.stroke();
    }
  };
  twig(0, 240, 0, -235, 6, 150);
  for (let k = 0; k < 6; k++) {
    const y = 180 - k * 70, s = k % 2 ? 1 : -1, len = 150 - k * 12;
    twig(0, y, s * len * 0.95, y - len * 0.6, 3.5, 70);
  }
  g.restore();

  // 2 — palm frond: a rachis (bottom → top) with long leaflets.
  g.save();
  g.translate(R / 2, R + R / 2);
  g.strokeStyle = 'hsl(45, 30%, 55%)';
  g.lineWidth = 7;
  g.beginPath();
  g.moveTo(0, 250);
  g.lineTo(0, -250);
  g.stroke();
  for (let k = 0; k < 46; k++) {
    const t = k / 46, y = 240 - t * 480;
    const len = 210 * Math.sin(Math.PI * (0.12 + t * 0.88)) + 20;
    for (const s of [-1, 1]) {
      g.strokeStyle = pale(85, 66);
      g.lineWidth = 9 * (1 - t * 0.5);
      g.beginPath();
      g.moveTo(0, y);
      g.quadraticCurveTo(s * len * 0.5, y - 18, s * len, y + 30 + r() * 20);
      g.stroke();
    }
  }
  g.restore();

  // 3 — grass blades rising from the bottom edge.
  g.save();
  g.translate(R, R);
  for (let k = 0; k < 75; k++) {
    const x = 30 + r() * (R - 60), h = R * (0.45 + r() * 0.52), lean = (r() - 0.5) * 140, w = 5 + r() * 7;
    const grad = g.createLinearGradient(0, R, 0, R - h);
    grad.addColorStop(0, 'hsl(85, 30%, 42%)');
    grad.addColorStop(0.6, pale(80, 70));
    grad.addColorStop(1, r() > 0.6 ? 'hsl(55, 40%, 78%)' : pale(80, 75));
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(x - w, R);
    g.quadraticCurveTo(x + lean * 0.3, R - h * 0.6, x + lean, R - h);
    g.quadraticCurveTo(x + lean * 0.3 + w * 0.4, R - h * 0.6, x + w, R);
    g.fill();
  }
  g.restore();
  return c;
}

let atlas: THREE.DataTexture | null = null;

/**
 * The atlas as a DataTexture whose fully transparent texels carry the mean
 * leaf colour of their region instead of black. Mipmaps average colour with
 * those texels, so at low resolution / far away leaves would otherwise turn
 * almost black at the alpha-test edge.
 */
function foliageAtlas(): THREE.DataTexture {
  if (atlas) return atlas;
  const canvas = drawAtlas();
  const img = canvas.getContext('2d')!.getImageData(0, 0, ATLAS, ATLAS);
  const px = img.data;
  const half = ATLAS / 2;
  for (let region = 0; region < 4; region++) {
    const x0 = (region % 2) * half, y0 = region < 2 ? 0 : half;
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y0 + half; y++) {
      for (let x = x0; x < x0 + half; x++) {
        const i = (y * ATLAS + x) * 4;
        if (px[i + 3]! > 200) { r += px[i]!; g += px[i + 1]!; b += px[i + 2]!; n++; }
      }
    }
    if (n === 0) continue;
    r /= n; g /= n; b /= n;
    for (let y = y0; y < y0 + half; y++) {
      for (let x = x0; x < x0 + half; x++) {
        const i = (y * ATLAS + x) * 4;
        const a = px[i + 3]! / 255;
        if (a >= 1) continue;
        // Semi-transparent edge texels were un-premultiplied toward black: blend toward the mean.
        px[i] = px[i]! * a + r * (1 - a);
        px[i + 1] = px[i + 1]! * a + g * (1 - a);
        px[i + 2] = px[i + 2]! * a + b * (1 - a);
      }
    }
  }
  const tex = new THREE.DataTexture(new Uint8Array(px.buffer.slice(0)), ATLAS, ATLAS, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.flipY = true; // like a CanvasTexture: canvas top = v 1 (regions 0–1 are the top half)
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  atlas = tex;
  return tex;
}

let material: THREE.MeshLambertMaterial | null = null;

/**
 * Shared leaf material: alpha-tested, double-sided, swaying gently in the
 * wind. Lambert, not PBR, and no alpha-to-coverage: leaves are drawn in many
 * overlapping layers, so their per-pixel cost dominates the frame.
 */
/**
 * Alpha-tested leaves thin out with distance: each mipmap averages leaf and
 * gap, so less of it passes the alpha test and far trees turn into twigs.
 * Scaling alpha up with the mip level keeps the coverage (Ben Golus' fix).
 */
export const MIP_ALPHA_GLSL = (w: number, h: number): string => `
  {
    vec2 texel = vMapUv * vec2(${w.toFixed(1)}, ${h.toFixed(1)});
    vec2 dx = dFdx(texel), dy = dFdy(texel);
    float mip = 0.5 * log2(max(dot(dx, dx), dot(dy, dy)));
    diffuseColor.a *= 1.0 + max(mip, 0.0) * 0.25;
  }`;

export function foliageMaterial(): THREE.MeshLambertMaterial {
  if (material) return material;
  const m = new THREE.MeshLambertMaterial({
    map: foliageAtlas(), vertexColors: true, alphaTest: 0.45, side: THREE.DoubleSide,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms['uTime'] = shaderTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          vec3 base = vec3(0.0);
          #ifdef USE_BATCHING
            base = batchingMatrix[3].xyz;
          #endif
          #ifdef USE_INSTANCING
            base = instanceMatrix[3].xyz;
          #endif
          float phase = dot(base.xz, vec2(0.37, 0.71)) + dot(position, vec3(1.3, 0.7, 1.1));
          float sway = max(position.y - 0.25, 0.0) * 0.012 + 0.015;
          transformed.x += sin(uTime * 1.7 + phase) * sway;
          transformed.z += cos(uTime * 1.3 + phase * 1.3) * sway;
        }`);
    // Back faces of a card use the same (outward) normal: both sides lit like the crown.
    // Lambert ignores scene.environment, so the sky's ambient light is added by hand.
    shader.uniforms['uSkyAmbient'] = skyAmbient;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uSkyAmbient;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        ${MIP_ALPHA_GLSL(ATLAS, ATLAS)}`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        normal = normalize(vNormal);`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        reflectedLight.indirectDiffuse += diffuseColor.rgb * uSkyAmbient;`);
  };
  m.customProgramCacheKey = () => 'foliage-v3';
  material = m;
  return m;
}

// ---------------------------------------------------------------------------
// Card geometry
// ---------------------------------------------------------------------------

/** Accumulates leaf cards; build() returns an indexed geometry with position/normal/color/uv. */
export class CardBuilder {
  private readonly pos: number[] = [];
  private readonly nrm: number[] = [];
  private readonly col: number[] = [];
  private readonly uv: number[] = [];
  private readonly idx: number[] = [];
  private readonly tmp = new THREE.Vector3();
  private readonly c = new THREE.Color();

  /**
   * One quad centred at `center`, spanned by `right` (half width) and `up`
   * (half height), lit with `normal`. UVs cover the atlas region.
   */
  quad(center: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3, normal: THREE.Vector3, region: LeafRegion, color: number, shade: number): void {
    const base = this.pos.length / 3;
    const u0 = (region % 2) * 0.5, v0 = region < 2 ? 0.5 : 0;
    this.c.set(color).multiplyScalar(shade);
    const corners: Array<[number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (const [sx, sy] of corners) {
      this.tmp.copy(center).addScaledVector(right, sx).addScaledVector(up, sy);
      this.pos.push(this.tmp.x, this.tmp.y, this.tmp.z);
      this.nrm.push(normal.x, normal.y, normal.z);
      this.col.push(this.c.r, this.c.g, this.c.b);
      this.uv.push(u0 + (sx * 0.5 + 0.5) * 0.5 * 0.98 + 0.005, v0 + (sy * 0.5 + 0.5) * 0.5 * 0.98 + 0.005);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Scatter `count` cards through an ellipsoid crown (centre c, radii r):
 * mostly near the surface, facing outward-ish with random roll. Inner cards
 * are darker (self-shadowing inside the crown).
 */
export function crownCards(
  b: CardBuilder, c: THREE.Vector3, r: THREE.Vector3, count: number, size: number,
  region: LeafRegion, colors: readonly number[], seed: number,
): void {
  const rnd = rand(seed * 7919 + 17);
  const dir = new THREE.Vector3(), p = new THREE.Vector3(), n = new THREE.Vector3();
  const right = new THREE.Vector3(), up = new THREE.Vector3(), q = new THREE.Quaternion();
  for (let k = 0; k < count; k++) {
    // Uniform direction, biased toward the surface.
    const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, s = Math.sqrt(1 - z * z);
    dir.set(Math.cos(a) * s, z, Math.sin(a) * s);
    const depth = 0.55 + 0.45 * Math.pow(rnd(), 0.6);
    p.set(dir.x * r.x * depth, dir.y * r.y * depth, dir.z * r.z * depth).add(c);
    // Lighting normal: outward, nudged up (light scatters through leaves).
    n.copy(dir).multiply(new THREE.Vector3(1 / r.x, 1 / r.y, 1 / r.z)).normalize().addScaledVector(UP, 0.35).normalize();
    // Card plane: roughly facing outward, randomly rolled and tilted.
    right.crossVectors(UP, dir);
    if (right.lengthSq() < 1e-4) right.set(1, 0, 0);
    right.normalize();
    up.crossVectors(dir, right).normalize();
    q.setFromAxisAngle(dir, rnd() * Math.PI * 2);
    right.applyQuaternion(q);
    up.applyQuaternion(q);
    const tilt = (rnd() - 0.5) * 1.2;
    q.setFromAxisAngle(right, tilt);
    up.applyQuaternion(q);
    const sz = size * (0.75 + rnd() * 0.5);
    const shade = 0.62 + 0.38 * depth + (rnd() - 0.5) * 0.12;
    b.quad(p, right.clone().multiplyScalar(sz / 2), up.clone().multiplyScalar(sz / 2), n, region, colors[k % colors.length]!, shade);
  }
}

/**
 * Conifer whorl: needle sprays hanging out and down from the trunk around a
 * cone of radius `radius` at height `y`.
 */
export function whorlCards(
  b: CardBuilder, y: number, radius: number, count: number, size: number, color: number, seed: number,
): void {
  const rnd = rand(seed * 104729 + 3);
  const out = new THREE.Vector3(), center = new THREE.Vector3(), n = new THREE.Vector3();
  const right = new THREE.Vector3(), along = new THREE.Vector3();
  for (let k = 0; k < count; k++) {
    const a = (k / count) * Math.PI * 2 + rnd() * 0.6;
    out.set(Math.cos(a), 0, Math.sin(a));
    const reach = radius * (0.55 + rnd() * 0.45);
    const droop = 0.25 + rnd() * 0.25;
    // Spray runs from near the trunk outward and slightly down.
    along.copy(out).multiplyScalar(reach).setY(-reach * droop);
    center.copy(along).multiplyScalar(0.5).setY(y + along.y * 0.5 + (rnd() - 0.5) * 0.3);
    right.set(-out.z, (rnd() - 0.5) * 0.4, out.x).normalize().multiplyScalar(size * 0.45);
    n.copy(out).setY(0.55).normalize();
    const shade = 0.8 + rnd() * 0.25;
    // Twig base sits at the trunk: the card's "up" axis follows the spray.
    b.quad(center, right, along.clone().multiplyScalar(0.55), n, LeafRegion.Needles, color, shade);
    // A second, crossed card gives the spray volume from every angle.
    const r2 = new THREE.Vector3().crossVectors(along, right).normalize().multiplyScalar(size * 0.35);
    b.quad(center, r2, along.clone().multiplyScalar(0.55), n, LeafRegion.Needles, color, shade * 0.92);
  }
}

/** Long drooping palm frond from `base` toward azimuth `a`, made of a few chained card segments. */
export function frondCards(b: CardBuilder, base: THREE.Vector3, a: number, length: number, width: number, color: number, seed: number, segs = 4): void {
  const rnd = rand(seed + 11);
  const out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
  const side = new THREE.Vector3(-out.z, 0, out.x);
  const lift = 0.5 + rnd() * 0.3;
  let prev = base.clone();
  for (let k = 0; k < segs; k++) {
    const t1 = (k + 1) / segs;
    // Rises a little, then arcs down.
    const p = base.clone().addScaledVector(out, length * t1).setY(base.y + length * (lift * t1 - 0.95 * t1 * t1));
    const center = prev.clone().add(p).multiplyScalar(0.5);
    const up = p.clone().sub(prev).multiplyScalar(0.5);
    const w = width * (k === segs - 1 ? 0.6 : 1);
    const n = new THREE.Vector3().crossVectors(side, up).normalize();
    if (n.y < 0) n.negate();
    n.addScaledVector(UP, 0.4).normalize();
    b.quad(center, side.clone().multiplyScalar(w / 2), up, n, LeafRegion.Frond, color, 0.85 + rnd() * 0.2);
    prev = p;
  }
}

/** Crossed vertical cards: grass tufts and fiber plants. */
export function tuftCards(b: CardBuilder, width: number, height: number, cards: number, color: number, seed: number): void {
  const rnd = rand(seed + 5);
  const c = new THREE.Vector3(), n = new THREE.Vector3();
  for (let k = 0; k < cards; k++) {
    const a = (k / cards) * Math.PI + rnd() * 0.4;
    const right = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(width / 2);
    c.set((rnd() - 0.5) * width * 0.3, height / 2, (rnd() - 0.5) * width * 0.3);
    n.set(0, 1, 0);
    b.quad(c, right, new THREE.Vector3(0, height / 2, 0), n, LeafRegion.Grass, color, 0.85 + rnd() * 0.25);
  }
}
