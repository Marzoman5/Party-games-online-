/**
 * Procedural stage visuals per theme ('sky' | 'arena' | 'forge' | 'training'): chunky platforms,
 * moving platforms following StageView, parallax backgrounds, lighting and stage hazards.
 * Everything here is per-match and disposed with disposeTree(root).
 */
import * as THREE from 'three';
import type { PlatformDef, StageDef, StageView } from '../types';
import { canvasTexture, rng, softCircleTexture } from './util';

const DEPTH = 4.2;

interface Theme {
  sky: [number, number, number]; // top, mid, horizon
  fog: number;
  clear: number;
  hemiSky: number;
  hemiGround: number;
  hemi: number;
  key: number;
  keyI: number;
  keyDir: [number, number, number];
  rim: number;
  rimI: number;
  top: number;
  trim: number;
  under: number;
  passTop: number;
  passGlow: number;
}

const THEMES: Record<StageDef['theme'], Theme> = {
  sky: {
    sky: [0x1d2b7a, 0xe2735b, 0xffcf8a], fog: 0xe9a07a, clear: 0x1d2b7a,
    hemiSky: 0xbfd6ff, hemiGround: 0x5a3a4a, hemi: 1.05, key: 0xffe0b8, keyI: 2.2, keyDir: [-6, 10, 8],
    rim: 0xff7aa8, rimI: 1.2, top: 0x58c95a, trim: 0xa5f07a, under: 0x7a5a52, passTop: 0xd9c7a8, passGlow: 0xffe9b0,
  },
  arena: {
    sky: [0x05061a, 0x141a4a, 0x2a2f7a], fog: 0x0b0e2e, clear: 0x05061a,
    hemiSky: 0x8fa6ff, hemiGround: 0x1a1030, hemi: 0.75, key: 0xdfe6ff, keyI: 2.4, keyDir: [3, 12, 9],
    rim: 0xff3ab8, rimI: 1.6, top: 0x2b3050, trim: 0x37e8ff, under: 0x181a2c, passTop: 0x30365c, passGlow: 0x37e8ff,
  },
  forge: {
    sky: [0x0b0405, 0x3a0d08, 0xb8360e], fog: 0x3a1208, clear: 0x0b0405,
    hemiSky: 0xffb08a, hemiGround: 0x400a00, hemi: 0.7, key: 0xffc890, keyI: 1.7, keyDir: [5, 10, 7],
    rim: 0xff5a1a, rimI: 2.4, top: 0x4a4447, trim: 0xff8a2a, under: 0x2a1f1d, passTop: 0x5a5254, passGlow: 0xff7a1a,
  },
  training: {
    sky: [0x0a1638, 0x15306a, 0x2a5aa8], fog: 0x14285a, clear: 0x0a1638,
    hemiSky: 0xcfe2ff, hemiGround: 0x2a3a5a, hemi: 1.1, key: 0xffffff, keyI: 2.0, keyDir: [-4, 12, 10],
    rim: 0x6fd3ff, rimI: 1.0, top: 0xe8eef8, trim: 0x37a8ff, under: 0x3a4a6a, passTop: 0xd8e6ff, passGlow: 0x37a8ff,
  },
};

function std(color: number, o: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.05, flatShading: true, ...o });
}

function glow(color: number, opacity = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
}

export class StageVisuals {
  readonly root = new THREE.Group();
  readonly key: THREE.DirectionalLight;
  readonly theme: Theme;
  readonly clearColor: number;
  private readonly platformGroups: THREE.Group[] = [];
  private readonly animated: ((t: number, dt: number) => void)[] = [];
  private hazardWarn: THREE.Mesh | null = null;
  private hazardColumn: THREE.Mesh | null = null;
  private embers: THREE.Points | null = null;
  private emberVel: Float32Array | null = null;
  private readonly lowQuality: boolean;

