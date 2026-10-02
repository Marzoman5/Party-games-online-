/**
 * Procedural item visuals: 64x64 Canvas2D HUD icons and low-poly 3D meshes.
 * Everything is generated in code (no asset files). Geometries, materials and
 * textures are cached module-wide and shared between mesh instances.
 */
import * as THREE from 'three';
import type { ItemType } from '../core/types';
import { TAU } from '../core/math';

// ---------------------------------------------------------------------------
// Icons (Canvas2D)
// ---------------------------------------------------------------------------

const ICON_SIZE = 64;
const iconCache = new Map<ItemType, HTMLCanvasElement>();

/** Returns a cached 64x64 canvas icon for the HUD item slot / roulette. */
export function buildItemIcon(item: ItemType): HTMLCanvasElement {
  const cached = iconCache.get(item);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, ICON_SIZE, ICON_SIZE);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    drawIcon(ctx, item);
  }
  iconCache.set(item, canvas);
  return canvas;
}

function drawIcon(ctx: CanvasRenderingContext2D, item: ItemType): void {
  const c = ICON_SIZE / 2;
  switch (item) {
    case 'none':
      return;
    case 'banana':
      drawBanana(ctx, c, c + 1, 1);
      return;
    case 'triple_banana':
      drawBanana(ctx, c - 15, c - 10, 0.52);
      drawBanana(ctx, c + 15, c - 10, 0.52);
      drawBanana(ctx, c, c + 13, 0.52);
      return;
    case 'green_shell':
      drawShell(ctx, c, c, 1, '#2fd24a', '#0f6b22', false);
      return;
    case 'red_shell':
      drawShell(ctx, c, c, 1, '#ff3b30', '#8a1410', false, true);
      return;
    case 'blue_shell':
      drawShell(ctx, c, c, 1, '#2f7bff', '#12348f', true);
      return;
    case 'triple_green_shell':
      drawTriple(ctx, (x, y, s) => drawShell(ctx, x, y, s, '#2fd24a', '#0f6b22', false));
      return;
    case 'triple_red_shell':
      drawTriple(ctx, (x, y, s) => drawShell(ctx, x, y, s, '#ff3b30', '#8a1410', false, true));
      return;
    case 'mushroom':
      drawMushroom(ctx, c, c, 1, '#ff3b30', false);
      return;
    case 'triple_mushroom':
      drawTriple(ctx, (x, y, s) => drawMushroom(ctx, x, y, s, '#ff3b30', false));
      return;
    case 'golden_mushroom':
      drawMushroom(ctx, c, c, 1, '#ffc531', true);
      return;
    case 'star':
      drawStar(ctx, c, c, 1);
      return;
    case 'lightning':
      drawLightning(ctx, c, c, 1);
      return;
    case 'bob_omb':
      drawBobOmb(ctx, c, c, 1);
      return;
  }
}

function drawTriple(ctx: CanvasRenderingContext2D, fn: (x: number, y: number, s: number) => void): void {
  const c = ICON_SIZE / 2;
  fn(c - 15, c - 9, 0.5);
  fn(c + 15, c - 9, 0.5);
  fn(c, c + 13, 0.5);
}

function ellipse(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number): void {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, TAU);
}

