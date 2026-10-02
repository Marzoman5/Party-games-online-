/**
 * North-up canvas minimap: static road layer (rendered once per track) plus
 * kart dots redrawn at ~30 Hz. The canvas has a fixed internal resolution; its
 * on-screen size comes from CSS (it scales with the viewport). Human karts get a
 * ring in their slot colour; the followed kart is drawn on top with a halo.
 */
import type { IKart, ITrack } from '../core/types';
import { MINIMAP_SIZE } from '../core/constants';
import { cssHex, el } from './dom';

const PAD = 14;
const REDRAW_INTERVAL = 1 / 30;

export interface MinimapOptions {
  /** Internal resolution in "CSS px" units before the DPR multiplier (default MINIMAP_SIZE). */
  size?: number;
  /** kartId -> CSS colour of human karts. */
  humanColors?: ReadonlyMap<number, string>;
}

export class Minimap {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly layer: HTMLCanvasElement;
  private track: ITrack | null = null;
  private timer = 0;
  private readonly dpr: number;
  private readonly size: number;
  private readonly humanColors: ReadonlyMap<number, string> | null;

  constructor(root: HTMLElement, opts: MinimapOptions = {}) {
    this.size = opts.size ?? MINIMAP_SIZE;
    this.humanColors = opts.humanColors ?? null;
    // The canvas is CSS-scaled; render at ~2x so it stays crisp on a 4K TV.
    this.dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1.5), 2);
    this.canvas = el('canvas', 'minimap-canvas', undefined, root);
    this.canvas.width = Math.round(this.size * this.dpr);
    this.canvas.height = Math.round(this.size * this.dpr);
    this.ctx = this.canvas.getContext('2d');
    this.layer = document.createElement('canvas');
    this.layer.width = this.canvas.width;
    this.layer.height = this.canvas.height;
  }

  setTrack(track: ITrack | null): void {
    this.track = track;
    this.renderStaticLayer();
    this.timer = REDRAW_INTERVAL; // force an immediate redraw
  }

  update(dt: number, karts: readonly IKart[], playerId: number): void {
    this.timer += dt;
    if (this.timer < REDRAW_INTERVAL) return;
    this.timer = 0;
    const ctx = this.ctx;
    if (!ctx) return;
    const size = this.size * this.dpr;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(this.layer, 0, 0);
    const track = this.track;
    if (!track) return;
    const scale = size - PAD * 2 * this.dpr;
    const off = PAD * this.dpr;
    const u = (this.size / MINIMAP_SIZE) * this.dpr;
    const hc = this.humanColors;

    // Pass 0: AI, pass 1: other humans, pass 2: the followed kart (always on top).
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < karts.length; i++) {
        const k = karts[i];
        const id = k.state.id;
        const isSelf = id === playerId;
        const ring = hc ? hc.get(id) : undefined;
        const kind = isSelf ? 2 : ring ? 1 : 0;
        if (kind !== pass) continue;
        const p = track.minimap.worldToMap(k.state.position.x, k.state.position.z);
        const x = off + p.x * scale;
        const y = off + p.y * scale;
        const r = (kind === 0 ? 4.5 : 6.5) * u;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = cssHex(k.state.character.color);
        ctx.fill();
        ctx.lineWidth = (kind === 0 ? 1.2 : 2.8) * u;
        ctx.strokeStyle = kind === 0 ? 'rgba(0,0,0,0.6)' : ring ?? '#ffffff';
        ctx.stroke();
        if (isSelf) {
          ctx.beginPath();
          ctx.arc(x, y, r + 4 * u, 0, Math.PI * 2);
          ctx.lineWidth = 1.8 * u;
          ctx.strokeStyle = ring ? ring : 'rgba(255,255,255,0.55)';
          ctx.globalAlpha = 0.7;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    }
  }

  dispose(): void {
    this.canvas.remove();
    // Release the backing stores right away (many races per session).
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.layer.width = 0;
    this.layer.height = 0;
    this.track = null;
  }

  private renderStaticLayer(): void {
    const ctx = this.layer.getContext('2d');
    if (!ctx) return;
    const size = this.size * this.dpr;
    ctx.clearRect(0, 0, size, size);
    const track = this.track;
    if (!track) return;
    const mm = track.minimap;
    const scale = size - PAD * 2 * this.dpr;
    const off = PAD * this.dpr;
    const u = (this.size / MINIMAP_SIZE) * this.dpr;
    const toX = (v: number) => off + v * scale;
    const toY = (v: number) => off + v * scale;

    const tracePoly = (pts: readonly { x: number; y: number }[], close: boolean) => {
      if (pts.length === 0) return;
      ctx.beginPath();
      ctx.moveTo(toX(pts[0].x), toY(pts[0].y));
      for (let i = 1; i < pts.length; i++) ctx.lineTo(toX(pts[i].x), toY(pts[i].y));
      if (close) ctx.closePath();
    };

    const left = mm.leftEdge;
    const right = mm.rightEdge;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (left.length > 1 && right.length > 1) {
      // Road ribbon: left edge forward, right edge backward.
      ctx.beginPath();
      ctx.moveTo(toX(left[0].x), toY(left[0].y));
      for (let i = 1; i < left.length; i++) ctx.lineTo(toX(left[i].x), toY(left[i].y));
      for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(toX(right[i].x), toY(right[i].y));
      ctx.closePath();
      ctx.fillStyle = 'rgba(20, 22, 40, 0.85)';
      ctx.fill();
      ctx.lineWidth = 1.5 * u;
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.stroke();
    } else if (mm.points.length > 1) {
      tracePoly(mm.points, true);
      ctx.lineWidth = 9 * u;
      ctx.strokeStyle = 'rgba(20, 22, 40, 0.9)';
      ctx.stroke();
      ctx.lineWidth = 11 * u;
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.globalCompositeOperation = 'destination-over';
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }

    // Dashed centreline.
    if (mm.points.length > 1) {
      tracePoly(mm.points, true);
      ctx.setLineDash([3 * u, 5 * u]);
      ctx.lineWidth = 1 * u;
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.stroke();
      ctx.setLineDash([]);

      // Finish line marker at t = 0.
      const p0 = mm.points[0];
      const p1 = mm.points[1];
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      const half = 7 * u;
      const cx = toX(p0.x);
      const cy = toY(p0.y);
      ctx.beginPath();
      ctx.moveTo(cx - nx * half, cy - ny * half);
      ctx.lineTo(cx + nx * half, cy + ny * half);
      ctx.lineWidth = 3 * u;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx - nx * half, cy - ny * half);
      ctx.lineTo(cx + nx * half, cy + ny * half);
      ctx.setLineDash([2 * u, 2 * u]);
      ctx.lineWidth = 3 * u;
      ctx.strokeStyle = '#111111';
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}
