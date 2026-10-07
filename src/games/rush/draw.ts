/**
 * LEAD — shared Party Rush canvas helpers (host). Every minigame and the shell draw players with
 * `drawToken` so a player is ALWAYS colour + emoji (+ name) together, readable from across the room.
 * Pure Canvas 2D, system fonts only (no web fonts), no assets.
 */
import type { RushPlayer } from './types';

/** System font stack (bold, rounded where available). */
export const FONT = `"Segoe UI", "SF Pro Rounded", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif`;
/** Emoji font stack (colour emoji on every OS). */
export const EMOJI_FONT = `"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", sans-serif`;

/** Party Rush palette (dark stage, loud accents). */
export const PAL = {
  bg0: '#120d2a',
  bg1: '#1d1546',
  panel: 'rgba(255,255,255,0.08)',
  line: 'rgba(255,255,255,0.18)',
  text: '#ffffff',
  dim: 'rgba(255,255,255,0.55)',
  good: '#3ddc5a',
  bad: '#ff4d4d',
  warn: '#ffc21a',
  accent: '#ff3ab8',
  gold: '#ffd23a',
  silver: '#d6dbe8',
  bronze: '#e08a4a',
} as const;

export function font(size: number, weight: number | string = 900): string {
  return `${weight} ${Math.round(size)}px ${FONT}`;
}

/** Text with a dark outline (legible on any background). */
export function drawText(
  g: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  color: string = PAL.text,
  opts: { align?: CanvasTextAlign; baseline?: CanvasTextBaseline; weight?: number | string; outline?: number; maxWidth?: number; alpha?: number } = {},
): void {
  g.save();
  g.font = font(size, opts.weight ?? 900);
  g.textAlign = opts.align ?? 'center';
  g.textBaseline = opts.baseline ?? 'middle';
  if (opts.alpha !== undefined) g.globalAlpha *= opts.alpha;
  const ow = opts.outline ?? Math.max(2, size * 0.12);
  if (ow > 0) {
    g.lineJoin = 'round';
    g.lineWidth = ow;
    g.strokeStyle = 'rgba(10,6,30,0.85)';
    g.strokeText(text, x, y, opts.maxWidth);
  }
  g.fillStyle = color;
  g.fillText(text, x, y, opts.maxWidth);
  g.restore();
}

