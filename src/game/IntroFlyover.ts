/**
 * Pre-race intro (ported idea from Turbo Kart Rally): a ~4.5 s crane flight
 * along the last stretch of track toward the start grid, descending from high
 * above and sweeping in from the side, ending just above the grid. The
 * countdown swoop (FollowCamera.setCinematic) then starts from the final pose.
 */
import * as THREE from 'three';
import type { ITrack, TrackSample } from '../core/types';
import { clamp01, lerp, smoothstep, wrap01 } from '../core/math';

export const INTRO_SECONDS = 4.5;
const PATH_SPAN = 0.2; // fraction of the lap flown
const START_HEIGHT = 36;
const END_HEIGHT = 8.5;
const START_SIDE = 26;

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

export class IntroFlyover {
  readonly duration: number;
  private time = 0;
  private readonly gridT: number;
  private readonly gridCenter = new THREE.Vector3();
  private readonly s0 = makeSample();
  private readonly s1 = makeSample();
  readonly position = new THREE.Vector3();
  readonly look = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly side: number;

  constructor(
    private readonly track: ITrack,
    duration = INTRO_SECONDS,
  ) {
    this.duration = Math.max(0.5, duration);
    const grid = track.startGrid;
    if (grid.length > 0) {
      // Average the grid's t on the circle (it straddles t = 0 on some tracks).
      let sx = 0;
      let sy = 0;
      for (const g of grid) {
        sx += Math.cos(g.t * Math.PI * 2);
        sy += Math.sin(g.t * Math.PI * 2);
        this.gridCenter.add(g.position);
      }
      this.gridCenter.multiplyScalar(1 / grid.length);
      this.gridT = wrap01(Math.atan2(sy, sx) / (Math.PI * 2));
    } else {
      this.gridT = 0.985;
      this.gridCenter.copy(track.sample(this.gridT).position);
    }
    this.side = Math.random() < 0.5 ? -1 : 1;
    this.evaluate(0);
  }

  get done(): boolean {
    return this.time >= this.duration;
  }

  get progress(): number {
    return clamp01(this.time / this.duration);
  }

  update(dt: number, camera: THREE.PerspectiveCamera): void {
    this.time += dt;
    this.evaluate(this.progress);
    camera.position.copy(this.position);
    camera.up.set(0, 1, 0);
    camera.lookAt(this.look);
    const fov = lerp(52, 46, this.progress);
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }

  private evaluate(u: number): void {
    const e = smoothstep(0, 1, u);
    const pathT = wrap01(this.gridT - PATH_SPAN * (1 - e) - 0.012);
    const smp = this.track.sample(pathT, this.s0);
    const height = lerp(START_HEIGHT, END_HEIGHT, e);
    const side = lerp(START_SIDE, 3, e) * this.side;
    this.position.copy(smp.position).addScaledVector(smp.binormal, side);
    this.position.y += height;
    const ground = this.track.heightAt(this.position.x, this.position.z);
    if (Number.isFinite(ground) && this.position.y < ground + 5) this.position.y = ground + 5;

    // Look ahead along the track, settling on the grid for the last third.
    const ahead = this.track.sample(wrap01(pathT + lerp(0.05, 0.02, e)), this.s1);
    this.tmp.copy(ahead.position);
    this.tmp.y += 1;
    const toGrid = smoothstep(0.55, 1, u);
    this.look.copy(this.tmp).lerp(this.tmp.copy(this.gridCenter).setY(this.gridCenter.y + 0.8), toGrid);
  }
}
