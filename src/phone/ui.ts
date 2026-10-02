/** DOM helpers, procedural avatars and shared lookup data (no three.js!). */
import { CHARACTERS } from '../kart/roster';
import { sunnyCircuit } from '../track/tracks/sunnyCircuit';
import { duneDrift } from '../track/tracks/duneDrift';
import { frostbiteFalls } from '../track/tracks/frostbiteFalls';
import { neonNexus } from '../track/tracks/neonNexus';
import type { CharacterDef, TrackDefinition } from '../core/types';
import { haptic } from './haptics';

export { CHARACTERS };
export const TRACK_DEFS: TrackDefinition[] = [sunnyCircuit, duneDrift, frostbiteFalls, neonNexus];

export const THEME_COLORS: Record<string, [string, string]> = {
  grassland: ['#3ddc5a', '#1d7a3a'],
  desert: ['#ffb347', '#b85c1c'],
  snow: ['#9fe3ff', '#3a78c9'],
  beach: ['#4de0d0', '#1f8fa8'],
  volcano: ['#ff6a3a', '#7a1a12'],
  neon: ['#ff4fd8', '#5b2bd6'],
};

type Child = Node | string | number | null | undefined | false;
type Props = {
  class?: string;
  testid?: string;
  text?: string;
  html?: string;
  style?: string;
  onclick?: (ev: MouseEvent) => void;
  [attr: string]: unknown;
};

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'testid') el.setAttribute('data-testid', String(v));
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'html') el.innerHTML = String(v);
      else if (k === 'style') el.setAttribute('style', String(v));
      else if (k === 'onclick') el.addEventListener('click', v as (ev: Event) => void);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'number' ? String(c) : c);
  }
  return el;
}

/** A big friendly button with a press tick. */
export function button(
  label: string | Node,
  testid: string,
  onTap: () => void,
  cls = 'btn',
): HTMLButtonElement {
  const b = h('button', { class: cls, testid, type: 'button' });
  if (typeof label === 'string') b.textContent = label;
  else b.append(label);
  b.addEventListener('click', (e) => {
    e.preventDefault();
    if (b.disabled) return;
    haptic('tick');
    onTap();
  });
  return b;
}

export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

const htmlCache = new WeakMap<Element, string>();
/** innerHTML, but only touches the DOM when the markup changed. */
export function setHtml(el: Element, html: string): void {
  if (htmlCache.get(el) === html) return;
  htmlCache.set(el, html);
  el.innerHTML = html;
}

export function toggleClass(el: Element, cls: string, on: boolean): void {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

export function show(el: HTMLElement, on: boolean): void {
  const want = on ? '' : 'none';
  if (el.style.display !== want) el.style.display = want;
}

export function hex(n: number): string {
  return '#' + (n >>> 0).toString(16).padStart(6, '0').slice(-6);
}

export function charById(id: string | undefined | null): CharacterDef | null {
  if (!id) return null;
  return CHARACTERS.find((c) => c.id === id) ?? null;
}

export function trackById(id: string | undefined | null): TrackDefinition | null {
  if (!id) return null;
  return TRACK_DEFS.find((t) => t.id === id) ?? null;
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function ordSuffix(n: number): string {
  return ordinal(n).slice(String(n).length);
}

export function fmtTime(sec: number): string {
  if (!(sec >= 0)) return 'DNF';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Procedural racer avatar: helmeted driver in a kart, in the racer's colours.
 * Weight class changes the kart's width so heavies look chunky.
 */
export function avatarSvg(c: CharacterDef | null, size = 56): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 64 64');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', 'avatar');
  svg.setAttribute('aria-hidden', 'true');
  if (!c) {
    svg.innerHTML = `<circle cx="32" cy="32" r="30" fill="#2a2450"/><text x="32" y="42" font-size="28" text-anchor="middle" fill="#8c86b8" font-weight="900">?</text>`;
    return svg;
  }
  const col = hex(c.color);
  const acc = hex(c.accent);
  const drv = hex(c.driverColor);
  const w = c.weightClass === 'heavy' ? 24 : c.weightClass === 'light' ? 18 : 21;
  const x0 = 32 - w;
  const x1 = 32 + w;
  svg.innerHTML = `
    <defs>
      <radialGradient id="g-${c.id}" cx="35%" cy="30%" r="80%">
        <stop offset="0" stop-color="${col}" stop-opacity=".55"/>
        <stop offset="1" stop-color="${col}" stop-opacity=".12"/>
      </radialGradient>
    </defs>
    <circle cx="32" cy="32" r="30" fill="url(#g-${c.id})" stroke="${col}" stroke-width="2.5"/>
    <rect x="${x0 - 4}" y="43" width="9" height="13" rx="3" fill="#15131f"/>
    <rect x="${x1 - 5}" y="43" width="9" height="13" rx="3" fill="#15131f"/>
    <path d="M${x0} 50 Q${x0} 40 ${x0 + 6} 39 L${x1 - 6} 39 Q${x1} 40 ${x1} 50 L${x1 - 2} 55 L${x0 + 2} 55 Z" fill="${col}" stroke="#0d0b18" stroke-width="1.5"/>
    <rect x="${x0 + 4}" y="46" width="${2 * w - 8}" height="3.5" rx="1.7" fill="${acc}"/>
    <circle cx="32" cy="27" r="14" fill="${col}" stroke="#0d0b18" stroke-width="1.5"/>
    <path d="M18.5 24 Q32 14 45.5 24" fill="none" stroke="${acc}" stroke-width="4" stroke-linecap="round"/>
    <rect x="22" y="25" width="20" height="9" rx="4.5" fill="${drv}" stroke="#0d0b18" stroke-width="1.2"/>
    <rect x="25" y="27" width="6" height="2.4" rx="1.2" fill="#ffffff" opacity=".7"/>
  `;
  return svg;
}

/** Mini track outline drawn from the control points (top-down XZ). */
export function trackSvg(t: TrackDefinition, stroke: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const pts = t.controlPoints;
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  const span = Math.max(maxX - minX, maxZ - minZ) || 1;
  const pad = span * 0.08;
  svg.setAttribute('viewBox', `${minX - pad} ${minZ - pad} ${maxX - minX + 2 * pad} ${maxZ - minZ + 2 * pad}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('class', 'track-map');
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.z.toFixed(1)}`).join(' ') + ' Z';
  const sw = span * 0.06;
  svg.innerHTML = `<path d="${d}" fill="none" stroke="rgba(0,0,0,.35)" stroke-width="${sw * 1.9}" stroke-linejoin="round"/>
    <path d="${d}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>
    <circle cx="${pts[0].x}" cy="${pts[0].z}" r="${sw * 1.1}" fill="#fff" stroke="#000" stroke-width="${sw * 0.3}"/>`;
  return svg;
}

let toastTimer = 0;
export function toast(msg: string): void {
  let el = document.getElementById('kp-toast');
  if (!el) {
    el = h('div', { id: 'kp-toast', class: 'toast', testid: 'toast' });
    document.body.append(el);
  }
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('on'), 2600);
}
