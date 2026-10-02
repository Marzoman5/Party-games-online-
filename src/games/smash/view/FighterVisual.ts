/**
 * One fighter on screen: the MODEL rig plus per-fighter extras (shield bubble, respawn halo,
 * charge / power glow, blob shadow). Per-match; dispose() frees everything it created and
 * calls rig.dispose() (the rig owns its own geometry caches).
 */
import * as THREE from 'three';
import { buildFighterModel, type FighterRig } from '../model/FighterModel';
import type { FighterView } from '../types';
import { disposeTree, softCircleTexture } from './util';

function fallbackRig(color: number): FighterRig {
  const root = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, flatShading: true });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 1.0, 4, 8), mat);
  body.position.y = 0.9;
  root.add(body);
  return {
    root,
    height: 1.8,
    update(v) {
      root.rotation.y = v.facing === 1 ? 0.9 : -0.9;
    },
    setPose() {},
    setTeamColor() {},
    dispose() {
      body.geometry.dispose();
      mat.dispose();
    },
  };
}

export class FighterVisual {
  readonly group = new THREE.Group();
  readonly rig: FighterRig;
  readonly color: number;
  private readonly shield: THREE.Mesh;
  private readonly shieldMat: THREE.MeshBasicMaterial;
  private readonly halo: THREE.Group;
  private readonly glow: THREE.Sprite;
  private readonly glowMat: THREE.SpriteMaterial;
  readonly blob: THREE.Mesh;
  private readonly blobMat: THREE.MeshBasicMaterial;
  private shieldFlash = 0;
  private readonly extras = new THREE.Group();
  /** Last known feet position (for effects after KO). */
  lastX = 0;
  lastY = 0;
  /** Results / sandbox: pose override instead of sim view. */
  pose: 'victory' | 'defeat' | 'idle' | null = null;

  constructor(characterId: string, color: number, teamColor: string | null) {
    this.color = color;
    let rig: FighterRig;
    try {
      rig = buildFighterModel(characterId, { teamColor });
    } catch (err) {
      console.error('[smash] buildFighterModel failed', characterId, err);
      rig = fallbackRig(color);
    }
    this.rig = rig;
    this.group.add(rig.root);
    this.group.add(this.extras);

    this.shieldMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    this.shield = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), this.shieldMat);
    this.shield.visible = false;
    this.shield.renderOrder = 15;
    this.extras.add(this.shield);

    // respawn halo platform
    this.halo = new THREE.Group();
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.6, 0.12, 24), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: color, emissiveIntensity: 0.9, roughness: 0.3, metalness: 0.3 }));
    disc.position.y = -0.06;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.05, 6, 32), new THREE.MeshBasicMaterial({ color, fog: false }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -0.02;
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.8, 0.5, 2.4, 20, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }),
    );
    beam.position.y = -1.3;
    this.halo.add(disc, ring, beam);
    this.halo.visible = false;
    this.extras.add(this.halo);

    this.glowMat = new THREE.SpriteMaterial({ map: softCircleTexture(), color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    this.glow = new THREE.Sprite(this.glowMat);
    this.glow.visible = false;
    this.extras.add(this.glow);

    this.blobMat = new THREE.MeshBasicMaterial({ map: softCircleTexture(), color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false, fog: false });
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.blobMat);
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.renderOrder = 2;
    this.extras.add(this.blob);
  }

  get height(): number {
    return this.rig.height || 1.8;
  }

  setShadows(on: boolean): void {
    this.rig.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.castShadow = on;
    });
  }

  flashShield(): void {
    this.shieldFlash = 1;
  }

  /**
   * Per-frame update from the sim view. groundY = surface under the fighter (or null).
   */
  update(v: FighterView, dt: number, time: number, groundY: number | null, blobShadows: boolean): void {
    const visible = !v.out && v.action !== 'ko' && v.action !== 'out';
    const rig = this.rig;
    this.lastX = v.x;
    this.lastY = v.y;
    if (this.pose) {
      rig.root.visible = true;
      rig.setPose(this.pose, time);
    } else {
      rig.update(v, dt, time);
      rig.root.visible = visible;
    }
    let jx = 0;
    if (v.hitlag > 0 && (v.action === 'hitstun' || v.action === 'tumble' || v.action === 'shieldStun')) jx = Math.sin(time * 95) * 0.07;
    if (!this.pose) rig.root.position.set(v.x + jx, v.y, 0);
    const h = this.height;
    const cx = rig.root.position.x;
    const cy = rig.root.position.y + h * 0.5;

    // shield bubble
    this.shieldFlash = Math.max(0, this.shieldFlash - dt * 6);
    if (visible && v.shielding && !this.pose) {
      this.shield.visible = true;
      const s = h * (0.33 + 0.38 * Math.max(0, Math.min(1, v.shield)));
      this.shield.scale.setScalar(s);
      this.shield.position.set(cx, cy, 0);
      this.shieldMat.color.setHex(this.color);
      if (this.shieldFlash > 0) this.shieldMat.color.lerp(new THREE.Color(0xffffff), this.shieldFlash);
      this.shieldMat.opacity = 0.32 + 0.12 * Math.sin(time * 10) + 0.4 * this.shieldFlash + (v.shield < 0.3 ? 0.15 * Math.sin(time * 30) : 0);
    } else {
      this.shield.visible = false;
    }

    // respawn halo
    const onHalo = v.action === 'respawn' && !this.pose;
    this.halo.visible = onHalo;
    if (onHalo) {
      this.halo.position.set(v.x, v.y, 0);
      this.halo.rotation.y = time * 2;
    }

    // charge / power / invincibility glow
    let g = 0;
    let gc = 0xffffff;
    let gs = h * 1.6;
    if (visible && !this.pose) {
      if (v.movePhase === 'charge') {
        g = 0.35 + 0.5 * v.charge + 0.2 * Math.sin(time * 40);
        gc = 0xffe060;
        gs = h * (1.2 + 0.8 * v.charge);
      } else if (v.powered) {
        g = 0.55 + 0.2 * Math.sin(time * 8);
        gc = new THREE.Color().setHSL((time * 0.5) % 1, 1, 0.6).getHex();
        gs = h * 2.2;
      } else if (v.invincible && v.action !== 'respawn' && v.action !== 'roll' && v.action !== 'spotDodge' && v.action !== 'airDodge') {
        g = 0.18 + 0.12 * Math.sin(time * 20);
      }
    }
    this.glow.visible = g > 0.01;
    if (this.glow.visible) {
      this.glowMat.opacity = Math.min(1, g);
      this.glowMat.color.setHex(gc);
      this.glow.scale.set(gs, gs, 1);
      this.glow.position.set(cx, cy, -0.3);
    }

    // blob shadow
    if (blobShadows && visible && groundY !== null && v.y >= groundY - 0.05) {
      const above = v.y - groundY;
      const k = Math.max(0, 1 - above / 6);
      this.blob.visible = k > 0.02;
      const s = (v.width || 0.8) * 1.6 * (0.6 + 0.4 * k);
      this.blob.scale.set(s, s * 0.55, 1);
      this.blob.position.set(cx, groundY + 0.02, rig.root.position.z);
      this.blobMat.opacity = 0.5 * k;
    } else {
      this.blob.visible = false;
    }
  }

  dispose(): void {
    this.rig.root.removeFromParent();
    try {
      this.rig.dispose();
    } catch (err) {
      console.warn('[smash] rig.dispose failed', err);
    }
    disposeTree(this.extras);
    this.group.removeFromParent();
  }
}
