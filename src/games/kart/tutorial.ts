/**
 * Kart Party tutorial (6 steps: steer, gas, drift, item, brake, pause) — host side.
 * The phone shows its own text for the same step index (src/phone/screens/controller.ts).
 */
import type { TutorialDef, TutorialStepDef } from '../../engine/GameModule';
import { TUTORIAL_STEP_MS } from '../../engine/config';
import { avatarMarkup } from '../../party/ui/avatar';
import { PHONE_H, PHONE_W, ZONE_ANCHOR, phoneMarkup, tiltPhoneMarkup } from './phoneArt';

const kart = (racer: string, cls = ''): string => `<div class="kp-demo-kart ${cls}">${avatarMarkup(racer, null)}</div>`;

export const KART_STEPS: TutorialStepDef[] = [
  {
    zone: 'steer',
    label: 'DRAG ◀ ▶',
    title: 'Drag left / right to steer',
    sub: 'Use the whole left half of your phone',
    demo: () =>
      `<div class="kp-demo-tilt">${tiltPhoneMarkup()}<div class="kp-demo-note">Optional: turn on <b>tilt steering</b> in ⚙️ settings</div></div>`,
  },
  {
    zone: 'gas',
    label: 'GAS',
    title: 'Gas — auto‑accelerate is ON',
    sub: 'Your kart drives forward by itself. You just steer!',
    demo: (r) => `<div class="kp-demo-gas"><div class="kp-speedlines"><i></i><i></i><i></i><i></i></div>${kart(r)}</div>`,
  },
  {
    zone: 'drift',
    label: 'HOLD',
    title: 'Hold DRIFT through corners…',
    sub: 'Sparks go blue → orange → purple… let go for a BOOST!',
    demo: (r) =>
      `<div class="kp-demo-drift">${kart(r, 'kp-drifting')}<div class="kp-sparks"><i></i><i></i><i></i><i></i><i></i></div>
       <div class="kp-spark-legend"><span class="s1">BLUE</span><span class="s2">ORANGE</span><span class="s3">PURPLE</span></div>
       <div class="kp-boost-word">BOOST!</div></div>`,
  },
  {
    zone: 'item',
    label: 'TAP',
    title: 'Tap ITEM to use it',
    sub: 'Drive through ? boxes to grab BOUNCERS, BANANAS, TURBOS…',
    demo: (r) =>
      `<div class="kp-demo-item">${kart(r)}<div class="kp-orb"></div><div class="kp-banana">🍌</div>
       <div class="kp-item-tags"><span class="t1">BOUNCER</span><span class="t2">BANANA</span></div></div>`,
  },
  {
    zone: 'brake',
    label: 'BRAKE',
    title: 'Brake / reverse',
    sub: 'Hold it to back out of a wall',
    demo: (r) => `<div class="kp-demo-brake">${kart(r, 'kp-reversing')}<div class="kp-rev">◀ R</div></div>`,
  },
  {
    zone: 'pause',
    label: '⏸',
    title: 'Pause any time',
    sub: 'The leader can resume, restart or quit',
    demo: () => `<div class="kp-demo-pause"><div class="kp-pause-icon"><i></i><i></i></div></div>`,
  },
];

export const KART_TUTORIAL: TutorialDef = {
  steps: KART_STEPS,
  stepMs: TUTORIAL_STEP_MS,
  phoneMarkup,
  phoneSize: [PHONE_W, PHONE_H],
  zoneAnchor: ZONE_ANCHOR,
  tryItHint: 'Try it now: press DRIFT or ITEM on your phone!',
};
