import * as THREE from 'three';
import { cached, flatMaterial, merge, paint, wobble } from './LowPolyFactory';

/**
 * The two big predators, built as real skeletons of pivots so ApexAnimation
 * can bend them: the crocodile's spine and 6-segment tail undulate, its jaw
 * hinges open, its sprawled legs step or tuck against the body when it
 * swims; the bear's spine rears up on its hind legs, its jaw opens to roar,
 * every leg has a shoulder/hip and an elbow/knee joint.
 *
 * Both face +Z with their feet at y = 0 at rest.
 */

const mesh = (g: THREE.BufferGeometry, castShadow = true): THREE.Mesh => {
  const m = new THREE.Mesh(g, flatMaterial);
  m.castShadow = castShadow;
  m.receiveShadow = true;
  return m;
};

const pivot = (name: string, x: number, y: number, z: number, ...children: THREE.Object3D[]): THREE.Group => {
  const g = new THREE.Group();
  g.name = name;
  g.position.set(x, y, z);
  g.add(...children);
  return g;
};

function rnd(n: number): number {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

/** Counter-shading by height: `top` colour above y1, `bottom` below y0. */
function shade(geo: THREE.BufferGeometry, top: number, bottom: number, y0: number, y1: number, jitter = 0.07, seed = 1): THREE.BufferGeometry {
  const g = paint(geo, top, 0, seed);
  const pos = g.attributes['position']!, col = g.attributes['color']!;
  const a = new THREE.Color(bottom), b = new THREE.Color(top), c = new THREE.Color();
  for (let tri = 0; tri < pos.count / 3; tri++) {
    const y = (pos.getY(tri * 3) + pos.getY(tri * 3 + 1) + pos.getY(tri * 3 + 2)) / 3;
    const t = Math.min(1, Math.max(0, (y - y0) / (y1 - y0)));
    const v = 1 + (rnd(tri + seed) - 0.5) * 2 * jitter;
    c.copy(a).lerp(b, t).multiplyScalar(v);
    for (let k = 0; k < 3; k++) col.setXYZ(tri * 3 + k, Math.min(1, c.r), Math.min(1, c.g), Math.min(1, c.b));
  }
  return g;
}

/** Box whose front (+Z) end is scaled down: snouts, tail segments. */
function taperBox(w: number, h: number, d: number, frontW: number, frontH: number, zFrom: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d, 2, 1, 4).translate(0, 0, zFrom + d / 2);
  const p = g.attributes['position']!;
  for (let i = 0; i < p.count; i++) {
    const t = (p.getZ(i) - zFrom) / d; // 0 at the back, 1 at the front
    p.setX(i, p.getX(i) * (1 + (frontW - 1) * t));
    p.setY(i, p.getY(i) * (1 + (frontH - 1) * t));
  }
  return g.toNonIndexed();
}

// ===========================================================================
// Crocodile — ~5 m saltwater crocodile
// ===========================================================================

const CROC = {
  back: 0x39432a, scute: 0x262d1b, flank: 0x56603c, belly: 0xcdbf95,
  eye: 0xe3b62c, pupil: 0x0d0c08, teeth: 0xf1e9d2, mouth: 0xb5615c, claw: 0x2a2620,
} as const;

/** Bony osteoderms: a row of small ridged plates along z. */
function scutes(xs: number[], y: number, z0: number, z1: number, n: number, size: number, seed: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (let i = 0; i < n; i++) {
    const z = z0 + ((z1 - z0) * (i + 0.5)) / n;
    for (const x of xs) {
      out.push(paint(new THREE.ConeGeometry(size, size * 1.3, 4).scale(1, 1, 1.6).rotateY(Math.PI / 4).translate(x, y + size * 0.4, z), CROC.scute, 0.12, seed + i * 7 + x * 31));
    }
  }
  return out;
}

function crocTorso(): THREE.BufferGeometry {
  return cached('croc:torso', () => merge([
    shade(wobble(new THREE.SphereGeometry(1, 14, 8), 0.04, 3).scale(0.44, 0.24, 0.82).translate(0, 0, 0.62), CROC.back, CROC.belly, -0.12, 0.1),
    shade(new THREE.SphereGeometry(1, 10, 6).scale(0.34, 0.2, 0.4).translate(0, 0.02, 1.25), CROC.back, CROC.belly, -0.1, 0.08, 0.07, 5), // shoulders
    ...scutes([-0.2, -0.08, 0.08, 0.2], 0.17, 0.05, 1.35, 9, 0.045, 11),
    ...scutes([-0.3, 0.3], 0.1, 0.25, 1.15, 6, 0.035, 19), // flank row
  ]));
}

