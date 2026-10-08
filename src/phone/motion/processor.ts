/**
 * PURE motion processing (no DOM): platform normalisation (`Normalizer`) and every Party Rush detector
 * (`MotionProcessor`). Fed RawMotion samples in SCREEN coordinates + a millisecond clock, so it runs
 * unchanged in Node (scripts/motion-selftest.ts) and on the phone (sensors.ts).
 *
 * Frames: SCREEN coordinates, x right, y up (top edge), z out of the screen. `up` (the normalised
 * gravity-reaction vector) is what an accelerometer at rest reads: face-up ≈ (0, 0, 1).
 * All thresholds live in ./tuning.ts.
 */
import type { RushEvent, RushStream } from '../../net/protocol';
import type { MotionEvent, RawMotion } from './index';
import { MT } from './tuning';

export type V3 = [number, number, number];

const G = 9.81;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

const fin = (v: number): boolean => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const len = (x: number, y: number, z: number): number => Math.sqrt(x * x + y * y + z * z);
/** Exponential smoothing factor for a step of dt seconds with time constant tc. */
const k = (dt: number, tc: number): number => (tc <= 0 ? 1 : 1 - Math.exp(-dt / tc));

// ===========================================================================================
// Normalizer: raw DOM readings (DEVICE frame, platform conventions) -> RawMotion (SCREEN frame)
// ===========================================================================================

/** One devicemotion event as delivered (device frame, platform sign conventions, null = missing). */
export interface DeviceMotionReading {
  /** accelerationIncludingGravity. */
  incl: V3 | null;
  /** acceleration (without gravity). */
  acc: V3 | null;
  /** rotationRate: alpha = about device z, beta = about device x, gamma = about device y. */
  rot: { alpha: number; beta: number; gamma: number } | null;
}

/** World "up" in DEVICE coordinates from DeviceOrientation beta/gamma (W3C ZXY Euler). Alpha unused. */
export function upFromOrientation(betaDeg: number, gammaDeg: number): V3 {
  const b = betaDeg * D2R;
  const g = gammaDeg * D2R;
  return [-Math.sin(g) * Math.cos(b), Math.sin(b), Math.cos(b) * Math.cos(g)];
}

/** Rotate a DEVICE-frame vector into SCREEN coordinates for screen.orientation.angle `angleDeg`. */
export function deviceToScreen(v: V3, angleDeg: number): V3 {
  if (!angleDeg) return [v[0], v[1], v[2]];
  const a = angleDeg * D2R;
  const c = Math.cos(a);
  const s = Math.sin(a);
  // screen-right = (cos a, −sin a) and screen-up = (sin a, cos a) in device coordinates.
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
}

/**
 * Normalises devicemotion across platforms:
 * - accelerationIncludingGravity sign: Android/W3C reads +9.81 on z face-up, (older) iOS Safari reads
 *   −9.81. The initial guess comes from the platform (iOS → flip); whenever deviceorientation beta/gamma
 *   (whose convention IS consistent everywhere) is available, the sign is verified against it at runtime
 *   and corrected, so a wrong UA guess or a changed iOS behaviour heals itself within ~10 samples.
 * - `acceleration` (no gravity) sign: verified against accelerationIncludingGravity (|incl − acc| must
 *   be ≈ 9.81); corrected if the platform uses the opposite convention for it.
 * - Missing accelerationIncludingGravity: falls back to gravity from deviceorientation beta/gamma.
 * - Rotates everything into SCREEN coordinates using the screen orientation angle.
 * rotationRate units/sign are verified later by MotionProcessor (needs the gravity estimate).
 */
export class Normalizer {
  inclSign: number;
  private inclVote = 0;
  private accRel = 1;
  private accVote = 0;
  private up: V3 | null = null;
  private upT = -Infinity;

  constructor(isIOS: boolean) {
    this.inclSign = isIOS ? -1 : 1;
  }

  /** Feed a deviceorientation reading (degrees; null-safe). */
  orientation(beta: number | null, gamma: number | null, t: number): void {
    if (beta === null || gamma === null || !fin(beta) || !fin(gamma)) return;
    this.up = upFromOrientation(beta, gamma);
    this.upT = t;
  }

  /** True if a recent orientation-derived gravity exists (fallback source). */
  hasOrientation(t: number): boolean {
    return this.up !== null && t - this.upT < 500;
  }

