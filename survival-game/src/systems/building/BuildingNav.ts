import type { World } from '../../core/ecs/World';
import type { EventBus } from '../../core/EventBus';
import type { NavGrid } from '../ai/nav/NavGrid';
import { BuildingGrid, CELL, DOOR, edgeOf, edgeSegment, type Piece } from './BuildingGrid';

type Rect = [number, number, number, number];
const THICK = 0.1;
/** Foundations taller than this above the ground are a wall to creatures, not a step. */
const CREATURE_STEP = 1.0;

/**
 * Keeps the AI's nav grid in sync with player buildings: walls and closed
 * doors block creature movement, open doors let them through, tall
 * foundations block, low ones are walked on. Every change bumps the grid
 * version, which makes FlowFieldService drop its cached fields — so a wolf
 * that was pathing to you re-routes the instant you close the door.
 */
export class BuildingNav {
  private readonly applied = new Map<number, Rect[]>();
  private readonly offs: Array<() => void>;

  constructor(private readonly grid: BuildingGrid, private readonly nav: NavGrid, events: EventBus, _world: World) {
    for (const p of grid.pieces()) this.apply(p);
    this.offs = [
      events.on('building:placed', ({ entity }) => {
        const p = grid.get(entity);
        if (p) this.apply(p);
      }),
      events.on('building:removed', ({ entity }) => this.clear(entity)),
      events.on('building:door', ({ entity }) => {
        const p = grid.get(entity);
        this.clear(entity);
        if (p) this.apply(p);
      }),
    ];
  }

  private apply(p: Piece): void {
    const rects = this.rectsFor(p);
    for (const r of rects) this.nav.blockRect(r[0], r[1], r[2], r[3], 1);
    this.applied.set(p.id, rects);
  }

  private clear(id: number): void {
    for (const r of this.applied.get(id) ?? []) this.nav.blockRect(r[0], r[1], r[2], r[3], -1);
    this.applied.delete(id);
  }

  rectsFor(p: Piece): Rect[] {
    if (p.kind === 'ceiling' || p.kind === 'bed') return []; // upper floors / furniture don't block paths
    if (p.kind === 'foundation') {
      const tall = p.y - this.grid.groundUnder(p.i, p.j) > CREATURE_STEP;
      return tall ? [[p.i * CELL, p.j * CELL, (p.i + 1) * CELL, (p.j + 1) * CELL]] : [];
    }
    const s = edgeSegment(edgeOf(p.i, p.j, p.side!));
    const along = s.x0 === s.x1 ? 'z' : 'x';
    const seg = (a: number, b: number): Rect => (along === 'x'
      ? [s.x0 + a, s.z0 - THICK, s.x0 + b, s.z0 + THICK]
      : [s.x0 - THICK, s.z0 + a, s.x0 + THICK, s.z0 + b]);
    if (p.kind === 'wall' || !p.open) return [seg(0, CELL)];
    // Open doorway: only the two side posts block.
    const gap0 = (CELL - DOOR.width) / 2, gap1 = gap0 + DOOR.width;
    return [seg(0, gap0 - NAV_GAP_MARGIN), seg(gap1 + NAV_GAP_MARGIN, CELL)];
  }

  dispose(): void {
    for (const off of this.offs) off();
  }
}

/**
 * The 1 m doorway minus agent-radius inflation on both posts would leave no
 * free nav cell at all, so the posts are shrunk slightly in the nav mask.
 * Creatures can then path through an open door; the posts are still solid
 * for physics.
 */
const NAV_GAP_MARGIN = 0.5;