function crocNeck(): THREE.BufferGeometry {
  return cached('croc:neck', () => merge([
    shade(new THREE.CylinderGeometry(0.22, 0.27, 0.42, 9).rotateX(Math.PI / 2).scale(1.15, 0.72, 1).translate(0, 0.0, 0.18), CROC.back, CROC.belly, -0.1, 0.08),
    ...scutes([-0.07, 0.07], 0.13, 0.02, 0.38, 3, 0.04, 23),
  ]));
}

function teethRow(side: number, y: number, z0: number, z1: number, halfW: (z: number) => number, up: boolean): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (let z = z0, i = 0; z < z1; z += 0.065, i++) {
    const len = 0.035 + (i % 3 === 0 ? 0.025 : 0) + (z > z1 - 0.2 ? 0.015 : 0);
    out.push(paint(new THREE.ConeGeometry(0.012, len, 4).rotateX(up ? 0 : Math.PI).translate(side * (halfW(z) - 0.008), y + (up ? len / 2 : -len / 2), z), CROC.teeth, 0.03));
  }
  return out;
}

function crocSkull(): THREE.BufferGeometry {
  return cached('croc:skull', () => {
    // Upper jaw: wide at the back, long narrow snout, flat top.
    const halfW = (z: number): number => 0.2 * (1 - (z / 0.95) * 0.55);
    return merge([
      shade(taperBox(0.4, 0.17, 0.95, 0.45, 0.6, 0).translate(0, 0.085, 0), CROC.back, CROC.flank, 0.0, 0.17),
      shade(new THREE.SphereGeometry(1, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(0.21, 0.16, 0.26).translate(0, 0.1, 0.08), CROC.back, CROC.flank, 0.05, 0.25, 0.06, 7), // cranium
      // Raised eye sockets and eyes on top of the head (they stay above water).
      ...[-1, 1].flatMap((s) => [
        shade(new THREE.SphereGeometry(0.06, 8, 5).scale(1, 0.75, 1.2).translate(s * 0.1, 0.24, 0.12), CROC.back, CROC.flank, 0.2, 0.3),
        paint(new THREE.SphereGeometry(0.035, 8, 6).translate(s * 0.115, 0.265, 0.15), CROC.eye, 0),
        paint(new THREE.BoxGeometry(0.006, 0.05, 0.012).translate(s * 0.142, 0.268, 0.155), CROC.pupil, 0), // slit pupil
      ]),
      // Nostril bump at the tip.
      shade(new THREE.SphereGeometry(0.05, 8, 5).scale(1.3, 0.6, 1).translate(0, 0.12, 0.9), CROC.back, CROC.flank, 0.1, 0.15),
      paint(new THREE.SphereGeometry(0.012, 5, 4).translate(-0.02, 0.15, 0.92), CROC.pupil, 0),
      paint(new THREE.SphereGeometry(0.012, 5, 4).translate(0.02, 0.15, 0.92), CROC.pupil, 0),
      // Bumpy texture along the snout.
      ...Array.from({ length: 8 }, (_, i) => paint(new THREE.IcosahedronGeometry(0.018, 0).translate((rnd(i) - 0.5) * 0.14, 0.17 - i * 0.004, 0.3 + i * 0.07), CROC.scute, 0.08, i)),
      // Interlocking teeth along both sides of the upper jaw.
      ...teethRow(-1, 0, 0.08, 0.93, halfW, false), ...teethRow(1, 0, 0.08, 0.93, halfW, false),
      paint(new THREE.BoxGeometry(0.28, 0.01, 0.8).translate(0, 0.005, 0.42), CROC.mouth, 0.06), // palate
    ]);
  });
}

function crocJaw(): THREE.BufferGeometry {
  return cached('croc:jaw', () => {
    const halfW = (z: number): number => 0.19 * (1 - (z / 0.95) * 0.55);
    return merge([
      shade(taperBox(0.38, 0.11, 0.95, 0.45, 0.55, 0).translate(0, -0.055, 0), CROC.flank, CROC.belly, -0.1, 0.0),
      paint(new THREE.BoxGeometry(0.26, 0.012, 0.78).translate(0, 0.004, 0.42), CROC.mouth, 0.08), // tongue/floor
      ...teethRow(-1, 0, 0.1, 0.92, halfW, true), ...teethRow(1, 0, 0.1, 0.92, halfW, true),
    ]);
  });
}

function crocTailSeg(i: number): THREE.BufferGeometry {
  return cached(`croc:tail${i}`, () => {
    const w0 = 0.34 * (1 - i * 0.15), w1 = 0.34 * (1 - (i + 1) * 0.15);
    const h0 = 0.27 * (1 - i * 0.12), h1 = 0.27 * (1 - (i + 1) * 0.12);
    const len = 0.42;
    // Built pointing backward (−Z) from the pivot.
    const seg = taperBox(w0, h0, len, w1 / w0, h1 / h0, 0).rotateY(Math.PI);
    const crest: THREE.BufferGeometry[] = [];
    const rows = i < 3 ? [-0.06, 0.06] : [0];
    for (let k = 0; k < 3; k++) {
      for (const x of rows) {
        const fh = 0.07 + 0.03 * (i < 3 ? 1 : 1.4);
        crest.push(paint(new THREE.ConeGeometry(0.03, fh, 3).scale(0.4, 1, 1.6).translate(x * (1 - i * 0.12), h0 / 2 * (1 - k * 0.05) + fh / 2 - 0.02, -0.07 - k * 0.14), CROC.scute, 0.1, i * 9 + k));
      }
    }
    return merge([shade(seg, CROC.back, CROC.belly, -h0 / 2, h0 / 2, 0.07, i), ...crest]);
  });
}

function crocLegGeos(front: boolean): { upper: THREE.BufferGeometry; lower: THREE.BufferGeometry } {
  return {
    upper: cached(`croc:upper${front}`, () => merge([
      // Sprawling: the upper leg points sideways (+X); mirrored for the right side by the pivot's scale.
      shade(new THREE.CylinderGeometry(0.075, 0.09, 0.3, 7).rotateZ(Math.PI / 2).translate(0.15, 0, 0), CROC.flank, CROC.belly, -0.05, 0.05),
    ])),
    lower: cached(`croc:lower${front}`, () => {
      const toes: THREE.BufferGeometry[] = [];
      const n = front ? 5 : 4;
      for (let k = 0; k < n; k++) {
        const a = -0.6 + (1.2 * k) / (n - 1);
        toes.push(paint(new THREE.CylinderGeometry(0.012, 0.018, 0.12, 4).rotateX(Math.PI / 2).translate(0, 0, 0.06).rotateY(a).translate(0.0, -0.24, 0.05), CROC.flank, 0.06, k));
        toes.push(paint(new THREE.ConeGeometry(0.01, 0.04, 3).rotateX(Math.PI / 2).translate(0, 0, 0.14).rotateY(a).translate(0, -0.24, 0.05), CROC.claw, 0.04, k));
      }
      return merge([
        shade(new THREE.CylinderGeometry(0.06, 0.05, 0.22, 7).translate(0, -0.11, 0), CROC.flank, CROC.belly, -0.2, 0),
        paint(new THREE.SphereGeometry(0.07, 7, 4).scale(1, 0.35, 1.3).translate(0, -0.235, 0.04), CROC.flank, 0.06), // foot
        ...toes,
      ]);
    }),
  };
}

export function crocodileModel(): THREE.Group {
  const root = new THREE.Group();
  root.name = 'crocodile';
  const jaw = pivot('jaw', 0, 0.02, 0.06, mesh(crocJaw()));
  const head = pivot('head', 0, 0.02, 0.38, mesh(crocSkull()), jaw);
  const neck = pivot('neck', 0, 0, 1.3, mesh(crocNeck()), head);
  // Tail chain: each segment's pivot sits at the end of the previous one.
  let tail: THREE.Group | null = null;
  for (let i = 5; i >= 0; i--) {
    const seg = pivot(`tail${i}`, 0, 0, i === 0 ? 0 : -0.4, mesh(crocTailSeg(i), i < 3));
    if (tail) seg.add(tail);
    tail = seg;
  }
  const legs: THREE.Group[] = [];
  for (const [name, x, z, front] of [['legFL', 0.3, 1.1, true], ['legFR', -0.3, 1.1, true], ['legBL', 0.32, 0.15, false], ['legBR', -0.32, 0.15, false]] as const) {
    const g = crocLegGeos(front);
    const knee = pivot('knee', 0.28, 0, 0, mesh(g.lower, false));
    const hip = pivot(name, x, -0.04, z, mesh(g.upper, false), knee);
    if (x < 0) hip.scale.x = -1; // mirror for the right side
    legs.push(hip);
  }
  const spine = pivot('spine', 0, 0.32, -0.6, mesh(crocTorso()), neck, pivot('tailRoot', 0, 0, -0.1, tail!), ...legs);
  root.add(spine);
  return root;
}

// ===========================================================================
// Bear — a big brown cave bear (~2.2 m long, 1.2 m at the shoulder)
// ===========================================================================

const BEAR = {
  fur: 0x4a3221, dark: 0x352317, light: 0x6b4a30, muzzle: 0x8d6c4b, nose: 0x141010,
  claw: 0xe2d9c6, eye: 0x0c0a09, mouth: 0x8e3f3c, teeth: 0xf0e8d4,
} as const;

/** Shaggy fur: faceted tufts scattered over an ellipsoid. */
function furTufts(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, n: number, seed: number, color: number = BEAR.dark): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (let i = 0; i < n; i++) {
    const u = rnd(seed + i * 3) * Math.PI * 2, v = rnd(seed + i * 5 + 1) * Math.PI * 0.75;
    const x = Math.cos(u) * Math.sin(v), y = Math.cos(v), z = Math.sin(u) * Math.sin(v);
    // Stubby shaggy clumps (not spikes): flattened facets lying along the body.
    out.push(paint(new THREE.IcosahedronGeometry(0.075, 0).scale(1.25, 0.9, 0.45).lookAt(new THREE.Vector3(x, y, z))
      .translate(cx + x * rx, cy + y * ry, cz + z * rz), i % 3 ? color : BEAR.fur, 0.12, seed + i));
  }
  return out;
}

