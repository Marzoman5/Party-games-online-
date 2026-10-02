/**
 * Inline-SVG illustration of the Smash Party FIGHTER controller held sideways (landscape),
 * mirroring the phone layout: floating analog stick on the left half; ATTACK (A) big, SPECIAL (B),
 * JUMP, SHIELD and GRAB on the right; pause in the top-right corner; your damage % + stocks at the
 * top centre. Each zone carries `class="kp-zone" data-zone` for the tutorial highlight.
 */
export const FPHONE_W = 900;
export const FPHONE_H = 440;

export type FighterZone = 'stick' | 'jump' | 'attack' | 'special' | 'shield' | 'goal' | 'pause';

/** Anchor points (SVG coords) the tutorial callouts point at. */
export const FIGHTER_ZONE_ANCHOR: Record<FighterZone, [number, number]> = {
  stick: [230, 262],
  jump: [782, 150],
  attack: [736, 304],
  special: [586, 348],
  shield: [596, 206],
  goal: [450, 92],
  pause: [842, 64],
};

export function fighterPhoneMarkup(slotColor: string): string {
  return `
<svg class="kp-phone kp-fphone" viewBox="0 0 ${FPHONE_W} ${FPHONE_H}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="spPhScreen" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#22163f"/><stop offset="1" stop-color="#0d0a22"/>
    </linearGradient>
    <linearGradient id="spPhStick" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${slotColor}" stop-opacity="0.3"/><stop offset="1" stop-color="${slotColor}" stop-opacity="0.06"/>
    </linearGradient>
    <radialGradient id="spPhA" cx="0.4" cy="0.35" r="0.75"><stop offset="0" stop-color="#ff9a8a"/><stop offset="1" stop-color="#e0283c"/></radialGradient>
    <radialGradient id="spPhB" cx="0.4" cy="0.35" r="0.75"><stop offset="0" stop-color="#9fd0ff"/><stop offset="1" stop-color="#2f62e8"/></radialGradient>
    <radialGradient id="spPhJ" cx="0.4" cy="0.35" r="0.75"><stop offset="0" stop-color="#9dffb4"/><stop offset="1" stop-color="#18a94c"/></radialGradient>
    <radialGradient id="spPhS" cx="0.4" cy="0.35" r="0.75"><stop offset="0" stop-color="#e2b8ff"/><stop offset="1" stop-color="#8a3df0"/></radialGradient>
    <radialGradient id="spPhG" cx="0.4" cy="0.35" r="0.75"><stop offset="0" stop-color="#fff07a"/><stop offset="1" stop-color="#f0a400"/></radialGradient>
  </defs>
  <!-- hands -->
  <g class="kp-hand kp-hand-l"><path d="M-30 200 Q20 150 70 190 L90 300 Q60 400 -30 420 Z" fill="#f2b98d" stroke="#b97a52" stroke-width="5"/></g>
  <g class="kp-hand kp-hand-r"><path d="M930 200 Q880 150 830 190 L810 300 Q840 400 930 420 Z" fill="#f2b98d" stroke="#b97a52" stroke-width="5"/></g>
  <!-- body -->
  <rect x="6" y="6" width="${FPHONE_W - 12}" height="${FPHONE_H - 12}" rx="64" fill="#11131f" stroke="#3a3f58" stroke-width="10"/>
  <rect x="40" y="30" width="${FPHONE_W - 80}" height="${FPHONE_H - 60}" rx="36" fill="url(#spPhScreen)"/>
  <rect x="18" y="170" width="10" height="100" rx="5" fill="#2a2e44"/>
  <!-- stick zone -->
  <g class="kp-zone" data-zone="stick">
    <rect x="52" y="120" width="380" height="278" rx="28" fill="url(#spPhStick)" stroke="${slotColor}" stroke-opacity="0.65" stroke-width="4" stroke-dasharray="14 12"/>
    <text x="242" y="160" text-anchor="middle" class="kp-ph-label" fill="#ffffff" opacity="0.85">MOVE</text>
    <circle cx="230" cy="262" r="78" fill="#ffffff" fill-opacity="0.08" stroke="#ffffff" stroke-opacity="0.45" stroke-width="5"/>
    <path d="M230 196 l-12 16 h24 z M230 328 l-12 -16 h24 z M164 262 l16 -12 v24 z M296 262 l-16 -12 v24 z" fill="#fff" opacity="0.55"/>
    <g class="kp-knob"><circle cx="230" cy="262" r="40" fill="${slotColor}" stroke="#fff" stroke-width="6"/><circle cx="230" cy="262" r="14" fill="#fff" opacity="0.9"/></g>
  </g>
  <!-- damage display -->
  <g class="kp-zone" data-zone="goal">
    <rect x="352" y="44" width="196" height="92" rx="22" fill="#000" fill-opacity="0.35" stroke="${slotColor}" stroke-width="4"/>
    <text x="450" y="108" text-anchor="middle" class="kp-ph-big kp-ph-pct" fill="#fff">42%</text>
    <circle cx="420" cy="124" r="6" fill="${slotColor}"/><circle cx="440" cy="124" r="6" fill="${slotColor}"/><circle cx="460" cy="124" r="6" fill="${slotColor}"/><circle cx="480" cy="124" r="6" fill="#555"/>
  </g>
  <!-- pause -->
  <g class="kp-zone" data-zone="pause">
    <circle cx="842" cy="64" r="24" fill="#2a2e4a" stroke="#ffffff" stroke-opacity="0.6" stroke-width="4"/>
    <rect x="833" y="53" width="7" height="22" rx="2" fill="#fff"/><rect x="845" y="53" width="7" height="22" rx="2" fill="#fff"/>
  </g>
  <!-- shield (+ grab: same step) -->
  <g class="kp-zone" data-zone="shield">
    <rect class="kp-btn-face" x="520" y="174" width="152" height="64" rx="32" fill="url(#spPhS)" stroke="#fff" stroke-width="5"/>
    <text x="596" y="216" text-anchor="middle" class="kp-ph-small" fill="#fff">SHIELD</text>
  </g>
  <g class="kp-zone" data-zone="shield">
    <circle class="kp-btn-face" cx="672" cy="96" r="38" fill="url(#spPhG)" stroke="#fff" stroke-width="5"/>
    <text x="672" y="104" text-anchor="middle" class="kp-ph-small" fill="#5a3300">GRAB</text>
  </g>
  <!-- jump -->
  <g class="kp-zone" data-zone="jump">
    <circle class="kp-btn-face" cx="782" cy="150" r="58" fill="url(#spPhJ)" stroke="#fff" stroke-width="6"/>
    <text x="782" y="160" text-anchor="middle" class="kp-ph-label" fill="#064a1e">JUMP</text>
  </g>
  <!-- special -->
  <g class="kp-zone" data-zone="special">
    <circle class="kp-btn-face" cx="586" cy="338" r="62" fill="url(#spPhB)" stroke="#fff" stroke-width="6"/>
    <text x="586" y="338" text-anchor="middle" class="kp-ph-big" fill="#fff">B</text>
    <text x="586" y="370" text-anchor="middle" class="kp-ph-small" fill="#fff">SPECIAL</text>
  </g>
  <!-- attack -->
  <g class="kp-zone" data-zone="attack">
    <circle class="kp-btn-face" cx="736" cy="304" r="84" fill="url(#spPhA)" stroke="#fff" stroke-width="6"/>
    <text x="736" y="306" text-anchor="middle" class="kp-ph-big" fill="#fff">A</text>
    <text x="736" y="346" text-anchor="middle" class="kp-ph-label" fill="#fff">ATTACK</text>
  </g>
</svg>`;
}
