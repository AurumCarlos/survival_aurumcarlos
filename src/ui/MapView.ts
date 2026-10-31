import type { Entity, World } from '../core/ecs/World';
import { PlayerControlled, Structure, Transform } from '../components';
import type { BuildingGrid } from '../systems/building/BuildingGrid';
import { CELL } from '../systems/building/BuildingGrid';
import { BIOME_NAME, type TerrainData } from '../world/TerrainGenerator';

/**
 * The minimap (top right, north up, ~110 m around you) and the full map (M).
 *
 * Both draw from one picture of the island made once per session from the
 * terrain data: biome colours, water by depth, steep rock, hill shading lit
 * from the north-west and faint contour lines every 10 m, so the relief
 * reads at a glance. Markers on top: you (an arrow, turning with your
 * view), your camp (fires, boxes, stations), your buildings, beds and caves.
 */

/** Map picture resolution (px for the whole map). */
const BASE = 768;
/** Minimap: radius shown around the player (m), size on screen (CSS px). */
const MINI_RADIUS = 110;
const MINI_SIZE = 176;

/** Biome colours, by BIOME id (sRGB). */
const BIOME_RGB: ReadonlyArray<readonly [number, number, number]> = [
  [216, 199, 154], // beach
  [76, 122, 58], // forest
  [63, 122, 53], // jungle
  [126, 160, 74], // meadow
  [138, 134, 106], // highlands
  [238, 242, 245], // snow
  [85, 85, 85], // cave
  [91, 107, 62], // mangrove
  [47, 106, 46], // rainforest
  [194, 169, 90], // savanna
  [224, 200, 138], // desert
  [143, 176, 76], // prairie
  [167, 179, 164], // tundra
  [111, 154, 85], // lake shore
];

export class MapView {
  private readonly base: HTMLCanvasElement;
  private readonly mini: HTMLCanvasElement;
  private readonly miniWrap: HTMLElement;
  private readonly full: HTMLElement;
  private readonly fullCanvas: HTMLCanvasElement;
  private readonly legend: HTMLElement;
  private acc = 1;
  private open = false;
  private readonly size: number;

  constructor(
    private readonly container: HTMLElement,
    private readonly terrain: TerrainData,
    private readonly buildings: BuildingGrid,
  ) {
    this.size = terrain.cfg.size;
    this.base = this.paintBase();

    this.miniWrap = document.createElement('div');
    this.miniWrap.className = 'minimap';
    this.mini = document.createElement('canvas');
    this.miniWrap.appendChild(this.mini);
    const north = document.createElement('span');
    north.className = 'minimap-n';
    north.textContent = 'N';
    this.miniWrap.appendChild(north);
    container.appendChild(this.miniWrap);

    this.full = document.createElement('div');
    this.full.className = 'fullmap';
    this.full.innerHTML = `<div class="fullmap-card"><h2>Map <small>M to close</small></h2><div class="fullmap-body"></div><div class="fullmap-legend"></div></div>`;
    this.fullCanvas = document.createElement('canvas');
    this.full.querySelector('.fullmap-body')!.appendChild(this.fullCanvas);
    this.legend = this.full.querySelector('.fullmap-legend')!;
    this.legend.innerHTML = this.legendHtml();
    container.appendChild(this.full);
  }

  get isOpen(): boolean {
    return this.open;
  }

  toggle(open = !this.open): void {
    this.open = open;
    this.full.classList.toggle('open', open);
    this.acc = 1; // redraw now
  }

  /** Per frame; redraws at ~15 Hz (the full map too while open). */
  update(world: World, player: Entity, dt: number): void {
    this.acc += dt;
    if (this.acc < 1 / 15) return;
    this.acc = 0;
    const t = world.get(player, Transform);
    const pc = world.get(player, PlayerControlled);
    if (!t || !pc) return;
    this.drawMini(world, t.position.x, t.position.z, pc.yaw);
    if (this.open) this.drawFull(world, t.position.x, t.position.z, pc.yaw);
  }

  dispose(): void {
    this.miniWrap.remove();
    this.full.remove();
  }

  // ---- Drawing ---------------------------------------------------------------

