/**
 * Tree species, engine-free (shared by the generator, nav grid, physics and
 * the mesh factory so a trunk is exactly as thick as its collider).
 *
 * A tree prop's `variant` encodes species × 4 + shape sub-variant, so variants
 * 0..3 (all saves made before species existed) are still the classic fir.
 */
export interface TreeSpecies {
  name: string;
  /** Height at scale 1 (m). */
  height: number;
  /** Trunk radius at the base at scale 1 (m). */
  trunk: number;
  /** Distinct mesh shapes (sub-variants beyond this reuse the first ones). */
  shapes: number;
}

export const TREE_SPECIES: readonly TreeSpecies[] = [
  { name: 'Fir', height: 16, trunk: 0.32, shapes: 4 },
  { name: 'Spruce', height: 19, trunk: 0.34, shapes: 2 },
  { name: 'Pine', height: 18, trunk: 0.3, shapes: 2 },
  { name: 'Oak', height: 11, trunk: 0.45, shapes: 2 },
  { name: 'Birch', height: 13, trunk: 0.2, shapes: 2 },
  { name: 'Redwood', height: 26, trunk: 0.7, shapes: 2 },
  { name: 'Palm', height: 9, trunk: 0.2, shapes: 2 },
];

export const SPECIES = { fir: 0, spruce: 1, pine: 2, oak: 3, birch: 4, redwood: 5, palm: 6 } as const;

export function treeSpecies(variant: number): number {
  return Math.min(TREE_SPECIES.length - 1, Math.floor(variant / 4));
}

/** Variant reduced to the meshes that actually exist (fewer instanced buckets per chunk). */
export function treeShape(variant: number): number {
  const sp = treeSpecies(variant);
  return sp * 4 + ((variant % 4) % TREE_SPECIES[sp]!.shapes);
}

export function treeTrunkRadius(variant: number): number {
  return TREE_SPECIES[treeSpecies(variant)]!.trunk;
}

export function treeHeight(variant: number): number {
  return TREE_SPECIES[treeSpecies(variant)]!.height;
}