function drawBanana(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s, s);
  ctx.rotate(-0.45);
  const path = (): void => {
    ctx.beginPath();
    ctx.moveTo(-19, -5);
    ctx.quadraticCurveTo(-3, 22, 19, 1);
  };
  path();
  ctx.lineWidth = 15;
  ctx.strokeStyle = '#4a3208';
  ctx.stroke();
  path();
  ctx.lineWidth = 11;
  ctx.strokeStyle = '#ffd83a';
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-13, -5);
  ctx.quadraticCurveTo(-2, 12, 12, 0);
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.stroke();
  ctx.fillStyle = '#6b4a12';
  ctx.beginPath();
  ctx.arc(-19.5, -5.5, 3.4, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(19.5, 0.5, 3.1, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/**
 * Orb projectile icon (BOUNCER / SEEKER / LEADER ZAP): a glossy ball with a white band.
 * `spiky` adds a ring of spikes and two side fins (LEADER ZAP), `seeker` a targeting reticle.
 */
function drawShell(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  s: number,
  color: string,
  dark: string,
  spiky: boolean,
  seeker = false,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s, s);
  ctx.lineWidth = 2.5;
  if (spiky) {
    // side fins
    ctx.fillStyle = '#bfe0ff';
    ctx.strokeStyle = dark;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(side * 16, -2);
      ctx.lineTo(side * 30, -10);
      ctx.lineTo(side * 27, 8);
      ctx.lineTo(side * 16, 8);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    // spikes all around
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#26335a';
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + Math.PI / 8;
      const bx = Math.cos(a) * 17;
      const by = 2 + Math.sin(a) * 17;
      const tx = Math.cos(a) * 27;
      const ty = 2 + Math.sin(a) * 27;
      const px = -Math.sin(a) * 4.5;
      const py = Math.cos(a) * 4.5;
      ctx.beginPath();
      ctx.moveTo(bx + px, by + py);
      ctx.lineTo(tx, ty);
      ctx.lineTo(bx - px, by - py);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
  // ball
  const g = ctx.createRadialGradient(-7, -6, 2, 0, 2, 21);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.25, color);
  g.addColorStop(1, dark);
  ctx.fillStyle = g;
  ctx.strokeStyle = dark;
  ctx.beginPath();
  ctx.arc(0, 2, 19, 0, TAU);
  ctx.fill();
  ctx.stroke();
  // white equator band
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 2, 19, 0, TAU);
  ctx.clip();
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.beginPath();
  ctx.ellipse(0, 6, 22, 5, 0, 0, TAU);
  ctx.fill();
  ctx.restore();
  if (seeker) {
    // targeting reticle
    ctx.strokeStyle = '#fff6d0';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.arc(0, -4, 6.5, 0, TAU);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -13);
    ctx.lineTo(0, -9);
    ctx.moveTo(0, 1);
    ctx.lineTo(0, 5);
    ctx.moveTo(-9, -4);
    ctx.lineTo(-5, -4);
    ctx.moveTo(5, -4);
    ctx.lineTo(9, -4);
    ctx.stroke();
  }
  // highlight
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ellipse(ctx, -7, -7, 5, 3);
  ctx.fill();
  ctx.restore();
}

/** TURBO canister icon: a stubby rocket with fins and a flame (gold variant for GOLD TURBO). */
function drawMushroom(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  s: number,
  capColor: string,
  gold: boolean,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s, s);
  ctx.rotate(0.55);
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = gold ? '#7a4d00' : '#3a1410';
  // flame
  const fg = ctx.createLinearGradient(0, 14, 0, 30);
  fg.addColorStop(0, '#fff3a0');
  fg.addColorStop(0.5, '#ff9a1f');
  fg.addColorStop(1, 'rgba(255,60,20,0)');
  ctx.fillStyle = fg;
  ctx.beginPath();
  ctx.moveTo(-7, 14);
  ctx.quadraticCurveTo(0, 36, 7, 14);
  ctx.closePath();
  ctx.fill();
  // fins
  ctx.fillStyle = gold ? '#fff1c4' : '#ffffff';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(side * 9, 2);
    ctx.lineTo(side * 18, 16);
    ctx.lineTo(side * 9, 14);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  // body
  ctx.fillStyle = capColor;
  ctx.beginPath();
  ctx.moveTo(-9, 14);
  ctx.lineTo(-9, -8);
  ctx.quadraticCurveTo(0, -30, 9, -8);
  ctx.lineTo(9, 14);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // window + band
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(-9, 4, 18, 4);
  ctx.fillStyle = '#9fe6ff';
  ctx.beginPath();
  ctx.arc(0, -6, 4.2, 0, TAU);
  ctx.fill();
  ctx.stroke();
  if (gold) {
    ctx.fillStyle = '#ffffff';
    drawSparkle(ctx, 14, -14, 5);
    drawSparkle(ctx, -15, -6, 3.5);
  }
  ctx.restore();
}