function bearTorso(): THREE.BufferGeometry {
  return cached('bear:torso', () => merge([
    // Torso relative to the hip pivot (which sits at the back, at hip height).
    shade(wobble(new THREE.SphereGeometry(1, 14, 9), 0.06, 5).scale(0.5, 0.48, 0.95).translate(0, 0.08, 0.62), BEAR.fur, BEAR.light, -0.35, 0.4),
    shade(wobble(new THREE.SphereGeometry(1, 12, 8), 0.06, 7).scale(0.46, 0.42, 0.42).translate(0, 0.28, 1.05), BEAR.dark, BEAR.fur, 0, 0.6, 0.07, 3), // shoulder hump
    shade(new THREE.SphereGeometry(1, 10, 7).scale(0.44, 0.44, 0.4).translate(0, 0.02, 0.08), BEAR.fur, BEAR.light, -0.3, 0.3, 0.07, 9), // rump
    ...furTufts(0, 0.1, 0.62, 0.48, 0.46, 0.9, 46, 11),
    ...furTufts(0, 0.3, 1.05, 0.44, 0.42, 0.4, 18, 31),
  ]));
}

function bearHeadGeo(): THREE.BufferGeometry {
  return cached('bear:head', () => merge([
    shade(wobble(new THREE.SphereGeometry(1, 12, 9), 0.05, 2).scale(0.26, 0.24, 0.27), BEAR.fur, BEAR.light, -0.2, 0.2), // skull
    shade(new THREE.CylinderGeometry(0.1, 0.15, 0.26, 9).rotateX(Math.PI / 2).translate(0, -0.06, 0.25), BEAR.muzzle, BEAR.muzzle, 0, 1), // muzzle
    paint(new THREE.SphereGeometry(0.055, 8, 6).scale(1.2, 0.8, 0.9).translate(0, -0.03, 0.39), BEAR.nose, 0.04), // nose
    ...[-1, 1].flatMap((s) => [
      paint(new THREE.SphereGeometry(0.075, 8, 6).scale(1, 1, 0.55).translate(s * 0.17, 0.2, -0.03), BEAR.dark, 0.06), // round ears
      paint(new THREE.SphereGeometry(0.045, 6, 4).scale(1, 1, 0.4).translate(s * 0.17, 0.2, 0.0), BEAR.light, 0.04),
      paint(new THREE.SphereGeometry(0.028, 6, 5).translate(s * 0.11, 0.07, 0.2), BEAR.eye, 0), // small eyes
      paint(new THREE.SphereGeometry(0.009, 4, 3).translate(s * 0.115, 0.08, 0.225), 0xffffff, 0), // glint
    ]),
    ...furTufts(0, 0.02, -0.05, 0.27, 0.25, 0.25, 22, 41),
    // Upper fangs, seen when the mouth opens.
    paint(new THREE.ConeGeometry(0.016, 0.06, 4).rotateX(Math.PI).translate(-0.06, -0.15, 0.33), BEAR.teeth, 0),
    paint(new THREE.ConeGeometry(0.016, 0.06, 4).rotateX(Math.PI).translate(0.06, -0.15, 0.33), BEAR.teeth, 0),
    paint(new THREE.BoxGeometry(0.16, 0.012, 0.2).translate(0, -0.125, 0.25), BEAR.mouth, 0.05), // palate
  ]));
}

