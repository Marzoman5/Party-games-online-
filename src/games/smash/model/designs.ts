/**
 * The 8 Smash Party fighter designs (original characters from the Kart Party roster).
 * Each design fills per-joint geometry batches in the joint's LOCAL frame:
 *   body faces +z, +y up, character's LEFT = +x, RIGHT = -x (the right side faces the camera).
 *   Limbs hang down -y from their joint. Head geometry sits above the neck joint.
 * Built once per character id and cached (geometries shared by every instance).
 */
import * as THREE from 'three';
import { GeoBatch, U } from './geo';
import type { Archetype } from '../types';

export const PART_NAMES = [
  'hips',
  'spine',
  'chest',
  'head',
  'lUA',
  'lFA',
  'lHand',
  'rUA',
  'rFA',
  'rHand',
  'lTh',
  'lSh',
  'lFoot',
  'rTh',
  'rSh',
  'rFoot',
] as const;
export type PartName = (typeof PART_NAMES)[number];

export interface Skel {
  k: number;
  bulk: number;
  ankle: number;
  thigh: number;
  shin: number;
  hipDrop: number;
  hipY: number;
  hipW: number;
  spineY: number;
  chestY: number;
  shoulderY: number;
  shoulderW: number;
  neckY: number;
  ua: number;
  fa: number;
  headR: number;
  height: number;
  /** Pivot height for whole-body flips / tumbles. */
  center: number;
}

export function makeSkel(k: number, bulk: number, headK: number, extraTop = 0): Skel {
  const ankle = 0.08 * k;
  const thigh = 0.35 * k;
  const shin = 0.35 * k;
  const hipDrop = 0.05 * k;
  const hipY = ankle + thigh + shin + hipDrop;
  const spineY = 0.1 * k;
  const chestY = 0.15 * k;
  const neckY = 0.27 * k;
  const headR = 0.24 * k * headK;
  const height = hipY + spineY + chestY + neckY + headR * 1.9 + extraTop;
  return {
    k,
    bulk,
    ankle,
    thigh,
    shin,
    hipDrop,
    hipY,
    hipW: 0.11 * k * Math.sqrt(bulk),
    spineY,
    chestY,
    shoulderY: 0.22 * k,
    shoulderW: 0.2 * k * bulk,
    neckY,
    ua: 0.27 * k,
    fa: 0.25 * k,
    headR,
    height,
    center: hipY + spineY,
  };
}

export type VictoryStyle = 'zippy' | 'pixel' | 'fennec' | 'max' | 'juno' | 'kai' | 'bram' | 'rosa';

export interface DangleDef {
  /** Base rotation about x (positive swings the tip backward for a down-hanging piece). */
  base: number;
  /** Response to forward speed (world units/frame) and vertical speed. */
  fwd: number;
  up: number;
  wave: number;
  waveSpeed: number;
  phase: number;
  max: number;
}

export interface PropDef {
  id: string;
  parent: PartName;
  pos: [number, number, number];
  rot?: [number, number, number];
  dangle?: DangleDef;
  /** Extra outline? (thin props skip it) */
  outline?: boolean;
  main: GeoBatch;
  glow: GeoBatch;
}

export interface Design {
  id: string;
  archetype: Archetype;
  skel: Skel;
  main: Record<PartName, GeoBatch>;
  glow: Record<PartName, GeoBatch>;
  props: PropDef[];
  glowColor: number;
  accent: number;
  color: number;
  /** Where held items attach. */
  hand: 'lHand' | 'rHand';
  /** Team ring radius. */
  ringR: number;
}

// ---------------------------------------------------------------------------
class DesignBuilder {
  main = {} as Record<PartName, GeoBatch>;
  glow = {} as Record<PartName, GeoBatch>;
  props: PropDef[] = [];
  constructor(public sk: Skel) {
    for (const n of PART_NAMES) {
      this.main[n] = new GeoBatch();
      this.glow[n] = new GeoBatch();
    }
  }
  m(n: PartName): GeoBatch {
    return this.main[n];
  }
  g(n: PartName): GeoBatch {
    return this.glow[n];
  }
  prop(id: string, parent: PartName, pos: [number, number, number], extra?: { rot?: [number, number, number]; dangle?: DangleDef; outline?: boolean }): PropDef {
    const p: PropDef = { id, parent, pos, rot: extra?.rot, dangle: extra?.dangle, outline: extra?.outline ?? true, main: new GeoBatch(), glow: new GeoBatch() };
    this.props.push(p);
    return p;
  }
}

interface Look {
  skin: number;
  top: number;
  belly?: number;
  sleeve: number;
  forearm: number;
  glove: number;
  pants: number;
  shin?: number;
  shoe: number;
  sole: number;
  belt?: number;
  /** Fist scale (bruisers). */
  fist?: number;
  armR?: number;
  legR?: number;
  torsoW?: number;
  torsoD?: number;
}

/** The common chunky body: pelvis, belly, chest, neck, arms, fists, legs, shoes. */
function baseBody(d: DesignBuilder, L: Look): void {
  const s = d.sk;
  const k = s.k;
  const u = U();
  const bw = L.torsoW ?? 1;
  const bd = L.torsoD ?? 1;
  const armR = (L.armR ?? 1) * k;
  const legR = (L.legR ?? 1) * k * Math.sqrt(s.bulk);
  // pelvis
  d.m('hips').add(u.rbox, L.pants, 0, -0.03 * k, 0, 0, 0, 0, (s.hipW * 2 + 0.16 * k) * bw, 0.2 * k, 0.24 * k * bd * s.bulk ** 0.5);
  if (L.belt !== undefined) d.m('hips').add(u.rbox, L.belt, 0, 0.06 * k, 0, 0, 0, 0, (s.hipW * 2 + 0.18 * k) * bw, 0.06 * k, 0.26 * k * bd * s.bulk ** 0.5);
  // belly
  d.m('spine').add(u.rbox, L.belly ?? L.top, 0, 0.08 * k, 0, 0, 0, 0, 0.34 * k * bw * s.bulk ** 0.7, 0.22 * k, 0.23 * k * bd * s.bulk ** 0.6);
  // chest (wedge-ish: wide shoulders)
  d.m('chest').add(u.rbox, L.top, 0, 0.13 * k, 0, 0, 0, 0, (s.shoulderW * 2 + 0.06 * k) * bw, 0.3 * k, 0.27 * k * bd * s.bulk ** 0.6);
  d.m('chest').add(u.cyl, L.skin, 0, 0.29 * k, 0, 0, 0, 0, 0.07 * k, 0.1 * k, 0.07 * k);
  // arms
  for (const side of [1, -1] as const) {
    const ua = side === 1 ? 'lUA' : 'rUA';
    const fa = side === 1 ? 'lFA' : 'rFA';
    const hd = side === 1 ? 'lHand' : 'rHand';
    d.m(ua).add(u.sphere, L.top, 0, 0, 0, 0, 0, 0, 0.1 * armR, 0.1 * armR, 0.1 * armR);
    d.m(ua).limb(L.sleeve, 0.075 * armR, 0.065 * armR, s.ua);
    d.m(fa).limb(L.forearm, 0.065 * armR, 0.058 * armR, s.fa);
    const f = (L.fist ?? 1) * k;
    d.m(hd).add(u.rbox, L.glove, 0, -0.06 * f, 0.01 * f, 0, 0, 0, 0.13 * f, 0.14 * f, 0.13 * f);
    d.m(hd).add(u.rbox, L.glove, 0.0, -0.03 * f, 0.065 * f, 0.4, 0, 0, 0.05 * f, 0.08 * f, 0.05 * f); // thumb
    // legs
    const th = side === 1 ? 'lTh' : 'rTh';
    const sh = side === 1 ? 'lSh' : 'rSh';
    const ft = side === 1 ? 'lFoot' : 'rFoot';
    d.m(th).limb(L.pants, 0.095 * legR, 0.08 * legR, s.thigh);
    d.m(sh).limb(L.shin ?? L.pants, 0.078 * legR, 0.065 * legR, s.shin);
    d.m(ft).add(u.rbox, L.shoe, 0, -0.025 * k, 0.06 * k, 0, 0, 0, 0.14 * legR, 0.11 * k, 0.27 * k);
    d.m(ft).add(u.box, L.sole, 0, -0.07 * k, 0.06 * k, 0, 0, 0, 0.145 * legR, 0.025 * k, 0.28 * k);
  }
}

