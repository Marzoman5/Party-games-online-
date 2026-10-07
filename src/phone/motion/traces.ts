/**
 * Synthetic, physically consistent motion traces for the motion self-test (scripts/motion-selftest.ts).
 *
 * A trace is an orientation path R(t) (columns = the phone's SCREEN axes expressed in the world frame:
 * X = player's right, Y = forward / toward the TV, Z = up) plus a world linear acceleration a(t).
 * Sensors are synthesised exactly like a phone measures them:
 *   accelerationIncludingGravity = Rᵀ (a + (0,0,9.81)),  acceleration = Rᵀ a,
 *   rotationRate = body angular velocity from R(t)ᵀ R(t+h) (deg/s),
 * then sensor noise, hand tremor, variable 50–100 Hz sample rates and timestamp jitter are added.
 * `toDevice` converts back to raw DEVICE-frame DOM readings (screen rotation, iOS sign flip) to test the
 * Normalizer too. Pure; no DOM.
 */
import type { RawMotion } from './index';
import type { DeviceMotionReading, V3 } from './processor';

export type M3 = number[]; // row-major 3x3

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const G = 9.81;

export function rotAxis(axis: V3, deg: number): M3 {
  const n = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const x = axis[0] / n, y = axis[1] / n, z = axis[2] / n;
  const a = deg * D2R;
  const c = Math.cos(a), s = Math.sin(a), C = 1 - c;
  return [
    c + x * x * C, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C,
  ];
}

export function mul(A: M3, B: M3): M3 {
  const o = new Array<number>(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) o[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
  return o;
}

/** Rᵀ v (world → screen/body). */
export function tmulv(R: M3, v: V3): V3 {
  return [
    R[0] * v[0] + R[3] * v[1] + R[6] * v[2],
    R[1] * v[0] + R[4] * v[1] + R[7] * v[2],
    R[2] * v[0] + R[5] * v[1] + R[8] * v[2],
  ];
}

/** Matrix from screen-axis columns (world coords). */
export function fromCols(x: V3, y: V3, z: V3): M3 {
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
}

export const WX: V3 = [1, 0, 0];
export const WY: V3 = [0, 1, 0];
export const WZ: V3 = [0, 0, 1];
/** Face up on a table / held flat, top edge toward the TV. */
export const R_FLAT: M3 = fromCols([1, 0, 0], [0, 1, 0], [0, 0, 1]);
/** Held upright in portrait, screen facing the player. */
export const R_UPRIGHT: M3 = fromCols([1, 0, 0], [0, 0, 1], [0, -1, 0]);
/** Hanging at the side, top edge pointing at the floor, screen facing forward. */
export const R_HOLSTER: M3 = fromCols([1, 0, 0], [0, 0, -1], [0, 1, 0]);

/** Pre-multiply by a world-axis rotation. */
export const turn = (R: M3, axis: V3, deg: number): M3 => mul(rotAxis(axis, deg), R);

const ease = (u: number): number => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, u)));

/** Piecewise orientation path: holds and eased world-axis rotations. */
export class Path {
  private segs: { t0: number; dur: number; R0: M3; axis: V3 | null; deg: number }[] = [];
  private cur: M3;
  duration = 0;
  constructor(R0: M3) {
    this.cur = R0;
  }
  hold(s: number): this {
    this.segs.push({ t0: this.duration, dur: s, R0: this.cur, axis: null, deg: 0 });
    this.duration += s;
    return this;
  }
  rot(axis: V3, deg: number, s: number): this {
    this.segs.push({ t0: this.duration, dur: s, R0: this.cur, axis, deg });
    this.cur = turn(this.cur, axis, deg);
    this.duration += s;
    return this;
  }
  at(t: number): M3 {
    for (const s of this.segs) {
      if (t < s.t0 + s.dur) {
        if (!s.axis) return s.R0;
        return turn(s.R0, s.axis, s.deg * ease((t - s.t0) / s.dur));
      }
    }
    return this.cur;
  }
}

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GenOpts {
  seed?: number;
  /** Sample rate range (Hz). */
  rate?: [number, number];
  /** White sensor noise (per axis, std): accel m/s², gyro deg/s. */
  accNoise?: number;
  gyroNoise?: number;
  /** Hand tremor (per axis, rough rms): accel m/s², gyro deg/s (6–11 Hz). */
  tremorAcc?: number;
  tremorGyro?: number;
  /** Device lacks `acceleration` (gravity must be estimated) / lacks a gyro. */
  noAcc?: boolean;
  noGyro?: boolean;
  /** Old Android: rotationRate in rad/s. */
  gyroRad?: boolean;
  /** Orientation wobble (world-axis rotations added on top of the path). */
  wobble?: { axis: V3; deg: number; hz: number; phase?: number }[];
  /** World linear acceleration (m/s²). */
  accel?: (t: number) => V3;
  /** Accelerometer range clip (m/s² per axis), e.g. 4 g. */
  clip?: number;
  /** Start time (ms). */
  t0?: number;
}

export interface TraceSample {
  t: number;
  raw: RawMotion;
  R: M3;
}