function bearJawGeo(): THREE.BufferGeometry {
  return cached('bear:jaw', () => merge([
    shade(new THREE.CylinderGeometry(0.08, 0.11, 0.24, 8).rotateX(Math.PI / 2).scale(1, 0.55, 1).translate(0, -0.03, 0.12), BEAR.muzzle, BEAR.light, -0.06, 0.02),
    paint(new THREE.BoxGeometry(0.13, 0.012, 0.2).translate(0, 0.0, 0.12), BEAR.mouth, 0.05), // tongue
    paint(new THREE.ConeGeometry(0.014, 0.05, 4).translate(-0.055, 0.03, 0.21), BEAR.teeth, 0),
    paint(new THREE.ConeGeometry(0.014, 0.05, 4).translate(0.055, 0.03, 0.21), BEAR.teeth, 0),
  ]));
}

function bearLegGeos(front: boolean): { upper: THREE.BufferGeometry; lower: THREE.BufferGeometry } {
  const upperLen = front ? 0.42 : 0.4, lowerLen = front ? 0.4 : 0.42;
  return {
    upper: cached(`bear:upper${front}`, () => merge([
      shade(wobble(new THREE.CylinderGeometry(0.15, 0.12, upperLen, 9), 0.05, front ? 1 : 2).translate(0, -upperLen / 2, 0), BEAR.fur, BEAR.dark, -upperLen, 0),
      ...furTufts(0, -upperLen * 0.4, 0, 0.14, upperLen * 0.4, 0.13, 10, front ? 51 : 61),
    ])),
    lower: cached(`bear:lower${front}`, () => {
      const claws: THREE.BufferGeometry[] = [];
      for (let k = 0; k < 5; k++) {
        const x = -0.08 + k * 0.04;
        claws.push(paint(new THREE.ConeGeometry(0.012, front ? 0.09 : 0.06, 4).rotateX(Math.PI / 2 + 0.6).translate(x, -lowerLen - 0.02, 0.16), BEAR.claw, 0.04, k));
      }
      return merge([
        shade(new THREE.CylinderGeometry(0.11, 0.1, lowerLen, 8).translate(0, -lowerLen / 2, 0), BEAR.dark, BEAR.fur, -lowerLen, 0),
        paint(new THREE.SphereGeometry(1, 9, 6).scale(0.12, 0.07, 0.17).translate(0, -lowerLen + 0.02, 0.06), BEAR.dark, 0.06), // paw
        ...claws,
      ]);
    }),
  };
}

