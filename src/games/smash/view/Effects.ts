/**
 * Combat effects: wraps the shared GPU ParticleSystem (src/fx) for sparks / smoke / explosions and
 * adds a small LIFETIME pool of additive meshes (impact rings, sword arcs, flashes, KO beams, stars).
 * Everything here is created once and reused, so it never grows renderer memory.
 */
import * as THREE from 'three';
import { ParticleSystem } from '../../../fx/ParticleSystem';
import type { HitKind } from '../types';
import { softCircleTexture } from './util';

type Shape = 'ring' | 'arc' | 'flash' | 'beam' | 'star';

interface FxItem {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  shape: Shape;
  t: number;
  life: number;
  s0: number;
  s1: number;
  a0: number;
  spin: number;
  stretch: number;
  active: boolean;
}

const POOL_PER_SHAPE: Record<Shape, number> = { ring: 14, arc: 8, flash: 12, beam: 4, star: 6 };

function starGeometry(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
    const r = i % 2 === 0 ? 1 : 0.45;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) s.moveTo(x, y);
    else s.lineTo(x, y);
  }
  s.closePath();
  return new THREE.ShapeGeometry(s);
}

function beamTexture(): THREE.Texture {
  const cv = document.createElement('canvas');
  cv.width = 64;
  cv.height = 256;
  const c = cv.getContext('2d');
  if (c) {
    const gx = c.createLinearGradient(0, 0, 64, 0);
    gx.addColorStop(0, 'rgba(255,255,255,0)');
    gx.addColorStop(0.5, 'rgba(255,255,255,1)');
    gx.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = gx;
    c.fillRect(0, 0, 64, 256);
    const gy = c.createLinearGradient(0, 0, 0, 256);
    gy.addColorStop(0, 'rgba(0,0,0,1)');
    gy.addColorStop(0.15, 'rgba(0,0,0,0)');
    gy.addColorStop(0.7, 'rgba(0,0,0,0)');
    gy.addColorStop(1, 'rgba(0,0,0,1)');
    c.globalCompositeOperation = 'destination-out';
    c.fillStyle = gy;
    c.fillRect(0, 0, 64, 256);
  }
  const t = new THREE.CanvasTexture(cv);
  t.needsUpdate = true;
  return t;
}

const KIND_COLOR: Record<HitKind, number> = {
  normal: 0xffd27a,
  sword: 0x9fe8ff,
  electric: 0x7ab8ff,
  fire: 0xff7a1a,
  water: 0x5ad0ff,
  bat: 0xfff27a,
  explosion: 0xff9a2e,
  projectile: 0xffffff,
  throw: 0xffd27a,
};

export class Effects {
  readonly particles: ParticleSystem;
  readonly root = new THREE.Group();
  private readonly pool: FxItem[] = [];
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly beamTex: THREE.Texture;
  private readonly v = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private quality = 2;