function drawSparkle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.quadraticCurveTo(x, y, x, y + r);
  ctx.quadraticCurveTo(x, y, x - r, y);
  ctx.quadraticCurveTo(x, y, x, y - r);
  ctx.fill();
}

function starPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, outer: number, inner: number): void {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawStar(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s, s);
  const glow = ctx.createRadialGradient(0, 2, 4, 0, 2, 31);
  glow.addColorStop(0, 'rgba(255,236,120,0.95)');
  glow.addColorStop(0.55, 'rgba(255,210,60,0.35)');
  glow.addColorStop(1, 'rgba(255,200,40,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(-32, -32, 64, 64);
  starPath(ctx, 0, 2, 26, 11.5);
  ctx.fillStyle = '#ffe23a';
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#c47a00';
  ctx.stroke();
  starPath(ctx, -1, 0, 16, 7);
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fill();
  ctx.restore();
}

function drawLightning(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s, s);
  // cloud
  ctx.fillStyle = '#4d5668';
  ctx.strokeStyle = '#1f2530';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(-13, -12, 10, 0, TAU);
  ctx.arc(1, -18, 12, 0, TAU);
  ctx.arc(15, -11, 10, 0, TAU);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(-23, -12, 46, 12, 5);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(-13, -12, 10, Math.PI * 0.75, Math.PI * 1.75);
  ctx.arc(1, -18, 12, Math.PI * 1.15, Math.PI * 1.95);
  ctx.arc(15, -11, 10, Math.PI * 1.3, Math.PI * 2.25);
  ctx.lineTo(23, -2);
  ctx.lineTo(-23, -2);
  ctx.closePath();
  ctx.stroke();
  // bolt
  ctx.shadowColor = 'rgba(255,225,60,0.9)';
  ctx.shadowBlur = 9;
  ctx.beginPath();
  ctx.moveTo(3, -10);
  ctx.lineTo(-9, 8);
  ctx.lineTo(-1, 8);
  ctx.lineTo(-7, 27);
  ctx.lineTo(12, 2);
  ctx.lineTo(3, 2);
  ctx.lineTo(11, -10);
  ctx.closePath();
  ctx.fillStyle = '#ffe135';
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#7a4d00';
  ctx.stroke();
  ctx.restore();
}

/** BOOMER icon: a classic round bomb with a red stripe, a fuse and a spark (no face). */
function drawBobOmb(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s, s);
  // fuse cap
  ctx.fillStyle = '#5a5a66';
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.rect(-5, -17, 10, 7);
  ctx.fill();
  ctx.stroke();
  // fuse
  ctx.strokeStyle = '#c9a46a';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, -17);
  ctx.quadraticCurveTo(2, -25, 9, -26);
  ctx.stroke();
  // body
  const g = ctx.createRadialGradient(-7, -2, 2, 0, 6, 21);
  g.addColorStop(0, '#5a5a6a');
  g.addColorStop(0.4, '#23232e');
  g.addColorStop(1, '#0b0b10');
  ctx.fillStyle = g;
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.arc(0, 6, 19, 0, TAU);
  ctx.fill();
  ctx.stroke();
  // red stripe
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 6, 19, 0, TAU);
  ctx.clip();
  ctx.fillStyle = '#e8322a';
  ctx.beginPath();
  ctx.ellipse(0, 8, 22, 4.5, -0.25, 0, TAU);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ellipse(ctx, -7, -2, 6, 3.5);
  ctx.fill();
  // spark
  ctx.fillStyle = '#ff9a1f';
  ctx.beginPath();
  ctx.arc(10, -26, 4.5, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#fff3b0';
  ctx.beginPath();
  ctx.arc(10, -26, 2, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = '#ffd23a';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    ctx.moveTo(10 + Math.cos(a) * 5.5, -26 + Math.sin(a) * 5.5);
    ctx.lineTo(10 + Math.cos(a) * 9, -26 + Math.sin(a) * 9);
  }
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// 3D meshes
// ---------------------------------------------------------------------------

const geometryCache = new Map<string, THREE.BufferGeometry>();
const materialCache = new Map<string, THREE.Material>();
const textureCache = new Map<string, THREE.Texture>();

function geo<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
  let g = geometryCache.get(key) as T | undefined;
  if (!g) {
    g = make();
    geometryCache.set(key, g);
  }
  return g;
}

