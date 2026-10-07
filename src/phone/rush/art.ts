/**
 * PARTY RUSH — phone-side pictures, all inline SVG drawn in code (no assets):
 * the hand+phone gesture demos (mirroring the TV's UP NEXT card), the Hot Potato bomb, the six target
 * poses (Copy the Pose), the fish on the hook and the "hold tight" grip. Animations live in rush.css.
 */
import { RUSH_POSES, type RushDemo } from '../../net/protocol';

const SKIN = '#ffc994';
const SKIN_LINE = '#8a4b22';
const INK = '#16122b';

function esc(t: string): string {
  return t.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch);
}

/** Front view of a phone (x 70..130, y 30..140) with the player's emoji on the screen. */
function phoneFront(emoji: string, screen = '#bfe6ff'): string {
  return `
    <rect x="70" y="30" width="60" height="110" rx="13" fill="${INK}" stroke="#fff" stroke-width="4"/>
    <rect x="76" y="40" width="48" height="90" rx="7" fill="${screen}"/>
    <rect x="91" y="34" width="18" height="4" rx="2" fill="#4a4470"/>
    <text x="100" y="94" font-size="30" text-anchor="middle" dominant-baseline="middle">${esc(emoji)}</text>`;
}

/** Right hand gripping the lower half of the phone (palm behind, fingers + thumb in front). */
function handBack(): string {
  return `
    <rect x="84" y="160" width="36" height="60" rx="14" fill="${SKIN}" stroke="${SKIN_LINE}" stroke-width="3"/>
    <rect x="62" y="96" width="80" height="80" rx="30" fill="${SKIN}" stroke="${SKIN_LINE}" stroke-width="3"/>`;
}
function handFront(): string {
  return `
    <rect x="58" y="96" width="22" height="14" rx="7" fill="${SKIN}" stroke="${SKIN_LINE}" stroke-width="3"/>
    <rect x="57" y="111" width="23" height="14" rx="7" fill="${SKIN}" stroke="${SKIN_LINE}" stroke-width="3"/>
    <rect x="59" y="126" width="21" height="14" rx="7" fill="${SKIN}" stroke="${SKIN_LINE}" stroke-width="3"/>
    <rect x="121" y="84" width="17" height="44" rx="8.5" fill="${SKIN}" stroke="${SKIN_LINE}" stroke-width="3" transform="rotate(-12 129 106)"/>`;
}

/** Motion marks drawn around the rig per demo (static, the rig itself animates). */
function marks(d: RushDemo): string {
  const m = 'fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"';
  switch (d) {
    case 'shake':
      return `<g class="mk"><path d="M40 70 q-12 25 0 50" ${m}/><path d="M24 60 q-18 35 0 70" ${m} opacity=".6"/>
        <path d="M160 70 q12 25 0 50" ${m}/><path d="M176 60 q18 35 0 70" ${m} opacity=".6"/></g>`;
    case 'tilt':
      return `<g class="mk"><path d="M48 32 Q100 0 152 32" ${m}/><path d="M48 32 l2 -16 M48 32 l15 4" ${m}/><path d="M152 32 l-2 -16 M152 32 l-15 4" ${m}/></g>`;
    case 'flick':
    case 'cast':
      return `<g class="mk"><path d="M150 40 Q185 85 160 140" ${m}/><path d="M160 140 l-2 -18 M160 140 l-16 -6" ${m}/></g>`;
    case 'yank':
      return `<g class="mk"><path d="M168 40 L168 120" ${m}/><path d="M168 124 l-12 -14 M168 124 l12 -14" ${m}/><path d="M32 40 L32 120" ${m} opacity=".6"/><path d="M32 124 l-12 -14 M32 124 l12 -14" ${m} opacity=".6"/></g>`;
    case 'still':
      return `<g class="mk mk-still"><circle cx="100" cy="100" r="92" fill="none" stroke="#fff" stroke-width="5" stroke-dasharray="10 12"/></g>`;
    case 'aim':
      return `<g class="mk"><circle cx="100" cy="22" r="17" fill="none" stroke="#fff" stroke-width="5"/><circle cx="100" cy="22" r="5" fill="#fff"/>
        <path d="M100 0 v9 M100 35 v9 M78 22 h9 M113 22 h9" stroke="#fff" stroke-width="4"/></g>`;
    case 'pose':
      return `<g class="mk"><path d="M36 150 A75 75 0 0 1 36 50" ${m}/><path d="M36 50 l-2 16 M36 50 l15 3" ${m}/></g>`;
    default:
      return '';
  }
}

