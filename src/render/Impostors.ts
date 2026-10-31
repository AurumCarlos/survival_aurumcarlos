import * as THREE from 'three';
import { MIP_ALPHA_GLSL, foliageMaterial } from './Foliage';
import { flatMaterial, propGeometry } from './LowPolyFactory';
import { skyAmbient } from './Materials';

/**
 * Tree impostors for the far distance. Each tree shape's detailed mesh is
 * rendered once, from the side, into one cell of a texture atlas; far trees
 * are then two crossed, alpha-tested quads with that picture — 4 triangles
 * instead of several hundred, so a 1000 m view of a forest costs almost
 * nothing. Only the albedo is baked (ambient light only, no fog); the quads
 * are lit live like the terrain, so they follow the time of day and the haze.
 */

const CELL_W = 256;
const CELL_H = 512;
const COLS = 8;

export interface TreeImpostors {
  material: THREE.MeshLambertMaterial;
  /** Crossed quads for a tree shape (see TreeSpecies.treeShape), in the tree's local space. */
  geometry: Map<number, THREE.BufferGeometry>;
  dispose(): void;
}

export function bakeTreeImpostors(renderer: THREE.WebGLRenderer, shapes: readonly number[]): TreeImpostors {
  const rows = Math.max(1, Math.ceil(shapes.length / COLS));
  const W = COLS * CELL_W, H = rows * CELL_H;
  const target = new THREE.WebGLRenderTarget(W, H, {
    samples: 4, // smooth silhouettes
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
  });
  target.texture.colorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 1));
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  const mesh = new THREE.Mesh(undefined, [flatMaterial, foliageMaterial()]);
  scene.add(mesh);

  // Save what we change on the shared renderer and materials.
  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevAutoClear = renderer.autoClear;
  const prevSky = skyAmbient.value.clone();
  skyAmbient.value.setRGB(0, 0, 0);

  renderer.setRenderTarget(target);
  // Transparent, but leaf-coloured: mipmaps blend edges toward green, not black.
  renderer.setClearColor(0x34482a, 0);
  renderer.clear();
  renderer.autoClear = false;
  target.scissorTest = true;

  const geometry = new Map<number, THREE.BufferGeometry>();
  const box = new THREE.Box3();
  shapes.forEach((shape, i) => {
    const g = propGeometry('tree', shape); // the detailed model: a full crown, baked once
    mesh.geometry = g;
    box.setFromBufferAttribute(g.attributes['position'] as THREE.BufferAttribute);
    const r = Math.max(-box.min.x, box.max.x, -box.min.z, box.max.z);
    const h = box.max.y - box.min.y;
    // Frame the tree in a 1:2 cell, standing on the bottom edge.
    const worldW = Math.max(2 * r, h / 2) * 1.04, worldH = worldW * 2;
    camera.left = -worldW / 2;
    camera.right = worldW / 2;
    camera.bottom = 0;
    camera.top = worldH;
    camera.position.set(0, box.min.y, 50);
    camera.lookAt(0, box.min.y, 0);
    camera.updateProjectionMatrix();
    const col = i % COLS, row = Math.floor(i / COLS);
    target.viewport.set(col * CELL_W, row * CELL_H, CELL_W, CELL_H);
    target.scissor.copy(target.viewport);
    renderer.setRenderTarget(target); // re-applies viewport and scissor
    renderer.render(scene, camera);
    geometry.set(shape, crossedQuads(worldW, worldH, box.min.y, col / COLS, row / rows, 1 / COLS, 1 / rows));
  });

  target.scissorTest = false;
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(prevClear, prevAlpha);
  renderer.autoClear = prevAutoClear;
  skyAmbient.value.copy(prevSky);
  mesh.geometry = new THREE.BufferGeometry();

  const material = new THREE.MeshLambertMaterial({ map: target.texture, alphaTest: 0.35, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    // Both faces lit as if facing up (like a canopy seen from afar), plus the sky's ambient light.
    shader.uniforms['uSkyAmbient'] = skyAmbient;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uSkyAmbient;')
      .replace('#include <map_fragment>', `#include <map_fragment>\n${MIP_ALPHA_GLSL(W, H)}`)
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n  normal = normalize(vNormal);')
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n  reflectedLight.indirectDiffuse += diffuseColor.rgb * uSkyAmbient;');
  };
  material.customProgramCacheKey = () => 'tree-impostor-v2';

  return {
    material,
    geometry,
    dispose: () => {
      target.dispose();
      material.dispose();
      for (const g of geometry.values()) g.dispose();
    },
  };
}

/** Two quads crossing on the Y axis, base at `y0`, mapped to one atlas cell. Normals point up (see the material). */
function crossedQuads(w: number, h: number, y0: number, u0: number, v0: number, du: number, dv: number): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], nrm: number[] = [], idx: number[] = [];
  for (const [ax, az] of [[1, 0], [0, 1]] as const) {
    const b = pos.length / 3;
    for (const [s, t] of [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]] as const) {
      pos.push(ax * s * w, y0 + t * h, az * s * w);
      uv.push(u0 + (s + 0.5) * du, v0 + t * dv);
      nrm.push(0, 1, 0);
    }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}
