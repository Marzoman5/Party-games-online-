/**
 * Item + projectile meshes. Prototypes (geometry/material) are created ONCE for the lifetime of
 * the engine; live items are cheap clones sharing them, so matches never grow GPU memory.
 */
import * as THREE from 'three';
import type { ItemKind, ItemView, ProjectileView } from '../types';
import { softCircleTexture } from './util';

function std(color: number, o: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1, flatShading: true, ...o });
}

export class ItemViews {
  readonly root = new THREE.Group();
  private readonly protos = new Map<ItemKind, THREE.Group>();
  private readonly live = new Map<number, { obj: THREE.Object3D; kind: ItemKind }>();
  private readonly proj = new Map<number, THREE.Object3D>();
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mats: THREE.Material[] = [];
  private readonly projMats = new Map<string, { core: THREE.MeshBasicMaterial; glow: THREE.SpriteMaterial }>();
  private readonly projGeo: THREE.SphereGeometry;
  private readonly orbMat: THREE.MeshStandardMaterial;
  private readonly fuseSpark: THREE.SpriteMaterial;
  private readonly seen = new Set<number>();
  /** Bomb fuses / orbs that should sparkle this frame (world positions). */
  readonly sparkles: { x: number; y: number }[] = [];

  constructor() {
    this.root.name = 'smash-items';
    const G = <T extends THREE.BufferGeometry>(g: T): T => {
      this.geos.push(g);
      return g;
    };
    const M = <T extends THREE.Material>(m: T): T => {
      this.mats.push(m);
      return m;
    };
    // --- bat: tapered barrel + grip + knob
    {
      const g = new THREE.Group();
      const barrel = new THREE.Mesh(G(new THREE.CylinderGeometry(0.11, 0.05, 0.85, 8)), M(std(0xd9a066)));
      barrel.position.y = 0.42;
      const band = new THREE.Mesh(G(new THREE.CylinderGeometry(0.105, 0.1, 0.06, 8)), M(std(0xff3a3a)));
      band.position.y = 0.65;
      const grip = new THREE.Mesh(G(new THREE.CylinderGeometry(0.05, 0.05, 0.3, 6)), M(std(0x222233)));
      grip.position.y = -0.12;
      const knob = new THREE.Mesh(G(new THREE.SphereGeometry(0.07, 6, 4)), M(std(0x222233)));
      knob.position.y = -0.28;
      g.add(barrel, band, grip, knob);
      this.protos.set('bat', g);
    }
    // --- bomb: dark sphere + cap + fuse
    {
      const g = new THREE.Group();
      const body = new THREE.Mesh(G(new THREE.SphereGeometry(0.3, 14, 10)), M(std(0x23233a, { metalness: 0.4, roughness: 0.35, flatShading: false })));
      body.position.y = 0.3;
      const cap = new THREE.Mesh(G(new THREE.CylinderGeometry(0.1, 0.12, 0.1, 8)), M(std(0x8a8aa0, { metalness: 0.8 })));
      cap.position.y = 0.62;
      const fuse = new THREE.Mesh(G(new THREE.CylinderGeometry(0.025, 0.025, 0.2, 5)), M(std(0xd8c8a0)));
      fuse.position.set(0.04, 0.74, 0);
      fuse.rotation.z = -0.4;
      const eyeMat = M(new THREE.MeshBasicMaterial({ color: 0xffffff }));
      const eyeGeo = G(new THREE.SphereGeometry(0.045, 6, 4));
      for (const sx of [-1, 1]) {
        const eye = new THREE.Mesh(eyeGeo, eyeMat);
        eye.position.set(sx * 0.09, 0.36, 0.27);
        eye.scale.set(1, 1.6, 0.6);
        g.add(eye);
      }
      g.add(body, cap, fuse);
      this.protos.set('bomb', g);
    }
    // --- food: glowing "power donut"
    {
      const g = new THREE.Group();
      const dough = new THREE.Mesh(G(new THREE.TorusGeometry(0.22, 0.1, 8, 16)), M(std(0xe0a060)));
      const glaze = new THREE.Mesh(G(new THREE.TorusGeometry(0.22, 0.085, 8, 16, Math.PI * 2)), M(std(0xff6ad5, { emissive: 0xff3ab8, emissiveIntensity: 0.6 })));
      glaze.position.z = 0.03;
      glaze.scale.set(1.02, 1.02, 0.8);
      const halo = new THREE.Sprite(M(new THREE.SpriteMaterial({ map: softCircleTexture(), color: 0xff8ae0, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false })));
      halo.scale.set(1.1, 1.1, 1);
      const inner = new THREE.Group();
      inner.add(dough, glaze);
      inner.position.y = 0.3;
      halo.position.y = 0.3;
      g.add(inner, halo);
      this.protos.set('food', g);
    }
    // --- capsule: two-tone "surprise capsule"
    {
      const g = new THREE.Group();
      const top = new THREE.Mesh(G(new THREE.SphereGeometry(0.22, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2)), M(std(0xff7a1a, { flatShading: false, roughness: 0.3 })));
      const bot = new THREE.Mesh(G(new THREE.SphereGeometry(0.22, 12, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2)), M(std(0xf4f4ff, { flatShading: false, roughness: 0.3 })));
      const midTop = new THREE.Mesh(G(new THREE.CylinderGeometry(0.22, 0.22, 0.12, 12)), top.material);
      midTop.position.y = -0.06;
      top.position.y = 0;
      const midBot = new THREE.Mesh(G(new THREE.CylinderGeometry(0.22, 0.22, 0.12, 12)), bot.material);
      midBot.position.y = -0.18;
      bot.position.y = -0.24;
      const q = new THREE.Group();
      q.add(top, midTop, midBot, bot);
      q.position.y = 0.46;
      q.rotation.z = 0.5;
      g.add(q);
      this.protos.set('capsule', g);
    }
    // --- orb: rainbow party orb
    {
      const g = new THREE.Group();
      this.orbMat = M(std(0xffffff, { emissive: 0xff00ff, emissiveIntensity: 0.9, roughness: 0.2 }));
      const core = new THREE.Mesh(G(new THREE.IcosahedronGeometry(0.42, 1)), this.orbMat);
      core.position.y = 0.5;
      const halo = new THREE.Sprite(M(new THREE.SpriteMaterial({ map: softCircleTexture(), color: 0xffffff, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false })));
      halo.scale.set(2.2, 2.2, 1);
      halo.position.y = 0.5;
      g.add(core, halo);
      this.protos.set('orb', g);
    }
    this.projGeo = G(new THREE.SphereGeometry(1, 12, 8));
    this.fuseSpark = M(new THREE.SpriteMaterial({ map: softCircleTexture(), color: 0xffd060, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  }

  private projMat(color: string): { core: THREE.MeshBasicMaterial; glow: THREE.SpriteMaterial } {
    let m = this.projMats.get(color);
    if (!m) {
      let c: THREE.Color;
      try {
        c = new THREE.Color(color);
      } catch {
        c = new THREE.Color(0xffffff);
      }
      m = {
        core: new THREE.MeshBasicMaterial({ color: c.clone().lerp(new THREE.Color(0xffffff), 0.45) }),
        glow: new THREE.SpriteMaterial({ map: softCircleTexture(), color: c, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
      };
      if (this.projMats.size < 32) this.projMats.set(color, m);
      else {
        // keep memory bounded: reuse the first cached entry
        return this.projMats.values().next().value!;
      }
    }
    return m;
  }

  update(
    items: readonly ItemView[],
    projectiles: readonly ProjectileView[],
    time: number,
    handPos: (fighter: number, out: THREE.Vector3) => boolean,
  ): void {
    this.sparkles.length = 0;
    // ---- items
    this.seen.clear();
    const tmp = new THREE.Vector3();
    for (const it of items) {
      this.seen.add(it.id);
      let rec = this.live.get(it.id);
      if (!rec || rec.kind !== it.kind) {
        if (rec) rec.obj.removeFromParent();
        const proto = this.protos.get(it.kind) ?? this.protos.get('capsule')!;
        const obj = proto.clone(true);
        obj.userData.shared = true;
        rec = { obj, kind: it.kind };
        this.live.set(it.id, rec);
        this.root.add(obj);
      }
      const o = rec.obj;
      if (it.holder >= 0 && handPos(it.holder, tmp)) {
        o.position.set(tmp.x, tmp.y - 0.3, tmp.z + 0.2);
      } else {
        o.position.set(it.x, it.y, 0.3);
      }
      o.rotation.z = it.rot;
      if (it.holder < 0 && it.kind !== 'bat') o.rotation.y = time * 1.5;
      o.visible = it.life > 120 || Math.floor(time * 12) % 2 === 0;
      if (it.kind === 'bomb' && (it.armed || Math.floor(time * 4) % 2 === 0)) this.sparkles.push({ x: o.position.x + 0.08, y: o.position.y + 0.85 });
      if (it.kind === 'orb') {
        const s = 1 + 0.08 * Math.sin(time * 6);
        o.scale.setScalar(s);
      }
      if (it.kind === 'food') o.position.y += 0.08 * Math.sin(time * 3 + it.id);
    }
    for (const [id, rec] of this.live) {
      if (!this.seen.has(id)) {
        rec.obj.removeFromParent();
        this.live.delete(id);
      }
    }
    this.orbMat.emissive.setHSL((time * 0.4) % 1, 1, 0.5);
    this.orbMat.color.setHSL((time * 0.4 + 0.5) % 1, 1, 0.7);

    // ---- projectiles
    this.seen.clear();
    for (const p of projectiles) {
      this.seen.add(p.id);
      let o = this.proj.get(p.id);
      if (!o) {
        const m = this.projMat(p.color);
        const g = new THREE.Group();
        g.userData.shared = true;
        const core = new THREE.Mesh(this.projGeo, m.core);
        const glow = new THREE.Sprite(m.glow);
        glow.scale.set(3, 3, 1);
        g.add(core, glow);
        o = g;
        this.proj.set(p.id, o);
        this.root.add(o);
      }
      const r = Math.max(0.08, p.r);
      o.position.set(p.x, p.y, 0.3);
      const sp = Math.hypot(p.vx, p.vy);
      const core = o.children[0];
      const stretch = p.kind === 'bolt' || p.kind === 'wave' ? 1 + Math.min(2.5, sp * 8) : 1;
      core.scale.set(r * stretch, r * (p.kind === 'wave' ? 1.6 : 1), r);
      o.rotation.z = sp > 1e-4 ? Math.atan2(p.vy, p.vx) : 0;
      o.children[1].scale.setScalar(r * 3.2 * (0.9 + 0.1 * Math.sin(time * 30 + p.id)));
      if (p.kind === 'rock') o.rotation.z += time * 6;
    }
    for (const [id, o] of this.proj) {
      if (!this.seen.has(id)) {
        o.removeFromParent();
        this.proj.delete(id);
      }
    }
  }

  clear(): void {
    for (const rec of this.live.values()) rec.obj.removeFromParent();
    this.live.clear();
    for (const o of this.proj.values()) o.removeFromParent();
    this.proj.clear();
  }

  /** Hand-held prototype clone for results / debug (not used per frame). */
  get fuseMaterial(): THREE.SpriteMaterial {
    return this.fuseSpark;
  }

  dispose(): void {
    this.clear();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    for (const m of this.projMats.values()) {
      m.core.dispose();
      m.glow.dispose();
    }
    this.projMats.clear();
    this.root.removeFromParent();
  }
}
