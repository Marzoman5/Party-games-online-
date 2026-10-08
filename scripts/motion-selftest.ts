/**
 * Party Rush motion self-test: drives the PURE motion processor (src/phone/motion/processor.ts) with
 * synthetic, physically consistent sensor traces (src/phone/motion/traces.ts) — sensor noise, hand
 * tremor, variable 50–100 Hz rates + jitter, gravity-tilt variation, iOS/Android sign conventions,
 * rotated screens, phones without `acceleration` or without a gyro, rad/s gyros.
 *
 *   npx tsx scripts/motion-selftest.ts            # compact table, exit 1 on any failure
 *   npx tsx scripts/motion-selftest.ts --verbose  # every check
 */
import type { RushEvent, RushStream } from '../src/net/protocol';
import type { MotionEvent } from '../src/phone/motion/index';
import { MotionProcessor, Normalizer, type V3 } from '../src/phone/motion/processor';
import { MT } from '../src/phone/motion/tuning';
import {
  Path, R_FLAT, R_HOLSTER, R_UPRIGHT, WX, WY, WZ, burst, generate, pulseRot, toDevice, turn,
  type GenOpts, type M3, type TraceSample,
} from '../src/phone/motion/traces';

const verbose = process.argv.includes('--verbose');

// ------------------------------------------------------------------------------------------ harness
interface Row {
  test: string;
  variant: string;
  value: string;
  expect: string;
  ok: boolean;
}
const rows: Row[] = [];
function check(test: string, variant: string, ok: boolean, value: string | number, expect: string): void {
  rows.push({ test, variant, value: String(value), expect, ok });
}

type Via = 'direct' | 'ios' | 'iosOrient' | 'rot90';
interface Variant {
  name: string;
  gen: GenOpts;
  via: Via;
}
const V_ANDROID: Variant = { name: 'android', gen: {}, via: 'direct' };
const V_IOS: Variant = { name: 'ios-flip', gen: {}, via: 'ios' };
const V_IOS_ORIENT: Variant = { name: 'ios-flip+orient', gen: {}, via: 'iosOrient' };
const V_ROT90: Variant = { name: 'screen-rot90', gen: {}, via: 'rot90' };
const V_NOACC: Variant = { name: 'no-acc', gen: { noAcc: true }, via: 'direct' };
const V_NOGYRO: Variant = { name: 'no-gyro', gen: { noGyro: true }, via: 'direct' };
const V_SLOW: Variant = { name: 'android-50Hz', gen: { rate: [45, 55] }, via: 'direct' };
const ALL: Variant[] = [V_ANDROID, V_IOS, V_IOS_ORIENT, V_ROT90, V_NOACC, V_SLOW];

interface Run {
  p: MotionProcessor;
  ev: MotionEvent[];
  t0: number;
}

/**
 * Feed a trace. `calib` = seconds from the start at which calibrate() is called (default 0.6, after
 * the warm-up hold). `each` sees the processor after every sample.
 */
function run(
  s: TraceSample[],
  v: Variant,
  stream: RushStream | null,
  events: RushEvent[],
  each?: (p: MotionProcessor, sec: number) => void,
  calib: number[] = [0.6],
): Run {
  const p = new MotionProcessor();
  const norm = new Normalizer(v.via === 'ios');
  const t0 = s[0].t;
  p.configure(stream, events);
  const ev: MotionEvent[] = [];
  const cal = [...calib];
  for (const x of s) {
    if (v.via === 'direct') p.push(x.raw, x.t);
    else {
      const angle = v.via === 'rot90' ? 90 : 0;
      const flip = v.via === 'ios' || v.via === 'iosOrient';
      const d = toDevice(x, angle, flip);
      if (v.via !== 'ios') norm.orientation(d.beta, d.gamma, x.t);
      const raw = norm.motion(d.reading, angle, x.t);
      if (raw) p.push(raw, x.t);
    }
    const sec = (x.t - t0) / 1000;
    while (cal.length && sec >= cal[0]) {
      cal.shift();
      p.calibrate();
    }
    ev.push(...p.drain());
    each?.(p, sec);
  }
  return { p, ev, t0 };
}

const count = (ev: MotionEvent[], k: RushEvent): number => ev.filter((e) => e.k === k).length;
const mean = (a: number[]): number => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
let seed = 1;
const gen = (path: Path | ((t: number) => M3), dur: number, v: Variant, o: GenOpts = {}): TraceSample[] =>
  generate(path, dur, { seed: seed++, tremorAcc: 0.08, tremorGyro: 1.2, ...o, ...v.gen });

