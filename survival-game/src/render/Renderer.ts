import * as THREE from 'three';
import { defineComponent } from '../core/ecs/World';
import type { ViewportTarget } from '../core/Lifecycle';
import type { DayNightCycle } from '../systems/DayNightCycle';

/** Handle component: the Three.js object that visualises an entity. */
export interface RenderObject {
  object: THREE.Object3D;
  /** Interpolate between fixed steps (moving things). Static props set false. */
  interpolate: boolean;
}
export const RenderObject = defineComponent<RenderObject>('RenderObject');

const SKY_DAY = new THREE.Color(0x8fd0f0);
const SKY_DUSK = new THREE.Color(0xe59a6b);
const SKY_NIGHT = new THREE.Color(0x0b1424);

/**
 * Scene, camera, lights and the WebGL renderer. The low-poly look comes from
 * flat-shaded vertex-coloured geometry + linear fog + a single shadow-casting
 * sun — no textures, so the whole game ships at a few hundred KB.
 */
export class Renderer implements ViewportTarget {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly sun = new THREE.DirectionalLight(0xffffff, 2.2);
  // Ground colour = light bounced off sand and grass; bright enough that forest shade isn't pitch black.
  readonly hemi = new THREE.HemisphereLight(0xbfe4ff, 0x7d8a5c, 0.9);
  private readonly fog: THREE.Fog;
  private readonly tmpColor = new THREE.Color();

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      // Avoid a mandatory buffer copy each frame; we never read pixels back.
      preserveDrawingBuffer: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 400);
    this.fog = new THREE.Fog(SKY_DAY.getHex(), 40, 160);
    this.scene.fog = this.fog;
    this.scene.background = SKY_DAY.clone();

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const s = this.sun.shadow.camera;
    s.left = s.bottom = -40;
    s.right = s.top = 40;
    s.near = 1;
    s.far = 200;
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun, this.sun.target, this.hemi);
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false); // CSS size is owned by the stylesheet
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /** Sky colour, sun direction/intensity and fog distance follow the clock. */
  applyTimeOfDay(cycle: DayNightCycle): void {
    const light = cycle.lightLevel;
    const elev = cycle.sunElevation;
    const duskness = Math.max(0, 1 - Math.abs(elev) / 0.35); // near horizon
    this.tmpColor.copy(SKY_NIGHT).lerp(SKY_DAY, light).lerp(SKY_DUSK, duskness * 0.5 * light);
    (this.scene.background as THREE.Color).copy(this.tmpColor);
    this.fog.color.copy(this.tmpColor);
    this.fog.far = 60 + 100 * light; // night closes in — and matches the AI's shorter sight range
    this.fog.near = this.fog.far * 0.25;

    this.sun.intensity = 2.4 * Math.max(0, Math.sin(elev));
    this.sun.color.setHSL(0.1, 0.6, 0.6 + 0.3 * light);
    this.hemi.intensity = 0.3 + 0.9 * light;
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
    const keep = new Set<THREE.Object3D>([this.sun, this.sun.target, this.hemi]);
    for (const child of [...this.scene.children]) {
      if (keep.has(child)) continue;
      child.traverse((o) => {
        const m = o as THREE.Mesh;
        if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
        if (m.isMesh && m.geometry.userData['owned']) m.geometry.dispose();
        if (m.isMesh && !Array.isArray(m.material) && m.material.userData['owned']) m.material.dispose();
      });
      this.scene.remove(child);
    }
    this.overlay = null;
  }

  dispose(): void {
    this.renderer.dispose();
  }
}
