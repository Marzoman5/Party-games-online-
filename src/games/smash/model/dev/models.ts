/**
 * Dev page: all 8 fighters side by side cycling through actions / moves.
 * Query: ?state=<name>&frame=<n>&facing=-1&team=1&portraits=1&freeze=1
 * window.__dev.show(name, frame, facing) freezes a state for screenshots.
 */
import * as THREE from 'three';
import type { ActionState, FighterView, MoveId, MovePhase } from '../../types';
import { buildFighterModel, rigStats, type FighterRig } from '../FighterModel';
import { renderPortrait } from '../portrait';

const IDS = ['zippy', 'pixel', 'fennec', 'max', 'juno', 'kai', 'bram', 'rosa'];

interface Entry {
  name: string;
  action: ActionState;
  move?: MoveId;
  startup?: number;
  active?: number;
  endlag?: number;
  chargeFrames?: number;
  vx?: number;
  vy?: number;
  grounded?: boolean;
  dur: number;
  hitlag?: number;
  invincible?: boolean;
  powered?: boolean;
  launch?: number;
}

const E = (name: string, action: ActionState, dur: number, extra: Partial<Entry> = {}): Entry => ({ name, action, dur, ...extra });
const M = (move: MoveId, grounded = true, startup = 7, active = 4, endlag = 16, extra: Partial<Entry> = {}): Entry => ({
  name: move,
  action: 'attack',
  move,
  startup,
  active,
  endlag,
  grounded,
  dur: startup + active + endlag + 8,
  ...extra,
});

const SEQ: Entry[] = [
  E('idle', 'idle', 90),
  E('walk', 'walk', 90, { vx: 0.06 }),
  E('run', 'run', 90, { vx: 0.16 }),
  E('crouch', 'crouch', 40),
  E('jumpSquat', 'jumpSquat', 4),
  E('jump', 'jump', 30, { grounded: false, vy: 0.2 }),
  E('doubleJump', 'doubleJump', 30, { grounded: false, vy: 0.15 }),
  E('fall', 'fall', 40, { grounded: false, vy: -0.15 }),
  E('land', 'land', 12),
  M('jab1', true, 3, 2, 10),
  M('jab2', true, 3, 2, 10),
  M('jab3', true, 5, 3, 18),
  M('dashAttack', true, 6, 6, 20),
  M('ftilt', true, 7, 4, 16),
  M('utilt', true, 6, 6, 14),
  M('dtilt', true, 5, 3, 12),
  M('fsmash', true, 10, 4, 26, { chargeFrames: 30 }),
  M('usmash', true, 9, 5, 26),
  M('dsmash', true, 8, 8, 24),
  M('nair', false, 4, 14, 12),
  M('fair', false, 8, 4, 16),
  M('bair', false, 6, 4, 14),
  M('uair', false, 5, 5, 14),
  M('dair', false, 10, 6, 20),
  M('nspecial', true, 12, 6, 20),
  M('sspecial', true, 8, 14, 18),
  M('uspecial', false, 5, 20, 10),
  M('dspecial', true, 8, 10, 20),
  M('grab', true, 6, 3, 18),
  M('fthrow', true, 8, 3, 16),
  M('bthrow', true, 10, 3, 16),
  M('uthrow', true, 8, 3, 16),
  M('dthrow', true, 8, 3, 16),
  M('itemSwing', true, 10, 4, 20),
  M('itemThrow', true, 8, 3, 14),
  M('finalSmash', true, 30, 40, 20, { powered: true }),
  E('shield', 'shield', 40),
  E('shieldStun', 'shieldStun', 10, { hitlag: 6 }),
  E('roll', 'roll', 26, { vx: 0.1, invincible: true }),
  E('spotDodge', 'spotDodge', 24, { invincible: true }),
  E('airDodge', 'airDodge', 24, { grounded: false, invincible: true }),
  E('shieldBreak', 'shieldBreak', 40, { grounded: false, vy: 0.2 }),
  E('dizzy', 'dizzy', 90),
  E('hitstun', 'hitstun', 20, { hitlag: 8, launch: 0.05 }),
  E('tumble', 'tumble', 60, { grounded: false, launch: 0.2, vx: -0.2 }),
  E('knockdown', 'knockdown', 40),
  E('getUp', 'getUp', 24),
  E('helpless', 'helpless', 50, { grounded: false, vy: -0.1 }),
  E('ledgeHang', 'ledgeHang', 60, { grounded: false, invincible: true }),
  E('ledgeClimb', 'ledgeClimb', 24),
  E('grabHold', 'grabHold', 40),
  E('grabbed', 'grabbed', 40),
  E('respawn', 'respawn', 60, { invincible: true }),
  E('powered', 'idle', 60, { powered: true }),
  E('victory', 'victory', 240),
  E('defeat', 'defeat', 120),
];