/** Raise (Quick Draw): side view — arm + phone pivoting from pointing at the floor up to level. */
function raiseSvg(emoji: string): string {
  return `<svg class="rz-demo-svg" viewBox="0 0 200 200" aria-hidden="true">
    <path d="M14 196 H186" stroke="rgba(255,255,255,.55)" stroke-width="5" stroke-dasharray="12 10"/>
    <g class="mk"><path d="M150 150 Q178 110 160 62" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round"/>
      <path d="M160 58 l-14 8 M160 58 l6 15" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round"/></g>
    <rect x="22" y="80" width="44" height="112" rx="18" fill="rgba(255,255,255,.85)" stroke="${INK}" stroke-width="3"/>
    <circle cx="44" cy="40" r="22" fill="${SKIN}" stroke="${SKIN_LINE}" stroke-width="3"/>
    <circle cx="52" cy="36" r="3" fill="${INK}"/><path d="M50 50 q6 3 10 -1" fill="none" stroke="${INK}" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="44" cy="70" r="16" fill="${SKIN}" stroke="${SKIN_LINE}" stroke-width="3"/>
    <g class="rig rig-raise">
      <rect x="40" y="62" width="70" height="17" rx="8.5" fill="${SKIN}" stroke="${SKIN_LINE}" stroke-width="3"/>
      <rect x="104" y="60" width="62" height="20" rx="6" fill="${INK}" stroke="#fff" stroke-width="4"/>
      <circle cx="112" cy="70" r="13" fill="${SKIN}" stroke="${SKIN_LINE}" stroke-width="3"/>
      <text x="142" y="71" font-size="14" text-anchor="middle" dominant-baseline="middle">${esc(emoji)}</text>
    </g>
  </svg>`;
}

/** Looping hand+phone gesture demo for `demo` (CSS animates `.rig` per data-demo). */
export function demoSvg(demo: RushDemo | '', emoji: string): string {
  const d: RushDemo = demo || 'flick';
  if (d === 'raise') return raiseSvg(emoji);
  return `<svg class="rz-demo-svg" viewBox="-10 -10 220 240" aria-hidden="true">
    ${marks(d)}
    <g class="rig">${handBack()}${phoneFront(emoji)}${handFront()}</g>
  </svg>`;
}

/** Static grip picture for the "Hold your phone tight!" card. */
export function gripSvg(emoji: string): string {
  return `<svg class="rz-grip-svg" viewBox="-10 -10 220 240" aria-hidden="true">
    <g class="rig">${handBack()}${phoneFront(emoji)}${handFront()}</g>
  </svg>`;
}

/** Big cartoon bomb with a lit fuse (Hot Potato holder). Pulse speed comes from CSS var --bp. */
export function bombSvg(): string {
  return `<svg class="rz-bomb-svg" viewBox="0 0 200 210" aria-hidden="true">
    <path class="fuse" d="M128 52 Q140 22 166 26 Q182 28 180 12" fill="none" stroke="#c9a46a" stroke-width="7" stroke-linecap="round"/>
    <g class="spark" transform="translate(180 12)">
      <path d="M0 -20 L5 -5 L20 0 L5 5 L0 20 L-5 5 L-20 0 L-5 -5 Z" fill="#ffe14d"/>
      <path d="M0 -11 L3 -3 L11 0 L3 3 L0 11 L-3 3 L-11 0 L-3 -3 Z" fill="#ff7a1a"/>
    </g>
    <g class="body">
      <rect x="104" y="40" width="40" height="30" rx="6" fill="#3a3550" stroke="${INK}" stroke-width="5" transform="rotate(30 124 55)"/>
      <circle cx="96" cy="120" r="72" fill="#25213a" stroke="${INK}" stroke-width="6"/>
      <ellipse cx="70" cy="92" rx="20" ry="13" fill="#fff" opacity=".35" transform="rotate(-35 70 92)"/>
      <circle cx="60" cy="120" r="6" fill="#fff" opacity=".2"/>
      <g class="face">
        <ellipse cx="76" cy="122" rx="9" ry="12" fill="#fff"/><ellipse cx="116" cy="122" rx="9" ry="12" fill="#fff"/>
        <circle cx="78" cy="125" r="5" fill="${INK}"/><circle cx="118" cy="125" r="5" fill="${INK}"/>
        <path d="M78 156 Q96 146 114 156" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/>
      </g>
    </g>
  </svg>`;
}

