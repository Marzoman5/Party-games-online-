/**
 * Keyframe-style pose library. A pose is a flat Float32Array of joint rotations + body offsets.
 * Conventions (body space, facing +z, LEFT = +x, RIGHT = -x; the right side faces the camera):
 *  - arm upper rx: negative = raise forward (-PI/2 horizontal, -PI straight up); out (abduct) via arm().
 *  - forearm rx negative = bend elbow (forearm forward/up). Thigh rx negative = leg forward.
 *  - shin rx positive = knee bend. spine/chest/head rx positive = lean / look down.
 *  - chest ry positive = right shoulder forward (punching with the right hand).
 *  - PITCH positive = whole body leans/flips forward (about the body centre).
 */
import type { MoveId } from '../types';
import type { Archetype } from '../types';

export const HIPS = 0,
  SPINE = 1,
  CHEST = 2,
  HEAD = 3,
  LUA = 4,
  LFA = 5,
  LHAND = 6,
  RUA = 7,
  RFA = 8,
  RHAND = 9,
  LTH = 10,
  LSH = 11,
  LFOOT = 12,
  RTH = 13,
  RSH = 14,
  RFOOT = 15;
export const NJ = 16;
export const OX = 48,
  OY = 49,
  OZ = 50,
  PITCH = 51,
  ROLL = 52,
  TWIST = 53,
  SQ = 54,
  WZ = 55,
  NCH = 56;

export type Pose = Float32Array;

export interface PoseCtx {
  id: string;
  style: Archetype;
  heavy: boolean;
  light: boolean;
  thigh: number;
  shin: number;
  k: number;
  t: number;
  af: number;
  vx: number;
  vy: number;
  /** Forward speed (vx * facing), world units / frame. */
  fwd: number;
  grounded: boolean;
  cyc: number;
  launch: number;
  charge: number;
  // ---- outputs (reset each frame by the rig)
  spinX: number;
  spinY: number;
  spinZ: number;
  spinOn: boolean;
  visorDown: boolean;
  bubble: number;
  stars: boolean;
  handGlow: number;
}

const PI = Math.PI;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const clamp01 = (v: number) => clamp(v, 0, 1);
export const ease = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function zero(p: Pose): void {
  p.fill(0);
  p[SQ] = 1;
}
export function copyPose(dst: Pose, src: Pose): void {
  dst.set(src);
}
export function lerpPose(out: Pose, a: Pose, b: Pose, t: number): void {
  for (let i = 0; i < NCH; i++) out[i] = a[i] + (b[i] - a[i]) * t;
}

function j(p: Pose, idx: number, x: number, y = 0, z = 0): void {
  const i = idx * 3;
  p[i] = x;
  p[i + 1] = y;
  p[i + 2] = z;
}
/** side: 1 = left (far), -1 = right (camera side). out > 0 = away from the body. */
function arm(p: Pose, side: 1 | -1, x: number, out: number, fa: number, hand = 0, twist = 0, faUp = 0): void {
  const b = side === 1 ? LUA : RUA;
  j(p, b, x, twist * side, out * side);
  j(p, b + 1, fa, 0, faUp * side);
  j(p, b + 2, hand);
}
function leg(p: Pose, side: 1 | -1, th: number, sh: number, foot = 0, out = 0): void {
  const b = side === 1 ? LTH : RTH;
  j(p, b, th, 0, out * side);
  j(p, b + 1, sh);
  j(p, b + 2, foot);
}
/** 2-bone leg IK: hips lowered by `drop`, foot `fwd` in front of the hip (body z). */
function legIK(p: Pose, c: PoseCtx, side: 1 | -1, drop: number, fwd: number, out = 0): void {
  const L1 = c.thigh;
  const L2 = c.shin;
  const h = Math.max(0.05, L1 + L2 - drop);
  let D = Math.hypot(fwd, h);
  const mx = (L1 + L2) * 0.999;
  if (D > mx) D = mx;
  const a = Math.atan2(fwd, h);
  const alpha = Math.acos(clamp((L1 * L1 + D * D - L2 * L2) / (2 * L1 * D), -1, 1));
  const knee = PI - Math.acos(clamp((L1 * L1 + L2 * L2 - D * D) / (2 * L1 * L2), -1, 1));
  const th = -(a + alpha);
  leg(p, side, th, knee, -(th + knee), out);
}
/** Grounded stance: right (camera-side) foot forward. */
function stance(p: Pose, c: PoseCtx, drop: number, spread: number, out = 0.06): void {
  const d = drop * c.k;
  legIK(p, c, -1, d, spread * c.k, out);
  legIK(p, c, 1, d, -spread * c.k, out);
  p[OY] = -d;
}

// ---------------------------------------------------------------------------
// Locomotion / neutral
// ---------------------------------------------------------------------------

export function idle(p: Pose, c: PoseCtx): void {
  zero(p);
  const b = Math.sin(c.t * 2.4);
  switch (c.style) {
    case 'bruiser':
      stance(p, c, 0.1 + b * 0.012, 0.15, 0.14);
      j(p, SPINE, 0.2);
      j(p, CHEST, 0.06 + b * 0.04);
      j(p, HEAD, -0.22);
      arm(p, -1, -0.45, 0.32, -0.9, 0.1);
      arm(p, 1, -0.3, 0.4, -0.8, 0.1);
      p[TWIST] = -0.15;
      break;
    case 'speedster': {
      const bb = Math.abs(Math.sin(c.t * 5));
      stance(p, c, 0.1 + bb * 0.05, 0.16, 0.05);
      j(p, SPINE, 0.22);
      j(p, CHEST, 0.05);
      j(p, HEAD, -0.2);
      arm(p, -1, -0.7, 0.2, -1.5);
      arm(p, 1, 0.45, 0.25, -0.9);
      break;
    }
    case 'sword':
      stance(p, c, 0.1 + b * 0.01, 0.2, 0.05);
      j(p, SPINE, 0.1);
      j(p, CHEST, 0.03 + b * 0.02, 0.15);
      j(p, HEAD, -0.12, -0.1);
      arm(p, -1, -0.8, 0.12, -0.55, 0.6);
      arm(p, 1, 0.25, 0.35, -0.9);
      p[TWIST] = -0.1;
      break;
    case 'zoner':
      stance(p, c, 0.04, 0.1, 0.04);
      j(p, SPINE, 0.02);
      j(p, CHEST, b * 0.03);
      j(p, HEAD, -0.06);
      arm(p, -1, -0.45 + b * 0.05, 0.45, -1.0);
      arm(p, 1, -0.3 - b * 0.05, 0.5, -0.9);
      p[OY] += 0.015 * Math.sin(c.t * 1.7);
      break;
    case 'trickster':
      stance(p, c, 0.15, 0.16, 0.1);
      j(p, SPINE, 0.3);
      j(p, CHEST, 0.06 + b * 0.02);
      j(p, HEAD, -0.3, 0, 0.1 * Math.sin(c.t * 1.3));
      arm(p, -1, -0.75, 0.25, -1.2);
      arm(p, 1, 0.55, 0.3, -0.5);
      p[ROLL] = 0.04 * Math.sin(c.t * 2);
      break;
    default:
      stance(p, c, 0.07 + b * 0.008, 0.15);
      j(p, SPINE, 0.08);
      j(p, CHEST, 0.03 + b * 0.025);
      j(p, HEAD, -0.06);
      arm(p, -1, -0.75, 0.2, -1.75);
      arm(p, 1, -0.45, 0.25, -1.9);
      p[TWIST] = -0.15;
  }
}

