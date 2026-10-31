import * as THREE from 'three';
import type { CreatureSpecies } from '../components';
import { cached, flatMaterial, merge, paint } from './LowPolyFactory';
import { bearModel, crocodileModel } from './ApexModels';

/**
 * Low-poly animal models, built from primitives at real-world size, facing
 * +Z with feet at y = 0. Each model is a Group with animatable pivots:
 *
 *   body (static mesh) · head (pivot at the neck) · leg0..3 (pivots at the
 *   hips/shoulders: 0 front-left, 1 front-right, 2 back-left, 3 back-right)
 *   · tail (pivot at its root)
 *
 * CreatureAnimationSystem swings the legs with walking speed. Fur is
 * counter-shaded (darker back, lighter belly) with per-face colour jitter.
 */

/** Paints each triangle by its height: `top` above y1, `bottom` below y0, blended between. */
function shade(geo: THREE.BufferGeometry, top: number, bottom: number, y0: number, y1: number, jitter = 0.07, seed = 1): THREE.BufferGeometry {
  const g = paint(geo, top, 0, seed);
  const pos = g.attributes['position']!, col = g.attributes['color']!;
  const a = new THREE.Color(bottom), b = new THREE.Color(top), c = new THREE.Color();
  for (let tri = 0; tri < pos.count / 3; tri++) {
    const y = (pos.getY(tri * 3) + pos.getY(tri * 3 + 1) + pos.getY(tri * 3 + 2)) / 3;
    const t = Math.min(1, Math.max(0, (y - y0) / (y1 - y0)));
    const v = 1 + (Math.sin((tri + seed) * 91.7) * 0.5) * 2 * jitter;
    c.copy(a).lerp(b, t).multiplyScalar(v);
    for (let k = 0; k < 3; k++) col.setXYZ(tri * 3 + k, Math.min(1, c.r), Math.min(1, c.g), Math.min(1, c.b));
  }
  return g;
}

/**
 * Each animal is 7 meshes (body, head, 4 legs, tail) so the legs can move.
 * Only the body and head cast shadows: thin legs/tail barely show in the
 * shadow map but would double their draw calls.
 */
const mesh = (g: THREE.BufferGeometry, castShadow = true): THREE.Mesh => {
  const m = new THREE.Mesh(g, flatMaterial);
  m.castShadow = castShadow;
  m.receiveShadow = true;
  return m;
};

interface LegSpec {
  hipY: number;
  upper: number;
  lower: number;
  rTop: number;
  rBottom: number;
  hoof: number;
  fur: number;
  hoofColor: number;
}

/** A leg hanging down from its pivot: thigh, shin, hoof/paw. Bottom lands exactly on y = −hipY. */
function legGeometry(key: string, s: LegSpec): THREE.BufferGeometry {
  return cached(`leg:${key}`, () => {
    const shin = s.hipY - s.upper - s.hoof;
    return merge([
      paint(new THREE.CylinderGeometry(s.rTop, s.rTop * 0.75, s.upper, 6).translate(0, -s.upper / 2, 0), s.fur, 0.06),
      paint(new THREE.CylinderGeometry(s.rTop * 0.7, s.rBottom, shin, 6).translate(0, -s.upper - shin / 2, 0.01), s.fur, 0.06),
      paint(new THREE.CylinderGeometry(s.rBottom * 1.15, s.rBottom * 1.3, s.hoof, 6).translate(0, -s.hipY + s.hoof / 2, 0.015), s.hoofColor, 0.04),
    ]);
  });
}

function assemble(
  name: string, body: THREE.BufferGeometry, head: THREE.BufferGeometry, headPivot: THREE.Vector3,
  leg: THREE.BufferGeometry, hips: Array<[number, number]>, hipY: number, tail: THREE.BufferGeometry, tailPivot: THREE.Vector3,
): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  const b = mesh(body);
  b.name = 'body';
  g.add(b);
  const hp = new THREE.Group();
  hp.name = 'head';
  hp.position.copy(headPivot);
  hp.add(mesh(head));
  g.add(hp);
  hips.forEach(([x, z], i) => {
    const l = new THREE.Group();
    l.name = `leg${i}`;
    l.position.set(x, hipY, z);
    l.add(mesh(leg, false));
    g.add(l);
  });
  const tp = new THREE.Group();
  tp.name = 'tail';
  tp.position.copy(tailPivot);
  tp.add(mesh(tail, false));
  g.add(tp);
  return g;
}

// ---------------------------------------------------------------------------