/** Head sphere centre in head-joint space. */
function headC(s: Skel): number {
  return s.headR * 0.95;
}

function eyes(b: GeoBatch, s: Skel, color = 0x15151f, spread = 0.36, lift = 0.05, size = 1, white = true): void {
  const u = U();
  const r = s.headR;
  const cy = headC(s) + r * lift;
  for (const side of [1, -1]) {
    const ex = side * r * spread;
    const ez = Math.sqrt(Math.max(0, 1 - spread * spread - lift * lift)) * r * 0.97;
    if (white) b.add(u.sphereLo, 0xffffff, ex, cy, ez - 0.012, 0, 0, 0, r * 0.15 * size, r * 0.2 * size, r * 0.07);
    b.add(u.sphereLo, color, ex * 0.98, cy - r * 0.01, ez + 0.004, 0, 0, 0, r * 0.09 * size, r * 0.14 * size, r * 0.06);
  }
}

function brows(b: GeoBatch, s: Skel, color: number, angle = 0.25, lift = 0.32): void {
  const u = U();
  const r = s.headR;
  for (const side of [1, -1]) {
    const ex = side * r * 0.36;
    const ey = headC(s) + r * lift;
    const ez = Math.sqrt(Math.max(0, 1 - 0.13 - lift * lift)) * r * 1.0;
    b.add(u.box, color, ex, ey, ez, 0, 0, side * angle, r * 0.32, r * 0.08, r * 0.08);
  }
}

// ---------------------------------------------------------------------------
// ZIPPY NOVA — light speedster: sleek visor helmet, cyan bodysuit, pink scarf streamers.
function zippy(): Design {
  const s = makeSkel(0.88, 0.9, 1.12, 0.03);
  const d = new DesignBuilder(s);
  const u = U();
  const C = 0x1fd6ee;
  const P = 0xff3fb4;
  const W = 0xf7f9ff;
  const NAVY = 0x15204a;
  baseBody(d, { skin: 0xf2c6a0, top: C, sleeve: C, forearm: W, glove: W, pants: C, shin: W, shoe: W, sole: P, belt: NAVY, legR: 0.9, armR: 0.9 });
  const k = s.k;
  // chest chevron + navy side panels
  d.m('chest').add(u.cone4, P, 0, 0.16 * k, 0.135 * k, Math.PI, Math.PI / 4, 0, 0.1 * k, 0.14 * k, 0.03 * k);
  d.m('spine').add(u.box, NAVY, 0, 0.1 * k, 0, 0, 0, 0, 0.35 * k, 0.05 * k, 0.24 * k);
  // shoe fins
  for (const ft of ['lFoot', 'rFoot'] as const) d.m(ft).add(u.cone4, P, 0, 0.02 * k, -0.08 * k, -1.9, 0, 0, 0.03 * k, 0.12 * k, 0.04 * k);
  // helmet
  const h = d.m('head');
  const r = s.headR;
  const cy = headC(s);
  h.add(u.sphere, W, 0, cy + r * 0.04, -r * 0.12, 0, 0, 0, r * 1.06, r * 1.04, r * 1.22);
  h.add(u.sphere, 0xf2c6a0, 0, cy - r * 0.35, r * 0.25, 0, 0, 0, r * 0.62, r * 0.55, r * 0.72); // chin
  h.add(u.sphere, NAVY, 0, cy + r * 0.06, r * 0.2, -0.08, 0, 0, r * 1.02, r * 0.46, r * 0.98); // visor
  for (const side of [1, -1]) d.g('head').add(u.box, C, side * r * 0.42, cy + r * 0.12, r * 1.08, 0, side * 0.5, 0, r * 0.5, r * 0.07, r * 0.05); // visor glint
  h.add(u.box, P, 0, cy + r * 0.7, -r * 0.1, 0.2, 0, 0, r * 0.14, r * 0.45, r * 1.7); // fin
  h.add(u.cone4, P, 0, cy + r * 0.55, -r * 1.05, -1.75, 0, 0, r * 0.12, r * 0.7, r * 0.3); // tail fin
  for (const side of [1, -1]) h.add(u.cyl, P, side * r * 1.02, cy - r * 0.05, -r * 0.05, 0, 0, Math.PI / 2, r * 0.26, r * 0.1, r * 0.26);
  h.add(u.sphereLo, 0xd0606a, 0, cy - r * 0.55, r * 0.78, 0, 0, 0, r * 0.18, r * 0.05, r * 0.06); // grin
  // scarf wrap + streamers
  d.m('chest').add(u.torus, P, 0, 0.28 * k, -0.005, Math.PI / 2, 0, 0, 0.11 * k, 0.11 * k, 0.17 * k);
  const dang = (ph: number): DangleDef => ({ base: 0.5, fwd: 9, up: -6, wave: 0.25, waveSpeed: 9, phase: ph, max: 1.6 });
  for (const side of [1, -1]) {
    const p = d.prop(side === 1 ? 'scarfL' : 'scarfR', 'chest', [side * 0.05 * k, 0.28 * k, -0.12 * k], { dangle: dang(side), outline: true });
    const len = side === 1 ? 0.62 * k : 0.5 * k;
    p.main.add(u.box, P, 0, -len / 2, 0, 0, 0, 0, 0.08 * k, len, 0.02 * k);
    p.main.add(u.cone4, P, 0, -len - 0.04 * k, 0, Math.PI, Math.PI / 4, 0, 0.06 * k, 0.1 * k, 0.02 * k);
  }
  return finish('zippy', 'speedster', d, C, P, P, 'rHand', 0.42);
}

