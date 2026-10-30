import { buildNavGrid } from '../systems/ai/nav/NavGrid';
import { decodeTerrain, encodeTerrain, type TerrainBundle } from './TerrainCodec';
import { generateTerrain, type TerrainConfig } from './TerrainGenerator';
import type { TerrainRequest, TerrainResponse } from './terrainProtocol';

export type WorkerFactory = () => Worker;

export interface GenerateOptions {
  signal?: AbortSignal;
  onProgress?: (fraction: number, phase: string) => void;
}

export class GenerationAbortedError extends Error {
  constructor() {
    super('Terrain generation was cancelled');
    this.name = 'AbortError';
  }
}

/**
 * Async terrain generation.
 *
 * - One fresh worker per request. Cancelling (back to menu, double-clicked
 *   "Start") terminates it immediately — no orphaned CPU work, and no chance
 *   of a stale result arriving after a newer request.
 * - Each request carries an id and replies with a different id are ignored.
 * - If workers are unavailable (old browser, CSP, worker script failed to
 *   load) generation falls back to the main thread. Slower to show, but the
 *   game still starts.
 * - Both paths go through the same encode/decode step, so a world is
 *   bit-identical whether it was generated in a worker or inline — which the
 *   save system relies on (it stores the seed, not the terrain).
 */
export class TerrainService {
  private nextId = 1;
  /** Set once a worker has failed to start, so we don't keep retrying it. */
  private workersBroken = false;
  lastMode: 'worker' | 'inline' | null = null;

  constructor(private readonly factory: WorkerFactory | null) {}

  async generate(cfg: TerrainConfig, opts: GenerateOptions = {}): Promise<TerrainBundle> {
    if (opts.signal?.aborted) throw new GenerationAbortedError();
    if (this.factory && !this.workersBroken && typeof Worker !== 'undefined') {
      try {
        const bundle = await this.viaWorker(cfg, opts);
        this.lastMode = 'worker';
        return bundle;
      } catch (err) {
        if (err instanceof GenerationAbortedError) throw err;
        if (!(err instanceof WorkerStartupError)) throw err;
        console.warn('[TerrainService] worker unavailable, generating on the main thread:', err.message);
        this.workersBroken = true;
      }
    }
    this.lastMode = 'inline';
    return this.inline(cfg, opts);
  }

  private viaWorker(cfg: TerrainConfig, opts: GenerateOptions): Promise<TerrainBundle> {
    const id = this.nextId++;
    return new Promise<TerrainBundle>((resolve, reject) => {
      let worker: Worker;
      try {
        worker = this.factory!();
      } catch (err) {
        reject(new WorkerStartupError(String(err)));
        return;
      }
      let gotMessage = false;
      const cleanup = (): void => {
        worker.terminate();
        opts.signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        cleanup();
        reject(new GenerationAbortedError());
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      worker.addEventListener('message', (e: MessageEvent<TerrainResponse>) => {
        const msg = e.data;
        gotMessage = true;
        if (msg.id !== id) return; // stale reply
        if (msg.type === 'progress') {
          opts.onProgress?.(msg.fraction, msg.phase);
        } else if (msg.type === 'done') {
          cleanup();
          try {
            resolve(decodeTerrain(msg.payload));
          } catch (err) {
            reject(err);
          }
        } else {
          cleanup();
          reject(new Error(`Terrain worker failed: ${msg.message}`));
        }
      });
      // An 'error' before any message means the script itself didn't load/parse.
      worker.addEventListener('error', (e: ErrorEvent) => {
        e.preventDefault();
        cleanup();
        reject(gotMessage ? new Error(`Terrain worker crashed: ${e.message}`) : new WorkerStartupError(e.message || 'worker failed to start'));
      });
      const req: TerrainRequest = { type: 'generate', id, cfg };
      worker.postMessage(req);
    });
  }

  private async inline(cfg: TerrainConfig, opts: GenerateOptions): Promise<TerrainBundle> {
    // Yield between phases so the loading screen can paint and a cancel can land.
    const checkpoint = async (fraction: number, phase: string): Promise<void> => {
      opts.onProgress?.(fraction, phase);
      await new Promise<void>((r) => setTimeout(r, 0));
      if (opts.signal?.aborted) throw new GenerationAbortedError();
    };
    await checkpoint(0.1, 'heights');
    const terrain = generateTerrain(cfg);
    await checkpoint(0.6, 'nav');
    const nav = buildNavGrid(terrain);
    await checkpoint(0.9, 'encode');
    return decodeTerrain(encodeTerrain({ terrain, nav }).message);
  }
}

class WorkerStartupError extends Error {}