export function walk(p: Pose, c: PoseCtx): void {
  zero(p);
  const s = Math.sin(c.cyc);
  const co = Math.cos(c.cyc);
  const amp = c.heavy ? 0.4 : 0.5;
  leg(p, -1, -amp * s, 0.15 + 0.55 * Math.max(0, co), 0.1 * s);
  leg(p, 1, amp * s, 0.15 + 0.55 * Math.max(0, -co), -0.1 * s);
  arm(p, -1, 0.45 * s, 0.12, -0.45);
  arm(p, 1, -0.45 * s, 0.12, -0.45);
  j(p, SPINE, 0.06);
  j(p, CHEST, 0, 0.12 * s);
  p[OY] = -0.03 * c.k + 0.025 * c.k * Math.abs(co);
  if (c.heavy) p[ROLL] = 0.05 * s;
}

export function run(p: Pose, c: PoseCtx): void {
  zero(p);
  const s = Math.sin(c.cyc);
  const co = Math.cos(c.cyc);
  leg(p, -1, -0.95 * s, 0.35 + 1.25 * Math.max(0, co), 0.25 * s);
  leg(p, 1, 0.95 * s, 0.35 + 1.25 * Math.max(0, -co), -0.25 * s);
  p[OY] = -0.05 * c.k + 0.05 * c.k * Math.abs(s);
  if (c.style === 'speedster') {
    j(p, HIPS, 0.15);
    j(p, SPINE, 0.35);
    j(p, HEAD, -0.45);
    arm(p, -1, 1.1, 0.15, -0.15, 0.3);
    arm(p, 1, 1.0, 0.15, -0.15, 0.3);
  } else if (c.style === 'sword') {
    j(p, HIPS, 0.1);
    j(p, SPINE, 0.25);
    j(p, HEAD, -0.3);
    arm(p, -1, 0.8, 0.25, -0.2, 0.9); // sword trailing
    arm(p, 1, -0.9 * s, 0.15, -1.4);
  } else {
    j(p, HIPS, 0.1);
    j(p, SPINE, c.heavy ? 0.3 : 0.22);
    j(p, HEAD, -0.3);
    arm(p, -1, 0.9 * s, 0.18, -1.5);
    arm(p, 1, -0.9 * s, 0.18, -1.5);
  }
  j(p, CHEST, 0, 0.2 * s);
}

export function crouch(p: Pose, c: PoseCtx, amt = 1): void {
  zero(p);
  stance(p, c, 0.32 * amt, 0.12, 0.12);
  j(p, SPINE, 0.45 * amt);
  j(p, CHEST, 0.15 * amt);
  j(p, HEAD, -0.5 * amt);
  arm(p, -1, -0.6 * amt, 0.25, -1.3);
  arm(p, 1, -0.4 * amt, 0.3, -1.2);
}

export function jump(p: Pose, c: PoseCtx): void {
  zero(p);
  const rising = c.vy > 0;
  leg(p, -1, -1.0, 1.4, 0.3);
  leg(p, 1, 0.25, 0.6, 0.4);
  arm(p, -1, rising ? -2.2 : -0.9, 0.5, -0.4);
  arm(p, 1, rising ? -0.3 : -0.6, 0.8, -0.5);
  j(p, SPINE, 0.05);
  j(p, HEAD, rising ? -0.25 : 0);
}

export function fall(p: Pose, c: PoseCtx): void {
  zero(p);
  const f = Math.sin(c.t * 9) * 0.06;
  leg(p, -1, -0.45, 0.7, 0.3);
  leg(p, 1, 0.1, 0.35, 0.3);
  arm(p, -1, -0.9 + f, 1.0, -0.4);
  arm(p, 1, -0.6 - f, 1.05, -0.4);
  j(p, SPINE, 0.08);
  j(p, HEAD, 0.15);
}

export function tuck(p: Pose): void {
  zero(p);
  leg(p, -1, -1.9, 2.3, 0.3, 0.1);
  leg(p, 1, -1.7, 2.3, 0.3, 0.1);
  arm(p, -1, -0.8, 0.1, -1.8);
  arm(p, 1, -0.8, 0.1, -1.8);
  j(p, SPINE, 0.5);
  j(p, HEAD, 0.4);
}

export function shield(p: Pose, c: PoseCtx): void {
  zero(p);
  stance(p, c, 0.14, 0.13, 0.1);
  j(p, SPINE, 0.25);
  j(p, CHEST, 0.1);
  j(p, HEAD, 0.25);
  arm(p, -1, -1.25, -0.35, -1.4);
  arm(p, 1, -1.1, -0.3, -1.5);
}

export function hitstun(p: Pose, c: PoseCtx, strength: number): void {
  zero(p);
  const s = 0.6 + strength * 0.6;
  p[PITCH] = -0.35 * s;
  j(p, SPINE, -0.25 * s);
  j(p, HEAD, -0.5 * s);
  arm(p, -1, -1.4 * s, 0.6, -0.3);
  arm(p, 1, -1.1 * s, 0.8, -0.3);
  if (c.grounded) stance(p, c, 0.08, 0.1);
  else {
    leg(p, -1, -0.8, 0.8);
    leg(p, 1, -0.2, 0.4);
  }
}

export function starfish(p: Pose): void {
  zero(p);
  arm(p, -1, -0.3, 1.45, -0.2);
  arm(p, 1, -0.2, 1.35, -0.3);
  leg(p, -1, -0.3, 0.3, 0.3, 0.55);
  leg(p, 1, 0.2, 0.2, 0.3, 0.5);
  j(p, HEAD, -0.3);
}

export function helpless(p: Pose, c: PoseCtx): void {
  zero(p);
  const w = Math.sin(c.t * 3);
  arm(p, -1, -2.4 + w * 0.1, 0.35, -0.3);
  arm(p, 1, -2.5 - w * 0.1, 0.4, -0.3);
  leg(p, -1, -0.2, 0.5, 0.4);
  leg(p, 1, 0.1, 0.6, 0.4);
  j(p, HEAD, 0.35);
  j(p, SPINE, 0.1);
  p[ROLL] = 0.12 * w;
}

export function lying(p: Pose, c: PoseCtx, center: number): void {
  zero(p);
  p[PITCH] = -PI / 2;
  p[OY] = -center + 0.16 * c.k;
  arm(p, -1, -0.2, 1.2, -0.2);
  arm(p, 1, -0.3, 1.1, -0.3);
  if (c.style === 'sword') j(p, RHAND, 1.5);
  leg(p, -1, -0.1, 0.25, 0.3, 0.2);
  leg(p, 1, 0.1, 0.1, 0.3, 0.2);
  j(p, HEAD, -0.2 + Math.sin(c.t * 2) * 0.03);
}