  /** Convert one devicemotion reading. Returns null when it carries no usable gravity at all. */
  motion(d: DeviceMotionReading, angleDeg: number, t: number): RawMotion | null {
    let incl = d.incl && fin(d.incl[0]) && fin(d.incl[1]) && fin(d.incl[2]) ? d.incl : null;
    let acc = d.acc && fin(d.acc[0]) && fin(d.acc[1]) && fin(d.acc[2]) ? d.acc : null;
    const recentUp = this.up && t - this.upT < 500 ? this.up : null;
    if (!incl) {
      if (!recentUp) return null;
      // Orientation-only fallback: exact gravity, no linear acceleration information.
      incl = [recentUp[0] * G, recentUp[1] * G, recentUp[2] * G];
      acc = [0, 0, 0];
    } else {
      const m = len(incl[0], incl[1], incl[2]);
      if (recentUp && m > 1 && Math.abs(m - G) < 3) {
        const dot = (incl[0] * recentUp[0] + incl[1] * recentUp[1] + incl[2] * recentUp[2]) / m;
        this.inclVote += (dot - this.inclVote) * 0.1;
        if (this.inclVote > 0.5) this.inclSign = 1;
        else if (this.inclVote < -0.5) this.inclSign = -1;
      }
      const s = this.inclSign;
      incl = [incl[0] * s, incl[1] * s, incl[2] * s];
      if (acc) {
        const sa = s * this.accRel;
        acc = [acc[0] * sa, acc[1] * sa, acc[2] * sa];
        const am = len(acc[0], acc[1], acc[2]);
        if (am > 1.5) {
          const e1 = Math.abs(len(incl[0] - acc[0], incl[1] - acc[1], incl[2] - acc[2]) - G);
          const e2 = Math.abs(len(incl[0] + acc[0], incl[1] + acc[1], incl[2] + acc[2]) - G);
          this.accVote += ((e1 <= e2 ? 1 : -1) - this.accVote) * 0.1;
          if (this.accVote < -0.6) {
            // The platform reports `acceleration` with the opposite sign: flip it from now on.
            this.accRel = -this.accRel;
            this.accVote = 0;
            acc = [-acc[0], -acc[1], -acc[2]];
          }
        }
      }
    }
    const gi = deviceToScreen(incl, angleDeg);
    const ai: V3 = acc ? deviceToScreen(acc, angleDeg) : [NaN, NaN, NaN];
    const r = d.rot;
    const ri: V3 =
      r && fin(r.alpha) && fin(r.beta) && fin(r.gamma)
        ? deviceToScreen([r.beta, r.gamma, r.alpha], angleDeg)
        : [NaN, NaN, NaN];
    return { gx: gi[0], gy: gi[1], gz: gi[2], ax: ai[0], ay: ai[1], az: ai[2], rx: ri[0], ry: ri[1], rz: ri[2] };
  }
}

// ===========================================================================================
// MotionProcessor: filters + detectors
// ===========================================================================================

/** Pose axes (the `up` vector for each RUSH_POSES index). leftEdge = left edge points down → up = +x. */
const POSE_AXES: readonly V3[] = [
  [0, 0, 1], // 0 faceUp
  [0, 0, -1], // 1 faceDown
  [0, 1, 0], // 2 upright
  [0, -1, 0], // 3 upsideDown
  [1, 0, 0], // 4 leftEdge (left edge pointing down)
  [-1, 0, 0], // 5 rightEdge
];

/** Debug snapshot (window.__phone.motion.state(), selftest). */
export interface MotionDebug {
  up: V3;
  hasAcc: boolean;
  hasGyro: boolean;
  gyroK: number;
  gyroChecked: boolean;
  shakeEnergy: number;
  shakes: number;
  accRms: number;
  gyroRms: number;
  still: number;
  table: boolean;
  stillAccum: number;
  pose: number;
  poseConf: number;
  tilt: [number, number];
  pitch: number;
  aim: [number, number];
  lastActive: number;
}

export class MotionProcessor {
  // ---- config
  private stream: RushStream | null = null;
  private events = new Set<RushEvent>();
  private queue: MotionEvent[] = [];

  // ---- clock / availability
  lastT = -1;
  samples = 0;
  hasAcc = false;
  private gyroSeen = false;
  hasGyro = false;

  // ---- gyro units / sign self-check
  gyroK = 1;
  gyroChecked = false;
  private chkT = 0;
  private chkStart: V3 = [0, 0, 1];
  private chkP: V3 = [0, 0, 0];
  private chkDev = 0;
  private chkMP = 0;
  private chkPP = 0;
  private chkEvidence = 0;
  private prevGrDir: V3 = [0, 0, 1];

