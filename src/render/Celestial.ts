import * as THREE from 'three';

/**
 * Sun, moon and stars, drawn as camera-following billboards just inside the
 * far plane (they ignore fog; terrain in front still hides them). The moon
 * sits roughly opposite the sun, a little off the sun's path, and goes
 * through eight phases, one per game day. Textures are drawn on canvases at
 * start-up: no image files.
 */

const DISTANCE = 370;
const MOON_PHASES = 8;

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')!];
}

/** Soft sun: a bright core fading into a wide glow. */
function sunTexture(): THREE.Texture {
  const [c, g] = canvas(256);
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,255,250,1)');
  grad.addColorStop(0.12, 'rgba(255,250,235,1)');
  grad.addColorStop(0.2, 'rgba(255,236,200,0.55)');
  grad.addColorStop(0.45, 'rgba(255,210,150,0.12)');
  grad.addColorStop(1, 'rgba(255,200,140,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** The moon disc (maria and craters), lit according to `phase` (0 = new, 0.5 = full). */
function moonTexture(phase: number): THREE.Texture {
  const S = 256, R = 100;
  const [c, g] = canvas(S);
  const cx = S / 2, cy = S / 2;
  // Soft halo around the disc.
  const halo = g.createRadialGradient(cx, cy, R * 0.9, cx, cy, S / 2);
  halo.addColorStop(0, 'rgba(200,215,255,0.18)');
  halo.addColorStop(1, 'rgba(200,215,255,0)');
  g.fillStyle = halo;
  g.fillRect(0, 0, S, S);
  // Surface.
  const [sc, sg] = canvas(S);
  sg.fillStyle = '#d9dbe0';
  sg.beginPath();
  sg.arc(cx, cy, R, 0, Math.PI * 2);
  sg.fill();
  let seed = 7;
  const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  sg.fillStyle = 'rgba(120,124,135,0.45)'; // maria
  for (const [x, y, r] of [[-30, -20, 34], [18, -35, 22], [25, 10, 28], [-10, 30, 20], [-45, 15, 16]] as const) {
    sg.beginPath();
    sg.ellipse(cx + x, cy + y, r, r * 0.8, rnd() * 3, 0, Math.PI * 2);
    sg.fill();
  }
  for (let k = 0; k < 40; k++) { // craters
    const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * R * 0.9, r = 2 + rnd() * 7;
    const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
    sg.fillStyle = 'rgba(90,92,100,0.35)';
    sg.beginPath();
    sg.arc(x, y, r, 0, Math.PI * 2);
    sg.fill();
    sg.fillStyle = 'rgba(255,255,255,0.25)';
    sg.beginPath();
    sg.arc(x - r * 0.3, y - r * 0.3, r * 0.5, 0, Math.PI * 2);
    sg.fill();
  }
  // Phase: light the disc as a sphere lit from the sun's side (phase 0 = new:
  // lit from behind, 0.5 = full: lit from the front), with a soft terminator.
  const th = phase * Math.PI * 2;
  const lx = Math.sin(th), lz = -Math.cos(th);
  const img = sg.getImageData(0, 0, S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const nx = (x - cx) / R, ny = (y - cy) / R, r2 = nx * nx + ny * ny;
      if (r2 > 1) continue;
      const lit = smooth(-0.06, 0.06, nx * lx + Math.sqrt(1 - r2) * lz);
      const k = 0.1 + 0.9 * lit, i = (y * S + x) * 4;
      img.data[i] = img.data[i]! * k;
      img.data[i + 1] = img.data[i + 1]! * k;
      img.data[i + 2] = Math.min(255, img.data[i + 2]! * k + (1 - lit) * 10);
    }
  }
  sg.putImageData(img, 0, 0);
  g.drawImage(sc, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Celestial {
  readonly group = new THREE.Group();
  private readonly sun: THREE.Sprite;
  private readonly moon: THREE.Sprite;
  private readonly stars: THREE.Points;
  private readonly moonTextures: THREE.Texture[] = [];
  private phase = -1;
  /** Unit direction toward the moon (read by the renderer for moonlight). */
  readonly moonDir = new THREE.Vector3();

  constructor() {
    const sunMat = new THREE.SpriteMaterial({
      map: sunTexture(), fog: false, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    this.sun = new THREE.Sprite(sunMat);
    this.sun.scale.setScalar(70);
    for (let k = 0; k < MOON_PHASES; k++) this.moonTextures.push(moonTexture(k / MOON_PHASES));
    this.moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.moonTextures[4]!, fog: false, depthWrite: false, transparent: true }));
    this.moon.scale.setScalar(34);

    // Stars on the upper sky, a few brighter than the rest.
    const n = 1400, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    let seed = 99;
    const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const y = 0.05 + rnd() * 0.95, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - y * y);
      pos.set([Math.cos(a) * r * DISTANCE, y * DISTANCE, Math.sin(a) * r * DISTANCE], i * 3);
      const b = 0.35 + rnd() ** 3 * 0.65, warm = rnd() * 0.15;
      col.set([b, b * (0.95 + warm * 0.3), b * (1.05 - warm)], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.stars = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 1.6, sizeAttenuation: false, vertexColors: true, fog: false, transparent: true, depthWrite: false, toneMapped: false,
    }));
    for (const o of [this.stars, this.moon, this.sun]) {
      o.frustumCulled = false;
      o.renderOrder = 1; // after the sky dome
    }
    this.group.add(this.stars, this.moon, this.sun);
  }

  /**
   * Places everything around the camera for the given sun direction,
   * daylight (0..1), game day (moon phase) and overcast (0..1, rain).
   */
  update(camera: THREE.Vector3, sunDir: THREE.Vector3, light: number, day: number, overcast = 0): void {
    const clear = 1 - 0.9 * overcast; // rain clouds hide sun, moon and stars
    this.group.position.copy(camera);
    this.sun.position.copy(sunDir).multiplyScalar(DISTANCE);
    // Haze at the horizon reddens and dims the sun; hidden once well below it.
    const elev = sunDir.y;
    this.sun.visible = elev > -0.08;
    (this.sun.material as THREE.SpriteMaterial).color.setRGB(1, 0.75 + 0.25 * smooth(0, 0.3, elev), 0.55 + 0.45 * smooth(0, 0.35, elev));
    (this.sun.material as THREE.SpriteMaterial).opacity = smooth(-0.08, 0.05, elev) * clear;

    // Moon: opposite the sun, tilted off its path.
    this.moonDir.set(-sunDir.x, -sunDir.y, -sunDir.z + 0.35).normalize();
    this.moon.position.copy(this.moonDir).multiplyScalar(DISTANCE * 0.98);
    this.moon.visible = this.moonDir.y > -0.05;
    // Faint by day, bright at night.
    (this.moon.material as THREE.SpriteMaterial).opacity = (0.25 + 0.75 * (1 - light)) * clear;
    const phase = ((day % MOON_PHASES) + MOON_PHASES) % MOON_PHASES;
    if (phase !== this.phase) {
      this.phase = phase;
      // Day 1 starts at full moon.
      (this.moon.material as THREE.SpriteMaterial).map = this.moonTextures[(phase + 4) % MOON_PHASES]!;
    }

    const night = (1 - smooth(0.08, 0.4, light)) * clear;
    this.stars.visible = night > 0.01;
    (this.stars.material as THREE.PointsMaterial).opacity = night;
  }

  /** 0 at new moon … 1 at full moon: how much light the moon gives. */
  get moonBrightness(): number {
    const p = ((this.phase + 4) % MOON_PHASES) / MOON_PHASES;
    return 0.5 - 0.5 * Math.cos(p * Math.PI * 2);
  }
}

function smooth(a: number, b: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
