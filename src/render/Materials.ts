import * as THREE from 'three';
import { grainTexture, terrainTextures, waterNormalTexture } from './Textures';

/**
 * Materials for the realistic look: stock three materials (so shadows, fog
 * and tone mapping keep working) patched with onBeforeCompile. Terrain and
 * props are Lambert + a sky-ambient term (cheap enough for integrated GPUs);
 * only the water is PBR, for its sky reflections:
 *
 *  - terrain: five texture layers blended per vertex and by height, planar on
 *    the ground and triplanar on rock faces, with anti-tiling;
 *  - detail: vertex colours × a triplanar grain (normal + cavity), for every
 *    procedural prop, creature and structure — no UVs needed;
 *  - water: two scrolling wave normal maps reflecting the sky.
 */

/** Seconds since start; advanced by Renderer.render(), read by animated shaders. */
export const shaderTime = { value: 0 };

/**
 * Sky light for the Lambert materials (terrain, props, leaves), which don't
 * sample the environment map; set every frame by Renderer from the haze colour.
 */
export const skyAmbient = { value: new THREE.Color(0.3, 0.33, 0.36) };

/** World position + world normal varyings, batching- and instancing-aware. Inserted after project_vertex. */
const WORLD_VARYINGS_VERT = /* glsl */ `
  {
    vec4 tWp = vec4(transformed, 1.0);
    mat3 tIm = mat3(1.0);
    #ifdef USE_BATCHING
      tWp = batchingMatrix * tWp;
      tIm = mat3(batchingMatrix);
    #endif
    #ifdef USE_INSTANCING
      tWp = instanceMatrix * tWp;
      tIm = tIm * mat3(instanceMatrix);
    #endif
    tWp = modelMatrix * tWp;
    vTPos = tWp.xyz;
    vTNrm = normalize(mat3(modelMatrix) * tIm * objectNormal);
  }
`;

/** Ben Golus' "whiteout" triplanar normal blend. n* are tangent-space normals (−1..1). */
const TRIPLANAR_GLSL = /* glsl */ `
  vec3 tBlendWeights(vec3 N, float sharp) {
    vec3 w = pow(abs(N), vec3(sharp));
    return w / (w.x + w.y + w.z);
  }
  vec3 tWhiteout(vec3 nX, vec3 nY, vec3 nZ, vec3 N, vec3 w) {
    nX = vec3(nX.xy + N.zy, abs(nX.z) * N.x);
    nY = vec3(nY.xy + N.xz, abs(nY.z) * N.y);
    nZ = vec3(nZ.xy + N.xy, abs(nZ.z) * N.z);
    return normalize(nX.zyx * w.x + nY.xzy * w.y + nZ.xyz * w.z);
  }
`;

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

/** Tiling size in metres of each layer (sand, grass, dirt, rock, snow). */
const LAYER_TILE = [3.2, 2.6, 2.8, 5.5, 6.0];

/**
 * Lambert, not PBR: the ground is matte, and on an integrated GPU the PBR
 * terrain (GGX + environment-map lookups over the whole screen) cost ~10 ms a
 * frame. Sky light comes from `skyAmbient` instead of the environment map.
 * The five layers are unrolled by hand: arrays indexed in a loop spill to
 * memory on Intel GPUs.
 */
