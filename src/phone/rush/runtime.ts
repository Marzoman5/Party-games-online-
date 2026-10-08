/**
 * PARTY RUSH — phone-side runtime shared by the layout, the test hooks and the dev preview:
 * input mode (motion vs touch fallback), the ONE join tap, and send counters.
 */
import type { MgFromPhone, RushEvent } from '../../net/protocol';
import { motion } from '../motion/index';
import { net } from '../net';
import { lsGet, lsSet } from '../settings';
import { state } from '../store';
import { requestWakeLock } from '../system';
import { sfx, unlockAudio } from './sound';

const TOUCH_KEY = 'kp.rushTouch';

export const rush = {
  /** The join tap happened on this page load (audio unlocked, motion asked, wake lock wanted). */
  tapped: false,
  /** A join tap is waiting for the motion permission answer. */
  pending: false,
  /** motion.enable() resolved true. */
  motionOk: false,
  /** The player chose touch controls in the corner menu (persisted per phone). */
  manualTouch: lsGet(TOUCH_KEY) === '1',
  /** Counters for tests: stream packets sent, events sent by kind. */
  sent: { stream: 0, events: {} as Record<string, number>, act: 0, here: 0, away: 0, mode: 0, next: 0 },
  /** Last `mode` value sent (-1 = never). */
  modeSent: -1,
};

/** Touch-fallback mode: no sensors (HTTP, denied, desktop) or the player picked touch. */
export function touchMode(): boolean {
  return rush.manualTouch || !rush.motionOk;
}

export function rid(): number {
  return state.rush?.rid ?? 0;
}

/** Send a minigame-channel message (counts it for `__phone.getState().rushSent`). */
export function sendMg(m: Omit<MgFromPhone, 't' | 'rid'> & { rid?: number }): void {
  const msg: MgFromPhone = { t: 'mg', rid: m.rid ?? rid(), ...m } as MgFromPhone;
  net.send(msg);
  const k = msg.k;
  if (k === 'act' || k === 'here' || k === 'away' || k === 'mode' || k === 'next') rush.sent[k]++;
  else rush.sent.events[k] = (rush.sent.events[k] ?? 0) + 1;
}

export function countEvent(k: RushEvent): void {
  rush.sent.events[k] = (rush.sent.events[k] ?? 0) + 1;
}

/** Tell the host which input mode we use (only when it changed, or `force`). */
export function sendMode(force = false): void {
  const v = touchMode() ? 0 : 1;
  if (!force && v === rush.modeSent) return;
  rush.modeSent = v;
  sendMg({ k: 'mode', v });
}

const listeners = new Set<() => void>();
export function onRushRuntime(fn: () => void): void {
  listeners.add(fn);
}
function changed(): void {
  listeners.forEach((f) => f());
}

/**
 * THE join tap (also the "come back" tap). Runs inside the user gesture, in this order:
 * audio unlock → motion.enable() (iOS permission prompt needs the gesture, so it is called before any
 * await) → wake lock → then `mode` + `here` once the permission answer is known (or after a timeout).
 */
export function joinTap(): void {
  unlockAudio();
  const already = rush.motionOk || motion.enabled;
  let p: Promise<boolean>;
  try {
    p = rush.manualTouch && !already ? Promise.resolve(false) : motion.enable();
  } catch {
    p = Promise.resolve(false);
  }
  void requestWakeLock();
  rush.tapped = true;
  sfx('join');
  if (already) {
    rush.motionOk = true;
    finish();
    return;
  }
  rush.pending = true;
  let done = false;
  const settle = (ok: boolean) => {
    if (ok) rush.motionOk = true;
    if (done) {
      // Permission answered after we already fell back: upgrade silently.
      if (ok) {
        sendMode();
        changed();
      }
      return;
    }
    done = true;
    rush.pending = false;
    finish();
  };
  p.then(
    (ok) => settle(!!ok),
    () => settle(false),
  );
  // Never leave a tipsy player hanging on a permission prompt they ignored: fall back to touch.
  window.setTimeout(() => settle(false), 6000);
  changed();
}

function finish(): void {
  sendMode(true);
  sendMg({ k: 'here' });
  changed();
}

/**
 * Late upgrade (called from the layout's tick): some phones deliver their first sensor reading well after
 * the join tap (or the permission prompt was answered late). Once real data flows, switch to motion.
 */
export function pollMotion(): void {
  if (!rush.tapped || rush.motionOk || rush.manualTouch) return;
  if (motion.enabled && motion.hasData) {
    rush.motionOk = true;
    sendMode();
    changed();
  }
}

/** One human-readable line for the corner menu: is motion working on this phone, and if not, why. */
export function motionStatus(): string {
  if (rush.manualTouch) return 'Touch controls are switched on above';
  if (rush.motionOk && motion.hasData) return 'Motion sensors: working ✓';
  if (typeof window !== 'undefined' && !window.isSecureContext) return 'Motion is off: this page was opened with http, not https. Scan the QR code on the TV again.';
  if (!rush.tapped) return 'Motion sensors start when you tap to play';
  if (motion.enabled) return 'Motion is allowed, but this phone is sending no sensor data';
  return 'Motion was not allowed. Close this tab, scan the QR code again and tap Allow.';
}

/** Corner menu toggle. */
export function setManualTouch(on: boolean): void {
  rush.manualTouch = on;
  lsSet(TOUCH_KEY, on ? '1' : null);
  if (!on && !rush.motionOk && rush.tapped) {
    // Turning touch off: try the sensors again (we are inside the toggle tap = a user gesture).
    void motion.enable().then((ok) => {
      if (ok) rush.motionOk = true;
      sendMode();
      changed();
    });
  }
  sendMode();
  changed();
}

/** Test hook: injected sensor data means this phone "has sensors" (unless touch was chosen). */
export function noteInjected(): void {
  if (motion.enabled && !rush.motionOk) {
    rush.motionOk = true;
    if (rush.tapped) sendMode();
    changed();
  }
}