function mat<T extends THREE.Material>(key: string, make: () => T): T {
  let m = materialCache.get(key) as T | undefined;
  if (!m) {
    m = make();
    materialCache.set(key, m);
  }
  return m;
}

function tex(key: string, make: () => THREE.Texture): THREE.Texture {
  let t = textureCache.get(key);
  if (!t) {
    t = make();
    textureCache.set(key, t);
  }
  return t;
}

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) draw(ctx);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function questionTexture(): THREE.Texture {
  return tex('question', () =>
    canvasTexture(128, (ctx) => {
      ctx.clearRect(0, 0, 128, 128);
      ctx.font = 'bold 96px "Arial Black", Impact, Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 10;
      ctx.strokeStyle = '#7a4400';
      ctx.strokeText('?', 64, 70);
      ctx.fillStyle = '#fff7c2';
      ctx.fillText('?', 64, 70);
    }),
  );
}

function standard(key: string, params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  return mat(key, () => new THREE.MeshStandardMaterial(params));
}

/** Tapers a TubeGeometry's radius along its length (thin at both ends). */
function taperTube(geometry: THREE.TubeGeometry, path: THREE.Curve<THREE.Vector3>, tubular: number, radial: number): void {
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  const p = new THREE.Vector3();
  const v = new THREE.Vector3();
  for (let i = 0; i <= tubular; i++) {
    const u = i / tubular;
    path.getPointAt(u, p);
    const e = Math.abs(2 * u - 1);
    const f = 1 - 0.72 * e * e * e * e;
    for (let j = 0; j <= radial; j++) {
      const idx = i * (radial + 1) + j;
      v.fromBufferAttribute(pos, idx).sub(p).multiplyScalar(f).add(p);
      pos.setXYZ(idx, v.x, v.y, v.z);
    }
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
}

function bananaCurve(): THREE.QuadraticBezierCurve3 {
  return new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(-0.46, 0.2, 0),
    new THREE.Vector3(0, -0.3, 0),
    new THREE.Vector3(0.46, 0.2, 0),
  );
}

function buildBanana(): THREE.Object3D {
  const g = new THREE.Group();
  const tubular = 16;
  const radial = 8;
  const body = new THREE.Mesh(
    geo('banana', () => {
      const curve = bananaCurve();
      const t = new THREE.TubeGeometry(curve, tubular, 0.115, radial, false);
      taperTube(t, curve, tubular, radial);
      return t;
    }),
    standard('banana', { color: 0xffd23a, roughness: 0.45, metalness: 0.0 }),
  );
  body.castShadow = true;
  g.add(body);
  const tipGeo = geo('bananaTip', () => new THREE.ConeGeometry(0.05, 0.14, 6));
  const tipMat = standard('bananaTip', { color: 0x5a3b10, roughness: 0.8 });
  const curve = bananaCurve();
  const p = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  for (let i = 0; i < 2; i++) {
    const tip = new THREE.Mesh(tipGeo, tipMat);
    curve.getPointAt(i, p);
    curve.getTangentAt(i, tangent);
    if (i === 0) tangent.negate();
    tip.position.copy(p).addScaledVector(tangent, 0.04);
    tip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent.normalize());
    g.add(tip);
  }
  g.position.y = 0.32;
  return g;
}

