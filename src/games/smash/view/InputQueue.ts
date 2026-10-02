/**
 * Phone fight-input packets -> per-frame SimInput.
 * Held bits are copied; press COUNTERS (0..255, wrapping) become queued one-frame press edges:
 * every counter increment yields exactly one `*Pressed` sim frame (two presses -> two frames).
 * The first packet after (re)connect / a new match only sets the baseline (no phantom presses).
 */
import type { DecodedFightInput } from '../../../net/protocol';
import { emptySimInput, type SimInput } from '../types';

type Btn = 'attack' | 'special' | 'jump' | 'grab' | 'shield';
const BTNS: readonly Btn[] = ['attack', 'special', 'jump', 'grab', 'shield'];
const MAX_QUEUED = 6;
/** Counter jumps larger than this are treated as a resync, not presses. */
const MAX_DELTA = 24;
/** No packet for this long = the phone reconnected: re-baseline. */
const STALE_MS = 3000;

export class InputQueue {
  private held: SimInput = emptySimInput();
  private baseline: Record<'attack' | 'special' | 'jump' | 'grab', number> | null = null;
  private readonly pending: Record<Btn, number> = { attack: 0, special: 0, jump: 0, grab: 0, shield: 0 };
  private shieldHeld = false;
  private lastPacketAt = -1e9;
  /** Number of attack presses seen since the last `takeAttackPresses()` (intro skip). */
  private attackTally = 0;

  /** Forget the counter baseline and any queued presses (new match / reconnect). */
  reset(): void {
    this.baseline = null;
    for (const b of BTNS) this.pending[b] = 0;
    this.held = emptySimInput();
    this.shieldHeld = false;
    this.attackTally = 0;
  }

  push(d: DecodedFightInput, nowMs: number): void {
    if (nowMs - this.lastPacketAt > STALE_MS) this.baseline = null;
    this.lastPacketAt = nowMs;
    const h = this.held;
    h.x = Number.isFinite(d.x) ? Math.max(-1, Math.min(1, d.x)) : 0;
    h.y = Number.isFinite(d.y) ? Math.max(-1, Math.min(1, d.y)) : 0;
    h.attack = !!d.attack;
    h.special = !!d.special;
    h.jump = !!d.jump;
    h.shield = !!d.shield;
    h.grab = !!d.grab;
    h.flick = !!d.flick;
    const counts = {
      attack: d.attackPresses & 255,
      special: d.specialPresses & 255,
      jump: d.jumpPresses & 255,
      grab: d.grabPresses & 255,
    };
    if (!this.baseline) {
      this.baseline = counts;
      this.shieldHeld = h.shield;
      return;
    }
    for (const k of ['attack', 'special', 'jump', 'grab'] as const) {
      const delta = (counts[k] - this.baseline[k] + 256) & 255;
      if (delta > 0 && delta <= MAX_DELTA) {
        this.pending[k] = Math.min(MAX_QUEUED, this.pending[k] + delta);
        if (k === 'attack') this.attackTally += delta;
      }
      this.baseline[k] = counts[k];
    }
    if (h.shield && !this.shieldHeld) this.pending.shield = Math.min(MAX_QUEUED, this.pending.shield + 1);
    this.shieldHeld = h.shield;
  }

  /** Input for the next sim frame: held state + at most one press edge per button. */
  next(out: SimInput): SimInput {
    const h = this.held;
    out.x = h.x;
    out.y = h.y;
    out.attack = h.attack;
    out.special = h.special;
    out.jump = h.jump;
    out.shield = h.shield;
    out.grab = h.grab;
    out.flick = h.flick;
    out.attackPressed = this.take('attack');
    out.specialPressed = this.take('special');
    out.jumpPressed = this.take('jump');
    out.grabPressed = this.take('grab');
    out.shieldPressed = this.take('shield');
    return out;
  }

  /** Drop queued presses (used while the sim is not consuming input, e.g. intro). */
  clearPending(): void {
    for (const b of BTNS) this.pending[b] = 0;
  }

  takeAttackPresses(): number {
    const n = this.attackTally;
    this.attackTally = 0;
    return n;
  }

  private take(b: Btn): boolean {
    if (this.pending[b] > 0) {
      this.pending[b]--;
      return true;
    }
    return false;
  }
}