  // ---- filters
  private g: V3 = [0, 0, G];
  up: V3 = [0, 0, 1];
  private linBias: V3 = [0, 0, 0];
  lin: V3 = [0, 0, 0];
  private gyroBias: V3 = [0, 0, 0];
  private gyroLp: V3 = [0, 0, 0];
  w: V3 = [0, 0, 0];

  // ---- shake
  private shakePre = 0;
  shakeEnv = 0;
  shakes = 0;
  private lobe: V3 | null = null;
  private lobePeak = 0;
  private lobeLastCount = -Infinity;
  private lobeQuietFor = 0;

  // ---- flick
  private flickBase = 0;
  private flickState: 'idle' | 'burst' | 'refr' = 'idle';
  private flickOnset = 0;
  private flickPeak = 0;
  private flickThr: number = MT.FLICK_THR;
  private flickDir: V3 = [0, 0, 0];

  // ---- still / table / activity
  private accVar = 0;
  private gyroVar = 0;
  accRms = 0;
  gyroRms = 0;
  private accFloor: number = MT.STILL_ACC_FLOOR;
  private gyroFloor: number = MT.STILL_GYRO_FLOOR;
  still = 0;
  private tableFor = 0;
  table = false;
  stillAccum = 0;
  private handFor = 0;
  lastActive = -Infinity;

  // ---- pose
  private cand = -1;
  private candSince = 0;
  pose = -1;
  poseConf = 0;
  private poseEmitted = -1;
  private posePrevValid = -1;

  // ---- tilt
  private neutral: V3 | null = null;
  private neutralPending = true;
  private tiltR: V3 = [1, 0, 0];
  private tiltF: V3 = [0, 0, 1];
  tiltA = 0;
  tiltB = 0;

  // ---- pitch / raise
  pitchDeg = 0;
  private raiseState: 'idle' | 'holster' | 'armed' | 'rising' = 'idle';
  private raiseT = 0;

  // ---- aim
  aimYaw = 0;
  aimPitch = 0;

  // =========================================================================================== API

  configure(stream: RushStream | null, events: readonly RushEvent[]): void {
    this.stream = stream;
    this.events = new Set(events);
    this.queue.length = 0;
    // Counters / one-shot state restart for the new round.
    this.shakes = 0;
    this.lobe = null;
    this.stillAccum = 0;
    this.pose = -1;
    this.poseEmitted = -1;
    this.candSince = this.lastT < 0 ? 0 : this.lastT;
    this.raiseState = this.pitchDeg < MT.RAISE_LOW_DEG ? 'holster' : 'idle';
    this.raiseT = this.lastT < 0 ? 0 : this.lastT;
    this.flickState = 'idle';
    this.aimYaw = 0;
    this.aimPitch = 0;
  }

  calibrate(): void {
    this.setNeutral();
    this.aimYaw = 0;
    this.aimPitch = 0;
    this.stillAccum = 0;
    this.shakes = 0;
    this.lobe = null;
    this.tiltA = 0;
    this.tiltB = 0;
  }

  sample(): [number, number, number] {
    const r = (v: number): number => Math.round(clamp(fin(v) ? v : 0, -1000, 1000));
    switch (this.stream) {
      case 'shake':
        return [r(this.shakeEnergy()), r(Math.min(1000, this.shakes)), 0];
      case 'tilt':
        return [r(this.tiltA), r(this.tiltB), 0];
      case 'still':
        return [r(this.still), this.table ? 1 : 0, r(this.stillAccum / MT.STILL_ACCUM_SECONDS)];
      case 'pose':
        return [this.pose, r(this.poseConf), 0];
      case 'aim':
        return this.aimOut();
      case 'pitch':
        return [r(this.pitchDeg * 10), 0, 0];
      default:
        return [0, 0, 0];
    }
  }

  drain(): MotionEvent[] {
    return this.queue.splice(0);
  }

  activeSince(t: number): boolean {
    return this.lastActive >= t;
  }

  /** Queue an event directly (tests / injectGesture); respects the configured event set. */
  emit(k: RushEvent, v: number, x: number, y: number, t: number, force = false): void {
    if (force) this.lastActive = Math.max(this.lastActive, t);
    if (!force && !this.events.has(k)) return;
    this.queue.push({ k, v, x, y, t });
    if (this.queue.length > 64) this.queue.shift();
  }

  shakeEnergy(): number {
    const e = this.shakeEnv / MT.SHAKE_FULL;
    const kn = MT.SHAKE_KNEE;
    const c = e <= kn ? e : kn + (1 - kn) * (1 - Math.exp(-(e - kn) / (1 - kn)));
    return 1000 * c;
  }

