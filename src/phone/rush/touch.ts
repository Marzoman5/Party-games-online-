/**
 * PARTY RUSH — touch fallback (no motion sensors, permission denied, desktop, or the player chose it).
 * Mirrors docs/PARTY_RUSH_CONTRACT.md "touch fallback" column. Pointer events, so it works with a finger
 * AND a mouse (Playwright). The whole surface (≥ half the screen) is the target — no small buttons.
 *
 *   shake  MASH button: a = energy from tap rate (smoothed, ~1000 at ~8 taps/s), b = taps since GO
 *   tilt   thumb pad: drag offset from where the finger landed → a right, b forward (up), springs back
 *   aim    thumb pad (sticky aim, next drag continues from it); a quick tap without dragging = `flick`
 *   still  press and hold: held + finger steady → a ≈ 0; released / drifting → movement; c accumulates
 *   pose   swipe ↑ upright, ↓ upside down, ← left edge, → right edge, tap face up, double tap face down
 *   pitch  a = −900 (holstered); a tap = `raise`
 *   else   tap anywhere = `flick` / `raise` / `tap` (whatever the round listens for)
 */
import type { RushEvent, RushStream } from '../../net/protocol';
import { h, setText, toggleClass } from '../ui';

export type TouchKind = 'mash' | 'pad' | 'aim' | 'hold' | 'pose' | 'tap';

export interface TouchEventOut {
  k: RushEvent;
  v: number;
  x: number;
  y: number;
  /** performance.now() of the finger landing (reaction timing). */
  t: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function touchKindFor(s: RushStream | null, ev: readonly RushEvent[]): TouchKind {
  if (s === 'shake') return 'mash';
  if (s === 'tilt') return 'pad';
  if (s === 'aim') return 'aim';
  if (s === 'still') return 'hold';
  if (s === 'pose' || ev.includes('pose')) return 'pose';
  return 'tap';
}

const SWIPE_PX = 34;
const DOUBLE_MS = 300;
const TAP_MOVE_PX = 14;
const FLICK_REFRACTORY_MS = 200;

export class TouchPad {
  readonly el: HTMLElement;
  kind: TouchKind = 'tap';
  private ev: RushEvent[] = [];
  private stream: RushStream | null = null;
  /** performance.now() of the last finger down (activity heartbeat). */
  lastTouchAt = 0;

  // pointer
  private pid: number | null = null;
  private sx = 0;
  private sy = 0;
  private st = 0;
  private lx = 0;
  private ly = 0;
  private moved = 0;
  private downAt = 0;

  // stream state
  private taps: number[] = [];
  private tapCount = 0;
  private energy = 0;
  private padA = 0;
  private padB = 0;
  private aimBaseA = 0;
  private aimBaseB = 0;
  private drift = 0;
  private stillA = 0;
  private stillC = 0;
  private pose = -1;
  private pendingTap = 0;
  private lastTapUp = 0;
  private lastFlick = 0;

  // visuals
  private knob: HTMLElement;
  private label: HTMLElement;
  private sub: HTMLElement;
  private face: HTMLElement;

  constructor(private readonly emit: (e: TouchEventOut) => void) {
    this.knob = h('div', { class: 'rt-knob' });
    this.label = h('div', { class: 'rt-label' });
    this.sub = h('div', { class: 'rt-sub' });
    this.face = h(
      'div',
      { class: 'rt-face' },
      h('i', { class: 'rt-arrow up', text: '↑' }),
      h('i', { class: 'rt-arrow down', text: '↓' }),
      h('i', { class: 'rt-arrow left', text: '←' }),
      h('i', { class: 'rt-arrow right', text: '→' }),
      this.knob,
      this.label,
    );
    this.el = h('div', { class: 'rz-touch', testid: 'rush-touch-pad' }, this.face, this.sub);
    this.el.addEventListener('pointerdown', (e) => this.down(e));
    this.el.addEventListener('pointermove', (e) => this.move(e));
    this.el.addEventListener('pointerup', (e) => this.up(e, false));
    this.el.addEventListener('pointercancel', (e) => this.up(e, true));
    this.el.addEventListener('lostpointercapture', (e) => this.up(e, true));
  }

