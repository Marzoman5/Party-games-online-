/**
 * Track minimap outline drawn from the track definition's control points (x/z plane),
 * smoothed with a centripetal-ish Catmull-Rom → cubic Bézier conversion. Inline SVG.
 */
import type { TrackDefinition } from '../../core/types';
import { hex, shade } from './dom';

const THEME_GRADIENTS: Record<string, [string, string]> = {
  grassland: ['#38c172', '#1e7fd6'],
  desert: ['#ffb347', '#d9622b'],
  snow: ['#a8e6ff', '#4b7bd8'],
  beach: ['#40e0d0', '#f7b267'],
  volcano: ['#ff5e3a', '#5c1a1a'],
  neon: ['#ff3ab8', '#3b1a8f'],
};

export function themeColors(def: TrackDefinition): [string, string] {
  return THEME_GRADIENTS[def.theme] ?? [hex(def.environment.skyHorizon), hex(def.environment.skyTop)];
}

export function themeEmoji(def: TrackDefinition): string {
  return (
    { grassland: '🌳', desert: '🌵', snow: '❄️', beach: '🏝️', volcano: '🌋', neon: '🌃' } as Record<string, string>
  )[def.theme] ?? '🏁';
}

export function trackPath(def: TrackDefinition, size = 200, pad = 16): { d: string; start: [number, number]; dir: number } {
  const pts = def.controlPoints.map((p) => [p.x, p.z] as [number, number]);
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const scale = (size - pad * 2) / Math.max(maxX - minX, maxY - minY, 1);
  const ox = (size - (maxX - minX) * scale) / 2;
  const oy = (size - (maxY - minY) * scale) / 2;
  const P = pts.map(([x, y]) => [ox + (x - minX) * scale, oy + (y - minY) * scale] as [number, number]);
  const n = P.length;
  let d = `M${P[0][0].toFixed(1)} ${P[0][1].toFixed(1)}`;
  for (let i = 0; i < n; i++) {
    const p0 = P[(i - 1 + n) % n],
      p1 = P[i],
      p2 = P[(i + 1) % n],
      p3 = P[(i + 2) % n];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6,
      c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6,
      c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  d += ' Z';
  const dir = (Math.atan2(P[1][1] - P[0][1], P[1][0] - P[0][0]) * 180) / Math.PI;
  return { d, start: P[0], dir };
}

export function minimapMarkup(def: TrackDefinition, opts: { size?: number; animated?: boolean } = {}): string {
  const size = opts.size ?? 200;
  const { d, start, dir } = trackPath(def, size, size * 0.09);
  const road = shade(hex(def.palette.road), 0.15);
  const w = size * 0.055;
  return `
<svg class="kp-minimap" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="${d}" fill="none" stroke="rgba(0,0,0,0.35)" stroke-width="${w * 2.3}" stroke-linejoin="round" transform="translate(0 ${size * 0.02})"/>
  <path d="${d}" fill="none" stroke="#ffffff" stroke-width="${w * 1.9}" stroke-linejoin="round"/>
  <path d="${d}" fill="none" stroke="${road}" stroke-width="${w * 1.2}" stroke-linejoin="round"/>
  <path class="${opts.animated ? 'kp-minimap-run' : ''}" d="${d}" fill="none" stroke="#ffd23f" stroke-width="${w * 0.35}"
        stroke-dasharray="${w * 0.9} ${w * 1.4}" stroke-linecap="round" stroke-linejoin="round"/>
  <g transform="translate(${start[0].toFixed(1)} ${start[1].toFixed(1)}) rotate(${dir.toFixed(1)})">
    <rect x="${-w * 0.45}" y="${-w * 1.1}" width="${w * 0.9}" height="${w * 2.2}" fill="#fff" stroke="#111" stroke-width="${w * 0.2}"/>
    <rect x="${-w * 0.45}" y="${-w * 1.1}" width="${w * 0.45}" height="${w * 0.55}" fill="#111"/>
    <rect x="0" y="${-w * 0.55}" width="${w * 0.45}" height="${w * 0.55}" fill="#111"/>
    <rect x="${-w * 0.45}" y="0" width="${w * 0.45}" height="${w * 0.55}" fill="#111"/>
    <rect x="0" y="${w * 0.55}" width="${w * 0.45}" height="${w * 0.55}" fill="#111"/>
  </g>
</svg>`;
}

export function stars(n: number, of = 3): string {
  return '★'.repeat(n) + '☆'.repeat(Math.max(0, of - n));
}