export function ledgeHang(p: Pose, c: PoseCtx): void {
  zero(p);
  const sw = Math.sin(c.t * 2.2);
  arm(p, -1, -2.95, 0.12, -0.1);
  arm(p, 1, -2.9, 0.15, -0.15);
  j(p, HEAD, -0.35);
  j(p, SPINE, -0.05);
  leg(p, -1, 0.1 + sw * 0.15, 0.3, 0.3);
  leg(p, 1, -0.15 - sw * 0.15, 0.45, 0.3);
  p[TWIST] = -0.4;
}

export function grabHold(p: Pose, c: PoseCtx): void {
  zero(p);
  stance(p, c, 0.08, 0.18);
  j(p, SPINE, 0.15);
  arm(p, -1, -1.45, 0.05, -0.35);
  arm(p, 1, -1.3, -0.1, -0.45);
}

export function grabbed(p: Pose, c: PoseCtx): void {
  zero(p);
  const w = Math.sin(c.t * 14);
  j(p, SPINE, 0.3);
  j(p, HEAD, 0.2 + w * 0.1);
  arm(p, -1, -0.8 + w * 0.4, 0.5, -0.6);
  arm(p, 1, -0.8 - w * 0.4, 0.5, -0.6);
  leg(p, -1, -0.4 + w * 0.3, 0.7, 0.3);
  leg(p, 1, 0.1 - w * 0.3, 0.5, 0.3);
  p[PITCH] = -0.12;
  p[OY] = 0.05 * c.k;
}

export function dizzy(p: Pose, c: PoseCtx): void {
  zero(p);
  const w = Math.sin(c.t * 3.2);
  stance(p, c, 0.1 + 0.04 * Math.abs(w), 0.08, 0.12);
  j(p, SPINE, 0.3);
  j(p, HEAD, 0.3, 0, 0.35 * w);
  arm(p, -1, -0.3, 0.2 + 0.1 * w, -0.2);
  arm(p, 1, -0.25, 0.2 - 0.1 * w, -0.2);
  p[ROLL] = 0.14 * w;
  c.stars = true;
}

export function clap(p: Pose, c: PoseCtx): void {
  zero(p);
  stance(p, c, 0.03, 0.06, 0.05);
  const cl = Math.abs(Math.sin(c.t * 6.5));
  j(p, SPINE, 0.12);
  j(p, HEAD, 0.28);
  arm(p, -1, -0.95, -0.3 + 0.28 * cl, -0.75);
  arm(p, 1, -0.95, -0.3 + 0.28 * cl, -0.75);
  p[TWIST] = -0.15;
}

// ---------------------------------------------------------------------------
// Victory loops (unique per character)
// ---------------------------------------------------------------------------

export function victory(p: Pose, c: PoseCtx): void {
  zero(p);
  const t = c.t;
  switch (c.id) {
    case 'zippy': {
      const T = t % 2.6;
      if (T < 0.55) {
        c.spinOn = true;
        c.spinY = ease(T / 0.55) * PI * 2;
        stance(p, c, 0.02, 0.05);
        arm(p, -1, -0.3, 1.2, -0.2);
        arm(p, 1, -0.3, 1.2, -0.2);
        leg(p, -1, -0.6, 1.2, 0.3);
      } else {
        const bb = Math.abs(Math.sin(t * 4)) * 0.02;
        stance(p, c, 0.03 + bb, 0.1, 0.1);
        arm(p, -1, -2.6, 0.35, -0.05); // point to the sky
        arm(p, 1, 0.2, 0.75, -1.9, 0, -1.0); // hand on hip
        j(p, HEAD, -0.35);
        j(p, CHEST, -0.1);
        p[TWIST] = -0.35;
      }
      break;
    }
    case 'pixel': {
      const w = Math.sin(t * 5);
      const bounce = Math.abs(Math.sin(t * 5));
      stance(p, c, 0.05 + bounce * 0.07, 0.08, 0.12);
      p[ROLL] = 0.12 * w;
      p[OX] = 0.06 * w * c.k;
      arm(p, -1, -2.6 - 0.35 * w, 0.4, -0.4);
      arm(p, 1, -2.6 + 0.35 * w, 0.4, -0.4);
      j(p, HEAD, -0.1, 0, -0.2 * w);
      const T = t % 3;
      c.bubble = T < 2.3 ? ease(T / 2.3) : 0;
      break;
    }
    case 'fennec': {
      const T = t % 3;
      if (T < 0.6) {
        c.spinOn = true;
        c.spinX = -ease(T / 0.6) * PI * 2; // backflip
        tuck(p);
        p[OY] = Math.sin((T / 0.6) * PI) * 0.6 * c.k;
      } else {
        stance(p, c, 0.22, 0.2, 0.2);
        j(p, SPINE, 0.25);
        j(p, HEAD, -0.25, 0, 0.25);
        arm(p, -1, -2.1, -0.2, -2.0, 0, 0.6); // V by the face
        arm(p, 1, -0.4, 0.4, -0.3);
        p[TWIST] = -0.4;
      }
      break;
    }
    case 'max': {
      const pump = Math.max(0, Math.sin(t * 7));
      stance(p, c, 0.03 + pump * 0.04, 0.12, 0.1);
      arm(p, -1, -2.9 + pump * 0.5, 0.2, -0.2 - pump * 1.2);
      arm(p, 1, 0.2, 0.75, -1.9, 0, -1.0);
      j(p, HEAD, -0.3);
      j(p, CHEST, -0.1);
      p[OY] += pump * 0.06 * c.k;
      p[TWIST] = -0.3;
      break;
    }
    case 'juno': {
      p[OY] = 0.28 * c.k + 0.06 * Math.sin(t * 2);
      leg(p, -1, -0.1, 0.25, 0.7);
      leg(p, 1, 0.05, 0.15, 0.7);
      arm(p, -1, -0.5, 1.0 + 0.1 * Math.sin(t * 3), -0.35);
      arm(p, 1, -0.5, 1.0 - 0.1 * Math.sin(t * 3), -0.35);
      j(p, HEAD, -0.3);
      j(p, CHEST, -0.1);
      c.handGlow = 1;
      break;
    }
    case 'kai': {
      const T = t % 4;
      stance(p, c, 0.05, 0.12, 0.06);
      if (T < 2.2) {
        arm(p, -1, -1.0, -0.35, -1.25, -0.1); // salute: blade vertical before the face
        arm(p, 1, -0.6, -0.2, -1.6);
        j(p, HEAD, 0.05);
      } else {
        const u = ease(clamp01((T - 2.2) / 0.3));
        arm(p, -1, lerp(-1.0, 0.25, u), lerp(-0.35, 0.5, u), lerp(-1.25, -0.1, u), lerp(-0.1, 1.2, u));
        arm(p, 1, -0.4, 0.3, -1.9);
        j(p, HEAD, -0.15);
      }
      p[TWIST] = -0.25;
      break;
    }
    case 'bram': {
      const T = t % 2.4;
      const st = T < 0.25 ? Math.sin((T / 0.25) * PI) : 0;
      stance(p, c, 0.12, 0.12, 0.25);
      if (st > 0) leg(p, -1, -0.6 * st, 0.8 * st, 0.2, 0.25);
      const fl = 1.75 + 0.15 * Math.sin(t * 6);
      arm(p, -1, -0.15, 1.4, 0, 0, 0, fl); // double-biceps flex
      arm(p, 1, -0.15, 1.4, 0, 0, 0, fl);
      j(p, CHEST, -0.15 + 0.05 * Math.sin(t * 6));
      j(p, HEAD, -0.2);
      p[TWIST] = -0.2;
      break;
    }
    case 'rosa': {
      const laugh = Math.sin(t * 12) * 0.05;
      stance(p, c, 0.06, 0.12, 0.2);
      arm(p, 1, 0.25, 0.75, -1.9, 0, -1.0); // hand on hip
      arm(p, -1, -0.9, 0.45, -1.3, 0.3); // thumbs up
      j(p, HEAD, -0.35 + laugh);
      j(p, CHEST, -0.18 + laugh);
      p[TWIST] = -0.3;
      break;
    }
    default:
      clap(p, c);
  }
}

