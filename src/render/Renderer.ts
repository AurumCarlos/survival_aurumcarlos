import * as THREE from 'three';
import { defineComponent } from '../core/ecs/World';
import type { ViewportTarget } from '../core/Lifecycle';
import type { DayNightCycle } from '../systems/DayNightCycle';
import { Sky } from 'three/addons/objects/Sky.js';
import { shaderTime, skyAmbient } from './Materials';

/** Handle component: the Three.js object that visualises an entity. */
export interface RenderObject {
  object: THREE.Object3D;
  /** Interpolate between fixed steps (moving things). Static props set false. */
  interpolate: boolean;
}
export const RenderObject = defineComponent<RenderObject>('RenderObject');

// Horizon haze colours (the fog and the bottom of the sky fade into these).
const HAZE_DAY = new THREE.Color(0xc6d8e6);
const HAZE_DUSK = new THREE.Color(0xd9a47c);
const HAZE_NIGHT = new THREE.Color(0x0a1220);
const DAY_SKY = new THREE.Color(0xbfd4e8);
/** Automatic quality aims for this frame rate (see Renderer.adaptQuality). */
const TARGET_FPS = 60;
/** From best to cheapest: internal resolution scale and shadow/detail tier. */
const QUALITY_LADDER: ReadonlyArray<{ scale: number; tier: 0 | 1 | 2 }> = [
  { scale: 1, tier: 2 }, { scale: 0.85, tier: 2 }, { scale: 0.7, tier: 2 }, { scale: 0.7, tier: 1 }, { scale: 0.6, tier: 1 },
  { scale: 0.7, tier: 0 }, { scale: 0.6, tier: 0 }, { scale: 0.5, tier: 0 }, { scale: 0.42, tier: 0 },
];
const MOON_SKY = new THREE.Color(0x5d78b0);

/**
 * Scene, camera, lights and the WebGL renderer. The realistic look comes
 * from PBR materials (see Materials.ts) lit by a single shadow-casting sun, a
 * physically based sky that also lights the scene through an environment map,
 * ACES filmic tone mapping and distance haze.
 */
export class Renderer implements ViewportTarget {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  // Fill light under the environment map: keeps forest shade and night from going pitch black.
  readonly hemi = new THREE.HemisphereLight(0xbfd4e8, 0x5a5440, 0.35);
  readonly sky = new Sky();
  private readonly fog: THREE.Fog;
  private readonly tmpColor = new THREE.Color();
  private readonly sunDir = new THREE.Vector3();
  private readonly pmrem: THREE.PMREMGenerator;
  private readonly envScene = new THREE.Scene();
  private readonly envSky = new Sky();
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private envSunY = Number.NaN;
  private envAt = 0;
  private readonly clock = new THREE.Clock();

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      // Avoid a mandatory buffer copy each frame; we never read pixels back.
      preserveDrawingBuffer: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.62;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap; // soft PCF costs too much fill on integrated GPUs
    this.pmrem = new THREE.PMREMGenerator(this.renderer);