  constructor(readonly stage: StageDef, quality: number) {
    this.lowQuality = quality <= 0;
    const th = THEMES[stage.theme] ?? THEMES.sky;
    this.theme = th;
    this.clearColor = th.clear;
    this.root.name = `stage:${stage.id}`;

    // ---- lights
    const hemi = new THREE.HemisphereLight(th.hemiSky, th.hemiGround, th.hemi);
    this.root.add(hemi);
    const key = new THREE.DirectionalLight(th.key, th.keyI);
    key.position.set(...th.keyDir);
    key.target.position.set(0, 0, 0);
    this.root.add(key, key.target);
    key.shadow.camera.left = -22;
    key.shadow.camera.right = 22;
    key.shadow.camera.top = 16;
    key.shadow.camera.bottom = -10;
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 60;
    key.shadow.bias = -0.0008;
    key.shadow.normalBias = 0.02;
    this.key = key;
    const rim = new THREE.DirectionalLight(th.rim, th.rimI);
    rim.position.set(4, 5, -10);
    this.root.add(rim);

    // ---- sky gradient backdrop
    this.root.add(this.skyBackdrop(th));

    // ---- platforms
    stage.platforms.forEach((p, i) => {
      const g = p.solid ? this.mainPlatform(p, th, stage.theme) : this.passPlatform(p, th, stage.theme, i);
      g.position.set(p.x, p.y, 0);
      this.platformGroups.push(g);
      this.root.add(g);
    });

    // ---- theme background
    const seed = stage.id.length * 7919 + 13;
    switch (stage.theme) {
      case 'sky':
        this.skyDecor(rng(seed));
        break;
      case 'arena':
        this.arenaDecor(rng(seed));
        break;
      case 'forge':
        this.forgeDecor(rng(seed));
        break;
      case 'training':
        this.trainingDecor();
        break;
    }
  }