export function generate(path: Path | ((t: number) => M3), dur: number, o: GenOpts = {}): TraceSample[] {
  const rnd = rng(o.seed ?? 1);
  const gauss = (): number => {
    const u = Math.max(1e-9, rnd());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };
  const [rMin, rMax] = o.rate ?? [50, 100];
  const accN = o.accNoise ?? 0.02;
  const gyroN = o.gyroNoise ?? 0.08;
  const tA = o.tremorAcc ?? 0;
  const tG = o.tremorGyro ?? 0;
  // tremor: a few sinusoids per axis with random frequencies/phases
  const trem = [0, 1, 2, 3, 4, 5].map(() =>
    [0, 1, 2].map(() => ({ f: 6 + rnd() * 5, p: rnd() * 6.283, a: 0.5 + rnd() })),
  );
  const tremor = (set: number, t: number): number =>
    trem[set].reduce((s, c) => s + c.a * Math.sin(2 * Math.PI * c.f * t + c.p), 0) / 1.9;
  const base = typeof path === 'function' ? path : (t: number) => path.at(t);
  const Rat = (t: number): M3 => {
    let R = base(t);
    for (const w of o.wobble ?? []) R = turn(R, w.axis, w.deg * Math.sin(2 * Math.PI * w.hz * t + (w.phase ?? 0)));
    return R;
  };
  const out: TraceSample[] = [];
  let t = 0;
  const h = 0.001;
  while (t <= dur) {
    const R = Rat(t);
    const R2 = Rat(t + h);
    // body angular velocity: Rᵀ R2 ≈ I + [ω]× h
    const d = mul(transpose(R), R2);
    let wx = ((d[7] - d[5]) / (2 * h)) * R2D;
    let wy = ((d[2] - d[6]) / (2 * h)) * R2D;
    let wz = ((d[3] - d[1]) / (2 * h)) * R2D;
    const aw = o.accel ? o.accel(t) : ([0, 0, 0] as V3);
    const lin = tmulv(R, aw);
    const tr = (i: number): number => tA * tremor(i, t);
    const la: V3 = [lin[0] + tr(0) + accN * gauss(), lin[1] + tr(1) + accN * gauss(), lin[2] + tr(2) + accN * gauss()];
    const gB = tmulv(R, [0, 0, G]);
    let incl: V3 = [gB[0] + la[0], gB[1] + la[1], gB[2] + la[2]];
    if (o.clip) incl = incl.map((v) => Math.max(-o.clip!, Math.min(o.clip!, v))) as V3;
    wx += tG * tremor(3, t) + gyroN * gauss();
    wy += tG * tremor(4, t) + gyroN * gauss();
    wz += tG * tremor(5, t) + gyroN * gauss();
    const gs = o.gyroRad ? D2R : 1;
    out.push({
      t: (o.t0 ?? 1000) + t * 1000,
      R,
      raw: {
        gx: incl[0], gy: incl[1], gz: incl[2],
        ax: o.noAcc ? NaN : la[0], ay: o.noAcc ? NaN : la[1], az: o.noAcc ? NaN : la[2],
        rx: o.noGyro ? NaN : wx * gs, ry: o.noGyro ? NaN : wy * gs, rz: o.noGyro ? NaN : wz * gs,
      },
    });
    const hz = rMin + (rMax - rMin) * rnd();
    t += (1 / hz) * (0.85 + 0.3 * rnd()); // jitter
  }
  return out;
}

function transpose(A: M3): M3 {
  return [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
}

/** Concatenate traces (each re-timed to follow the previous one). */
export function concat(...parts: TraceSample[][]): TraceSample[] {
  const out: TraceSample[] = [];
  let off = 0;
  for (const p of parts) {
    if (!p.length) continue;
    const start = p[0].t;
    const shift = out.length ? out[out.length - 1].t + 12 - start : 0;
    for (const s of p) out.push({ ...s, t: s.t + shift + off });
  }
  return out;
}

/** One-cycle sine acceleration burst along `dir` (accelerate then brake: net velocity 0). */
export function burst(t0: number, dur: number, peak: number, dir: V3): (t: number) => V3 {
  const n = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  return (t) => {
    if (t < t0 || t > t0 + dur) return [0, 0, 0];
    const s = peak * Math.sin((2 * Math.PI * (t - t0)) / dur);
    return [(dir[0] / n) * s, (dir[1] / n) * s, (dir[2] / n) * s];
  };
}

/** Raised-cosine rotation-rate pulse: the path rotates `deg` about world `axis` between t0 and t0+dur. */
export function pulseRot(R0: M3, axis: V3, deg: number, t0: number, dur: number): (t: number) => M3 {
  return (t) => {
    if (t <= t0) return R0;
    if (t >= t0 + dur) return turn(R0, axis, deg);
    const u = (t - t0) / dur;
    // integral of 0.5(1 − cos 2πu) = u − sin(2πu)/(2π)
    return turn(R0, axis, deg * (u - Math.sin(2 * Math.PI * u) / (2 * Math.PI)));
  };
}

/** Raw DOM readings in the DEVICE frame for a screen rotated by `angleDeg`, optionally iOS-flipped. */
export function toDevice(
  s: TraceSample,
  angleDeg: number,
  iosFlip: boolean,
): { reading: DeviceMotionReading; beta: number; gamma: number } {
  const a = angleDeg * D2R;
  const c = Math.cos(a), sn = Math.sin(a);
  const inv = (v: V3): V3 => [v[0] * c + v[1] * sn, -v[0] * sn + v[1] * c, v[2]];
  const r = s.raw;
  const f = iosFlip ? -1 : 1;
  const incl = inv([r.gx, r.gy, r.gz]).map((v) => v * f) as V3;
  const acc = Number.isFinite(r.ax) ? (inv([r.ax, r.ay, r.az]).map((v) => v * f) as V3) : null;
  const rot = Number.isFinite(r.rx) ? inv([r.rx, r.ry, r.rz]) : null;
  // orientation from the true up vector (device frame)
  const up = inv(tmulv(s.R, [0, 0, 1]));
  const beta = Math.asin(Math.max(-1, Math.min(1, up[1]))) * R2D;
  const gamma = Math.atan2(-up[0], up[2]) * R2D;
  return { reading: { incl, acc, rot: rot ? { beta: rot[0], gamma: rot[1], alpha: rot[2] } : null }, beta, gamma };
}