/** Orb projectile mesh (BOUNCER / SEEKER / LEADER ZAP). */
function buildShell(color: number, key: string, spiky: boolean): THREE.Object3D {
  const g = new THREE.Group();
  const R = 0.34;
  const ball = new THREE.Mesh(
    geo('orbBall', () => new THREE.SphereGeometry(R, 14, 10)),
    standard(`orb_${key}`, { color, roughness: 0.25, metalness: 0.15, emissive: color, emissiveIntensity: 0.18 }),
  );
  ball.castShadow = true;
  g.add(ball);
  const band = new THREE.Mesh(
    geo('orbBand', () => new THREE.TorusGeometry(R * 1.0, 0.045, 6, 20)),
    standard('orbBand', { color: 0xffffff, roughness: 0.4 }),
  );
  band.rotation.x = Math.PI / 2;
  g.add(band);
  if (key === 'red') {
    // seeker "lens" on the front
    const lens = new THREE.Mesh(
      geo('orbLens', () => new THREE.CylinderGeometry(0.11, 0.11, 0.05, 12)),
      standard('orbLens', { color: 0xfff6d0, emissive: 0xffe08a, emissiveIntensity: 1.6, roughness: 0.3 }),
    );
    lens.rotation.x = Math.PI / 2;
    lens.position.set(0, 0.08, -R * 0.95);
    g.add(lens);
  }
  if (spiky) {
    const spikeGeo = geo('orbSpike', () => new THREE.ConeGeometry(0.075, 0.2, 6));
    const spikeMat = standard('orbSpike', { color: 0xf2f6ff, roughness: 0.3, metalness: 0.3 });
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      for (const yy of [0.45, -0.25]) {
        if (yy < 0 && i % 2 === 1) continue;
        const dir = new THREE.Vector3(Math.cos(a), yy, Math.sin(a)).normalize();
        const spike = new THREE.Mesh(spikeGeo, spikeMat);
        spike.position.copy(dir).multiplyScalar(R + 0.06);
        spike.quaternion.setFromUnitVectors(up, dir);
        g.add(spike);
      }
    }
    const top = new THREE.Mesh(spikeGeo, spikeMat);
    top.position.y = R + 0.07;
    g.add(top);
    // stabiliser fins on both sides (swept back, like a missile)
    const finGeo = geo('orbFin', () => {
      const shape = new THREE.Shape();
      shape.moveTo(0, 0);
      shape.lineTo(0.3, 0.06);
      shape.lineTo(0.36, 0.3);
      shape.lineTo(0.08, 0.16);
      shape.closePath();
      return new THREE.ShapeGeometry(shape);
    });
    const finMat = standard('orbFin', { color: 0x9fd0ff, roughness: 0.35, emissive: 0x2f7bff, emissiveIntensity: 0.4, side: THREE.DoubleSide });
    for (let i = -1; i <= 1; i += 2) {
      const fin = new THREE.Mesh(finGeo, finMat);
      fin.position.set(i * (R - 0.02), -0.05, 0.05);
      fin.rotation.set(Math.PI / 2, 0, i > 0 ? -0.35 : Math.PI + 0.35);
      g.add(fin);
    }
  }
  g.position.y = R;
  return g;
}

