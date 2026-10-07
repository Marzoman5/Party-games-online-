/**
 * PARTY RUSH — the triple cue: full-screen colour flash + phone sound + vibration (where supported).
 * iOS has no web vibration, so the flash + sound always stand on their own.
 */
import type { RushFx } from '../../net/protocol';
import { vibrate } from '../haptics';
import { sfx } from './sound';

const VIBE: Record<RushFx, number | number[]> = {
  none: 0,
  go: 160,
  good: [40, 50, 60],
  bad: [220, 70, 220],
  buzz: [70, 40, 70, 40, 70, 40, 160],
  boom: [400, 80, 200],
  tick: 25,
  win: [60, 50, 60, 50, 260],
};

/** Restart a CSS animation class on `el` (forces a reflow between remove and add). */
export function restartAnim(el: HTMLElement, cls: string): void {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

/**
 * Fire the triple cue on the flash overlay. `fx` picks the colours (CSS `.rz-flash[data-fx]`),
 * the blip and the vibration pattern.
 */
export function fireCue(flash: HTMLElement, fx: RushFx, strength = 0.5): void {
  if (fx === 'none') return;
  flash.setAttribute('data-fx', fx);
  restartAnim(flash, 'on');
  sfx(fx, strength);
  const v = VIBE[fx];
  if (v) vibrate(v);
}
