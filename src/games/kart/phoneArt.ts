/**
 * Inline-SVG illustration of the phone controller held sideways (landscape), mirroring the
 * phone layout: left half = steering zone; right side = big GAS, DRIFT/HOP, big ITEM,
 * small BRAKE/reverse; pause ⏸ top centre. Each zone has a `data-zone` for highlighting.
 */
export const PHONE_W = 900;
export const PHONE_H = 440;

export type Zone = 'steer' | 'gas' | 'drift' | 'item' | 'brake' | 'pause';

/** Anchor points (SVG coords) the tutorial callouts point at. */
export const ZONE_ANCHOR: Record<Zone, [number, number]> = {
  steer: [250, 230],
  gas: [762, 300],
  drift: [596, 330],
  item: [608, 160],
  brake: [778, 112],
  pause: [450, 70],
};

export function phoneMarkup(slotColor: string): string {
  return `
<svg class="kp-phone" viewBox="0 0 ${PHONE_W} ${PHONE_H}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="kpPhScreen" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1b1f3b"/><stop offset="1" stop-color="#0d0f22"/>
    </linearGradient>
    <linearGradient id="kpPhSteer" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${slotColor}" stop-opacity="0.32"/><stop offset="1" stop-color="${slotColor}" stop-opacity="0.08"/>
    </linearGradient>
    <radialGradient id="kpPhGas" cx="0.4" cy="0.35" r="0.75"><stop offset="0" stop-color="#7dffa0"/><stop offset="1" stop-color="#14a64a"/></radialGradient>
    <radialGradient id="kpPhItem" cx="0.4" cy="0.35" r="0.75"><stop offset="0" stop-color="#fff07a"/><stop offset="1" stop-color="#f0a400"/></radialGradient>
    <radialGradient id="kpPhDrift" cx="0.4" cy="0.35" r="0.75"><stop offset="0" stop-color="#9fd0ff"/><stop offset="1" stop-color="#5b3cf0"/></radialGradient>
    <radialGradient id="kpPhBrake" cx="0.4" cy="0.35" r="0.75"><stop offset="0" stop-color="#ff9a9a"/><stop offset="1" stop-color="#d42a3a"/></radialGradient>
  </defs>
  <!-- hands -->
  <g class="kp-hand kp-hand-l"><path d="M-30 200 Q20 150 70 190 L90 300 Q60 400 -30 420 Z" fill="#f2b98d" stroke="#b97a52" stroke-width="5"/></g>
  <g class="kp-hand kp-hand-r"><path d="M930 200 Q880 150 830 190 L810 300 Q840 400 930 420 Z" fill="#f2b98d" stroke="#b97a52" stroke-width="5"/></g>
  <!-- body -->
  <rect x="6" y="6" width="${PHONE_W - 12}" height="${PHONE_H - 12}" rx="64" fill="#11131f" stroke="#3a3f58" stroke-width="10"/>
  <rect x="40" y="30" width="${PHONE_W - 80}" height="${PHONE_H - 60}" rx="36" fill="url(#kpPhScreen)"/>
  <rect x="18" y="170" width="10" height="100" rx="5" fill="#2a2e44"/>
  <!-- steer zone -->
  <g class="kp-zone" data-zone="steer">
    <rect x="52" y="42" width="396" height="356" rx="28" fill="url(#kpPhSteer)" stroke="${slotColor}" stroke-opacity="0.65" stroke-width="4" stroke-dasharray="14 12"/>
    <text x="250" y="122" text-anchor="middle" class="kp-ph-label" fill="#ffffff" opacity="0.85">STEER</text>
    <path d="M110 230 l40 -34 v68 z" fill="#ffffff" opacity="0.7"/>
    <path d="M390 230 l-40 -34 v68 z" fill="#ffffff" opacity="0.7"/>
    <line x1="170" y1="230" x2="330" y2="230" stroke="#ffffff" stroke-opacity="0.35" stroke-width="8" stroke-linecap="round"/>
    <g class="kp-thumb"><circle cx="250" cy="230" r="40" fill="${slotColor}" stroke="#fff" stroke-width="6"/><circle cx="250" cy="230" r="14" fill="#fff" opacity="0.9"/></g>
  </g>
  <!-- pause -->
  <g class="kp-zone" data-zone="pause">
    <circle cx="450" cy="70" r="28" fill="#2a2e4a" stroke="#ffffff" stroke-opacity="0.6" stroke-width="4"/>
    <rect x="439" y="57" width="8" height="26" rx="2" fill="#fff"/><rect x="453" y="57" width="8" height="26" rx="2" fill="#fff"/>
  </g>
  <!-- brake -->
  <g class="kp-zone" data-zone="brake">
    <circle cx="778" cy="112" r="44" fill="url(#kpPhBrake)" stroke="#fff" stroke-width="5"/>
    <text x="778" y="121" text-anchor="middle" class="kp-ph-small" fill="#fff">BRAKE</text>
  </g>
  <!-- item -->
  <g class="kp-zone" data-zone="item">
    <circle class="kp-btn-face" cx="608" cy="160" r="74" fill="url(#kpPhItem)" stroke="#fff" stroke-width="6"/>
    <text x="608" y="148" text-anchor="middle" class="kp-ph-q" fill="#7a4a00">?</text>
    <text x="608" y="196" text-anchor="middle" class="kp-ph-label" fill="#5a3300">ITEM</text>
  </g>
  <!-- drift -->
  <g class="kp-zone" data-zone="drift">
    <rect class="kp-btn-face" x="512" y="282" width="170" height="96" rx="48" fill="url(#kpPhDrift)" stroke="#fff" stroke-width="6"/>
    <text x="597" y="343" text-anchor="middle" class="kp-ph-label" fill="#fff">DRIFT</text>
  </g>
  <!-- gas -->
  <g class="kp-zone" data-zone="gas">
    <circle class="kp-btn-face" cx="768" cy="300" r="86" fill="url(#kpPhGas)" stroke="#fff" stroke-width="6"/>
    <text x="768" y="314" text-anchor="middle" class="kp-ph-big" fill="#064a1e">GAS</text>
    <text x="768" y="350" text-anchor="middle" class="kp-ph-small" fill="#064a1e">AUTO</text>
  </g>
</svg>`;
}

export function tiltPhoneMarkup(): string {
  return `
<svg class="kp-tilt" viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <g class="kp-tilt-g">
    <rect x="10" y="18" width="100" height="48" rx="10" fill="#1b1f3b" stroke="#fff" stroke-width="4"/>
    <rect x="18" y="25" width="84" height="34" rx="5" fill="#3d8bff" opacity="0.6"/>
    <path d="M44 42 h32 M44 42 l8 -6 M44 42 l8 6 M76 42 l-8 -6 M76 42 l-8 6" stroke="#fff" stroke-width="4" stroke-linecap="round" fill="none"/>
  </g>
</svg>`;
}
