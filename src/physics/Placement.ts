import type { Vec3 } from '../data/schema';
import { Groups, type PhysicsWorld } from './PhysicsWorld';

export interface PlacementQuery {
  feet: Vec3;
  yaw: number;
  /** Half-size of the structure's footprint (m). */
  radius: number;
  heightAt(x: number, z: number): number;
  /** Ground-level check (trees, water, cliffs) used when not standing on a building. */
  isWalkable(x: number, z: number): boolean;
  waterLevel: number;
}

/**
 * Where a structure put down "in front of the player" ends up: on the
 * surface below — terrain, or the foundation/floor of a house (it used to be
 * placed at terrain height, i.e. buried inside the floor) — and never pushed
 * through a wall. Returns the spot, or a reason it can't go there.
 */
export function placementSpot(physics: PhysicsWorld, q: PlacementQuery): { x: number; y: number; z: number } | { error: string } {
  const { feet } = q;
  const fx = -Math.sin(q.yaw), fz = -Math.cos(q.yaw);
  let dist = 1.4 + q.radius;
  const wall = physics.raycast(
    { x: feet.x, y: feet.y + 0.9, z: feet.z }, { x: feet.x + fx * dist, y: feet.y + 0.9, z: feet.z + fz * dist },
    Groups.STATIC | Groups.BUILDING,
  );
  if (wall) {
    dist = Math.hypot(wall.point.x - feet.x, wall.point.z - feet.z) - q.radius - 0.15;
    if (dist < 0.7) return { error: 'No room to put that here' };
  }
  const x = feet.x + fx * dist, z = feet.z + fz * dist;
  const down = physics.raycast({ x, y: feet.y + 1.4, z }, { x, y: feet.y - 3, z }, Groups.TERRAIN | Groups.BUILDING | Groups.STATIC);
  if (down?.group === Groups.STATIC) return { error: 'A tree or rock is in the way' };
  const onBuilding = down?.group === Groups.BUILDING;
  const y = down ? down.point.y : q.heightAt(x, z);
  if (!onBuilding && !q.isWalkable(x, z)) return { error: "Can't place that here" };
  if (y < q.waterLevel - 0.1) return { error: "Can't place that in water" };
  return { x, y, z };
}