  debug(): MotionDebug {
    const a = this.aimOut();
    return {
      up: [this.up[0], this.up[1], this.up[2]],
      hasAcc: this.hasAcc,
      hasGyro: this.hasGyro,
      gyroK: this.gyroK,
      gyroChecked: this.gyroChecked,
      shakeEnergy: Math.round(this.shakeEnergy()),
      shakes: this.shakes,
      accRms: this.accRms,
      gyroRms: this.gyroRms,
      still: Math.round(this.still),
      table: this.table,
      stillAccum: Math.round(this.stillAccum / MT.STILL_ACCUM_SECONDS),
      pose: this.pose,
      poseConf: Math.round(this.poseConf),
      tilt: [Math.round(this.tiltA), Math.round(this.tiltB)],
      pitch: Math.round(this.pitchDeg * 10),
      aim: [a[0], a[1]],
      lastActive: this.lastActive,
    };
  }

  // =========================================================================================== core

  /** Feed one sample (SCREEN frame, SI units, deg/s) taken at time `t` (ms, monotonic). */
  push(r: RawMotion, t: number): void {
    const first = this.lastT < 0;
    let dt = first ? 0.01 : (t - this.lastT) / 1000;
    dt = clamp(dt, MT.DT_MIN, MT.DT_MAX);
    this.lastT = first ? t : Math.max(t, this.lastT);
    this.samples++;

    let ix = r.gx, iy = r.gy, iz = r.gz;
    if (!fin(ix) || !fin(iy) || !fin(iz)) {
      ix = this.g[0];
      iy = this.g[1];
      iz = this.g[2];
    }
    const hasAcc = fin(r.ax) && fin(r.ay) && fin(r.az);
    this.hasAcc = hasAcc;
    const gyroFinite = fin(r.rx) && fin(r.ry) && fin(r.rz);
    if (gyroFinite && Math.abs(r.rx) + Math.abs(r.ry) + Math.abs(r.rz) > MT.GYRO_PRESENT) this.gyroSeen = true;
    const hasGyro = this.gyroSeen && gyroFinite;
    this.hasGyro = hasGyro;
    const rawW: V3 = hasGyro ? [r.rx, r.ry, r.rz] : [0, 0, 0];

    // ---- gravity: OS gravity (incl − acc) when available, else the low-passed incl; a gyro predicts.
    const gr: V3 = hasAcc ? [ix - r.ax, iy - r.ay, iz - r.az] : [ix, iy, iz];
    const grM = len(gr[0], gr[1], gr[2]);
    const inclM = len(ix, iy, iz);
    if (first) {
      this.g = grM > 1 ? [gr[0], gr[1], gr[2]] : [0, 0, G];
      this.prevGrDir = grM > 1 ? [gr[0] / grM, gr[1] / grM, gr[2] / grM] : [0, 0, 1];
      this.chkStart = this.prevGrDir;
    } else {
      const gk = this.gyroK;
      if (hasGyro) {
        // A world-fixed vector seen from the rotating phone: dv/dt = −ω × v.
        const wx = rawW[0] * gk * D2R, wy = rawW[1] * gk * D2R, wz = rawW[2] * gk * D2R;
        const [gx, gy, gz] = this.g;
        this.g = [gx - (wy * gz - wz * gy) * dt, gy - (wz * gx - wx * gz) * dt, gz - (wx * gy - wy * gx) * dt];
      }
      let tc = hasAcc ? MT.GRAV_TC_WITH_ACC : hasGyro ? MT.GRAV_TC_GYRO : MT.GRAV_TC_PLAIN;
      if (!hasAcc) tc *= 1 + 4 * Math.min(1, Math.abs(inclM - G) / MT.GRAV_DISTRUST_MS2);
      if (grM > 1) {
        const a = k(dt, tc);
        this.g = [this.g[0] + (gr[0] - this.g[0]) * a, this.g[1] + (gr[1] - this.g[1]) * a, this.g[2] + (gr[2] - this.g[2]) * a];
      }
      if (hasGyro && !this.gyroChecked && grM > 1) this.gyroCheck(gr, grM, inclM, rawW, dt);
    }
    const gm = len(this.g[0], this.g[1], this.g[2]) || 1;
    this.up = [this.g[0] / gm, this.g[1] / gm, this.g[2] / gm];
    const up = this.up;

    // ---- linear acceleration (high-passed) + gyro (calibrated, bias-corrected)
    const linRaw: V3 = hasAcc ? [r.ax, r.ay, r.az] : [ix - this.g[0], iy - this.g[1], iz - this.g[2]];
    if (first) this.linBias = [linRaw[0], linRaw[1], linRaw[2]];
    else {
      const a = k(dt, MT.LIN_HP_TC);
      for (let i = 0; i < 3; i++) this.linBias[i] += (linRaw[i] - this.linBias[i]) * a;
    }
    const lin: V3 = [linRaw[0] - this.linBias[0], linRaw[1] - this.linBias[1], linRaw[2] - this.linBias[2]];
    this.lin = lin;
    const linM = len(lin[0], lin[1], lin[2]);

    const gk = this.gyroK;
    const w: V3 = [rawW[0] * gk - this.gyroBias[0], rawW[1] * gk - this.gyroBias[1], rawW[2] * gk - this.gyroBias[2]];
    this.w = w;
    const wM = len(w[0], w[1], w[2]);
    if (hasGyro && wM < MT.GYRO_BIAS_GATE && this.accRms < 0.1) {
      const a = k(dt, MT.GYRO_BIAS_TC);
      for (let i = 0; i < 3; i++) this.gyroBias[i] = clamp(this.gyroBias[i] + w[i] * a, -MT.GYRO_BIAS_MAX, MT.GYRO_BIAS_MAX);
    }
    if (first) this.gyroLp = [w[0], w[1], w[2]];
    else {
      const a = k(dt, MT.GYRO_HP_TC);
      for (let i = 0; i < 3; i++) this.gyroLp[i] += (w[i] - this.gyroLp[i]) * a;
    }
    const wHpM = len(w[0] - this.gyroLp[0], w[1] - this.gyroLp[1], w[2] - this.gyroLp[2]);

    this.doShake(lin, linM, wM, hasGyro, dt, t);
    this.doFlick(lin, linM, wM, hasGyro, dt, t);
    this.doStill(linM, wHpM, hasGyro, dt, t, first);
    this.doPose(up, t);
    this.doTilt(up, dt);
    this.doPitch(up, t);
    this.doAim(w, up, hasGyro, dt);
  }