export function createTerrainMaterial(): THREE.MeshLambertMaterial {
  const { albedo, normal } = terrainTextures();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms['uAlbedo'] = { value: albedo };
    shader.uniforms['uNormalArr'] = { value: normal };
    shader.uniforms['uTile'] = { value: LAYER_TILE.map((m) => 1 / m) };
    shader.uniforms['uSkyAmbient'] = skyAmbient;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 layersA;
        attribute float layersB;
        varying vec4 vLayA;
        varying float vLayB;
        varying vec3 vTPos;
        varying vec3 vTNrm;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        vLayA = layersA;
        vLayB = layersB;
        ${WORLD_VARYINGS_VERT}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform highp sampler2DArray uAlbedo;
        uniform highp sampler2DArray uNormalArr;
        uniform float uTile[5];
        uniform vec3 uSkyAmbient;
        varying vec4 vLayA;
        varying float vLayB;
        varying vec3 vTPos;
        varying vec3 vTNrm;
        ${TRIPLANAR_GLSL}
        // One planar sample per layer; a low-frequency mask shifts the UVs
        // and the brightness to hide the tiling. Returns albedo (a = height)
        // and the world-space normal.
        vec4 tPlanar(float layer, float tile, float mask, vec3 N, out vec3 n) {
          vec2 uv = vTPos.xz * tile + vec2(mask * 0.11, mask * 0.07);
          vec4 a = texture(uAlbedo, vec3(uv, layer));
          vec3 t = texture(uNormalArr, vec3(uv, layer)).xyz * 2.0 - 1.0;
          n = normalize(vec3(t.x + N.x, abs(t.z) * N.y, t.y + N.z));
          a.rgb *= 0.88 + mask * 0.24;
          return a;
        }
        // Rock: triplanar so cliffs aren't smeared.
        vec4 tRock(float tile, vec3 N, out vec3 n) {
          vec3 bw = tBlendWeights(N, 4.0);
          vec4 ax = texture(uAlbedo, vec3(vTPos.zy * tile, 3.0)), ay = texture(uAlbedo, vec3(vTPos.xz * tile, 3.0)), az = texture(uAlbedo, vec3(vTPos.xy * tile, 3.0));
          vec3 nx = texture(uNormalArr, vec3(vTPos.zy * tile, 3.0)).xyz, ny = texture(uNormalArr, vec3(vTPos.xz * tile, 3.0)).xyz, nz = texture(uNormalArr, vec3(vTPos.xy * tile, 3.0)).xyz;
          n = tWhiteout(nx * 2.0 - 1.0, ny * 2.0 - 1.0, nz * 2.0 - 1.0, N, bw);
          return ax * bw.x + ay * bw.y + az * bw.z;
        }
        vec3 tTerrainN;`)
      .replace('#include <map_fragment>', `
        {
          vec3 N = normalize(vTNrm);
          float mask = smoothstep(0.3, 0.7, texture(uAlbedo, vec3(vTPos.xz * 0.011, 1.0)).a);
          float w0 = vLayA.x, w1 = vLayA.y, w2 = vLayA.z, w3 = vLayA.w, w4 = vLayB;
          vec4 a0 = vec4(0.0), a1 = vec4(0.0), a2 = vec4(0.0), a3 = vec4(0.0), a4 = vec4(0.0);
          vec3 n0 = N, n1 = N, n2 = N, n3 = N, n4 = N;
          if (w0 > 0.002) a0 = tPlanar(0.0, uTile[0], mask, N, n0);
          if (w1 > 0.002) a1 = tPlanar(1.0, uTile[1], mask, N, n1);
          if (w2 > 0.002) a2 = tPlanar(2.0, uTile[2], mask, N, n2);
          if (w3 > 0.002) a3 = tRock(uTile[3], N, n3);
          if (w4 > 0.002) a4 = tPlanar(4.0, uTile[4], mask, N, n4);
          // Height blend: the taller layer (pebbles, grass clumps) pokes through at transitions.
          float h0 = a0.a + w0, h1 = a1.a + w1, h2 = a2.a + w2, h3 = a3.a + w3, h4 = a4.a + w4;
          float hmax = max(max(max(h0, h1), max(h2, h3)), h4) - 0.25;
          float b0 = max(h0 - hmax, 0.0) * w0, b1 = max(h1 - hmax, 0.0) * w1, b2 = max(h2 - hmax, 0.0) * w2;
          float b3 = max(h3 - hmax, 0.0) * w3, b4 = max(h4 - hmax, 0.0) * w4;
          float wsum = max(b0 + b1 + b2 + b3 + b4, 1e-4);
          diffuseColor.rgb = (a0.rgb * b0 + a1.rgb * b1 + a2.rgb * b2 + a3.rgb * b3 + a4.rgb * b4) / wsum;
          tTerrainN = normalize(n0 * b0 + n1 * b1 + n2 * b2 + n3 * b3 + n4 * b4);
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = normalize((viewMatrix * vec4(tTerrainN, 0.0)).xyz);`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        reflectedLight.indirectDiffuse += diffuseColor.rgb * uSkyAmbient;`);
  };
  mat.customProgramCacheKey = () => 'terrain-v2';
  return mat;
}

// ---------------------------------------------------------------------------
// Props, creatures, structures
// ---------------------------------------------------------------------------

export interface DetailOptions extends THREE.MeshLambertMaterialParameters {
  /** Metres per grain tile. */
  grainScale?: number;
  /** 0..1: how strongly the grain bends normals. */
  grainStrength?: number;
}

