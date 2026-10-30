/**
 * Terrain Web Worker. Runs the pure generator + nav-grid builder off the main
 * thread and transfers the typed arrays back without copying.
 *
 * Loaded with `new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' })`,
 * which Vite bundles as a separate module-worker chunk.
 */
import { buildNavGrid } from '../systems/ai/nav/NavGrid';
import { encodeTerrain } from './TerrainCodec';
import { generateTerrain } from './TerrainGenerator';
import type { TerrainRequest, TerrainResponse } from './terrainProtocol';

/**
 * Minimal view of the dedicated-worker global. Declared locally so this file
 * type-checks under the project's DOM lib without pulling in the WebWorker lib
 * (the two libs declare conflicting `self`/`postMessage` types).
 */
interface WorkerScope {
  postMessage(message: TerrainResponse, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (e: MessageEvent<TerrainRequest>) => void): void;
}
const scope = self as unknown as WorkerScope;

scope.addEventListener('message', (e) => {
  const req = e.data;
  if (req?.type !== 'generate') return;
  const t0 = performance.now();
  try {
    scope.postMessage({ type: 'progress', id: req.id, phase: 'heights', fraction: 0.1 });
    const terrain = generateTerrain(req.cfg);
    scope.postMessage({ type: 'progress', id: req.id, phase: 'nav', fraction: 0.6 });
    const nav = buildNavGrid(terrain);
    scope.postMessage({ type: 'progress', id: req.id, phase: 'encode', fraction: 0.9 });
    const { message, transfer } = encodeTerrain({ terrain, nav });
    scope.postMessage({ type: 'done', id: req.id, payload: message, ms: performance.now() - t0 }, transfer);
  } catch (err) {
    scope.postMessage({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
  }
});