  // =========================================================================================== gyro check

  /**
   * Least-squares fit of the observed gravity-direction change against the change the gyro predicts
   * (assuming deg/s, right-handed): k ≈ 1 → fine; k ≈ 57 → the device reports rad/s; k < 0 → flipped.
   */
  private gyroCheck(gr: V3, grM: number, inclM: number, rawW: V3, dt: number): void {
    const d: V3 = [gr[0] / grM, gr[1] / grM, gr[2] / grM];
    const p = this.prevGrDir;
    const wx = rawW[0] * D2R, wy = rawW[1] * D2R, wz = rawW[2] * D2R;
    this.chkP[0] -= (wy * p[2] - wz * p[1]) * dt;
    this.chkP[1] -= (wz * p[0] - wx * p[2]) * dt;
    this.chkP[2] -= (wx * p[1] - wy * p[0]) * dt;
    this.prevGrDir = d;
    this.chkDev = Math.max(this.chkDev, Math.abs(inclM - G));
    this.chkT += dt;
    if (this.chkT < MT.GYROCHK_WINDOW) return;
    const m: V3 = [d[0] - this.chkStart[0], d[1] - this.chkStart[1], d[2] - this.chkStart[2]];
    const mM = len(m[0], m[1], m[2]);
    if (mM >= MT.GYROCHK_MIN_TURN && this.chkDev <= MT.GYROCHK_MAX_DEV) {
      this.chkMP += m[0] * this.chkP[0] + m[1] * this.chkP[1] + m[2] * this.chkP[2];
      this.chkPP += this.chkP[0] ** 2 + this.chkP[1] ** 2 + this.chkP[2] ** 2;
      this.chkEvidence += mM;
    }
    this.chkT = 0;
    this.chkDev = 0;
    this.chkStart = d;
    this.chkP = [0, 0, 0];
    if (this.chkEvidence >= MT.GYROCHK_EVIDENCE) {
      if (this.chkPP > 1e-12) {
        const kk = this.chkMP / this.chkPP;
        const ak = Math.abs(kk);
        if (ak > 0.4 && ak < 2.5) {
          this.gyroK = Math.sign(kk);
          this.gyroChecked = true;
        } else if (ak > 20 && ak < 150) {
          this.gyroK = Math.sign(kk) * R2D;
          this.gyroChecked = true;
        }
      }
      this.chkEvidence = 0;
      this.chkMP = 0;
      this.chkPP = 0;
    }
  }

