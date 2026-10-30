import type * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { EventBus } from '../core/EventBus';

export interface AssetEntry {
  key: string;
  url: string;
  /**
   * Required assets without a working fallback abort loading. Everything
   * else degrades gracefully: the game is fully playable on procedural
   * low-poly meshes alone.
   */
  required: boolean;
  fallback?: () => THREE.Object3D;
}

export interface LoadReport {
  loaded: string[];
  fellBack: string[];
  failed: string[];
}

export interface AssetLoaderOptions {
  timeoutMs?: number;
  retries?: number;
  onProgress?: (done: number, total: number, key: string) => void;
}

/**
 * Asset loading with three layers of protection:
 *
 *  1. Timeout — a stalled CDN request must not freeze the loading screen.
 *  2. Retry with exponential backoff — transient network errors (flaky Wi-Fi,
 *     502 from the CDN) usually succeed on the second attempt.
 *  3. Fallback — on final failure, substitute the procedural mesh and emit
 *     'asset:failed' so the UI can show a non-blocking warning.
 *
 * Only a *required* asset with no fallback rejects the whole load, and the
 * caller then shows an error screen with a Retry button.
 */
export class AssetLoader {
  private readonly gltf = new GLTFLoader();
  private readonly cache = new Map<string, THREE.Object3D>();

  constructor(private readonly events: EventBus, private readonly opts: AssetLoaderOptions = {}) {}

  async loadAll(entries: readonly AssetEntry[]): Promise<LoadReport> {
    const report: LoadReport = { loaded: [], fellBack: [], failed: [] };
    let done = 0;
    await Promise.all(
      entries.map(async (entry) => {
        try {
          const obj = await this.withRetry(entry);
          this.cache.set(entry.key, obj);
          report.loaded.push(entry.key);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (entry.fallback) {
            this.cache.set(entry.key, entry.fallback());
            report.fellBack.push(entry.key);
            this.events.emit('asset:failed', { key: entry.key, error: message, usingFallback: true });
          } else {
            report.failed.push(entry.key);
            this.events.emit('asset:failed', { key: entry.key, error: message, usingFallback: false });
          }
        } finally {
          this.opts.onProgress?.(++done, entries.length, entry.key);
        }
      }),
    );
    const fatal = entries.filter((e) => e.required && report.failed.includes(e.key));
    if (fatal.length) {
      throw new AssetLoadError(`Required assets failed: ${fatal.map((e) => e.key).join(', ')}`, report);
    }
    return report;
  }

  /** Returns a fresh clone so callers can transform it freely. */
  get(key: string): THREE.Object3D | undefined {
    return this.cache.get(key)?.clone();
  }

  private async withRetry(entry: AssetEntry): Promise<THREE.Object3D> {
    const retries = this.opts.retries ?? 2;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.loadOnce(entry.url);
      } catch (err) {
        lastErr = err;
        // A 404 won't fix itself, and neither will a parse error (dev servers
        // with SPA fallback answer missing .glb files with index.html → JSON
        // parse failure). Retry only what looks transient.
        if (err instanceof Error && /404|not found|unexpected token|json|invalid|unsupported/i.test(err.message)) break;
        if (attempt < retries) await sleep(300 * 2 ** attempt);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private loadOnce(url: string): Promise<THREE.Object3D> {
    const timeoutMs = this.opts.timeoutMs ?? 15000;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(new Error(`Timed out after ${timeoutMs} ms: ${url}`));
      }, timeoutMs);
      this.gltf.load(
        url,
        (gltf) => {
          if (settled) return;
          clearTimeout(timer);
          gltf.scene.traverse((o) => {
            const m = o as THREE.Mesh;
            if (m.isMesh) m.castShadow = m.receiveShadow = true;
          });
          resolve(gltf.scene);
        },
        undefined,
        (err) => {
          if (settled) return;
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(`Failed to load ${url}`));
        },
      );
    });
  }
}

export class AssetLoadError extends Error {
  constructor(message: string, readonly report: LoadReport) {
    super(message);
    this.name = 'AssetLoadError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