// ------------------------------------------------------------------------------------------ shake
function shakeTrace(v: Variant, hz: number, posAmp: number, wristDeg: number, dur: number, extra: GenOpts = {}): TraceSample[] {
  const w = 2 * Math.PI * hz;
  return gen(new Path(R_UPRIGHT).hold(0.6 + dur + 1), 0.6 + dur, v, {
    accel: (t) => (t < 0.6 ? [0, 0, 0] : [0.3 * -posAmp * w * w * Math.sin(w * (t - 0.6)), 0, -posAmp * w * w * Math.sin(w * (t - 0.6))]),
    wobble: [{ axis: WX, deg: wristDeg, hz }],
    ...extra,
  });
}
for (const v of [...ALL, V_NOGYRO]) {
  const gentle = run(shakeTrace(v, 2, 0.04, 8, 3), v, 'shake', ['flick']);
  const eG: number[] = [];
  const g2 = run(shakeTrace(v, 2, 0.04, 8, 3), v, 'shake', [], (p, s) => s > 1.6 && eG.push(p.sample()[0]));
  const hard: number[] = [];
  let envH = 0;
  let envG = 0;
  const h = run(shakeTrace(v, 5, 0.07, 20, 3, { clip: 78 }), v, 'shake', [], (p, s) => {
    if (s > 1.6) {
      hard.push(p.sample()[0]);
      envH += p.shakeEnv;
    }
  });
  run(shakeTrace(v, 2, 0.04, 8, 3), v, 'shake', [], (p, s) => s > 1.6 && (envG += p.shakeEnv));
  const mg = Math.round(mean(eG));
  const mh = Math.round(mean(hard));
  check('shake gentle energy', v.name, mg >= 500 && mg <= 950, mg, '500..950');
  const cg = g2.p.sample()[1];
  check('shake gentle count (12 half-cycles)', v.name, cg >= 9 && cg <= 15, cg, '9..15');
  const ratioRaw = envH / envG;
  const ratioOut = mh / mg;
  check('shake hard energy (compressed)', v.name, mh > mg + 50 && mh <= 1000 && ratioOut < 0.5 * ratioRaw, `${mh} (x${ratioOut.toFixed(1)} vs raw x${ratioRaw.toFixed(1)})`, '>gentle+50, gain < half raw');
  const ch = h.p.sample()[1];
  check('shake hard count (30 half-cycles)', v.name, ch >= 22 && ch <= 36, ch, '22..36');
  void gentle;
}

