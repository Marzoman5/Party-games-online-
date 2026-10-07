/**
 * DOM side of the phone motion pipeline: permission flow, devicemotion / deviceorientation listeners,
 * screen-orientation transform (via Normalizer), sample clock, and the MotionApi object.
 * All maths lives in ./processor.ts (pure, unit-tested by scripts/motion-selftest.ts).
 */
import type { RushEvent, RushStream } from '../../net/protocol';
import type { MotionApi, MotionEvent, RawMotion } from './index';
import { MotionProcessor, Normalizer, type MotionDebug, type V3 } from './processor';

type PermFn = () => Promise<'granted' | 'denied' | string>;
type WithPerm = { requestPermission?: PermFn };

const hasWindow = typeof window !== 'undefined';
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function screenAngle(): number {
  if (!hasWindow) return 0;
  const so = (screen as Screen & { orientation?: ScreenOrientation }).orientation;
  if (so && typeof so.angle === 'number') return so.angle;
  const wo = (window as unknown as { orientation?: number }).orientation;
  return typeof wo === 'number' ? wo : 0;
}

function isIOS(): boolean {
  if (!hasWindow || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS reports as a Mac with touch.
  if (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1) return true;
  const DME = typeof DeviceMotionEvent !== 'undefined' ? (DeviceMotionEvent as unknown as WithPerm) : null;
  return !!DME && typeof DME.requestPermission === 'function';
}

const vec = (o: DeviceMotionEventAcceleration | null | undefined): V3 | null =>
  o && o.x !== null && o.y !== null && o.z !== null ? [o.x, o.y, o.z] : null;

/** Debug view of the motion pipeline (window.__phone.motion.state() can surface it). */
export interface MotionState extends MotionDebug {
  supported: boolean;
  enabled: boolean;
  hasData: boolean;
  samples: number;
  inclSign: number;
}

export function createMotion(): MotionApi & { state(): MotionState } {
  const proc = new MotionProcessor();
  const norm = new Normalizer(isIOS());
  let listening = false;
  let enabled = false;
  let injected = false;
  let lastDataT = -Infinity;
  let lastSampleT = -1;
  let denied = false;
  let pending: Promise<boolean> | null = null;
  let dataWaiters: (() => void)[] = [];

  const supported = (): boolean =>
    injected ||
    (hasWindow &&
      window.isSecureContext === true &&
      (typeof DeviceMotionEvent !== 'undefined' || typeof DeviceOrientationEvent !== 'undefined'));

  /** Monotonic sample clock; batched events (same timestamp) are spread by the reported interval. */
  const stamp = (intervalMs: number): number => {
    let t = now();
    if (lastSampleT >= 0 && t - lastSampleT < 2) t = lastSampleT + (intervalMs > 0 && intervalMs < 100 ? intervalMs : 10);
    if (t <= lastSampleT) t = lastSampleT + 1;
    lastSampleT = t;
    return t;
  };

  const gotData = (): void => {
    lastDataT = now();
    if (dataWaiters.length) {
      const w = dataWaiters;
      dataWaiters = [];
      for (const f of w) f();
    }
  };

  const onMotion = (e: DeviceMotionEvent): void => {
    const incl = vec(e.accelerationIncludingGravity);
    const acc = vec(e.acceleration);
    const rr = e.rotationRate;
    const rot = rr && rr.alpha !== null && rr.beta !== null && rr.gamma !== null ? { alpha: rr.alpha, beta: rr.beta, gamma: rr.gamma } : null;
    // interval: ms per spec, but iOS Safari reports seconds
    let iv = typeof e.interval === 'number' && Number.isFinite(e.interval) ? e.interval : 0;
    if (iv > 0 && iv < 1) iv *= 1000;
    const t0 = now();
    // Desktop browsers fire all-null events; without devicemotion gravity the orientation handler drives.
    if (!incl) return;
    const raw = norm.motion({ incl, acc, rot }, screenAngle(), t0);
    if (!raw) return;
    proc.push(raw, stamp(iv));
    gotData();
  };

  let lastMotionT = -Infinity;
  const onMotionTracked = (e: DeviceMotionEvent): void => {
    if (e.accelerationIncludingGravity && e.accelerationIncludingGravity.x !== null) lastMotionT = now();
    onMotion(e);
  };

  const onOrientation = (e: DeviceOrientationEvent): void => {
    if (e.beta === null || e.gamma === null) return;
    const t = now();
    norm.orientation(e.beta, e.gamma, t);
    // Fallback: no devicemotion gravity → drive the processor from orientation alone.
    if (t - lastMotionT > 500) {
      const raw = norm.motion({ incl: null, acc: null, rot: null }, screenAngle(), t);
      if (raw) {
        proc.push(raw, stamp(0));
        gotData();
      }
    }
  };

  const listen = (): void => {
    if (listening || !hasWindow) return;
    listening = true;
    window.addEventListener('devicemotion', onMotionTracked);
    window.addEventListener('deviceorientation', onOrientation);
  };

  const waitForData = (ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (now() - lastDataT < 1000) return resolve(true);
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve(false);
      }, ms);
      dataWaiters.push(() => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(true);
      });
    });

  const doEnable = (): Promise<boolean> => {
    if (!supported()) return Promise.resolve(false);
    if (injected) return Promise.resolve(true);
    if (denied) return Promise.resolve(false);
    // iOS 13+: both prompts must START inside the user gesture → kick off both before awaiting.
    const DME = typeof DeviceMotionEvent !== 'undefined' ? (DeviceMotionEvent as unknown as WithPerm) : null;
    const DOE = typeof DeviceOrientationEvent !== 'undefined' ? (DeviceOrientationEvent as unknown as WithPerm) : null;
    const ask = (W: WithPerm | null): Promise<boolean> => {
      if (!W || typeof W.requestPermission !== 'function') return Promise.resolve(true);
      try {
        return W.requestPermission().then(
          (r) => r === 'granted',
          () => false,
        );
      } catch {
        return Promise.resolve(false);
      }
    };
    const pm = ask(DME);
    const po = ask(DOE);
    return Promise.all([pm, po]).then(async ([okM, okO]) => {
      if (!okM && !okO) {
        denied = true;
        return false;
      }
      listen();
      enabled = true;
      return waitForData(1500);
    });
  };

  const api = {
    get supported() {
      return supported();
    },
    get enabled() {
      return enabled || injected;
    },
    get hasData() {
      return injected || now() - lastDataT < 1000;
    },
    enable(): Promise<boolean> {
      if (injected) return Promise.resolve(true);
      if (enabled && now() - lastDataT < 1000) return Promise.resolve(true);
      if (pending) return pending;
      if (enabled) {
        // Listeners already attached (earlier attempt saw no data yet): just wait again.
        pending = waitForData(1500).finally(() => (pending = null));
        return pending;
      }
      pending = doEnable().finally(() => (pending = null));
      return pending;
    },
    configure(stream: RushStream | null, events: readonly RushEvent[]) {
      proc.configure(stream, events);
    },
    calibrate() {
      proc.calibrate();
    },
    sample(): [number, number, number] {
      return proc.sample();
    },
    drain(): MotionEvent[] {
      return proc.drain();
    },
    activeSince(t: number): boolean {
      return proc.activeSince(t);
    },
    inject(r: Partial<RawMotion>) {
      injected = true;
      const n = (v: number | undefined, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
      const up = proc.lastT >= 0 ? proc.up : ([0, 0, 1] as V3);
      const full: RawMotion = {
        gx: n(r.gx, up[0] * 9.81),
        gy: n(r.gy, up[1] * 9.81),
        gz: n(r.gz, up[2] * 9.81),
        ax: n(r.ax, NaN),
        ay: n(r.ay, NaN),
        az: n(r.az, NaN),
        rx: n(r.rx, 0),
        ry: n(r.ry, 0),
        rz: n(r.rz, 0),
      };
      if (Number.isFinite(full.ax) || Number.isFinite(full.ay) || Number.isFinite(full.az)) {
        full.ax = n(full.ax, 0);
        full.ay = n(full.ay, 0);
        full.az = n(full.az, 0);
      }
      proc.push(full, stamp(0));
      gotData();
    },
    injectGesture(k: RushEvent, v = 50, x = 0, y = 0) {
      injected = true;
      proc.emit(k, v, x, y, now(), true);
    },
    state(): MotionState {
      return {
        ...proc.debug(),
        supported: supported(),
        enabled: enabled || injected,
        hasData: injected || now() - lastDataT < 1000,
        samples: proc.samples,
        inclSign: norm.inclSign,
      };
    },
  };
  return api;
}
