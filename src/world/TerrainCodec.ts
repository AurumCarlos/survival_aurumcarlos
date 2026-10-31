import type { NavGridData } from '../systems/ai/nav/NavGrid';
import type { Cave, PropKind, PropPlacement, Spawn, TerrainConfig, TerrainData } from './TerrainGenerator';

/** Everything the terrain worker produces. */
export interface TerrainBundle {
  terrain: TerrainData;
  nav: NavGridData;
}

/**
 * Wire format between the worker and the main thread. Every bulk array is a
 * typed array whose buffer is *transferred* (zero-copy) rather than cloned.
 * Props are packed 8 floats each instead of sent as ~10k JS objects, which
 * would cost several ms of structured-clone on each side.
 */
export interface EncodedTerrain {
  cfg: TerrainConfig;
  heights: Float32Array;
  slopes: Float32Array;
  props: Float32Array;
  chunksPerSide: number;
  maxY: number;
  spawn: Spawn;
  nav: NavGridData;
  biomes?: Uint8Array;
  caves?: Cave[];
}

const KINDS: readonly PropKind[] = [
  'tree', 'rock', 'berry_bush', 'fiber_plant', 'carcass', 'water_source', 'grass_tuft', 'log', 'mushroom',
  // appended (indices above must never change)
  'metal_rock', 'obsidian_rock', 'crystal', 'oil_rock', 'shell_bed', 'salt_deposit', 'rare_flower', 'fish_shoal',
  'cactus', 'dead_bush', 'tall_grass', 'reeds', // gen 4
];
const STRIDE = 8; // kind, x, y, z, rotationY, scale, variant, chunk

export function encodeTerrain(b: TerrainBundle): { message: EncodedTerrain; transfer: ArrayBuffer[] } {
  const t = b.terrain;
  const props = new Float32Array(t.props.length * STRIDE);
  t.props.forEach((p, i) => {
    const o = i * STRIDE;
    props[o] = KINDS.indexOf(p.kind);
    props[o + 1] = p.position.x;
    props[o + 2] = p.position.y;
    props[o + 3] = p.position.z;
    props[o + 4] = p.rotationY;
    props[o + 5] = p.scale;
    props[o + 6] = p.variant;
    props[o + 7] = p.chunk;
  });
  const message: EncodedTerrain = {
    cfg: t.cfg, heights: t.heights, slopes: t.slopes, props, chunksPerSide: t.chunksPerSide, maxY: t.maxY, spawn: t.spawn, nav: b.nav,
    ...(t.biomes ? { biomes: t.biomes } : {}), ...(t.caves ? { caves: t.caves } : {}),
  };
  const transfer = [t.heights.buffer, t.slopes.buffer, props.buffer, b.nav.blocked.buffer, b.nav.cost.buffer] as ArrayBuffer[];
  if (b.nav.obstacles) transfer.push(b.nav.obstacles.buffer as ArrayBuffer);
  if (t.biomes) transfer.push(t.biomes.buffer as ArrayBuffer);
  return { message, transfer };
}

export function decodeTerrain(m: EncodedTerrain): TerrainBundle {
  const n = m.props.length / STRIDE;
  const props: PropPlacement[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * STRIDE;
    const kind = KINDS[m.props[o]!];
    if (!kind) throw new Error(`Corrupt terrain payload: unknown prop kind ${m.props[o]}`);
    props[i] = {
      kind,
      // Float32 storage: positions round-trip to ~1e-5 m, irrelevant for gameplay.
      position: { x: m.props[o + 1]!, y: m.props[o + 2]!, z: m.props[o + 3]! },
      rotationY: m.props[o + 4]!,
      scale: m.props[o + 5]!,
      variant: m.props[o + 6]!,
      chunk: m.props[o + 7]!,
    };
  }
  return {
    terrain: {
      cfg: m.cfg, heights: m.heights, slopes: m.slopes, props, chunksPerSide: m.chunksPerSide, maxY: m.maxY, spawn: { ...m.spawn },
      ...(m.biomes ? { biomes: m.biomes } : {}), ...(m.caves ? { caves: m.caves } : {}),
    },
    nav: m.nav,
  };
}
