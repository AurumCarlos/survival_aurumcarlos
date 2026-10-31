/**
 * Headless checks for the settings: validation of stored values, and that
 * gameplay is no longer adjustable (only graphics, controls and sound).
 */
import { CONTROL_DEFS, DEFAULT_CONTROLS, DEFAULT_GRAPHICS, GRAPHICS_DEFS, sanitize, type GraphicsSettings } from '../src/data/settings';
import * as settings from '../src/data/settings';

declare const process: { exit(code: number): never };
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

console.log('── Settings ──');
const g = sanitize<GraphicsSettings>(GRAPHICS_DEFS, { detailedTrees: 999, quality: 'ultra', showFps: 'yes', resolution: '0.7', bogus: 1 });
check('stored values are validated: clamped, unknown dropped, bad types reset',
  g.detailedTrees === 80 && g.quality === 'auto' && g.showFps === true && g.resolution === '0.7' && !('bogus' in g));
const inRange = [...GRAPHICS_DEFS, ...CONTROL_DEFS].every((d) => d.kind.type !== 'range' || (d.default as number) >= d.kind.min && (d.default as number) <= d.kind.max);
check('defaults are valid', inRange && DEFAULT_GRAPHICS.detailedTrees === 15 && DEFAULT_CONTROLS.fov === 75);
check('no simulation settings any more (a game, not a simulator)', !('SIM' in settings) && !('SIM_DEFS' in settings));

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