// ------------------------------------------------------------------------------------------ flick
/** Wrist flick at t=1.0: rotation (top edge forward) + accel burst. */
function flickPath(R0: M3, axis: V3, deg: number, dur: number, at = 1.0): (t: number) => M3 {
  return pulseRot(R0, axis, deg, at, dur);
}
const FLICKS = [
  { name: 'small', deg: -15, dur: 0.15, acc: 7, vMin: 15 },
  { name: 'medium', deg: -30, dur: 0.15, acc: 14, vMin: 25 },
  { name: 'hard', deg: -55, dur: 0.12, acc: 28, vMin: 50 },
];
for (const v of [...ALL, V_NOGYRO]) {
  const vs: number[] = [];
  for (const f of FLICKS) {
    // upright grip: top edge forward = rotation about world X (negative), hand moves forward (+Y)
    const s = gen(flickPath(R_UPRIGHT, WX, f.deg, f.dur), 2.2, v, { accel: burst(1.0, f.dur, f.acc, WY), clip: 78 });
    const r = run(s, v, null, ['flick']);
    const n = count(r.ev, 'flick');
    const e = r.ev.find((x) => x.k === 'flick');
    vs.push(e ? e.v : 0);
    check(`flick ${f.name} -> exactly 1`, v.name, n === 1 && !!e && e.v >= f.vMin, `${n} (v=${e ? e.v : '-'})`, `1, v>=${f.vMin}`);
    if (e) {
      const lat = e.t - (r.t0 + 1000);
      check(`flick ${f.name} onset latency`, v.name, lat >= 0 && lat <= 90, `${Math.round(lat)}ms`, '0..90ms');
    }
  }
  check('flick strength ordering', v.name, vs[0] <= vs[1] && vs[1] <= vs[2], vs.join('/'), 'small<=med<=hard');
  // flat grip, flick forward (toward the TV) → +y; sideways right → +x
  {
    const s = gen(flickPath(R_FLAT, WX, 15, 0.15), 2.2, v, { accel: burst(1.0, 0.15, 8, WY) });
    const e = run(s, v, null, ['flick']).ev.filter((x) => x.k === 'flick');
    check('flick dir forward (flat) -> +y', v.name, e.length === 1 && e[0].y > 50, e.length ? `x=${e[0].x} y=${e[0].y}` : 'none', 'y>50');
  }
  {
    const s = gen(flickPath(R_FLAT, WY, 15, 0.15), 2.2, v, { accel: burst(1.0, 0.15, 8, WX) });
    const e = run(s, v, null, ['flick']).ev.filter((x) => x.k === 'flick');
    check('flick dir right (flat) -> +x', v.name, e.length === 1 && e[0].x > 50, e.length ? `x=${e[0].x} y=${e[0].y}` : 'none', 'x>50');
  }
  // three small flicks 0.4 s apart → 3 (refractory does not swallow real flicks)
  {
    const pa = (t: number, t0: number, deg: number): number => {
      const u = Math.min(1, Math.max(0, (t - t0) / 0.15));
      return deg * (u - Math.sin(2 * Math.PI * u) / (2 * Math.PI));
    };
    const path = (t: number): M3 => turn(R_UPRIGHT, WX, pa(t, 1.0, -15) + pa(t, 1.4, 15) + pa(t, 1.8, -15));
    const acc = (t: number): V3 => {
      const a = burst(1.0, 0.15, 7, WY)(t), b = burst(1.4, 0.15, 7, [0, -1, 0])(t), c = burst(1.8, 0.15, 7, WY)(t);
      return [a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]];
    };
    const r = run(gen(path, 2.6, v, { accel: acc }), v, null, ['flick']);
    const n = count(r.ev, 'flick');
    check('3 small flicks 0.4s apart -> 3', v.name, n === 3, n, '3');
  }
  // NOT flicks: slow drift (40° over 2 s), slow walking
  {
    const s = gen(new Path(R_UPRIGHT).hold(1).rot(WX, -40, 2).hold(1), 4, v);
    const n = count(run(s, v, null, ['flick']).ev, 'flick');
    check('slow drift 40deg/2s -> no flick', v.name, n === 0, n, '0');
  }
  {
    const s = gen(new Path(turn(R_UPRIGHT, WX, -20)).hold(2).rot(WZ, 90, 3).hold(3), 8, v, {
      accel: (t) => [1.0 * Math.sin(2 * Math.PI * 0.9 * t), 0.8 * Math.sin(2 * Math.PI * 1.8 * t + 1), 2.4 * Math.sin(2 * Math.PI * 1.8 * t)],
      wobble: [
        { axis: WX, deg: 4, hz: 1.8 },
        { axis: WY, deg: 3, hz: 0.9 },
      ],
    });
    const n = count(run(s, v, null, ['flick']).ev, 'flick');
    check('walking 8s (incl. a turn) -> no flick', v.name, n === 0, n, '0');
  }
}

// ------------------------------------------------------------------------------------------ still / table
for (const v of [...ALL, V_NOGYRO]) {
  {
    const s = generate(new Path(R_FLAT).hold(4), 4, { seed: seed++, accNoise: 0.012, gyroNoise: 0.05, ...v.gen });
    const tbl: number[] = [];
    let b12 = 0;
    const r = run(s, v, 'still', [], (p, sec) => {
      const o = p.sample();
      if (sec > 2) tbl.push(o[0]);
      if (sec > 2.2 && o[1] === 1) b12++;
    });
    const a = Math.round(Math.max(...tbl));
    check('table: still a ~ 0', v.name, a <= 10, a, '<=10');
    check('table: b = 1 after ~1.2s', v.name, b12 > 0 && r.p.sample()[1] === 1, r.p.sample()[1], '1');
    check('table: activeSince false', v.name, !r.p.activeSince(r.t0), String(r.p.activeSince(r.t0)), 'false');
  }
  {
    const s = gen(new Path(turn(R_UPRIGHT, WX, -25)).hold(4), 4, v, { tremorAcc: 0.1, tremorGyro: 1.5 });
    const as: number[] = [];
    let b1 = 0;
    const r = run(s, v, 'still', [], (p, sec) => {
      const o = p.sample();
      if (sec > 1) {
        as.push(o[0]);
        if (o[1] === 1) b1++;
      }
    });
    const a = Math.round(mean(as));
    check('hand-held still: low non-zero a', v.name, a >= 15 && a <= 100, a, '15..100');
    check('hand-held still: never table', v.name, b1 === 0, b1, '0 samples');
    check('hand-held still: activeSince true', v.name, r.p.activeSince(r.t0), String(r.p.activeSince(r.t0)), 'true');
    const c = r.p.sample()[2];
    check('hand-held still: c accumulates', v.name, c > 0 && c < 60, c, '1..59 (mean a × 3.4s/15s)');
  }
  {
    // moving the phone around → big a, c grows
    const s = gen(new Path(R_UPRIGHT).hold(0.6).rot(WY, 30, 0.5).rot(WY, -30, 0.5).rot(WX, -20, 0.5).hold(0.5), 2.6, v, {
      accel: (t) => [1.5 * Math.sin(5 * t), 0, 1.0 * Math.sin(7 * t)],
    });
    const as: number[] = [];
    run(s, v, 'still', [], (p, sec) => sec > 0.8 && sec < 2.1 && as.push(p.sample()[0]));
    const a = Math.round(mean(as));
    check('moving: still a high', v.name, a >= 250, a, '>=250');
  }
}

