/**
 * Procedural racer avatar: a chunky cartoon kart (side view, facing right) with a helmeted
 * driver, painted in the racer's roster colours, with a number badge in the player's slot colour.
 * Pure inline SVG — no image assets.
 */
import { getCharacter } from '../../kart/roster';
import { hex, shade, svgFrom } from './dom';

let uid = 0;

export function avatarMarkup(characterId: string, slotColor: string | null, opts: { label?: string } = {}): string {
  const c = getCharacter(characterId);
  const body = hex(c.color);
  const accent = hex(c.accent);
  const visor = hex(c.driverColor);
  const dark = shade(body, -0.45);
  const light = shade(body, 0.35);
  const id = `av${++uid}`;
  const badge = slotColor ?? accent;
  const label = opts.label ?? '';
  return `
<svg class="kp-avatar-svg" viewBox="0 0 160 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${light}"/><stop offset="0.55" stop-color="${body}"/><stop offset="1" stop-color="${dark}"/>
    </linearGradient>
    <radialGradient id="${id}h" cx="0.35" cy="0.3" r="0.8">
      <stop offset="0" stop-color="${shade(body, 0.55)}"/><stop offset="0.6" stop-color="${body}"/><stop offset="1" stop-color="${dark}"/>
    </radialGradient>
  </defs>
  <ellipse cx="80" cy="110" rx="62" ry="7" fill="rgba(0,0,0,0.28)"/>
  <!-- exhaust -->
  <rect x="10" y="74" width="16" height="9" rx="4" fill="#5b6070"/>
  <rect x="6" y="75" width="6" height="7" rx="3" fill="#2b2f3a"/>
  <!-- driver body + arm -->
  <path d="M58 70 Q60 46 78 46 Q96 46 98 70 Z" fill="${accent}"/>
  <path d="M86 60 Q102 60 112 70" stroke="${shade(accent, -0.25)}" stroke-width="9" stroke-linecap="round" fill="none"/>
  <!-- steering wheel -->
  <line x1="110" y1="74" x2="118" y2="58" stroke="#2b2f3a" stroke-width="5" stroke-linecap="round"/>
  <ellipse cx="118" cy="57" rx="4" ry="9" fill="none" stroke="#2b2f3a" stroke-width="4"/>
  <!-- kart body -->
  <path d="M14 86 Q14 66 36 66 L100 66 Q118 66 128 72 L150 80 Q156 83 154 90 L150 96 L20 96 Q14 96 14 86 Z"
        fill="url(#${id}b)" stroke="${shade(body, -0.6)}" stroke-width="3" stroke-linejoin="round"/>
  <path d="M30 78 L132 78 L146 84" stroke="${accent}" stroke-width="6" fill="none" stroke-linecap="round"/>
  <path d="M24 70 Q40 68 60 68" stroke="rgba(255,255,255,0.55)" stroke-width="3" fill="none" stroke-linecap="round"/>
  <!-- front bumper -->
  <rect x="144" y="86" width="12" height="10" rx="4" fill="#2b2f3a"/>
  <!-- number badge -->
  <circle cx="58" cy="85" r="10" fill="#fff" stroke="${badge}" stroke-width="4"/>
  <text x="58" y="90" text-anchor="middle" font-family="Impact, Arial Black, sans-serif" font-size="14" fill="#1a1a2e">${label}</text>
  <!-- wheels -->
  <g class="kp-wheel"><circle cx="40" cy="98" r="15" fill="#1d2029"/><circle cx="40" cy="98" r="7" fill="#c9ced9"/><circle cx="40" cy="98" r="3" fill="#5b6070"/></g>
  <g class="kp-wheel"><circle cx="128" cy="99" r="13" fill="#1d2029"/><circle cx="128" cy="99" r="6" fill="#c9ced9"/><circle cx="128" cy="99" r="2.5" fill="#5b6070"/></g>
  <!-- helmet -->
  <g class="kp-helmet">
    <circle cx="80" cy="34" r="25" fill="url(#${id}h)" stroke="${shade(body, -0.6)}" stroke-width="3"/>
    <path d="M58 26 Q80 6 102 26" stroke="${accent}" stroke-width="7" fill="none" stroke-linecap="round"/>
    <path d="M84 30 Q106 28 104 42 Q102 50 88 48 Q80 46 82 38 Z" fill="${shade(visor, -0.15)}" stroke="#1a1a2e" stroke-width="3"/>
    <path d="M90 33 Q98 32 99 37" stroke="rgba(255,255,255,0.8)" stroke-width="3" fill="none" stroke-linecap="round"/>
    <ellipse cx="68" cy="22" rx="7" ry="4" fill="rgba(255,255,255,0.45)" transform="rotate(-30 68 22)"/>
  </g>
</svg>`;
}

export function avatarSvg(characterId: string, slotColor: string | null, opts: { label?: string } = {}): SVGSVGElement {
  return svgFrom(avatarMarkup(characterId, slotColor, opts));
}

/** Avatar holder that only re-renders the SVG when the racer/colour actually changes. */
export class AvatarView {
  readonly root: HTMLDivElement;
  private key = '';

  constructor(cls = '') {
    this.root = document.createElement('div');
    this.root.className = `kp-avatar ${cls}`.trim();
  }

  set(characterId: string, slotColor: string | null, label = ''): void {
    const key = `${characterId}|${slotColor}|${label}`;
    if (key === this.key) return;
    this.key = key;
    this.root.replaceChildren(avatarSvg(characterId, slotColor, { label }));
  }
}
