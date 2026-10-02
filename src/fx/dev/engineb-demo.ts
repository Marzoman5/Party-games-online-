/**
 * DEV-ONLY harness for ENGINE-B (not part of the production bundle: vite only builds index.html
 * and play.html). Open /src/fx/dev/engineb-demo.html on the dev server. Exposes window.__eb.
 */
import * as THREE from 'three';
import { Track } from '../../track/Track';
import { TRACKS } from '../../track/tracks';
import { Kart } from '../../kart/Kart';
import { CHARACTERS } from '../../kart/roster';
import { AIDriver } from '../../ai/AIDriver';
import { ItemManager } from '../../items/ItemManager';
import { ParticleSystem } from '../ParticleSystem';
import { PostFX } from '../PostFX';
import { FIXED_DT } from '../../core/constants';
import { events } from '../../core/events';
import { buildItemIcon, buildItemMesh } from '../../items/itemVisuals';
import type { ItemType } from '../../core/types';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const cams = [0, 1, 2, 3].map(() => new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 2000));
const particles = new ParticleSystem();
const postfx = new PostFX();
postfx.init(renderer, scene, cams[0]);
scene.add(particles.object);

let track: Track | null = null;
let karts: Kart[] = [];
let ais: AIDriver[] = [];
let items: ItemManager | null = null;
let lights: THREE.Object3D[] = [];
let acc = 0;
let time = 0;
let views = 1;
let camMode: 'chase' | 'rampSide' = 'chase';
let rampIndex = 0;
let focus = 0;
let paused = false;
let usePost = true;
const counters = { ramp: 0, trick: 0, trickBoost: 0 };
events.on('kart:ramp', () => counters.ramp++);
events.on('kart:trick', () => counters.trick++);
events.on('kart:boost', (e) => { if (e.source === 'trick') counters.trickBoost++; });

function start(trackIndex: number, humans = 1): void {
  if (track) {
    scene.remove(track.object);
    track.dispose();
    for (const k of karts) k.dispose();
    items?.dispose();
    if (items) scene.remove(items.object);
    for (const l of lights) { scene.remove(l); (l as THREE.DirectionalLight).dispose?.(); }
  }
  const def = TRACKS[trackIndex];
  track = new Track(def);
  scene.add(track.object);
  const env = def.environment;
  const sun = new THREE.DirectionalLight(env.sunColor, env.sunIntensity);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -60; sc.right = 60; sc.top = 60; sc.bottom = -60; sc.near = 1; sc.far = 400;
  const hemi = new THREE.HemisphereLight(env.ambientSky, env.ambientGround, env.ambientIntensity);
  lights = [sun, sun.target, hemi];
  scene.add(sun, sun.target, hemi);
  scene.fog = env.fogDensity > 0 ? new THREE.FogExp2(env.fogColor, env.fogDensity) : null;
  scene.background = new THREE.Color(env.skyHorizon);
  karts = CHARACTERS.map((c, i) => new Kart(i, c, i < humans));
  karts.forEach((k, i) => { k.resetTo(track!.startGrid[i].position, track!.startGrid[i].quaternion); scene.add(k.object); });
  ais = karts.map((k, i) => new AIDriver(k, 'hard', 500 + i));
  items = new ItemManager(particles);
  items.init(track, karts);
  scene.add(items.object);
  particles.reset();
  time = 0;
}

function step(dt: number): void {
  if (!track || !items) return;
  acc += Math.min(dt, 0.05);
  while (acc >= FIXED_DT) {
    acc -= FIXED_DT;
    time += FIXED_DT;
    const order = karts.slice().sort((a, b) => b.state.raceProgress - a.state.raceProgress);
    order.forEach((k, i) => (k.state.place = i + 1));
    for (let i = 0; i < karts.length; i++) {
      const inp = ais[i].update(FIXED_DT, track, karts, items, karts[0]);
      if (inp.useItem) items.requestUse(karts[i], inp.lookBack);
    }
    for (const k of karts) k.update(FIXED_DT, track, karts);
    items.update(FIXED_DT);
    for (const k of karts) {
      const s = k.state;
      s.raceProgress = Math.floor(s.raceProgress) + s.trackT; // crude
      if (s.position.y < -30) { const c = track.checkpoints[0]; k.resetTo(c.position, karts[0].state.quaternion); }
    }
  }
}

const _v = new THREE.Vector3();
function placeCam(cam: THREE.PerspectiveCamera, kartId: number): void {
  if (!track) return;
  if (camMode === 'rampSide' && track.jumpRamps && track.jumpRamps[rampIndex]) {
    const r = track.jumpRamps[rampIndex];
    const right = _v.set(-r.forward.z, 0, r.forward.x);
    cam.position.copy(r.position).addScaledVector(right, 16).addScaledVector(r.forward, 6);
    cam.position.y += 4;
    cam.lookAt(r.position.x + r.forward.x * 7, r.position.y + 1.5, r.position.z + r.forward.z * 7);
    return;
  }
  const k = karts[kartId];
  const f = k.forwardDir(_v);
  cam.position.copy(k.state.position).addScaledVector(f, -6.5);
  cam.position.y += 2.6;
  cam.lookAt(k.state.position.x + f.x * 4, k.state.position.y + 1, k.state.position.z + f.z * 4);
}

