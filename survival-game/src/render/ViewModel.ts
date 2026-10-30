import * as THREE from 'three';
import type { System, World } from '../core/ecs/World';
import { PlayerControlled } from '../components';
import { PlayerAnimC, viewModelPose, type ViewPose } from '../systems/player/PlayerAnimation';
import { flatMaterial, viewModelGeometry } from './LowPolyFactory';
import type { Renderer } from './Renderer';

/**
 * First-person hands/tool, drawn in a separate overlay pass.
 *
 * Why a separate scene + camera: a tool parented to the world camera
 * physically extends 0.5–1 m in front of the eye, so walking up to a tree or
 * looking down a slope pushes it *into* that geometry — the clipping glitch.
 * Rendering it after clearing the depth buffer makes it always draw on top,
 * and its own narrow-near-plane camera keeps it from being cut by near-plane
 * clipping. Visibility itself comes from the animation state machine: the
 * mesh exists only while equipped or acting.
 */
export class ViewModel implements System {
  readonly name = 'viewmodel';
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(58, 1, 0.01, 10);
  private readonly mesh: THREE.Mesh;
  private readonly hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  private readonly key = new THREE.DirectionalLight(0xffffff, 1.2);
  private readonly pose: ViewPose = { visible: false, x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };
  private shownItem: string | null | undefined = undefined;
  /** Torch flame drawn in the overlay (unlit, so it glows at night). */
  private readonly flame = new THREE.Group();
  /**
   * The torch's light lives in the WORLD scene (the overlay only draws the
   * hand), following the camera. It always stays in the scene with intensity
   * 0 when unused: adding/removing a light would force every material to
   * recompile its shader, a visible hitch.
   */
  readonly torchLight = new THREE.PointLight(0xffa24a, 0, 20, 1.3);
  /** Glow on the hand/tool itself from the flame. */
  private readonly handGlow = new THREE.PointLight(0xffa24a, 0, 2, 1);
  private time = 0;
  private readonly tmp = new THREE.Vector3();

  constructor(private readonly r: Renderer) {
    this.mesh = new THREE.Mesh(viewModelGeometry(null), flatMaterial);
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.scale.setScalar(0.62); // hand-space models are ~life-size; scaled to read well at 58° FOV
    this.key.position.set(0.5, 1, 0.5);
    const outer = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.2, 6).translate(0, 0.1, 0),
      new THREE.MeshBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0.85, depthWrite: false }));
    const inner = new THREE.Mesh(new THREE.ConeGeometry(0.032, 0.12, 6).translate(0, 0.06, 0),
      new THREE.MeshBasicMaterial({ color: 0xffe27a, transparent: true, opacity: 0.95, depthWrite: false }));
    this.flame.add(outer, inner);
    this.flame.position.set(0.01, 0.52, 0);
    this.flame.visible = false;
    this.mesh.add(this.flame);
    this.handGlow.position.set(0, 0.6, 0);
    this.mesh.add(this.handGlow);
    this.scene.add(this.mesh, this.hemi, this.key);
    r.scene.add(this.torchLight);
  }

  update(world: World): void {
    const player = world.first(PlayerControlled, PlayerAnimC);
    if (player === undefined) {
      this.mesh.visible = false;
      return;
    }
    const anim = world.require(player, PlayerAnimC);
    if (this.shownItem !== anim.held) {
      // Geometry swap only ever happens while holstered (the FSM guarantees
      // `held` changes only then), so the switch is never seen on screen.
      this.mesh.geometry = viewModelGeometry(anim.held);
      this.shownItem = anim.held;
    }
    const p = viewModelPose(anim, this.pose);
    this.mesh.visible = p.visible;
    this.mesh.position.set(p.x, p.y, p.z);
    this.mesh.rotation.set(p.rx, p.ry, p.rz);

    // Torch: flame flicker + a light that illuminates the world around you.
    this.time += 1 / 60;
    const lit = anim.held === 'torch' && p.visible;
    const flicker = 0.82 + Math.sin(this.time * 17) * 0.08 + Math.sin(this.time * 29.3 + 1.7) * 0.06 + Math.sin(this.time * 7.1) * 0.04;
    this.flame.visible = lit;
    if (lit) this.flame.scale.set(1, flicker * 1.15, 1);
    this.torchLight.intensity = lit ? 9 * flicker : 0;
    this.handGlow.intensity = lit ? 2.5 * flicker : 0;
    if (lit) {
      // Held low and to the right, a little ahead of the eye.
      const cam = this.r.camera;
      this.tmp.set(0.35, -0.25, -0.55).applyQuaternion(cam.quaternion);
      this.torchLight.position.copy(cam.position).add(this.tmp);
    }

    // Match world lighting so the axe isn't fully lit at midnight.
    this.hemi.intensity = this.r.hemi.intensity;
    this.key.intensity = 0.3 + this.r.sun.intensity * 0.4;
    this.camera.aspect = this.r.camera.aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Called by Renderer after the world pass. */
  render(gl: THREE.WebGLRenderer): void {
    if (!this.mesh.visible) return;
    const auto = gl.autoClear;
    gl.autoClear = false; // keep the world pass's colour buffer
    gl.clearDepth();
    gl.render(this.scene, this.camera);
    gl.autoClear = auto;
  }
}
