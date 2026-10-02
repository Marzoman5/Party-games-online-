/**
 * Procedural stage preview (inline SVG) drawn from the StageDef: themed sky, platforms (solid
 * main stage with depth, thin pass-through platforms), moving-platform paths and the lava pit.
 */
import type { StageDef } from '../../types';

const THEMES: Record<string, { sky: [string, string]; ground: [string, string]; deco: string }> = {
  sky: { sky: ['#4fb3ff', '#ffb36b'], ground: ['#7be07b', '#3a8a4a'], deco: 'clouds' },
  arena: { sky: ['#2a0f5c', '#ff3ab8'], ground: ['#2de2e6', '#1b3b8f'], deco: 'lights' },
  forge: { sky: ['#2a0b0b', '#ff6a2a'], ground: ['#5a5a6a', '#2b2b35'], deco: 'embers' },
  training: { sky: ['#1d2a44', '#3b5a8a'], ground: ['#9fb4d8', '#4a5a78'], deco: 'grid' },
};

let uid = 0;

export function stageColors(st: StageDef): [string, string] {
  return (THEMES[st.theme] ?? THEMES.sky).sky;
}

export function stagePreviewMarkup(st: StageDef, w = 320, hgt = 180): string {
  const t = THEMES[st.theme] ?? THEMES.sky;
  const id = `stg${++uid}`;
  const cam = st.camera;
  // Fit the platforms (plus some air) — the camera box is mostly sky.
  const left = Math.max(cam.left, -16);
  const right = Math.min(cam.right, 16);
  const top = Math.min(cam.top, 10);
  const bottom = Math.max(cam.bottom, -6);
  const sx = w / (right - left);
  const sy = hgt / (top - bottom);
  const X = (x: number): number => (x - left) * sx;
  const Y = (y: number): number => (top - y) * sy;
  const parts: string[] = [];
  parts.push(`<defs>
    <linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.sky[0]}"/><stop offset="1" stop-color="${t.sky[1]}"/></linearGradient>
    <linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.ground[0]}"/><stop offset="1" stop-color="${t.ground[1]}"/></linearGradient>
  </defs>`);
  parts.push(`<rect width="${w}" height="${hgt}" fill="url(#${id}s)"/>`);
  if (t.deco === 'clouds') {
    for (const [cx, cy, r] of [
      [50, 40, 16],
      [70, 44, 12],
      [250, 30, 18],
      [272, 36, 12],
      [160, 150, 22],
    ])
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff" opacity="0.55"/>`);
  } else if (t.deco === 'lights') {
    for (let i = 0; i < 7; i++) parts.push(`<rect x="${20 + i * 45}" y="0" width="6" height="${hgt}" fill="#fff" opacity="0.06"/>`);
    parts.push(`<circle cx="${w / 2}" cy="20" r="60" fill="#ff3ab8" opacity="0.18"/>`);
  } else if (t.deco === 'grid') {
    for (let i = 0; i < 12; i++) parts.push(`<line x1="${i * 30}" y1="0" x2="${i * 30}" y2="${hgt}" stroke="#fff" stroke-opacity="0.08"/>`);
    for (let i = 0; i < 7; i++) parts.push(`<line x1="0" y1="${i * 30}" x2="${w}" y2="${i * 30}" stroke="#fff" stroke-opacity="0.08"/>`);
  }
  if (st.hazard === 'lava') {
    parts.push(`<rect x="0" y="${hgt - 22}" width="${w}" height="22" fill="#ff5a1a"/>`);
    parts.push(`<path d="M0 ${hgt - 22} q20 -8 40 0 t40 0 t40 0 t40 0 t40 0 t40 0 t40 0 t40 0" fill="#ffb02e"/>`);
  }
  for (const p of st.platforms) {
    const x0 = X(p.x - p.w / 2);
    const x1 = X(p.x + p.w / 2);
    const y0 = Y(p.y);
    if (p.solid) {
      const depth = Math.max(8, p.h * sy);
      parts.push(`<path d="M${x0} ${y0} L${x1} ${y0} L${x1 - depth * 0.35} ${y0 + depth} L${x0 + depth * 0.35} ${y0 + depth} Z" fill="url(#${id}g)" stroke="#120a2e" stroke-width="3"/>`);
      parts.push(`<rect x="${x0}" y="${y0 - 3}" width="${x1 - x0}" height="6" rx="3" fill="#fff" opacity="0.75"/>`);
    } else {
      parts.push(`<rect x="${x0}" y="${y0 - 2}" width="${x1 - x0}" height="7" rx="3.5" fill="#fff" stroke="#120a2e" stroke-width="2.5"/>`);
      if (p.path) {
        const ax = X(p.x + p.path.dx);
        const ay = Y(p.y + p.path.dy);
        const cx = (x0 + x1) / 2;
        parts.push(`<line x1="${cx}" y1="${y0}" x2="${ax}" y2="${ay}" stroke="#ffd23f" stroke-width="3" stroke-dasharray="6 5"/>`);
        parts.push(`<circle cx="${ax}" cy="${ay}" r="4" fill="#ffd23f"/>`);
      }
    }
  }
  return `<svg class="sh-stage-svg" viewBox="0 0 ${w} ${hgt}" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${parts.join('')}</svg>`;
}