export function bearModel(): THREE.Group {
  const root = new THREE.Group();
  root.name = 'bear';
  const jaw = pivot('jaw', 0, -0.12, 0.16, mesh(bearJawGeo()));
  const head = pivot('head', 0, 0.02, 0.34, mesh(bearHeadGeo()), jaw);
  head.scale.setScalar(1.15);
  const neck = pivot('neck', 0, 0.22, 1.3, mesh(cached('bear:neck', () => merge([
    shade(new THREE.CylinderGeometry(0.22, 0.3, 0.42, 9).rotateX(Math.PI / 2 - 0.35).translate(0, 0.0, 0.16), BEAR.fur, BEAR.light, -0.2, 0.2),
    ...furTufts(0, 0, 0.15, 0.27, 0.25, 0.22, 14, 71),
  ]))), head);
  const leg = (name: string, x: number, y: number, z: number, front: boolean): THREE.Group => {
    const g = bearLegGeos(front);
    const lower = pivot('lower', 0, -(front ? 0.42 : 0.4), 0, mesh(g.lower, false));
    return pivot(name, x, y, z, mesh(g.upper, false), lower);
  };
  const tail = pivot('tail', 0, 0.12, -0.32, mesh(cached('bear:tail', () => merge([paint(new THREE.SphereGeometry(0.08, 6, 5).scale(1, 0.9, 1.3), BEAR.dark, 0.08)])), false));
  // The spine pivots at the hips: rotating it about X makes the bear rear up.
  const spine = pivot('spine', 0, 0.86, -0.5, mesh(bearTorso()), neck, tail,
    leg('legFL', 0.24, -0.04, 1.12, true), leg('legFR', -0.24, -0.04, 1.12, true));
  // Hind legs hang from the hips on the root, so they stay planted when it rears.
  root.add(spine, leg('legBL', 0.26, 0.82, -0.48, false), leg('legBR', -0.26, 0.82, -0.48, false));
  return root;
}