/** TURBO canister mesh: an upright stubby rocket (gold variant for GOLD TURBO). */
function buildMushroom(gold: boolean): THREE.Object3D {
  const g = new THREE.Group();
  const bodyMat = gold
    ? standard('turboGold', { color: 0xf2b31a, roughness: 0.28, metalness: 0.75, emissive: 0x3a2400, emissiveIntensity: 0.6 })
    : standard('turboRed', { color: 0xe5261c, roughness: 0.35, metalness: 0.2 });
  const body = new THREE.Mesh(geo('turboBody', () => new THREE.CylinderGeometry(0.17, 0.19, 0.42, 12)), bodyMat);
  body.castShadow = true;
  g.add(body);
  const nose = new THREE.Mesh(geo('turboNose', () => new THREE.ConeGeometry(0.17, 0.26, 12)), bodyMat);
  nose.position.y = 0.34;
  g.add(nose);
  const band = new THREE.Mesh(
    geo('turboBand', () => new THREE.CylinderGeometry(0.182, 0.182, 0.06, 12)),
    standard('turboBand', { color: 0xffffff, roughness: 0.5 }),
  );
  band.position.y = 0.06;
  g.add(band);
  const window_ = new THREE.Mesh(
    geo('turboWindow', () => new THREE.SphereGeometry(0.06, 8, 6)),
    standard('turboWindow', { color: 0x9fe6ff, emissive: 0x2a8fb0, emissiveIntensity: 0.6, roughness: 0.2 }),
  );
  window_.position.set(0, 0.16, -0.16);
  window_.scale.set(1, 1, 0.5);
  g.add(window_);
  const finGeo = geo('turboFin', () => {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(0.16, -0.12);
    shape.lineTo(0.16, -0.24);
    shape.lineTo(0, -0.16);
    shape.closePath();
    return new THREE.ShapeGeometry(shape);
  });
  const finMat = standard(gold ? 'turboFinGold' : 'turboFin', { color: gold ? 0xfff0c0 : 0xffffff, roughness: 0.5, side: THREE.DoubleSide });
  for (let i = 0; i < 3; i++) {
    const fin = new THREE.Mesh(finGeo, finMat);
    const a = (i / 3) * TAU;
    fin.position.set(Math.cos(a) * 0.17, -0.06, Math.sin(a) * 0.17);
    fin.rotation.y = -a;
    g.add(fin);
  }
  const flame = new THREE.Mesh(
    geo('turboFlame', () => new THREE.ConeGeometry(0.12, 0.26, 8)),
    mat('turboFlame', () => new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.85, toneMapped: false })),
  );
  flame.rotation.x = Math.PI;
  flame.position.y = -0.34;
  g.add(flame);
  g.position.y = 0.48;
  return g;
}

function buildStar(): THREE.Object3D {
  const g = new THREE.Group();
  const star = new THREE.Mesh(
    geo('star', () => {
      const shape = new THREE.Shape();
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? 0.46 : 0.2;
        const a = Math.PI / 2 + (i * Math.PI) / 5;
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r;
        if (i === 0) shape.moveTo(x, y);
        else shape.lineTo(x, y);
      }
      shape.closePath();
      const e = new THREE.ExtrudeGeometry(shape, {
        depth: 0.14,
        bevelEnabled: true,
        bevelThickness: 0.03,
        bevelSize: 0.03,
        bevelSegments: 1,
        curveSegments: 1,
      });
      e.translate(0, 0, -0.07);
      return e;
    }),
    standard('star', { color: 0xffe14a, emissive: 0xffb300, emissiveIntensity: 0.9, roughness: 0.3, metalness: 0.2 }),
  );
  star.castShadow = true;
  g.add(star);
  g.position.y = 0.5;
  return g;
}

/** BOOMER mesh: round bomb with a red stripe, metal cap and burning fuse (no face / feet). */
function buildBobOmb(): THREE.Object3D {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    geo('bombBody', () => new THREE.SphereGeometry(0.36, 14, 10)),
    standard('bombBody', { color: 0x15151c, roughness: 0.35, metalness: 0.3 }),
  );
  body.name = 'bombBody';
  body.castShadow = true;
  g.add(body);
  const stripe = new THREE.Mesh(
    geo('bombStripe', () => new THREE.TorusGeometry(0.355, 0.04, 6, 24)),
    standard('bombStripe', { color: 0xe8322a, roughness: 0.4, emissive: 0x5a0a06, emissiveIntensity: 0.5 }),
  );
  stripe.rotation.x = Math.PI / 2 - 0.25;
  g.add(stripe);
  const cap = new THREE.Mesh(
    geo('bombCap', () => new THREE.CylinderGeometry(0.1, 0.12, 0.1, 10)),
    standard('bombCap', { color: 0x777784, roughness: 0.4, metalness: 0.7 }),
  );
  cap.position.set(0, 0.38, 0);
  g.add(cap);
  const fuse = new THREE.Mesh(
    geo('bombFuse', () => new THREE.CylinderGeometry(0.022, 0.022, 0.16, 5)),
    standard('bombFuse', { color: 0xc9a46a, roughness: 0.9 }),
  );
  fuse.position.set(0.03, 0.49, 0);
  fuse.rotation.z = -0.35;
  g.add(fuse);
  const tip = new THREE.Mesh(
    geo('bombTip', () => new THREE.SphereGeometry(0.055, 6, 4)),
    standard('bombTip', { color: 0xffb020, emissive: 0xff7a00, emissiveIntensity: 2.5, roughness: 0.5 }),
  );
  tip.name = 'bombTip';
  tip.position.set(0.06, 0.58, 0);
  g.add(tip);
  g.position.y = 0.37;
  return g;
}