// ------------------------------------------------------------------------------------------ pose
const POSE_R: M3[] = [
  R_FLAT, // faceUp
  turn(R_FLAT, WY, 180), // faceDown
  R_UPRIGHT, // upright
  turn(R_UPRIGHT, WY, 180), // upsideDown
  turn(R_UPRIGHT, WY, -90), // leftEdge (screen x → world up)
  turn(R_UPRIGHT, WY, 90), // rightEdge
];
const NAMES = ['faceUp', 'faceDown', 'upright', 'upsideDown', 'leftEdge', 'rightEdge'];
for (const v of [...ALL, V_NOGYRO]) {
  for (let i = 0; i < 6; i++) {
    const s = gen(new Path(POSE_R[i]).hold(2.5), 2.5, v, {
      wobble: [{ axis: i % 2 ? WX : WY, deg: 25, hz: 0.7, phase: 1.3 }],
    });
    const conf: number[] = [];
    const r = run(s, v, 'pose', ['pose'], (p, sec) => sec > 0.5 && conf.push(p.sample()[1]));
    const e = r.ev.filter((x) => x.k === 'pose');
    const st = r.p.sample()[0];
    check(`pose ${NAMES[i]} ±25° wobble`, v.name, e.length === 1 && e[0].v === i && st === i, `ev=${e.map((x) => x.v).join(',') || '-'} a=${st} conf~${Math.round(mean(conf))}`, `1 event v=${i}`);
  }
  // sequence with a brief pass: faceUp → (0.05 s upright) → faceDown → upright → leftEdge
  const path = new Path(R_FLAT).hold(1).rot(WX, 90, 0.2).hold(0.05).rot(WX, 90, 0.2).hold(1).rot(WX, -90, 0.35).hold(1).rot(WY, -90, 0.35).hold(1);
  const r = run(gen(path, path.duration, v), v, 'pose', ['pose']);
  const seq = r.ev.filter((x) => x.k === 'pose').map((x) => x.v);
  check('pose sequence, brief pass ignored', v.name, seq.join(',') === '0,1,2,4', seq.join(','), '0,1,2,4');
}

// ------------------------------------------------------------------------------------------ tilt
const TILT_GRIPS: { name: string; R: M3 }[] = [
  { name: 'flat-ish (30° up)', R: turn(R_FLAT, WX, 30) },
  { name: 'upright (leaning back 15°)', R: turn(R_UPRIGHT, WX, -15) },
];
for (const v of [...ALL, V_NOGYRO]) {
  for (const g of TILT_GRIPS) {
    const path = new Path(g.R).hold(1).rot(WY, 7.5, 0.3).hold(0.7).rot(WY, -7.5, 0.3).hold(0.5).rot(WX, -7.5, 0.3).hold(0.7);
    let aR = 0, bR = 0, aF = 0, bF = 0, a0 = 0;
    run(gen(path, path.duration, v), v, 'tilt', [], (p, sec) => {
      const o = p.sample();
      if (sec > 0.95 && sec < 1.0) a0 = o[0];
      if (sec > 1.9 && sec < 2.0) [aR, bR] = o;
      if (sec > 3.7 && sec < 3.8) [aF, bF] = o;
    });
    const ok0 = Math.abs(a0) < 40;
    check(`tilt ${g.name}: neutral at calibrate`, v.name, ok0, a0, '|a|<40');
    check(`tilt ${g.name}: 7.5° right`, v.name, Math.abs(aR - 474) < 90 && Math.abs(bR) < 90, `a=${aR} b=${bR}`, 'a≈+474 b≈0');
    check(`tilt ${g.name}: 7.5° forward`, v.name, Math.abs(bF - 474) < 90 && Math.abs(aF) < 90, `a=${aF} b=${bF}`, 'a≈0 b≈+474');
  }
}

