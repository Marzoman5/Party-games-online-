/**
 * Per-slot human input channel. Persists across races (one per player slot) so
 * the phone's wrapping `itemPresses` counter is never mis-read.
 *
 * `itemPresses` is a 0..255 wrapping counter: every increment is one ITEM tap.
 * The first packet only initialises the counter. Increments are queued and
 * released ONE PER PHYSICS STEP, so quick double taps are never lost or merged.
 */
import type { HumanInput } from './api';
import type { InputState } from '../core/types';

const MAX_QUEUED_USES = 6;
/** A queued tap waits this long for the item to become usable (spin-out, roulette) before it is dropped. */
const PENDING_TTL = 0.6;

export function neutralHumanInput(): HumanInput {
  return { steer: 0, throttle: 0, brake: 0, drift: false, itemHeld: false, lookBack: false, itemPresses: 0 };
}

export class HumanInputChannel {
  readonly latest: HumanInput = neutralHumanInput();
  /** True once any packet arrived for this slot. */
  hasInput = false;
  private lastPresses = -1;
  private pendingUses = 0;
  private pendingAge = 0;

  /**
   * New packet. `acceptPresses` = the race is live (racing / finished); outside
   * of that the counter is tracked but taps are not queued.
   */
  receive(input: HumanInput, acceptPresses: boolean): void {
    const l = this.latest;
    l.steer = Number.isFinite(input.steer) ? Math.max(-1, Math.min(1, input.steer)) : 0;
    l.throttle = Number.isFinite(input.throttle) ? Math.max(0, Math.min(1, input.throttle)) : 0;
    l.brake = Number.isFinite(input.brake) ? Math.max(0, Math.min(1, input.brake)) : 0;
    l.drift = !!input.drift;
    l.itemHeld = !!input.itemHeld;
    l.lookBack = !!input.lookBack;
    const presses = (Number.isFinite(input.itemPresses) ? input.itemPresses : 0) & 255;
    l.itemPresses = presses;
    this.hasInput = true;
    if (this.lastPresses < 0) {
      this.lastPresses = presses;
      return;
    }
    const diff = (presses - this.lastPresses) & 255;
    this.lastPresses = presses;
    // A huge jump means the phone reloaded / counter reset: treat as re-init.
    if (diff === 0 || diff > 32) return;
    if (acceptPresses) {
      if (this.pendingUses === 0) this.pendingAge = 0;
      this.pendingUses = Math.min(MAX_QUEUED_USES, this.pendingUses + diff);
    }
  }

  /**
   * Once per physics step: consume one queued ITEM tap if the kart can use its
   * item right now. Taps wait up to PENDING_TTL for a usable moment (e.g. the
   * end of a spin-out); taps with no item to use are dropped.
   */
  takeUse(dt: number, hasItem: boolean, canUseNow: boolean): boolean {
    if (this.pendingUses <= 0) return false;
    if (!hasItem) {
      this.pendingUses = 0;
      return false;
    }
    if (!canUseNow) {
      this.pendingAge += dt;
      if (this.pendingAge > PENDING_TTL) this.pendingUses = 0;
      return false;
    }
    this.pendingUses--;
    this.pendingAge = 0;
    return true;
  }

  clearPending(): void {
    this.pendingUses = 0;
    this.pendingAge = 0;
  }

  /** Neutralise the analog state (e.g. new race) but keep the press counter. */
  resetAnalog(): void {
    const l = this.latest;
    l.steer = 0;
    l.throttle = 0;
    l.brake = 0;
    l.drift = false;
    l.itemHeld = false;
    l.lookBack = false;
    this.pendingUses = 0;
  }

  /** Write into a kart InputState. */
  writeTo(out: InputState, useItem: boolean): void {
    const l = this.latest;
    out.throttle = l.throttle;
    out.brake = l.brake;
    out.steer = l.steer;
    out.drift = l.drift;
    out.useItem = useItem;
    out.useItemHeld = l.itemHeld;
    out.lookBack = l.lookBack;
    out.pause = false;
    out.confirm = false;
    out.back = false;
    out.menuUp = false;
    out.menuDown = false;
    out.menuLeft = false;
    out.menuRight = false;
  }
}
