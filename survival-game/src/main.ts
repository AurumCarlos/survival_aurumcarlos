import './styles.css';
import { App } from './app/App';

/**
 * Entry point. All wiring lives in app/App.ts (long-lived services + state
 * machine) and app/GameSession.ts (one game's world and systems).
 */
const root = document.getElementById('app')!;

// WebGL availability check before anything touches the GPU.
if (!document.createElement('canvas').getContext('webgl2')) {
  root.innerHTML = '<div class="fatal">This game needs WebGL 2. Enable hardware acceleration in your browser settings and reload.</div>';
} else {
  const app = new App(root);
  app.start().catch((err: unknown) => {
    console.error(err);
    root.insertAdjacentHTML('beforeend', `<div class="fatal">Failed to start: ${String(err)}</div>`);
  });
}
