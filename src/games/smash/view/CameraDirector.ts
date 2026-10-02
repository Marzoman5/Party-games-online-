/**
 * One shared perspective camera looking at the 2D fight plane from +z. Frames every living
 * fighter (+ margins, + velocity lead), clamped to stage.camera bounds, with smooth pan/zoom,
 * a gentle 2.5D tilt/dolly, focus shots (intro / GAME! / results) and trauma-based screen shake.
 */
import * as THREE from 'three';
import type { StageDef } from '../types';
import { clamp, damp } from './util';

export interface FrameTarget {
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  vy: number;
}

const FOV = 36;
const MIN_H = 8.5;
const HUD_FRAC = 0.16;

export class CameraDirector {
  readonly camera: THREE.PerspectiveCamera;
  /** Visible plane centre + height (world units at z = 0). */
  cx = 0;
  cy = 3;
  h = 14;
  private trauma = 0;
  private time = 0;
  private focus: { x: number; y: number; h: number; rate: number } | null = null;
  marginScale = 1;
  private readonly tanHalf = Math.tan(((FOV / 2) * Math.PI) / 180);
  private readonly ndc = new THREE.Vector3();

  constructor() {
    this.camera = new THREE.PerspectiveCamera(FOV, 16 / 9, 0.5, 400);
  }

  get width(): number {
    return this.h * this.camera.aspect;
  }

  setAspect(a: number): void {
    this.camera.aspect = a;
    this.camera.updateProjectionMatrix();
  }

  /** Close-up / focus shot (null = back to framing the fighters). */
  setFocus(x: number, y: number, h: number, rate = 3): void {
    this.focus = { x, y, h, rate };
  }
  clearFocus(): void {
    this.focus = null;
  }

  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Jump straight to the target framing (new match). */
  snap(targets: FrameTarget[], stage: StageDef): void {
    const t = this.target(targets, stage);
    this.cx = t.x;
    this.cy = t.y;
    this.h = t.h;
    this.trauma = 0;
    this.apply();
  }

  private target(targets: FrameTarget[], stage: StageDef): { x: number; y: number; h: number } {
    const aspect = this.camera.aspect;
    const cb = stage.camera;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const f of targets) {
      const lx = clamp(f.vx * 14, -3, 3);
      const ly = clamp(f.vy * 10, -2, 2.5);
      minX = Math.min(minX, f.x - f.w / 2, f.x + lx);
      maxX = Math.max(maxX, f.x + f.w / 2, f.x + lx);
      minY = Math.min(minY, f.y, f.y + ly);
      maxY = Math.max(maxY, f.y + f.h, f.y + f.h + ly);
    }
    if (!Number.isFinite(minX)) {
      // nobody alive: show the stage centre
      const main = stage.platforms[0];
      minX = (main?.x ?? 0) - 6;
      maxX = (main?.x ?? 0) + 6;
      minY = main?.y ?? 0;
      maxY = minY + 4;
    }
    // keep the main stage surface in view so you can always read where the ground is
    const m = this.marginScale;
    const mx = 3.6 * m;
    const mt = 3.0 * m;
    const mb = 2.2 * m;
    const boxW = maxX - minX + mx * 2;
    const boxH = maxY - minY + mt + mb;
    let h = Math.max(boxH, boxW / aspect) / (1 - HUD_FRAC);
    const maxH = Math.max(MIN_H, Math.min(cb.top - cb.bottom, (cb.right - cb.left) / aspect));
    h = clamp(h, MIN_H, maxH);
    let x = (minX + maxX) / 2;
    let y = (minY - mb + maxY + mt) / 2 - h * HUD_FRAC * 0.5;
    const halfW = (h * aspect) / 2;
    const halfH = h / 2;
    x = cb.right - cb.left > halfW * 2 ? clamp(x, cb.left + halfW, cb.right - halfW) : (cb.left + cb.right) / 2;
    y = cb.top - cb.bottom > halfH * 2 ? clamp(y, cb.bottom + halfH, cb.top - halfH) : (cb.top + cb.bottom) / 2;
    return { x, y, h };
  }

  update(dt: number, targets: FrameTarget[], stage: StageDef): void {
    this.time += dt;
    let tx: number;
    let ty: number;
    let th: number;
    let rate = 3.2;
    let zoomRate: number;
    if (this.focus) {
      tx = this.focus.x;
      ty = this.focus.y;
      th = this.focus.h;
      rate = this.focus.rate;
      zoomRate = this.focus.rate;
    } else {
      const t = this.target(targets, stage);
      tx = t.x;
      ty = t.y;
      th = t.h;
      zoomRate = th > this.h ? 3.5 : 1.6;
    }
    this.cx = damp(this.cx, tx, rate, dt);
    this.cy = damp(this.cy, ty, rate, dt);
    this.h = damp(this.h, th, zoomRate, dt);
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    this.apply();
  }

  private apply(): void {
    const d = this.h / 2 / this.tanHalf;
    const cam = this.camera;
    const s = this.trauma * this.trauma;
    const t = this.time;
    const sx = s * 0.9 * (Math.sin(t * 61.3) * 0.6 + Math.sin(t * 37.1) * 0.4);
    const sy = s * 0.9 * (Math.sin(t * 53.7 + 1.3) * 0.6 + Math.sin(t * 29.3) * 0.4);
    // 2.5D: camera slightly above and to the side, looking a touch down
    const dolly = Math.sin(t * 0.13) * 0.06 * d;
    const lift = 0.1 * d;
    cam.position.set(this.cx + dolly + sx, this.cy + lift + sy, d);
    cam.lookAt(this.cx + sx * 0.5, this.cy + sy * 0.5 + lift * 0.25, 0);
    cam.rotation.z += s * 0.03 * Math.sin(t * 47);
    cam.updateMatrixWorld();
  }

  /** NDC (x, y) of a world point (z = 0 plane). */
  project(x: number, y: number, out: { x: number; y: number }): { x: number; y: number } {
    this.ndc.set(x, y, 0).project(this.camera);
    out.x = this.ndc.x;
    out.y = this.ndc.y;
    return out;
  }
}