function buildLightning(): THREE.Object3D {
  const g = new THREE.Group();
  const boltGeo = geo('bolt', () => {
    const s = new THREE.Shape();
    s.moveTo(0.08, 0.5);
    s.lineTo(-0.22, 0.02);
    s.lineTo(-0.02, 0.02);
    s.lineTo(-0.18, -0.5);
    s.lineTo(0.3, 0.12);
    s.lineTo(0.08, 0.12);
    s.lineTo(0.28, 0.5);
    s.closePath();
    return new THREE.ShapeGeometry(s);
  });
  const bolt = new THREE.Mesh(
    boltGeo,
    mat('bolt', () => new THREE.MeshBasicMaterial({ color: 0xffe135, side: THREE.DoubleSide, toneMapped: false })),
  );
  g.add(bolt);
  const glow = new THREE.Mesh(
    boltGeo,
    mat(
      'boltGlow',
      () =>
        new THREE.MeshBasicMaterial({
          color: 0xffc400,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.45,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
        }),
    ),
  );
  glow.scale.setScalar(1.35);
  glow.position.z = -0.01;
  g.add(glow);
  g.position.y = 0.55;
  return g;
}

/**
 * Builds a fresh Object3D for the given item (≤ 600 triangles). Geometries and
 * materials are shared from the module caches; the returned group itself can be
 * freely positioned, scaled and removed. Triple items return the single base
 * item (the ItemManager instantiates three of them for the orbit).
 */
export function buildItemMesh(item: ItemType): THREE.Object3D {
  switch (item) {
    case 'banana':
    case 'triple_banana':
      return buildBanana();
    case 'green_shell':
    case 'triple_green_shell':
      return buildShell(0x2fd24a, 'green', false);
    case 'red_shell':
    case 'triple_red_shell':
      return buildShell(0xff3b30, 'red', false);
    case 'blue_shell':
      return buildShell(0x2f7bff, 'blue', true);
    case 'mushroom':
    case 'triple_mushroom':
      return buildMushroom(false);
    case 'golden_mushroom':
      return buildMushroom(true);
    case 'star':
      return buildStar();
    case 'lightning':
      return buildLightning();
    case 'bob_omb':
      return buildBobOmb();
    case 'none':
    default:
      return new THREE.Group();
  }
}

/** Base (non-triple) item type, e.g. 'triple_red_shell' -> 'red_shell'. */
export function baseItemType(item: ItemType): ItemType {
  switch (item) {
    case 'triple_banana':
      return 'banana';
    case 'triple_green_shell':
      return 'green_shell';
    case 'triple_red_shell':
      return 'red_shell';
    case 'triple_mushroom':
      return 'mushroom';
    default:
      return item;
  }
}

/** Frees all cached GPU resources (geometries, materials, textures) and icon canvases. */
export function disposeItemVisualCaches(): void {
  for (const g of geometryCache.values()) g.dispose();
  geometryCache.clear();
  for (const m of materialCache.values()) m.dispose();
  materialCache.clear();
  for (const t of textureCache.values()) t.dispose();
  textureCache.clear();
  iconCache.clear();
}
