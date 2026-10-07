/**
 * Game logos / picker cards for the hub (title + lobby). Pure inline markup, no assets.
 */
import type { GameInfo } from '../../net/protocol';
import { esc } from './dom';

/** Small sticker logo for a game ("KART PARTY", "SMASH PARTY"). */
export function gameLogoMarkup(info: GameInfo): string {
  const [first, ...rest] = info.title.toUpperCase().split(' ');
  return `<div class="kp-glogo kp-glogo-${esc(info.id)}" style="--gc:${esc(info.color)}">
    <span class="kp-glogo-emoji" aria-hidden="true">${info.emoji}</span>
    <span class="kp-glogo-words"><span class="kp-glogo-a">${esc(first)}</span><span class="kp-glogo-b">${esc(rest.join(' '))}</span></span>
  </div>`;
}

/** Decorative background art for a game card. */
export function gameCardArt(id: string): string {
  if (id === 'rush') {
    return `<svg class="kp-gart" viewBox="0 0 200 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="10" y="100" width="180" height="10" rx="5" fill="#120a2e" opacity=".55"/>
      <polygon points="104,6 70,64 96,64 82,114 132,48 104,48 120,6" fill="#ffd23f" stroke="#120a2e" stroke-width="5" stroke-linejoin="round"/>
      <g transform="translate(26 30) rotate(-14)">
        <rect x="0" y="0" width="30" height="54" rx="7" fill="#120a2e"/>
        <rect x="4" y="6" width="22" height="40" rx="3" fill="#3ddc5a"/>
        <text x="15" y="31" text-anchor="middle" font-size="14">🐸</text>
      </g>
      <g transform="translate(146 24) rotate(16)">
        <rect x="0" y="0" width="30" height="54" rx="7" fill="#120a2e"/>
        <rect x="4" y="6" width="22" height="40" rx="3" fill="#3d8bff"/>
        <text x="15" y="31" text-anchor="middle" font-size="14">🦊</text>
      </g>
      <path d="M14 40 q-8 10 0 20 M8 34 q-12 16 0 32" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" opacity=".8"/>
      <path d="M186 34 q8 10 0 20 M192 28 q12 16 0 32" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" opacity=".8"/>
    </svg>`;
  }
  if (id === 'smash') {
    return `<svg class="kp-gart" viewBox="0 0 200 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <polygon points="100,8 114,42 152,30 128,60 170,74 124,80 136,114 100,90 64,114 76,80 30,74 72,60 48,30 86,42" fill="#ffd23f" stroke="#120a2e" stroke-width="5" stroke-linejoin="round"/>
      <rect x="10" y="98" width="180" height="12" rx="6" fill="#120a2e" opacity=".55"/>
      <rect x="40" y="92" width="120" height="10" rx="5" fill="#fff" opacity=".85"/>
      <text x="100" y="72" text-anchor="middle" font-family="Impact, Arial Black, sans-serif" font-size="30" fill="#ff4d5e" stroke="#120a2e" stroke-width="2">POW!</text>
    </svg>`;
  }
  return `<svg class="kp-gart" viewBox="0 0 200 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M0 96 Q100 70 200 96 L200 120 L0 120 Z" fill="#120a2e" opacity=".55"/>
      <path d="M10 104 Q100 80 190 104" stroke="#fff" stroke-width="4" stroke-dasharray="14 10" fill="none" opacity=".8"/>
      <g transform="translate(60 40)">
        <path d="M0 40 Q0 26 16 26 L64 26 Q76 26 84 32 L96 38 Q100 41 98 46 L94 50 L6 50 Q0 50 0 40 Z" fill="#ff3ab8" stroke="#120a2e" stroke-width="4"/>
        <circle cx="48" cy="14" r="14" fill="#2de2e6" stroke="#120a2e" stroke-width="4"/>
        <circle cx="20" cy="52" r="10" fill="#120a2e"/><circle cx="82" cy="52" r="9" fill="#120a2e"/>
      </g>
      <g stroke="#ffd23f" stroke-width="5" stroke-linecap="round"><line x1="20" y1="58" x2="48" y2="58"/><line x1="12" y1="72" x2="44" y2="72"/></g>
    </svg>`;
}