/** Static 3/4 hero stance for portraits / character select. */
export function portrait(p: Pose, c: PoseCtx): void {
  zero(p);
  switch (c.id) {
    case 'kai':
      stance(p, c, 0.08, 0.15);
      arm(p, -1, -0.35, 0.3, -2.1, 0.1); // blade resting over the shoulder
      arm(p, 1, 0.1, 0.35, -0.5);
      j(p, HEAD, -0.05, 0.15);
      break;
    case 'juno':
      stance(p, c, 0.02, 0.08);
      arm(p, -1, -1.0, 0.35, -1.0);
      arm(p, 1, -0.3, 0.6, -0.9);
      c.handGlow = 1;
      break;
    case 'bram':
      stance(p, c, 0.1, 0.12, 0.2);
      arm(p, -1, -0.6, 0.4, -1.2);
      arm(p, 1, -0.6, 0.4, -1.2);
      j(p, SPINE, 0.12);
      j(p, HEAD, -0.15);
      break;
    case 'rosa':
      stance(p, c, 0.05, 0.12, 0.15);
      arm(p, -1, -0.9, 0.4, -1.5);
      arm(p, 1, 0.25, 0.75, -1.9, 0, -1.0);
      j(p, HEAD, -0.12);
      break;
    case 'pixel':
      stance(p, c, 0.03, 0.08);
      arm(p, -1, -2.3, 0.2, -1.4);
      arm(p, 1, -0.4, 0.4, -0.6);
      j(p, HEAD, 0, 0, -0.18);
      break;
    case 'fennec':
      stance(p, c, 0.12, 0.15, 0.12);
      j(p, SPINE, 0.2);
      arm(p, -1, -2.1, -0.2, -2.0, 0, 0.6);
      arm(p, 1, 0.2, 0.3, -0.5);
      j(p, HEAD, -0.15, 0, 0.2);
      break;
    case 'zippy':
      stance(p, c, 0.05, 0.12);
      arm(p, -1, -1.0, 0.3, -1.6);
      arm(p, 1, 0.2, 0.75, -1.9, 0, -1.0);
      j(p, HEAD, -0.15);
      break;
    default:
      stance(p, c, 0.05, 0.12);
      arm(p, -1, -0.9, 0.25, -1.9);
      arm(p, 1, 0.2, 0.75, -1.9, 0, -1.0);
      j(p, HEAD, -0.1);
  }
}

// ---------------------------------------------------------------------------
// Moves. stage 'wind' = end of startup (held while charging); 'strike' = active, `a` = frames
// since the active window opened (arcs sweep over the first few active frames).
// ---------------------------------------------------------------------------

export type Stage = 'wind' | 'strike';

let _swA = 0;
/** Sweep progress over n frames of the active window (no per-frame closures). */
function sw(n: number): number {
  return ease(clamp01(_swA / n));
}

const SPECIAL_HEAVY: Partial<Record<MoveId, true>> = { fsmash: true, usmash: true, dsmash: true, nspecial: true, sspecial: true, uspecial: true, dspecial: true, finalSmash: true };