function makeView(i: number, id: string): FighterView {
  return {
    index: i, characterId: id, name: id, color: '#fff', slot: i, team: 0, cpu: false, dummy: false,
    x: 0, y: 0, vx: 0, vy: 0, facing: 1, grounded: true,
    action: 'idle', actionFrame: 0, move: null, moveFrame: 0, moveTotal: 0, movePhase: null, charge: 0,
    damage: 0, stocks: 3, kos: 0, falls: 0, sds: 0, damageDealt: 0, damageTaken: 0, score: 0,
    shield: 1, shielding: false, invincible: false, hitlag: 0, launchSpeed: 0, heldItem: null, ledge: 0,
    jumpsLeft: 1, powered: false, out: false, respawning: false, width: 0.8, height: 1.8,
  };
}

function applyEntry(v: FighterView, e: Entry, f: number, facing: 1 | -1): void {
  v.facing = facing;
  v.action = e.action;
  v.actionFrame = f;
  v.vx = (e.vx ?? 0) * facing;
  v.vy = e.vy ?? 0;
  v.grounded = e.grounded ?? true;
  v.hitlag = e.hitlag ? Math.max(0, e.hitlag - f) : 0;
  v.invincible = !!e.invincible;
  v.powered = !!e.powered;
  v.launchSpeed = e.launch ?? 0;
  v.move = null;
  v.movePhase = null;
  v.moveFrame = 0;
  v.charge = 0;
  if (e.move) {
    const s = e.startup ?? 6;
    const a = e.active ?? 4;
    const l = e.endlag ?? 14;
    const ch = e.chargeFrames ?? 0;
    v.move = e.move;
    v.moveTotal = s + a + l;
    let mf = f + 1;
    if (ch && mf > s) {
      if (mf <= s + ch) {
        v.movePhase = 'charge';
        v.charge = (mf - s) / ch;
        v.moveFrame = s;
        return;
      }
      mf -= ch;
    }
    if (mf > v.moveTotal) {
      v.action = v.grounded ? 'idle' : 'fall';
      v.move = null;
      return;
    }
    v.moveFrame = mf;
    v.movePhase = (mf <= s ? 'startup' : mf <= s + a ? 'active' : 'endlag') as MovePhase;
  }
}

// ---------------------------------------------------------------------------
const params = new URLSearchParams(location.search);
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a3350);
const camera = new THREE.PerspectiveCamera(26, window.innerWidth / window.innerHeight, 0.1, 100);
const zoom = Number(params.get('zoom') ?? 0);
const focus = params.get('focus');
camera.position.set(0, 1.5, 14.8);
camera.lookAt(0, 1.0, 0);
scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x40354a, 1.3));
const sun = new THREE.DirectionalLight(0xffffff, 2.4);
sun.position.set(4, 9, 7);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -12;
sun.shadow.camera.right = 12;
sun.shadow.camera.top = 6;
sun.shadow.camera.bottom = -2;
scene.add(sun);
const ground = new THREE.Mesh(new THREE.BoxGeometry(40, 0.4, 4), new THREE.MeshStandardMaterial({ color: 0x55607a, roughness: 0.9 }));
ground.position.y = -0.2;
ground.receiveShadow = true;
scene.add(ground);

