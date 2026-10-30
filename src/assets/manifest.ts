import type { AssetEntry } from './AssetLoader';
import { campfireObject, leanToObject } from '../render/LowPolyFactory';
import { creatureMesh } from '../render/CreatureModels';

/**
 * Optional authored models. Drop .glb files into /public/assets to replace
 * the procedural defaults; if a file is missing or broken the procedural
 * mesh is used and a toast is shown. Nothing here is required, so the game
 * always boots.
 */
export const ASSET_MANIFEST: readonly AssetEntry[] = [
  { key: 'wolf', url: 'assets/wolf.glb', required: false, fallback: () => creatureMesh('wolf') },
  { key: 'deer', url: 'assets/deer.glb', required: false, fallback: () => creatureMesh('deer') },
  { key: 'boar', url: 'assets/boar.glb', required: false, fallback: () => creatureMesh('boar') },
  { key: 'campfire', url: 'assets/campfire.glb', required: false, fallback: campfireObject },
  { key: 'lean_to', url: 'assets/lean_to.glb', required: false, fallback: leanToObject },
];