  /** Choose the fallback for this round (keeps accumulators unless the kind changes). */
  configure(s: RushStream | null, ev: readonly RushEvent[]): void {
    const kind = touchKindFor(s, ev);
    this.ev = [...ev];
    this.stream = s;
    if (kind !== this.kind) {
      this.kind = kind;
      this.release();
      this.reset();
    }
    this.el.setAttribute('data-kind', kind);
    // The pad keeps its testid (rush-touch-pad); the mash button gets its own on the face.
    this.face.setAttribute('data-testid', kind === 'mash' ? 'rush-mash' : `rush-touch-${kind}`);
    const [label, sub] = this.copy();
    setText(this.label, label);
    setText(this.sub, sub);
  }

  private copy(): [string, string] {
    switch (this.kind) {
      case 'mash':
        return ['MASH!', 'tap as fast as you can'];
      case 'pad':
        return ['', 'drag your thumb to tilt'];
      case 'aim':
        return ['', 'drag to aim · tap to throw'];
      case 'hold':
        return ['HOLD', 'press & keep your thumb still'];
      case 'pose':
        return ['', 'swipe ↑ ↓ ← → · tap = face up · double tap = face down'];
      default:
        return ['TAP!', ''];
    }
  }

  /** At GO: zero counters + aim, forget the old pose. */
  reset(): void {
    this.taps = [];
    this.tapCount = 0;
    this.energy = 0;
    this.padA = this.padB = 0;
    this.aimBaseA = this.aimBaseB = 0;
    this.stillA = 0;
    this.stillC = 0;
    this.drift = 0;
    this.pose = -1;
    clearTimeout(this.pendingTap);
    this.pendingTap = 0;
    this.renderKnob();
  }

  /** Drop the finger (screen change, blur). */
  release(): void {
    this.pid = null;
    toggleClass(this.el, 'down', false);
    if (this.kind === 'pad') {
      this.padA = this.padB = 0;
      this.renderKnob();
    }
  }

  private radius(): number {
    const r = this.el.getBoundingClientRect();
    return Math.max(60, Math.min(r.width, r.height) * 0.32);
  }

  private down(e: PointerEvent): void {
    e.preventDefault();
    const now = performance.now();
    this.lastTouchAt = now;
    if (this.pid !== null && this.kind !== 'mash') return;
    this.pid = e.pointerId;
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic */
    }
    this.sx = this.lx = e.clientX;
    this.sy = this.ly = e.clientY;
    this.st = now;
    this.downAt = now;
    this.moved = 0;
    toggleClass(this.el, 'down', true);
    switch (this.kind) {
      case 'mash':
        this.taps.push(now);
        this.tapCount++;
        this.face.classList.remove('bump');
        void this.face.offsetWidth;
        this.face.classList.add('bump');
        if (this.ev.includes('flick')) this.flick(now);
        break;
      case 'aim':
        this.aimBaseA = this.padA;
        this.aimBaseB = this.padB;
        break;
      case 'tap':
        this.fireTap(now);
        break;
      default:
        break;
    }
  }

  private move(e: PointerEvent): void {
    if (e.pointerId !== this.pid) return;
    const dx = e.clientX - this.sx;
    const dy = e.clientY - this.sy;
    this.drift += Math.hypot(e.clientX - this.lx, e.clientY - this.ly);
    this.lx = e.clientX;
    this.ly = e.clientY;
    this.moved = Math.max(this.moved, Math.hypot(dx, dy));
    this.lastTouchAt = performance.now();
    if (this.kind === 'pad' || this.kind === 'aim') {
      const R = this.radius();
      const baseA = this.kind === 'aim' ? this.aimBaseA : 0;
      const baseB = this.kind === 'aim' ? this.aimBaseB : 0;
      this.padA = clamp(baseA + (dx / R) * 1000, -1000, 1000);
      this.padB = clamp(baseB - (dy / R) * 1000, -1000, 1000);
      this.renderKnob();
    }
  }

