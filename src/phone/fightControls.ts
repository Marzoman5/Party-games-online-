/**
 * Smash Party input engine: floating analog stick + face buttons -> FightInputPacket.
 *
 * - Floating stick: the base appears where the thumb lands; the knob travels one radius
 *   (R = settings.stickSize x screen height); past that the base is dragged along so
 *   reversing direction is always quick. Radial deadzone, analog x/y (y up).
 * - Flick: |v| goes from < FLICK_LOW to > FLICK_HIGH within FLICK_WINDOW_MS -> FBTN_FLICK
 *   is set for FLICK_HOLD_MS (ATTACK during that = smash attack). Tap-jump (setting): an
 *   upward flick also counts as a JUMP press.
 * - Buttons are hold bits + wrapping press counters (+1 per touch-down), so a mashed tap is
 *   never lost even if it starts and ends between two packets.
 * - Packets go out at 60 Hz while active and immediately on every edge.
 */
import { decodeFightInput, encodeFightInput, type DecodedFightInput } from '../net/protocol';
import { haptic } from './haptics';
import { net } from './net';
import { settings } from './settings';

export const STICK_DEADZONE = 0.12;
export const FLICK_LOW = 0.35;
export const FLICK_HIGH = 0.85;
export const FLICK_WINDOW_MS = 70;
export const FLICK_HOLD_MS = 120;
/** The base starts following the thumb once it is this many radii away. */
export const STICK_FOLLOW = 1.0;
/** How close to the zone edge the base may be centred (in radii). */
export const STICK_EDGE_MARGIN = 0.45;
/** Tap-jump counts an upward flick whose direction is within ~50 degrees of straight up. */
export const TAPJUMP_MIN_UP = 0.64;

export type FightButtonId = 'attack' | 'special' | 'jump' | 'shield' | 'grab';
export const FIGHT_BUTTONS: FightButtonId[] = ['attack', 'special', 'jump', 'shield', 'grab'];

/** Radial deadzone + rescale. Pure, exported for tests. */
export function applyDeadzone(rx: number, ry: number, dz = STICK_DEADZONE): { x: number; y: number; m: number } {
  const m = Math.hypot(rx, ry);
  if (m <= dz || m === 0) return { x: 0, y: 0, m: 0 };
  const mc = Math.min(1, m);
  const out = (mc - dz) / (1 - dz);
  return { x: (rx / m) * out, y: (ry / m) * out, m: out };
}

/** 8-way direction index (0 = right, 2 = up, 4 = left, 6 = down) or -1 when neutral. */
export function dir8(x: number, y: number): number {
  if (Math.hypot(x, y) < 0.01) return -1;
  const a = Math.atan2(y, x);
  return ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
}

export class FloatingStick {
  pointerId: number | null = null;
  /** Base centre (client px). */
  ox = 0;
  oy = 0;
  /** Finger (client px). */
  fx = 0;
  fy = 0;
  /** Raw normalised vector (|v| <= 1, y up). */
  rx = 0;
  ry = 0;
  radius = 56;
  /** [t, |v|] samples for flick detection. */
  private hist: [number, number][] = [];
  /** Set by move() when a flick was detected on this sample. */
  flicked = false;

  get active(): boolean {
    return this.pointerId !== null;
  }

  down(id: number, x: number, y: number, bounds: DOMRect | null, radius: number, now: number): void {
    this.pointerId = id;
    this.radius = Math.max(20, radius);
    let ox = x;
    let oy = y;
    if (bounds) {
      const m = this.radius * STICK_EDGE_MARGIN;
      ox = Math.max(bounds.left + m, Math.min(bounds.right - m, ox));
      oy = Math.max(bounds.top + m, Math.min(bounds.bottom - m, oy));
    }
    this.ox = ox;
    this.oy = oy;
    this.hist = [[now, 0]];
    this.flicked = false;
    this.move(x, y, now);
  }