// ---------------------------------------------------------------------------
// PIXEL POP — light zoner: bubble-gum buns, mint headphones, skirt, chunky boots.
function pixel(): Design {
  const s = makeSkel(0.86, 0.9, 1.18, 0.06);
  const d = new DesignBuilder(s);
  const u = U();
  const PK = 0xff4fa3;
  const MT = 0x4dffc3;
  const CR = 0xfff1a8;
  const HAIR = 0xe02d8a;
  const PLUM = 0x3a2050;
  const SKIN = 0xffd9c0;
  baseBody(d, { skin: SKIN, top: CR, sleeve: MT, forearm: SKIN, glove: CR, pants: PK, shin: PLUM, shoe: MT, sole: CR, legR: 0.85, armR: 0.85 });
  const k = s.k;
  // jacket panels + collar
  for (const side of [1, -1]) d.m('chest').add(u.rbox, MT, side * 0.13 * k, 0.13 * k, 0.01, 0, 0, 0, 0.1 * k, 0.31 * k, 0.28 * k);
  d.m('chest').add(u.sphereLo, PK, 0, 0.17 * k, 0.14 * k, 0, 0, 0, 0.045 * k, 0.045 * k, 0.02 * k); // gum badge
  // skirt
  d.m('hips').add(new THREE.CylinderGeometry(0.19 * k, 0.29 * k, 0.2 * k, 10, 1), PK, 0, -0.06 * k, 0);
  d.m('hips').add(u.cyl12, CR, 0, -0.16 * k, 0, 0, 0, 0, 0.295 * k, 0.025 * k, 0.295 * k);
  // chunky boots
  for (const ft of ['lFoot', 'rFoot'] as const) d.m(ft).add(u.cyl, MT, 0, 0.06 * k, 0.0, 0, 0, 0, 0.085 * k, 0.12 * k, 0.085 * k);
  // head
  const h = d.m('head');
  const r = s.headR;
  const cy = headC(s);
  h.add(u.sphere, SKIN, 0, cy, 0, 0, 0, 0, r, r * 0.98, r * 0.96);
  h.add(u.sphere, HAIR, 0, cy + r * 0.18, -r * 0.12, 0, 0, 0, r * 1.06, r * 0.92, r * 1.02); // hair cap
  // bangs
  for (let i = -2; i <= 2; i++) h.add(u.sphereLo, HAIR, i * r * 0.28, cy + r * 0.6 - Math.abs(i) * r * 0.05, r * 0.68, 0.3, 0, 0, r * 0.22, r * 0.2, r * 0.18);
  // buns
  for (const side of [1, -1]) {
    h.add(u.sphere, HAIR, side * r * 0.72, cy + r * 0.95, -r * 0.05, 0, 0, 0, r * 0.48, r * 0.48, r * 0.48);
    h.add(u.torus, MT, side * r * 0.62, cy + r * 0.8, -r * 0.05, 0.3, 0, side * 0.7, r * 0.3, r * 0.3, r * 0.3);
  }
  // headphones
  h.add(new THREE.TorusGeometry(r * 1.08, r * 0.1, 5, 14, Math.PI), MT, 0, cy + r * 0.05, r * 0.05, 0, 0, 0);
  for (const side of [1, -1]) {
    h.add(u.cyl12, MT, side * r * 1.05, cy, 0, 0, 0, Math.PI / 2, r * 0.36, r * 0.24, r * 0.36);
    d.g('head').add(u.cyl12, PK, side * r * 1.18, cy, 0, 0, 0, Math.PI / 2, r * 0.2, r * 0.04, r * 0.2);
  }
  eyes(h, s, 0x3a1a4a, 0.36, 0.0, 1.25);
  h.add(u.sphereLo, 0xff8fb0, r * 0.62, cy - r * 0.28, r * 0.72, 0, 0, 0, r * 0.12, r * 0.07, r * 0.04);
  h.add(u.sphereLo, 0xff8fb0, -r * 0.62, cy - r * 0.28, r * 0.72, 0, 0, 0, r * 0.12, r * 0.07, r * 0.04);
  h.add(u.sphereLo, 0xc0306a, 0, cy - r * 0.42, r * 0.88, 0, 0, 0, r * 0.1, r * 0.06, r * 0.05);
  // gum bubble (victory) — unit sphere scaled at runtime
  const bub = d.prop('bubble', 'head', [0, cy - r * 0.4, r * 1.0], { outline: false });
  bub.main.add(u.sphere, 0xff8cc8, 0, 0, 1, 0, 0, 0, 1, 1, 1);
  // pigtail ribbons on buns as streamers
  return finish('pixel', 'zoner', d, PK, MT, MT, 'rHand', 0.42);
}

