import * as THREE from 'three';

const DROPS = 3000;
/** Slightly blue-grey streaks. */
const TINT = new THREE.Color(0.94, 1, 1.08);
/** Box of rain around the camera (m). */
const SPAN = 36;
const HEIGHT = 22;

/**
 * Rain streaks. All the motion is in the vertex shader: each drop has a
 * fixed random spot in a box that wraps around the camera (so the rain is
 * anchored to the world as you walk) and falls with time, slanted by the
 * wind. `intensity` (0..1) sets how many drops are drawn, so drizzle and
 * downpour are the same draw call. Zero CPU work per frame beyond uniforms.
 */
export class Rain {
  readonly object: THREE.LineSegments;
  private readonly uniforms = {
    uTime: { value: 0 },
    uCamera: { value: new THREE.Vector3() },
    uIntensity: { value: 0 },
    uColor: { value: new THREE.Color(0.75, 0.8, 0.88) },
  };

  constructor() {
    const seeds = new Float32Array(DROPS * 2 * 4);
    const ends = new Float32Array(DROPS * 2);
    const pos = new Float32Array(DROPS * 2 * 3); // unused by the shader, needed by three
    let s = 12345;
    const rnd = (): number => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < DROPS; i++) {
      const x = rnd() * SPAN, z = rnd() * SPAN, phase = rnd() * HEIGHT, keep = rnd();
      for (let k = 0; k < 2; k++) {
        seeds.set([x, z, phase, keep], (i * 2 + k) * 4);
        ends[i * 2 + k] = k;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('seed', new THREE.BufferAttribute(seeds, 4));
    geo.setAttribute('end', new THREE.BufferAttribute(ends, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute vec4 seed;
        attribute float end;
        uniform float uTime;
        uniform vec3 uCamera;
        uniform float uIntensity;
        varying float vAlpha;
        const float SPAN = ${SPAN.toFixed(1)};
        const float HEIGHT = ${HEIGHT.toFixed(1)};
        void main() {
          // Wrap the drop's spot into the box centred on the camera (world-anchored).
          vec2 xz = mod(seed.xy - uCamera.xz + SPAN * 0.5, SPAN) + uCamera.xz - SPAN * 0.5;
          float y = uCamera.y + HEIGHT * 0.5 - mod(seed.z + uTime * 17.0, HEIGHT);
          vec3 wind = vec3(1.6, 0.0, 0.7);
          vec3 p = vec3(xz.x, y, xz.y) + wind * (y - uCamera.y) * 0.08;
          // The streak: from the drop down 0.7 m along its fall direction.
          p -= normalize(vec3(wind.x * 0.08, 1.0, wind.z * 0.08)) * end * 0.7;
          vAlpha = seed.w < uIntensity ? (1.0 - end * 0.7) : 0.0;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          if (vAlpha <= 0.0) discard;
          gl_FragColor = vec4(uColor, vAlpha * 0.35);
        }`,
    });
    this.object = new THREE.LineSegments(geo, mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = 2;
    this.object.visible = false;
  }

  /** `light` (0..1 daylight) dims the streaks at night. */
  update(time: number, camera: THREE.Vector3, intensity: number, light: number): void {
    this.object.visible = intensity > 0.01;
    this.uniforms.uTime.value = time;
    this.uniforms.uCamera.value.copy(camera);
    this.uniforms.uIntensity.value = intensity;
    this.uniforms.uColor.value.copy(TINT).multiplyScalar(0.2 + 0.6 * light);
  }
}
