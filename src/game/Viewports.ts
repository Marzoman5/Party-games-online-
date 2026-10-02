/**
 * Split-screen layout + per-viewport render state.
 *
 *  1 view : full screen
 *  2 views: side by side when the canvas aspect >= 1.5 (TV / widescreen), stacked otherwise
 *  3 views: quadrants, the 4th quadrant shows a live minimap + standings panel
 *  4 views: quadrants
 *
 * Rects are normalised [0..1] with a TOP-LEFT origin (DOM convention); the
 * renderer converts to GL's bottom-left origin.
 */
import * as THREE from 'three';
import { FollowCamera } from './FollowCamera';
import type { HUD } from '../ui/HUD';

export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutResult {
  views: NormRect[];
  /** Extra panel rect (3-player minimap/standings), or null. */
  panel: NormRect | null;
}

export const SIDE_BY_SIDE_MIN_ASPECT = 1.5;

export function computeLayout(count: number, canvasW: number, canvasH: number): LayoutResult {
  const aspect = canvasW / Math.max(1, canvasH);
  if (count <= 1) return { views: [{ x: 0, y: 0, w: 1, h: 1 }], panel: null };
  if (count === 2) {
    if (aspect >= SIDE_BY_SIDE_MIN_ASPECT) {
      return {
        views: [
          { x: 0, y: 0, w: 0.5, h: 1 },
          { x: 0.5, y: 0, w: 0.5, h: 1 },
        ],
        panel: null,
      };
    }
    return {
      views: [
        { x: 0, y: 0, w: 1, h: 0.5 },
        { x: 0, y: 0.5, w: 1, h: 0.5 },
      ],
      panel: null,
    };
  }
  const q: NormRect[] = [
    { x: 0, y: 0, w: 0.5, h: 0.5 },
    { x: 0.5, y: 0, w: 0.5, h: 0.5 },
    { x: 0, y: 0.5, w: 0.5, h: 0.5 },
    { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
  ];
  if (count === 3) return { views: q.slice(0, 3), panel: q[3] };
  return { views: q, panel: null };
}

/** Apply a normalised rect + which-screen-edges-it-touches to a DOM node (for --safe margins). */
export function applyRectToElement(node: HTMLElement, r: NormRect): void {
  node.style.left = `${r.x * 100}%`;
  node.style.top = `${r.y * 100}%`;
  node.style.width = `${r.w * 100}%`;
  node.style.height = `${r.h * 100}%`;
  const eps = 1e-4;
  node.style.setProperty('--st', r.y < eps ? 'var(--safe, 0px)' : '0px');
  node.style.setProperty('--sl', r.x < eps ? 'var(--safe, 0px)' : '0px');
  node.style.setProperty('--sb', r.y + r.h > 1 - eps ? 'var(--safe, 0px)' : '0px');
  node.style.setProperty('--sr', r.x + r.w > 1 - eps ? 'var(--safe, 0px)' : '0px');
}

/** One human's view: camera, chase rig, DOM container + HUD. */
export class Viewport {
  readonly camera: THREE.PerspectiveCamera;
  readonly follow: FollowCamera;
  readonly element: HTMLElement;
  hud: HUD | null = null;
  rect: NormRect = { x: 0, y: 0, w: 1, h: 1 };
  lookBack = false;

  constructor(
    readonly index: number,
    readonly kartId: number,
    parent: HTMLElement,
  ) {
    this.camera = new THREE.PerspectiveCamera(68, 1, 0.1, 1200);
    this.follow = new FollowCamera(this.camera);
    this.element = document.createElement('div');
    this.element.className = 'vp';
    this.element.dataset.vp = String(index);
    parent.appendChild(this.element);
  }

  setRect(r: NormRect, canvasW: number, canvasH: number): void {
    this.rect = r;
    applyRectToElement(this.element, r);
    const aspect = (r.w * canvasW) / Math.max(1, r.h * canvasH);
    if (Math.abs(this.camera.aspect - aspect) > 1e-4) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
    // Tall viewports (side-by-side halves) get a slightly wider lens.
    this.follow.fovScale = aspect < 1.1 ? 1.12 : aspect < 1.4 ? 1.05 : 1;
    this.element.classList.toggle('compact', r.w < 0.99 || r.h < 0.99);
    this.element.classList.toggle('quad', r.w < 0.51 && r.h < 0.51);
  }

  dispose(): void {
    this.follow.dispose();
    this.hud?.dispose();
    this.hud = null;
    this.element.remove();
  }
}
