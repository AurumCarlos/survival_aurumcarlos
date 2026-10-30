import type { Entity, World } from '../core/ecs/World';
import { AIBrain, Creature, Structure, SurvivorC, Transform } from '../components';
import type { Vec3 } from '../data/schema';
import { spawnStructure } from '../entities/factories';
import { BuildingGrid, BED, type Piece } from './building/BuildingGrid';
import { InventoryGrid } from './inventory/InventoryGrid';

/**
 * Death with a bed (Minecraft-style): everything you carried is left in a
 * bag where you fell, and you wake up next to your bed with fresh vitals.
 * Without a bed, death stays final for that world.
 */

/** Where to stand up beside a bed: the floor next to its long side, at floor height. */
export function bedSpawnPoint(bed: Piece): Vec3 {
  const b = BuildingGrid.bedPlacement(bed);
  const off = BED.width / 2 + 0.45;
  return b.alongX ? { x: b.x, y: bed.y, z: b.z + off } : { x: b.x + off, y: bed.y, z: b.z };
}

/** The bed to respawn at: the one you last slept in, else the newest one. */
export function chooseBed(grid: BuildingGrid, preferred: number | null): Piece | null {
  const beds = [...grid.pieces()].filter((p) => p.kind === 'bed');
  return beds.find((b) => b.id === preferred) ?? beds.sort((a, b) => b.id - a.id)[0] ?? null;
}

/** Move the whole inventory, hotbar and worn armour into a bag at `where`. Returns the bag (null if you had nothing). */
export function dropBelongings(world: World, player: Entity, where: Vec3): Entity | null {
  const s = world.require(player, SurvivorC);
  const stacks = [
    ...s.inventory.placements.map((p) => p.stack),
    ...s.hotbar.filter((h): h is NonNullable<typeof h> => h !== null),
    ...(s.equipped.body ? [s.equipped.body] : []),
  ];
  s.inventory.placements = [];
  s.hotbar = s.hotbar.map(() => null);
  s.equipped.body = null;
  if (stacks.length === 0) return null;
  const bag = spawnStructure(world, 'death_bag', { ...where });
  const box = new InventoryGrid(world.require(bag, Structure).container!);
  for (const st of stacks) box.add(st.item, st.qty, st.durability);
  return bag;
}

/** Bring the survivor back to life at `at`, with fresh-but-not-full vitals and no lingering effects. */
export function revive(world: World, player: Entity, at: Vec3): void {
  const s = world.require(player, SurvivorC);
  s.alive = true;
  s.vitals.health = 70;
  s.vitals.hunger = Math.max(s.vitals.hunger, 60);
  s.vitals.thirst = Math.max(s.vitals.thirst, 60);
  s.vitals.energy = Math.max(s.vitals.energy, 70);
  s.vitals.stamina = 100;
  s.vitals.bodyTemp = 37;
  s.effects = [];
  s.activity = 'idle';
  const t = world.require(player, Transform);
  t.position = { ...at };
  t.prevPosition = { ...at };
  // The animals that were after you lose interest.
  for (const e of world.query(Creature, AIBrain)) {
    const c = world.require(e, Creature);
    c.perception.awareness = 0;
    c.perception.lastKnownTargetPos = null;
    c.perception.lastKnownAge = Number.POSITIVE_INFINITY;
    const bb = world.require(e, AIBrain).blackboard;
    if (bb.state !== 'flee') bb.state = 'patrol';
    if (bb.apex && bb.apex.mode !== 'sleep' && bb.apex.mode !== 'swim' && bb.apex.mode !== 'lurk') {
      bb.apex.mode = c.species === 'bear' ? 'home' : 'return';
      bb.apex.t = 0;
      bb.apex.target = null;
    }
  }
}