export function movePose(p: Pose, c: PoseCtx, move: MoveId, stage: Stage, a: number): void {
  zero(p);
  const W = stage === 'wind';
  _swA = a;
  const sword = c.style === 'sword';
  const heavy = c.style === 'bruiser';
  if (c.id === 'rosa' && SPECIAL_HEAVY[move]) c.visorDown = true;
  if (!c.grounded && !isAerial(move)) {
    // grounded move used in the air (specials): air legs
  }
  switch (move) {
    case 'jab1':
      stance(p, c, 0.08, 0.17);
      if (sword) {
        arm(p, -1, W ? -1.6 : lerp(-1.6, -0.6, sw(3)), W ? 0.6 : lerp(0.6, -0.2, sw(3)), -0.3, 1.2);
        j(p, CHEST, 0.05, W ? -0.4 : 0.4);
      } else if (W) {
        arm(p, -1, 0.3, 0.3, -2.0);
        arm(p, 1, -0.6, 0.25, -1.9);
        j(p, CHEST, 0, -0.3);
      } else {
        arm(p, -1, -1.6, 0.05, -0.05);
        arm(p, 1, 0.1, 0.3, -1.9);
        j(p, CHEST, 0.08, 0.45);
        j(p, SPINE, 0.1);
      }
      break;
    case 'jab2':
      stance(p, c, 0.08, 0.17);
      if (sword) {
        arm(p, -1, W ? -0.6 : lerp(-0.6, -1.7, sw(3)), W ? -0.2 : lerp(-0.2, 0.7, sw(3)), -0.3, 1.2);
        j(p, CHEST, 0.05, W ? 0.4 : -0.4);
      } else if (W) {
        arm(p, -1, -1.2, 0.1, -1.0);
        arm(p, 1, 0.3, 0.3, -2.0);
        j(p, CHEST, 0, 0.3);
      } else {
        arm(p, 1, -1.6, -0.1, -0.05);
        arm(p, -1, 0.2, 0.3, -1.9);
        j(p, CHEST, 0.08, -0.5);
        j(p, SPINE, 0.1);
      }
      break;
    case 'jab3':
      if (sword) {
        stance(p, c, 0.12, 0.25);
        arm(p, -1, -1.5, 0.05, W ? -1.4 : 0, W ? 1.4 : 1.55);
        arm(p, 1, 0.4, 0.4, -0.5);
        j(p, CHEST, 0.15, W ? -0.4 : 0.5);
        p[OX] = W ? 0 : 0.1 * c.k;
      } else if (heavy) {
        stance(p, c, 0.12, 0.2);
        arm(p, -1, W ? -2.6 : -1.0, 0.1, W ? -1.0 : -0.1);
        arm(p, 1, W ? -2.6 : -1.0, 0.1, W ? -1.0 : -0.1);
        j(p, SPINE, W ? -0.2 : 0.5);
      } else {
        legIK(p, c, 1, 0.04 * c.k, -0.05 * c.k);
        leg(p, -1, W ? -1.3 : -1.55, W ? 1.8 : 0.05, W ? 0 : -0.4);
        j(p, SPINE, -0.2);
        arm(p, -1, 0.4, 0.4, -1.2);
        arm(p, 1, -0.4, 0.5, -1.4);
      }
      break;
    case 'dashAttack':
      if (c.style === 'speedster') {
        // slide kick
        p[PITCH] = -0.9;
        p[OY] = -0.3 * c.k;
        leg(p, -1, -1.3, 0.05, -0.3);
        leg(p, 1, -0.5, 1.4, 0);
        arm(p, -1, 0.4, 0.6, -0.2);
        arm(p, 1, 0.6, 0.6, -0.2);
        j(p, HEAD, 0.7);
      } else if (heavy) {
        p[PITCH] = W ? 0.1 : 0.4;
        j(p, CHEST, 0, 0.6);
        arm(p, -1, -0.4, -0.4, -1.8);
        arm(p, 1, 0.2, 0.2, -1.6);
        legIK(p, c, -1, 0.15 * c.k, 0.25 * c.k);
        legIK(p, c, 1, 0.15 * c.k, -0.25 * c.k);
        p[OY] = -0.15 * c.k;
      } else if (sword) {
        p[PITCH] = 0.3;
        arm(p, -1, W ? -2.0 : lerp(-2.4, -0.4, sw(3)), 0.1, -0.2, 0.2);
        arm(p, 1, 0.6, 0.4, -0.3);
        leg(p, -1, -0.9, 1.0, 0.2);
        leg(p, 1, 0.6, 0.4, 0.4);
      } else {
        p[PITCH] = W ? 0.1 : 0.45;
        leg(p, -1, -1.2, 0.2, -0.2);
        leg(p, 1, 0.5, 1.0, 0.3);
        arm(p, -1, -1.5, 0.2, -0.1);
        arm(p, 1, -1.4, 0.3, -0.2);
        p[OY] = 0.05 * c.k;
      }
      break;
    case 'ftilt':
      if (sword) {
        stance(p, c, 0.12, 0.25);
        arm(p, -1, -1.45, 0.05, -0.1, 1.45);
        arm(p, 1, 0.4, 0.5, -0.6);
        j(p, CHEST, 0.1, W ? -0.9 : lerp(-0.9, 0.8, sw(3)));
        j(p, SPINE, 0, W ? -0.2 : 0.3);
      } else if (heavy) {
        stance(p, c, 0.12, 0.22);
        arm(p, -1, W ? 0.3 : -1.55, W ? 1.0 : 0.1, W ? -0.6 : 0, 0);
        j(p, CHEST, 0.1, W ? -0.6 : 0.7);
        arm(p, 1, -0.4, 0.4, -1.2);
      } else {
        legIK(p, c, 1, 0.06 * c.k, -0.08 * c.k);
        leg(p, -1, W ? -1.3 : -1.55, W ? 2.0 : 0.05, -0.2, W ? 0 : 0.1);
        j(p, SPINE, -0.35);
        j(p, HEAD, -0.15);
        arm(p, -1, -0.3, 0.6, -1.2);
        arm(p, 1, 0.3, 0.6, -1.0);
        p[TWIST] = -0.2;
      }
      break;
    case 'utilt':
      stance(p, c, 0.08, 0.12);
      if (sword) {
        arm(p, -1, W ? -0.4 : lerp(-0.6, -3.6, sw(4)), 0.1, -0.1, 0);
      } else {
        arm(p, -1, W ? -0.2 : lerp(-0.6, -3.0, sw(3)), 0.1, W ? -1.6 : -0.3);
        arm(p, 1, -0.5, 0.3, -1.5);
      }
      j(p, SPINE, W ? 0.2 : -0.2);
      j(p, HEAD, W ? 0 : -0.4);
      break;
    case 'dtilt':
      crouch(p, c, 1);
      if (sword) {
        arm(p, -1, -1.3, 0.05, 0, 1.6);
        j(p, CHEST, 0.2, W ? -0.5 : 0.4);
        p[OX] = W ? 0 : 0.1 * c.k;
      } else {
        leg(p, -1, W ? -0.8 : -1.5, W ? 1.8 : 0.1, -0.3, 0.1);
        arm(p, -1, -0.6, 0.6, -0.3);
        arm(p, 1, -0.9, 0.4, -0.3);
        j(p, SPINE, 0.5);
      }
      break;
    case 'fsmash':
      if (sword) {
        stance(p, c, 0.15, 0.3);
        arm(p, -1, W ? -2.8 : lerp(-2.8, -0.4, sw(3)), 0.05, W ? -0.6 : 0, W ? 0.3 : 0.2);
        arm(p, 1, W ? -2.6 : 0.6, 0.2, W ? -0.8 : -0.3);
        j(p, SPINE, W ? -0.35 : 0.55);
        p[OX] = W ? -0.05 * c.k : 0.18 * c.k;
      } else if (heavy) {
        stance(p, c, W ? 0.08 : 0.25, 0.25, 0.15);
        const v = W ? -2.95 : lerp(-2.95, -0.7, sw(3));
        arm(p, -1, v, 0.0, W ? -0.6 : -0.1);
        arm(p, 1, v, 0.0, W ? -0.6 : -0.1);
        j(p, SPINE, W ? -0.35 : 0.75);
        j(p, HEAD, W ? -0.3 : -0.2);
        p[OX] = W ? -0.05 * c.k : 0.15 * c.k;
      } else {
        stance(p, c, 0.14, W ? 0.2 : 0.3);
        if (W) {
          arm(p, -1, 1.0, 0.3, -1.6);
          arm(p, 1, -1.3, 0.2, -0.3);
          j(p, SPINE, -0.25);
          j(p, CHEST, 0, -0.7);
        } else {
          arm(p, -1, -1.6, 0.0, 0);
          arm(p, 1, 0.6, 0.4, -0.6);
          j(p, SPINE, 0.35);
          j(p, CHEST, 0, 0.7);
          p[OX] = 0.15 * c.k;
        }
      }
      break;
    case 'usmash':
      if (W) {
        crouch(p, c, 0.9);
        arm(p, -1, 0.6, 0.3, -0.4, sword ? 0.4 : 0);
        arm(p, 1, 0.6, 0.3, -0.4);
      } else {
        stance(p, c, -0.02, 0.06);
        const v = lerp(-1.0, sword ? -3.5 : -3.0, sw(3));
        arm(p, -1, v, 0.15, sword ? 0 : -0.2);
        arm(p, 1, heavy ? v : -0.6, heavy ? 0.15 : 0.6, -0.3);
        j(p, SPINE, -0.2);
        j(p, HEAD, -0.5);
        p[SQ] = 1.08;
        p[OY] = 0.08 * c.k;
      }
      break;
    case 'dsmash':
      if (W) {
        crouch(p, c, 0.8);
        arm(p, -1, -1.3, -0.3, -1.4, sword ? 1.4 : 0);
        arm(p, 1, -1.3, -0.3, -1.4);
      } else if (sword || c.style === 'speedster' || c.style === 'trickster') {
        crouch(p, c, 1);
        arm(p, -1, -0.5, 1.4, 0, 1.5);
        arm(p, 1, -0.5, 1.3, 0);
        c.spinOn = true;
        c.spinY = sw(10) * PI * 2;
      } else {
        // low front/back split with fists driven both ways
        stance(p, c, 0.3, 0.42, 0.1);
        arm(p, -1, heavy ? -0.5 : -1.3, 0.15, -0.05);
        arm(p, 1, heavy ? 0.5 : 1.3, 0.15, -0.05);
        j(p, SPINE, heavy ? 0.7 : 0.35);
        j(p, HEAD, -0.4);
      }
      break;
    case 'nair':
      starfish(p);
      if (sword) arm(p, -1, -1.55, 0.05, 0, 1.55);
      c.spinOn = true;
      c.spinY = (stage === 'wind' ? 0 : a * 0.45) * (c.heavy ? 0.7 : 1);
      break;
    case 'fair':
      tuck(p);
      if (sword) {
        arm(p, -1, W ? -3.0 : lerp(-3.0, -0.2, sw(3)), 0.05, 0, 0.2);
        j(p, SPINE, W ? -0.2 : 0.4);
      } else if (heavy) {
        const v = W ? -2.9 : lerp(-2.9, -0.4, sw(3));
        arm(p, -1, v, 0, -0.1);
        arm(p, 1, v, 0, -0.1);
        j(p, SPINE, W ? -0.3 : 0.6);
      } else {
        leg(p, -1, W ? -1.2 : lerp(-2.2, -0.9, sw(3)), W ? 2.0 : 0.05, -0.3);
        arm(p, -1, W ? -2.6 : lerp(-2.6, -0.5, sw(3)), 0.2, -0.2);
        j(p, SPINE, W ? -0.2 : 0.35);
      }
      break;
    case 'bair':
      tuck(p);
      if (sword) {
        arm(p, -1, W ? -1.0 : 1.3, 0.2, 0, W ? 0 : -1.4);
        j(p, CHEST, 0.2, W ? 0.5 : -0.6);
      } else {
        leg(p, -1, W ? -1.6 : 1.45, W ? 2.3 : 0.05, W ? 0.3 : -0.5);
        arm(p, -1, -1.2, 0.3, -0.6);
        arm(p, 1, -1.2, 0.3, -0.6);
        j(p, SPINE, W ? 0.4 : 0.6);
        j(p, HEAD, -0.4, W ? 0 : -0.6);
      }
      break;
    case 'uair':
      if (sword) {
        tuck(p);
        arm(p, -1, W ? -0.8 : lerp(-1.0, -4.0, sw(4)), 0.1, 0, 0);
        j(p, HEAD, -0.5);
      } else {
        zero(p);
        p[PITCH] = -0.45;
        leg(p, -1, W ? -0.4 : lerp(-0.4, -2.7, sw(3)), W ? 1.6 : 0.05, -0.3);
        leg(p, 1, 0.4, 0.8, 0.3);
        arm(p, -1, 0.5, 0.5, -0.3);
        arm(p, 1, 0.5, 0.5, -0.3);
        j(p, HEAD, -0.5);
      }
      break;
    case 'dair':
      if (sword) {
        tuck(p);
        arm(p, -1, W ? -1.5 : -0.1, 0.05, W ? -1.2 : 0, W ? 0 : 1.6);
        j(p, HEAD, 0.5);
      } else if (heavy) {
        zero(p);
        arm(p, -1, W ? -2.9 : -0.1, 0.1, W ? -0.6 : 0);
        arm(p, 1, W ? -2.9 : -0.1, 0.1, W ? -0.6 : 0);
        leg(p, -1, -1.2, 1.6, 0.3);
        leg(p, 1, -1.0, 1.6, 0.3);
        j(p, SPINE, 0.4);
      } else {
        zero(p);
        if (W) tuck(p);
        else {
          leg(p, -1, 0.0, 0.0, 0.8, 0.05);
          leg(p, 1, 0.05, 0.05, 0.8, 0.05);
          arm(p, -1, -2.6, 0.3, -0.3);
          arm(p, 1, -2.6, 0.3, -0.3);
          j(p, HEAD, 0.4);
          if (c.style === 'speedster') {
            c.spinOn = true;
            c.spinY = a * 0.6;
          }
        }
      }
      break;
    // ---------------- specials
    case 'nspecial':
      nspecial(p, c, W, a, sw);
      break;
    case 'sspecial':
      sspecial(p, c, W, a, sw);
      break;
    case 'uspecial':
      uspecial(p, c, W, a, sw);
      break;
    case 'dspecial':
      dspecial(p, c, W, a, sw);
      break;
    // ---------------- grabs & throws
    case 'grab':
      stance(p, c, 0.1, 0.2);
      j(p, SPINE, W ? 0.05 : 0.3);
      arm(p, -1, W ? -0.6 : -1.5, W ? 0.4 : -0.05, -0.15);
      arm(p, 1, W ? -0.5 : -1.4, W ? 0.4 : -0.15, -0.15);
      break;
    case 'pummel':
      grabHold(p, c);
      j(p, HEAD, W ? -0.3 : 0.5);
      j(p, SPINE, W ? 0.0 : 0.35);
      break;
    case 'fthrow':
      stance(p, c, 0.12, 0.25);
      j(p, SPINE, W ? -0.1 : 0.4);
      arm(p, -1, W ? -0.9 : -1.6, -0.1, W ? -1.6 : 0);
      arm(p, 1, W ? -0.8 : -1.5, -0.1, W ? -1.6 : 0);
      p[OX] = W ? -0.05 * c.k : 0.12 * c.k;
      break;
    case 'bthrow':
      stance(p, c, 0.12, 0.2);
      arm(p, -1, -1.3, 0.3, -0.3);
      arm(p, 1, -1.3, 0.3, -0.3);
      p[TWIST] = W ? 0.3 : -PI * 0.85 * sw(6);
      j(p, SPINE, 0.2);
      break;
    case 'uthrow':
      if (W) {
        crouch(p, c, 0.6);
        arm(p, -1, -1.2, -0.1, -1.0);
        arm(p, 1, -1.2, -0.1, -1.0);
      } else {
        stance(p, c, 0, 0.08);
        arm(p, -1, -3.05, 0.15, -0.1);
        arm(p, 1, -3.05, 0.15, -0.1);
        j(p, HEAD, -0.5);
        p[SQ] = 1.05;
      }
      break;
    case 'dthrow':
      if (W) {
        stance(p, c, 0.05, 0.15);
        arm(p, -1, -2.8, 0.1, -0.6);
        arm(p, 1, -2.8, 0.1, -0.6);
      } else {
        crouch(p, c, 1);
        arm(p, -1, -0.6, 0.1, -0.1);
        arm(p, 1, -0.6, 0.1, -0.1);
        j(p, SPINE, 0.8);
      }
      break;
    case 'getupAttack':
      crouch(p, c, 1.1);
      leg(p, -1, -1.4, 0.1, -0.2, 0.4);
      arm(p, -1, -0.3, 1.0, 0);
      arm(p, 1, -0.3, 1.0, 0);
      c.spinOn = true;
      c.spinY = W ? 0 : sw(10) * PI * 2;
      break;
    case 'ledgeAttack':
      legIK(p, c, 1, 0.1 * c.k, -0.1 * c.k);
      leg(p, -1, W ? -1.2 : -1.6, W ? 1.9 : 0.05, -0.2);
      j(p, SPINE, -0.25);
      arm(p, -1, -0.4, 0.6, -1.0);
      arm(p, 1, 0.3, 0.6, -1.0);
      break;
    case 'itemSwing':
      stance(p, c, 0.12, 0.25);
      arm(p, -1, W ? -2.0 : -1.4, W ? 0.9 : 0.1, W ? -1.4 : -0.1, 1.0);
      arm(p, 1, W ? -2.0 : -1.2, W ? -0.2 : 0.2, W ? -1.4 : -0.3, 1.0);
      j(p, CHEST, 0.1, W ? -1.0 : lerp(-1.0, 1.0, sw(3)));
      j(p, SPINE, 0, W ? -0.2 : 0.3);
      break;
    case 'itemThrow':
      stance(p, c, 0.1, 0.22);
      arm(p, -1, W ? -2.7 : lerp(-2.7, -0.9, sw(3)), 0.2, W ? -1.2 : 0, 0);
      arm(p, 1, -1.0, 0.4, -0.6);
      j(p, SPINE, W ? -0.25 : 0.35);
      j(p, CHEST, 0, W ? -0.5 : 0.4);
      break;
    case 'finalSmash':
      if (W) {
        crouch(p, c, 0.7);
        arm(p, -1, -0.6, 0.2, -1.9);
        arm(p, 1, -0.6, 0.2, -1.9);
        j(p, HEAD, 0.3);
      } else {
        stance(p, c, 0.02, 0.12, 0.15);
        arm(p, -1, -2.5, 0.65, -0.1);
        arm(p, 1, -2.5, 0.65, -0.1);
        j(p, HEAD, -0.45);
        j(p, CHEST, -0.2);
        p[SQ] = 1.06;
      }
      c.handGlow = 1;
      break;
  }
  if (!c.grounded && !isAerial(move) && move !== 'uspecial' && move !== 'sspecial') {
    // airborne version of a grounded pose: tuck the legs a bit instead of planting them
    leg(p, -1, -0.8, 1.2, 0.3);
    leg(p, 1, 0.1, 0.8, 0.3);
    p[OY] = 0;
  }
}

