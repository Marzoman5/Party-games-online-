/**
 * Hitbox / hurtbox wireframe overlay (host key H, __smash.setDebug). One preallocated
 * LineSegments buffer for the engine lifetime: hit = red, hurt = yellow, intangible = blue,
 * grab = purple, shield = cyan, ledge = green.
 */
import * as THREE from 'three';
import type { DebugShape } from '../types';

const MAX_VERTS = 24000;
const SEG = 18;

const COLORS: Record<string, [number, number, number]> = {
  hit: [1, 0.15, 0.15],
  hurt: [1, 0.9, 0.1],
  intangible: [0.25, 0.5, 1],
  grab: [0.75, 0.3, 1],
  shield: [0.2, 1, 1],
  ledge: [0.3, 1, 0.4],
};

export class DebugOverlay {
  readonly object: THREE.LineSegments;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.LineBasicMaterial;
  private n = 0;

  constructor() {
    this.pos = new Float32Array(MAX_VERTS * 3);
    this.col = new Float32Array(MAX_VERTS * 3);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.mat = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false, transparent: true, fog: false });
    this.object = new THREE.LineSegments(this.geo, this.mat);
    this.object.renderOrder = 100;
    this.object.frustumCulled = false;
    this.object.visible = false;
  }

  private seg(x1: number, y1: number, x2: number, y2: number, c: [number, number, number]): void {
    if (this.n + 2 > MAX_VERTS) return;
    let i = this.n * 3;
    this.pos[i] = x1;
    this.pos[i + 1] = y1;
    this.pos[i + 2] = 1.5;
    this.col.set(c, i);
    i += 3;
    this.pos[i] = x2;
    this.pos[i + 1] = y2;
    this.pos[i + 2] = 1.5;
    this.col.set(c, i);
    this.n += 2;
  }

  private circle(x: number, y: number, r: number, c: [number, number, number], from = 0, to = Math.PI * 2): void {
    const steps = Math.max(4, Math.round((SEG * (to - from)) / (Math.PI * 2)));
    let px = x + Math.cos(from) * r;
    let py = y + Math.sin(from) * r;
    for (let k = 1; k <= steps; k++) {
      const a = from + ((to - from) * k) / steps;
      const nx = x + Math.cos(a) * r;
      const ny = y + Math.sin(a) * r;
      this.seg(px, py, nx, ny, c);
      px = nx;
      py = ny;
    }
  }

  update(shapes: readonly DebugShape[]): void {
    this.n = 0;
    for (const s of shapes) {
      const c = s.intangible ? COLORS.intangible : COLORS[s.kind] ?? COLORS.hurt;
      if (s.x2 !== undefined && s.y2 !== undefined && (s.x2 !== s.x || s.y2 !== s.y)) {
        // capsule: two half circles + two side lines
        const dx = s.x2 - s.x;
        const dy = s.y2 - s.y;
        const a = Math.atan2(dy, dx);
        const nx = -Math.sin(a) * s.r;
        const ny = Math.cos(a) * s.r;
        this.seg(s.x + nx, s.y + ny, s.x2 + nx, s.y2 + ny, c);
        this.seg(s.x - nx, s.y - ny, s.x2 - nx, s.y2 - ny, c);
        this.circle(s.x, s.y, s.r, c, a + Math.PI / 2, a + Math.PI * 1.5);
        this.circle(s.x2, s.y2, s.r, c, a - Math.PI / 2, a + Math.PI / 2);
      } else {
        this.circle(s.x, s.y, s.r, c);
        if (s.kind === 'hit') {
          this.seg(s.x - s.r * 0.5, s.y, s.x + s.r * 0.5, s.y, c);
          this.seg(s.x, s.y - s.r * 0.5, s.x, s.y + s.r * 0.5, c);
        }
      }
    }
    this.geo.setDrawRange(0, this.n);
    const p = this.geo.getAttribute('position') as THREE.BufferAttribute;
    const cl = this.geo.getAttribute('color') as THREE.BufferAttribute;
    p.needsUpdate = true;
    cl.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