// ---------------------------------------------------------------------------
// FENNEC FLASH — light trickster: hood with giant fennec ears, goggles, face wrap, cape, tail.
function fennec(): Design {
  const s = makeSkel(0.9, 0.92, 1.1, 0.12);
  const d = new DesignBuilder(s);
  const u = U();
  const Y = 0xffcf1f;
  const O = 0xff6a00;
  const BR = 0x2b1b12;
  const SAND = 0xe8c48a;
  const SKIN = 0xc68a5a;
  baseBody(d, { skin: SKIN, top: Y, belly: BR, sleeve: BR, forearm: SAND, glove: BR, pants: 0x6b4426, shin: SAND, shoe: BR, sole: O, belt: O, legR: 1.05, armR: 0.9 });
  const k = s.k;
  // shin wraps
  for (const sh of ['lSh', 'rSh'] as const) for (let i = 0; i < 3; i++) d.m(sh).add(u.cyl, O, 0, -0.1 * k - i * 0.08 * k, 0, 0.25, 0, 0, 0.074 * k, 0.02 * k, 0.074 * k);
  // sash across chest
  d.m('chest').add(u.box, O, 0, 0.13 * k, 0.0, 0, 0, 0.7, 0.07 * k, 0.42 * k, 0.29 * k);
  const h = d.m('head');
  const r = s.headR;
  const cy = headC(s);
  h.add(u.sphere, SKIN, 0, cy - r * 0.02, r * 0.04, 0, 0, 0, r * 0.9, r * 0.92, r * 0.92);
  h.add(u.sphere, Y, 0, cy + r * 0.12, -r * 0.34, 0, 0, 0, r * 1.12, r * 1.1, r * 1.0); // hood
  h.add(u.torusThin, O, 0, cy + r * 0.08, r * 0.6, 0, 0, 0, r * 0.95, r * 1.0, r * 0.6); // hood rim
  // ears
  for (const side of [1, -1]) {
    const ex = side * r * 0.62;
    const ey = cy + r * 1.25;
    h.add(u.cone, Y, ex, ey, -r * 0.1, 0.05, 0, -side * 0.42, r * 0.5, r * 1.4, r * 0.32);
    h.add(u.cone, 0xffd8c0, ex - side * r * 0.03, ey - r * 0.05, r * 0.04, 0.05, 0, -side * 0.42, r * 0.32, r * 1.05, r * 0.12);
    h.add(u.cone, BR, ex + side * r * 0.29, ey + r * 0.6, -r * 0.1, 0.05, 0, -side * 0.42, r * 0.17, r * 0.3, r * 0.12);
  }
  // goggles on the brow
  h.add(new THREE.TorusGeometry(r * 1.12, r * 0.07, 4, 16), BR, 0, cy + r * 0.62, -r * 0.12, Math.PI / 2 - 0.5, 0, 0);
  for (const side of [1, -1]) {
    h.add(u.cyl12, BR, side * r * 0.34, cy + r * 0.98, r * 0.55, Math.PI / 2 - 1.0, 0, 0, r * 0.25, r * 0.14, r * 0.25);
    d.g('head').add(u.cyl12, 0x5fd0ff, side * r * 0.34, cy + r * 1.03, r * 0.6, Math.PI / 2 - 1.0, 0, 0, r * 0.18, r * 0.05, r * 0.18);
  }
  // face wrap
  h.add(u.sphere, BR, 0, cy - r * 0.42, r * 0.22, 0, 0, 0, r * 0.82, r * 0.42, r * 0.78);
  eyes(h, s, 0x1a1008, 0.34, 0.02, 1.15);
  brows(h, s, BR, -0.2, 0.25);
  // cape
  const cape = d.prop('cape', 'chest', [0, 0.26 * k, -0.15 * k], { dangle: { base: 0.18, fwd: 7, up: -5, wave: 0.12, waveSpeed: 7, phase: 0, max: 1.4 } });
  cape.main.add(new THREE.CylinderGeometry(0.2 * k, 0.32 * k, 0.62 * k, 8, 1, true, Math.PI * 0.6, Math.PI * 0.8), O, 0, -0.31 * k, 0.1 * k, 0, Math.PI, 0);
  cape.main.add(new THREE.CylinderGeometry(0.205 * k, 0.325 * k, 0.6 * k, 8, 1, true, Math.PI * 0.6, Math.PI * 0.8), 0xd04c00, 0, -0.31 * k, 0.1 * k, 0, Math.PI, 0, 0.98, 1, 0.98);
  // fluffy tail
  const tail = d.prop('tail', 'hips', [0, 0.0, -0.13 * k], { dangle: { base: 0.7, fwd: 5, up: -4, wave: 0.25, waveSpeed: 5, phase: 1, max: 1.5 } });
  tail.main.add(u.sphere, Y, 0, -0.2 * k, 0, 0, 0, 0, 0.11 * k, 0.24 * k, 0.11 * k);
  tail.main.add(u.sphere, BR, 0, -0.42 * k, 0, 0, 0, 0, 0.08 * k, 0.1 * k, 0.08 * k);
  return finish('fennec', 'trickster', d, Y, O, O, 'rHand', 0.42);
}

// ---------------------------------------------------------------------------
// MAX VORTEX — all-rounder hero: spiky hair, red racing jacket, goggles pushed up on the forehead.
function max(): Design {
  const s = makeSkel(1, 1, 1.05, 0.08);
  const d = new DesignBuilder(s);
  const u = U();
  const R = 0xe32222;
  const Y = 0xffd23f;
  const W = 0xffffff;
  const HAIR = 0x3b2416;
  const SKIN = 0xf0b98a;
  const DEN = 0x2b3a67;
  baseBody(d, { skin: SKIN, top: R, belly: 0x262a33, sleeve: R, forearm: R, glove: 0x23232a, pants: DEN, shoe: R, sole: W, belt: 0x23232a });
  const k = s.k;
  // jacket details: white collar, yellow chest stripe, sleeve stripes, open front
  d.m('chest').add(u.torus, W, 0, 0.27 * k, 0, Math.PI / 2, 0, 0, 0.13 * k, 0.12 * k, 0.2 * k);
  d.m('chest').add(u.box, Y, 0, 0.17 * k, 0.0, 0, 0, 0, (s.shoulderW * 2 + 0.07 * k), 0.06 * k, 0.28 * k);
  d.m('chest').add(u.box, 0x262a33, 0, 0.06 * k, 0.13 * k, 0, 0, 0, 0.1 * k, 0.16 * k, 0.03 * k);
  d.m('spine').add(u.box, R, 0.12 * k, 0.07 * k, 0.005, 0, 0, 0, 0.12 * k, 0.22 * k, 0.235 * k);
  d.m('spine').add(u.box, R, -0.12 * k, 0.07 * k, 0.005, 0, 0, 0, 0.12 * k, 0.22 * k, 0.235 * k);
  for (const ua of ['lUA', 'rUA', 'lFA', 'rFA'] as const) {
    const sx = ua[0] === 'l' ? 1 : -1;
    d.m(ua).add(u.box, Y, sx * 0.06 * k, -0.13 * k, 0, 0, 0, 0, 0.025 * k, 0.24 * k, 0.04 * k);
  }
  for (const fa of ['lFA', 'rFA'] as const) d.m(fa).add(u.cyl, W, 0, -0.22 * k, 0, 0, 0, 0, 0.068 * k, 0.05 * k, 0.068 * k);
  for (const ft of ['lFoot', 'rFoot'] as const) d.m(ft).add(u.box, Y, 0, 0.0, 0.0, 0, 0, 0, 0.15 * k, 0.025 * k, 0.12 * k);
  // head
  const h = d.m('head');
  const r = s.headR;
  const cy = headC(s);
  h.add(u.sphere, SKIN, 0, cy, 0, 0, 0, 0, r * 0.98, r, r * 0.98);
  h.add(u.sphere, HAIR, 0, cy + r * 0.25, -r * 0.12, 0, 0, 0, r * 1.02, r * 0.85, r * 1.0);
  // spikes (swept back + up)
  const spikes: [number, number, number, number, number, number][] = [
    [0, 0.95, 0.35, -0.6, 0, 0.55],
    [0.42, 0.85, 0.2, -0.7, 0, -0.5],
    [-0.42, 0.85, 0.2, -0.7, 0, 0.5],
    [0, 0.85, -0.35, -1.2, 0, 0.6],
    [0.55, 0.55, -0.4, -1.4, 0, -0.8],
    [-0.55, 0.55, -0.4, -1.4, 0, 0.8],
    [0, 0.45, -0.85, -1.9, 0, 0.6],
    [0.25, 0.75, 0.55, -0.2, 0, -0.3],
    [-0.22, 0.78, 0.6, -0.15, 0, 0.25],
  ];
  for (const [x, y, z, rx, , len] of spikes) h.add(u.cone, HAIR, x * r, cy + y * r, z * r, rx, 0, -x * 0.9, r * 0.32, r * (0.75 + len * 0.6), r * 0.32);
  // goggles on the forehead
  h.add(new THREE.TorusGeometry(r * 1.0, r * 0.08, 4, 16), Y, 0, cy + r * 0.42, -r * 0.02, Math.PI / 2 - 0.3, 0, 0);
  for (const side of [1, -1]) {
    h.add(u.cyl12, 0x2a2a30, side * r * 0.36, cy + r * 0.62, r * 0.75, Math.PI / 2 - 0.65, 0, 0, r * 0.28, r * 0.16, r * 0.28);
    d.g('head').add(u.cyl12, 0x7fe0ff, side * r * 0.36, cy + r * 0.67, r * 0.81, Math.PI / 2 - 0.65, 0, 0, r * 0.21, r * 0.05, r * 0.21);
  }
  eyes(h, s, 0x2a1a10, 0.36, 0.0, 1.05);
  brows(h, s, HAIR, 0.3, 0.3);
  h.add(u.box, 0x8a3a2a, 0, cy - r * 0.45, r * 0.86, 0, 0, 0.12, r * 0.32, r * 0.05, r * 0.05); // smirk
  h.add(u.sphereLo, SKIN, 0, cy - r * 0.05, r * 0.98, 0, 0, 0, r * 0.1, r * 0.12, r * 0.1); // nose
  return finish('max', 'allrounder', d, R, Y, Y, 'rHand', 0.48);
}