    this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 400);
    this.fog = new THREE.Fog(HAZE_DAY.getHex(), 40, 160);
    this.scene.fog = this.fog;
    this.scene.background = null;

    for (const sky of [this.sky, this.envSky]) {
      const u = sky.material.uniforms;
      u['turbidity']!.value = 4.5;
      u['rayleigh']!.value = 1.4;
      u['mieCoefficient']!.value = 0.004;
      u['mieDirectionalG']!.value = 0.82;
      sky.scale.setScalar(1000);
      sky.frustumCulled = false;
    }
    // The visible sky fades into the fog colour at the horizon, so distant
    // terrain melts into the sky instead of ending on a hard band.
    hazeSky(this.sky, this.fog.color);
    this.envScene.add(this.envSky);

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const s = this.sun.shadow.camera;
    s.left = s.bottom = -40;
    s.right = s.top = 40;
    s.near = 1;
    s.far = 220;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target, this.hemi, this.sky);
    // Shadows are re-rendered every few frames (shadowEvery, see render()): the
    // sun crawls, and the shadow map and its matrix stay consistent between
    // updates, so a stale map is still correct in world space.
    this.renderer.shadowMap.autoUpdate = false;
  }

  private shadowFrame = 0;

  // ---- Automatic quality ------------------------------------------------
  // The realistic look is fill-rate bound (layered leaves, PBR, shadows). On
  // an integrated GPU, render() measures the frame rate every 0.5 s and walks
  // a ladder of settings: first lower the internal resolution, then cheaper
  // shadows and shorter detail distances, then no shadows. It climbs back up
  // after 2 s with headroom (4 s if it just had to step down).
  private basePixelRatio = 1;
  /** Current rung of QUALITY_LADDER (0 = best). */
  private rung = 0;
  private fpsFrames = 0;
  private fpsWindowStart = 0;
  private headroomWindows = 0;
  private upgradeDelay = 4;

  /** Fraction of the native resolution currently rendered. */
  get resolutionScale(): number {
    return QUALITY_LADDER[this.rung]!.scale;
  }

  /** Shadow / detail tier of the current rung: 2 full, 1 reduced, 0 no shadows. */
  get qualityTier(): 0 | 1 | 2 {
    return QUALITY_LADDER[this.rung]!.tier;
  }

  /** Distances CullingSystem applies to props for the current tier. */
  get propDistances(): { view: number; treeLod: number; smallProps: number } {
    const view = this.viewDistance;
    switch (this.qualityTier) {
      case 2: return { view, treeLod: 32, smallProps: 50 };
      case 1: return { view: Math.min(view, 120), treeLod: 20, smallProps: 35 };
      default: return { view: Math.min(view, 95), treeLod: 12, smallProps: 22 };
    }
  }

  private adaptQuality(now: number): void {
    this.fpsFrames++;
    const elapsed = now - this.fpsWindowStart;
    if (elapsed < 500) return;
    const fps = (this.fpsFrames * 1000) / elapsed;
    this.fpsFrames = 0;
    this.fpsWindowStart = now;
    if (elapsed > 2000) return; // first window, or back from a pause: not a real measurement
    let next = this.rung;
    if (fps < TARGET_FPS - 4) {
      next += fps < TARGET_FPS / 2 ? 2 : 1; // big drops take big steps
      this.headroomWindows = 0;
      this.upgradeDelay = 8;
    } else if (fps >= TARGET_FPS - 1 && ++this.headroomWindows >= this.upgradeDelay) {
      next -= 1;
      this.headroomWindows = 0;
      this.upgradeDelay = 4;
    }
    next = Math.min(QUALITY_LADDER.length - 1, Math.max(0, next));
    if (next !== this.rung) this.applyRung(next);
  }

  private applyRung(rung: number): void {
    const prevTier = this.qualityTier;
    this.rung = rung;
    this.renderer.setPixelRatio(this.basePixelRatio * this.resolutionScale);
    const tier = this.qualityTier;
    if (tier === prevTier) return;
    // Tier changes recompile shaders (shadow on/off): rare by design.
    this.sun.castShadow = tier > 0;
    const size = tier === 2 ? 2048 : 1024;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.shadowEvery = tier === 2 ? 3 : 6;
  }

  private shadowEvery = 3;

  /** Distance past which nothing is visible (fully fogged), plus a chunk's half-diagonal. */
  get viewDistance(): number {
    return this.fog.far + 24;
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.basePixelRatio = pixelRatio;
    this.renderer.setPixelRatio(pixelRatio * this.resolutionScale);
    this.renderer.setSize(width, height, false); // CSS size is owned by the stylesheet
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /** Sky, sun direction/intensity, haze and environment light follow the clock. */
  applyTimeOfDay(cycle: DayNightCycle): void {
    const light = cycle.lightLevel;
    const elev = cycle.sunElevation;
    const duskness = Math.max(0, 1 - Math.abs(elev) / 0.35); // near horizon
    this.tmpColor.copy(HAZE_NIGHT).lerp(HAZE_DAY, light).lerp(HAZE_DUSK, duskness * 0.55 * light);
    this.fog.color.copy(this.tmpColor);
    this.fog.far = 60 + 100 * light; // night closes in — and matches the AI's shorter sight range
    this.fog.near = this.fog.far * 0.12;

    const az = cycle.sunAzimuth;
    this.sunDir.set(Math.cos(az) * Math.cos(elev), Math.sin(elev), Math.sin(az) * Math.cos(elev));
    this.sky.material.uniforms['sunPosition']!.value.copy(this.sunDir);
    this.sky.position.copy(this.camera.position);
    this.sky.material.uniforms['uNight']!.value = 1 - Math.min(1, Math.max(0, (light - 0.06) / 0.35));

    const sinE = Math.max(0, Math.sin(elev));
    this.sun.intensity = 3.2 * Math.min(1, sinE * 2.5);
    // Warm and orange near the horizon, white at noon.
    this.sun.color.setHSL(0.08, 0.85 - 0.6 * Math.min(1, sinE * 2), 0.55 + 0.4 * Math.min(1, sinE * 2));
    // Moonlight at night: a cool fill bright enough to find your way without a torch.
    this.hemi.color.copy(MOON_SKY).lerp(DAY_SKY, light);
    this.hemi.intensity = 0.9 - 0.55 * light;
    this.scene.environmentIntensity = 0.25 + 0.75 * light;
    skyAmbient.value.copy(this.fog.color).multiplyScalar(0.45 * this.scene.environmentIntensity);
    this.updateEnvironment();
  }

  /**
   * Re-renders the sky into a prefiltered environment map when the sun has
   * moved enough (at most every 2 s): sky-coloured ambient light and
   * reflections on water, wet rock and metal.
   */
  private updateEnvironment(): void {
    const now = performance.now();
    if (Math.abs(this.sunDir.y - this.envSunY) < 0.02 || now - this.envAt < 2000) {
      if (this.envTarget) return;
    }
    this.envSunY = this.sunDir.y;
    this.envAt = now;
    // Below the horizon the physical sky is black: keep a faint moonlit blue instead.
    this.envSky.material.uniforms['sunPosition']!.value.set(this.sunDir.x, Math.max(this.sunDir.y, 0.02), this.sunDir.z);
    const next = this.pmrem.fromScene(this.envScene, 0, 0.1, 1000);
    this.envTarget?.dispose();
    this.envTarget = next;
    this.scene.environment = next.texture;
  }

  /** Keep the shadow frustum centred on the player so 2048² covers 80 m crisply. */
  followShadows(target: THREE.Vector3, cycle: DayNightCycle): void {
    const elev = Math.max(cycle.sunElevation, 0.15);
    const az = cycle.sunAzimuth;
    this.sun.position.set(
      target.x + Math.cos(az) * Math.cos(elev) * 60,
      target.y + Math.sin(elev) * 60,
      target.z + Math.sin(az) * Math.cos(elev) * 60,
    );
    this.sun.target.position.copy(target);
  }

  /** Optional second pass drawn over the world with a cleared depth buffer (first-person viewmodel). */
  overlay: { render(gl: THREE.WebGLRenderer): void } | null = null;

  render(): void {
    shaderTime.value = this.clock.getElapsedTime();
    this.adaptQuality(performance.now());
    if (this.shadowFrame++ % this.shadowEvery === 0) this.renderer.shadowMap.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
    this.overlay?.render(this.renderer);
  }

  /** Clears the frame to the sky colour without drawing the world (menus with no session). */
  clear(): void {
    this.renderer.setClearColor(0x0b1424, 1);
    this.renderer.clear();
  }

  /**
   * Removes everything a session added and frees GPU memory it owned. The
   * renderer (and its WebGL context) is reused across sessions: creating a
   * new context per game would leak and eventually hit the browser's limit
   * (~16 contexts), which is one of the classic causes of context loss.
   * Geometries cached by LowPolyFactory are shared and deliberately kept.
   */
  resetScene(): void {
    const keep = new Set<THREE.Object3D>([this.sun, this.sun.target, this.hemi, this.sky]);
    for (const child of [...this.scene.children]) {
      if (keep.has(child)) continue;
      child.traverse((o) => {
        const m = o as THREE.Mesh;
        if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
        if ((o as THREE.BatchedMesh).isBatchedMesh) (o as THREE.BatchedMesh).dispose();
        if (m.isMesh && m.geometry.userData['owned']) m.geometry.dispose();
        if (m.isMesh && !Array.isArray(m.material) && m.material.userData['owned']) m.material.dispose();
      });
      this.scene.remove(child);
    }
    this.overlay = null;
  }

  dispose(): void {
    this.envTarget?.dispose();
    this.pmrem.dispose();
    this.renderer.dispose();
  }
}

