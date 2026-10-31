/**
 * Bakes the procedural terrain textures off the main thread at start-up
 * (see prepareTerrainTextures in Textures.ts), so loading a world doesn't
 * spend a second or two on them.
 */
import { bakeTerrainData } from './Textures';

declare const self: { postMessage(msg: unknown, transfer: Transferable[]): void };

const data = bakeTerrainData();
self.postMessage(data, [data.albedo.buffer, data.normal.buffer, data.means.buffer]);