// ---------------------------------------------------------------------------
// JUNO BOLT — storm zoner: hooded coat with lightning trim, shadowed face with glowing eyes, glowing hands.
function juno(): Design {
  const s = makeSkel(1, 0.95, 1.0, 0.16);
  const d = new DesignBuilder(s);
  const u = U();
  const PU = 0x7c3aed;
  const AM = 0xffb020;
  const DK = 0x161326;
  const PU2 = 0x5a22c0;
  baseBody(d, { skin: DK, top: PU, sleeve: PU, forearm: PU2, glove: DK, pants: DK, shoe: PU2, sole: AM, belt: AM });
  const k = s.k;
  // lightning zig-zag on chest
  const zz: [number, number, number][] = [
    [0.05, 0.24, 0.6],
    [-0.01, 0.15, -0.6],
    [0.04, 0.06, 0.6],
  ];
  for (const [x, y, a] of zz) d.m('chest').add(u.box, AM, x * k, y * k, 0.14 * k, 0, 0, a, 0.035 * k, 0.12 * k, 0.02 * k);
  // high collar
  d.m('chest').add(new THREE.CylinderGeometry(0.14 * k, 0.12 * k, 0.12 * k, 8, 1, true), PU2, 0, 0.3 * k, 0);
  // flared cuffs + glowing hands
  for (const side of ['l', 'r'] as const) {
    const fa = (side + 'FA') as PartName;
    const hd = (side + 'Hand') as PartName;
    d.m(fa).add(new THREE.CylinderGeometry(0.1 * k, 0.07 * k, 0.1 * k, 8, 1), PU, 0, -0.2 * k, 0);
    d.m(fa).add(u.cyl, AM, 0, -0.25 * k, 0, 0, 0, 0, 0.101 * k, 0.02 * k, 0.101 * k);
    d.g(hd).add(u.ico1, AM, 0, -0.06 * k, 0.01 * k, 0, 0, 0, 0.085 * k, 0.085 * k, 0.085 * k);
  }
  // coat skirt (front flaps on thighs) + boots
  for (const side of ['l', 'r'] as const) {
    d.m((side + 'Th') as PartName).add(u.box, PU, 0, -0.15 * k, 0.03 * k, 0, 0, 0, 0.2 * k, 0.32 * k, 0.17 * k);
    d.m((side + 'Th') as PartName).add(u.box, AM, 0, -0.31 * k, 0.03 * k, 0, 0, 0, 0.205 * k, 0.025 * k, 0.175 * k);
    d.m((side + 'Sh') as PartName).add(u.cyl, PU2, 0, -0.22 * k, 0, 0, 0, 0, 0.085 * k, 0.24 * k, 0.085 * k);
  }
  // hood with shadowed face
  const h = d.m('head');
  const r = s.headR;
  const cy = headC(s);
  h.add(u.sphere, PU, 0, cy + r * 0.08, -r * 0.1, 0, 0, 0, r * 1.15, r * 1.12, r * 1.12);
  h.add(u.cone, PU, 0, cy + r * 0.5, -r * 1.1, -2.1, 0, 0, r * 0.45, r * 0.9, r * 0.45); // hood tip
  h.add(u.sphere, DK, 0, cy - r * 0.04, r * 0.32, 0, 0, 0, r * 0.82, r * 0.8, r * 0.75); // shadowed face
  h.add(new THREE.TorusGeometry(r * 0.86, r * 0.07, 4, 16), AM, 0, cy + r * 0.0, r * 0.62, 0, 0, 0, 1, 1.08, 0.7);
  // bolt on the hood
  h.add(u.box, AM, r * 0.2, cy + r * 1.05, r * 0.05, 0.3, 0, 0.6, r * 0.12, r * 0.4, r * 0.08);
  h.add(u.box, AM, r * 0.05, cy + r * 0.82, r * 0.38, 0.6, 0, -0.6, r * 0.12, r * 0.4, r * 0.08);
  // glowing eyes
  for (const side of [1, -1]) d.g('head').add(u.box, AM, side * r * 0.3, cy + r * 0.05, r * 1.04, 0, 0, -side * 0.3, r * 0.26, r * 0.1, r * 0.05);
  // coat tail
  const tail = d.prop('coat', 'hips', [0, 0.05 * k, -0.13 * k], { dangle: { base: 0.12, fwd: 5, up: -4, wave: 0.08, waveSpeed: 6, phase: 0, max: 1.2 } });
  tail.main.add(new THREE.CylinderGeometry(0.22 * k, 0.3 * k, 0.62 * k, 8, 1, true, Math.PI * 0.55, Math.PI * 0.9), PU, 0, -0.31 * k, 0.14 * k, 0, Math.PI, 0);
  tail.main.add(new THREE.CylinderGeometry(0.3 * k, 0.305 * k, 0.04 * k, 8, 1, true, Math.PI * 0.55, Math.PI * 0.9), AM, 0, -0.61 * k, 0.14 * k, 0, Math.PI, 0);
  return finish('juno', 'zoner', d, PU, AM, AM, 'rHand', 0.48);
}