/** Lambert (like the terrain) + sky ambient: props are mostly matte, and PBR cost too much fill. */
export function createDetailMaterial(o: DetailOptions = {}): THREE.MeshLambertMaterial {
  const { grainScale = 0.9, grainStrength = 0.8, ...params } = o;
  const grain = grainTexture();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, ...params });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms['uSkyAmbient'] = skyAmbient;
    shader.uniforms['uGrain'] = { value: grain };
    shader.uniforms['uGrainScale'] = { value: 1 / grainScale };
    shader.uniforms['uGrainStrength'] = { value: grainStrength };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTPos;
        varying vec3 vTNrm;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        ${WORLD_VARYINGS_VERT}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uGrain;
        uniform float uGrainScale;
        uniform float uGrainStrength;
        uniform vec3 uSkyAmbient;
        varying vec3 vTPos;
        varying vec3 vTNrm;
        ${TRIPLANAR_GLSL}
        vec3 tDetailN;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 N = normalize(vTNrm);
          #ifdef DOUBLE_SIDED
            N *= gl_FrontFacing ? 1.0 : -1.0;
          #endif
          vec3 bw = tBlendWeights(N, 3.0);
          // Side projections are stretched vertically: bark fibres and rock strata.
          vec3 p = vTPos * uGrainScale;
          vec4 gx = texture2D(uGrain, p.zy * vec2(1.0, 0.35)), gy = texture2D(uGrain, p.xz), gz = texture2D(uGrain, p.xy * vec2(1.0, 0.35));
          vec4 gf = texture2D(uGrain, p.xz * 0.23 + p.y * 0.11); // large blotches
          float h = gx.a * bw.x + gy.a * bw.y + gz.a * bw.z;
          diffuseColor.rgb *= mix(0.62, 1.12, h) * mix(0.85, 1.1, gf.a);
          vec3 nx = (gx.xyz * 2.0 - 1.0) * vec3(uGrainStrength, uGrainStrength, 1.0);
          vec3 ny = (gy.xyz * 2.0 - 1.0) * vec3(uGrainStrength, uGrainStrength, 1.0);
          vec3 nz = (gz.xyz * 2.0 - 1.0) * vec3(uGrainStrength, uGrainStrength, 1.0);
          tDetailN = tWhiteout(nx, ny, nz, N, bw);
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = normalize((viewMatrix * vec4(tDetailN, 0.0)).xyz);`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        reflectedLight.indirectDiffuse += diffuseColor.rgb * uSkyAmbient;`);
  };
  mat.customProgramCacheKey = () => `detail-v2-${grainScale}-${grainStrength}`;
  return mat;
}

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------

export function createWaterMaterial(): THREE.MeshStandardMaterial {
  const waves = waterNormalTexture();
  const mat = new THREE.MeshStandardMaterial({
    color: 0x155a66, roughness: 0.14, metalness: 0.0, transparent: true, opacity: 0.72, depthWrite: false,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms['uWaves'] = { value: waves };
    shader.uniforms['uTime'] = shaderTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTPos;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        vTPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uWaves;
        uniform float uTime;
        varying vec3 vTPos;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec2 p = vTPos.xz;
          vec3 a = texture2D(uWaves, p * 0.07 + vec2(uTime * 0.012, uTime * 0.007)).xyz * 2.0 - 1.0;
          vec3 b = texture2D(uWaves, p * 0.19 + vec2(-uTime * 0.017, uTime * 0.021)).xyz * 2.0 - 1.0;
          vec3 c = texture2D(uWaves, p * 0.013 + vec2(uTime * 0.003, -uTime * 0.004)).xyz * 2.0 - 1.0;
          vec3 n = normalize(vec3(a.xy * 0.16 + b.xy * 0.1 + c.xy * 0.2, 1.0));
          normal = normalize((viewMatrix * vec4(n.x, n.z, n.y, 0.0)).xyz);
        }`)
      .replace('#include <opaque_fragment>', `
        // Fresnel: see-through looking down, a sky mirror toward the horizon.
        {
          float facing = clamp(abs(dot(normalize(-vViewPosition), normal)), 0.0, 1.0);
          diffuseColor.a = mix(0.95, diffuseColor.a, facing);
        }
        #include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => 'water-v1';
  return mat;
}
