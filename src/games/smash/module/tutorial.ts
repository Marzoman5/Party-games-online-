/**
 * Smash Party tutorial (host side). Index = `PhoneState.tutorial.step`; the phone shows its own
 * text for the same step (see docs/PARTY_HUB_CONTRACT.md "Smash Party tutorial steps").
 */
import type { TutorialDef, TutorialStepDef } from '../../../engine/GameModule';
import { getCharacter } from '../../../kart/roster';
import { FIGHTER_ZONE_ANCHOR, FPHONE_H, FPHONE_W, fighterPhoneMarkup } from './phoneArt';
import { hexColor } from './setup';

export const SMASH_STEP_MS = 4500;
/** First step stays up longer (everyone is still looking at their phone). */
export const SMASH_FIRST_STEP_MS = 7000;

/** A chunky procedural fighter silhouette in the character's colours (side view, facing right). */
export function fighterFigure(characterId: string, cls = ''): string {
  const c = getCharacter(characterId);
  const body = hexColor(c.color);
  const accent = hexColor(c.accent);
  return `<svg class="sh-fig ${cls}" viewBox="0 0 80 110" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <ellipse cx="40" cy="106" rx="22" ry="4" fill="rgba(0,0,0,.3)"/>
    <g class="sh-fig-legs"><rect x="27" y="70" width="11" height="32" rx="5" fill="${accent}" stroke="#120a2e" stroke-width="3"/>
    <rect x="42" y="70" width="11" height="32" rx="5" fill="${accent}" stroke="#120a2e" stroke-width="3"/></g>
    <rect x="20" y="38" width="40" height="40" rx="14" fill="${body}" stroke="#120a2e" stroke-width="3.5"/>
    <g class="sh-fig-arm"><rect x="44" y="44" width="30" height="11" rx="5.5" fill="${body}" stroke="#120a2e" stroke-width="3"/>
    <circle cx="74" cy="49.5" r="7" fill="#fff" stroke="#120a2e" stroke-width="3"/></g>
    <circle cx="40" cy="22" r="17" fill="${body}" stroke="#120a2e" stroke-width="3.5"/>
    <path d="M44 16 Q56 16 56 24 Q56 30 46 29 Z" fill="#fff" stroke="#120a2e" stroke-width="2.5"/>
    <path d="M26 10 Q40 0 54 10" stroke="${accent}" stroke-width="5" fill="none" stroke-linecap="round"/>
  </svg>`;
}

const fig = (id: string, cls = ''): string => `<div class="sh-demo-fig ${cls}">${fighterFigure(id)}</div>`;
const ground = '<div class="sh-demo-ground"></div>';

export const SMASH_STEPS: TutorialStepDef[] = [
  {
    zone: 'stick',
    label: 'PUSH',
    title: 'Move with the stick',
    sub: 'Put your thumb anywhere on the left side and push',
    demo: (r) => `<div class="sh-demo sh-demo-walk">${ground}${fig(r, 'sh-walk')}<div class="sh-demo-arrows">◀ ▶</div></div>`,
  },
  {
    zone: 'jump',
    label: 'JUMP ×2',
    title: 'JUMP — tap again in the air to double jump',
    sub: 'Tap JUMP (twice for a double jump)',
    demo: (r) => `<div class="sh-demo sh-demo-jump">${ground}${fig(r, 'sh-jump')}<div class="sh-demo-word sh-w1">JUMP!</div><div class="sh-demo-word sh-w2">AGAIN!</div></div>`,
  },
  {
    zone: 'attack',
    label: 'A',
    title: 'ATTACK — the stick picks the move',
    sub: 'Tap ATTACK. Flick the stick + ATTACK = SMASH attack (hold to charge)',
    demo: (r) => `<div class="sh-demo sh-demo-attack">${ground}${fig(r, 'sh-punch')}<div class="sh-burst">POW!</div><div class="sh-demo-tag">FLICK + A = SMASH</div></div>`,
  },
  {
    zone: 'special',
    label: 'B',
    title: 'SPECIAL — 4 special moves. UP + SPECIAL = recovery',
    sub: 'Tap SPECIAL with a direction. Fell off? UP + SPECIAL!',
    demo: (r) => `<div class="sh-demo sh-demo-special"><div class="sh-demo-ledge"></div>${fig(r, 'sh-recover')}<div class="sh-swirl"></div><div class="sh-demo-tag">▲ + B = BACK TO THE STAGE</div></div>`,
  },
  {
    zone: 'shield',
    label: 'HOLD',
    title: 'Hold SHIELD to block — + stick to dodge. GRAB to throw',
    sub: 'Hold SHIELD; tap GRAB near someone to grab & throw',
    demo: (r) => `<div class="sh-demo sh-demo-shield">${ground}${fig(r, 'sh-guard')}<div class="sh-bubble"></div><div class="sh-hit-spark">✦</div><div class="sh-demo-tag">BLOCKED!</div></div>`,
  },
  {
    zone: 'goal',
    label: '%',
    title: 'Push them off the stage — higher % = they fly farther!',
    sub: 'Hit them to raise their %, then smash them off the screen',
    demo: (r) =>
      `<div class="sh-demo sh-demo-goal"><div class="sh-demo-stage"></div>${fig(r, 'sh-launch')}<div class="sh-pct"><b>0%</b><b>48%</b><b>127%</b></div><div class="sh-ko-star">★</div><div class="sh-demo-tag sh-ko-tag">KO!</div></div>`,
  },
];

export const SMASH_TUTORIAL: TutorialDef = {
  steps: SMASH_STEPS,
  stepMs: SMASH_STEP_MS,
  firstStepMs: SMASH_FIRST_STEP_MS,
  phoneMarkup: fighterPhoneMarkup,
  phoneSize: [FPHONE_W, FPHONE_H],
  zoneAnchor: FIGHTER_ZONE_ANCHOR,
  tryItHint: 'Try it now: press JUMP or ATTACK on your phone!',
};