// ---------------------------------------------------------------------------
// KAI TIDEWATER — sword fighter: headband tails, swept hair, gi jacket + sash, glowing water blade.
function kai(): Design {
  const s = makeSkel(1, 1, 1.02, 0.06);
  const d = new DesignBuilder(s);
  const u = U();
  const B = 0x1e6bff;
  const O = 0xff7a1a;
  const L = 0xdff6ff;
  const NAVY = 0x13213f;
  const SKIN = 0xd9a070;
  baseBody(d, { skin: SKIN, top: B, sleeve: B, forearm: L, glove: NAVY, pants: L, shoe: NAVY, sole: 0x0b1226, belt: O });
  for (const sh of ['lSh', 'rSh'] as const) d.m(sh).add(u.cyl, B, 0, -0.22 * s.k, 0, 0, 0, 0, 0.08 * s.k, 0.24 * s.k, 0.08 * s.k);
  const k = s.k;
  // crossed collar
  d.m('chest').add(u.box, L, 0.05 * k, 0.17 * k, 0.135 * k, 0, 0, -0.55, 0.05 * k, 0.3 * k, 0.02 * k);
  d.m('chest').add(u.box, L, -0.05 * k, 0.17 * k, 0.135 * k, 0, 0, 0.55, 0.05 * k, 0.3 * k, 0.02 * k);
  // jacket skirt over hips + sash knot
  d.m('hips').add(new THREE.CylinderGeometry(0.2 * k, 0.25 * k, 0.16 * k, 8, 1), B, 0, -0.06 * k, 0);
  d.m('hips').add(u.box, O, 0.12 * k, 0.0, 0.13 * k, 0, 0, 0.3, 0.06 * k, 0.16 * k, 0.03 * k);
  // forearm wraps
  for (const fa of ['lFA', 'rFA'] as const) for (let i = 0; i < 3; i++) d.m(fa).add(u.cyl, 0xb8d8ea, 0, -0.06 * k - i * 0.065 * k, 0, 0.2, 0, 0, 0.066 * k, 0.015 * k, 0.066 * k);
  // head
  const h = d.m('head');
  const r = s.headR;
  const cy = headC(s);
  h.add(u.sphere, SKIN, 0, cy, 0, 0, 0, 0, r * 0.97, r, r * 0.97);
  h.add(u.sphere, NAVY, 0, cy + r * 0.25, -r * 0.15, 0, 0, 0, r * 1.02, r * 0.85, r * 1.0);
  // swept-back hair blades
  for (let i = -2; i <= 2; i++) h.add(u.cone4, NAVY, i * r * 0.28, cy + r * 0.62 - Math.abs(i) * r * 0.08, -r * 0.55, -1.95, 0, i * 0.08, r * 0.24, r * 1.0, r * 0.14);
  h.add(u.cone4, NAVY, r * 0.4, cy + r * 0.58, r * 0.62, 0.4, 0, -0.5, r * 0.18, r * 0.5, r * 0.1); // fringe
  // headband
  h.add(new THREE.TorusGeometry(r * 1.0, r * 0.1, 4, 16), O, 0, cy + r * 0.42, 0, Math.PI / 2 - 0.08, 0, 0);
  h.add(u.box, O, 0, cy + r * 0.38, -r * 1.0, 0, 0, 0.6, r * 0.18, r * 0.18, r * 0.12); // knot
  eyes(h, s, 0x101828, 0.36, 0.0, 0.95);
  brows(h, s, NAVY, 0.32, 0.28);
  h.add(u.box, 0x7a3a28, 0, cy - r * 0.45, r * 0.87, 0, 0, 0, r * 0.22, r * 0.04, r * 0.05);
  // headband tails
  for (const side of [1, -1]) {
    const p = d.prop(side === 1 ? 'bandL' : 'bandR', 'head', [side * r * 0.12, cy + r * 0.38, -r * 1.02], {
      rot: [0, 0, side * 0.15],
      dangle: { base: 0.9, fwd: 8, up: -6, wave: 0.25, waveSpeed: 10, phase: side * 0.7, max: 1.6 },
    });
    const len = side === 1 ? 0.42 * k : 0.34 * k;
    p.main.add(u.box, O, 0, -len / 2, 0, 0, 0, 0, 0.06 * k, len, 0.015 * k);
  }
  // the water blade (in the right hand; blade along +z, tilted slightly up)
  const sw = d.prop('sword', 'rHand', [0, -0.06 * k, 0.02 * k], { outline: false });
  const BL = 1.0 * k;
  sw.main.add(u.cyl, O, 0, 0, -0.02 * k, Math.PI / 2, 0, 0, 0.032 * k, 0.24 * k, 0.032 * k); // grip
  sw.main.add(u.sphereLo, 0xffd060, 0, 0, -0.15 * k, 0, 0, 0, 0.045 * k, 0.045 * k, 0.045 * k); // pommel
  sw.main.add(u.torus, 0xffd060, 0, 0, 0.11 * k, 0, 0, 0, 0.09 * k, 0.09 * k, 0.12 * k); // guard ring
  sw.main.add(u.box, NAVY, 0, 0, 0.11 * k, 0, 0, 0, 0.22 * k, 0.04 * k, 0.04 * k); // guard bar
  sw.glow.add(u.box, 0x2aa8ff, 0, 0, 0.13 * k + BL / 2, 0, 0, 0, 0.024 * k, 0.11 * k, BL);
  sw.glow.add(u.cone4, 0x2aa8ff, 0, 0, 0.13 * k + BL + 0.07 * k, Math.PI / 2, Math.PI / 4, 0, 0.07 * k, 0.15 * k, 0.016 * k);
  sw.main.add(u.box, 0xbff4ff, 0, 0.035 * k, 0.13 * k + BL * 0.48, 0, 0, 0, 0.027 * k, 0.025 * k, BL * 0.9); // bright edge
  return finish('kai', 'sword', d, B, O, 0x1f9dff, 'lHand', 0.48);
}