  private up(e: PointerEvent, cancel: boolean): void {
    if (e.pointerId !== this.pid) return;
    this.pid = null;
    toggleClass(this.el, 'down', false);
    const now = performance.now();
    const dx = e.clientX - this.sx;
    const dy = e.clientY - this.sy;
    if (this.kind === 'pad') {
      this.padA = this.padB = 0;
      this.renderKnob();
    } else if (this.kind === 'aim') {
      if (!cancel && this.moved < TAP_MOVE_PX && now - this.downAt < 350) this.flick(this.downAt);
    } else if (this.kind === 'pose' && !cancel) {
      const dist = Math.hypot(dx, dy);
      if (dist >= SWIPE_PX) {
        const p = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 5 : 4) : dy < 0 ? 2 : 3;
        this.setPose(p, this.st);
      } else if (this.pendingTap && now - this.lastTapUp < DOUBLE_MS) {
        clearTimeout(this.pendingTap);
        this.pendingTap = 0;
        this.setPose(1, this.st);
      } else {
        this.lastTapUp = now;
        const t = this.st;
        this.pendingTap = window.setTimeout(() => {
          this.pendingTap = 0;
          this.setPose(0, t);
        }, DOUBLE_MS);
      }
    }
  }

  private setPose(p: number, t: number): void {
    this.pose = p;
    this.el.setAttribute('data-pose', String(p));
    this.face.classList.remove('bump');
    void this.face.offsetWidth;
    this.face.classList.add('bump');
    if (this.ev.includes('pose') || this.stream === 'pose') this.emit({ k: 'pose', v: p, x: 0, y: 0, t });
  }

  private flick(t: number): void {
    if (t - this.lastFlick < FLICK_REFRACTORY_MS) return;
    this.lastFlick = t;
    this.emit({ k: 'flick', v: 60, x: 0, y: 100, t });
  }

  private fireTap(t: number): void {
    this.face.classList.remove('bump');
    void this.face.offsetWidth;
    this.face.classList.add('bump');
    if (this.ev.includes('flick')) this.flick(t);
    else if (this.ev.includes('raise')) this.emit({ k: 'raise', v: 0, x: 0, y: 0, t });
    else this.emit({ k: 'tap', v: 0, x: 0, y: 0, t });
  }

  private renderKnob(): void {
    const show = this.kind === 'pad' || this.kind === 'aim';
    // Knob travel = 38 % of the face size (CSS uses the custom properties).
    this.knob.style.setProperty('--kx', show ? (this.padA / 1000).toFixed(3) : '0');
    this.knob.style.setProperty('--ky', show ? (-this.padB / 1000).toFixed(3) : '0');
  }

  /** Current stream sample (call at 20 Hz). */
  sample(stream: RushStream | null): [number, number, number] {
    const now = performance.now();
    switch (stream) {
      case 'shake': {
        while (this.taps.length && now - this.taps[0] > 1000) this.taps.shift();
        const rate = this.taps.length; // taps in the last second
        const target = clamp((rate / 8) * 1000, 0, 1000);
        this.energy += (target - this.energy) * (target > this.energy ? 0.45 : 0.18);
        return [Math.round(this.energy), Math.min(1000, this.tapCount), 0];
      }
      case 'tilt':
        return [Math.round(this.padA), Math.round(this.padB), 0];
      case 'aim':
        return [Math.round(this.padA), Math.round(this.padB), 0];
      case 'still': {
        const held = this.pid !== null;
        const d = this.drift;
        this.drift = 0;
        let target = held ? clamp((d - 1.5) * 45, 0, 1000) : 650;
        if (held && now - this.downAt < 250) target = 0; // landing the thumb isn't "moving"
        this.stillA += (target - this.stillA) * 0.5;
        if (this.stillA < 8) this.stillA = 0;
        this.stillC = clamp(this.stillC + this.stillA / 60, 0, 1000);
        toggleClass(this.el, 'holding', held);
        setText(this.label, held ? (this.stillA > 120 ? 'STEADY!' : 'HOLDING ✓') : 'HOLD');
        return [Math.round(this.stillA), 0, Math.round(this.stillC)];
      }
      case 'pose':
        return [this.pose, this.pose >= 0 ? 1000 : 0, 0];
      case 'pitch':
        return [-900, 0, 0];
      default:
        return [0, 0, 0];
    }
  }
}