  // =========================================================================================== shake

  private doShake(lin: V3, linM: number, wM: number, hasGyro: boolean, dt: number, t: number): void {
    const inten = Math.max(0, linM + (hasGyro ? wM * MT.SHAKE_GYRO_W : 0) - MT.SHAKE_FLOOR);
    this.shakePre += (inten - this.shakePre) * k(dt, MT.SHAKE_PRE_TC);
    const tc = this.shakePre > this.shakeEnv ? MT.SHAKE_ATTACK_TC : MT.SHAKE_RELEASE_TC;
    this.shakeEnv += (this.shakePre - this.shakeEnv) * k(dt, tc);

    // Half-cycle counter: a new "lobe" starts when the acceleration points against the previous lobe.
    if (linM < MT.SHAKE_COUNT_LO) {
      this.lobeQuietFor += dt;
      if (this.lobeQuietFor > MT.SHAKE_COUNT_FORGET) this.lobe = null;
    } else this.lobeQuietFor = 0;
    if (linM < MT.SHAKE_COUNT_HI) return;
    const dir: V3 = [lin[0] / linM, lin[1] / linM, lin[2] / linM];
    if (!this.lobe) {
      this.lobe = dir;
      this.lobePeak = linM;
      this.lobeLastCount = t;
      this.shakes++;
      return;
    }
    const along = lin[0] * this.lobe[0] + lin[1] * this.lobe[1] + lin[2] * this.lobe[2];
    if (along > 0) {
      if (linM > this.lobePeak) {
        this.lobe = dir;
        this.lobePeak = linM;
      }
    } else if (-along >= MT.SHAKE_COUNT_HI && t - this.lobeLastCount >= MT.SHAKE_COUNT_MIN_GAP * 1000) {
      this.lobe = dir;
      this.lobePeak = linM;
      this.lobeLastCount = t;
      this.shakes++;
    }
  }

  // =========================================================================================== flick

  private doFlick(lin: V3, linM: number, wM: number, hasGyro: boolean, dt: number, t: number): void {
    const thr = MT.FLICK_THR;
    const s = hasGyro ? linM / MT.FLICK_LIN_REF + wM / MT.FLICK_GYRO_REF : linM / MT.FLICK_LIN_REF_NOGYRO;
    if (this.flickState === 'idle') {
      const eff = Math.max(thr, MT.FLICK_BASE_K * this.flickBase);
      if (s >= eff) {
        this.flickState = 'burst';
        this.flickOnset = t;
        this.flickPeak = s;
        this.flickThr = eff;
        this.flickDir = [lin[0] * dt, lin[1] * dt, lin[2] * dt];
        return;
      }
      this.flickBase += (s - this.flickBase) * k(dt, MT.FLICK_BASE_TC);
      return;
    }
    if (this.flickState === 'burst') {
      if (s > this.flickPeak) {
        this.flickPeak = s;
        for (let i = 0; i < 3; i++) this.flickDir[i] += lin[i] * dt;
      }
      if (s < this.flickPeak * MT.FLICK_PEAK_FALL || t - this.flickOnset >= MT.FLICK_MAX_WAIT * 1000) {
        const v = Math.round(
          MT.FLICK_V_MIN + (100 - MT.FLICK_V_MIN) * clamp((this.flickPeak - this.flickThr) / (MT.FLICK_HARD_S - this.flickThr), 0, 1),
        );
        const d = this.flickDir;
        const dm = len(d[0], d[1], d[2]);
        const x = dm > 1e-6 ? Math.round((100 * d[0]) / dm) : 0;
        const y = dm > 1e-6 ? Math.round((100 * d[1]) / dm) : 0;
        this.lastActive = t;
        this.emit('flick', v, x, y, this.flickOnset);
        // Quick Draw: a `raise` is simply a quick snap of the phone from ANY grip (pointing the phone at the
        // floor first turned out to be confusing and awkward when sitting down).
        this.emit('raise', 0, 0, 0, this.flickOnset);
        this.flickState = 'refr';
      }
      return;
    }
    // refractory: wait the minimum time AND for the burst to die down
    if (t - this.flickOnset >= MT.FLICK_REFRACTORY * 1000 && s < MT.FLICK_REARM * this.flickThr) {
      this.flickState = 'idle';
      this.flickBase += (s - this.flickBase) * k(dt, MT.FLICK_BASE_TC);
    }
  }

  // =========================================================================================== still

