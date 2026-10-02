/**
 * Multi-touch controller input: a relative-drag steering zone + hold buttons.
 *
 * Every pointer is tracked by id, independently: the steering finger and any
 * number of button fingers never interfere. Buttons use pointer capture so a
 * thumb that slides off DRIFT keeps drifting until it lifts. Packets are sent
 * at 60 Hz while active and immediately on every button edge.
 */
import { encodeInput, type DecodedInput } from '../net/protocol';
import { haptic } from './haptics';
import { net } from './net';
import { settings } from './settings';
import { tilt } from './tilt';

/** Fraction of the screen width a drag needs for full lock (at sensitivity 1). */
export const FULL_LOCK_FRAC = 0.22;
export const DEADZONE = 0.06;
export const CURVE = 1.35;
export const SMOOTH_TAU = 0.04;

/** Pure steering response: drag distance (px) -> -1..1. Exported for tests. */
export function steerResponse(dx: number, fullLockPx: number): number {
  const v = Math.max(-1, Math.min(1, dx / fullLockPx));
  const m = Math.max(0, Math.abs(v) - DEADZONE) / (1 - DEADZONE);
  return Math.sign(v) * Math.pow(m, CURVE);
}

/** Relative steering with a floating anchor: dragging past full lock drags the centre along. */
export class TouchSteer {
  pointerId: number | null = null;
  originX = 0;
  originY = 0;
  x = 0;
  y = 0;
  value = 0;

  down(id: number, x: number, y = 0): void {
    this.pointerId = id;
    this.originX = x;
    this.originY = y;
    this.x = x;
    this.y = y;
    this.value = 0;
  }

  move(x: number, fullLockPx: number, y = this.y): void {
    this.x = x;
    this.y = y;
    const dx = x - this.originX;
    if (Math.abs(dx) > fullLockPx) this.originX = x - Math.sign(dx) * fullLockPx;
    this.value = steerResponse(x - this.originX, fullLockPx);
  }

  up(): void {
    this.pointerId = null;
    this.value = 0;
  }

  get active(): boolean {
    return this.pointerId !== null;
  }
}

export type ButtonId = 'gas' | 'brake' | 'drift' | 'item';

export class Controls {
  readonly steer = new TouchSteer();
  /** Smoothed steering actually sent. */
  steerOut = 0;
  private held: Record<ButtonId, Set<number>> = {
    gas: new Set(),
    brake: new Set(),
    drift: new Set(),
    item: new Set(),
  };
  itemPresses = 0;
  seq = 0;
  /** Auto-accelerate allowed right now (gated during the countdown for the rocket start). */
  autoGate = true;
  /** Sending enabled (race / tutorial screens). */
  private active = false;
  private timer = 0;
  private lastStep = performance.now();
  lastInput: DecodedInput = {
    seq: 0,
    steer: 0,
    throttle: 0,
    brake: 0,
    drift: false,
    itemHeld: false,
    lookBack: false,
    itemPresses: 0,
  };
  /** Called after each packet so the UI can update knob/indicators. */
  onFrame: () => void = () => {};
  /** Button edge listeners (for UI press states). */
  onButton: (id: ButtonId, down: boolean) => void = () => {};

  isHeld(id: ButtonId): boolean {
    return this.held[id].size > 0;
  }

  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    clearInterval(this.timer);
    if (on) {
      this.lastStep = performance.now();
      this.timer = window.setInterval(() => this.send(), 1000 / 60);
    } else {
      this.releaseAll();
    }
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Forget every finger (screen change, app backgrounded, rotate overlay). */
  releaseAll(): void {
    this.steer.up();
    this.steerOut = 0;
    for (const id of Object.keys(this.held) as ButtonId[]) {
      if (this.held[id].size) {
        this.held[id].clear();
        this.onButton(id, false);
      }
    }
    if (this.active) this.send();
  }

  // ----- button binding ---------------------------------------------------

  bindButton(el: HTMLElement, id: ButtonId): void {
    const set = this.held[id];
    const release = (e: PointerEvent) => {
      if (!set.has(e.pointerId)) return;
      set.delete(e.pointerId);
      if (set.size === 0) {
        this.onButton(id, false);
        this.send();
      }
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic events */
      }
      const was = set.size > 0;
      set.add(e.pointerId);
      if (id === 'item') this.itemPresses = (this.itemPresses + 1) & 255;
      if (!was) {
        this.onButton(id, true);
        haptic('press');
      }
      this.send();
    });
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('lostpointercapture', release);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  bindSteerZone(el: HTMLElement): void {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      // A new finger in the zone takes over steering (forgiving if one got stuck).
      this.steer.down(e.pointerId, e.clientX, e.clientY);
      this.onFrame();
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.steer.pointerId) return;
      this.steer.move(e.clientX, this.fullLockPx(), e.clientY);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.steer.pointerId) return;
      this.steer.up();
      // Letting go = wheel straight, immediately (tilt mode glides back to the tilt value).
      if (!(settings.tilt && tilt.hasData)) this.steerOut = 0;
      this.send();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  fullLockPx(): number {
    const w = Math.max(window.innerWidth, 200);
    return (w * FULL_LOCK_FRAC) / settings.touchSensitivity;
  }

  // ----- packet ------------------------------------------------------------

  /** Target steering before smoothing: touch finger wins over tilt. */
  steerTarget(): number {
    if (this.steer.active) return this.steer.value;
    if (settings.tilt && tilt.hasData) return tilt.steer();
    return 0;
  }

  throttle(): number {
    if (this.isHeld('brake')) return 0;
    if (this.isHeld('gas')) return 1;
    return settings.autoAccelerate && this.autoGate ? 1 : 0;
  }

  /** Build + send one packet (also advances steering smoothing). */
  send(): void {
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0, (now - this.lastStep) / 1000));
    this.lastStep = now;
    const target = this.steerTarget();
    const k = 1 - Math.exp(-dt / SMOOTH_TAU);
    this.steerOut += (target - this.steerOut) * k;
    if (Math.abs(this.steerOut - target) < 0.004) this.steerOut = target;
    const inp: Omit<DecodedInput, 'seq'> = {
      steer: this.steerOut,
      throttle: this.throttle(),
      brake: this.isHeld('brake') ? 1 : 0,
      drift: this.isHeld('drift'),
      itemHeld: this.isHeld('item'),
      lookBack: false,
      itemPresses: this.itemPresses,
    };
    if (!this.active) return;
    this.seq = (this.seq + 1) >>> 0;
    const pkt = encodeInput(this.seq, inp);
    net.sendInput(pkt);
    this.lastInput = {
      seq: pkt[1],
      steer: pkt[2] / 100,
      throttle: pkt[3] / 100,
      brake: pkt[4] / 100,
      drift: inp.drift,
      itemHeld: inp.itemHeld,
      lookBack: false,
      itemPresses: pkt[6],
    };
    this.onFrame();
  }
}

export const controls = new Controls();