// ---------------------------------------------------------------------------
// BOULDER BRAM — heavy bruiser: mossy boulder shoulders + fists, stone boots, moss beard.
function bram(): Design {
  const s = makeSkel(1.24, 1.45, 0.84, 0.02);
  const d = new DesignBuilder(s);
  const u = U();
  const G = 0x1f9a4b;
  const TAN = 0xd88a3c;
  const BR = 0x5a3b21;
  const STONE = 0x8c8a82;
  const MOSS = 0x3f9a36;
  const SKIN = 0xb88458;
  const st = { jitter: 0.16, moss: MOSS, mossAt: 0.35, ao: 0.3 };
  baseBody(d, { skin: SKIN, top: G, sleeve: STONE, forearm: STONE, glove: STONE, pants: BR, shin: BR, shoe: STONE, sole: 0x5c5a54, belt: TAN, fist: 1.6, armR: 1.55, legR: 1.15, torsoW: 1.05, torsoD: 1.15 });
  const k = s.k;
  // vest opening shows skin chest + rope belt knots
  d.m('chest').add(u.rbox, SKIN, 0, 0.12 * k, 0.12 * k * s.bulk ** 0.6, 0, 0, 0, 0.16 * k, 0.24 * k, 0.04 * k);
  d.m('hips').add(u.sphereLo, TAN, 0.12 * k, 0.06 * k, 0.16 * k, 0, 0, 0, 0.05 * k, 0.05 * k, 0.05 * k);
  // boulder shoulders
  for (const side of [1, -1]) {
    const ua = side === 1 ? 'lUA' : 'rUA';
    d.m(ua).add(u.ico, STONE, side * 0.03 * k, 0.04 * k, 0, 0.4, side * 0.3, 0.2, 0.26 * k, 0.22 * k, 0.24 * k, st);
    d.m(ua).add(u.ico, STONE, side * 0.07 * k, -0.06 * k, 0.04 * k, 1.1, 0.5, 0.3, 0.16 * k, 0.14 * k, 0.15 * k, st);
    const fa = side === 1 ? 'lFA' : 'rFA';
    d.m(fa).add(u.dodec, STONE, 0, -0.1 * k, 0, 0.3, 0.2, 0, 0.12 * k, 0.15 * k, 0.12 * k, st);
    const hd = side === 1 ? 'lHand' : 'rHand';
    d.m(hd).add(u.ico, STONE, 0, -0.12 * k, 0.02 * k, 0.2, 0.7, 0.1, 0.2 * k, 0.19 * k, 0.2 * k, st);
    for (let i = -1; i <= 1; i++) d.m(hd).add(u.ico, 0x7a786f, i * 0.07 * k, -0.2 * k, 0.12 * k, 0.5 * i, 0, 0, 0.055 * k, 0.05 * k, 0.05 * k, st);
    const ft = side === 1 ? 'lFoot' : 'rFoot';
    d.m(ft).add(u.ico, STONE, 0, -0.01 * k, 0.07 * k, 0, 0.3, 0, 0.13 * k, 0.1 * k, 0.19 * k, st);
  }
  // head: blocky jaw, brow ridge, moss hair + beard
  const h = d.m('head');
  const r = s.headR;
  const cy = headC(s);
  h.add(u.rbox, SKIN, 0, cy - r * 0.05, 0, 0, 0, 0, r * 1.7, r * 1.75, r * 1.65);
  h.add(u.box, 0x9a6a44, 0, cy + r * 0.32, r * 0.78, 0.1, 0, 0, r * 1.5, r * 0.22, r * 0.25); // brow
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    h.add(u.ico, MOSS, Math.cos(a) * r * 0.55, cy + r * 0.85, Math.sin(a) * r * 0.5 - r * 0.05, a, a * 2, 0, r * 0.42, r * 0.32, r * 0.42, { jitter: 0.2 });
  }
  h.add(u.ico, 0x2f7a2c, 0, cy + r * 0.95, 0, 0.3, 0.2, 0, r * 0.55, r * 0.35, r * 0.55, { jitter: 0.2 });
  for (let i = -2; i <= 2; i++) h.add(u.ico, 0x2f7a2c, i * r * 0.3, cy - r * 0.78 - (2 - Math.abs(i)) * r * 0.1, r * 0.55, i, 0.4, 0, r * 0.3, r * 0.32, r * 0.25, { jitter: 0.2 });
  eyes(h, s, 0x1a1208, 0.36, 0.1, 0.8, false);
  d.g('head').add(u.sphereLo, 0xffd27a, r * 0.36, cy + r * 0.1, r * 0.88, 0, 0, 0, r * 0.07, r * 0.07, r * 0.03);
  d.g('head').add(u.sphereLo, 0xffd27a, -r * 0.36, cy + r * 0.1, r * 0.88, 0, 0, 0, r * 0.07, r * 0.07, r * 0.03);
  h.add(u.sphereLo, 0xa06a42, 0, cy - r * 0.12, r * 0.9, 0, 0, 0, r * 0.18, r * 0.16, r * 0.14); // nose
  // mossy back rock
  d.m('chest').add(u.ico, STONE, 0, 0.18 * k, -0.17 * k, 0.5, 0.3, 0, 0.2 * k, 0.17 * k, 0.12 * k, st);
  return finish('bram', 'bruiser', d, G, TAN, 0xffd27a, 'rHand', 0.62);
}