function deer(): THREE.Group {
  const back = 0x9a6638, belly = 0xe6d3b0;
  const body = cached('deer:body', () => merge([
    shade(new THREE.CapsuleGeometry(0.22, 0.72, 3, 8).rotateX(Math.PI / 2).scale(1, 1.08, 1).translate(0, 0.98, 0), back, belly, 0.8, 1.12),
    shade(new THREE.CylinderGeometry(0.085, 0.13, 0.5, 7).rotateX(-0.62).translate(0, 1.2, 0.5), back, belly, 1.05, 1.3, 0.07, 3), // neck
    paint(new THREE.IcosahedronGeometry(0.15, 0).scale(1, 0.9, 1).translate(0, 0.98, -0.45), 0xd9c4a0, 0.05), // white rump patch
  ]));
  const head = cached('deer:head', () => merge([
    shade(new THREE.CylinderGeometry(0.05, 0.1, 0.32, 7).rotateX(Math.PI / 2 + 0.25).translate(0, -0.02, 0.12), back, belly, -0.1, 0.05), // muzzle
    paint(new THREE.IcosahedronGeometry(0.105, 0).translate(0, 0.02, -0.02), back, 0.06), // skull
    paint(new THREE.IcosahedronGeometry(0.03, 0).translate(0, -0.06, 0.28), 0x221a16, 0), // nose
    paint(new THREE.ConeGeometry(0.045, 0.16, 4).rotateZ(1.0).translate(-0.12, 0.1, -0.04), back, 0.05), // ears
    paint(new THREE.ConeGeometry(0.045, 0.16, 4).rotateZ(-1.0).translate(0.12, 0.1, -0.04), back, 0.05),
    // Antlers: a main beam with two tines per side.
    ...[-1, 1].flatMap((side) => [
      paint(new THREE.CylinderGeometry(0.012, 0.02, 0.36, 5).rotateZ(-side * 0.45).rotateX(-0.25).translate(side * 0.1, 0.25, -0.05), 0x6b5a45, 0.08),
      paint(new THREE.CylinderGeometry(0.009, 0.014, 0.18, 4).rotateZ(side * 0.2).rotateX(0.5).translate(side * 0.15, 0.3, 0.03), 0x6b5a45, 0.08),
      paint(new THREE.CylinderGeometry(0.008, 0.012, 0.15, 4).rotateZ(-side * 0.9).translate(side * 0.2, 0.36, -0.07), 0x6b5a45, 0.08),
    ]),
  ]));
  const spec: LegSpec = { hipY: 0.86, upper: 0.4, lower: 0.38, rTop: 0.06, rBottom: 0.022, hoof: 0.06, fur: 0x8f5f35, hoofColor: 0x2a221c };
  const tail = cached('deer:tail', () => merge([paint(new THREE.ConeGeometry(0.05, 0.14, 5).rotateX(-2.4).translate(0, 0.02, -0.05), 0xf0e6d6, 0.04)]));
  return assemble('deer', body, head, new THREE.Vector3(0, 1.43, 0.66), legGeometry('deer', spec),
    [[-0.12, 0.38], [0.12, 0.38], [-0.12, -0.38], [0.12, -0.38]], spec.hipY, tail, new THREE.Vector3(0, 1.05, -0.58));
}

function wolf(): THREE.Group {
  const back = 0x5e5f66, belly = 0xcfcbc2;
  const body = cached('wolf:body', () => merge([
    shade(new THREE.CapsuleGeometry(0.2, 0.62, 3, 8).rotateX(Math.PI / 2).translate(0, 0.66, -0.02), back, belly, 0.52, 0.8),
    shade(new THREE.IcosahedronGeometry(0.25, 1).scale(1, 1.05, 0.95).translate(0, 0.7, 0.32), back, belly, 0.55, 0.85, 0.07, 2), // chest ruff
  ]));
  const head = cached('wolf:head', () => merge([
    shade(new THREE.IcosahedronGeometry(0.15, 0).scale(1, 0.95, 1.05), back, belly, -0.1, 0.08), // skull
    shade(new THREE.CylinderGeometry(0.045, 0.085, 0.24, 6).rotateX(Math.PI / 2 + 0.1).translate(0, -0.04, 0.17), back, belly, -0.1, 0.0, 0.06, 4), // snout
    paint(new THREE.IcosahedronGeometry(0.03, 0).translate(0, -0.03, 0.3), 0x15130f, 0), // nose
    paint(new THREE.ConeGeometry(0.05, 0.14, 4).translate(-0.08, 0.15, -0.03), 0x4c4d53, 0.05), // pointed ears
    paint(new THREE.ConeGeometry(0.05, 0.14, 4).translate(0.08, 0.15, -0.03), 0x4c4d53, 0.05),
    paint(new THREE.IcosahedronGeometry(0.018, 0).translate(-0.065, 0.03, 0.12), 0xe8c04a, 0), // eyes
    paint(new THREE.IcosahedronGeometry(0.018, 0).translate(0.065, 0.03, 0.12), 0xe8c04a, 0),
  ]));
  const spec: LegSpec = { hipY: 0.6, upper: 0.3, lower: 0.25, rTop: 0.065, rBottom: 0.032, hoof: 0.05, fur: 0x55565c, hoofColor: 0x3a3a3e };
  const tail = cached('wolf:tail', () => merge([shade(new THREE.ConeGeometry(0.085, 0.5, 6).rotateX(-2.5).translate(0, -0.2, -0.17), back, 0x2f2f33, -0.4, 0.0)]));
  return assemble('wolf', body, head, new THREE.Vector3(0, 0.86, 0.56), legGeometry('wolf', spec),
    [[-0.11, 0.3], [0.11, 0.3], [-0.11, -0.32], [0.11, -0.32]], spec.hipY, tail, new THREE.Vector3(0, 0.74, -0.44));
}

