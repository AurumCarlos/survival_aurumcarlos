import * as THREE from 'three';
import { defineComponent } from '../core/ecs/World';
import type { ViewportTarget } from '../core/Lifecycle';
import type { DayNightCycle } from '../systems/DayNightCycle';
import { Sky } from 'three/addons/objects/Sky.js';
import { shaderTime, skyAmbient } from './Materials';
import { Celestial } from './Celestial';
import { Rain } from './Rain';
import { DEFAULT_GRAPHICS, type GraphicsSettings } from '../data/settings';

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
const HAZE_RAIN = new THREE.Color(0x8e979f);
const DAY_SKY = new THREE.Color(0xbfd4e8);
/** From best to cheapest: internal resolution scale and shadow/detail tier. */
const QUALITY_LADDER: ReadonlyArray<{ scale: number; tier: 0 | 1 | 2 }> = [
  { scale: 1, tier: 2 }, { scale: 0.85, tier: 2 }, { scale: 0.7, tier: 2 }, { scale: 0.7, tier: 1 }, { scale: 0.6, tier: 1 },
  { scale: 0.7, tier: 0 }, { scale: 0.6, tier: 0 }, { scale: 0.5, tier: 0 }, { scale: 0.42, tier: 0 },
];
/** Resolution steps when only the resolution is automatic. */
const AUTO_SCALES = [1, 0.85, 0.7, 0.6, 0.5, 0.42];
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
  private readonly tmpColor2 = new THREE.Color();
  private readonly sunDir = new THREE.Vector3();
  /** Direction of the shadow-casting light: the sun, or the moon at night. */
  private readonly lightDir = new THREE.Vector3(0.3, 0.8, 0.2).normalize();
  private readonly tmpDir = new THREE.Vector3();
  readonly celestial = new Celestial();
  readonly rain = new Rain();
  /** Smoothed rain strength (0..1): the weather fades in and out instead of switching. */
  private rainLevel = 0;
  private lastTimeOfDay = performance.now();
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
    this.scene.add(this.sun, this.sun.target, this.hemi, this.sky, this.celestial.group, this.rain.object);
    // Shadows are re-rendered every few frames (shadowEvery, see render()): the
    // sun crawls, and the shadow map and its matrix stay consistent between
    // updates, so a stale map is still correct in world space.
    this.renderer.shadowMap.autoUpdate = false;
  }

  private shadowFrame = 0;

  // ---- Quality: graphics settings + automatic adjustment ------------------
  // The realistic look is fill-rate bound (layered leaves, PBR, shadows). In
  // Auto, render() measures the frame rate every 0.5 s and walks a ladder of
  // settings: first lower the internal resolution, then cheaper shadows and
  // shorter detail distances, then no shadows. It climbs back up after 2 s
  // with headroom (4 s if it just had to step down). A fixed quality or
  // resolution in the settings removes that part from the ladder.
  private basePixelRatio = 1;
  private graphics: GraphicsSettings = { ...DEFAULT_GRAPHICS };
  private ladder: ReadonlyArray<{ scale: number; tier: 0 | 1 | 2 }> = QUALITY_LADDER;
  /** Current rung of the ladder (0 = best). */
  private rung = 0;
  private tier: 0 | 1 | 2 = 2;
  private fpsFrames = 0;
  private fpsWindowStart = 0;
  private headroomWindows = 0;
  private upgradeDelay = 4;

  /** Applies the graphics settings (see data/settings.ts). */
  setGraphics(g: GraphicsSettings): void {
    this.graphics = { ...g };
    const fixedTier = g.quality === 'high' ? 2 : g.quality === 'medium' ? 1 : g.quality === 'low' ? 0 : null;
    const fixedScale = g.resolution === 'auto' ? null : Number(g.resolution);
    if (fixedTier === null && fixedScale === null) this.ladder = QUALITY_LADDER;
    else if (fixedTier === null) this.ladder = ([2, 1, 0] as const).map((tier) => ({ scale: fixedScale!, tier }));
    else if (fixedScale === null) this.ladder = AUTO_SCALES.map((scale) => ({ scale, tier: fixedTier }));
    else this.ladder = [{ scale: fixedScale, tier: fixedTier }];
    this.headroomWindows = 0;
    this.applyRung(0, true);
  }

  /** Fraction of the native resolution currently rendered. */
  get resolutionScale(): number {
    return this.ladder[this.rung]!.scale;
  }

  /** Shadow / detail tier in use: 2 full, 1 reduced, 0 no shadows. */
  get qualityTier(): 0 | 1 | 2 {
    return this.tier;
  }

  /**
   * What CullingSystem applies to props: draw distances and how many of the
   * nearest trees get the detailed mesh (the player's setting; in Auto it is
   * scaled down on the cheaper tiers).
   */
  get propDistances(): { view: number; detailedTrees: number; smallProps: number } {
    const view = this.viewDistance * (this.graphics.viewDistance / 100);
    const n = this.graphics.detailedTrees;
    const auto = this.graphics.quality === 'auto';
    switch (this.tier) {
      case 2: return { view, detailedTrees: n, smallProps: 50 };
      case 1: return { view: Math.min(view, 120), detailedTrees: auto ? Math.round(n * 0.66) : n, smallProps: 35 };
      default: return { view: Math.min(view, 95), detailedTrees: auto ? Math.round(n * 0.4) : n, smallProps: 22 };
    }
  }

  private adaptQuality(now: number): void {
    this.fpsFrames++;
    const elapsed = now - this.fpsWindowStart;
    if (elapsed < 500) return;
    const fps = (this.fpsFrames * 1000) / elapsed;
    this.fpsFrames = 0;
    this.fpsWindowStart = now;
    if (elapsed > 2000 || this.ladder.length < 2) return; // first window / back from a pause, or nothing to adjust
    const target = this.graphics.targetFps || 120; // unlimited: aim high, without wrecking the image
    let next = this.rung;
    if (fps < target * 0.93) {
      next += fps < target / 2 ? 2 : 1; // big drops take big steps
      this.headroomWindows = 0;
      this.upgradeDelay = 8;
    } else if (fps >= target - 1 && ++this.headroomWindows >= this.upgradeDelay) {
      next -= 1;
      this.headroomWindows = 0;
      this.upgradeDelay = 4;
    }
    next = Math.min(this.ladder.length - 1, Math.max(0, next));
    if (next !== this.rung) this.applyRung(next);
  }

  private applyRung(rung: number, force = false): void {
    this.rung = rung;
    this.renderer.setPixelRatio(this.basePixelRatio * this.resolutionScale);
    const tier = this.ladder[rung]!.tier;
    if (tier === this.tier && !force) return;
    this.tier = tier;
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

  /** Vertical field of view in degrees (controls setting). */
  setFov(deg: number): void {
    if (this.camera.fov === deg) return;
    this.camera.fov = deg;
    this.camera.updateProjectionMatrix();
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
    const now = performance.now();
    const dt = Math.min(0.5, (now - this.lastTimeOfDay) / 1000);
    this.lastTimeOfDay = now;
    this.rainLevel += (cycle.rainIntensity - this.rainLevel) * Math.min(1, dt * 0.4);
    const rain = this.rainLevel;
    const duskness = Math.max(0, 1 - Math.abs(elev) / 0.35); // near horizon
    this.tmpColor.copy(HAZE_NIGHT).lerp(HAZE_DAY, light).lerp(HAZE_DUSK, duskness * 0.55 * light);
    this.tmpColor.lerp(this.tmpColor2.copy(HAZE_RAIN).multiplyScalar(0.12 + 0.88 * light), rain * 0.8); // grey, darker rain haze
    this.fog.color.copy(this.tmpColor);
    // Night closes in (and matches the AI's shorter sight range); rain shortens the view too.
    this.fog.far = (60 + 100 * light) * (1 - 0.4 * rain);
    this.fog.near = this.fog.far * 0.12;
    this.sky.material.uniforms['uRain']!.value = rain;
    this.sky.material.uniforms['uDay']!.value = light;

    const az = cycle.sunAzimuth;
    this.sunDir.set(Math.cos(az) * Math.cos(elev), Math.sin(elev), Math.sin(az) * Math.cos(elev));
    this.sky.material.uniforms['sunPosition']!.value.copy(this.sunDir);
    this.sky.position.copy(this.camera.position);
    this.sky.material.uniforms['uNight']!.value = 1 - Math.min(1, Math.max(0, (light - 0.06) / 0.35));

    this.celestial.update(this.camera.position, this.sunDir, light, cycle.day - 1, rain);

    const sinE = Math.max(0, Math.sin(elev));
    const moon = this.celestial.moonDir;
    if (sinE > 0.02 || moon.y < 0.05) {
      // Daylight: warm and orange near the horizon, white at noon.
      this.lightDir.copy(this.sunDir);
      this.sun.intensity = 3.2 * Math.min(1, sinE * 2.5) * (1 - 0.7 * rain); // clouds hide the sun
      this.sun.color.setHSL(0.08, 0.85 - 0.6 * Math.min(1, sinE * 2), 0.55 + 0.4 * Math.min(1, sinE * 2));
    } else {
      // Night: the moon becomes the shadow-casting light — cold, faint, brighter near full moon.
      this.lightDir.copy(moon);
      this.sun.intensity = (0.12 + 0.4 * this.celestial.moonBrightness) * Math.min(1, moon.y * 4) * (1 - 0.8 * rain);
      this.sun.color.setRGB(0.62, 0.72, 1);
    }
    // Moonlight at night: a cool fill bright enough to find your way without a torch.
    this.hemi.color.copy(MOON_SKY).lerp(DAY_SKY, light);
    this.hemi.intensity = 0.9 - 0.55 * light;
    this.scene.environmentIntensity = (0.25 + 0.75 * light) * (1 - 0.3 * rain);
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
  followShadows(target: THREE.Vector3, _cycle: DayNightCycle): void {
    // The light (sun by day, moon by night) never comes from lower than ~9°: long shadows, never infinite ones.
    this.tmpDir.copy(this.lightDir);
    if (this.tmpDir.y < 0.15) this.tmpDir.setY(0.15).normalize();
    this.sun.position.copy(target).addScaledVector(this.tmpDir, 60);
    this.sun.target.position.copy(target);
  }

  /** Optional second pass drawn over the world with a cleared depth buffer (first-person viewmodel). */
  overlay: { render(gl: THREE.WebGLRenderer): void } | null = null;

  render(): void {
    shaderTime.value = this.clock.getElapsedTime();
    this.rain.update(shaderTime.value, this.camera.position, this.rainLevel, this.sky.material.uniforms['uDay']!.value as number);
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
    const keep = new Set<THREE.Object3D>([this.sun, this.sun.target, this.hemi, this.sky, this.celestial.group, this.rain.object]);
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
  m.uniforms['uRain'] = { value: 0 };
  m.uniforms['uDay'] = { value: 1 };
  m.uniforms['uTime'] = shaderTime;
  m.fragmentShader = m.fragmentShader
    .replace('uniform vec3 up;', `uniform vec3 up;
      uniform vec3 uHaze;
      uniform float uNight;
      uniform vec3 uNightSky;
      uniform float uRain;
      uniform float uDay;
      uniform float uTime;
      float cHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float cNoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(cHash(i), cHash(i + vec2(1, 0)), u.x), mix(cHash(i + vec2(0, 1)), cHash(i + vec2(1, 1)), u.x), u.y);
      }
      float cFbm(vec2 p) {
        float s = 0.0, a = 0.5;
        for (int i = 0; i < 5; i++) { s += cNoise(p) * a; p = p * 2.03 + 17.1; a *= 0.5; }
        return s;
      }`)
    // Like three's fog_fragment, the mix happens after tone mapping, so the
    // horizon matches fogged terrain exactly.
    .replace('#include <colorspace_fragment>', `#include <colorspace_fragment>
      float hz = 1.0 - smoothstep(-0.02, 0.3, direction.y);
      gl_FragColor.rgb = mix(gl_FragColor.rgb, linearToOutputTexel(vec4(uHaze, 1.0)).rgb, hz);
      // After sunset the scattering model turns muddy brown: fade to a night blue.
      gl_FragColor.rgb = mix(gl_FragColor.rgb, linearToOutputTexel(vec4(mix(uNightSky, uHaze, hz), 1.0)).rgb, uNight);
      // Clouds: drifting noise projected on a high flat layer, thicker and
      // darker when it rains, lit warm on the sun's side, fading into the haze.
      if (direction.y > 0.0) {
        vec2 uv = direction.xz / (direction.y + 0.12) * 1.4 + uTime * vec2(0.006, 0.0025);
        float n = cFbm(uv);
        float cover = mix(0.58, 0.28, uRain);
        float c = smoothstep(cover, cover + 0.2, n) * smoothstep(0.0, 0.2, direction.y);
        float sunSide = pow(max(dot(direction, vSunDirection), 0.0), 6.0);
        vec3 lit = vec3(1.0, 0.98, 0.95) * (0.07 + 0.85 * uDay) + vec3(1.0, 0.82, 0.55) * sunSide * 0.35 * uDay;
        lit = mix(lit, lit * 0.6, smoothstep(cover + 0.12, cover + 0.45, n)) * (1.0 - 0.45 * uRain);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, lit, c * 0.9);
      }
      // Overcast: the whole sky turns grey under rain.
      gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.55, 0.58, 0.62) * (0.08 + 0.8 * uDay), uRain * 0.55 * (1.0 - hz));`);
  m.needsUpdate = true;
}
