import type { TerrainConfig } from './TerrainGenerator';
import type { EncodedTerrain } from './TerrainCodec';

/** Messages main → worker. */
export interface TerrainRequest {
  type: 'generate';
  /** Correlates responses with requests so a stale reply can never be mistaken for the current one. */
  id: number;
  cfg: TerrainConfig;
}

/** Messages worker → main. */
export type TerrainResponse =
  | { type: 'progress'; id: number; phase: 'heights' | 'nav' | 'encode'; fraction: number }
  | { type: 'done'; id: number; payload: EncodedTerrain; ms: number }
  | { type: 'error'; id: number; message: string };