  move(x: number, y: number, now: number): void {
    this.fx = x;
    this.fy = y;
    let dx = x - this.ox;
    let dy = y - this.oy;
    const d = Math.hypot(dx, dy);
    const R = this.radius;
    if (d > R * STICK_FOLLOW) {
      // Drag the base along behind the thumb.
      const k = (d - R * STICK_FOLLOW) / d;
      this.ox += dx * k;
      this.oy += dy * k;
      dx = x - this.ox;
      dy = y - this.oy;
    }
    let rx = dx / R;
    let ry = -dy / R;
    const m = Math.hypot(rx, ry);
    if (m > 1) {
      rx /= m;
      ry /= m;
    }
    this.rx = rx;
    this.ry = ry;
    const mag = Math.min(1, m);
    // Flick: was below LOW within the window, now above HIGH.
    this.flicked = false;
    if (mag > FLICK_HIGH) {
      for (const [t, v] of this.hist) {
        if (now - t <= FLICK_WINDOW_MS && v < FLICK_LOW) {
          this.flicked = true;
          break;
        }
      }
    }
    this.hist.push([now, mag]);
    while (this.hist.length > 2 && now - this.hist[0][0] > FLICK_WINDOW_MS + 40) this.hist.shift();
    if (this.flicked) this.hist = [[now, mag]]; // one flick per centre->edge motion
  }

  up(): void {
    this.pointerId = null;
    this.rx = 0;
    this.ry = 0;
    this.hist = [];
    this.flicked = false;
  }

  /** Deadzoned output. */
  out(): { x: number; y: number; m: number } {
    return applyDeadzone(this.rx, this.ry);
  }
}

export interface FightButtonGeom {
  id: FightButtonId;
  /** Centre + radius in client px. */
  x: number;
  y: number;
  r: number;
}

export class FightControls {
  readonly stick = new FloatingStick();
  private held: Record<FightButtonId, Set<number>> = {
    attack: new Set(),
    special: new Set(),
    jump: new Set(),
    shield: new Set(),
    grab: new Set(),
  };
  /** pointerId -> button for pointers that landed in the button zone. */
  private owner = new Map<number, FightButtonId>();
  presses = { attack: 0, special: 0, jump: 0, grab: 0 };
  seq = 0;
  flickUntil = 0;
  /** Tap-jump: the up-flick holds the jump bit until the stick comes back down. */
  private tapJumpHeld = false;
  private active = false;
  private timer = 0;
  /** Count of packets sent (tests / debug). */
  sent = 0;
  lastFightInput: DecodedFightInput = {
    seq: 0,
    x: 0,
    y: 0,
    attack: false,
    special: false,
    jump: false,
    shield: false,
    grab: false,
    flick: false,
    attackPresses: 0,
    specialPresses: 0,
    jumpPresses: 0,
    grabPresses: 0,
  };
  /** Button geometry provider (set by the layout) for forgiving hit-testing. */
  geometry: () => FightButtonGeom[] = () => [];
  /** Stick radius provider (px). */
  stickRadius: () => number = () => Math.max(window.innerHeight, 200) * settings.stickSize;
  onButton: (id: FightButtonId, down: boolean) => void = () => {};
  onFrame: () => void = () => {};
  /** Called when a flick is detected (visual feedback). */
  onFlick: () => void = () => {};

  isHeld(id: FightButtonId): boolean {
    return this.held[id].size > 0;
  }