// ------------------------------------------------------------------------------------------ pitch / raise
for (const v of [...ALL, V_NOGYRO]) {
  {
    const path = new Path(R_HOLSTER).hold(1).rot(WX, 90, 0.25).hold(1);
    let pDown = 0, pUp = 0;
    const r = run(gen(path, path.duration, v), v, 'pitch', ['raise'], (p, sec) => {
      if (sec > 0.8 && sec < 0.9) pDown = p.sample()[0];
      if (sec > 2.0) pUp = p.sample()[0];
    });
    const n = count(r.ev, 'raise');
    check('pitch stream holster / level', v.name, pDown < -820 && Math.abs(pUp) < 80, `${pDown} / ${pUp}`, '≈-900 / ≈0');
    const e = r.ev.find((x) => x.k === 'raise');
    const lat = e ? e.t - (r.t0 + 1000) : NaN;
    check('raise after holster -> 1', v.name, n === 1, `${n}${e ? ` (t+${Math.round(lat)}ms)` : ''}`, '1');
  }
  {
    const path = new Path(turn(R_HOLSTER, WX, 80)).hold(1).rot(WX, 35, 0.25).hold(1);
    const n = count(run(gen(path, path.duration, v), v, 'pitch', ['raise']).ev, 'raise');
    check('quick snap from any grip -> at most 1 raise', v.name, n <= 1, n, '0..1');
  }
  {
    const path = new Path(turn(R_HOLSTER, WX, 45)).hold(5);
    const n = count(run(gen(path, 5, v, { wobble: [{ axis: WX, deg: 9, hz: 0.5 }] }), v, 'pitch', ['raise']).ev, 'raise');
    check('slow wobble near -45° -> 0', v.name, n === 0, n, '0');
  }
  {
    const path = new Path(R_HOLSTER).hold(1).rot(WX, 90, 5).hold(0.5);
    const n = count(run(gen(path, path.duration, v), v, 'pitch', ['raise']).ev, 'raise');
    check('very slow raise (5s) -> 0', v.name, n === 0, n, '0');
  }
  {
    // two draws: holster, raise, holster again, raise again → 2
    const path = new Path(R_HOLSTER).hold(1).rot(WX, 90, 0.25).hold(0.6).rot(WX, -90, 0.4).hold(0.6).rot(WX, 90, 0.25).hold(0.6);
    const n = count(run(gen(path, path.duration, v), v, 'pitch', ['raise']).ev, 'raise');
    check('two draws -> 2 raises (+1 if the return move is quick)', v.name, n >= 2 && n <= 3, n, '2..3');
  }
}

// ------------------------------------------------------------------------------------------ aim
const AIM_GRIPS: { name: string; R: M3 }[] = [
  { name: 'upright', R: turn(R_UPRIGHT, WX, -10) },
  { name: 'flat', R: turn(R_FLAT, WX, 20) },
];
for (const v of MT.AIM_USE_GYRO ? ALL : []) {
  for (const g of AIM_GRIPS) {
    const path = new Path(g.R).hold(1).rot(WZ, -10, 0.3).hold(0.6).hold(0.2).rot(WX, 10, 0.3).hold(0.6);
    let x1 = 0, y1 = 0, xc = 99, x2 = 0, y2 = 0;
    // calibrate at 0.6 (start), at 1.95 (re-centre after the yaw)
    run(gen(path, path.duration, v), v, 'aim', [], (p, sec) => {
      const o = p.sample();
      if (sec > 1.75 && sec < 1.85) [x1, y1] = o;
      if (sec > 1.96 && sec < 2.0) xc = o[0];
      if (sec > 2.95 && sec < 3.0) [x2, y2] = o;
    }, [0.6, 1.95]);
    const tol = 70;
    check(`aim ${g.name}: 10° yaw right`, v.name, Math.abs(x1 - 769) < tol && Math.abs(y1) < tol, `x=${x1} y=${y1}`, 'x≈+769 y≈0');
    check(`aim ${g.name}: calibrate re-centres`, v.name, Math.abs(xc) < 40, xc, '|x|<40');
    check(`aim ${g.name}: 10° pitch up`, v.name, Math.abs(y2 - 769) < tol && Math.abs(x2) < tol, `x=${x2} y=${y2}`, 'x≈0 y≈+769');
  }
}