export function isAerial(m: MoveId): boolean {
  return m === 'nair' || m === 'fair' || m === 'bair' || m === 'uair' || m === 'dair';
}

type Sw = (n: number) => number;

function castPose(p: Pose, c: PoseCtx, W: boolean): void {
  stance(p, c, 0.1, 0.22);
  if (W) {
    arm(p, -1, -0.6, -0.4, -1.9);
    arm(p, 1, -0.6, -0.4, -1.9);
    j(p, SPINE, 0.15);
    j(p, HEAD, 0.1);
  } else {
    arm(p, -1, -1.6, -0.12, 0, -0.3);
    arm(p, 1, -1.5, -0.05, 0, -0.3);
    j(p, SPINE, -0.12);
    j(p, CHEST, 0, 0.2);
  }
  c.handGlow = 1;
}

function nspecial(p: Pose, c: PoseCtx, W: boolean, a: number, sw: Sw): void {
  switch (c.style) {
    case 'zoner':
      castPose(p, c, W);
      break;
    case 'sword':
      stance(p, c, 0.12, 0.3);
      if (W) {
        arm(p, -1, 0.5, 0.4, -1.4, 1.2);
        j(p, CHEST, 0, -0.6);
      } else {
        arm(p, -1, -1.55, 0.0, 0, 1.55);
        j(p, CHEST, 0.15, 0.4);
        p[OX] = 0.15 * c.k;
      }
      arm(p, 1, 0.4, 0.4, -0.6);
      break;
    case 'bruiser':
      stance(p, c, 0.18, 0.3, 0.15);
      if (W) {
        arm(p, -1, 1.1, 0.4, -1.5);
        arm(p, 1, -1.2, 0.3, -0.6);
        j(p, SPINE, -0.2);
        j(p, CHEST, 0, -0.8);
      } else {
        arm(p, -1, -1.6, 0.0, 0);
        arm(p, 1, 0.8, 0.4, -0.8);
        j(p, SPINE, 0.45);
        j(p, CHEST, 0, 0.8);
        p[OX] = 0.3 * c.k;
      }
      break;
    case 'speedster':
      stance(p, c, W ? 0.3 : 0.1, 0.3);
      j(p, SPINE, W ? 0.6 : 0.3);
      arm(p, -1, W ? 0.9 : -1.6, 0.2, W ? -0.2 : 0, 0);
      arm(p, 1, W ? 0.9 : 0.8, 0.2, W ? -0.2 : -0.3);
      c.handGlow = 1;
      break;
    case 'trickster':
      // overhand sand-shot throw
      stance(p, c, 0.12, 0.22);
      arm(p, -1, W ? -2.7 : lerp(-2.7, -1.0, sw(3)), 0.2, W ? -1.3 : 0);
      arm(p, 1, -1.0, 0.4, -0.4);
      j(p, SPINE, W ? -0.25 : 0.35);
      j(p, CHEST, 0, W ? -0.5 : 0.4);
      break;
    default:
      // all-rounder: one-handed energy palm
      stance(p, c, 0.12, 0.25);
      if (W) {
        arm(p, -1, 0.5, 0.3, -1.8);
        j(p, CHEST, 0, -0.5);
      } else {
        arm(p, -1, -1.6, -0.05, 0, -0.4);
        j(p, CHEST, 0.05, 0.4);
      }
      arm(p, 1, -0.9, 0.2, -1.6);
      c.handGlow = 1;
  }
}

