/**
 * Move data model + per-fighter movesets (data-driven frame data).
 *
 * Frames are 1-based (moveFrame 1 = first frame of the move). Offsets (x, y) are from the
 * fighter's FEET, x facing-relative (+ = in front). Angles: 0 = forward, 90 = up, 361 = "sakurai".
 */
import type { HitKind, MoveId } from '../types';

export interface HitboxDef {
  f0: number;
  f1: number;
  x: number;
  y: number;
  r: number;
  dmg: number;
  ang: number;
  bkb: number;
  kbg: number;
  kind: HitKind;
  /** Hit group: one hit per group per victim per move instance. */
  g: number;
}

export interface ProjSpec {
  /** First spawn frame; repeats every `every` frames until `until` (inclusive). */
  f: number;
  every?: number;
  until?: number;
  kind: string;
  color: string;
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  grav?: number;
  life: number;
  dmg: number;
  ang: number;
  bkb: number;
  kbg: number;
  hitKind?: HitKind;
  /** Homing steering accel (world/frame²). */
  homing?: number;
  /** Ground bounces before dying (default 0 = dies on ground unless `stick`). */
  bounce?: number;
  /** Rests on the ground instead of dying. */
  stick?: boolean;
  /** Explodes (radius) on hit / end of life. */
  explodeR?: number;
  /** Doesn't vanish when it hits. */
  pierce?: boolean;
  /** Damage scaled by the move's charge (1 + chargeBonus * charge). */
  chargeScale?: boolean;
  /** Max simultaneous projectiles of this kind for the owner. */
  maxActive?: number;
  /** Spawn at a random x over the main stage, high up (rain). */
  rain?: boolean;
  /** Decoy: sits still and bursts when an opponent touches it. */
  decoy?: boolean;
}

export interface VelKey {
  f: number;
  until?: number;
  vx?: number;
  vy?: number;
}

export interface MoveDef {
  key: string;
  id: MoveId;
  total: number;
  hits: HitboxDef[];
  grab?: { f0: number; f1: number; x: number; y: number; r: number; command?: string };
  /** Throw: victim released at frame `f` with this hit. */
  throwHit?: { f: number; dmg: number; ang: number; bkb: number; kbg: number };
  /** Damage applied directly at frame f (pummel). */
  pummel?: { f: number; dmg: number };
  landLag?: number;
  intan?: [number, number];
  armor?: [number, number];
  chargeAt?: number;
  chargeMax?: number;
  chargeBonus?: number;
  chargeBtn?: 'attack' | 'special';
  vel?: VelKey[];
  /** Gravity multiplier during the move (until gravUntil, default whole move). */
  grav?: number;
  gravUntil?: number;
  /** Air drift multiplier. */
  drift?: number;
  /** Horizontal stick steering speed during the move (recoveries). */
  steer?: number;
  helpless?: boolean;
  /** Air-started move ends on landing (default true). */
  landCancel?: boolean;
  ledgeFrom?: number;
  proj?: ProjSpec[];
  counter?: [number, number];
  counterMove?: string;
  reflect?: [number, number, number];
  teleport?: { f: number; dist: number; foe?: boolean }[];
  /** Chain into another move by pressing `btn` from frame `from`. */
  next?: { key: string; from: number; btn: 'attack' | 'special' };
  /** vy set on the attacker when this move hits (bounce off foes). */
  bounceOnHit?: number;
  /** Fast fall allowed (aerials). */
  aerial?: boolean;
  final?: boolean;
  /** Turns the victim around on hit. */
  turnVictim?: boolean;
  // ---- derived ----
  firstActive: number;
  lastActive: number;
  maxDmg: number;
}

export type MoveSet = Record<string, MoveDef>;

type HbIn = [number, number, number, number, number, number, number, number, number, number?, HitKind?];

function hb(a: HbIn, kind: HitKind, sc: Scale): HitboxDef {
  const [f0, f1, x, y, r, dmg, ang, bkb, kbg, g, k] = a;
  return {
    f0: F(f0, sc),
    f1: Math.max(F(f0, sc), F(f1, sc)),
    x: x * sc.re,
    y: y * sc.hy,
    r: r * Math.sqrt(sc.re),
    dmg: Math.round(dmg * sc.pw * 10) / 10,
    ang,
    bkb,
    kbg: Math.round(kbg * (1 - (sc.pw - 1) * 0.5)),
    kind: k ?? kind,
    g: g ?? 0,
  };
}

interface Scale {
  pw: number; // damage
  sp: number; // frames
  re: number; // horizontal reach
  hy: number; // vertical (fighter height / 1.8)
  kind: HitKind;
}

function F(n: number, sc: Scale): number {
  return Math.max(1, Math.round(n * sc.sp));
}