  get isActive(): boolean {
    return this.active;
  }

  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    clearInterval(this.timer);
    if (on) {
      this.timer = window.setInterval(() => this.send(), 1000 / 60);
      this.send();
    } else {
      this.releaseAll();
    }
  }

  releaseAll(): void {
    this.stick.up();
    this.tapJumpHeld = false;
    this.flickUntil = 0;
    this.owner.clear();
    for (const id of FIGHT_BUTTONS) {
      if (this.held[id].size) {
        this.held[id].clear();
        this.onButton(id, false);
      }
    }
    this.onFrame();
    if (this.active) this.send();
  }

  // ----- buttons -----------------------------------------------------------

  /** Pick the button for a touch: inside a circle (+ slop), nearest by normalised distance. */
  pick(x: number, y: number): FightButtonId | null {
    let best: FightButtonId | null = null;
    let bestD = Infinity;
    for (const g of this.geometry()) {
      const d = Math.hypot(x - g.x, y - g.y);
      const reach = g.r + Math.max(12, g.r * 0.22);
      if (d > reach) continue;
      const nd = d / g.r;
      if (nd < bestD) {
        bestD = nd;
        best = g.id;
      }
    }
    return best;
  }

  press(id: FightButtonId, pointerId: number): void {
    const set = this.held[id];
    const was = set.size > 0;
    set.add(pointerId);
    this.owner.set(pointerId, id);
    // Only count presses that can be sent (no burst of stale presses after a reconnect).
    if (id !== 'shield' && this.active) this.presses[id] = (this.presses[id] + 1) & 255;
    if (!was) this.onButton(id, true);
    haptic('tick');
    this.send();
  }

  release(pointerId: number): void {
    const id = this.owner.get(pointerId);
    if (!id) return;
    this.owner.delete(pointerId);
    const set = this.held[id];
    set.delete(pointerId);
    if (set.size === 0) {
      this.onButton(id, false);
      this.send();
    }
  }

  /**
   * A touch in the button zone that misses every button but lands on the stick side of the
   * cluster (the dead gap between the zones) drives the stick instead.
   */
  private stickSideOfButtons(x: number): boolean {
    const g = this.geometry();
    if (!g.length) return false;
    if (settings.leftHanded) return x > Math.max(...g.map((b) => b.x + b.r * 1.25));
    return x < Math.min(...g.map((b) => b.x - b.r * 1.25));
  }

  private stickDown(e: PointerEvent, el: HTMLElement, bounds: DOMRect | null): void {
    e.preventDefault();
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    // A new thumb takes over (forgiving if one got stuck).
    this.stick.down(e.pointerId, e.clientX, e.clientY, bounds, this.stickRadius(), performance.now());
    this.afterStick();
  }

  private stickMove(e: PointerEvent): void {
    if (e.pointerId !== this.stick.pointerId) return;
    const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    if (evs.length > 1) {
      for (const c of evs) {
        this.stick.move(c.clientX, c.clientY, c.timeStamp || performance.now());
        if (this.stick.flicked) this.afterStick();
      }
    } else {
      this.stick.move(e.clientX, e.clientY, performance.now());
    }
    this.afterStick();
  }

  private stickUp(e: PointerEvent): boolean {
    if (e.pointerId !== this.stick.pointerId) return false;
    this.stick.up();
    this.tapJumpHeld = false;
    this.onFrame();
    this.send();
    return true;
  }

  /** The whole button zone captures touches; each lands on the nearest button. */
  bindButtonZone(el: HTMLElement): void {
    el.addEventListener('pointerdown', (e) => {
      const id = this.pick(e.clientX, e.clientY);
      if (!id) {
        if (this.stickSideOfButtons(e.clientX)) this.stickDown(e, el, null);
        return;
      }
      e.preventDefault();
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic */
      }
      // A recycled pointer id (stuck finger) -> drop the old hold first.
      if (this.owner.has(e.pointerId)) this.release(e.pointerId);
      this.press(id, e.pointerId);
    });
    el.addEventListener('pointermove', (e) => this.stickMove(e));
    const up = (e: PointerEvent) => {
      if (!this.stickUp(e)) this.release(e.pointerId);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  bindStickZone(el: HTMLElement): void {
    el.addEventListener('pointerdown', (e) => this.stickDown(e, el, el.getBoundingClientRect()));
    el.addEventListener('pointermove', (e) => this.stickMove(e));
    const end = (e: PointerEvent) => void this.stickUp(e);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private afterStick(): void {
    const s = this.stick;
    if (s.flicked) {
      s.flicked = false;
      this.flickUntil = performance.now() + FLICK_HOLD_MS;
      const m = Math.hypot(s.rx, s.ry) || 1;
      if (settings.tapJump && this.active && s.ry / m > TAPJUMP_MIN_UP) {
        this.presses.jump = (this.presses.jump + 1) & 255;
        this.tapJumpHeld = true;
      }
      this.onFlick();
      this.send();
    }
    if (this.tapJumpHeld && s.ry < 0.4) this.tapJumpHeld = false;
    this.onFrame();
  }

  // ----- packet ------------------------------------------------------------

  current(): Omit<DecodedFightInput, 'seq'> {
    const o = this.stick.out();
    return {
      x: o.x,
      y: o.y,
      attack: this.isHeld('attack'),
      special: this.isHeld('special'),
      jump: this.isHeld('jump') || this.tapJumpHeld,
      shield: this.isHeld('shield'),
      grab: this.isHeld('grab'),
      flick: performance.now() < this.flickUntil,
      attackPresses: this.presses.attack,
      specialPresses: this.presses.special,
      jumpPresses: this.presses.jump,
      grabPresses: this.presses.grab,
    };
  }

  send(): void {
    if (!this.active) return;
    this.seq = (this.seq + 1) >>> 0;
    const pkt = encodeFightInput(this.seq, this.current());
    if (net.sendInput(pkt)) this.sent++;
    this.lastFightInput = decodeFightInput(pkt) ?? this.lastFightInput;
  }
}

export const fightControls = new FightControls();