  private drawMini(world: World, px: number, pz: number, yaw: number): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const S = Math.round(MINI_SIZE * dpr);
    if (this.mini.width !== S) this.mini.width = this.mini.height = S;
    const g = this.mini.getContext('2d')!;
    g.clearRect(0, 0, S, S);
    g.save();
    g.beginPath();
    g.arc(S / 2, S / 2, S / 2 - 1, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = '#1d5f80'; // open sea past the map edge
    g.fillRect(0, 0, S, S);
    const k = BASE / this.size; // base px per metre
    g.imageSmoothingEnabled = true;
    g.drawImage(this.base, (px + this.size / 2 - MINI_RADIUS) * k, (pz + this.size / 2 - MINI_RADIUS) * k, MINI_RADIUS * 2 * k, MINI_RADIUS * 2 * k, 0, 0, S, S);
    const toScreen = (x: number, z: number): [number, number] => [S / 2 + ((x - px) / MINI_RADIUS) * (S / 2), S / 2 + ((z - pz) / MINI_RADIUS) * (S / 2)];
    this.drawMarkers(g, world, toScreen, dpr, MINI_RADIUS * 1.5, px, pz);
    g.restore();
    drawArrow(g, S / 2, S / 2, yaw, 9 * dpr);
  }

  private drawFull(world: World, px: number, pz: number, yaw: number): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const css = Math.floor(Math.min(window.innerWidth * 0.62, window.innerHeight * 0.78));
    const S = Math.round(css * dpr);
    if (this.fullCanvas.width !== S) {
      this.fullCanvas.width = this.fullCanvas.height = S;
      this.fullCanvas.style.width = this.fullCanvas.style.height = `${css}px`;
    }
    const g = this.fullCanvas.getContext('2d')!;
    g.drawImage(this.base, 0, 0, S, S);
    const toScreen = (x: number, z: number): [number, number] => [((x + this.size / 2) / this.size) * S, ((z + this.size / 2) / this.size) * S];
    this.drawMarkers(g, world, toScreen, dpr, Infinity, px, pz);
    const [sx, sz] = toScreen(px, pz);
    drawArrow(g, sx, sz, yaw, 11 * dpr);
    // Scale bar: 100 m.
    const bar = (100 / this.size) * S;
    g.fillStyle = 'rgba(0,0,0,.55)';
    g.fillRect(12 * dpr, S - 30 * dpr, bar + 16 * dpr, 20 * dpr);
    g.fillStyle = '#fff';
    g.fillRect(20 * dpr, S - 18 * dpr, bar, 3 * dpr);
    g.font = `${11 * dpr}px system-ui, sans-serif`;
    g.fillText('100 m', 20 * dpr, S - 22 * dpr);
  }

  /** Caves, buildings, beds and camp structures (within `range` m of the player when finite). */
  private drawMarkers(
    g: CanvasRenderingContext2D, world: World, toScreen: (x: number, z: number) => [number, number],
    dpr: number, range: number, px: number, pz: number,
  ): void {
    const near = (x: number, z: number): boolean => range === Infinity || Math.abs(x - px) < range && Math.abs(z - pz) < range;
    for (const c of this.terrain.caves ?? []) {
      if (!near(c.x, c.z)) continue;
      const [x, y] = toScreen(c.x, c.z);
      g.fillStyle = '#1b1b1b';
      g.strokeStyle = '#d8d0c0';
      g.lineWidth = 1.5 * dpr;
      g.beginPath();
      g.arc(x, y, 4.5 * dpr, Math.PI, 0); // a cave mouth
      g.lineTo(x + 4.5 * dpr, y + 3 * dpr);
      g.lineTo(x - 4.5 * dpr, y + 3 * dpr);
      g.closePath();
      g.fill();
      g.stroke();
    }
    for (const p of this.buildings.pieces()) {
      const wx = (p.i + 0.5) * CELL, wz = (p.j + 0.5) * CELL;
      if (!near(wx, wz)) continue;
      const [x, y] = toScreen(wx, wz);
      if (p.kind === 'bed') {
        g.fillStyle = '#6fa8ff';
        g.fillRect(x - 3 * dpr, y - 3 * dpr, 6 * dpr, 6 * dpr);
      } else if (p.kind === 'foundation') {
        const s = Math.max(2 * dpr, Math.abs(toScreen(wx + CELL, wz)[0] - x));
        g.fillStyle = 'rgba(230, 210, 170, .85)';
        g.fillRect(x - s / 2, y - s / 2, s, s);
      }
    }
    for (const e of world.query(Structure, Transform)) {
      const st = world.require(e, Structure);
      const pos = world.require(e, Transform).position;
      if (!near(pos.x, pos.z)) continue;
      const [x, y] = toScreen(pos.x, pos.z);
      g.fillStyle = st.kind === 'campfire' ? '#ff9a3c' : st.kind === 'death_bag' ? '#e04848' : '#c79a5a';
      g.beginPath();
      g.arc(x, y, (st.kind === 'death_bag' ? 4 : 3) * dpr, 0, Math.PI * 2);
      g.fill();
    }
  }

  private legendHtml(): string {
    const present = new Set<number>(this.terrain.biomes ?? []);
    const items = BIOME_RGB.map((c, b) => ({ b, c })).filter(({ b }) => present.has(b) && b !== 6);
    const swatch = (rgb: readonly number[], label: string): string =>
      `<span><i style="background: rgb(${rgb.join(',')})"></i>${label}</span>`;
    return [
      ...items.map(({ b, c }) => swatch(c, BIOME_NAME[b] ?? '')),
      swatch([87, 194, 201], 'Water'),
      '<span><b class="lg-you">▲</b>You</span><span><b class="lg-cave">◖</b>Cave</span><span><b style="color:#ff9a3c">●</b>Camp</span><span><b style="color:#6fa8ff">■</b>Bed</span>',
    ].join('');
  }

  /** The island picture, once. */
  private paintBase(): HTMLCanvasElement {
    const t = this.terrain;
    const { size, resolution, waterLevel: W } = t.cfg;
    const n = resolution + 1;
    const c = document.createElement('canvas');
    c.width = c.height = BASE;
    const g = c.getContext('2d')!;
    const img = g.createImageData(BASE, BASE);
    const d = img.data;
    const h = (ix: number, iz: number): number => t.heights[Math.min(n - 1, Math.max(0, iz)) * n + Math.min(n - 1, Math.max(0, ix))]!;
    const step = size / resolution;
    for (let py = 0; py < BASE; py++) {
      for (let px = 0; px < BASE; px++) {
        const fx = ((px + 0.5) / BASE) * resolution, fz = ((py + 0.5) / BASE) * resolution;
        const ix = Math.round(fx), iz = Math.round(fz);
        const y = h(ix, iz);
        let r: number, gr: number, b: number;
        if (y < W) {
          // Water: turquoise shallows to deep blue.
          const depth = Math.min(1, (W - y) / 5);
          r = 87 + (29 - 87) * depth;
          gr = 194 + (95 - 194) * depth;
          b = 201 + (128 - 201) * depth;
        } else {
          const biome = t.biomes ? t.biomes[iz * n + ix]! : 1;
          [r, gr, b] = (BIOME_RGB[biome] ?? BIOME_RGB[1]!) as [number, number, number];
          const slope = t.slopes[iz * n + ix]!;
          if (slope > 0.22) {
            const k = Math.min(1, (slope - 0.22) / 0.2);
            r += (124 - r) * k;
            gr += (118 - gr) * k;
            b += (108 - b) * k;
          }
          // Hill shading, lit from the north-west.
          const dx = (h(ix + 1, iz) - h(ix - 1, iz)) / (2 * step), dz = (h(ix, iz + 1) - h(ix, iz - 1)) / (2 * step);
          const shade = Math.max(0.55, Math.min(1.25, 1 - (dx + dz) * 0.9));
          r *= shade;
          gr *= shade;
          b *= shade;
          // Contours every 10 m.
          const band = (y - W) / 10;
          if (Math.abs(band - Math.round(band)) < 0.04 && y - W > 2) {
            r *= 0.8;
            gr *= 0.8;
            b *= 0.8;
          }
          if (y < W + 0.35) { // wet edge
            r = r * 0.85 + 20;
            gr = gr * 0.85 + 20;
            b = b * 0.85 + 30;
          }
        }
        const o = (py * BASE + px) * 4;
        d[o] = r;
        d[o + 1] = gr;
        d[o + 2] = b;
        d[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }
}

/** The player: an arrow pointing where they look (north up; yaw 0 looks north). */
function drawArrow(g: CanvasRenderingContext2D, x: number, y: number, yaw: number, s: number): void {
  g.save();
  g.translate(x, y);
  g.rotate(-yaw);
  g.beginPath();
  g.moveTo(0, -s);
  g.lineTo(s * 0.62, s * 0.7);
  g.lineTo(0, s * 0.35);
  g.lineTo(-s * 0.62, s * 0.7);
  g.closePath();
  g.fillStyle = '#ffffff';
  g.strokeStyle = '#1a1a1a';
  g.lineWidth = Math.max(1, s * 0.16);
  g.fill();
  g.stroke();
  g.restore();
}