  setShadows(on: boolean, size: number): void {
    this.key.castShadow = on;
    if (on && this.key.shadow.mapSize.x !== size) {
      if (this.key.shadow.map) {
        this.key.shadow.map.dispose();
        (this.key.shadow as { map: THREE.WebGLRenderTarget | null }).map = null;
      }
      this.key.shadow.mapSize.set(size, size);
    }
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && o.userData.platform) {
        m.receiveShadow = on;
        m.castShadow = on;
      }
    });
  }

  /** Top-surface centre of platform i right now. */
  update(sv: StageView | null, time: number, dt: number): void {
    if (sv) {
      for (let i = 0; i < this.platformGroups.length; i++) {
        const p = sv.platforms[i];
        if (p) this.platformGroups[i].position.set(p.x, p.y, 0);
      }
      const hz = sv.hazard;
      if (this.hazardWarn && this.hazardColumn) {
        if (hz && (hz.warning > 0 || hz.active)) {
          this.hazardWarn.visible = true;
          this.hazardWarn.position.x = hz.x;
          this.hazardWarn.scale.x = Math.max(0.5, hz.w);
          const pulse = 0.5 + 0.5 * Math.sin(time * (8 + 14 * hz.warning));
          (this.hazardWarn.material as THREE.MeshBasicMaterial).opacity = hz.active ? 0.35 : 0.15 + 0.5 * hz.warning * pulse;
          this.hazardColumn.visible = hz.active;
          if (hz.active) {
            this.hazardColumn.position.x = hz.x;
            this.hazardColumn.scale.set(Math.max(0.5, hz.w) * (0.9 + 0.1 * Math.sin(time * 30)), 1, 1);
          }
        } else {
          this.hazardWarn.visible = false;
          this.hazardColumn.visible = false;
        }
      }
    }
    for (const a of this.animated) a(time, dt);
    if (this.embers && this.emberVel) {
      const pos = this.embers.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      const v = this.emberVel;
      const hz = sv?.hazard;
      const boost = hz && hz.active ? 3 : 1;
      for (let i = 0; i < arr.length / 3; i++) {
        arr[i * 3] += Math.sin(time * 1.3 + i) * 0.01;
        arr[i * 3 + 1] += v[i] * dt * boost;
        if (arr[i * 3 + 1] > 16) {
          arr[i * 3 + 1] = -8;
          arr[i * 3] = (Math.random() - 0.5) * 50;
        }
      }
      pos.needsUpdate = true;
    }
  }

  // ------------------------------------------------------------------ pieces

  private skyBackdrop(th: Theme): THREE.Mesh {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        top: { value: new THREE.Color(th.sky[0]) },
        mid: { value: new THREE.Color(th.sky[1]) },
        hor: { value: new THREE.Color(th.sky[2]) },
      },
      vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.0); vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }',
      fragmentShader:
        'uniform vec3 top; uniform vec3 mid; uniform vec3 hor; varying vec3 vW; void main(){ float h = clamp((vW.y+30.0)/90.0,0.0,1.0); vec3 c = h<0.35 ? mix(hor,mid,h/0.35) : mix(mid,top,(h-0.35)/0.65); gl_FragColor=vec4(c,1.0);\n#include <colorspace_fragment>\n}',
      depthWrite: false,
      fog: false,
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(600, 300), mat);
    m.position.set(0, 20, -120);
    m.renderOrder = -10;
    return m;
  }

  private mainPlatform(p: PlatformDef, th: Theme, theme: StageDef['theme']): THREE.Group {
    const g = new THREE.Group();
    const w = p.w;
    const topMat = std(th.top, theme === 'arena' ? { metalness: 0.6, roughness: 0.35 } : theme === 'training' ? { roughness: 0.5 } : {});
    const top = new THREE.Mesh(new THREE.BoxGeometry(w, 0.45, DEPTH), topMat);
    top.position.y = -0.225;
    top.userData.platform = true;
    g.add(top);
    const trim = new THREE.Mesh(new THREE.BoxGeometry(w + 0.12, 0.1, DEPTH + 0.12), theme === 'sky' ? std(th.trim) : glow(th.trim));
    trim.position.y = theme === 'sky' ? -0.04 : -0.1;
    g.add(trim);

    // tapered underside (extruded trapezoid)
    const depthH = Math.max(2.5, p.h * 1.5);
    const shape = new THREE.Shape();
    const bw = theme === 'arena' ? w * 0.92 : w * 0.42;
    shape.moveTo(-w / 2, 0);
    shape.lineTo(w / 2, 0);
    if (theme === 'sky' || theme === 'forge') {
      shape.lineTo(w * 0.38, -depthH * 0.45);
      shape.lineTo(bw / 2, -depthH);
      shape.lineTo(0, -depthH * 1.25);
      shape.lineTo(-bw / 2, -depthH);
      shape.lineTo(-w * 0.4, -depthH * 0.5);
    } else {
      shape.lineTo(bw / 2, -depthH);
      shape.lineTo(-bw / 2, -depthH);
    }
    shape.closePath();
    const ext = new THREE.ExtrudeGeometry(shape, { depth: DEPTH * 0.9, bevelEnabled: false });
    ext.translate(0, -0.45, -DEPTH * 0.45);
    const underMat = std(th.under, theme === 'arena' ? { metalness: 0.5, roughness: 0.4 } : {});
    const under = new THREE.Mesh(ext, underMat);
    under.userData.platform = true;
    g.add(under);

    const r = rng(Math.round(w * 100));
    if (theme === 'sky') {
      // grass tufts and hanging rocks
      const rockMat = std(0x8a6a60, { emissive: 0x3a2028, emissiveIntensity: 0.6 });
      for (let i = 0; i < 7; i++) {
        const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.4 + r() * 0.7, 0), rockMat);
        rock.position.set((r() - 0.5) * w * 0.6, -depthH * (0.9 + r() * 0.6), (r() - 0.5) * 2);
        rock.rotation.set(r() * 3, r() * 3, 0);
        g.add(rock);
      }
      const grassMat = std(0x3fa34a);
      for (let i = 0; i < 18; i++) {
        const tuft = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.35, 4), grassMat);
        tuft.position.set((r() - 0.5) * (w - 0.6), 0.1, -DEPTH / 2 + 0.2 + r() * 0.6);
        g.add(tuft);
      }
      // little rooftop railing posts at the back
      const postMat = std(0xf0e0c8);
      for (let x = -w / 2 + 0.6; x <= w / 2 - 0.5; x += 1.6) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.7, 0.12), postMat);
        post.position.set(x, 0.35, -DEPTH / 2 + 0.15);
        g.add(post);
      }
      const rail = new THREE.Mesh(new THREE.BoxGeometry(w - 0.8, 0.1, 0.1), postMat);
      rail.position.set(0, 0.7, -DEPTH / 2 + 0.15);
      g.add(rail);
    } else if (theme === 'arena') {
      // neon stripes on the front face + under-glow
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, 0.08, 0.05), glow(0xff3ab8));
      stripe.position.set(0, -0.9, DEPTH / 2 + 0.03);
      g.add(stripe);
      const stripe2 = stripe.clone();
      stripe2.material = glow(0x37e8ff);
      stripe2.position.y = -1.6;
      g.add(stripe2);
      const lightMat = glow(0xfff2c0);
      for (let x = -w / 2 + 1; x < w / 2; x += 2) {
        const l = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.12, 0.05), lightMat);
        l.position.set(x, -0.3, DEPTH / 2 + 0.04);
        g.add(l);
      }
    } else if (theme === 'forge') {
      const crackMat = glow(0xff6a10);
      for (let i = 0; i < 9; i++) {
        const c = new THREE.Mesh(new THREE.BoxGeometry(0.06 + r() * 0.05, 0.6 + r() * 1.4, 0.05), crackMat);
        c.position.set((r() - 0.5) * w * 0.7, -0.9 - r() * 1.5, DEPTH * 0.45 + 0.03);
        c.rotation.z = (r() - 0.5) * 1.2;
        g.add(c);
      }
      // riveted steel plates on top edge
      const rivetMat = std(0x9a9090, { metalness: 0.7, roughness: 0.4 });
      for (let x = -w / 2 + 0.4; x < w / 2; x += 1.2) {
        const rv = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 4), rivetMat);
        rv.position.set(x, -0.2, DEPTH / 2 + 0.01);
        g.add(rv);
      }
      // hazard stripes along the front
      const tex = canvasTexture(256, 32, (c) => {
        c.fillStyle = '#1a1a1a';
        c.fillRect(0, 0, 256, 32);
        c.fillStyle = '#ffb000';
        for (let x = -32; x < 256; x += 32) {
          c.beginPath();
          c.moveTo(x, 32);
          c.lineTo(x + 16, 0);
          c.lineTo(x + 32, 0);
          c.lineTo(x + 16, 32);
          c.fill();
        }
      });
      tex.wrapS = THREE.RepeatWrapping;
      tex.repeat.set(w / 2, 1);
      const band = new THREE.Mesh(new THREE.PlaneGeometry(w, 0.3), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 }));
      band.position.set(0, -0.3, DEPTH / 2 + 0.005);
      g.add(band);
    } else {
      // training: ruler marks on the front face
      const tex = canvasTexture(1024, 64, (c) => {
        c.fillStyle = '#e8eef8';
        c.fillRect(0, 0, 1024, 64);
        const units = Math.round(w);
        for (let i = 0; i <= units; i++) {
          const x = (i / units) * 1024;
          const major = (i - units / 2) % 5 === 0;
          c.fillStyle = major ? '#1d4fa8' : '#7a95c8';
          c.fillRect(x - (major ? 2 : 1), 0, major ? 4 : 2, major ? 40 : 22);
          if (major) {
            c.font = 'bold 18px sans-serif';
            c.textAlign = 'center';
            c.fillText(String(Math.abs(i - units / 2)), Math.min(1010, Math.max(14, x)), 60);
          }
        }
      });
      const ruler = new THREE.Mesh(new THREE.PlaneGeometry(w, 0.42), new THREE.MeshBasicMaterial({ map: tex }));
      ruler.position.set(0, -0.23, DEPTH / 2 + 0.005);
      g.add(ruler);
    }
    return g;
  }

  private passPlatform(p: PlatformDef, th: Theme, theme: StageDef['theme'], i: number): THREE.Group {
    const g = new THREE.Group();
    const moving = !!p.path;
    const thick = 0.28;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(p.w, thick, DEPTH * 0.55), std(th.passTop, theme === 'arena' || theme === 'forge' ? { metalness: 0.6, roughness: 0.4 } : {}));
    slab.position.y = -thick / 2;
    slab.userData.platform = true;
    g.add(slab);
    const edge = new THREE.Mesh(new THREE.BoxGeometry(p.w + 0.06, 0.06, DEPTH * 0.55 + 0.06), glow(th.passGlow, 0.9));
    edge.position.y = -0.02;
    g.add(edge);
    const under = new THREE.Mesh(new THREE.PlaneGeometry(p.w * 0.9, 0.5), new THREE.MeshBasicMaterial({ map: softCircleTexture(), color: th.passGlow, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
    under.position.set(0, -thick - 0.25, DEPTH * 0.28);
    g.add(under);
    if (theme === 'sky') {
      // little floating rock under the plank
      const rock = new THREE.Mesh(new THREE.ConeGeometry(p.w * 0.22, 1.1, 5), std(th.under, { emissive: 0x4a2a30, emissiveIntensity: 0.7 }));
      rock.rotation.x = Math.PI;
      rock.position.y = -thick - 0.55;
      g.add(rock);
    }
    if (moving || theme === 'forge') {
      // hover thrusters
      const tMat = glow(theme === 'forge' ? 0xffa040 : th.passGlow, 0.9);
      for (const sx of [-1, 1]) {
        const t = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.08, 0.5, 8), tMat);
        t.position.set(sx * p.w * 0.35, -thick - 0.25, 0);
        g.add(t);
      }
      const phase = i * 1.7;
      this.animated.push((time) => {
        const s = 0.85 + 0.15 * Math.sin(time * 18 + phase);
        g.children.forEach((c) => {
          if ((c as THREE.Mesh).geometry instanceof THREE.CylinderGeometry) c.scale.set(1, s, 1);
        });
      });
    }
    return g;
  }

  // ------------------------------------------------------------------ themes

  private skyDecor(r: () => number): void {
    // sun
    const sun = new THREE.Mesh(new THREE.CircleGeometry(9, 32), new THREE.MeshBasicMaterial({ color: 0xfff0c0, fog: false }));
    sun.position.set(-26, 2, -110);
    this.root.add(sun);
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshBasicMaterial({ map: softCircleTexture(), color: 0xffb070, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    halo.position.set(-26, 2, -109);
    this.root.add(halo);

    // distant skyline towers with lit windows
    const winTex = canvasTexture(64, 128, (c) => {
      c.fillStyle = '#2a1f4a';
      c.fillRect(0, 0, 64, 128);
      for (let y = 4; y < 128; y += 10) for (let x = 4; x < 64; x += 10) {
        if (Math.random() < 0.45) {
          c.fillStyle = Math.random() < 0.5 ? '#ffd27a' : '#ff9a6a';
          c.fillRect(x, y, 5, 6);
        }
      }
    });
    const towerMat = new THREE.MeshBasicMaterial({ map: winTex, color: 0xb8a0d8, fog: true });
    const towerGeo = new THREE.BoxGeometry(1, 1, 1);
    for (let i = 0; i < 26; i++) {
      const h = 10 + r() * 28;
      const w = 3 + r() * 5;
      const t = new THREE.Mesh(towerGeo, towerMat);
      t.scale.set(w, h, 3);
      t.position.set(-90 + i * 7 + r() * 3, -34 + h / 2, -75 - r() * 15);
      this.root.add(t);
    }

    // cloud sea below
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(400, 120), new THREE.MeshBasicMaterial({ color: 0xf3c3b0, transparent: true, opacity: 0.85, fog: true }));
    sea.rotation.x = -Math.PI / 2;
    sea.position.set(0, -16, -50);
    this.root.add(sea);

    // clouds (puffs)
    const cloudMat = std(0xfff2ee, { roughness: 1, emissive: 0x6a3a50, emissiveIntensity: 0.25 });
    const puff = new THREE.IcosahedronGeometry(1, 1);
    const clouds: THREE.Group[] = [];
    const nClouds = this.lowQuality ? 7 : 14;
    for (let i = 0; i < nClouds; i++) {
      const c = new THREE.Group();
      const n = 4 + Math.floor(r() * 4);
      for (let k = 0; k < n; k++) {
        const m = new THREE.Mesh(puff, cloudMat);
        const s = 1.2 + r() * 1.8;
        m.scale.set(s * 1.4, s, s);
        m.position.set(k * 1.6 - n * 0.8, r() * 0.8, r());
        c.add(m);
      }
      const z = -18 - r() * 50;
      c.position.set(-60 + r() * 120, -10 + r() * 30, z);
      c.userData.speed = 0.3 + r() * 0.6;
      clouds.push(c);
      this.root.add(c);
    }
    // floating islands
    const islandRock = std(0x7a5a6a, { emissive: 0x4a2a40, emissiveIntensity: 0.6 });
    const islandTop = std(0x4fae58);
    for (let i = 0; i < 5; i++) {
      const isl = new THREE.Group();
      const s = 2 + r() * 3;
      const rock = new THREE.Mesh(new THREE.ConeGeometry(s, s * 2.2, 6), islandRock);
      rock.rotation.x = Math.PI;
      rock.position.y = -s * 1.1;
      const topM = new THREE.Mesh(new THREE.CylinderGeometry(s, s * 0.95, 0.5, 6), islandTop);
      isl.add(rock, topM);
      isl.position.set(-50 + i * 25 + r() * 8, -2 + r() * 14, -40 - r() * 25);
      const ph = r() * 6;
      this.animated.push((t) => {
        isl.position.y += Math.sin(t * 0.5 + ph) * 0.004;
      });
      this.root.add(isl);
    }
    this.animated.push((_t, dt) => {
      for (const c of clouds) {
        c.position.x += c.userData.speed * dt;
        if (c.position.x > 70) c.position.x = -70;
      }
    });
    this.root.add(this.fogMarker(0xe9a07a));
  }

  private arenaDecor(r: () => number): void {
    // moon
    const moon = new THREE.Mesh(new THREE.CircleGeometry(5, 32), new THREE.MeshBasicMaterial({ color: 0xe8ecff, fog: false }));
    moon.position.set(30, 38, -115);
    this.root.add(moon);
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshBasicMaterial({ map: softCircleTexture(), color: 0x8090ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    halo.position.set(30, 38, -114);
    this.root.add(halo);
    // stars
    const starGeo = new THREE.BufferGeometry();
    const sp: number[] = [];
    for (let i = 0; i < 300; i++) sp.push((r() - 0.5) * 400, 10 + r() * 90, -112);
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    this.root.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, fog: false })));

    // stands: stepped tiers in an arc behind the stage
    const standMat = std(0x1c1f3a, { roughness: 0.9 });
    const tiers = 6;
    for (let t = 0; t < tiers; t++) {
      const tier = new THREE.Mesh(new THREE.BoxGeometry(120, 1.6, 3), standMat);
      tier.position.set(0, -6 + t * 1.8, -16 - t * 3);
      this.root.add(tier);
    }
    // crowd silhouettes (instanced), bobbing
    const n = this.lowQuality ? 260 : 620;
    const crowdGeo = new THREE.CapsuleGeometry(0.28, 0.45, 2, 6);
    const crowdMat = new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true });
    const crowd = new THREE.InstancedMesh(crowdGeo, crowdMat, n);
    const base: { x: number; y: number; z: number; ph: number; amp: number }[] = [];
    const m4 = new THREE.Matrix4();
    const col = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const t = Math.floor(r() * tiers);
      const x = (r() - 0.5) * 116;
      const y = -6 + t * 1.8 + 1.3;
      const z = -16 - t * 3 + (r() - 0.5) * 1.5;
      base.push({ x, y, z, ph: r() * 6.28, amp: 0.05 + r() * 0.15 });
      m4.makeTranslation(x, y, z);
      crowd.setMatrixAt(i, m4);
      col.setHSL(r(), 0.45, 0.06 + r() * 0.08);
      crowd.setColorAt(i, col);
    }
    this.root.add(crowd);
    if (!this.lowQuality) {
      let acc = 0;
      this.animated.push((time, dt) => {
        acc += dt;
        if (acc < 1 / 20) return;
        acc = 0;
        for (let i = 0; i < n; i++) {
          const b = base[i];
          m4.makeTranslation(b.x, b.y + Math.abs(Math.sin(time * 3 + b.ph)) * b.amp * this.crowdHype, b.z);
          crowd.setMatrixAt(i, m4);
        }
        crowd.instanceMatrix.needsUpdate = true;
      });
    }
    // neon rings & sign columns
    const ringColors = [0xff3ab8, 0x37e8ff, 0xffd23f];
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(5 + i * 1.5, 0.12, 6, 48), glow(ringColors[i]));
      ring.position.set(0, 14, -40 - i * 2);
      const ph = i * 1.3;
      this.animated.push((time) => {
        ring.rotation.y = Math.sin(time * 0.4 + ph) * 0.6;
        ring.rotation.x = Math.cos(time * 0.3 + ph) * 0.3;
      });
      this.root.add(ring);
    }
    for (const sx of [-1, 1]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(1.2, 30, 1.2), std(0x22264a, { metalness: 0.6, roughness: 0.4 }));
      pillar.position.set(sx * 30, 0, -22);
      this.root.add(pillar);
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.2, 28, 0.2), glow(sx < 0 ? 0xff3ab8 : 0x37e8ff));
      strip.position.set(sx * 30 + sx * -0.65, 0, -21.3);
      this.root.add(strip);
    }
    // spotlight cones (additive)
    const coneGeo = new THREE.ConeGeometry(4, 34, 24, 1, true);
    coneGeo.translate(0, -17, 0);
    for (let i = 0; i < 4; i++) {
      const cone = new THREE.Mesh(coneGeo, new THREE.MeshBasicMaterial({ color: i % 2 ? 0x8fd8ff : 0xffb0e8, transparent: true, opacity: 0.045, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
      cone.position.set(-24 + i * 16, 22, -12);
      const ph = i * 1.9;
      this.animated.push((time) => {
        cone.rotation.z = Math.sin(time * 0.5 + ph) * 0.45;
      });
      this.root.add(cone);
    }
    // glossy floor far below
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 60), std(0x0c0e22, { metalness: 0.7, roughness: 0.3, flatShading: false }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -7.2, -10);
    this.root.add(floor);
    this.root.add(this.fogMarker(0x0b0e2e));
  }

  /** Arena crowd bob amplitude multiplier (raised briefly on KOs). */
  crowdHype = 1;

  private forgeDecor(r: () => number): void {
    // lava sea
    const lavaMat = new THREE.ShaderMaterial({
      uniforms: { t: { value: 0 } },
      vertexShader: 'varying vec2 vUv; varying vec3 vW; void main(){ vUv=uv; vec4 w=modelMatrix*vec4(position,1.0); vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }',
      fragmentShader: `uniform float t; varying vec2 vUv; varying vec3 vW;
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
        float n(vec2 p){ vec2 i=floor(p); vec2 f=fract(p); f=f*f*(3.0-2.0*f);
          return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x), f.y); }
        void main(){ vec2 p = vW.xz*0.18; float v = n(p+vec2(t*0.15,t*0.05))*0.6 + n(p*2.3-vec2(t*0.2,0.0))*0.4;
          vec3 c = mix(vec3(0.55,0.06,0.0), vec3(1.0,0.55,0.08), smoothstep(0.35,0.85,v));
          c += vec3(1.0,0.9,0.4)*smoothstep(0.8,0.95,v);
          gl_FragColor = vec4(c,1.0);\n#include <colorspace_fragment>\n}`,
      fog: false,
    });
    const lava = new THREE.Mesh(new THREE.PlaneGeometry(260, 120), lavaMat);
    lava.rotation.x = -Math.PI / 2;
    lava.position.set(0, -8.5, -30);
    this.root.add(lava);
    this.animated.push((time) => {
      lavaMat.uniforms.t.value = time;
    });
    const lavaLight = new THREE.PointLight(0xff5a10, 60, 40, 1.6);
    lavaLight.position.set(0, -6, 4);
    this.root.add(lavaLight);
    this.animated.push((time) => {
      lavaLight.intensity = 50 + Math.sin(time * 3.1) * 8 + Math.sin(time * 7.3) * 4;
    });

    // machinery silhouettes: chimneys, gears, pipes
    const darkMat = std(0x2a1a18, { metalness: 0.5, roughness: 0.6, emissive: 0x3a0c04, emissiveIntensity: 0.8 });
    for (let i = 0; i < 8; i++) {
      const h = 14 + r() * 22;
      const ch = new THREE.Mesh(new THREE.CylinderGeometry(1.2 + r(), 1.8 + r(), h, 8), darkMat);
      ch.position.set(-80 + i * 23 + r() * 4, -8 + h / 2, -62 - r() * 22);
      this.root.add(ch);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.15, 6, 16), glow(0xff6a10, 0.9));
      ring.rotation.x = Math.PI / 2;
      ring.position.set(ch.position.x, ch.position.y + h / 2 - 1, ch.position.z);
      this.root.add(ring);
    }
    for (let i = 0; i < 3; i++) {
      const gear = new THREE.Group();
      const s = 3 + r() * 3;
      gear.add(new THREE.Mesh(new THREE.TorusGeometry(s, s * 0.22, 6, 20), darkMat));
      for (let k = 0; k < 10; k++) {
        const tooth = new THREE.Mesh(new THREE.BoxGeometry(s * 0.35, s * 0.35, s * 0.3), darkMat);
        const a = (k / 10) * Math.PI * 2;
        tooth.position.set(Math.cos(a) * s * 1.2, Math.sin(a) * s * 1.2, 0);
        tooth.rotation.z = a;
        gear.add(tooth);
      }
      gear.position.set(-40 + i * 40, 16 + r() * 8, -55 - i * 4);
      const dir = i % 2 ? 1 : -1;
      this.animated.push((_t, dt) => {
        gear.rotation.z += dir * dt * 0.25;
      });
      this.root.add(gear);
    }
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 120, 8), darkMat);
    pipe.rotation.z = Math.PI / 2;
    pipe.position.set(0, 26, -50);
    this.root.add(pipe);

    // embers
    const n = this.lowQuality ? 60 : 180;
    const pos = new Float32Array(n * 3);
    this.emberVel = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 50;
      pos[i * 3 + 1] = -8 + Math.random() * 24;
      pos[i * 3 + 2] = -14 + Math.random() * 16;
      this.emberVel[i] = 0.8 + Math.random() * 2.2;
    }
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.embers = new THREE.Points(
      eg,
      new THREE.PointsMaterial({ color: 0xffa040, size: 0.22, map: softCircleTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
    );
    this.embers.frustumCulled = false;
    this.root.add(this.embers);

    // hazard warning glow (on the main stage) + eruption column
    const warn = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 6),
      new THREE.MeshBasicMaterial({ map: softCircleTexture(), color: 0xff2a00, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }),
    );
    warn.position.set(0, 0.5, DEPTH / 2 + 0.2);
    warn.visible = false;
    this.root.add(warn);
    this.hazardWarn = warn;
    const colGeo = new THREE.CylinderGeometry(0.5, 0.65, 26, 16, 1, true);
    colGeo.translate(0, 13 - 8.5, 0);
    const col = new THREE.Mesh(
      colGeo,
      new THREE.MeshBasicMaterial({ color: 0xff8a20, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }),
    );
    col.visible = false;
    this.root.add(col);
    this.hazardColumn = col;
    this.root.add(this.fogMarker(0x3a1208));
  }

  private trainingDecor(): void {
    // grid back wall
    const gridMat = new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: 'varying vec3 vW; void main(){ vec4 w=modelMatrix*vec4(position,1.0); vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }',
      fragmentShader: `varying vec3 vW;
        float line(float v, float w){ float d = abs(fract(v-0.5)-0.5); return 1.0 - smoothstep(0.0, w, d); }
        void main(){ float minor = max(line(vW.x, 0.02), line(vW.y, 0.02));
          float major = max(line(vW.x/5.0, 0.008), line(vW.y/5.0, 0.008));
          vec3 base = vec3(0.05,0.10,0.24); vec3 c = base + vec3(0.12,0.22,0.45)*minor*0.6 + vec3(0.25,0.55,1.0)*major;
          gl_FragColor = vec4(c,1.0);\n#include <colorspace_fragment>\n}`,
    });
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(200, 80), gridMat);
    wall.position.set(0, 10, -14);
    this.root.add(wall);
    const floorMat = gridMat.clone();
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 40), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -8, -4);
    this.root.add(floor);
    // horizontal height markers (every 5 units)
    for (let y = 5; y <= 15; y += 5) {
      const l = new THREE.Mesh(new THREE.PlaneGeometry(60, 0.06), new THREE.MeshBasicMaterial({ color: 0x6fd3ff, transparent: true, opacity: 0.5 }));
      l.position.set(0, y, -2.4);
      this.root.add(l);
    }
    // floating holo panels
    for (const sx of [-1, 1]) {
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(6, 3.5), new THREE.MeshBasicMaterial({ color: 0x37a8ff, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false }));
      panel.position.set(sx * 17, 9, -8);
      panel.rotation.y = -sx * 0.4;
      this.root.add(panel);
      const frame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(6, 3.5)), new THREE.LineBasicMaterial({ color: 0x9fdcff }));
      frame.position.copy(panel.position);
      frame.rotation.copy(panel.rotation);
      this.root.add(frame);
    }
    this.root.add(this.fogMarker(0x14285a));
  }

  /** Carries the theme fog colour; SmashGame applies scene.fog from it. */
  private fogMarker(color: number): THREE.Object3D {
    const o = new THREE.Object3D();
    o.userData.fogColor = color;
    return o;
  }
}
