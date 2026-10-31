import type * as THREE from 'three';
import type { Entity, System, World } from '../core/ecs/World';
import { AIBrain, Creature, Transform } from '../components';
import { RenderObject } from './Renderer';

interface Rig {
  legs: THREE.Object3D[];
  head: THREE.Object3D | undefined;
  tail: THREE.Object3D | undefined;
  phase: number;
  speed: number;
  t: number;
}

/** Diagonal gait: front-left with back-right, front-right with back-left. */
const LEG_PHASE = [0, Math.PI, Math.PI, 0] as const;

/**
 * Procedural walk/run cycle for the animal models (CreatureModels.ts): legs
 * swing with the creature's actual ground speed, the head bobs, the tail
 * sways, and grazing animals lower their head while standing still.
 * Purely visual — reads Transform, never writes simulation state.
 */
export class CreatureAnimationSystem implements System {
  readonly name = 'creature-animation';
  private readonly rigs = new Map<Entity, Rig>();

  update(world: World, dt: number): void {
    for (const e of world.query(Creature, Transform, RenderObject)) {
      const obj = world.require(e, RenderObject).object;
      if (!obj.visible) continue;
      const sp = world.require(e, Creature).species;
      if (sp === 'crocodile' || sp === 'bear') continue; // skeletal rigs: ApexAnimation
      let rig = this.rigs.get(e);
      if (!rig) {
        rig = {
          legs: [0, 1, 2, 3].map((i) => obj.getObjectByName(`leg${i}`)).filter((o): o is THREE.Object3D => !!o),
          head: obj.getObjectByName('head'),
          tail: obj.getObjectByName('tail'),
          phase: (e * 1.7) % (Math.PI * 2),
          speed: 0,
          t: e,
        };
        this.rigs.set(e, rig);
      }
      const t = world.require(e, Transform);
      const c = world.require(e, Creature);
      // Ground speed from the last fixed step (60 Hz), smoothed so the gait doesn't jitter.
      const raw = Math.hypot(t.position.x - t.prevPosition.x, t.position.z - t.prevPosition.z) * 60;
      rig.speed += (raw - rig.speed) * Math.min(1, dt * 8);
      rig.t += dt;
      const stride = c.species === 'boar' ? 0.55 : c.species === 'wolf' ? 0.8 : 1.0; // metres per step
      rig.phase += (rig.speed / stride) * Math.PI * dt;
      const run = Math.min(1, rig.speed / Math.max(0.1, c.runSpeed));
      const amp = Math.min(0.75, rig.speed * 0.22);

      rig.legs.forEach((leg, i) => {
        leg.rotation.x = Math.sin(rig!.phase + LEG_PHASE[i]!) * amp;
      });
      if (rig.head) {
        const state = world.get(e, AIBrain)?.blackboard.state;
        const grazing = c.species !== 'wolf' && rig.speed < 0.15 && state === 'patrol';
        const target = grazing ? 0.75 + Math.sin(rig.t * 0.9) * 0.1 : Math.sin(rig.phase * 2) * 0.06 * (0.3 + run) - run * 0.15;
        rig.head.rotation.x += (target - rig.head.rotation.x) * Math.min(1, dt * 4);
        rig.head.rotation.y = Math.sin(rig.t * 0.7 + e) * (grazing ? 0.15 : 0.05);
      }
      if (rig.tail) {
        rig.tail.rotation.y = Math.sin(rig.t * (c.species === 'wolf' ? 3 : 6) + e) * (0.15 + run * 0.2);
        rig.tail.rotation.x = run * 0.4;
      }
    }
    // Forget rigs of creatures that died (they become carcasses) or were removed.
    for (const e of this.rigs.keys()) if (!world.has(e, Creature)) this.rigs.delete(e);
  }
}