export function drawEmoji(g: CanvasRenderingContext2D, emoji: string, x: number, y: number, size: number, alpha = 1): void {
  g.save();
  g.globalAlpha *= alpha;
  g.font = `${Math.round(size)}px ${EMOJI_FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // Emoji glyphs sit slightly high in most fonts.
  g.fillText(emoji, x, y + size * 0.06);
  g.restore();
}

export function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

export interface TokenOpts {
  /** Draw the name under the token (default true). */
  label?: boolean;
  /** Name position. */
  labelPos?: 'below' | 'above' | 'right';
  /** Greyed out (away / out). */
  dim?: boolean;
  /** Extra ring colour (e.g. leader gold, holder red). */
  ring?: string;
  /** Show the small 👆 badge for touch players (default true). */
  touchBadge?: boolean;
  /** Squash/stretch wobble 0..1. */
  wobble?: number;
  /** Rotation (radians) of the disc + emoji. */
  rot?: number;
  /** Label size multiplier. */
  labelScale?: number;
}

/**
 * THE way to draw a player: a colour disc with a white rim, the emoji on it, and the name in the
 * player's colour (outlined). `r` = disc radius in stage units (≥ 28 keeps it readable on a TV).
 */
export function drawToken(g: CanvasRenderingContext2D, p: Pick<RushPlayer, 'name' | 'emoji' | 'color' | 'touch'>, x: number, y: number, r: number, opts: TokenOpts = {}): void {
  g.save();
  const dim = !!opts.dim;
  if (dim) g.globalAlpha *= 0.4;
  g.translate(x, y);
  if (opts.rot) g.rotate(opts.rot);
  const w = opts.wobble ?? 0;
  if (w) g.scale(1 + w * 0.12, 1 - w * 0.12);
  // shadow
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.beginPath();
  g.ellipse(0, r * 0.92, r * 0.85, r * 0.22, 0, 0, Math.PI * 2);
  g.fill();
  // disc
  g.beginPath();
  g.arc(0, 0, r, 0, Math.PI * 2);
  g.fillStyle = dim ? '#555' : p.color;
  g.fill();
  g.lineWidth = Math.max(3, r * 0.14);
  g.strokeStyle = '#ffffff';
  g.stroke();
  if (opts.ring) {
    g.beginPath();
    g.arc(0, 0, r + Math.max(4, r * 0.16), 0, Math.PI * 2);
    g.lineWidth = Math.max(4, r * 0.16);
    g.strokeStyle = opts.ring;
    g.stroke();
  }
  drawEmoji(g, p.emoji, 0, 0, r * 1.25);
  g.restore();
  if (p.touch && opts.touchBadge !== false) drawEmoji(g, '👆', x + r * 0.78, y - r * 0.78, r * 0.55, dim ? 0.4 : 1);
  if (opts.label !== false) {
    const ls = Math.max(22, r * 0.62) * (opts.labelScale ?? 1);
    const pos = opts.labelPos ?? 'below';
    const lx = pos === 'right' ? x + r + 12 : x;
    const ly = pos === 'below' ? y + r + ls * 0.75 : pos === 'above' ? y - r - ls * 0.7 : y;
    drawText(g, p.name, lx, ly, ls, dim ? '#999' : p.color, { align: pos === 'right' ? 'left' : 'center', maxWidth: pos === 'right' ? undefined : Math.max(r * 4, 160) });
  }
}

/** Layout helper: n cells in a grid filling (x, y, w, h), as square-ish as possible. Returns cell centres + size. */
export function gridCells(n: number, x: number, y: number, w: number, h: number): { cx: number; cy: number; w: number; h: number }[] {
  if (n <= 0) return [];
  let best = { cols: 1, rows: n, size: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const size = Math.min(w / cols, h / rows);
    if (size > best.size) best = { cols, rows, size };
  }
  const cw = w / best.cols;
  const ch = h / best.rows;
  const out: { cx: number; cy: number; w: number; h: number }[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / best.cols);
    const inRow = row === best.rows - 1 ? n - row * best.cols : best.cols;
    const col = i % best.cols;
    const offset = ((best.cols - inRow) * cw) / 2; // centre a short last row
    out.push({ cx: x + offset + cw * (col + 0.5), cy: y + ch * (row + 0.5), w: cw, h: ch });
  }
  return out;
}

/** Simple 0..1 easing helpers. */
export const ease = {
  outCubic: (t: number): number => 1 - Math.pow(1 - clamp01(t), 3),
  inOutSine: (t: number): number => -(Math.cos(Math.PI * clamp01(t)) - 1) / 2,
  outBack: (t: number): number => {
    const c = 1.70158;
    const x = clamp01(t) - 1;
    return 1 + (c + 1) * x * x * x + c * x * x;
  },
};

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Background fill for a minigame stage (vertical gradient). */
export function stageBackground(g: CanvasRenderingContext2D, top: string, bottom: string, w = 1920, h = 1080): void {
  const gr = g.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, top);
  gr.addColorStop(1, bottom);
  g.fillStyle = gr;
  g.fillRect(0, 0, w, h);
}

/** Mulberry32 seeded RNG. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Competition ranking from scores (higher is better unless `lowerBetter`): ties share the place. */
export function rankBy<T extends { id: string }>(items: T[], score: (x: T) => number, lowerBetter = false): (T & { place: number })[] {
  const sorted = [...items].sort((a, b) => (lowerBetter ? score(a) - score(b) : score(b) - score(a)));
  const out: (T & { place: number })[] = [];
  sorted.forEach((it, i) => {
    const prev = out[i - 1];
    const place = prev && score(prev) === score(it) ? prev.place : i + 1;
    out.push({ ...it, place });
  });
  return out;
}