type MoveIn = Partial<Omit<MoveDef, 'hits' | 'key' | 'id' | 'firstActive' | 'lastActive' | 'maxDmg'>> & {
  total: number;
  hits?: HbIn[];
  raw?: boolean; // don't scale (specials)
};

const UNIT: Scale = { pw: 1, sp: 1, re: 1, hy: 1, kind: 'normal' };

function mk(key: string, id: MoveId, m: MoveIn, sc: Scale): MoveDef {
  const s = m.raw ? { ...UNIT, kind: sc.kind, hy: sc.hy } : sc;
  const hits = (m.hits ?? []).map((h) => hb(h, s.kind, s));
  const d: MoveDef = {
    ...(m as object),
    key,
    id,
    total: m.raw ? m.total : F(m.total, s),
    hits,
    landLag: m.landLag,
    firstActive: 0,
    lastActive: 0,
    maxDmg: 0,
  } as MoveDef;
  if (!m.raw && d.chargeAt) d.chargeAt = F(d.chargeAt, s);
  if (!m.raw && d.grab) d.grab = { ...d.grab, f0: F(d.grab.f0, s), f1: F(d.grab.f1, s) };
  if (!m.raw && d.next) d.next = { ...d.next, from: F(d.next.from, s) };
  if (!m.raw && d.intan) d.intan = [F(d.intan[0], s), F(d.intan[1], s)];
  if (!m.raw && d.vel) d.vel = d.vel.map((v) => ({ ...v, f: F(v.f, s), until: v.until != null ? F(v.until, s) : undefined }));
  derive(d);
  return d;
}

function derive(d: MoveDef): void {
  let first = 1e9;
  let last = 0;
  let mx = 0;
  for (const h of d.hits) {
    first = Math.min(first, h.f0);
    last = Math.max(last, h.f1);
    mx = Math.max(mx, h.dmg);
  }
  if (d.grab) {
    first = Math.min(first, d.grab.f0);
    last = Math.max(last, d.grab.f1);
  }
  if (d.proj) for (const p of d.proj) {
    first = Math.min(first, p.f);
    last = Math.max(last, p.until ?? p.f);
    mx = Math.max(mx, p.dmg);
  }
  if (d.throwHit) {
    first = Math.min(first, d.throwHit.f);
    last = Math.max(last, d.throwHit.f);
    mx = Math.max(mx, d.throwHit.dmg);
  }
  if (d.counter) {
    first = Math.min(first, d.counter[0]);
    last = Math.max(last, d.counter[1]);
  }
  if (d.reflect) {
    first = Math.min(first, d.reflect[0]);
    last = Math.max(last, d.reflect[1]);
  }
  if (first === 1e9) {
    first = 1;
    last = 0;
  }
  d.firstActive = first;
  d.lastActive = last;
  d.maxDmg = mx;
}

// ---------------------------------------------------------------------------
// Shared normal moves (scaled per fighter)
// ---------------------------------------------------------------------------

interface Normals {
  [key: string]: { id: MoveId; m: MoveIn };
}