const team = params.get('team') === '1';
const TEAMS = ['#ff4040', '#3a7bff', '#3ad16b', '#ffd23a'];
const rigs: FighterRig[] = [];
const views: FighterView[] = [];
const SPACING = 2.15;
IDS.forEach((id, i) => {
  const rig = buildFighterModel(id, { teamColor: team ? TEAMS[i % 4] : null });
  rig.root.position.x = (i - (IDS.length - 1) / 2) * SPACING;
  scene.add(rig.root);
  rigs.push(rig);
  views.push(makeView(i, id));
});
if (focus) {
  const i = IDS.indexOf(focus);
  const x = (i - (IDS.length - 1) / 2) * SPACING;
  camera.position.set(x + 0.4, 1.4, 6.5);
  camera.lookAt(x, 1.0, 0);
} else if (zoom) {
  camera.position.set(0, 1.6, 22 - zoom);
  camera.lookAt(0, 1.0, 0);
}

const hud = document.getElementById('hud')!;
const statsEl = document.getElementById('stats')!;
statsEl.textContent = IDS.map((id, i) => {
  const s = rigStats(rigs[i]);
  return `${id}: ${s.meshes} meshes / ${s.triangles} tris / h=${rigs[i].height.toFixed(2)}`;
}).join('  |  ');

if (params.get('portraits') !== '0') {
  const ports = document.getElementById('ports')!;
  for (const id of IDS) {
    const img = document.createElement('img');
    const ps = Number(params.get('psize') ?? 0);
    img.src = renderPortrait(renderer, id, ps || 128);
    if (ps) img.style.width = img.style.height = ps + 'px';
    img.title = id;
    ports.appendChild(img);
  }
}

let seqIdx = 0;
let frame = 0;
let facing: 1 | -1 = params.get('facing') === '-1' ? -1 : 1;
let frozen: { e: Entry; f: number } | null = null;
let time = 0;

function findEntry(name: string): Entry {
  return SEQ.find((e) => e.name === name) ?? SEQ[0];
}

/** Freeze a state: simulate the timeline from frame 0 to `f` at 60 Hz for deterministic blends. */
function show(name: string, f: number, fac: 1 | -1 = facing): void {
  const e = findEntry(name);
  facing = fac;
  frozen = { e, f };
  // warm up from idle
  for (let i = 0; i < rigs.length; i++) {
    const v = views[i];
    applyEntry(v, SEQ[0], 0, fac);
    for (let k = 0; k < 20; k++) rigs[i].update(v, 1 / 60, k / 60);
    for (let k = 0; k <= f; k++) {
      applyEntry(v, e, k, fac);
      rigs[i].update(v, 1 / 60, 1 + k / 60);
    }
  }
  time = 1 + f / 60;
  hud.textContent = `${e.name}  f${f}  ${views[3].movePhase ?? ''}`;
  renderer.render(scene, camera);
}
(window as unknown as { __dev: unknown }).__dev = { show, names: SEQ.map((e) => e.name) };

const st = params.get('state');
if (st) show(st, Number(params.get('frame') ?? 10), facing);

let last = performance.now();
function loop(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!frozen) {
    time += dt;
    frame++;
    const e = SEQ[seqIdx];
    if (frame >= e.dur) {
      frame = 0;
      seqIdx = (seqIdx + 1) % SEQ.length;
      if (seqIdx === 0) facing = facing === 1 ? -1 : 1;
    }
    const cur = SEQ[seqIdx];
    for (let i = 0; i < rigs.length; i++) {
      applyEntry(views[i], cur, frame, facing);
      rigs[i].update(views[i], dt, time);
    }
    hud.textContent = `${cur.name}  ${views[0].movePhase ?? ''}`;
    renderer.render(scene, camera);
  }
  requestAnimationFrame(loop);
}
if (params.get('freeze') !== '1') requestAnimationFrame(loop);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});