// ---------------------------------------------------------------------------
// BIG RIG ROSA — heavy grappler: hard hat + flip-up welding visor, overalls, giant work gloves, ponytail.
function rosa(): Design {
  const s = makeSkel(1.12, 1.35, 0.94, 0.12);
  const d = new DesignBuilder(s);
  const u = U();
  const O = 0xff6a00;
  const T = 0x19d3c5;
  const CH = 0x2a2a34;
  const SKIN = 0x8d5a3b;
  baseBody(d, { skin: SKIN, top: 0x3c4150, belly: O, sleeve: 0x3c4150, forearm: SKIN, glove: CH, pants: O, shin: O, shoe: CH, sole: 0x111116, belt: CH, fist: 1.55, armR: 1.35, legR: 1.1, torsoD: 1.1 });
  const k = s.k;
  // overall bib + straps + pocket
  d.m('chest').add(u.rbox, O, 0, 0.07 * k, 0.11 * k * s.bulk ** 0.6, 0, 0, 0, 0.36 * k, 0.24 * k, 0.08 * k);
  d.m('chest').add(u.box, T, 0, 0.08 * k, 0.15 * k * s.bulk ** 0.6, 0, 0, 0, 0.12 * k, 0.08 * k, 0.02 * k);
  for (const side of [1, -1]) {
    d.m('chest').add(u.box, T, side * 0.12 * k, 0.2 * k, 0.0, 0, 0, 0, 0.06 * k, 0.04 * k, 0.32 * k * s.bulk ** 0.6);
    d.m('chest').add(u.sphereLo, 0xd0d0d8, side * 0.12 * k, 0.16 * k, 0.14 * k * s.bulk ** 0.6, 0, 0, 0, 0.025 * k, 0.025 * k, 0.015 * k);
  }
  // rolled sleeves
  for (const ua of ['lUA', 'rUA'] as const) d.m(ua).add(u.cyl, 0x3c4150, 0, -0.2 * k * 1.0, 0, 0, 0, 0, 0.11 * k, 0.07 * k, 0.11 * k);
  // big gauntlet cuffs
  for (const hd of ['lHand', 'rHand'] as const) {
    d.m(hd).add(u.cyl, T, 0, 0.0, 0, 0, 0, 0, 0.11 * k, 0.07 * k, 0.11 * k);
    d.m(hd).add(u.box, 0x44444f, 0, -0.04 * k, 0.11 * k, 0, 0, 0, 0.18 * k, 0.03 * k, 0.03 * k);
  }
  // steel-toe boots
  for (const ft of ['lFoot', 'rFoot'] as const) {
    d.m(ft).add(u.hemi, 0x9aa0aa, 0, -0.06 * k, 0.15 * k, 0, 0, 0, 0.085 * k, 0.08 * k, 0.08 * k);
    d.m(ft).add(u.cyl, CH, 0, 0.05 * k, -0.01 * k, 0, 0, 0, 0.09 * k, 0.12 * k, 0.09 * k);
  }
  // head
  const h = d.m('head');
  const r = s.headR;
  const cy = headC(s);
  h.add(u.sphere, SKIN, 0, cy, 0, 0, 0, 0, r * 0.98, r, r * 0.98);
  h.add(u.sphere, 0x1f1716, 0, cy + r * 0.1, -r * 0.2, 0, 0, 0, r * 1.0, r * 0.9, r * 0.9); // hair
  // hard hat
  h.add(u.hemi, O, 0, cy + r * 0.3, -r * 0.02, 0, 0, 0, r * 1.12, r * 0.95, r * 1.15);
  h.add(u.cyl12, O, 0, cy + r * 0.32, r * 0.1, 0, 0, 0, r * 1.25, r * 0.07, r * 1.35);
  h.add(u.box, T, 0, cy + r * 0.85, -r * 0.02, 0, 0, 0, r * 0.22, r * 0.55, r * 2.1);
  eyes(h, s, 0x1a0e08, 0.36, 0.0, 1.0);
  brows(h, s, 0x1f1716, -0.15, 0.27);
  h.add(u.box, 0xf4f0ea, 0, cy - r * 0.42, r * 0.86, 0, 0, 0, r * 0.38, r * 0.08, r * 0.05); // grin
  // welding visor on side pivots (rotated up by default, slams down for big moves)
  const vis = d.prop('visor', 'head', [0, cy + r * 0.28, 0], { outline: true });
  vis.main.add(new THREE.CylinderGeometry(r * 1.12, r * 1.12, r * 0.95, 10, 1, true, -Math.PI * 0.42, Math.PI * 0.84), CH, 0, -r * 0.48, 0);
  vis.main.add(u.cyl, 0x44444f, r * 1.12, 0, 0, 0, 0, Math.PI / 2, r * 0.12, r * 0.08, r * 0.12);
  vis.main.add(u.cyl, 0x44444f, -r * 1.12, 0, 0, 0, 0, Math.PI / 2, r * 0.12, r * 0.08, r * 0.12);
  vis.glow.add(u.box, T, 0, -r * 0.4, r * 1.13, 0, 0, 0, r * 0.95, r * 0.14, r * 0.04);
  // ponytail
  const pt = d.prop('pony', 'head', [0, cy + r * 0.15, -r * 0.92], { dangle: { base: 0.5, fwd: 5, up: -4, wave: 0.15, waveSpeed: 6, phase: 0, max: 1.3 } });
  pt.main.add(u.sphere, 0x1f1716, 0, -r * 0.45, -r * 0.05, 0, 0, 0, r * 0.28, r * 0.55, r * 0.28);
  pt.main.add(u.cyl, T, 0, -r * 0.02, 0, 0, 0, 0, r * 0.16, r * 0.1, r * 0.16);
  return finish('rosa', 'bruiser', d, O, T, T, 'rHand', 0.6);
}

function finish(id: string, archetype: Archetype, d: DesignBuilder, color: number, accent: number, glowColor: number, hand: 'lHand' | 'rHand', ringR: number): Design {
  return { id, archetype, skel: d.sk, main: d.main, glow: d.glow, props: d.props, color, accent, glowColor, hand, ringR };
}

export const DESIGN_IDS = ['zippy', 'pixel', 'fennec', 'max', 'juno', 'kai', 'bram', 'rosa'] as const;
const BUILDERS: Record<string, () => Design> = { zippy, pixel, fennec, max, juno, kai, bram, rosa };

// ---------------------------------------------------------------------------
// Built (merged) geometry cache — shared by every instance of a character.
export interface BuiltProp {
  def: PropDef;
  main: THREE.BufferGeometry | null;
  glow: THREE.BufferGeometry | null;
}
export interface BuiltDesign {
  id: string;
  archetype: Archetype;
  skel: Skel;
  main: Record<PartName, THREE.BufferGeometry | null>;
  glow: Record<PartName, THREE.BufferGeometry | null>;
  props: BuiltProp[];
  color: number;
  accent: number;
  glowColor: number;
  hand: 'lHand' | 'rHand';
  ringR: number;
  triangles: number;
}

const cache = new Map<string, BuiltDesign>();

export function getDesign(characterId: string): BuiltDesign {
  const id = BUILDERS[characterId] ? characterId : 'max';
  const hit = cache.get(id);
  if (hit) return hit;
  const d = BUILDERS[id]();
  const main = {} as Record<PartName, THREE.BufferGeometry | null>;
  const glow = {} as Record<PartName, THREE.BufferGeometry | null>;
  let tris = 0;
  const count = (g: THREE.BufferGeometry | null) => {
    if (g) tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    return g;
  };
  for (const n of PART_NAMES) {
    main[n] = count(d.main[n].build());
    glow[n] = count(d.glow[n].build());
  }
  const props = d.props.map((p) => ({ def: p, main: count(p.main.build()), glow: count(p.glow.build()) }));
  const built: BuiltDesign = {
    id,
    archetype: d.archetype,
    skel: d.skel,
    main,
    glow,
    props,
    color: d.color,
    accent: d.accent,
    glowColor: d.glowColor,
    hand: d.hand,
    ringR: d.ringR,
    triangles: Math.round(tris),
  };
  cache.set(id, built);
  return built;
}