function baseNormals(): Normals {
  return {
    jab1: { id: 'jab1', m: { total: 17, hits: [[3, 4, 0.75, 1.05, 0.45, 2.5, 75, 16, 25]], next: { key: 'jab2', from: 6, btn: 'attack' } } },
    jab2: { id: 'jab2', m: { total: 19, hits: [[3, 4, 0.8, 1.05, 0.45, 2, 75, 18, 25]], next: { key: 'jab3', from: 6, btn: 'attack' } } },
    jab3: { id: 'jab3', m: { total: 32, hits: [[4, 6, 0.85, 1.0, 0.55, 5, 45, 42, 90]] } },
    dashAttack: { id: 'dashAttack', m: { total: 36, hits: [[6, 9, 0.8, 0.9, 0.6, 10, 50, 55, 60], [10, 14, 0.8, 0.9, 0.5, 6, 60, 45, 50]], vel: [{ f: 1, until: 12, vx: 0.2 }] } },
    ftilt: { id: 'ftilt', m: { total: 28, hits: [[6, 8, 1.0, 1.0, 0.5, 9, 32, 30, 85], [6, 8, 0.45, 1.0, 0.4, 8, 32, 30, 85]] } },
    utilt: { id: 'utilt', m: { total: 28, hits: [[5, 7, 0.6, 1.6, 0.55, 6, 95, 40, 110], [8, 10, 0.0, 2.0, 0.6, 6, 95, 40, 110], [11, 12, -0.5, 1.6, 0.5, 5, 100, 40, 100]] } },
    dtilt: { id: 'dtilt', m: { total: 22, hits: [[5, 7, 1.0, 0.25, 0.45, 6, 78, 35, 60]] } },
    fsmash: { id: 'fsmash', m: { total: 50, chargeAt: 7, hits: [[14, 16, 1.2, 1.0, 0.6, 16, 38, 25, 78], [14, 16, 0.55, 1.0, 0.45, 14, 38, 25, 76]] } },
    usmash: { id: 'usmash', m: { total: 46, chargeAt: 6, hits: [[10, 14, 0.15, 2.05, 0.75, 15, 88, 32, 90], [10, 14, 0.4, 1.2, 0.5, 13, 88, 32, 88]] } },
    dsmash: { id: 'dsmash', m: { total: 46, chargeAt: 5, hits: [[10, 12, 1.0, 0.3, 0.55, 13, 28, 30, 78], [10, 12, -1.0, 0.3, 0.55, 13, 152, 30, 78], [15, 17, -1.1, 0.3, 0.5, 11, 152, 30, 72]] } },
    nair: { id: 'nair', m: { total: 36, landLag: 8, aerial: true, hits: [[5, 8, 0.2, 1.0, 0.8, 9, 45, 25, 90], [9, 20, 0.2, 1.0, 0.75, 5, 45, 15, 70]] } },
    fair: { id: 'fair', m: { total: 40, landLag: 14, aerial: true, hits: [[12, 15, 0.95, 0.9, 0.55, 13, 40, 30, 82], [12, 15, 0.45, 1.1, 0.45, 11, 40, 30, 80]] } },
    bair: { id: 'bair', m: { total: 30, landLag: 9, aerial: true, hits: [[6, 9, -1.0, 1.0, 0.55, 11, 145, 20, 88], [10, 14, -0.9, 1.0, 0.5, 7, 145, 15, 70]] } },
    uair: { id: 'uair', m: { total: 30, landLag: 8, aerial: true, hits: [[5, 9, 0.2, 2.0, 0.6, 7, 80, 30, 100]] } },
    dair: { id: 'dair', m: { total: 40, landLag: 16, aerial: true, hits: [[14, 17, 0.1, -0.1, 0.55, 13, 280, 25, 72], [18, 24, 0.1, 0.0, 0.5, 9, 70, 25, 60]] } },
    grab: { id: 'grab', m: { total: 30, grab: { f0: 7, f1: 8, x: 0.85, y: 1.0, r: 0.55 } } },
    dashGrab: { id: 'grab', m: { total: 38, grab: { f0: 9, f1: 10, x: 1.15, y: 1.0, r: 0.6 }, vel: [{ f: 1, until: 8, vx: 0.12 }] } },
    pummel: { id: 'pummel', m: { total: 14, pummel: { f: 3, dmg: 1.4 } } },
    fthrow: { id: 'fthrow', m: { total: 28, throwHit: { f: 10, dmg: 8, ang: 40, bkb: 60, kbg: 65 } } },
    bthrow: { id: 'bthrow', m: { total: 32, throwHit: { f: 13, dmg: 10, ang: 140, bkb: 60, kbg: 72 } } },
    uthrow: { id: 'uthrow', m: { total: 30, throwHit: { f: 12, dmg: 7, ang: 90, bkb: 65, kbg: 62 } } },
    dthrow: { id: 'dthrow', m: { total: 30, throwHit: { f: 14, dmg: 6, ang: 72, bkb: 55, kbg: 42 } } },
    getupAttack: { id: 'getupAttack', m: { total: 40, intan: [1, 20], hits: [[15, 17, 0.9, 0.5, 0.6, 7, 35, 60, 30], [18, 20, -0.9, 0.5, 0.6, 7, 145, 60, 30]] } },
    ledgeAttack: { id: 'ledgeAttack', m: { total: 50, intan: [1, 24], hits: [[24, 27, 0.9, 0.6, 0.6, 9, 35, 70, 20]] } },
    itemSwing: { id: 'itemSwing', m: { total: 44, chargeAt: 6, raw: true, hits: [[14, 17, 1.4, 1.0, 0.8, 17, 40, 42, 88, 0, 'bat'], [14, 17, 0.6, 1.0, 0.55, 15, 40, 42, 86, 0, 'bat']] } },
    itemThrow: { id: 'itemThrow', m: { total: 20, raw: true } },
  };
}

// ---------------------------------------------------------------------------
// Per-fighter kits
// ---------------------------------------------------------------------------

interface Kit {
  scale: Partial<Scale>;
  height: number;
  /** Override / add normal moves. */
  normals?: Normals;
  specials: Normals;
}

