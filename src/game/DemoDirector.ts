/**
 * TV-broadcast style camera for the attract (demo) race: cuts to a different
 * kart every ~7 s, mostly chase shots, with occasional trackside (static camera
 * the kart drives past), orbit and high "helicopter" shots.
 */
import * as THREE from 'three';
import type { IKart, ITrack, TrackSample } from '../core/types';
import { clamp, damp, wrap01 } from '../core/math';
import { FollowCamera } from './FollowCamera';

type ShotKind = 'chase' | 'trackside' | 'orbit' | 'heli';

const SHOT_MIN = 5.5;
const SHOT_MAX = 8.5;

function makeSample(): TrackSample {
  return {
    position: new THREE.Vector3(),
    tangent: new THREE.Vector3(0, 0, -1),
    normal: new THREE.Vector3(0, 1, 0),
    binormal: new THREE.Vector3(1, 0, 0),
    halfWidth: 0,
    wallHalfWidth: 0,
    t: 0,
  };
}

export class DemoDirector {
  private readonly follow: FollowCamera;
  private shot: ShotKind = 'chase';
  private shotTime = 0;
  private shotLength = 7;
  private targetId = 0;
  private lastTargetId = -1;
  private orbitAngle = 0;
  private readonly fixedPos = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly smp = makeSample();
  private readonly tmp = new THREE.Vector3();
  private fov = 60;
  private shotCount = 0;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly track: ITrack,
  ) {
    this.follow = new FollowCamera(camera);
    this.follow.setTrack(track);
  }

  /** Current focus kart (for shadows / audio). */
  get focusId(): number {
    return this.targetId;
  }

  start(karts: readonly IKart[]): void {
    this.targetId = karts.length > 0 ? Math.floor(Math.random() * karts.length) : 0;
    this.cut(karts, 'chase');
  }

  update(dt: number, karts: readonly IKart[]): void {
    if (karts.length === 0) return;
    this.shotTime += dt;
    let target = karts[this.targetId] ?? karts[0];
    if (this.shotTime >= this.shotLength || (this.shot === 'trackside' && this.passedTrackside(target))) {
      this.nextShot(karts);
      target = karts[this.targetId] ?? karts[0];
    }
    const p = target.state.position;
    switch (this.shot) {
      case 'chase':
        this.follow.update(dt, target, false);
        return;
      case 'trackside': {
        this.camera.position.copy(this.fixedPos);
        this.look.lerp(this.tmp.copy(p).setY(p.y + 0.8), 1 - Math.exp(-10 * dt));
        const d = this.fixedPos.distanceTo(p);
        this.fov = damp(this.fov, clamp(900 / Math.max(8, d), 22, 62), 4, dt);
        break;
      }
      case 'orbit': {
        this.orbitAngle += dt * 0.45;
        const r = 9.5;
        this.camera.position.set(p.x + Math.cos(this.orbitAngle) * r, p.y + 3.6, p.z + Math.sin(this.orbitAngle) * r);
        this.look.copy(p).setY(p.y + 0.7);
        this.fov = damp(this.fov, 55, 3, dt);
        break;
      }
      case 'heli': {
        const h = target.state.heading;
        this.tmp.set(Math.sin(h) * 16, 22, Math.cos(h) * 16).add(p);
        this.camera.position.lerp(this.tmp, 1 - Math.exp(-2.5 * dt));
        this.look.lerp(this.tmp.copy(p).setY(p.y + 0.5), 1 - Math.exp(-6 * dt));
        this.fov = damp(this.fov, 50, 3, dt);
        break;
      }
    }
    // Ground clamp for free cameras.
    const ground = this.track.heightAt(this.camera.position.x, this.camera.position.z);
    if (Number.isFinite(ground) && this.camera.position.y < ground + 1.2) this.camera.position.y = ground + 1.2;
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.look);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  dispose(): void {
    this.follow.dispose();
  }

  // ----------------------------------------------------------------- private

  private nextShot(karts: readonly IKart[]): void {
    // Prefer front-runners and karts in a close battle; never the same kart twice in a row.
    let best = -1;
    let bestScore = -Infinity;
    for (const k of karts) {
      const s = k.state;
      if (s.id === this.targetId && karts.length > 1) continue;
      let score = Math.random() * 3 - s.place * 0.35;
      for (const o of karts) {
        if (o === k) continue;
        if (o.state.position.distanceToSquared(s.position) < 64) score += 1.2;
      }
      if (s.isBoosting || s.isDrifting) score += 0.6;
      if (s.id === this.lastTargetId) score -= 1;
      if (score > bestScore) {
        bestScore = score;
        best = s.id;
      }
    }
    this.lastTargetId = this.targetId;
    if (best >= 0) this.targetId = best;
    const r = Math.random();
    const kind: ShotKind = this.shotCount % 3 === 0 ? 'chase' : r < 0.5 ? 'chase' : r < 0.75 ? 'trackside' : r < 0.9 ? 'orbit' : 'heli';
    this.cut(karts, kind);
  }

  private cut(karts: readonly IKart[], kind: ShotKind): void {
    const target = karts[this.targetId] ?? karts[0];
    this.shot = kind;
    this.shotTime = 0;
    this.shotCount++;
    this.shotLength = SHOT_MIN + Math.random() * (SHOT_MAX - SHOT_MIN);
    if (!target) return;
    const s = target.state;
    this.look.copy(s.position);
    switch (kind) {
      case 'chase':
        this.follow.snapTo(target);
        break;
      case 'trackside': {
        // Plant a camera beside the road ~55 m ahead of the kart.
        const len = Math.max(100, this.track.length);
        const smp = this.track.sample(wrap01(s.trackT + 55 / len), this.smp);
        const side = Math.random() < 0.5 ? -1 : 1;
        this.fixedPos
          .copy(smp.position)
          .addScaledVector(smp.binormal, side * (smp.wallHalfWidth + 3.5));
        this.fixedPos.y += 2.2 + Math.random() * 2.5;
        const g = this.track.heightAt(this.fixedPos.x, this.fixedPos.z);
        if (Number.isFinite(g) && this.fixedPos.y < g + 1.5) this.fixedPos.y = g + 1.5;
        this.shotLength = 9;
        this.fov = 40;
        break;
      }
      case 'orbit':
        this.orbitAngle = Math.random() * Math.PI * 2;
        this.fov = 55;
        break;
      case 'heli':
        this.camera.position.copy(s.position).add(this.tmp.set(0, 22, 16));
        this.fov = 50;
        break;
    }
  }

  private passedTrackside(target: IKart): boolean {
    if (this.shotTime < 2.5) return false;
    // Cut once the kart has gone well past the camera.
    target.forwardDir(this.tmp);
    const dx = target.state.position.x - this.fixedPos.x;
    const dz = target.state.position.z - this.fixedPos.z;
    const along = dx * this.tmp.x + dz * this.tmp.z;
    return along > 25;
  }
}