// gravity aim (the default, and the only way without a gyro): tilt relative to the re-centre point
for (const v of MT.AIM_USE_GYRO ? [V_NOGYRO] : [...ALL, V_NOGYRO]) {
  const path = new Path(turn(R_FLAT, WX, 20)).hold(1).rot(WY, 10, 0.3).hold(0.6);
  let x1 = 0;
  run(gen(path, path.duration, v), v, 'aim', [], (p, sec) => {
    if (sec > 1.75) x1 = p.sample()[0];
  });
  check('aim by tilt: 10° right tilt', v.name, Math.abs(x1 - 625) < 90, x1, 'x≈+625');
}

// rad/s gyro (old Android): handled after some natural handling
{
  const v: Variant = { name: 'android-rad/s', gen: { gyroRad: true }, via: 'direct' };
  const handle = new Path(R_UPRIGHT).hold(0.5).rot(WX, 40, 0.6).rot(WY, 50, 0.6).rot(WY, -50, 0.6).rot(WX, -40, 0.6).rot(WY, 30, 0.5).rot(WY, -30, 0.5)
    .hold(0.6).rot(WZ, -10, 0.3).hold(0.6);
  let x1 = 0;
  const r = run(gen(handle, handle.duration, v), v, 'aim', [], (p, sec) => {
    if (sec > handle.duration - 0.1) x1 = p.sample()[0];
  }, [handle.duration - 1.5]);
  check('gyro units self-check (rad/s → deg/s)', v.name, Math.abs(r.p.gyroK - 57.2958) < 0.01, r.p.gyroK.toFixed(2), '57.30');
  if (MT.AIM_USE_GYRO) check('aim with rad/s gyro: 10° yaw', v.name, Math.abs(x1 - 625) < 70, x1, 'x≈+625');
  const v2: Variant = { name: 'android-deg/s', gen: {}, via: 'direct' };
  const r2 = run(gen(handle, handle.duration, v2), v2, 'aim', []);
  check('gyro units self-check (deg/s kept)', v2.name, r2.p.gyroK === 1 && r2.p.gyroChecked, `${r2.p.gyroK} checked=${r2.p.gyroChecked}`, '1, checked');
}

// iOS sign autodetect via orientation, with a WRONG platform guess
{
  const v = V_IOS_ORIENT;
  const s = gen(new Path(R_FLAT).hold(1.5), 1.5, v);
  const norm = new Normalizer(false);
  for (const x of s) {
    const d = toDevice(x, 0, true);
    norm.orientation(d.beta, d.gamma, x.t);
    norm.motion(d.reading, 0, x.t);
  }
  check('iOS incl sign detected from orientation', v.name, norm.inclSign === -1, norm.inclSign, '-1');
}

// ------------------------------------------------------------------------------------------ report
const failed = rows.filter((r) => !r.ok);
const byTest = new Map<string, Row[]>();
for (const r of rows) {
  const l = byTest.get(r.test) ?? [];
  l.push(r);
  byTest.set(r.test, l);
}
const pad = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
console.log(`\n${pad('check', 44)} ${pad('pass', 7)} ${pad('expect', 26)} sample values`);
console.log('-'.repeat(130));
for (const [test, l] of byTest) {
  const ok = l.filter((r) => r.ok).length;
  const vals = l.map((r) => `${r.variant}:${r.value}`).join('  ');
  console.log(`${pad(test, 44)} ${pad(`${ok}/${l.length}`, 7)} ${pad(l[0].expect, 26)} ${ok === l.length && !verbose ? vals.slice(0, 120) : ''}`);
  if (verbose || ok !== l.length) for (const r of l) if (verbose || !r.ok) console.log(`    ${r.ok ? 'ok  ' : 'FAIL'} ${pad(r.variant, 18)} ${r.value}`);
}
console.log('-'.repeat(130));
console.log(`${rows.length - failed.length}/${rows.length} checks passed${failed.length ? ` — ${failed.length} FAILED` : ''}`);
process.exit(failed.length ? 1 : 0);
