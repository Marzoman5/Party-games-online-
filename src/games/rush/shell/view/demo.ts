/**
 * SHELL — the looping "hand + phone doing the gesture" demo on the UP NEXT card (inline SVG, animated by
 * CSS keyframes in rush.css: `.rd-<demo>`). Our own markup only; no assets.
 */
import type { RushDemo } from '../../../../net/protocol';

const SKIN = '#f4c7a1';
const SKIN_LINE = '#7a4a2c';

/** Phone held in a right hand, wrist at (150, 300). */
function rig(color: string, screen: string): string {
  return `
  <g class="rd-rig">
    <rect x="122" y="250" width="56" height="130" rx="22" fill="${SKIN}" stroke="${SKIN_LINE}" stroke-width="5"/>
    <rect x="100" y="52" width="100" height="186" rx="18" fill="#17122c" stroke="#ffffff" stroke-width="7"/>
    <rect x="110" y="68" width="80" height="150" rx="8" fill="${color}"/>
    <g class="rd-screen">${screen}</g>
    <path d="M96 170 Q86 214 104 262 Q126 296 168 290 Q204 282 208 246 L208 172 Q206 160 194 162 L186 166 Q184 154 172 156 L164 160 Q160 150 148 154 Q130 160 120 176 Z" fill="${SKIN}" stroke="${SKIN_LINE}" stroke-width="5" stroke-linejoin="round"/>
    <path d="M168 168 L170 214 M188 170 L190 218" stroke="${SKIN_LINE}" stroke-width="4" stroke-linecap="round" opacity="0.55"/>
    <path d="M100 196 Q84 150 104 128 Q116 120 122 134 L120 176" fill="${SKIN}" stroke="${SKIN_LINE}" stroke-width="5" stroke-linejoin="round"/>
  </g>`;
}

const FX: Record<RushDemo, string> = {
  shake: `<g class="rd-fx rd-fx-shake" stroke="#fff" stroke-width="7" stroke-linecap="round">
      <path d="M60 110 L80 110 M50 150 L78 150 M60 190 L80 190"/><path d="M240 110 L220 110 M250 150 L222 150 M240 190 L220 190"/></g>`,
  tilt: `<g class="rd-fx" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" opacity="0.85">
      <path d="M58 120 Q40 160 58 200"/><path d="M50 196 L58 204 L68 192"/><path d="M242 120 Q260 160 242 200"/><path d="M250 196 L242 204 L232 192"/></g>`,
  flick: `<g class="rd-fx rd-fx-burst" stroke="#ffe14a" stroke-width="8" stroke-linecap="round">
      <path d="M70 70 L44 52 M60 108 L28 104 M86 42 L72 16"/></g>`,
  yank: `<g class="rd-fx rd-fx-bite"><circle cx="232" cy="74" r="30" fill="#ff4d4d" stroke="#fff" stroke-width="5"/>
      <text x="232" y="90" text-anchor="middle" font-size="46" font-weight="900" fill="#fff" font-family="Impact, Arial Black, sans-serif">!</text></g>`,
  still: `<g class="rd-fx rd-fx-still" fill="none" stroke="#9be7ff" stroke-width="6"><circle cx="150" cy="150" r="128" stroke-dasharray="14 12"/></g>
      <text class="rd-fx rd-fx-still" x="150" y="34" text-anchor="middle" font-size="34" font-weight="900" fill="#9be7ff" font-family="Impact, Arial Black, sans-serif">FREEZE</text>`,
  raise: `<text class="rd-fx rd-fx-draw" x="244" y="70" text-anchor="middle" font-size="44" font-weight="900" fill="#3ddc5a" stroke="#0b0720" stroke-width="3" paint-order="stroke" font-family="Impact, Arial Black, sans-serif">DRAW!</text>`,
  pose: `<g class="rd-fx" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" opacity="0.8"><path d="M250 150 A100 100 0 0 1 150 250"/><path d="M160 238 L150 250 L164 262"/></g>`,
  aim: `<g class="rd-fx rd-fx-aim" fill="none" stroke="#ff4d4d" stroke-width="6"><circle cx="252" cy="70" r="30"/><circle cx="252" cy="70" r="12"/>
      <path d="M252 30 L252 46 M252 94 L252 110 M212 70 L228 70 M276 70 L292 70"/></g>`,
  cast: `<path class="rd-fx rd-fx-line" d="M150 52 Q200 -10 270 40 Q290 60 284 120" fill="none" stroke="#e8f4ff" stroke-width="4" stroke-dasharray="320" stroke-dashoffset="320"/>
      <circle class="rd-fx rd-fx-bob" cx="284" cy="124" r="10" fill="#ff4d4d" stroke="#fff" stroke-width="3"/>`,
};

const SCREEN: Record<RushDemo, string> = {
  shake: '<text x="150" y="160" text-anchor="middle" font-size="34" font-weight="900" fill="#fff" font-family="Impact, Arial Black, sans-serif">SHAKE</text>',
  tilt: '<circle class="rd-ball" cx="150" cy="150" r="16" fill="#fff"/>',
  flick: '<text x="150" y="162" text-anchor="middle" font-size="40" font-weight="900" fill="#fff" font-family="Impact, Arial Black, sans-serif">FLICK</text>',
  yank: '<text x="150" y="160" text-anchor="middle" font-size="38" font-weight="900" fill="#fff" font-family="Impact, Arial Black, sans-serif">YANK</text>',
  still: '<text x="150" y="160" text-anchor="middle" font-size="34" font-weight="900" fill="#fff" font-family="Impact, Arial Black, sans-serif">SHHH</text>',
  raise: '<text x="150" y="160" text-anchor="middle" font-size="40" font-weight="900" fill="#fff" font-family="Impact, Arial Black, sans-serif">UP!</text>',
  pose: '<path d="M150 110 L170 150 L130 150 Z" fill="#fff"/>',
  aim: '<circle cx="150" cy="146" r="18" fill="none" stroke="#fff" stroke-width="6"/><circle cx="150" cy="146" r="5" fill="#fff"/>',
  cast: '<text x="150" y="160" text-anchor="middle" font-size="38" font-weight="900" fill="#fff" font-family="Impact, Arial Black, sans-serif">CAST</text>',
};

/** Inline SVG markup of the looping gesture demo. */
export function demoSvg(demo: RushDemo | '', color: string): string {
  const d: RushDemo = demo && demo in FX ? demo : 'flick';
  return `<svg class="rd rd-${d}" viewBox="0 0 300 380" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <circle cx="150" cy="170" r="146" fill="${color}" opacity="0.18"/>
    ${FX[d]}
    ${rig(color, SCREEN[d])}
  </svg>`;
}