  constructor() {
    this.particles = new ParticleSystem();
    this.root.name = 'smash-fx';
    this.root.add(this.particles.object);
    this.beamTex = beamTexture();
    const ring = new THREE.RingGeometry(0.82, 1, 40);
    const arc = new THREE.RingGeometry(0.7, 1, 24, 1, -Math.PI * 0.45, Math.PI * 0.9);
    const flash = new THREE.PlaneGeometry(2, 2);
    const beam = new THREE.PlaneGeometry(1, 1);
    beam.translate(0, 0.5, 0);
    const star = starGeometry();
    this.geos.push(ring, arc, flash, beam, star);
    const geoFor: Record<Shape, THREE.BufferGeometry> = { ring, arc, flash, beam, star };
    for (const shape of Object.keys(POOL_PER_SHAPE) as Shape[]) {
      for (let i = 0; i < POOL_PER_SHAPE[shape]; i++) {
        const mat = new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          depthTest: shape !== 'beam',
          side: THREE.DoubleSide,
          fog: false,
          map: shape === 'flash' ? softCircleTexture() : shape === 'beam' ? this.beamTex : null,
        });
        const mesh = new THREE.Mesh(geoFor[shape], mat);
        mesh.visible = false;
        mesh.frustumCulled = false;
        mesh.renderOrder = shape === 'beam' ? 30 : 25;
        this.root.add(mesh);
        this.pool.push({ mesh, mat, shape, t: 0, life: 1, s0: 1, s1: 1, a0: 1, spin: 0, stretch: 1, active: false });
      }
    }
  }

  setQuality(tier: 0 | 1 | 2 | 3): void {
    this.quality = tier;
    this.particles.setQuality(tier);
  }

  private spawn(shape: Shape, x: number, y: number, z: number, color: number, life: number, s0: number, s1: number, a0 = 1, rot = 0, spin = 0, stretch = 1): FxItem | null {
    let best: FxItem | null = null;
    for (const it of this.pool) {
      if (it.shape !== shape) continue;
      if (!it.active) {
        best = it;
        break;
      }
      if (!best || it.t / it.life > best.t / best.life) best = it;
    }
    if (!best) return null;
    best.active = true;
    best.t = 0;
    best.life = life;
    best.s0 = s0;
    best.s1 = s1;
    best.a0 = a0;
    best.spin = spin;
    best.stretch = stretch;
    best.mat.color.setHex(color);
    best.mesh.position.set(x, y, z);
    best.mesh.rotation.set(0, 0, rot);
    best.mesh.visible = true;
    return best;
  }

  update(dt: number, camera: THREE.Camera): void {
    this.particles.update(dt, [], camera);
    for (const it of this.pool) {
      if (!it.active) continue;
      it.t += dt;
      const k = it.t / it.life;
      if (k >= 1) {
        it.active = false;
        it.mesh.visible = false;
        continue;
      }
      const ease = 1 - Math.pow(1 - k, 3);
      const s = it.s0 + (it.s1 - it.s0) * ease;
      if (it.shape === 'beam') {
        it.mesh.scale.set(s * (1 - k * 0.7), it.stretch, 1);
        it.mat.opacity = it.a0 * (k < 0.1 ? k / 0.1 : 1 - (k - 0.1) / 0.9);
      } else {
        it.mesh.scale.set(s * it.stretch, s, s);
        it.mat.opacity = it.a0 * (1 - k) * (1 - k);
      }
      it.mesh.rotation.z += it.spin * dt;
    }
  }

  // ------------------------------------------------------------------ presets

  hit(x: number, y: number, strength: number, kind: HitKind, angleDeg: number, attackerColor: number, shielded: boolean): void {
    const s = Math.max(0.15, Math.min(1, strength));
    const c = shielded ? 0x9fe8ff : KIND_COLOR[kind] ?? 0xffd27a;
    const a = (angleDeg * Math.PI) / 180;
    this.dir.set(Math.cos(a), Math.sin(a), 0);
    this.v.set(x, y, 0.6);
    const ps = this.particles;
    const sc = 0.35 + 0.75 * s;
    if (shielded) {
      ps.emit('hitSparks', this.v, { color: c, scale: 0.4 });
      this.spawn('ring', x, y, 0.7, c, 0.18, 0.2, 0.9, 0.9);
      return;
    }
    ps.emit('hitSparks', this.v, { color: c, scale: sc, direction: this.dir });
    this.spawn('flash', x, y, 0.7, c, 0.12 + 0.06 * s, 0.4 + 0.6 * s, 0.9 + 1.4 * s, 1);
    this.spawn('ring', x, y, 0.7, 0xffffff, 0.2 + 0.1 * s, 0.2, 0.9 + 1.8 * s, 0.9);
    switch (kind) {
      case 'sword':
        this.spawn('arc', x, y, 0.75, 0xbff4ff, 0.18, 0.9 + 0.8 * s, 1.3 + 1.1 * s, 1, a + Math.PI / 2, 6, 1.5);
        break;
      case 'electric':
        ps.emit('lightningStrike', this.v.set(x, y - 0.5, 0.5), { scale: 0.25 + 0.3 * s });
        ps.emit('hitSparks', this.v.set(x, y, 0.6), { color: 0xbfe0ff, scale: sc * 0.8 });
        break;
      case 'fire':
      case 'explosion':
        ps.emit('explosion', this.v.set(x, y - 0.3, 0.4), { scale: 0.25 + 0.35 * s });
        break;
      case 'water':
        ps.emit('waterSplash', this.v.set(x, y - 0.3, 0.4), { scale: 0.4 + 0.3 * s });
        break;
      case 'bat':
        this.spawn('star', x, y, 0.8, 0xfff27a, 0.6, 0.3, 1.6, 1, 0, 8);
        ps.emit('starSparkle', this.v.set(x, y, 0.6), { scale: 1.2 });
        break;
      default:
        break;
    }
    if (s > 0.7) {
      ps.emit('starSparkle', this.v.set(x, y, 0.6), { scale: 0.6 });
      this.spawn('ring', x, y, 0.65, c, 0.35, 0.4, 3.2, 0.7);
    }
  }

  /** Blast-zone KO: coloured beam shooting in from the blast side + explosion. */
  ko(x: number, y: number, side: 'left' | 'right' | 'top' | 'bottom', color: number, cx: number, cy: number): void {
    // beam starts at the KO point and points back toward the stage centre
    const ang = Math.atan2(cy - y, cx - x) - Math.PI / 2;
    const len = Math.hypot(cx - x, cy - y) * 0.95 + 6;
    this.spawn('beam', x, y, 1, color, 1.1, 4.5, 2.5, 1, ang, 0, len);
    this.spawn('beam', x, y, 1.1, 0xffffff, 0.7, 2.2, 1, 0.9, ang, 0, len * 0.9);
    this.spawn('flash', x, y, 1, color, 0.6, 3, 9, 1);
    this.spawn('flash', x, y, 1.1, 0xffffff, 0.3, 2, 5, 1);
    this.spawn('ring', x, y, 1, color, 0.7, 1, 9, 1);
    this.v.set(x, y, 0.5);
    this.particles.emit('explosion', this.v, { scale: 1.1 });
    this.particles.emit('lapFlash', this.v, { color, scale: 1.4 });
    void side;
  }

  explosion(x: number, y: number, r: number): void {
    this.v.set(x, y, 0.3);
    this.particles.emit('explosion', this.v, { scale: Math.max(0.4, r * 0.45) });
    this.spawn('flash', x, y, 0.8, 0xffc070, 0.25, r, r * 2.4, 1);
  }

  shieldBreak(x: number, y: number, color: number): void {
    this.v.set(x, y, 0.5);
    this.particles.emit('shellBreak', this.v, { color, scale: 1.2 });
    this.spawn('ring', x, y, 0.6, color, 0.5, 0.8, 3.5, 1);
    this.spawn('star', x, y + 1.2, 0.7, 0xffffff, 0.8, 0.2, 0.7, 1, 0, 10);
  }

  landDust(x: number, y: number, hard: boolean): void {
    this.v.set(x, y, 0.2);
    this.particles.emit('landPuff', this.v, { scale: hard ? 0.65 : 0.4 });
  }

  dashDust(x: number, y: number, facing: number): void {
    this.v.set(x - facing * 0.3, y, 0.1);
    this.particles.emit('dust', this.v, { scale: 0.35, color: 0xd8ccb8 });
  }

  smoke(x: number, y: number, hot: boolean): void {
    this.v.set(x, y, 0);
    this.particles.emit('dust', this.v, { scale: hot ? 0.45 : 0.32, color: hot ? 0xfff0d8 : 0xb8b8c0 });
  }

  sparkle(x: number, y: number, scale = 0.4): void {
    this.v.set(x, y, 0.4);
    this.particles.emit('starSparkle', this.v, { scale });
  }

  puff(x: number, y: number): void {
    this.v.set(x, y, 0.5);
    this.particles.emit('landPuff', this.v, { scale: 1.2 });
    this.particles.emit('starSparkle', this.v, { scale: 1 });
    this.spawn('ring', x, y, 0.6, 0xffffff, 0.4, 0.3, 2.4, 1);
  }

  respawnFlash(x: number, y: number, color: number): void {
    this.spawn('ring', x, y + 0.9, 0.6, color, 0.5, 0.4, 2.6, 1);
    this.sparkle(x, y + 0.9, 0.8);
  }

  confetti(x: number, y: number): void {
    this.v.set(x, y, 0);
    this.particles.emit('confetti', this.v, { scale: 0.7 });
  }

  heal(x: number, y: number): void {
    this.v.set(x, y + 1, 0.4);
    this.particles.emit('lapFlash', this.v, { color: 0x7affa0, scale: 0.5 });
  }

  power(x: number, y: number): void {
    this.v.set(x, y + 1, 0.4);
    this.particles.emit('lapFlash', this.v, { color: 0xffffff, scale: 1.2 });
    this.spawn('star', x, y + 1, 0.8, 0xfff0a0, 0.8, 0.5, 3, 1, 0, 5);
  }

  clear(): void {
    this.particles.reset();
    for (const it of this.pool) {
      it.active = false;
      it.mesh.visible = false;
    }
  }

  dispose(): void {
    this.particles.dispose();
    for (const it of this.pool) it.mat.dispose();
    for (const g of this.geos) g.dispose();
    this.beamTex.dispose();
    this.root.removeFromParent();
  }

  get tier(): number {
    return this.quality;
  }
}