function boar(): THREE.Group {
  const back = 0x3e3029, belly = 0x6a5446;
  const body = cached('boar:body', () => {
    const bristles: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 7; i++) {
      bristles.push(paint(new THREE.ConeGeometry(0.04, 0.12, 3).translate(0, 0.9 + Math.sin(i / 6 * Math.PI) * 0.04, 0.32 - i * 0.1), 0x251c17, 0.05, i));
    }
    return merge([
      shade(new THREE.CapsuleGeometry(0.3, 0.5, 3, 8).rotateX(Math.PI / 2).scale(0.95, 1.08, 1).translate(0, 0.56, 0), back, belly, 0.3, 0.75),
      ...bristles,
    ]);
  });
  const head = cached('boar:head', () => merge([
    shade(new THREE.ConeGeometry(0.21, 0.46, 7).rotateX(Math.PI / 2).translate(0, -0.03, 0.18), back, belly, -0.2, 0.1), // wedge head
    paint(new THREE.CylinderGeometry(0.075, 0.075, 0.05, 8).rotateX(Math.PI / 2).translate(0, -0.06, 0.41), 0x8a6a62, 0.03), // snout disc
    paint(new THREE.ConeGeometry(0.02, 0.13, 4).rotateX(-0.6).rotateZ(0.5).translate(-0.08, -0.05, 0.33), 0xf2ead8, 0), // tusks
    paint(new THREE.ConeGeometry(0.02, 0.13, 4).rotateX(-0.6).rotateZ(-0.5).translate(0.08, -0.05, 0.33), 0xf2ead8, 0),
    paint(new THREE.ConeGeometry(0.06, 0.12, 4).rotateZ(0.7).translate(-0.13, 0.12, -0.03), back, 0.05), // ears
    paint(new THREE.ConeGeometry(0.06, 0.12, 4).rotateZ(-0.7).translate(0.13, 0.12, -0.03), back, 0.05),
    paint(new THREE.IcosahedronGeometry(0.016, 0).translate(-0.1, 0.05, 0.14), 0x120d0a, 0), // eyes
    paint(new THREE.IcosahedronGeometry(0.016, 0).translate(0.1, 0.05, 0.14), 0x120d0a, 0),
  ]));
  const spec: LegSpec = { hipY: 0.38, upper: 0.18, lower: 0.14, rTop: 0.075, rBottom: 0.04, hoof: 0.05, fur: 0x35291f, hoofColor: 0x1b1512 };
  const tail = cached('boar:tail', () => merge([paint(new THREE.CylinderGeometry(0.012, 0.02, 0.18, 4).rotateX(-2.6).translate(0, -0.06, -0.06), back, 0.05)]));
  return assemble('boar', body, head, new THREE.Vector3(0, 0.6, 0.5), legGeometry('boar', spec),
    [[-0.15, 0.3], [0.15, 0.3], [-0.15, -0.3], [0.15, -0.3]], spec.hipY, tail, new THREE.Vector3(0, 0.68, -0.52));
}

export function creatureMesh(species: CreatureSpecies): THREE.Group {
  switch (species) {
    case 'deer': return deer();
    case 'wolf': return wolf();
    case 'crocodile': return crocodileModel();
    case 'bear': return bearModel();
    default: return boar();
  }
}