/** A fish on the hook (Fishing bite). */
export function fishSvg(): string {
  return `<svg class="rz-fish-svg" viewBox="0 0 220 200" aria-hidden="true">
    <path d="M58 0 V100" stroke="#fff" stroke-width="4"/>
    <g class="fish">
      <path d="M150 120 L206 88 L198 124 L206 160 Z" fill="#ff9f1a" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
      <ellipse cx="104" cy="124" rx="62" ry="40" fill="#ffc21a" stroke="${INK}" stroke-width="5"/>
      <path d="M96 86 Q110 66 132 92" fill="#ff9f1a" stroke="${INK}" stroke-width="4"/>
      <path d="M118 104 Q128 124 118 146" fill="none" stroke="${INK}" stroke-width="3" opacity=".5"/>
      <circle cx="70" cy="112" r="11" fill="#fff" stroke="${INK}" stroke-width="3"/><circle cx="67" cy="112" r="5" fill="${INK}"/>
      <path d="M44 132 q8 6 16 0" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>
      <path d="M58 98 v26 q0 12 -9 12 q-7 0 -7 -7" fill="none" stroke="#e6e6f0" stroke-width="6" stroke-linecap="round"/>
    </g>
    <text x="24" y="70" font-size="34" font-weight="900" fill="#fff" class="excl">!</text>
    <text x="180" y="56" font-size="34" font-weight="900" fill="#fff" class="excl">!</text>
  </svg>`;
}

/** Big readable label per pose index (RUSH_POSES order). */
export const POSE_LABELS = ['FACE UP', 'FACE DOWN', 'STAND IT UP', 'UPSIDE DOWN', 'LEFT SIDE DOWN', 'RIGHT SIDE DOWN'];
/** Touch fallback gesture per pose index. */
export const POSE_SWIPES = ['tap', 'double-tap', 'swipe ↑', 'swipe ↓', 'swipe ←', 'swipe →'];

/**
 * Clear pictogram of the target phone pose. Upright / upside down / edges: a front-view phone rotated,
 * with the floor drawn under it and a TOP marker; face up / down: a flat phone on a table, seen from the
 * side, with an arrow showing where the screen points.
 */
export function poseSvg(index: number, emoji: string): string {
  const i = Math.max(0, Math.min(RUSH_POSES.length - 1, Math.round(index)));
  const floor = `<path d="M10 222 H210" stroke="#fff" stroke-width="6" stroke-linecap="round"/>
    <path d="M24 226 l-12 14 M54 226 l-12 14 M84 226 l-12 14 M114 226 l-12 14 M144 226 l-12 14 M174 226 l-12 14 M204 226 l-12 14" stroke="rgba(255,255,255,.6)" stroke-width="4"/>`;
  if (i === 0 || i === 1) {
    const up = i === 0;
    // Side view of a flat phone on a table; the screen side is the bright stripe.
    const phone = `<rect x="34" y="176" width="152" height="22" rx="9" fill="${INK}" stroke="#fff" stroke-width="4"/>
      <rect x="44" y="${up ? 172 : 196}" width="132" height="6" rx="3" fill="#7fe0ff"/>`;
    const arrow = up
      ? `<path d="M110 160 V70" stroke="#fff" stroke-width="10" stroke-linecap="round"/><path d="M110 58 l-26 30 h52 z" fill="#fff"/>
         <text x="110" y="40" font-size="40" text-anchor="middle" dominant-baseline="middle">☀️</text>`
      : `<path d="M110 70 V150" stroke="#fff" stroke-width="10" stroke-linecap="round" stroke-dasharray="4 16" opacity=".8"/>
         <text x="110" y="40" font-size="34" text-anchor="middle" dominant-baseline="middle">⬇️</text>
         <text x="110" y="112" font-size="15" font-weight="900" fill="#fff" text-anchor="middle">SCREEN DOWN</text>`;
    const label = up ? `<text x="110" y="128" font-size="15" font-weight="900" fill="#fff" text-anchor="middle">SCREEN UP</text>` : '';
    return `<svg class="rz-pose-svg" viewBox="0 0 220 250" aria-hidden="true">${arrow}${label}${phone}${floor}</svg>`;
  }
  const rot = i === 2 ? 0 : i === 3 ? 180 : i === 4 ? -90 : 90;
  // Phone front centred at (110, 120), rotated; it stands on the floor line (edge length after rotation).
  const landscape = i >= 4;
  const k = 1.45;
  const cy = landscape ? 222 - 32 * k - 4 : 222 - 57 * k - 4;
  return `<svg class="rz-pose-svg" viewBox="0 0 220 250" aria-hidden="true">
    ${floor}
    <g transform="translate(110 ${cy}) rotate(${rot}) scale(${k})">
      <rect x="-32" y="-57" width="64" height="114" rx="13" fill="${INK}" stroke="#fff" stroke-width="4"/>
      <rect x="-26" y="-47" width="52" height="94" rx="7" fill="#bfe6ff"/>
      <rect x="-10" y="-53" width="20" height="4" rx="2" fill="#4a4470"/>
      <path d="M0 -40 l-12 14 h24 z" fill="#ff4d6d"/>
      <text x="0" y="-12" font-size="9" font-weight="900" fill="#ff4d6d" text-anchor="middle">TOP</text>
      <text x="0" y="18" font-size="30" text-anchor="middle" dominant-baseline="middle">${esc(emoji)}</text>
    </g>
  </svg>`;
}
