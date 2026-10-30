import type { Entity, World } from '../../core/ecs/World';
import type { Blackboard } from '../../components';

/**
 * A small behaviour-tree runtime.
 *
 * Design choice: nodes are *stateless* and all per-creature state lives in
 * the entity's Blackboard. That lets one tree instance drive every wolf in
 * the world (no per-creature node allocations), and makes the tree
 * "reactive": the root Selector re-evaluates from the top every tick, so a
 * wolf that is mid-patrol switches to Chase the moment it spots the player,
 * and a chasing wolf flees the instant it is badly hurt.
 */

export type BTStatus = 'success' | 'failure' | 'running';

export interface BTContext<S> {
  world: World;
  entity: Entity;
  bb: Blackboard;
  dt: number;
  services: S;
}

export interface BTNode<S> {
  readonly label: string;
  tick(ctx: BTContext<S>): BTStatus;
}

/** Runs children in order; succeeds on the first child that does not fail. */
export class Selector<S> implements BTNode<S> {
  constructor(readonly label: string, private readonly children: BTNode<S>[]) {}
  tick(ctx: BTContext<S>): BTStatus {
    for (const c of this.children) {
      const s = c.tick(ctx);
      if (s !== 'failure') return s;
    }
    return 'failure';
  }
}

/** Runs children in order; fails on the first child that does not succeed. */
export class Sequence<S> implements BTNode<S> {
  constructor(readonly label: string, private readonly children: BTNode<S>[]) {}
  tick(ctx: BTContext<S>): BTStatus {
    for (const c of this.children) {
      const s = c.tick(ctx);
      if (s !== 'success') return s;
    }
    return 'success';
  }
}

export class Condition<S> implements BTNode<S> {
  constructor(readonly label: string, private readonly test: (ctx: BTContext<S>) => boolean) {}
  tick(ctx: BTContext<S>): BTStatus {
    return this.test(ctx) ? 'success' : 'failure';
  }
}

export class Action<S> implements BTNode<S> {
  constructor(readonly label: string, private readonly run: (ctx: BTContext<S>) => BTStatus) {}
  tick(ctx: BTContext<S>): BTStatus {
    return this.run(ctx);
  }
}

export class Inverter<S> implements BTNode<S> {
  readonly label: string;
  constructor(private readonly child: BTNode<S>) {
    this.label = `!${child.label}`;
  }
  tick(ctx: BTContext<S>): BTStatus {
    const s = this.child.tick(ctx);
    return s === 'success' ? 'failure' : s === 'failure' ? 'success' : 'running';
  }
}
