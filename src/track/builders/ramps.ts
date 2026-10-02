import * as THREE from 'three';
import type { JumpRampInfo } from '../../core/types';
import { JUMP_RAMP_HEIGHT, JUMP_RAMP_LENGTH } from '../../core/constants';
import { wrap01 } from '../../core/math';
import { type BuildContext, track, trackMesh } from './context';
import { frameAtS } from './props';
import { makeRampTexture } from '../textures';

/** Gap kept between a ramp's side and the road edge (metres). */
export const JUMP_RAMP_EDGE_INSET = 1.4;
const SEGMENTS = 8;
const LIFT = 0.03;
const GLOW_DEPTH = 0.45;

/** Lateral half width of a ramp at a given road half width. */
export function jumpRampHalfWidth(roadHalfWidth: number): number {
  return Math.max(3, roadHalfWidth - JUMP_RAMP_EDGE_INSET);
}

/** Gameplay description of each ramp (positions only; no geometry). */
export function computeJumpRamps(ctx: BuildContext): JumpRampInfo[] {
  const { cl, def } = ctx;
  const out: JumpRampInfo[] = [];
  for (const raw of def.jumpRamps ?? []) {
    const t = wrap01(raw);
    const s0 = t * cl.length;
    const lip = frameAtS(ctx, s0 + JUMP_RAMP_LENGTH);
    const start = frameAtS(ctx, s0);
    out.push({
      t,
      tEnd: wrap01((s0 + JUMP_RAMP_LENGTH) / cl.length),
      position: new THREE.Vector3(lip.x, lip.y, lip.z),
      forward: new THREE.Vector3(lip.fx, 0, lip.fz).normalize(),
      halfWidth: jumpRampHalfWidth(Math.min(start.hw, lip.hw)),
      length: JUMP_RAMP_LENGTH,
      height: JUMP_RAMP_HEIGHT,
    });
  }
  return out;
}

/**
 * Striped kicker ramps with a glowing lip. Three merged meshes for all ramps on the track
 * (top surface, side/back walls, glow strip).
 */