/** Patches the sky shader to fade into `haze` toward (and below) the horizon, and to a night blue after dusk. */
function hazeSky(sky: Sky, haze: THREE.Color): void {
  const m = sky.material;
  m.uniforms['uHaze'] = { value: haze };
  m.uniforms['uNight'] = { value: 0 };
  m.uniforms['uNightSky'] = { value: new THREE.Color(0x070d1c) };
  m.fragmentShader = m.fragmentShader
    .replace('uniform vec3 up;', 'uniform vec3 up;\nuniform vec3 uHaze;\nuniform float uNight;\nuniform vec3 uNightSky;')
    // Like three's fog_fragment, the mix happens after tone mapping, so the
    // horizon matches fogged terrain exactly.
    .replace('#include <colorspace_fragment>', `#include <colorspace_fragment>
      float hz = 1.0 - smoothstep(-0.02, 0.3, direction.y);
      gl_FragColor.rgb = mix(gl_FragColor.rgb, linearToOutputTexel(vec4(uHaze, 1.0)).rgb, hz);
      // After sunset the scattering model turns muddy brown: fade to a night blue.
      gl_FragColor.rgb = mix(gl_FragColor.rgb, linearToOutputTexel(vec4(mix(uNightSky, uHaze, hz), 1.0)).rgb, uNight);`);
  m.needsUpdate = true;
}