  private doStill(linM: number, wHpM: number, hasGyro: boolean, dt: number, t: number, first: boolean): void {
    const a = first ? 1 : k(dt, MT.STILL_TC);
    this.accVar += (linM * linM - this.accVar) * a;
    this.gyroVar += (wHpM * wHpM - this.gyroVar) * a;
    this.accRms = Math.sqrt(this.accVar);
    this.gyroRms = hasGyro ? Math.sqrt(this.gyroVar) : 0;

    const tableNow = hasGyro
      ? this.gyroRms < MT.TABLE_GYRO && this.accRms < MT.TABLE_ACC
      : this.accRms < MT.TABLE_ACC_NOGYRO;
    this.tableFor = tableNow ? this.tableFor + dt : 0;
    this.table = this.tableFor >= MT.TABLE_HOLD;
    if (this.table) {
      // Learn this device's resting noise so a resting phone reads ≈ 0 movement.
      const fa = k(dt, 1);
      this.accFloor += (clamp(this.accRms * 1.25, MT.STILL_ACC_FLOOR, MT.STILL_FLOOR_MAX_ACC) - this.accFloor) * fa;
      if (hasGyro) this.gyroFloor += (clamp(this.gyroRms * 1.25, MT.STILL_GYRO_FLOOR, MT.STILL_FLOOR_MAX_GYRO) - this.gyroFloor) * fa;
    }
    const ma = Math.max(0, this.accRms - this.accFloor);
    const mv = hasGyro
      ? ma / MT.STILL_ACC_REF + Math.max(0, this.gyroRms - this.gyroFloor) / MT.STILL_GYRO_REF
      : ma / MT.STILL_ACC_REF_NOGYRO;
    this.still = this.table ? 0 : 1000 * (1 - Math.exp(-mv));
    this.stillAccum += this.still * dt;

    const hand = hasGyro
      ? this.gyroRms > MT.HAND_GYRO || this.accRms > MT.HAND_ACC_BIG
      : this.accRms > MT.HAND_ACC;
    this.handFor = hand ? this.handFor + dt : 0;
    if (this.handFor >= MT.HAND_HOLD) this.lastActive = t;
  }

  // =========================================================================================== pose

  private doPose(up: V3, t: number): void {
    let best = -1;
    let bestDot = -2;
    for (let i = 0; i < 6; i++) {
      const ax = POSE_AXES[i];
      const d = ax[0] * up[0] + ax[1] * up[1] + ax[2] * up[2];
      if (d > bestDot) {
        bestDot = d;
        best = i;
      }
    }
    const dotOf = (i: number): number => {
      const ax = POSE_AXES[i];
      return ax[0] * up[0] + ax[1] * up[1] + ax[2] * up[2];
    };
    let c = this.cand;
    if (c >= 0 && dotOf(c) >= Math.cos(MT.POSE_EXIT_DEG * D2R)) {
      // keep (hysteresis)
    } else c = bestDot >= Math.cos(MT.POSE_ENTER_DEG * D2R) ? best : -1;
    if (c !== this.cand) {
      this.cand = c;
      this.candSince = t;
    }
    if (c !== this.pose && t - this.candSince >= MT.POSE_HOLD * 1000) {
      // a change between two real poses means a hand moved it (the first acquisition doesn't count)
      if (c >= 0 && this.posePrevValid >= 0 && c !== this.posePrevValid) this.lastActive = t;
      if (c >= 0) this.posePrevValid = c;
      this.pose = c;
      if (c >= 0 && c !== this.poseEmitted) {
        this.poseEmitted = c;
        this.emit('pose', c, 0, 0, t);
      }
    }
    const c45 = Math.cos(45 * D2R);
    this.poseConf = this.pose >= 0 ? 1000 * clamp((dotOf(this.pose) - c45) / (1 - c45), 0, 1) : 0;
  }

  // =========================================================================================== tilt

  private setNeutral(): void {
    if (this.lastT < 0) {
      this.neutralPending = true;
      return;
    }
    this.neutralPending = false;
    const n = this.up;
    this.neutral = [n[0], n[1], n[2]];
    // right axis: screen x orthogonalised against the neutral up; fallback when the phone is on its edge
    let r: V3 = [1 - n[0] * n[0], -n[0] * n[1], -n[0] * n[2]];
    let rm = len(r[0], r[1], r[2]);
    if (rm < 0.35) {
      // n × (−y)
      r = [n[2], 0, -n[0]];
      rm = len(r[0], r[1], r[2]) || 1;
    }
    r = [r[0] / rm, r[1] / rm, r[2] / rm];
    // forward axis f = r × n: up leans toward f when the top edge tips away from the player
    const f: V3 = [r[1] * n[2] - r[2] * n[1], r[2] * n[0] - r[0] * n[2], r[0] * n[1] - r[1] * n[0]];
    this.tiltR = r;
    this.tiltF = f;
  }