export function buildJumpRamps(ctx: BuildContext, ramps: readonly JumpRampInfo[]): THREE.Group | null {
  if (ramps.length === 0) return null;
  const { cl, def } = ctx;
  const group = new THREE.Group();
  group.name = 'jumpRamps';

  const topV: number[] = [];
  const topU: number[] = [];
  const topI: number[] = [];
  const sideV: number[] = [];
  const glowV: number[] = [];

  const quad = (arr: number[], a: number[], b: number[], c: number[], d: number[]): void => {
    // a-b-c, a-c-d (counter-clockwise seen from outside)
    arr.push(...a, ...b, ...c, ...a, ...c, ...d);
  };

  for (const r of ramps) {
    const s0 = r.t * cl.length;
    const w = r.halfWidth;
    const base = topV.length / 3;
    let prevL: number[] | null = null;
    let prevR: number[] | null = null;
    let prevLB: number[] | null = null;
    let prevRB: number[] | null = null;
    for (let k = 0; k <= SEGMENTS; k++) {
      const f = frameAtS(ctx, s0 + (r.length * k) / SEGMENTS);
      const h = (r.height * k) / SEGMENTS + LIFT;
      const L = [f.x - f.rx * w, f.y + h, f.z - f.rz * w];
      const R = [f.x + f.rx * w, f.y + h, f.z + f.rz * w];
      const LB = [L[0], f.y - 0.05, L[2]];
      const RB = [R[0], f.y - 0.05, R[2]];
      topV.push(...L, ...R);
      topU.push(0, k / SEGMENTS, 1, k / SEGMENTS);
      if (prevL && prevR && prevLB && prevRB) {
        // left wall (outside faces -right)
        quad(sideV, prevLB, prevL, L, LB);
        // right wall
        quad(sideV, prevRB, RB, R, prevR);
      }
      prevL = L;
      prevR = R;
      prevLB = LB;
      prevRB = RB;
      if (k === SEGMENTS) {
        // back (lip) face, facing forward
        quad(sideV, LB, L, R, RB);
        // glow strip on top of the lip: a thin band just before the edge + down the back face
        const fb = frameAtS(ctx, s0 + r.length - GLOW_DEPTH);
        const hb = r.height * (1 - GLOW_DEPTH / r.length) + LIFT + 0.015;
        const gL0 = [fb.x - fb.rx * w, fb.y + hb, fb.z - fb.rz * w];
        const gR0 = [fb.x + fb.rx * w, fb.y + hb, fb.z + fb.rz * w];
        const gL1 = [L[0], L[1] + 0.015, L[2]];
        const gR1 = [R[0], R[1] + 0.015, R[2]];
        quad(glowV, gL0, gR0, gR1, gL1);
        // a band down the back face (slightly in front of it)
        const ox = f.fx * 0.02;
        const oz = f.fz * 0.02;
        quad(
          glowV,
          [L[0] + ox, L[1], L[2] + oz],
          [R[0] + ox, R[1], R[2] + oz],
          [R[0] + ox, L[1] - 0.22, R[2] + oz],
          [L[0] + ox, L[1] - 0.22, L[2] + oz],
        );
      }
    }
    for (let k = 0; k < SEGMENTS; k++) {
      const a = base + k * 2;
      topI.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  const tex = makeRampTexture();
  track(ctx, tex);

  const topGeo = new THREE.BufferGeometry();
  topGeo.setAttribute('position', new THREE.Float32BufferAttribute(topV, 3));
  topGeo.setAttribute('uv', new THREE.Float32BufferAttribute(topU, 2));
  topGeo.setIndex(topI);
  topGeo.computeVertexNormals();
  topGeo.computeBoundingSphere();
  // A touch of self-illumination so the stripes read on night tracks (and in shadow).
  const topMat = new THREE.MeshStandardMaterial({
    map: tex,
    emissive: 0xffffff,
    emissiveMap: tex,
    emissiveIntensity: def.theme === 'neon' ? 0.45 : 0.1,
    roughness: 0.55,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });
  const top = new THREE.Mesh(topGeo, topMat);
  top.name = 'jumpRampTop';
  top.castShadow = true;
  top.receiveShadow = true;
  trackMesh(ctx, top);
  group.add(top);

  const sideGeo = new THREE.BufferGeometry();
  sideGeo.setAttribute('position', new THREE.Float32BufferAttribute(sideV, 3));
  sideGeo.computeVertexNormals();
  sideGeo.computeBoundingSphere();
  const sideColor = def.theme === 'neon' ? 0x2a1840 : def.theme === 'snow' ? 0x3a5a7a : 0x3a3a44;
  const sideMat = new THREE.MeshStandardMaterial({ color: sideColor, roughness: 0.7, side: THREE.DoubleSide });
  const sides = new THREE.Mesh(sideGeo, sideMat);
  sides.name = 'jumpRampSides';
  sides.castShadow = true;
  trackMesh(ctx, sides);
  group.add(sides);

  const glowGeo = new THREE.BufferGeometry();
  glowGeo.setAttribute('position', new THREE.Float32BufferAttribute(glowV, 3));
  glowGeo.computeBoundingSphere();
  const glowColor = def.theme === 'desert' ? 0xffb03a : def.theme === 'neon' ? 0xff3fe0 : 0x5ff6ff;
  const glowMat = new THREE.MeshBasicMaterial({ color: glowColor, side: THREE.DoubleSide, toneMapped: false });
  glowMat.color.multiplyScalar(2.2); // HDR so the lip blooms
  const glow = new THREE.Mesh(glowGeo, glowMat);
  glow.name = 'jumpRampGlow';
  trackMesh(ctx, glow);
  group.add(glow);

  // Gentle pulse on the lip so it reads from a distance.
  const baseColor = glowMat.color.clone();
  ctx.updaters.push((_dt, elapsed) => {
    const k = 0.75 + 0.25 * Math.sin(elapsed * 6);
    glowMat.color.copy(baseColor).multiplyScalar(k);
  });

  return group;
}
