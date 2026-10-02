/**
 * Smash Party fighter rig: procedural low-poly full-body fighters with a hierarchical joint rig,
 * keyframed pose animation driven by FighterView, and in-rig effects (hitlag shake, invincibility
 * flicker, final-smash glow, smash-charge glow, team ring, dizzy stars).
 *
 * Hierarchy: root (feet at origin) → ring (team) / fx (shake) → yaw (facing + camera turn)
 *   → mirror (scale.x ±1 so the striking side always faces the camera) → tilt (pose offsets,
 *   pitch / roll / twist) → spin (raw flips & spins) → body (−centre) → hips → spine → chest → …
 * Geometry is merged per joint and cached per character (shared by all instances); materials are
 * per fighter. Nothing is allocated per frame.
 */
import * as THREE from 'three';
import type { ActionState, FighterView, MoveId } from '../types';
import { getDesign, PART_NAMES, type BuiltDesign, type PartName, type DangleDef } from './designs';
import { makeOutlineMaterial } from './geo';
import * as P from './poses';

export type FighterPose = 'idle' | 'victory' | 'portrait' | 'defeat';

export interface FighterRig {
  /** Feet at local origin, +y up; the view positions it at (x, y, 0). */
  root: THREE.Group;
  height: number;
  /** dt = render seconds, time = seconds (monotonic). */
  update(v: FighterView, dt: number, time: number): void;
  setPose(pose: FighterPose, time: number): void;
  setTeamColor(css: string | null): void;
  /** Object3D in the fighter's item hand — attach held item meshes here. */
  getHandAnchor?(): THREE.Object3D;
  dispose(): void;
}

/** Turn toward the camera when facing sideways (radians). */
const CAM_TURN = 0.52;
const HALF_PI = Math.PI / 2;
const TWO_PI = Math.PI * 2;
const OUTLINE = 0x16121c;

const STARS_GEO = new THREE.OctahedronGeometry(0.08, 0);
const RING_GEO = new THREE.TorusGeometry(1, 0.06, 4, 28);

function wrapPi(a: number): number {
  a = (a + Math.PI) % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a - Math.PI;
}

interface PropRt {
  id: string;
  obj: THREE.Object3D;
  dangle?: DangleDef;
  baseRot: THREE.Euler;
  cur: number;
}

/** Base materials per fighter. */
interface Mats {
  main: THREE.MeshStandardMaterial;
  glow: THREE.MeshStandardMaterial;
  outline: THREE.MeshBasicMaterial;
  ring: THREE.MeshBasicMaterial;
  stars: THREE.MeshBasicMaterial;
}

const _col = new THREE.Color();
const _col2 = new THREE.Color();
const _white = new THREE.Color(1, 1, 1);

class Rig implements FighterRig {
  root = new THREE.Group();
  height: number;

  private d: BuiltDesign;
  private fx = new THREE.Group();
  private yaw = new THREE.Group();
  private mirror = new THREE.Group();
  private tilt = new THREE.Group();
  private spin = new THREE.Group();
  private body = new THREE.Group();
  private joints: THREE.Object3D[] = [];
  private props: PropRt[] = [];
  private propById: Record<string, PropRt> = {};
  private hand = new THREE.Object3D();
  private ring: THREE.Mesh;
  private stars = new THREE.Group();
  private mats: Mats;
  private glowBase = new THREE.Color();

  private cur = new Float32Array(P.NCH);
  private tgt = new Float32Array(P.NCH);
  private tmp = new Float32Array(P.NCH);
  private tmp2 = new Float32Array(P.NCH);
  private c: P.PoseCtx;
  private first = true;

  private yawCur = HALF_PI - CAM_TURN;
  private spinX = 0;
  private spinY = 0;
  private spinZ = 0;
  private tumbleAng = 0;
  private cycle = 0;
  private visor = 0;
  private bubble = 0;
  private handGlow = 0;