  /** Right / forward tilt in degrees relative to the neutral. */
  tiltDeg(up: V3 = this.up): [number, number] {
    if (!this.neutral) return [0, 0];
    const r = this.tiltR, f = this.tiltF;
    const right = -Math.asin(clamp(up[0] * r[0] + up[1] * r[1] + up[2] * r[2], -1, 1)) * R2D;
    const fwd = Math.asin(clamp(up[0] * f[0] + up[1] * f[1] + up[2] * f[2], -1, 1)) * R2D;
    return [right, fwd];
  }

  private doTilt(up: V3, dt: number): void {
    if (this.neutralPending) this.setNeutral();
    const [ra, fa] = this.tiltDeg(up);
    const map = (d: number): number => {
      const dz = MT.TILT_DEADZONE_DEG;
      const m = Math.max(0, Math.abs(d) - dz) / (MT.TILT_FULL_DEG - dz);
      return Math.sign(d) * Math.min(1, m) * 1000;
    };
    const a = k(dt, MT.TILT_SMOOTH_TC);
    this.tiltA += (map(ra) - this.tiltA) * a;
    this.tiltB += (map(fa) - this.tiltB) * a;
  }

  // =========================================================================================== pitch / raise

  private doPitch(up: V3, t: number): void {
    this.pitchDeg = Math.asin(clamp(up[1], -1, 1)) * R2D;
    const p = this.pitchDeg;
    const low = MT.RAISE_LOW_DEG;
    switch (this.raiseState) {
      case 'idle':
        if (p < low) {
          this.raiseState = 'holster';
          this.raiseT = t;
        }
        break;
      case 'holster':
        if (p >= low) this.raiseState = 'idle';
        else if (t - this.raiseT >= MT.RAISE_HOLSTER * 1000) this.raiseState = 'armed';
        break;
      case 'armed':
        if (p >= low) {
          this.raiseState = 'rising';
          this.raiseT = t;
        }
        break;
      case 'rising':
        if (p > MT.RAISE_HIGH_DEG) {
          if (t - this.raiseT <= MT.RAISE_WINDOW * 1000) {
            this.lastActive = t;
            // Phones without a gyro can't see a pure wrist rotation as a flick: keep the classic
            // "point down, then raise" path for them.
            if (!this.hasGyro) this.emit('raise', 0, 0, 0, this.raiseT);
          }
          this.raiseState = 'idle';
        } else if (p < low) this.raiseState = 'armed';
        else if (t - this.raiseT > MT.RAISE_WINDOW * 1000) this.raiseState = 'idle';
        break;
    }
  }

  // =========================================================================================== aim

  private doAim(w: V3, up: V3, hasGyro: boolean, dt: number): void {
    if (!hasGyro) return;
    // yaw about world vertical (right turn = +x), pitch about the horizontal right axis (up = +y)
    const yawRate = -(w[0] * up[0] + w[1] * up[1] + w[2] * up[2]);
    let h: V3 = [1 - up[0] * up[0], -up[0] * up[1], -up[0] * up[2]];
    const hm = len(h[0], h[1], h[2]);
    h = hm > 0.3 ? [h[0] / hm, h[1] / hm, h[2] / hm] : [1, 0, 0];
    const pitchRate = w[0] * h[0] + w[1] * h[1] + w[2] * h[2];
    const decay = Math.exp(-dt / MT.AIM_DECAY_TC);
    const lim = MT.AIM_CLAMP_DEG;
    this.aimYaw = clamp((this.aimYaw + yawRate * dt) * decay, -lim, lim);
    this.aimPitch = clamp((this.aimPitch + pitchRate * dt) * decay, -lim, lim);
  }

  private aimOut(): [number, number, number] {
    let x: number, y: number;
    if (this.hasGyro) {
      x = this.aimYaw;
      y = this.aimPitch;
    } else {
      // No gyro: aim with tilt relative to the re-centre point (calibrate()).
      const [ra, fa] = this.tiltDeg();
      x = ra;
      y = -fa;
    }
    const s = 1000 / MT.AIM_FULL_DEG;
    return [Math.round(clamp(x * s, -1000, 1000)), Math.round(clamp(y * s, -1000, 1000)), 0];
  }
}