function sspecial(p: Pose, c: PoseCtx, W: boolean, a: number, sw: Sw): void {
  switch (c.style) {
    case 'speedster':
      // jet kick: body horizontal, leg leading
      if (W) {
        tuck(p);
        p[PITCH] = -0.2;
      } else {
        zero(p);
        p[PITCH] = 1.25;
        leg(p, -1, -1.45, 0.0, -0.4);
        leg(p, 1, -1.1, 1.3, 0.2);
        arm(p, -1, 0.9, 0.3, -0.1);
        arm(p, 1, 1.0, 0.3, -0.1);
        j(p, HEAD, -0.9);
      }
      break;
    case 'zoner':
      // side-arm lash / lob
      stance(p, c, 0.1, 0.22);
      arm(p, -1, W ? 0.9 : lerp(0.9, -1.65, sw(3)), 0.25, W ? -1.2 : -0.05, -0.4);
      arm(p, 1, W ? -0.8 : 0.6, 0.4, -0.8);
      j(p, SPINE, W ? -0.15 : 0.25);
      j(p, CHEST, 0, W ? -0.7 : 0.6);
      c.handGlow = 1;
      break;
    case 'sword':
      p[PITCH] = W ? 0 : 0.45;
      arm(p, -1, -1.45, 0.05, -0.1, 1.45);
      arm(p, 1, 0.8, 0.4, -0.2);
      j(p, CHEST, 0.1, W ? -1.0 : lerp(-1.0, 1.0, sw(4)));
      leg(p, -1, -1.0, 0.8, 0.2);
      leg(p, 1, 0.7, 0.4, 0.4);
      break;
    case 'bruiser':
      // shoulder charge / lunging grab
      p[PITCH] = W ? 0.15 : 0.55;
      if (c.id === 'rosa') {
        arm(p, -1, -1.5, -0.1, -0.3);
        arm(p, 1, -1.5, -0.1, -0.3);
      } else {
        j(p, CHEST, 0, 0.7);
        arm(p, -1, -0.3, -0.5, -1.8);
        arm(p, 1, 0.3, 0.3, -1.5);
      }
      leg(p, -1, -0.9, 0.9, 0.2);
      leg(p, 1, 0.7, 0.5, 0.3);
      break;
    case 'trickster':
      // cape-swirl dash
      p[PITCH] = W ? 0 : 0.5;
      arm(p, -1, 0.8, 0.6, -0.2);
      arm(p, 1, 0.8, 0.6, -0.2);
      leg(p, -1, -1.0, 1.2, 0.2);
      leg(p, 1, 0.5, 0.6, 0.3);
      c.spinOn = true;
      c.spinY = W ? 0 : sw(12) * PI * 2;
      break;
    default:
      // dash punch
      p[PITCH] = W ? 0 : 0.7;
      arm(p, -1, W ? 0.8 : -1.6, 0.1, W ? -1.6 : 0);
      arm(p, 1, 0.9, 0.3, -0.3);
      leg(p, -1, -0.7, 0.9, 0.2);
      leg(p, 1, 0.7, 0.4, 0.3);
      c.handGlow = 1;
  }
}

