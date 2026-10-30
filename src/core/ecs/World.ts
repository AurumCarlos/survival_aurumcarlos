/**
 * Minimal, allocation-conscious ECS.
 *
 * - Entities are plain integers (recycled through a free list).
 * - Components are plain data objects stored in one Map per component type.
 * - Systems own all behaviour; components never hold methods or references to
 *   Three.js / Cannon objects except through dedicated "handle" components
 *   (see components/index.ts), which keeps game rules testable without a GPU.
 */

export type Entity = number;

/** Typed token identifying a component store. The phantom field carries T. */
export interface ComponentType<T> {
  readonly id: number;
  readonly name: string;
  /** @internal phantom type marker, never set at runtime */
  readonly __type?: T;
}

let nextComponentId = 0;
export function defineComponent<T>(name: string): ComponentType<T> {
  return { id: nextComponentId++, name };
}

export class World {
  private nextEntity: Entity = 1;
  private readonly freeList: Entity[] = [];
  private readonly alive = new Set<Entity>();
  private readonly stores = new Map<number, Map<Entity, unknown>>();
  /** Destruction is deferred to the end of the tick so systems can iterate safely. */
  private readonly pendingDestroy = new Set<Entity>();
  private readonly destroyListeners: Array<(e: Entity) => void> = [];

  create(): Entity {
    const e = this.freeList.pop() ?? this.nextEntity++;
    this.alive.add(e);
    return e;
  }

  isAlive(e: Entity): boolean {
    return this.alive.has(e) && !this.pendingDestroy.has(e);
  }

  /** Marks an entity for removal; it disappears from queries after flush(). */
  destroy(e: Entity): void {
    if (this.alive.has(e)) this.pendingDestroy.add(e);
  }

  onDestroy(listener: (e: Entity) => void): void {
    this.destroyListeners.push(listener);
  }

  /** Called by the game loop once per frame, after all systems have run. */
  flush(): void {
    if (this.pendingDestroy.size === 0) return;
    for (const e of this.pendingDestroy) {
      for (const l of this.destroyListeners) l(e);
      for (const store of this.stores.values()) store.delete(e);
      this.alive.delete(e);
      this.freeList.push(e);
    }
    this.pendingDestroy.clear();
  }

  add<T>(e: Entity, type: ComponentType<T>, data: T): T {
    this.storeOf(type).set(e, data);
    return data;
  }

  remove<T>(e: Entity, type: ComponentType<T>): void {
    this.stores.get(type.id)?.delete(e);
  }

  has<T>(e: Entity, type: ComponentType<T>): boolean {
    return this.stores.get(type.id)?.has(e) ?? false;
  }

  get<T>(e: Entity, type: ComponentType<T>): T | undefined {
    return this.stores.get(type.id)?.get(e) as T | undefined;
  }

  /** Like get(), but throws: use when absence is a programming error. */
  require<T>(e: Entity, type: ComponentType<T>): T {
    const c = this.get(e, type);
    if (c === undefined) throw new Error(`Entity ${e} is missing component ${type.name}`);
    return c;
  }

  /**
   * Yields entities that have every listed component. Iterates the smallest
   * store and probes the others, so a query over "Survivor + Transform" costs
   * O(#survivors), not O(#transforms).
   */
  *query(...types: ComponentType<unknown>[]): Generator<Entity> {
    if (types.length === 0) return;
    let smallest: Map<Entity, unknown> | undefined;
    for (const t of types) {
      const s = this.stores.get(t.id);
      if (!s) return;
      if (!smallest || s.size < smallest.size) smallest = s;
    }
    if (!smallest) return;
    outer: for (const e of smallest.keys()) {
      if (this.pendingDestroy.has(e)) continue;
      for (const t of types) {
        if (!this.stores.get(t.id)!.has(e)) continue outer;
      }
      yield e;
    }
  }

  /** First entity matching a query, e.g. the local player. */
  first(...types: ComponentType<unknown>[]): Entity | undefined {
    for (const e of this.query(...types)) return e;
    return undefined;
  }

  get entityCount(): number {
    return this.alive.size;
  }

  private storeOf<T>(type: ComponentType<T>): Map<Entity, T> {
    let s = this.stores.get(type.id);
    if (!s) {
      s = new Map();
      this.stores.set(type.id, s);
    }
    return s as Map<Entity, T>;
  }
}

/**
 * Systems split work between two phases:
 *  - fixedUpdate(dt): deterministic simulation at a constant step (physics, AI,
 *    metabolism). May run 0..N times per rendered frame.
 *  - update(dt, alpha): once per rendered frame (input sampling, camera,
 *    interpolation, UI). `alpha` ∈ [0,1) is how far we are between the last
 *    two fixed steps; see RenderSyncSystem.
 */
export interface System {
  readonly name: string;
  fixedUpdate?(world: World, dt: number): void;
  update?(world: World, dt: number, alpha: number): void;
  dispose?(): void;
}