const C = {
  wind: '#9ad7ff',
  rock: '#8a6a4a',
  quake: '#c9a36b',
  bolt: '#ffe04d',
  spark: '#b98cff',
  beam: '#fff27a',
  fire: '#ff8a2a',
  decoy: '#ffd46b',
  gum: '#ff5fb0',
  candy: '#6dffcf',
  horn: '#ffffff',
  water: '#4fc3ff',
};

const KITS: Record<string, Kit> = {
  // ===================================================================== MAX (all-rounder)
  max: {
    scale: {},
    height: 1.8,
    specials: {
      nspecial: { id: 'nspecial', m: { total: 38, raw: true, grav: 0.6, proj: [{ f: 12, kind: 'orb', color: C.wind, x: 0.8, y: 1.1, r: 0.35, vx: 0.22, vy: 0, grav: 0.012, bounce: 3, life: 100, dmg: 5, ang: 45, bkb: 25, kbg: 45, maxActive: 2 }] } },
      sspecial: { id: 'sspecial', m: { total: 36, raw: true, grav: 0.4, gravUntil: 20, vel: [{ f: 1, vy: 0.04 }], reflect: [8, 18, 1.1], turnVictim: true, hits: [[10, 14, 0.9, 1.0, 0.65, 7, 60, 40, 50]] } },
      uspecial: {
        id: 'uspecial',
        m: {
          total: 48, raw: true, helpless: true, ledgeFrom: 8, steer: 0.07, landLag: 18,
          vel: [{ f: 4, vx: 0.07, vy: 0.36 }],
          hits: [[4, 6, 0.4, 1.3, 0.7, 3, 85, 60, 10, 0], [7, 9, 0.3, 1.6, 0.7, 2, 85, 55, 10, 1], [10, 12, 0.3, 1.7, 0.7, 2, 85, 55, 10, 2], [13, 16, 0.3, 1.8, 0.75, 5, 80, 40, 108, 3]],
        },
      },
      dspecial: {
        id: 'dspecial',
        m: {
          total: 50, raw: true, grav: 0.35, drift: 1.2,
          hits: [[6, 7, 0, 1.0, 1.15, 2, 90, 35, 0, 0], [12, 13, 0, 1.0, 1.15, 2, 90, 35, 0, 1], [18, 19, 0, 1.0, 1.15, 2, 90, 35, 0, 2], [24, 25, 0, 1.0, 1.15, 2, 90, 35, 0, 3], [32, 35, 0, 1.0, 1.25, 5, 45, 50, 92, 4]],
        },
      },
      finalSmash: {
        id: 'finalSmash',
        m: {
          total: 120, raw: true, final: true, intan: [1, 120], grav: 0,
          vel: [{ f: 10, until: 96, vx: 0.13, vy: 0 }],
          hits: [
            ...[0, 1, 2, 3, 4, 5, 6].map((i) => [12 + i * 11, 13 + i * 11, 0.6, 1.3, 2.4, 3, 88, 48, 0, i] as HbIn),
            [96, 100, 0.6, 1.4, 2.8, 12, 48, 25, 125, 7],
          ],
        },
      },
    },
  },
  // ===================================================================== BRAM (heavy bruiser)
  bram: {
    scale: { pw: 1.3, sp: 1.22, re: 1.18 },
    height: 2.1,
    specials: {
      nspecial: { id: 'nspecial', m: { total: 52, raw: true, grav: 0.6, proj: [{ f: 20, kind: 'rock', color: C.rock, x: 0.9, y: 1.6, r: 0.55, vx: 0.2, vy: 0.2, grav: 0.012, bounce: 1, life: 120, dmg: 12, ang: 45, bkb: 40, kbg: 70, maxActive: 1 }] } },
      sspecial: { id: 'sspecial', m: { total: 48, raw: true, armor: [5, 30], grav: 0.3, gravUntil: 30, vel: [{ f: 8, until: 28, vx: 0.28, vy: 0 }], hits: [[8, 28, 0.75, 1.1, 0.75, 12, 40, 45, 72]] } },
      uspecial: {
        id: 'uspecial',
        m: {
          total: 64, raw: true, helpless: true, ledgeFrom: 14, steer: 0.06, landLag: 20,
          vel: [{ f: 6, vx: 0.06, vy: 0.4 }],
          hits: [[6, 12, 0.3, 1.6, 0.95, 8, 80, 60, 55, 0], [13, 22, 0.2, 2.0, 0.8, 5, 80, 50, 50, 0]],
        },
      },
      dspecial: {
        id: 'dspecial',
        m: {
          total: 50, raw: true, grav: 1.4,
          hits: [[16, 18, 1.3, 0.3, 0.95, 14, 75, 50, 72], [16, 18, -1.3, 0.3, 0.95, 14, 105, 50, 72]],
          proj: [
            { f: 17, kind: 'wave', color: C.quake, x: 1.4, y: 0.35, r: 0.5, vx: 0.2, vy: 0, life: 40, dmg: 8, ang: 70, bkb: 45, kbg: 55, pierce: true },
            { f: 17, kind: 'wave', color: C.quake, x: -1.4, y: 0.35, r: 0.5, vx: -0.2, vy: 0, life: 40, dmg: 8, ang: 70, bkb: 45, kbg: 55, pierce: true },
          ],
        },
      },
      finalSmash: {
        id: 'finalSmash',
        m: {
          total: 110, raw: true, final: true, intan: [1, 110], grav: 0,
          hits: [
            ...[-10, -6, -2, 2, 6, 10].map((x) => [30, 32, x, 0.6, 2.3, 9, 90, 62, 0, 0] as HbIn),
            ...[-10, -6, -2, 2, 6, 10].map((x) => [62, 64, x, 0.8, 2.6, 24, 82, 30, 112, 1] as HbIn),
          ],
        },
      },
    },
  },
  // ===================================================================== ZIPPY (speedster)
  zippy: {
    scale: { pw: 0.8, sp: 0.82, re: 0.92 },
    height: 1.6,
    normals: {
      nair: {
        id: 'nair',
        m: { total: 34, landLag: 7, aerial: true, hits: [[4, 5, 0.1, 0.9, 0.75, 2, 361, 30, 10, 0], [8, 9, 0.1, 0.9, 0.75, 2, 361, 30, 10, 1], [12, 13, 0.1, 0.9, 0.75, 2, 361, 30, 10, 2], [17, 19, 0.1, 0.9, 0.8, 5, 45, 30, 95, 3]] },
      },
      uair: { id: 'uair', m: { total: 26, landLag: 6, aerial: true, hits: [[4, 8, 0.1, 1.9, 0.65, 7, 82, 30, 95]] } },
    },
    specials: {
      nspecial: {
        id: 'nspecial',
        m: {
          total: 44, raw: true, grav: 0.3, gravUntil: 30, vel: [{ f: 6, until: 30, vx: 0.28 }],
          hits: [...[0, 1, 2, 3, 4].map((i) => [6 + i * 5, 8 + i * 5, 0.2, 0.8, 0.7, 2, 60, 30, 15, i] as HbIn), [31, 33, 0.3, 0.8, 0.75, 4, 45, 45, 75, 5]],
        },
      },
      sspecial: { id: 'sspecial', m: { total: 34, raw: true, grav: 0, gravUntil: 18, vel: [{ f: 5, until: 14, vx: 0.5, vy: 0 }, { f: 15, vx: 0.1 }], hits: [[5, 14, 0.4, 0.8, 0.7, 8, 40, 45, 62]] } },
      uspecial: {
        id: 'uspecial',
        m: {
          total: 50, raw: true, helpless: true, ledgeFrom: 10, steer: 0.09, landLag: 16,
          vel: [{ f: 5, until: 26, vy: 0.33 }],
          grav: 0, gravUntil: 27,
          hits: [...[0, 1, 2, 3].map((i) => [5 + i * 6, 7 + i * 6, 0, 1.0, 0.8, 2, 88, 55, 10, i] as HbIn), [27, 29, 0, 1.2, 0.85, 4, 75, 45, 92, 4]],
        },
      },
      dspecial: { id: 'dspecial', m: { total: 40, raw: true, landLag: 14, bounceOnHit: 0.26, vel: [{ f: 8, until: 30, vx: 0.18, vy: -0.22 }], grav: 0, gravUntil: 30, hits: [[8, 30, 0.45, 0.3, 0.55, 9, 50, 40, 60]] } },
      finalSmash: {
        id: 'finalSmash',
        m: {
          total: 120, raw: true, final: true, intan: [1, 120], grav: 0,
          vel: [{ f: 10, until: 38, vx: 0.5, vy: 0 }, { f: 39, until: 68, vx: -0.5 }, { f: 69, until: 98, vx: 0.5 }, { f: 99, vx: 0 }],
          hits: [...Array.from({ length: 14 }, (_, i) => [10 + i * 6, 12 + i * 6, 0, 1.0, 1.5, 2.5, 80, 40, 0, i] as HbIn), [102, 106, 0, 1.0, 3.0, 9, 45, 25, 122, 14]],
        },
      },
    },
  },
  // ===================================================================== KAI (sword)
  kai: {
    scale: { pw: 1.05, sp: 1.05, re: 1.38, kind: 'sword' },
    height: 1.85,
    specials: {
      nspecial: { id: 'nspecial', m: { total: 50, raw: true, chargeAt: 8, chargeMax: 60, chargeBonus: 1.0, chargeBtn: 'special', grav: 0.5, hits: [[18, 21, 1.45, 1.0, 0.85, 10, 38, 35, 85, 0, 'sword'], [18, 21, 0.6, 1.0, 0.6, 9, 38, 35, 85, 0, 'sword']] } },
      sspecial: { id: 'sspecial', m: { total: 30, raw: true, grav: 0.4, vel: [{ f: 1, vy: 0.05 }], hits: [[7, 9, 1.3, 1.1, 0.7, 4, 70, 30, 30, 0, 'sword']], next: { key: 'sspecial2', from: 11, btn: 'special' } } },
      sspecial2: { id: 'sspecial', m: { total: 30, raw: true, grav: 0.4, vel: [{ f: 1, vy: 0.05 }], hits: [[6, 8, 1.3, 1.3, 0.7, 4, 75, 30, 30, 0, 'sword']], next: { key: 'sspecial3', from: 10, btn: 'special' } } },
      sspecial3: { id: 'sspecial', m: { total: 40, raw: true, grav: 0.5, hits: [[8, 11, 1.4, 1.0, 0.8, 7, 40, 45, 88, 0, 'sword']] } },
      uspecial: {
        id: 'uspecial',
        m: {
          total: 55, raw: true, helpless: true, ledgeFrom: 12, steer: 0.07, landLag: 20,
          vel: [{ f: 5, vx: 0.05, vy: 0.38 }],
          hits: [[5, 8, 0.6, 1.4, 0.8, 6, 85, 70, 20, 0, 'sword'], [9, 20, 0.5, 2.0, 0.75, 3, 80, 50, 30, 1, 'sword'], [21, 24, 0.5, 2.2, 0.8, 5, 70, 45, 95, 2, 'sword']],
        },
      },
      dspecial: { id: 'dspecial', m: { total: 42, raw: true, grav: 0.3, counter: [5, 26], counterMove: 'counterStrike' } },
      counterStrike: { id: 'dspecial', m: { total: 34, raw: true, grav: 0.2, intan: [1, 16], hits: [[6, 9, 1.1, 1.0, 1.0, 10, 40, 50, 82, 0, 'sword'], [6, 9, -0.6, 1.0, 0.8, 10, 40, 50, 82, 0, 'sword']] } },
      finalSmash: {
        id: 'finalSmash',
        m: {
          total: 100, raw: true, final: true, intan: [1, 100], grav: 0,
          hits: [
            ...[1.5, 4, 6.5, 9, 11.5, 14].map((x) => [20, 24, x, 1.1, 1.6, 14, 90, 62, 0, 0, 'sword'] as HbIn),
            ...[1.5, 4, 6.5, 9, 11.5, 14].map((x) => [50, 54, x, 1.4, 1.9, 20, 40, 30, 115, 1, 'sword'] as HbIn),
          ],
        },
      },
    },
  },
  // ===================================================================== JUNO (projectile zoner)
  juno: {
    scale: { pw: 0.95, sp: 1.0, re: 1.0, kind: 'normal' },
    height: 1.8,
    specials: {
      nspecial: {
        id: 'nspecial',
        m: { total: 34, raw: true, chargeAt: 6, chargeMax: 90, chargeBonus: 2.0, chargeBtn: 'special', grav: 0.5, proj: [{ f: 12, kind: 'bolt', color: C.bolt, x: 0.9, y: 1.1, r: 0.3, vx: 0.45, vy: 0, life: 70, dmg: 6, ang: 40, bkb: 25, kbg: 70, hitKind: 'electric', chargeScale: true }] },
      },
      sspecial: { id: 'sspecial', m: { total: 40, raw: true, grav: 0.5, proj: [{ f: 14, kind: 'spark', color: C.spark, x: 0.8, y: 1.2, r: 0.35, vx: 0.12, vy: 0, life: 150, dmg: 7, ang: 60, bkb: 40, kbg: 50, hitKind: 'electric', homing: 0.006, maxActive: 1 }] } },
      uspecial: {
        id: 'uspecial',
        m: { total: 46, raw: true, helpless: true, ledgeFrom: 10, steer: 0.08, landLag: 18, vel: [{ f: 6, vx: 0.08, vy: 0.42 }], hits: [[6, 14, 0, 1.4, 0.85, 7, 80, 50, 70, 0, 'electric']] },
      },
      dspecial: { id: 'dspecial', m: { total: 40, raw: true, grav: 0.35, hits: [[8, 14, 0, 1.0, 1.5, 8, 50, 55, 55, 0, 'electric']] } },
      finalSmash: {
        id: 'finalSmash',
        m: {
          total: 140, raw: true, final: true, intan: [1, 140], grav: 0,
          proj: [
            { f: 30, every: 6, until: 90, kind: 'beam', color: C.beam, x: 1.2, y: 1.1, r: 1.25, vx: 0.9, vy: 0, life: 28, dmg: 2, ang: 15, bkb: 35, kbg: 0, hitKind: 'electric', pierce: true },
            { f: 96, kind: 'beam', color: C.beam, x: 1.2, y: 1.1, r: 1.7, vx: 0.9, vy: 0, life: 30, dmg: 13, ang: 30, bkb: 28, kbg: 122, hitKind: 'electric', pierce: true },
          ],
        },
      },
    },
  },
  // ===================================================================== FENNEC (trickster)
  fennec: {
    scale: { pw: 0.92, sp: 0.9, re: 0.95 },
    height: 1.6,
    specials: {
      nspecial: { id: 'nspecial', m: { total: 30, raw: true, grav: 0.5, proj: [{ f: 8, kind: 'decoy', color: C.decoy, x: 0.9, y: 0.8, r: 0.7, vx: 0, vy: 0, grav: 0.01, stick: true, life: 180, dmg: 10, ang: 60, bkb: 50, kbg: 60, explodeR: 1.4, decoy: true, maxActive: 1, hitKind: 'explosion' }] } },
      sspecial: { id: 'sspecial', m: { total: 36, raw: true, grav: 0.5, proj: [{ f: 12, kind: 'wisp', color: C.fire, x: 0.8, y: 1.0, r: 0.35, vx: 0.2, vy: 0, life: 120, dmg: 8, ang: 45, bkb: 35, kbg: 60, hitKind: 'fire', homing: 0.008, maxActive: 2 }] } },
      uspecial: {
        id: 'uspecial',
        m: { total: 40, raw: true, helpless: true, ledgeFrom: 17, landLag: 16, intan: [4, 18], grav: 0, gravUntil: 20, vel: [{ f: 1, vx: 0, vy: 0 }], teleport: [{ f: 16, dist: 7.5 }], hits: [[17, 19, 0, 0.9, 0.85, 6, 70, 50, 60]] },
      },
      dspecial: { id: 'dspecial', m: { total: 30, raw: true, grav: 0.2, reflect: [4, 20, 1.3], hits: [[4, 6, 0, 0.9, 1.0, 5, 80, 50, 40]] } },
      finalSmash: {
        id: 'finalSmash',
        m: {
          total: 110, raw: true, final: true, intan: [1, 110], grav: 0, vel: [{ f: 1, vx: 0, vy: 0 }],
          teleport: [{ f: 20, dist: 0, foe: true }, { f: 45, dist: 0, foe: true }, { f: 70, dist: 0, foe: true }],
          hits: [[21, 24, 0.6, 1.0, 1.5, 10, 45, 50, 0, 0, 'fire'], [46, 49, 0.6, 1.0, 1.5, 10, 45, 50, 0, 1, 'fire'], [71, 75, 0.6, 1.0, 1.8, 14, 40, 30, 118, 2, 'fire']],
        },
      },
    },
  },
  // ===================================================================== PIXEL (gum zoner, rougher)
  pixel: {
    scale: { pw: 0.88, sp: 0.95, re: 0.9 },
    height: 1.55,
    specials: {
      nspecial: { id: 'nspecial', m: { total: 40, raw: true, grav: 0.5, proj: [{ f: 14, kind: 'gum', color: C.gum, x: 0.7, y: 1.1, r: 0.4, vx: 0.14, vy: 0.18, grav: 0.01, stick: true, life: 90, dmg: 10, ang: 70, bkb: 40, kbg: 65, explodeR: 1.4, maxActive: 2, hitKind: 'explosion' }] } },
      sspecial: { id: 'sspecial', m: { total: 40, raw: true, grav: 0.3, gravUntil: 30, vel: [{ f: 6, until: 30, vx: 0.3, vy: 0 }], hits: [[6, 30, 0.5, 0.7, 0.6, 7, 45, 50, 50]] } },
      uspecial: {
        id: 'uspecial',
        m: { total: 60, raw: true, helpless: true, ledgeFrom: 8, steer: 0.1, landLag: 16, grav: 0, gravUntil: 42, vel: [{ f: 8, until: 42, vy: 0.2 }], hits: [[42, 45, 0, 2.0, 1.1, 8, 80, 50, 70]] },
      },
      dspecial: {
        id: 'dspecial',
        m: {
          total: 40, raw: true, grav: 0.5,
          proj: [
            { f: 12, kind: 'candy', color: C.candy, x: 0.4, y: 1.0, r: 0.25, vx: 0.08, vy: 0.2, grav: 0.012, stick: true, life: 80, dmg: 4, ang: 70, bkb: 40, kbg: 30 },
            { f: 12, kind: 'candy', color: C.candy, x: 0.4, y: 1.0, r: 0.25, vx: 0.15, vy: 0.17, grav: 0.012, stick: true, life: 80, dmg: 4, ang: 70, bkb: 40, kbg: 30 },
            { f: 12, kind: 'candy', color: C.candy, x: -0.3, y: 1.0, r: 0.25, vx: -0.07, vy: 0.2, grav: 0.012, stick: true, life: 80, dmg: 4, ang: 110, bkb: 40, kbg: 30 },
          ],
        },
      },
      finalSmash: {
        id: 'finalSmash',
        m: {
          total: 120, raw: true, final: true, intan: [1, 120], grav: 0, vel: [{ f: 1, vx: 0, vy: 0 }],
          proj: [
            { f: 20, every: 7, until: 90, kind: 'gum', color: C.gum, x: 0, y: 0, r: 0.75, vx: 0, vy: -0.12, grav: 0.004, life: 160, dmg: 6, ang: 80, bkb: 45, kbg: 0, explodeR: 1.9, rain: true, hitKind: 'explosion' },
            { f: 96, kind: 'gum', color: C.gum, x: 0, y: 0, r: 1.0, vx: 0, vy: -0.16, grav: 0.004, life: 160, dmg: 12, ang: 60, bkb: 28, kbg: 118, explodeR: 3.2, rain: true, hitKind: 'explosion' },
          ],
        },
      },
    },
  },
  // ===================================================================== ROSA (grappler, rougher)
  rosa: {
    scale: { pw: 1.2, sp: 1.14, re: 1.1 },
    height: 2.0,
    specials: {
      nspecial: { id: 'nspecial', m: { total: 44, raw: true, grav: 0.5, hits: [[12, 18, 1.3, 1.1, 1.5, 4, 30, 72, 20]] } },
      sspecial: {
        id: 'sspecial',
        m: { total: 50, raw: true, chargeAt: 6, chargeMax: 50, chargeBonus: 0.5, chargeBtn: 'special', armor: [1, 34], grav: 0.3, gravUntil: 34, vel: [{ f: 8, until: 34, vx: 0.32, vy: 0 }], hits: [[8, 34, 0.75, 1.0, 0.8, 11, 40, 50, 70]] },
      },
      uspecial: {
        id: 'uspecial',
        m: {
          total: 50, raw: true, helpless: true, ledgeFrom: 8, steer: 0.08, landLag: 18,
          vel: [{ f: 5, vx: 0.1, vy: 0.4 }],
          hits: [[5, 9, 0.2, 1.2, 0.95, 3, 85, 60, 10, 0], [10, 14, 0.2, 1.4, 0.95, 3, 85, 60, 10, 1], [15, 20, 0.2, 1.6, 0.95, 3, 85, 60, 10, 2], [21, 24, 0.2, 1.8, 1.0, 6, 60, 45, 88, 3]],
        },
      },
      dspecial: { id: 'dspecial', m: { total: 50, raw: true, grav: 0.5, grab: { f0: 10, f1: 13, x: 0.95, y: 1.0, r: 0.75, command: 'towSlam' } } },
      towSlam: { id: 'dspecial', m: { total: 40, raw: true, intan: [1, 20], throwHit: { f: 22, dmg: 14, ang: 75, bkb: 60, kbg: 68 } } },
      finalSmash: {
        id: 'finalSmash',
        m: {
          total: 110, raw: true, final: true, intan: [1, 110], grav: 0,
          vel: [{ f: 20, until: 82, vx: 0.42, vy: 0 }, { f: 83, vx: 0 }],
          hits: [...[0, 1, 2, 3, 4, 5].map((i) => [20 + i * 10, 23 + i * 10, 0.5, 1.1, 1.9, 4, 70, 50, 0, i] as HbIn), [84, 88, 0.6, 1.2, 2.4, 12, 40, 30, 120, 6]],
        },
      },
    },
  },
};

const CACHE: Record<string, MoveSet> = {};

/** All moves of a fighter (cached). Unknown ids fall back to max. */
export function getMoveSet(fighterId: string): MoveSet {
  const id = KITS[fighterId] ? fighterId : 'max';
  if (CACHE[id]) return CACHE[id];
  const kit = KITS[id];
  const sc: Scale = { ...UNIT, ...kit.scale, hy: kit.height / 1.8 };
  const set: MoveSet = {};
  const all: Normals = { ...baseNormals(), ...(kit.normals ?? {}), ...kit.specials };
  for (const key of Object.keys(all)) {
    const { id: mid, m } = all[key];
    set[key] = mk(key, mid, m, sc);
  }
  CACHE[id] = set;
  return set;
}

/** For tests: every fighter id that has a kit. */
export const KIT_IDS = Object.keys(KITS);