  // move phase tracking
  private lastMove: MoveId | null = null;
  private lastMoveFrame = 0;
  private lastPhase: string | null = null;
  private activeStart = 0;
  private endStart = 0;
  private lastAction: ActionState | null = null;
  private poseTime = -1;
  private snap = false;

  constructor(characterId: string, teamColor: string | null) {
    const d = (this.d = getDesign(characterId));
    const s = d.skel;
    this.height = s.height;
    this.c = {
      id: d.id,
      style: d.archetype,
      heavy: d.archetype === 'bruiser',
      light: s.k < 0.95,
      thigh: s.thigh,
      shin: s.shin,
      k: s.k,
      t: 0,
      af: 0,
      vx: 0,
      vy: 0,
      fwd: 0,
      grounded: true,
      cyc: 0,
      launch: 0,
      charge: 0,
      spinX: 0,
      spinY: 0,
      spinZ: 0,
      spinOn: false,
      visorDown: false,
      bubble: 0,
      stars: false,
      handGlow: 0,
    };

    const main = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.62, metalness: 0.04 });
    const glow = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: d.glowColor, emissiveIntensity: 1.0, flatShading: true, roughness: 0.4 });
    this.glowBase.setHex(d.glowColor);
    glow.color.setHex(d.glowColor).multiplyScalar(0.4);
    const outline = makeOutlineMaterial(OUTLINE, 0.022 * s.k);
    const ring = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false });
    const stars = new THREE.MeshBasicMaterial({ color: 0xffe14a });
    this.mats = { main, glow, outline, ring, stars };

    // hierarchy
    this.root.name = 'fighter:' + d.id;
    this.root.add(this.fx);
    this.fx.add(this.yaw);
    this.yaw.add(this.mirror);
    this.mirror.add(this.tilt);
    this.tilt.position.y = s.center;
    this.tilt.add(this.spin);
    this.spin.add(this.body);
    this.body.position.y = -s.center;

    const J: Record<PartName, THREE.Object3D> = {} as Record<PartName, THREE.Object3D>;
    for (const n of PART_NAMES) {
      const o = new THREE.Group();
      o.name = n;
      J[n] = o;
      this.joints.push(o);
    }
    this.body.add(J.hips);
    J.hips.position.set(0, s.hipY, 0);
    J.hips.add(J.spine);
    J.spine.position.set(0, s.spineY, 0);
    J.spine.add(J.chest);
    J.chest.position.set(0, s.chestY, 0);
    J.chest.add(J.head);
    J.head.position.set(0, s.neckY, 0);
    for (const side of [1, -1] as const) {
      const pre = side === 1 ? 'l' : 'r';
      const ua = J[(pre + 'UA') as PartName];
      const fa = J[(pre + 'FA') as PartName];
      const hd = J[(pre + 'Hand') as PartName];
      J.chest.add(ua);
      ua.position.set(side * s.shoulderW, s.shoulderY, 0);
      ua.add(fa);
      fa.position.set(0, -s.ua, 0);
      fa.add(hd);
      hd.position.set(0, -s.fa, 0);
      const th = J[(pre + 'Th') as PartName];
      const sh = J[(pre + 'Sh') as PartName];
      const ft = J[(pre + 'Foot') as PartName];
      J.hips.add(th);
      th.position.set(side * s.hipW, -s.hipDrop, 0);
      th.add(sh);
      sh.position.set(0, -s.thigh, 0);
      sh.add(ft);
      ft.position.set(0, -s.shin, 0);
    }
    for (const n of PART_NAMES) this.attach(J[n], d.main[n], d.glow[n], true);

    for (const bp of d.props) {
      const o = new THREE.Group();
      o.name = bp.def.id;
      o.position.set(bp.def.pos[0], bp.def.pos[1], bp.def.pos[2]);
      if (bp.def.rot) o.rotation.set(bp.def.rot[0], bp.def.rot[1], bp.def.rot[2]);
      J[bp.def.parent].add(o);
      this.attach(o, bp.main, bp.glow, bp.def.outline !== false);
      const rt: PropRt = { id: bp.def.id, obj: o, dangle: bp.def.dangle, baseRot: o.rotation.clone(), cur: bp.def.dangle ? bp.def.dangle.base : 0 };
      this.props.push(rt);
      this.propById[rt.id] = rt;
    }
    if (this.propById.bubble) this.propById.bubble.obj.visible = false;

    J[d.hand].add(this.hand);
    this.hand.position.set(0, -0.08 * s.k, 0.04 * s.k);
    this.hand.name = 'handAnchor';

    // team ring (outside the yaw so it stays flat)
    this.ring = new THREE.Mesh(RING_GEO, ring);
    this.ring.rotation.x = -HALF_PI;
    this.ring.position.y = 0.03;
    this.ring.scale.setScalar(d.ringR);
    this.ring.renderOrder = -1;
    this.ring.visible = false;
    this.root.add(this.ring);

    // dizzy stars
    for (let i = 0; i < 3; i++) {
      const st = new THREE.Mesh(STARS_GEO, stars);
      st.scale.set(1, 1, 0.45);
      this.stars.add(st);
    }
    this.stars.visible = false;
    this.stars.position.y = s.height + 0.12;
    this.fx.add(this.stars);

    this.setTeamColor(teamColor);
  }

  private attach(o: THREE.Object3D, main: THREE.BufferGeometry | null, glow: THREE.BufferGeometry | null, outline: boolean): void {
    if (main) {
      const m = new THREE.Mesh(main, this.mats.main);
      m.castShadow = true;
      o.add(m);
      if (outline) {
        const ol = new THREE.Mesh(main, this.mats.outline);
        ol.castShadow = false;
        o.add(ol);
      }
    }
    if (glow) {
      const g = new THREE.Mesh(glow, this.mats.glow);
      g.castShadow = false;
      o.add(g);
    }
  }

  getHandAnchor(): THREE.Object3D {
    return this.hand;
  }

  setTeamColor(css: string | null): void {
    if (css) {
      this.mats.ring.color.set(css);
      this.ring.visible = true;
      _col.set(css);
      this.mats.outline.color.setHex(OUTLINE).lerp(_col, 0.45);
    } else {
      this.ring.visible = false;
      this.mats.outline.color.setHex(OUTLINE);
    }
  }

  // -------------------------------------------------------------------------
  update(v: FighterView, dt: number, time: number): void {
    if (v.action === 'ko' || v.action === 'out' || v.out) {
      this.root.visible = false;
      this.first = true;
      return;
    }
    this.root.visible = true;
    dt = Math.min(Math.max(dt, 0), 0.1);
    const c = this.c;
    c.t = time;
    c.af = v.actionFrame;
    c.vx = v.vx;
    c.vy = v.vy;
    c.fwd = v.vx * v.facing;
    c.grounded = v.grounded;
    c.launch = v.launchSpeed;
    c.charge = v.charge;
    this.resetOutputs();

    // locomotion phase
    const speed = Math.abs(v.vx);
    if (v.action === 'walk' || v.action === 'run') {
      const stride = (v.action === 'run' ? 1.35 : 0.9) * c.k;
      this.cycle += TWO_PI * Math.max(speed * 60, 0.6) * dt / stride;
      c.cyc = this.cycle;
    }

    let rate = 22;
    this.snap = false;
    const tgt = this.tgt;
    const a = v.action;

    if (a !== this.lastAction) {
      if (a === 'tumble' || a === 'thrown') this.tumbleAng = this.spinX;
    }

    switch (a) {
      case 'idle':
      case 'respawn':
        P.idle(tgt, c);
        rate = 14;
        break;
      case 'turn':
        P.idle(tgt, c);
        break;
      case 'walk':
        P.walk(tgt, c);
        rate = 16;
        break;
      case 'run':
        P.run(tgt, c);
        rate = 18;
        break;
      case 'crouch':
        P.crouch(tgt, c, 1);
        rate = 28;
        break;
      case 'jumpSquat':
        P.crouch(tgt, c, 0.55);
        rate = 40;
        break;
      case 'jump':
        P.jump(tgt, c);
        rate = 16;
        break;
      case 'doubleJump': {
        const u = Math.min(1, v.actionFrame / 20);
        if (u < 1) {
          P.tuck(tgt);
          c.spinOn = true;
          c.spinX = P.ease(u) * TWO_PI;
        } else P.fall(tgt, c);
        rate = 24;
        break;
      }
      case 'fall':
        P.fall(tgt, c);
        rate = 10;
        break;
      case 'land': {
        const u = Math.max(0, 1 - v.actionFrame / 8);
        P.crouch(tgt, c, 0.75 * u + 0.2);
        rate = 40;
        break;
      }
      case 'attack':
        if (v.move) rate = this.attackPose(v, c);
        else P.idle(tgt, c);
        break;
      case 'shield':
        P.shield(tgt, c);
        rate = 30;
        break;
      case 'shieldStun':
        P.shield(tgt, c);
        tgt[P.PITCH] -= 0.1;
        tgt[P.OX] -= 0.04;
        rate = 40;
        break;
      case 'shieldBreak':
        P.starfish(tgt);
        tgt[P.LUA * 3] = -2.6 + Math.sin(time * 18) * 0.4;
        tgt[P.RUA * 3] = -2.6 - Math.sin(time * 18) * 0.4;
        c.spinOn = true;
        c.spinY = v.actionFrame * 0.12;
        break;
      case 'dizzy':
        P.dizzy(tgt, c);
        rate = 10;
        break;
      case 'roll': {
        P.tuck(tgt);
        tgt[P.OY] = -(this.d.skel.center - 0.38 * c.k);
        const dir = Math.sign(c.fwd) || 1;
        c.spinOn = true;
        c.spinX = dir * P.ease(Math.min(1, v.actionFrame / 22)) * TWO_PI;
        rate = 35;
        break;
      }
      case 'spotDodge':
        P.crouch(tgt, c, 0.35);
        tgt[P.WZ] = -0.45;
        tgt[P.TWIST] = -0.6;
        tgt[P.SPINE * 3] = -0.2;
        rate = 35;
        break;
      case 'airDodge':
        P.tuck(tgt);
        tgt[P.WZ] = -0.35;
        tgt[P.ROLL] = 0.3;
        rate = 30;
        break;
      case 'ledgeHang':
        P.ledgeHang(tgt, c);
        rate = 18;
        break;
      case 'ledgeClimb': {
        const u = Math.min(1, v.actionFrame / 22);
        if (u < 0.5) {
          P.crouch(tgt, c, 1);
          tgt[P.LUA * 3] = -0.4;
          tgt[P.RUA * 3] = -0.4;
        } else P.idle(tgt, c);
        rate = 20;
        break;
      }
      case 'grabHold':
        P.grabHold(tgt, c);
        break;
      case 'grabbed':
        P.grabbed(tgt, c);
        break;
      case 'thrown':
      case 'tumble':
        P.starfish(tgt);
        this.tumbleAng -= dt * 60 * (0.12 + Math.min(0.6, v.launchSpeed * 1.4));
        c.spinOn = true;
        c.spinX = this.tumbleAng;
        rate = 14;
        break;
      case 'hitstun':
        P.hitstun(tgt, c, Math.min(1, v.launchSpeed * 6));
        rate = v.actionFrame < 2 ? 60 : 20;
        break;
      case 'helpless':
        P.helpless(tgt, c);
        rate = 8;
        break;
      case 'knockdown':
        P.lying(tgt, c, this.d.skel.center);
        rate = 22;
        break;
      case 'getUp': {
        const u = Math.min(1, v.actionFrame / 22);
        P.lying(this.tmp, c, this.d.skel.center);
        P.crouch(this.tmp2, c, 0.8);
        P.lerpPose(tgt, this.tmp, this.tmp2, P.ease(u));
        rate = 30;
        break;
      }
      case 'victory':
        P.victory(tgt, c);
        rate = 14;
        break;
      case 'defeat':
        P.clap(tgt, c);
        rate = 10;
        break;
      default:
        P.idle(tgt, c);
    }
    this.lastAction = a;

    // facing / yaw
    let yawTarget = v.facing === 1 ? HALF_PI - CAM_TURN : -(HALF_PI - CAM_TURN);
    if (a === 'victory' || a === 'defeat') yawTarget = v.facing === 1 ? 0.35 : -0.35;
    if (a === 'ledgeHang') yawTarget *= 0.75;
    const yawRate = a === 'turn' ? 26 : 18;

    this.apply(dt, rate, this.snap, yawTarget, yawRate, time);
    this.effects(v, dt, time);
  }

  /** Attack poses with phase-aware timing. Returns the blend rate. */
  private attackPose(v: FighterView, c: P.PoseCtx): number {
    const move = v.move as MoveId;
    const mf = v.moveFrame;
    const phase = v.movePhase ?? 'startup';
    if (move !== this.lastMove || mf < this.lastMoveFrame) {
      this.activeStart = 0;
      this.endStart = 0;
      this.lastPhase = null;
    }
    if (phase === 'active' && this.lastPhase !== 'active') {
      this.activeStart = mf;
      this.snap = true;
    }
    if (phase === 'endlag' && this.lastPhase !== 'endlag') {
      this.endStart = mf;
      if (!this.activeStart) this.activeStart = Math.max(1, mf - 2);
    }
    this.lastMove = move;
    this.lastMoveFrame = mf;
    this.lastPhase = phase;
    const tgt = this.tgt;

    if (phase === 'startup' || phase === 'charge') {
      P.movePose(tgt, c, move, 'wind', 0);
      if (phase === 'startup') {
        const est = Math.max(3, Math.min(18, v.moveTotal * 0.3));
        const u = P.ease(Math.min(1, mf / est));
        const base = this.tmp;
        // blend from the neutral pose toward the wind-up
        const vis = c.visorDown;
        const hg = c.handGlow;
        if (c.grounded) P.idle(base, c);
        else P.fall(base, c);
        c.visorDown = vis;
        c.handGlow = hg;
        P.lerpPose(tgt, base, tgt, 0.35 + 0.65 * u);
        return 30;
      }
      // charging smash: tremble
      const tr = Math.sin(c.t * 70) * 0.035 * (0.4 + c.charge);
      tgt[P.SPINE * 3] += tr;
      tgt[P.CHEST * 3 + 1] += tr;
      tgt[P.OX] += tr * 0.3;
      c.handGlow = Math.max(c.handGlow, 0.4 + c.charge * 0.6);
      return 30;
    }
    if (phase === 'active') {
      P.movePose(tgt, c, move, 'strike', mf - this.activeStart);
      return 50;
    }
    // endlag
    const span = Math.max(1, v.moveTotal - this.endStart);
    const u = (mf - this.endStart) / span;
    const aEnd = Math.max(0, this.endStart - this.activeStart) + (mf - this.endStart);
    if (u < 0.4) {
      P.movePose(tgt, c, move, 'strike', aEnd);
      return 20;
    }
    if (c.grounded) P.idle(tgt, c);
    else P.fall(tgt, c);
    // keep continuous spins wound down smoothly
    return 9;
  }

  private resetOutputs(): void {
    const c = this.c;
    c.spinOn = false;
    c.spinX = 0;
    c.spinY = 0;
    c.spinZ = 0;
    c.visorDown = false;
    c.bubble = 0;
    c.stars = false;
    c.handGlow = 0;
  }

  /** Blend toward the target and write joint transforms. */
  private apply(dt: number, rate: number, snap: boolean, yawTarget: number, yawRate: number, time: number): void {
    const cur = this.cur;
    const tgt = this.tgt;
    const c = this.c;
    if (this.first || snap) {
      cur.set(tgt);
    } else {
      const k = 1 - Math.exp(-rate * dt);
      for (let i = 0; i < P.NCH; i++) cur[i] += (tgt[i] - cur[i]) * k;
    }
    // yaw
    if (this.first) this.yawCur = yawTarget;
    else this.yawCur += (yawTarget - this.yawCur) * (1 - Math.exp(-yawRate * dt));
    this.yaw.rotation.y = this.yawCur;
    this.mirror.scale.x = this.yawCur >= 0 ? 1 : -1;

    // spins
    if (c.spinOn) {
      this.spinX = c.spinX;
      this.spinY = c.spinY;
      this.spinZ = c.spinZ;
    } else {
      const k = 1 - Math.exp(-16 * dt);
      this.spinX = wrapPi(this.spinX);
      this.spinY = wrapPi(this.spinY);
      this.spinZ = wrapPi(this.spinZ);
      this.spinX -= this.spinX * k;
      this.spinY -= this.spinY * k;
      this.spinZ -= this.spinZ * k;
    }
    this.spin.rotation.set(this.spinX, this.spinY, this.spinZ, 'YXZ');

    // joints
    const J = this.joints;
    for (let j = 0; j < P.NJ; j++) {
      const i = j * 3;
      J[j].rotation.set(cur[i], cur[i + 1], cur[i + 2]);
    }
    const s = this.d.skel;
    this.tilt.position.set(cur[P.OX], s.center + cur[P.OY], cur[P.OZ]);
    this.tilt.rotation.set(cur[P.PITCH], cur[P.TWIST], cur[P.ROLL], 'YXZ');
    const sq = cur[P.SQ];
    this.tilt.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq));
    this.fx.position.z = cur[P.WZ];

    // props
    const fwd = c.fwd;
    for (const pr of this.props) {
      if (pr.dangle) {
        const d = pr.dangle;
        const speedTerm = Math.max(0, Math.min(1.2, Math.abs(fwd) * d.fwd + (c.spinOn ? 0.6 : 0)));
        const vyTerm = Math.max(-0.4, Math.min(1.0, c.vy * d.up));
        const wv = Math.sin(time * d.waveSpeed + d.phase) * d.wave * (0.4 + speedTerm);
        const target = Math.min(d.max, d.base + speedTerm + (c.grounded ? 0 : vyTerm) + wv);
        pr.cur += (target - pr.cur) * (1 - Math.exp(-10 * dt));
        pr.obj.rotation.x = pr.baseRot.x + pr.cur;
      }
    }
    const visor = this.propById.visor;
    if (visor) {
      this.visor += ((c.visorDown ? 1 : 0) - this.visor) * (1 - Math.exp(-20 * dt));
      visor.obj.rotation.x = -1.35 * (1 - this.visor);
    }
    const bub = this.propById.bubble;
    if (bub) {
      this.bubble += (c.bubble - this.bubble) * (c.bubble < this.bubble ? 1 : 1 - Math.exp(-12 * dt));
      bub.obj.visible = this.bubble > 0.02;
      const r = 0.02 + this.bubble * 0.13 * s.k;
      bub.obj.scale.setScalar(r);
    }
    this.first = false;
  }

  private effects(v: FighterView, dt: number, time: number): void {
    // hitlag shake
    if (v.hitlag > 0) {
      const amp = 0.03 + Math.min(v.hitlag, 12) * 0.006;
      this.fx.position.x = (Math.random() - 0.5) * 2 * amp;
      this.fx.position.y = (Math.random() - 0.5) * amp;
    } else {
      this.fx.position.x = 0;
      this.fx.position.y = 0;
    }
    this.stars.visible = this.c.stars;
    if (this.c.stars) {
      for (let i = 0; i < 3; i++) {
        const a = time * 4 + (i * TWO_PI) / 3;
        const st = this.stars.children[i];
        st.position.set(Math.cos(a) * 0.3, Math.sin(a * 2) * 0.04, Math.sin(a) * 0.3);
        st.rotation.y = time * 6;
      }
    }
    this.glowFx(v.invincible, v.powered, v.movePhase === 'charge' ? v.charge : 0, dt, time);
  }

  private glowFx(invincible: boolean, powered: boolean, charge: number, dt: number, time: number): void {
    const m = this.mats;
    _col.setRGB(0, 0, 0);
    if (powered) {
      _col2.setHSL((time * 0.6) % 1, 1, 0.5);
      _col.add(_col2.multiplyScalar(0.35 + 0.15 * Math.sin(time * 8)));
    }
    if (charge > 0) {
      _col2.setHex(this.d.accent);
      _col.add(_col2.lerp(_white, 0.5).multiplyScalar(charge * (0.1 + 0.08 * Math.sin(time * 40))));
    }
    if (invincible) {
      const f = 0.5 + 0.5 * Math.sin(time * 30);
      _col.r += 0.16 * f;
      _col.g += 0.18 * f;
      _col.b += 0.24 * f;
    }
    m.main.emissive.copy(_col);
    this.handGlow += (this.c.handGlow - this.handGlow) * (1 - Math.exp(-14 * dt));
    m.glow.emissiveIntensity = 0.75 + this.handGlow * 1.2 + (powered ? 0.8 : 0) + Math.sin(time * 6) * 0.15;
    if (powered) m.glow.emissive.setHSL((time * 0.6) % 1, 1, 0.55);
    else m.glow.emissive.copy(this.glowBase);
  }

  // -------------------------------------------------------------------------
  setPose(pose: FighterPose, time: number): void {
    const dt = this.poseTime < 0 ? 0 : Math.min(0.1, Math.max(0, time - this.poseTime));
    this.poseTime = time;
    this.root.visible = true;
    const c = this.c;
    c.t = time;
    c.af = Math.floor(time * 60);
    c.vx = 0;
    c.vy = 0;
    c.fwd = 0;
    c.grounded = true;
    c.launch = 0;
    c.charge = 0;
    this.resetOutputs();
    let yaw = 0.45;
    switch (pose) {
      case 'victory':
        P.victory(this.tgt, c);
        yaw = 0.3;
        break;
      case 'defeat':
        P.clap(this.tgt, c);
        yaw = 0.2;
        break;
      case 'portrait':
        P.portrait(this.tgt, c);
        yaw = 0.55;
        break;
      default:
        P.idle(this.tgt, c);
        yaw = 0.6;
    }
    this.apply(dt, 14, false, yaw, 18, time);
    this.fx.position.set(0, 0, 0);
    this.stars.visible = false;
    this.glowFx(false, false, 0, dt, time);
  }

  dispose(): void {
    const m = this.mats;
    m.main.dispose();
    m.glow.dispose();
    m.outline.dispose();
    m.ring.dispose();
    m.stars.dispose();
    this.root.removeFromParent();
  }

  /** Debug / perf: meshes + triangles in this rig. */
  stats(): { meshes: number; triangles: number } {
    let meshes = 0;
    let tris = 0;
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        meshes++;
        const g = mesh.geometry;
        tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
      }
    });
    return { meshes, triangles: Math.round(tris) };
  }
}

export function buildFighterModel(characterId: string, opts?: { teamColor?: string | null }): FighterRig {
  return new Rig(characterId, opts?.teamColor ?? null);
}

/** Dev / perf helper. */
export function rigStats(rig: FighterRig): { meshes: number; triangles: number } {
  return (rig as Rig).stats();
}
