import * as THREE from 'three';
import type { System, World } from '../core/ecs/World';
import type { EventBus } from '../core/EventBus';
import { PlayerControlled } from '../components';
import { BuildingGrid, CELL, DOOR, edgeOf, edgeSegment, type Candidate, type Piece } from '../systems/building/BuildingGrid';
import { BuilderC } from '../systems/building/BuildingSystem';
import {
  bedGeometry, ceilingGeometry, stairsGeometry, doorGeometry, doorwayGeometry, flatMaterial, foundationGeometry, wallGeometry,
} from './LowPolyFactory';

/**
 * Meshes for player buildings, the translucent placement ghost (green =
 * placeable, red = not), and door swing animation.
 */
export class BuildingVisuals implements System {
  readonly name = 'building-visuals';
  private readonly objects = new Map<number, THREE.Object3D>();
  private readonly doors = new Map<number, { pivot: THREE.Object3D; target: number }>();
  private readonly offs: Array<() => void>;
  private readonly ghostOk = new THREE.MeshBasicMaterial({ color: 0x5cff7a, transparent: true, opacity: 0.4, depthWrite: false });
  private readonly ghostBad = new THREE.MeshBasicMaterial({ color: 0xff4a4a, transparent: true, opacity: 0.4, depthWrite: false });
  private ghost: THREE.Object3D | null = null;
  private ghostKey = '';

  constructor(private readonly grid: BuildingGrid, private readonly scene: THREE.Scene, events: EventBus) {
    for (const p of grid.pieces()) this.add(p);
    this.offs = [
      events.on('building:placed', ({ entity }) => {
        const p = grid.get(entity);
        if (p) this.add(p);
      }),
      events.on('building:removed', ({ entity }) => {
        this.objects.get(entity)?.removeFromParent();
        this.objects.delete(entity);
        this.doors.delete(entity);
      }),
      events.on('building:door', ({ entity, open }) => {
        const d = this.doors.get(entity);
        if (d) d.target = open ? -Math.PI / 2 : 0;
      }),
    ];
  }

  update(world: World, dt: number): void {
    // Door swing.
    for (const d of this.doors.values()) {
      const r = d.pivot.rotation.y;
      d.pivot.rotation.y = r + (d.target - r) * (1 - Math.exp(-10 * dt));
    }

    // Placement ghost.
    const player = world.first(PlayerControlled, BuilderC);
    const b = player !== undefined ? world.require(player, BuilderC) : undefined;
    const c = b?.active ? b.preview : null;
    if (!c) {
      if (this.ghost) this.ghost.visible = false;
      return;
    }
    const key = `${c.kind}:${c.kind === 'foundation' ? Math.round((c.y - this.grid.groundUnder(c.i, c.j)) * 10) : ''}`;
    if (key !== this.ghostKey || !this.ghost) {
      this.ghost?.removeFromParent();
      this.ghost = this.build(c, this.ghostOk, true);
      this.ghost.traverse((o) => ((o as THREE.Mesh).renderOrder = 10));
      this.scene.add(this.ghost);
      this.ghostKey = key;
    }
    this.place(this.ghost, c);
    const mat = b!.blockedReason ? this.ghostBad : this.ghostOk;
    this.ghost.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.material = mat;
    });
    this.ghost.visible = true;
  }

  private add(p: Piece): void {
    const obj = this.build(p, flatMaterial, false);
    this.place(obj, p);
    this.scene.add(obj);
    this.objects.set(p.id, obj);
    if (p.kind === 'doorway') {
      const pivot = obj.getObjectByName('door-pivot')!;
      const open = p.open ? -Math.PI / 2 : 0;
      pivot.rotation.y = open;
      this.doors.set(p.id, { pivot, target: open });
    }
  }

  private build(c: Candidate, mat: THREE.Material, ghost: boolean): THREE.Object3D {
    const mesh = (g: THREE.BufferGeometry): THREE.Mesh => {
      const m = new THREE.Mesh(g, mat);
      m.castShadow = !ghost;
      m.receiveShadow = !ghost;
      return m;
    };
    switch (c.kind) {
      case 'bed':
        return mesh(bedGeometry());
      case 'stairs':
        return mesh(stairsGeometry());
      case 'foundation':
        return mesh(foundationGeometry(c.y - this.grid.groundUnder(c.i, c.j) + 0.5));
      case 'ceiling':
        return mesh(ceilingGeometry());
      case 'wall':
        return mesh(wallGeometry());
      case 'doorway': {
        const g = new THREE.Group();
        g.add(mesh(doorwayGeometry()));
        const pivot = new THREE.Group();
        pivot.name = 'door-pivot';
        pivot.position.x = -DOOR.width / 2; // hinge on the left jamb
        pivot.add(mesh(doorGeometry()));
        g.add(pivot);
        return g;
      }
    }
  }

  /** Position/orient an object for a piece or candidate. */
  private place(obj: THREE.Object3D, c: Candidate): void {
    if (c.kind === 'bed') {
      const b = BuildingGrid.bedPlacement(c);
      obj.position.set(b.x, c.y, b.z);
      const [di, dj] = c.side === 'e' ? [1, 0] : c.side === 'w' ? [-1, 0] : c.side === 's' ? [0, 1] : [0, -1];
      obj.rotation.y = Math.atan2(di, dj); // model's headboard (+Z) → toward the chosen edge
      return;
    }
    if (c.kind === 'stairs') {
      obj.position.set((c.i + 0.5) * CELL, c.y, (c.j + 0.5) * CELL);
      const [di, dj] = c.side === 'e' ? [1, 0] : c.side === 'w' ? [-1, 0] : c.side === 's' ? [0, 1] : [0, -1];
      obj.rotation.y = Math.atan2(di, dj); // model climbs toward +Z
      return;
    }
    if (c.kind === 'foundation' || c.kind === 'ceiling') {
      obj.position.set((c.i + 0.5) * CELL, c.y, (c.j + 0.5) * CELL);
      obj.rotation.y = 0;
      return;
    }
    const s = edgeSegment(edgeOf(c.i, c.j, c.side!));
    obj.position.set((s.x0 + s.x1) / 2, c.y, (s.z0 + s.z1) / 2);
    obj.rotation.y = s.z0 === s.z1 ? 0 : Math.PI / 2;
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.ghostOk.dispose();
    this.ghostBad.dispose();
  }
}