function uspecial(p: Pose, c: PoseCtx, W: boolean, a: number, sw: Sw): void {
  if (W) {
    crouch(p, c, 0.8);
    if (!c.grounded) tuck(p);
    return;
  }
  zero(p);
  switch (c.style) {
    case 'zoner':
      // float up in a glowing curl
      arm(p, -1, -2.9, 0.4, -0.3);
      arm(p, 1, -2.9, 0.4, -0.3);
      leg(p, -1, -0.2, 0.4, 0.8);
      leg(p, 1, 0.0, 0.3, 0.8);
      j(p, HEAD, -0.4);
      p[SQ] = 1.08;
      c.handGlow = 1;
      c.spinOn = true;
      c.spinY = a * 0.35;
      break;
    case 'sword':
      arm(p, -1, -1.5, 1.5, 0, 1.5);
      arm(p, 1, -2.6, 0.3, -0.2);
      leg(p, -1, -0.8, 1.2, 0.3);
      leg(p, 1, 0.1, 0.4, 0.5);
      c.spinOn = true;
      c.spinY = a * 0.5;
      break;
    case 'bruiser': {
      const v = -3.0;
      arm(p, -1, v, 0.2, -0.2);
      arm(p, 1, v, 0.2, -0.2);
      leg(p, -1, -0.9, 1.4, 0.3);
      leg(p, 1, 0.2, 0.5, 0.4);
      j(p, HEAD, -0.5);
      c.spinOn = true;
      c.spinY = a * 0.25;
      break;
    }
    case 'trickster':
      starfish(p);
      arm(p, -1, -2.6, 0.4, -0.1);
      arm(p, 1, -2.6, 0.4, -0.1);
      c.spinOn = true;
      c.spinY = a * 0.7;
      break;
    case 'speedster':
      tuck(p);
      arm(p, -1, -3.0, 0.1, 0);
      arm(p, 1, -3.0, 0.1, 0);
      leg(p, -1, 0, 0, 0.8, 0.05);
      leg(p, 1, 0, 0, 0.8, 0.05);
      j(p, SPINE, 0);
      j(p, HEAD, -0.3);
      p[SQ] = 1.1;
      c.spinOn = true;
      c.spinY = a * 0.8;
      break;
    default:
      // rising uppercut
      arm(p, -1, lerp(-1.4, -3.05, sw(3)), 0.05, -0.15);
      arm(p, 1, 0.4, 0.5, -1.0);
      leg(p, -1, -1.1, 1.5, 0.3);
      leg(p, 1, 0.3, 0.3, 0.6);
      j(p, HEAD, -0.5);
      p[SQ] = 1.08;
      c.spinOn = true;
      c.spinY = a * 0.3;
      c.handGlow = 1;
  }
}

function dspecial(p: Pose, c: PoseCtx, W: boolean, a: number, sw: Sw): void {
  switch (c.style) {
    case 'sword':
      // counter stance: blade held vertical
      stance(p, c, 0.15, 0.2);
      if (W) {
        arm(p, -1, -1.0, -0.3, -1.1, -0.2);
        arm(p, 1, -0.9, -0.3, -1.4);
        j(p, HEAD, 0.1);
      } else {
        arm(p, -1, lerp(-2.6, -0.4, sw(3)), 0.05, 0, 0.3);
        j(p, SPINE, 0.45);
        p[OX] = 0.15 * c.k;
      }
      break;
    case 'bruiser':
      // ground pound
      if (W) {
        stance(p, c, 0.05, 0.15, 0.2);
        arm(p, -1, -2.95, 0.15, -0.5);
        arm(p, 1, -2.95, 0.15, -0.5);
        j(p, SPINE, -0.25);
      } else {
        stance(p, c, 0.35, 0.12, 0.3);
        arm(p, -1, -0.5, 0.1, 0);
        arm(p, 1, -0.5, 0.1, 0);
        j(p, SPINE, 0.85);
        j(p, HEAD, -0.6);
      }
      break;
    case 'zoner':
      // field burst: arms spread, palms down
      stance(p, c, W ? 0.2 : 0.06, 0.15, 0.15);
      if (W) {
        arm(p, -1, -0.8, -0.3, -1.8);
        arm(p, 1, -0.8, -0.3, -1.8);
        j(p, SPINE, 0.3);
      } else {
        arm(p, -1, -1.0, 0.5, -0.1, 0.6);
        arm(p, 1, 0.9, 0.5, -0.1, 0.6);
        j(p, HEAD, -0.3);
        p[SQ] = 1.05;
      }
      c.handGlow = 1;
      break;
    case 'trickster':
      // decoy crouch under the cape
      crouch(p, c, 1.15);
      arm(p, -1, -1.4, -0.2, -1.6);
      arm(p, 1, -1.4, -0.2, -1.6);
      j(p, HEAD, 0.5);
      break;
    case 'speedster':
      // breakdance spin kick
      crouch(p, c, 1.2);
      leg(p, -1, -1.5, 0.1, -0.2, 0.5);
      arm(p, -1, -0.4, 0.3, -0.1);
      arm(p, 1, -0.4, 0.3, -0.1);
      c.spinOn = true;
      c.spinY = W ? 0 : a * 0.55;
      break;
    default:
      // counter: guard then open burst
      stance(p, c, 0.12, 0.2);
      if (W) {
        arm(p, -1, -1.3, -0.4, -1.5);
        arm(p, 1, -1.3, -0.4, -1.5);
        j(p, HEAD, 0.25);
      } else {
        arm(p, -1, -1.2, 1.1, -0.1);
        arm(p, 1, -1.2, 1.1, -0.1);
        j(p, HEAD, -0.25);
        j(p, CHEST, -0.15);
      }
      c.handGlow = 1;
  }
}