let last = performance.now();
let fps = 60;
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  fps = fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05;
  if (!paused) step(dt);
  for (const k of karts) k.updateVisuals(dt);
  track?.update(dt, time);
  particles.update(dt, karts, cams[0]);
  const W = innerWidth, H = innerHeight;
  renderer.info.autoReset = false;
  renderer.info.reset();
  if (views === 1) {
    placeCam(cams[0], focus);
    cams[0].aspect = W / H; cams[0].updateProjectionMatrix();
    if (usePost) { postfx.setCamera(cams[0]); postfx.render(dt); } else renderer.render(scene, cams[0]);
  } else {
    renderer.setScissorTest(true);
    for (let i = 0; i < views; i++) {
      const x = (i % 2) * W / 2, y = (i < 2 ? H / 2 : 0);
      const w = views === 2 ? W : W / 2, h = H / 2;
      const xx = views === 2 ? 0 : x, yy = views === 2 ? (i === 0 ? H / 2 : 0) : y;
      renderer.setViewport(xx, yy, w, h); renderer.setScissor(xx, yy, w, h);
      placeCam(cams[i], i);
      cams[i].aspect = w / h; cams[i].updateProjectionMatrix();
      renderer.render(scene, cams[i]);
    }
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, W, H);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

(window as unknown as { __eb: unknown }).__eb = {
  start,
  setViews: (n: number) => { views = n; },
  setCam: (m: 'chase' | 'rampSide', ri = 0) => { camMode = m; rampIndex = ri; },
  setFocus: (i: number) => { focus = i; },
  setPost: (on: boolean) => { usePost = on; },
  pause: (p: boolean) => { paused = p; },
  setQuality: (t: 0 | 1 | 2 | 3) => particles.setQuality(t),
  advance: (sec: number) => { for (let i = 0; i < sec / 0.05; i++) step(0.05); },
  info: () => ({
    calls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    geometries: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures,
    programs: renderer.info.programs?.length ?? 0,
    fps: Math.round(fps),
    counters: { ...counters },
    karts: karts.map((k) => ({ id: k.state.id, air: k.state.isAirborne, trick: k.state.isTricking, ready: k.state.trickReady, t: k.state.trackT.toFixed(3), spd: k.state.speed.toFixed(1) })),
    ramps: track?.jumpRamps?.map((r) => r.t),
  }),
  kart: (i: number) => karts[i],
  tris: () => {
    const out: Record<string, number> = {};
    const add = (name: string, o: THREE.Object3D): void => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry) return;
      const g = m.geometry;
      const tri = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
      const inst = (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1;
      out[name] = (out[name] ?? 0) + tri * inst;
    };
    track?.object.traverse((o) => add('track:' + (o.name || o.parent?.name || o.type), o));
    karts[0]?.object.traverse((o) => add('kart0', o));
    let kartMeshes = 0; karts[0]?.object.traverse((o) => { if ((o as THREE.Mesh).isMesh) kartMeshes++; });
    out.kartMeshes = kartMeshes;
    return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]).slice(0, 25));
  },
  measure: (n: number) => {
    views = n;
    const W = innerWidth, H = innerHeight;
    renderer.info.autoReset = false;
    renderer.info.reset();
    const t0 = performance.now();
    renderer.setScissorTest(n > 1);
    for (let i = 0; i < n; i++) {
      const w = n === 1 ? W : W / 2, h = n === 1 ? H : H / 2;
      const x = n === 1 ? 0 : (i % 2) * w, y = n === 1 ? 0 : (i < 2 ? h : 0);
      renderer.setViewport(x, y, w, h); renderer.setScissor(x, y, w, h);
      placeCam(cams[i], i); cams[i].aspect = w / h; cams[i].updateProjectionMatrix();
      renderer.render(scene, cams[i]);
    }
    renderer.setScissorTest(false);
    (renderer.getContext() as WebGL2RenderingContext).finish();
    const ms = performance.now() - t0;
    const groups: Record<string, number> = {};
    track?.object.children.forEach((c) => {
      let n2 = 0; c.traverse((o) => { if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints) n2++; });
      groups[c.name || c.type] = n2;
    });
    let casters = 0; scene.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.castShadow && o.visible) casters++; });
    return { calls: renderer.info.render.calls, tris: renderer.info.render.triangles, ms: Math.round(ms), groups, casters };
  },
  track: () => track,
  scene,
  renderer,
  icons: () => {
    const ids: ItemType[] = ['banana', 'green_shell', 'red_shell', 'blue_shell', 'mushroom', 'golden_mushroom', 'star', 'lightning', 'bob_omb', 'triple_red_shell', 'triple_mushroom'];
    const div = document.createElement('div');
    div.style.cssText = 'position:fixed;left:0;top:0;background:#335;padding:8px;display:flex;gap:6px;z-index:5';
    for (const id of ids) { const c = buildItemIcon(id); c.style.width = '96px'; c.style.height = '96px'; div.appendChild(c); }
    document.body.appendChild(div);
  },
  itemMeshes: () => {
    const ids: ItemType[] = ['green_shell', 'red_shell', 'blue_shell', 'mushroom', 'golden_mushroom', 'star', 'bob_omb', 'banana'];
    const r = track!.jumpRamps![0];
    const g = new THREE.Group();
    ids.forEach((id, i) => { const m = buildItemMesh(id); m.position.z += (i - 3.5) * 1.1; m.scale.setScalar(1.6); g.add(m); });
    const right = new THREE.Vector3(-r.forward.z, 0, r.forward.x);
    g.position.copy(r.position).addScaledVector(r.forward, 6).addScaledVector(right, 9);
    g.position.y += 0.1;
    g.rotation.y = Math.atan2(-r.forward.x, -r.forward.z) + Math.PI;
    scene.add(g);
    camMode = 'rampSide';
    return true;
  },
};
start(0, 1);
