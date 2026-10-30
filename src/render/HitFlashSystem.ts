import * as THREE from 'three';
import type { Entity, System, World } from '../core/ecs/World';
import type { EventBus } from '../core/EventBus';
import { RenderObject } from './Renderer';

const FLASH_SECONDS = 0.35;

/**
 * Minecraft-style damage feedback: a creature that takes a hit turns red for
 * a moment. Meshes share one flat-shaded material, so instead of tinting it
 * (which would turn every creature red) we temporarily swap each mesh of the
 * hit entity to a shared red material and restore the originals afterwards.
 */
export class HitFlashSystem implements System {
  readonly name = 'hit-flash';
  private readonly active = new Map<Entity, { time: number; originals: Map<THREE.Mesh, THREE.Material | THREE.Material[]> }>();
  /** Vertex colours × red + red emissive: keeps the low-poly shading but reads clearly as "hurt" day or night. */
  private readonly red = new THREE.MeshLambertMaterial({
    vertexColors: true, flatShading: true, color: 0xff5050, emissive: 0x991111,
  });
  private readonly off: () => void;

  constructor(events: EventBus, private readonly world: World) {
    this.off = events.on('creature:hit', ({ entity }) => this.flash(entity));
  }

  private flash(e: Entity): void {
    const ro = this.world.get(e, RenderObject);
    if (!ro) return;
    const existing = this.active.get(e);
    if (existing) {
      existing.time = FLASH_SECONDS; // re-hit: extend, originals already saved
      return;
    }
    const originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
    ro.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      originals.set(m, m.material);
      m.material = this.red;
    });
    this.active.set(e, { time: FLASH_SECONDS, originals });
  }

  update(_world: World, dt: number): void {
    for (const [e, f] of this.active) {
      f.time -= dt;
      if (f.time > 0) continue;
      for (const [mesh, mat] of f.originals) mesh.material = mat;
      this.active.delete(e);
    }
  }

  dispose(): void {
    this.off();
    for (const f of this.active.values()) for (const [mesh, mat] of f.originals) mesh.material = mat;
    this.active.clear();
    this.red.dispose();
  }
}
