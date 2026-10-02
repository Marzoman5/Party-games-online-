/**
 * SmashGame — the SMASH PARTY engine host (VIEW). Owns one WebGLRenderer for its lifetime,
 * runs the deterministic 60 Hz SmashSim with an accumulator, renders stage / fighters / effects /
 * magnifiers, the in-match DOM HUD (#smash-ui), procedural audio, and installs `window.__smash`.
 * The party hub drives it only through ISmashHost.
 */
import * as THREE from 'three';
import { readForcedTierFromUrl, TIERS } from '../../game/QualityScaler';
import type { QualityTier } from '../../game/api';
import { getCharacter } from '../../kart/roster';
import { TEAM_COLORS, type DecodedFightInput, type PhoneFx } from '../../net/protocol';
import type {
  FighterStatus,
  ISmashHost,
  SmashDebugHooks,
  SmashFx,
  SmashMatchConfig,
  SmashPhase,
  SmashResult,
  SmashResultRow,
  SmashSandboxConfig,
} from './api';
import { renderPortrait } from './model/portrait';
import { FIGHTERS } from './roster';
import { SmashSim } from './sim/SmashSim';
import { getStage, PICKABLE_STAGES } from './stages';
import {
  emptySimInput,
  type FighterView,
  type ISmashSim,
  type ItemKind,
  type SimConfig,
  type SimEvent,
  type SimInput,
  type StageDef,
} from './types';
import { CameraDirector, type FrameTarget } from './view/CameraDirector';
import { DebugOverlay } from './view/DebugOverlay';
import { Effects } from './view/Effects';
import { FighterVisual } from './view/FighterVisual';
import { Hud, type PanelInfo } from './view/Hud';
import { InputQueue } from './view/InputQueue';
import { ItemViews } from './view/ItemViews';
import { Magnifier, type MagnifyRequest } from './view/Magnifier';
import { SmashAudio } from './view/SmashAudio';
import type { SmashTrack } from './view/songs';
import { StageVisuals } from './view/StageVisuals';
import { clamp, cssToHex, disposeTree } from './view/util';
import './smash.css';

type Mode = 'attract' | 'match' | 'sandbox';

const MAX_STEPS = 12;
const INTRO_SECONDS = 2.6;
const GAMESET_SECONDS = 2.6;
const ATTRACT_MAX_SECONDS = 100;
const HUMAN_AI_LEVEL = 5;

interface FighterMeta {
  name: string;
  characterId: string;
  color: string; // slot / team colour
  slot: number; // lobby slot (-1 cpu)
  playerId: string | null;
  cpu: boolean;
  dummy: boolean;
  team: number;
}

export class SmashGame implements ISmashHost {
  onPhaseChange: ((phase: SmashPhase) => void) | null = null;
  onMatchComplete: ((result: SmashResult) => void) | null = null;
  onPauseRequest: (() => void) | null = null;
  onFx: ((fx: SmashFx) => void) | null = null;

  private phaseValue: SmashPhase = 'idle';
  private readonly container: HTMLElement;
  private readonly uiRoot: HTMLDivElement;
  private readonly hud: Hud;
  private readonly audio = new SmashAudio();

  // lifetime render objects (created on first activate)
  private renderer: THREE.WebGLRenderer | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private scene: THREE.Scene | null = null;
  private camDir: CameraDirector | null = null;
  private effects: Effects | null = null;
  private items: ItemViews | null = null;
  private magnifier: Magnifier | null = null;
  private debug: DebugOverlay | null = null;
  private tier: QualityTier = 2;
  private forcedTier: QualityTier | null = null;

  // per match
  private mode: Mode = 'attract';
  private matchRoot: THREE.Group | null = null;
  private stageVis: StageVisuals | null = null;
  private sim: ISmashSim | null = null;
  private stage: StageDef | null = null;
  private fighters: FighterVisual[] = [];
  private meta: FighterMeta[] = [];
  private cfg: SmashMatchConfig | null = null;
  private sandboxCfg: SmashSandboxConfig | null = null;
  private inputs: InputQueue[] = [];
  private simInputs: SimInput[] = [];
  private emptyInput = emptySimInput();
  private pendingBuild: (() => void) | null = null;
  private phaseTime = 0;
  private prevPhase: SmashPhase = 'fighting';
  private acc = 0;
  private timeScaleValue = 1;
  private slowmo = 1;
  private introIndex = -1;
  private countdownShown = 0;
  private fightFrames = 0;
  private gameSetSeen = false;
  private lastKo: { x: number; y: number; t: number } | null = null;
  private result: SmashResult | null = null;
  private attractEndAt = -1;
  private readonly aiPlayers = new Set<string>();
  private readonly debugCpu = new Map<number, number | null>();
  private stats = { hits: 0, kos: 0, itemsSpawned: 0, itemsUsed: 0 };
  private matchesStarted = 0;
  private lastDamage: number[] = [];

  // loop
  private active = false;
  private rafId = 0;
  private lastTime = -1;
  private time = 0;
  private fps = 60;
  private frameErrors = 0;
  private sizeDirty = true;
  private cssW = 1;
  private cssH = 1;
  private resizeObserver: ResizeObserver | null = null;
  private tvMode = false;
  private debugOn = false;
  private hooksInstalled = false;
  private readonly portraits = new Map<string, string>();
  private portraitQueue: string[] = [];
  private readonly tmpV = new THREE.Vector3();
  private readonly ndc = { x: 0, y: 0 };
  private offscreen: boolean[] = [];

  constructor(container: HTMLElement) {
    this.container = container;
    this.uiRoot = document.createElement('div');
    this.uiRoot.id = 'smash-ui';
    this.uiRoot.classList.add('hidden');
    this.hud = new Hud(this.uiRoot);
    this.hud.setMode('hidden');
  }

  get phase(): SmashPhase {
    return this.phaseValue;
  }

  private setPhase(p: SmashPhase): void {
    if (p === this.phaseValue) return;
    this.phaseValue = p;
    this.phaseTime = 0;
    try {
      this.onPhaseChange?.(p);
    } catch (err) {
      console.error('[smash] onPhaseChange handler failed', err);
    }
  }

  // ================================================================== lifecycle

  private initRenderer(): void {
    if (this.renderer) return;
    this.forcedTier = readForcedTierFromUrl();
    const low = this.forcedTier === 0;
    const renderer = new THREE.WebGLRenderer({ antialias: !low, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor(0x101028, 1);
    const canvas = renderer.domElement;
    canvas.className = 'smash-canvas hidden';
    this.container.appendChild(canvas);
    this.renderer = renderer;
    this.canvas = canvas;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.warn('[smash] WebGL context lost');
    });

    this.scene = new THREE.Scene();
    this.camDir = new CameraDirector();
    this.scene.add(this.camDir.camera);
    this.effects = new Effects();
    this.scene.add(this.effects.root);
    this.items = new ItemViews();
    this.scene.add(this.items.root);
    this.debug = new DebugOverlay();
    this.scene.add(this.debug.object);
    this.tier = this.forcedTier ?? this.pickTier();
    this.magnifier = new Magnifier(this.tier === 0 ? 128 : 256);
    this.applyQuality();

    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(() => {
        this.sizeDirty = true;
      });
      this.resizeObserver.observe(this.container);
    }
    window.addEventListener('resize', this.onResize);
    this.portraitQueue = FIGHTERS.map((f) => f.id);
  }

  private pickTier(): QualityTier {
    const w = window.innerWidth || 1280;
    const h = window.innerHeight || 720;
    const px = w * h * (window.devicePixelRatio || 1) ** 2;
    return px <= 2.6e6 ? 3 : 2;
  }

  private applyQuality(): void {
    const set = TIERS[this.tier];
    this.effects?.setQuality(set.particles);
    const shadows = set.shadowMapSize > 0;
    if (this.stageVis) this.stageVis.setShadows(shadows, set.shadowMapSize);
    for (const f of this.fighters) f.setShadows(shadows);
    this.magnifier?.setSize(this.tier === 0 ? 128 : 256);
    this.sizeDirty = true;
  }

  private readonly onResize = (): void => {
    this.sizeDirty = true;
  };

  private updateSize(): void {
    this.sizeDirty = false;
    const r = this.renderer;
    if (!r || !this.camDir) return;
    const w = Math.max(1, this.container.clientWidth || window.innerWidth);
    const h = Math.max(1, this.container.clientHeight || window.innerHeight);
    const set = TIERS[this.tier];
    let pr = Math.min(window.devicePixelRatio || 1, set.maxDpr);
    const budget = Math.sqrt(set.maxPixels / Math.max(1, w * h));
    if (pr > budget) pr = budget;
    pr = Math.max(0.35, pr);
    this.cssW = w;
    this.cssH = h;
    r.setPixelRatio(pr);
    r.setSize(w, h, false);
    this.camDir.setAspect(w / h);
  }

  activate(): void {
    if (this.active) return;
    this.active = true;
    try {
      this.initRenderer();
    } catch (err) {
      console.error('[smash] renderer init failed', err);
    }
    if (!this.uiRoot.parentElement) this.container.appendChild(this.uiRoot);
    this.canvas?.classList.remove('hidden');
    this.uiRoot.classList.remove('hidden');
    this.uiRoot.classList.toggle('tv', this.tvMode);
    this.installHooks();
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('pointerdown', this.onGesture, { passive: true });
    window.addEventListener('keydown', this.onGesture);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.audio.setActive(true);
    this.hud.setMuted(this.audio.muted);
    this.lastTime = -1;
    if (!this.rafId) this.rafId = requestAnimationFrame(this.loop);
    if (this.phaseValue === 'idle') this.startAttract();
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('pointerdown', this.onGesture);
    window.removeEventListener('keydown', this.onGesture);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.teardownMatch();
    this.audio.setActive(false);
    this.canvas?.classList.add('hidden');
    this.canvas?.classList.remove('dim');
    this.uiRoot.classList.add('hidden');
    this.hud.setMode('hidden');
    this.cfg = null;
    this.sandboxCfg = null;
    this.setPhase('idle');
  }

  private readonly onGesture = (): void => {
    this.audio.ensure();
  };

  private readonly onVisibility = (): void => {
    this.lastTime = -1;
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.repeat) return;
    const k = e.key;
    if (k === 'Escape' || k === 'p' || k === 'P') {
      const p = this.phaseValue;
      if (p === 'intro' || p === 'countdown' || p === 'fighting') {
        try {
          this.onPauseRequest?.();
        } catch (err) {
          console.error('[smash] onPauseRequest failed', err);
        }
      }
    } else if (k === 'h' || k === 'H') {
      this.setDebug(!this.debugOn);
    } else if (k === 'm' || k === 'M') {
      this.audio.setMuted(!this.audio.muted);
      this.hud.setMuted(this.audio.muted);
    }
  };

  // ================================================================== match setup

  private teardownMatch(): void {
    for (const f of this.fighters) f.dispose();
    this.fighters = [];
    if (this.matchRoot) {
      if (this.stageVis) disposeTree(this.stageVis.root);
      disposeTree(this.matchRoot);
    }
    this.matchRoot = null;
    this.stageVis = null;
    this.sim = null;
    this.stage = null;
    this.meta = [];
    this.inputs = [];
    this.simInputs = [];
    this.pendingBuild = null;
    this.items?.clear();
    this.effects?.clear();
    this.hud.clear();
    this.hud.showBig(null);
    this.hud.setSuddenDeath(false);
    this.camDir?.clearFocus();
    this.lastKo = null;
    this.slowmo = 1;
    this.acc = 0;
    this.canvas?.classList.remove('dim');
    if (this.scene) this.scene.fog = null;
    if (this.renderer) this.renderer.setClearColor(0x101028, 1);
  }

  private build(simCfg: SimConfig, meta: FighterMeta[], mode: Mode): boolean {
    this.teardownMatch();
    if (!this.renderer || !this.scene || !this.camDir) return false;
    this.mode = mode;
    let sim: ISmashSim;
    try {
      sim = new SmashSim(simCfg);
    } catch (err) {
      console.error('[smash] SmashSim failed to start', err);
      return false;
    }
    this.sim = sim;
    this.stage = sim.stage;
    this.meta = meta;
    this.stats = { hits: 0, kos: 0, itemsSpawned: 0, itemsUsed: 0 };
    this.fightFrames = 0;
    this.gameSetSeen = false;
    this.result = mode === 'match' ? null : this.result;
    this.lastDamage = meta.map(() => 0);
    this.offscreen = meta.map(() => false);

    const root = new THREE.Group();
    root.name = 'smash-match';
    this.matchRoot = root;
    this.scene.add(root);
    try {
      this.stageVis = new StageVisuals(sim.stage, this.tier);
      root.add(this.stageVis.root);
      let fogColor = this.stageVis.theme.fog;
      this.stageVis.root.traverse((o) => {
        if (o.userData.fogColor !== undefined) fogColor = o.userData.fogColor as number;
      });
      this.scene.fog = new THREE.Fog(fogColor, 40, 190);
      this.renderer.setClearColor(this.stageVis.clearColor, 1);
    } catch (err) {
      console.error('[smash] stage visuals failed', err);
    }

    const teams = simCfg.rules.teams;
    sim.fighters.forEach((f, i) => {
      const m = meta[i];
      const teamColor = teams && !m.dummy ? TEAM_COLORS[m.team % 2] ?? null : null;
      const colorCss = teamColor ?? m.color;
      const fv = new FighterVisual(f.characterId, teamColor || !(m.cpu || m.dummy) ? cssToHex(colorCss) : getCharacter(m.characterId).color, teamColor);
      if (teamColor) {
        try {
          fv.rig.setTeamColor(teamColor);
        } catch {
          /* optional */
        }
      }
      root.add(fv.group);
      this.fighters.push(fv);
    });
    this.applyQuality();

    // inputs: one queue per fighter (humans use theirs)
    this.inputs = sim.fighters.map(() => new InputQueue());
    this.simInputs = sim.fighters.map(() => emptySimInput());

    // HUD panels
    const infos: PanelInfo[] = meta.map((m) => ({
      name: m.name,
      characterId: m.characterId,
      tag: m.dummy ? 'TARGET' : m.cpu ? 'CPU' : `P${m.slot + 1}`,
      color: teams && !m.dummy ? TEAM_COLORS[m.team % 2] : m.color,
      cpu: m.cpu,
      dummy: m.dummy,
      portrait: this.portraits.get(m.characterId) ?? null,
      charColor: '#' + getCharacter(m.characterId).color.toString(16).padStart(6, '0'),
    }));
    this.hud.build(infos);

    // camera
    this.camDir.marginScale = this.tvMode ? 1.12 : 1;
    this.camDir.snap(this.frameTargets(), sim.stage);
    // warm shaders
    try {
      this.renderer.compile(this.scene, this.camDir.camera);
    } catch {
      /* optional */
    }
    return true;
  }

  private metaFromMatch(cfg: SmashMatchConfig): FighterMeta[] {
    const out: FighterMeta[] = [];
    for (const h of cfg.humans) out.push({ name: h.name, characterId: h.characterId, color: h.color, slot: h.slot, playerId: h.playerId, cpu: false, dummy: false, team: h.team });
    for (const c of cfg.cpus) out.push({ name: c.name, characterId: c.characterId, color: c.color, slot: -1, playerId: null, cpu: true, dummy: false, team: c.team });
    return out;
  }

  startMatch(cfg: SmashMatchConfig): void {
    if (!this.active) this.activate();
    if (this.cfg !== cfg) this.debugCpu.clear();
    this.cfg = cfg;
    this.sandboxCfg = null;
    this.result = null;
    this.matchesStarted++;
    this.hud.setMode('match');
    this.canvas?.classList.remove('dim');
    this.setPhase('loading');
    this.audio.setMusicLevel(1);
    this.pendingBuild = () => {
      const s = cfg.setup;
      const meta = this.metaFromMatch(cfg);
      const simCfg: SimConfig = {
        stageId: s.stageId,
        fighters: [
          ...cfg.humans.map((h) => ({ characterId: h.characterId, name: h.name, color: h.color, slot: h.slot, team: h.team, cpuLevel: null })),
          ...cfg.cpus.map((c) => ({ characterId: c.characterId, name: c.name, color: c.color, slot: -1, team: c.team, cpuLevel: clamp(Math.round(c.level), 1, 9) })),
        ],
        rules: {
          mode: s.mode,
          stocks: s.stocks,
          timeSec: s.timeSec,
          teams: s.teams,
          friendlyFire: s.friendlyFire,
          items: s.items,
          itemFrequency: s.itemFrequency,
          hazards: s.hazards,
        },
        seed: cfg.seed ?? Math.floor(Math.random() * 1e9),
      };
      if (!this.build(simCfg, meta, 'match')) {
        console.error('[smash] match build failed; back to attract');
        this.startAttract();
        return;
      }
      cfg.humans.forEach((h, i) => {
        if (this.aiPlayers.has(h.playerId)) this.sim?.setCpu(i, HUMAN_AI_LEVEL);
      });
      for (const [i, lvl] of this.debugCpu) this.sim?.setCpu(i, lvl);
      this.audio.playMusic(this.trackFor(this.stage));
      this.audio.startCrowd(this.stage?.theme === 'arena' ? 1 : 0.5);
      this.introIndex = -1;
      this.countdownShown = 0;
      if (cfg.intro === false) this.setPhase('countdown');
      else {
        this.hud.setMode('intro');
        this.setPhase('intro');
      }
    };
  }

  startSandbox(cfg: SmashSandboxConfig): void {
    if (!this.active) this.activate();
    this.cfg = null;
    this.sandboxCfg = cfg;
    this.debugCpu.clear();
    this.hud.setMode('sandbox');
    this.audio.setMusicLevel(0.8);
    const meta: FighterMeta[] = cfg.humans.map((h) => ({ name: h.name, characterId: h.characterId, color: h.color, slot: h.slot, playerId: h.playerId, cpu: false, dummy: false, team: h.team }));
    const dummyChar = FIGHTERS.find((f) => !cfg.humans.some((h) => h.characterId === f.id))?.id ?? FIGHTERS[0].id;
    meta.push({ name: 'DUMMY', characterId: dummyChar, color: '#b8c4e0', slot: -1, playerId: null, cpu: false, dummy: true, team: 1 });
    const simCfg: SimConfig = {
      stageId: 'training',
      fighters: meta.map((m) => ({ characterId: m.characterId, name: m.name, color: m.color, slot: m.slot, team: m.team, cpuLevel: null, dummy: m.dummy || undefined })),
      rules: { mode: 'stock', stocks: 99, timeSec: 0, teams: false, friendlyFire: false, items: false, itemFrequency: 'low', hazards: false },
      seed: Math.floor(Math.random() * 1e9),
      sandbox: true,
    };
    if (!this.build(simCfg, meta, 'sandbox')) {
      this.startAttract();
      return;
    }
    cfg.humans.forEach((h, i) => {
      if (this.aiPlayers.has(h.playerId)) this.sim?.setCpu(i, HUMAN_AI_LEVEL);
    });
    this.sim?.go();
    this.audio.playMusic('training');
    this.setPhase('sandbox');
  }

  private startAttract(): void {
    if (!this.renderer) return;
    this.cfg = null;
    this.sandboxCfg = null;
    this.hud.setMode('hidden');
    const stages = PICKABLE_STAGES.length ? PICKABLE_STAGES : [getStage('skyline')];
    const stage = stages[Math.floor(Math.random() * stages.length)];
    const pool = [...FIGHTERS].sort(() => Math.random() - 0.5).slice(0, 4);
    const palette = ['#ff4d4d', '#3d8bff', '#3ddc5a', '#ffc21a'];
    const meta: FighterMeta[] = pool.map((f, i) => ({ name: getCharacter(f.id).name, characterId: f.id, color: palette[i], slot: -1, playerId: null, cpu: true, dummy: false, team: i % 2 }));
    const simCfg: SimConfig = {
      stageId: stage.id,
      fighters: meta.map((m) => ({ characterId: m.characterId, name: m.name, color: m.color, slot: -1, team: m.team, cpuLevel: 5 + Math.floor(Math.random() * 3) })),
      rules: { mode: 'stock', stocks: 2, timeSec: 0, teams: false, friendlyFire: false, items: true, itemFrequency: 'medium', hazards: true },
      seed: Math.floor(Math.random() * 1e9),
    };
    if (!this.build(simCfg, meta, 'attract')) {
      this.setPhase('attract');
      return;
    }
    this.sim?.go();
    this.attractEndAt = -1;
    this.audio.setMusicLevel(0.45);
    this.audio.playMusic('attract');
    this.audio.stopCrowd();
    this.setPhase('attract');
  }

  private trackFor(stage: StageDef | null): SmashTrack {
    switch (stage?.theme) {
      case 'arena':
        return 'arena';
      case 'forge':
        return 'forge';
      case 'training':
        return 'training';
      default:
        return 'sky';
    }
  }

  retireFromSandbox(slot: number): void {
    const sim = this.sim;
    if (!sim || this.mode !== 'sandbox') return;
    const f = sim.fighters[slot];
    if (!f || f.dummy || f.out) return;
    this.effects?.puff(f.x, f.y + f.height / 2);
    this.audio.dodge(0);
    try {
      sim.retire(slot);
    } catch (err) {
      console.error('[smash] retire failed', err);
    }
  }

  setHumanInput(slot: number, input: DecodedFightInput): void {
    const q = this.inputs[slot];
    if (!q || !input) return;
    const m = this.meta[slot];
    if (!m || m.cpu || m.dummy) return;
    q.push(input, performance.now());
  }

  setSlotAI(slot: number, ai: boolean): void {
    const m = this.meta[slot];
    const pid = m?.playerId ?? this.cfg?.humans[slot]?.playerId ?? this.sandboxCfg?.humans[slot]?.playerId;
    if (pid) {
      if (ai) this.aiPlayers.add(pid);
      else this.aiPlayers.delete(pid);
    }
    if (!m || m.cpu || m.dummy || !this.sim) return;
    try {
      this.sim.setCpu(slot, ai ? HUMAN_AI_LEVEL : null);
    } catch (err) {
      console.error('[smash] setCpu failed', err);
    }
    this.inputs[slot]?.reset();
  }

  pause(): void {
    const p = this.phaseValue;
    if (p === 'paused' || p === 'idle' || p === 'attract' || p === 'results' || p === 'loading') return;
    this.prevPhase = p;
    const keepTime = this.phaseTime;
    this.setPhase('paused');
    this.phaseTime = keepTime;
    this.canvas?.classList.add('dim');
    this.audio.duck(true);
  }

  resume(): void {
    if (this.phaseValue !== 'paused') return;
    const keepTime = this.phaseTime;
    this.setPhase(this.prevPhase);
    this.phaseTime = keepTime;
    this.canvas?.classList.remove('dim');
    this.audio.duck(false);
    this.lastTime = -1;
    for (const q of this.inputs) q.clearPending();
  }

  restartMatch(): void {
    if (this.cfg) {
      const cfg = this.cfg;
      this.startMatch(cfg);
    } else if (this.sandboxCfg) {
      this.startSandbox(this.sandboxCfg);
    }
  }

  quitMatch(): void {
    if (!this.active) return;
    this.canvas?.classList.remove('dim');
    this.audio.duck(false);
    this.startAttract();
  }

  // ================================================================== status

  getFighterStatus(slot: number): FighterStatus | null {
    const sim = this.sim;
    if (!sim || this.mode === 'attract') return null;
    const f = sim.fighters[slot];
    if (!f) return null;
    const p = this.phaseValue === 'paused' ? this.prevPhase : this.phaseValue;
    let countdown = 0;
    if (p === 'loading' || p === 'intro') countdown = 3;
    else if (p === 'countdown') countdown = clamp(3 - Math.floor(this.phaseTime), 1, 3);
    const timeMode = sim.config.rules.mode === 'time' && this.mode === 'match';
    const st: FighterStatus = {
      fighter: slot,
      characterId: f.characterId,
      damage: Math.floor(f.damage),
      stocks: timeMode ? -1 : f.stocks,
      score: f.score,
      kos: f.kos,
      countdown,
      timeLeft: sim.timeLeft,
      out: f.out,
      respawning: f.respawning,
      cpu: f.cpu,
      team: f.team,
      item: f.heldItem ?? 'none',
      suddenDeath: sim.suddenDeath,
    };
    if (this.mode === 'sandbox') {
      const d = sim.fighters.find((x) => x.dummy);
      st.dummyDamage = d ? Math.floor(d.damage) : 0;
    }
    return st;
  }

  getResults(): SmashResult | null {
    return this.result;
  }

  getPortrait(characterId: string): string | null {
    const c = this.portraits.get(characterId);
    if (c) return c;
    if (!this.renderer) return null;
    return this.renderPortraitNow(characterId);
  }

  private renderPortraitNow(id: string): string | null {
    const r = this.renderer;
    if (!r) return null;
    try {
      const url = renderPortrait(r, id, 256);
      if (url && url.length > 200) {
        this.portraits.set(id, url);
        this.hud.setPortrait(id, url);
      }
      return url || null;
    } catch (err) {
      console.warn('[smash] renderPortrait failed', id, err);
      return null;
    } finally {
      r.setRenderTarget(null);
      r.setScissorTest(false);
      this.sizeDirty = true;
    }
  }

  setTvMode(on: boolean): void {
    this.tvMode = on;
    this.uiRoot.classList.toggle('tv', on);
    if (this.camDir) this.camDir.marginScale = on ? 1.12 : 1;
  }

  // ================================================================== main loop

  private readonly loop = (now: number): void => {
    if (!this.active) {
      this.rafId = 0;
      return;
    }
    this.rafId = requestAnimationFrame(this.loop);
    if (this.lastTime < 0) this.lastTime = now;
    let raw = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (!(raw >= 0)) raw = 0;
    if (raw > 0 && raw < 5) this.fps += (1 / Math.max(1e-3, raw) - this.fps) * Math.min(1, raw * 2);
    const dt = Math.min(raw, 0.25);
    try {
      if (this.sizeDirty) this.updateSize();
      this.frame(dt);
    } catch (err) {
      this.frameErrors++;
      if (this.frameErrors <= 3 || this.frameErrors % 300 === 0) console.error('[smash] frame error', err);
    }
  };

  private frame(dt: number): void {
    this.time += dt;
    const r = this.renderer;
    if (!r || !this.scene || !this.camDir) return;

    if (this.pendingBuild) {
      // 'loading': render one frame with the old scene cleared, then build
      const b = this.pendingBuild;
      if (this.phaseTime > 0) {
        this.pendingBuild = null;
        b();
      }
      this.phaseTime += dt;
      r.render(this.scene, this.camDir.camera);
      return;
    }

    const p = this.phaseValue;
    if (p !== 'paused') this.phaseTime += dt;
    this.updatePhase(dt);

    // ---- step the sim
    const sim = this.sim;
    if (sim) {
      const stepping = p === 'attract' || p === 'intro' || p === 'countdown' || p === 'fighting' || p === 'gameSet' || p === 'sandbox' || p === 'results';
      if (stepping) {
        this.acc += dt * this.timeScaleValue * this.slowmo;
        let steps = Math.floor(this.acc * 60);
        const cap = MAX_STEPS * Math.max(1, Math.ceil(this.timeScaleValue));
        if (steps > cap) {
          steps = cap;
          this.acc = 0;
        } else {
          this.acc -= steps / 60;
        }
        const takesInput = p === 'fighting' || p === 'sandbox';
        for (let s = 0; s < steps; s++) {
          for (let i = 0; i < this.simInputs.length; i++) {
            const m = this.meta[i];
            if (takesInput && m && !m.cpu && !m.dummy) this.inputs[i].next(this.simInputs[i]);
            else Object.assign(this.simInputs[i], this.emptyInput);
          }
          const evs = sim.step(this.simInputs);
          if (p === 'fighting') this.fightFrames++;
          if (evs && evs.length) this.handleEvents(evs);
          if (p === 'fighting' && sim.status === 'gameSet' && !this.gameSetSeen) {
            this.onGameSet();
            break;
          }
        }
        if ((p === 'intro' || p === 'countdown') && !takesInput) {
          // presses during intro/countdown only matter for skipping; never queue them into the fight
          for (const q of this.inputs) q.clearPending();
        }
      }
    }

    this.render(dt);
    this.portraitTick();
  }

  private updatePhase(dt: number): void {
    const p = this.phaseValue;
    const sim = this.sim;
    void dt;
    switch (p) {
      case 'intro': {
        const n = Math.max(1, this.fighters.length);
        const per = INTRO_SECONDS / n;
        const idx = Math.min(n - 1, Math.floor(this.phaseTime / per));
        let skip = false;
        for (let i = 0; i < this.inputs.length; i++) if (this.meta[i] && !this.meta[i].cpu && this.inputs[i].takeAttackPresses() > 0) skip = true;
        if (skip || this.phaseTime >= INTRO_SECONDS) {
          this.hud.showIntro(null);
          this.hud.setMode('match');
          this.camDir?.clearFocus();
          this.setPhase('countdown');
          this.countdownShown = 0;
          return;
        }
        if (idx !== this.introIndex && sim) {
          this.introIndex = idx;
          const f = sim.fighters[idx];
          const m = this.meta[idx];
          if (f && m) {
            const tag = m.cpu ? `CPU · LV ${this.cfg?.cpus[idx - (this.cfg?.humans.length ?? 0)]?.level ?? ''}` : `P${m.slot + 1}`;
            const def = FIGHTERS.find((d) => d.id === f.characterId);
            this.hud.showIntro({ name: m.name, tag, color: this.colorOf(idx), sub: `${getCharacter(f.characterId).name}${def ? ' · ' + def.archetypeLabel : ''}` });
            this.audio.swoosh();
          }
        }
        if (sim) {
          const f = sim.fighters[this.introIndex] ?? sim.fighters[0];
          const segT = (this.phaseTime % per) / per;
          if (f) this.camDir?.setFocus(f.x + (segT - 0.5) * 1.2 * (f.facing || 1), f.y + f.height * 0.62, 4.2 - segT * 0.5, 6);
        }
        return;
      }
      case 'countdown': {
        const n = Math.floor(this.phaseTime) + 1; // 1..3
        if (this.phaseTime >= 3) {
          this.goFight();
          return;
        }
        if (n > this.countdownShown) {
          this.countdownShown = n;
          const num = 4 - n;
          this.hud.showBig(String(num), 'count', 950);
          this.audio.countdown(num);
        }
        for (let i = 0; i < this.inputs.length; i++) this.inputs[i].takeAttackPresses();
        return;
      }
      case 'fighting': {
        if (sim) {
          this.hud.setTimer(sim.config.rules.mode === 'time' || sim.suddenDeath ? sim.timeLeft : -1);
          if (sim.status === 'gameSet' && !this.gameSetSeen) this.onGameSet();
        }
        return;
      }
      case 'gameSet': {
        if (this.phaseTime > 1.1) this.slowmo = 1;
        else this.slowmo = 0.25;
        if (this.phaseTime >= GAMESET_SECONDS) this.finishMatch();
        return;
      }
      case 'results': {
        if (this.phaseTime % 2.2 < dt && sim) {
          const w = this.fighters[this.result?.winnerFighter ?? 0];
          if (w) this.effects?.confetti(w.rig.root.position.x, w.rig.root.position.y + 5);
        }
        return;
      }
      case 'attract': {
        if (!sim) return;
        if (sim.status === 'gameSet' && this.attractEndAt < 0) this.attractEndAt = this.phaseTime + 3;
        if (this.phaseTime > ATTRACT_MAX_SECONDS && this.attractEndAt < 0) {
          try {
            sim.forceGameSet();
          } catch {
            /* */
          }
          this.attractEndAt = this.phaseTime + 2;
        }
        if (this.attractEndAt >= 0 && this.phaseTime >= this.attractEndAt) this.startAttract();
        return;
      }
      default:
        return;
    }
  }

  private goFight(): void {
    this.hud.showBig('GO!', 'go', 1000);
    this.audio.go();
    try {
      this.sim?.go();
    } catch (err) {
      console.error('[smash] sim.go failed', err);
    }
    for (const q of this.inputs) {
      q.clearPending();
      q.takeAttackPresses();
    }
    this.setPhase('fighting');
    this.fxAllHumans('go', 1);
  }

  private onGameSet(): void {
    if (this.gameSetSeen) return;
    this.gameSetSeen = true;
    this.hud.showBig('GAME!', 'game', 2500);
    this.hud.setTimer(-1);
    this.audio.game();
    this.audio.duck(true);
    this.fxAllHumans('game', 1);
    this.camDir?.shake(0.5);
    const ko = this.lastKo;
    if (ko && this.time - ko.t < 1.6 && this.stage) {
      const cb = this.stage.camera;
      this.camDir?.setFocus(clamp(ko.x, cb.left + 6, cb.right - 6), clamp(ko.y, cb.bottom + 4, cb.top - 4), 10, 2.2);
    }
    this.setPhase('gameSet');
    this.slowmo = 0.25;
  }

  private finishMatch(): void {
    this.slowmo = 1;
    this.audio.duck(false);
    this.hud.showBig(null);
    const res = this.buildResult();
    this.result = res;
    // results staging: winner(s) centre stage doing `victory`, others `defeat`
    const sim = this.sim;
    const stage = this.stage;
    if (sim && stage) {
      const main = stage.platforms.findIndex((pl) => pl.solid);
      const mp = sim.stageView.platforms[Math.max(0, main)] ?? { x: 0, y: 0 };
      const winners = sim.fighters.filter((f) => (res.winnerTeam >= 0 ? f.team === res.winnerTeam : f.index === res.winnerFighter)).map((f) => f.index);
      const losers = sim.fighters.filter((f) => !winners.includes(f.index) && !f.dummy).map((f) => f.index);
      winners.forEach((wi, k) => {
        const fv = this.fighters[wi];
        if (!fv) return;
        fv.pose = 'victory';
        fv.rig.root.position.set(mp.x + (k - (winners.length - 1) / 2) * 1.8, mp.y, 0.6);
        fv.rig.root.rotation.set(0, 0, 0);
      });
      losers.forEach((li, k) => {
        const fv = this.fighters[li];
        if (!fv) return;
        fv.pose = 'defeat';
        const side = k % 2 === 0 ? 1 : -1;
        fv.rig.root.position.set(mp.x + side * (2.6 + Math.floor(k / 2) * 1.7) + (winners.length > 1 ? side * 0.9 : 0), mp.y, -1.4);
        fv.rig.root.rotation.set(0, 0, 0);
      });
      const wx = winners.length ? mp.x : 0;
      this.camDir?.setFocus(wx, mp.y + 1.9, 6.2 + (winners.length - 1) * 1.2, 2.5);
      const w = this.fighters[winners[0]];
      if (w) this.effects?.confetti(w.rig.root.position.x, mp.y + 5);
    }
    this.audio.playMusic('results');
    this.audio.stopCrowd();
    this.hud.setMode('results');
    this.setPhase('results');
    try {
      this.onMatchComplete?.(res);
    } catch (err) {
      console.error('[smash] onMatchComplete handler failed', err);
    }
  }

  private buildResult(): SmashResult {
    const sim = this.sim!;
    let rows: SmashResultRow[] = [];
    try {
      rows = sim.results().map((r) => {
        const m = this.meta[r.fighter];
        const f = sim.fighters[r.fighter];
        return {
          fighter: r.fighter,
          slot: m && !m.cpu ? m.slot : -1,
          playerId: m && !m.cpu ? m.playerId : null,
          name: m?.name ?? f?.name ?? '?',
          characterId: f?.characterId ?? m?.characterId ?? '',
          color: m?.color ?? '#fff',
          team: r.team,
          cpu: m ? m.cpu : true,
          place: r.place,
          kos: r.kos,
          falls: r.falls,
          sds: r.sds,
          damageDealt: Math.round(r.damageDealt),
          damageTaken: Math.round(r.damageTaken),
          stocksLeft: r.stocksLeft,
          score: r.score,
        };
      });
    } catch (err) {
      console.error('[smash] sim.results failed', err);
    }
    rows = rows.filter((r) => !this.meta[r.fighter]?.dummy).sort((a, b) => a.place - b.place);
    const w = sim.winner ?? { fighter: -1, team: -1 };
    const winnerFighter = w.fighter >= 0 ? w.fighter : rows[0]?.fighter ?? 0;
    return {
      rows,
      winnerFighter,
      winnerTeam: sim.config.rules.teams ? (w.team >= 0 ? w.team : sim.fighters[winnerFighter]?.team ?? -1) : -1,
      mode: sim.config.rules.mode,
      duration: Math.round((this.fightFrames / 60) * 10) / 10,
    };
  }

  // ================================================================== events

  private colorOf(i: number): string {
    const m = this.meta[i];
    if (!m) return '#ffffff';
    if (this.sim?.config.rules.teams && !m.dummy) return TEAM_COLORS[m.team % 2];
    return m.color;
  }

  /** Vivid colour for effects: player / team colour, or the character colour for CPUs. */
  private fxColor(i: number): number {
    const m = this.meta[i];
    if (m && (m.cpu || m.dummy) && !this.sim?.config.rules.teams) return getCharacter(m.characterId).color;
    return cssToHex(this.colorOf(i));
  }

  private pan(x: number): number {
    if (!this.camDir) return 0;
    return clamp((x - this.camDir.cx) / Math.max(4, this.camDir.width / 2), -0.9, 0.9);
  }

  private fx(fighter: number, kind: PhoneFx['kind'], strength: number): void {
    const m = this.meta[fighter];
    if (!m || m.cpu || m.dummy || this.mode === 'attract') return;
    try {
      this.onFx?.({ slot: fighter, kind, strength: clamp(strength, 0, 1) });
    } catch (err) {
      console.error('[smash] onFx failed', err);
    }
  }

  private fxAllHumans(kind: PhoneFx['kind'], strength: number): void {
    for (let i = 0; i < this.meta.length; i++) this.fx(i, kind, strength);
  }

  private handleEvents(evs: readonly SimEvent[]): void {
    const fx = this.effects;
    const sim = this.sim;
    if (!fx || !sim) return;
    const quiet = this.mode === 'attract';
    for (const e of evs) {
      switch (e.type) {
        case 'hit': {
          const ac = e.attacker >= 0 ? this.fxColor(e.attacker) : 0xffffff;
          fx.hit(e.x, e.y, e.strength, e.kind, e.angle, ac, e.shielded);
          this.audio.hit(e.strength, e.kind, this.pan(e.x), e.shielded);
          if (e.shielded) {
            this.fighters[e.victim]?.flashShield();
          } else {
            this.stats.hits++;
            this.camDir?.shake(Math.pow(clamp(e.strength, 0, 1), 2) * 0.55);
            if (e.strength > 0.7 && !quiet) this.audio.crowd('ooh', e.strength);
            this.fx(e.victim, 'hit', clamp(e.kb / 150, 0.05, 1));
            if (e.attacker >= 0 && e.attacker !== e.victim) this.fx(e.attacker, 'land', 0.3);
          }
          break;
        }
        case 'ko': {
          this.stats.kos++;
          const st = this.stage;
          const cx = st ? (st.camera.left + st.camera.right) / 2 : 0;
          const cy = st ? st.platforms[0]?.y ?? 0 : 0;
          // KO point clamped into the visible area so the blast is seen
          const cam = this.camDir;
          let x = e.x;
          let y = e.y;
          if (cam) {
            const hw = cam.width / 2;
            const hh = cam.h / 2;
            x = clamp(x, cam.cx - hw * 0.98, cam.cx + hw * 0.98);
            y = clamp(y, cam.cy - hh * 0.98, cam.cy + hh * 0.98);
          }
          fx.ko(x, y, e.side, this.fxColor(e.victim), cx, cy + 2);
          this.audio.koBoom(this.pan(x));
          cam?.shake(0.85);
          this.lastKo = { x, y, t: this.time };
          if (this.stageVis) this.stageVis.crowdHype = 3;
          setTimeout(() => {
            if (this.stageVis) this.stageVis.crowdHype = 1;
          }, 1800);
          if (!quiet) this.hud.koPop(e.victim);
          this.fx(e.victim, 'ko', 1);
          if (e.by >= 0 && e.by !== e.victim) this.fx(e.by, 'koOther', 1);
          break;
        }
        case 'respawn': {
          const f = sim.fighters[e.fighter];
          if (f) fx.respawnFlash(f.x, f.y, this.fxColor(e.fighter));
          break;
        }
        case 'shieldBreak': {
          const f = sim.fighters[e.fighter];
          if (f) fx.shieldBreak(f.x, f.y + f.height / 2, this.fxColor(e.fighter));
          this.audio.shieldBreak(this.pan(f?.x ?? 0));
          if (!quiet) this.audio.crowd('ooh', 1);
          this.fx(e.fighter, 'shieldBreak', 1);
          break;
        }
        case 'ledgeGrab':
          this.audio.ledge(this.pan(sim.fighters[e.fighter]?.x ?? 0));
          break;
        case 'jump': {
          const f = sim.fighters[e.fighter];
          if (f) {
            this.audio.jump(e.double, this.pan(f.x));
            if (!e.double) fx.landDust(f.x, f.y, false);
            else fx.sparkle(f.x, f.y, 0.25);
          }
          break;
        }
        case 'land': {
          const f = sim.fighters[e.fighter];
          if (f) {
            fx.landDust(f.x, f.y, e.hard);
            this.audio.land(e.hard, this.pan(f.x));
          }
          break;
        }
        case 'swing':
          this.audio.whoosh(e.strength, this.pan(sim.fighters[e.fighter]?.x ?? 0));
          break;
        case 'special':
          this.audio.whoosh(0.7, this.pan(sim.fighters[e.fighter]?.x ?? 0));
          break;
        case 'dodge':
          this.audio.dodge(this.pan(sim.fighters[e.fighter]?.x ?? 0));
          break;
        case 'grab':
          this.audio.grab(this.pan(sim.fighters[e.fighter]?.x ?? 0));
          break;
        case 'throw':
          this.audio.whoosh(0.8, this.pan(sim.fighters[e.fighter]?.x ?? 0));
          break;
        case 'itemSpawn':
          this.stats.itemsSpawned++;
          fx.sparkle(e.x, e.y + 0.4, 0.6);
          break;
        case 'itemPickup':
          this.stats.itemsUsed++;
          this.audio.pickup();
          break;
        case 'itemThrow':
          this.audio.whoosh(0.6, this.pan(sim.fighters[e.fighter]?.x ?? 0));
          break;
        case 'heal': {
          const f = sim.fighters[e.fighter];
          if (f) fx.heal(f.x, f.y);
          this.audio.heal();
          break;
        }
        case 'explosion':
          fx.explosion(e.x, e.y, e.r);
          this.audio.explosion(e.r / 2, this.pan(e.x));
          this.camDir?.shake(0.45);
          break;
        case 'capsuleOpen':
          fx.puff(e.x, e.y);
          break;
        case 'powerUp': {
          const f = sim.fighters[e.fighter];
          if (f) fx.power(f.x, f.y);
          this.audio.powerUp();
          break;
        }
        case 'finalSmash': {
          const f = sim.fighters[e.fighter];
          if (f) fx.power(f.x, f.y);
          this.audio.powerUp();
          this.audio.crowd('cheer', 1);
          this.camDir?.shake(0.6);
          break;
        }
        case 'hazardWarning':
          this.audio.hazardWarning();
          break;
        case 'hazardErupt':
          this.audio.hazardErupt();
          this.camDir?.shake(0.35);
          break;
        case 'timeWarning':
          this.audio.tick(e.secondsLeft <= 5);
          break;
        case 'suddenDeath':
          this.hud.setSuddenDeath(true);
          this.hud.showBig('SUDDEN DEATH', 'count', 1600);
          this.audio.announce('Sudden death!');
          break;
        case 'gameSet':
          if (this.phaseValue === 'fighting') this.onGameSet();
          break;
        default:
          break;
      }
    }
  }

  /**
   * Debug helpers (forceKO / spawnItem / forceGameSet) push events between steps; a sim that
   * resets its event list at the start of step() would drop them, so drain them here.
   */
  private simEvLen(): number {
    const ev = (this.sim as unknown as { ev?: SimEvent[] } | null)?.ev;
    return Array.isArray(ev) ? ev.length : 0;
  }

  private drainSimEvents(from: number): void {
    const ev = (this.sim as unknown as { ev?: SimEvent[] } | null)?.ev;
    if (!Array.isArray(ev) || ev.length <= from) return;
    const fresh = ev.splice(from);
    this.handleEvents(fresh);
  }

  // ================================================================== render

  private frameTargets(): FrameTarget[] {
    const sim = this.sim;
    const out: FrameTarget[] = [];
    if (!sim) return out;
    for (const f of sim.fighters) {
      if (f.out || f.action === 'ko' || f.action === 'out') continue;
      out.push({ x: f.x, y: f.y, w: f.width || 0.8, h: f.height || 1.8, vx: f.vx, vy: f.vy });
    }
    return out;
  }

  private groundBelow(x: number, y: number): number | null {
    const sim = this.sim;
    const st = this.stage;
    if (!sim || !st) return null;
    let best: number | null = null;
    st.platforms.forEach((p, i) => {
      const pv = sim.stageView.platforms[i] ?? p;
      if (Math.abs(x - pv.x) <= p.w / 2 && pv.y <= y + 0.05 && (best === null || pv.y > best)) best = pv.y;
    });
    return best;
  }

  private render(dt: number): void {
    const r = this.renderer!;
    const scene = this.scene!;
    const cam = this.camDir!;
    const sim = this.sim;
    const stage = this.stage;
    const paused = this.phaseValue === 'paused';
    const vdt = paused ? 0 : dt * (this.phaseValue === 'gameSet' ? this.slowmo : 1);

    if (sim && stage) {
      this.stageVis?.update(sim.stageView, this.time, vdt);
      const blobs = TIERS[this.tier].shadowMapSize === 0;
      const lowFx = this.tier === 0;
      for (let i = 0; i < this.fighters.length; i++) {
        const fv = this.fighters[i];
        const f = sim.fighters[i];
        if (!f) continue;
        fv.update(f, vdt, this.time, this.groundBelow(f.x, f.y), blobs);
        if (paused) continue;
        // launch smoke trail
        if (f.launchSpeed > 0.08 && !f.out && f.action !== 'ko' && (!lowFx || Math.floor(this.time * 30) % 2 === 0)) {
          this.effects?.smoke(f.x, f.y + f.height / 2, f.launchSpeed > 0.25);
        }
        // dash dust
        if (f.action === 'run' && f.actionFrame <= 2 && f.grounded) this.effects?.dashDust(f.x, f.y, f.facing);
        // HUD panel
        const dmg = f.damage;
        this.lastDamage[i] = dmg;
        this.hud.updatePanel(i, {
          damage: dmg,
          stocks: this.mode === 'sandbox' ? -1 : f.stocks,
          kos: f.kos,
          score: f.score,
          out: f.out,
          cpu: f.cpu,
          timeMode: sim.config.rules.mode === 'time' && this.mode === 'match',
        });
        if (this.mode === 'sandbox') this.hud.hidePanel(i, f.out && !f.dummy);
      }
      // bomb fuse sparkles from the items view
      if (this.items) {
        const hand = (fi: number, out: THREE.Vector3): boolean => {
          const fv = this.fighters[fi];
          if (!fv) return false;
          const a = fv.rig.getHandAnchor?.();
          if (a) {
            a.getWorldPosition(out);
            out.y += 0.3;
            return true;
          }
          const f = sim.fighters[fi];
          if (!f) return false;
          out.set(f.x + f.facing * 0.45, f.y + f.height * 0.55, 0);
          return true;
        };
        this.items.update(sim.items, sim.projectiles, this.time, hand);
        this.items.root.visible = this.phaseValue !== 'results';
        if (!paused && Math.floor(this.time * 20) !== Math.floor((this.time - dt) * 20)) {
          for (const s of this.items.sparkles) this.effects?.sparkle(s.x, s.y, 0.15);
        }
      }
      // camera
      if (!paused) cam.update(dt, this.frameTargets(), stage);
      // debug overlay
      if (this.debug) {
        this.debug.object.visible = this.debugOn;
        if (this.debugOn) {
          try {
            this.debug.update(sim.debugShapes());
          } catch {
            this.debug.update([]);
          }
        }
      }
    }
    if (!paused) this.effects?.update(vdt, cam.camera);

    // ---- name tags + offscreen detection
    const showTags = sim && this.mode !== 'attract' && this.phaseValue !== 'results' && this.phaseValue !== 'intro' && this.phaseValue !== 'loading';
    const mags: MagnifyRequest[] = [];
    if (sim) {
      for (let i = 0; i < sim.fighters.length; i++) {
        const f = sim.fighters[i];
        const gone = f.out || f.action === 'ko' || f.action === 'out';
        cam.project(f.x, f.y + f.height * 0.5, this.ndc);
        const off = !gone && (Math.abs(this.ndc.x) > 1.0 || Math.abs(this.ndc.y) > 1.0);
        this.offscreen[i] = off;
        if (off && this.phaseValue !== 'results' && this.phaseValue !== 'intro') {
          mags.push({ x: f.x, y: f.y + f.height * 0.5, h: f.height, ndcX: this.ndc.x, ndcY: this.ndc.y, color: this.fxColor(i) });
        }
        if (!showTags || gone || off || f.dummy) {
          this.hud.setTag(i, null);
          continue;
        }
        cam.project(f.x, f.y + f.height + 0.25, this.ndc);
        this.hud.setTag(i, (this.ndc.x * 0.5 + 0.5) * this.cssW, (0.5 - this.ndc.y * 0.5) * this.cssH);
      }
    }

    r.setRenderTarget(null);
    r.render(scene, cam.camera);
    if (this.magnifier && mags.length) {
      const unit = Math.min(this.cssW, this.cssH) / 100 * (this.tvMode ? 1.1 : 1);
      const safe = this.tvMode ? this.cssH * 0.05 : 0;
      this.magnifier.render(r, scene, mags, this.cssW, this.cssH, unit, safe);
    } else if (this.magnifier) {
      this.magnifier.shown = 0;
    }
  }

  private portraitTick(): void {
    if (!this.portraitQueue.length || !this.renderer) return;
    const id = this.portraitQueue.shift()!;
    if (!this.portraits.has(id)) this.renderPortraitNow(id);
  }

  // ================================================================== debug hooks

  setDebug(on: boolean): void {
    this.debugOn = on;
    if (this.debug) this.debug.object.visible = on;
  }

  private installHooks(): void {
    if (this.hooksInstalled) return;
    this.hooksInstalled = true;
    const game = this;
    const hooks: SmashDebugHooks & { engine: SmashGame } = {
      engine: game,
      getState() {
        const sim = game.sim;
        const mem = game.renderer?.info.memory ?? { geometries: 0, textures: 0 };
        const progs = (game.renderer?.info as unknown as { programs?: unknown[] } | undefined)?.programs;
        const fighters = sim
          ? sim.fighters.map((f: FighterView, i: number) => {
              const m = game.meta[i];
              return {
                index: i,
                slot: m ? m.slot : -1,
                name: m?.name ?? f.name,
                characterId: f.characterId,
                human: !!m && !m.cpu && !m.dummy,
                cpu: f.cpu,
                dummy: f.dummy,
                team: f.team,
                x: f.x,
                y: f.y,
                vx: f.vx,
                vy: f.vy,
                facing: f.facing,
                grounded: f.grounded,
                action: f.action,
                move: f.move,
                damage: f.damage,
                stocks: f.stocks,
                kos: f.kos,
                falls: f.falls,
                damageDealt: f.damageDealt,
                out: f.out,
                respawning: f.respawning,
                invincible: f.invincible,
                shield: f.shield,
                heldItem: f.heldItem,
                offscreen: !!game.offscreen[i],
              };
            })
          : [];
        return {
          phase: game.phaseValue,
          stageId: game.stage?.id ?? null,
          frame: sim?.frame ?? 0,
          fps: Math.round(game.fps * 10) / 10,
          matchesStarted: game.matchesStarted,
          timeLeft: sim?.timeLeft ?? -1,
          suddenDeath: sim?.suddenDeath ?? false,
          hits: game.stats.hits,
          kos: game.stats.kos,
          itemsSpawned: game.stats.itemsSpawned,
          itemsUsed: game.stats.itemsUsed,
          debugOverlay: game.debugOn,
          camera: { x: game.camDir?.cx ?? 0, y: game.camDir?.cy ?? 0, width: game.camDir?.width ?? 0 },
          memory: { geometries: mem.geometries, textures: mem.textures, programs: Array.isArray(progs) ? progs.length : 0 },
          fighters,
          items: sim ? sim.items.map((it) => ({ id: it.id, kind: it.kind, x: it.x, y: it.y, holder: it.holder })) : [],
          projectiles: sim?.projectiles.length ?? 0,
        };
      },
      setDamage(fighter: number, pct: number) {
        game.sim?.setDamage(fighter, pct);
      },
      ko(fighter: number) {
        const n = game.simEvLen();
        game.sim?.forceKO(fighter);
        game.drainSimEvents(n);
      },
      spawnItem(kind: ItemKind, x?: number, y?: number) {
        const n = game.simEvLen();
        const id = game.sim?.spawnItem(kind, x, y) ?? -1;
        game.drainSimEvents(n);
        return id;
      },
      giveItem(fighter: number, kind: ItemKind) {
        game.sim?.giveItem(fighter, kind);
      },
      endMatch() {
        const p = game.phaseValue;
        if (p === 'intro' || p === 'countdown') game.goFight();
        if (game.phaseValue === 'paused') game.resume();
        if (game.phaseValue === 'fighting' || game.phaseValue === 'attract') {
          const n = game.simEvLen();
          try {
            game.sim?.forceGameSet();
          } catch (err) {
            console.error('[smash] forceGameSet failed', err);
          }
          game.drainSimEvents(n);
          if (game.phaseValue === 'fighting') game.onGameSet();
        }
      },
      setDebug(on: boolean) {
        game.setDebug(on);
      },
      cpu(fighter: number, level: number | null) {
        game.debugCpu.set(fighter, level);
        game.sim?.setCpu(fighter, level);
      },
      timeScale(n: number) {
        game.timeScaleValue = Number.isFinite(n) && n > 0 ? Math.min(16, n) : 1;
      },
    };
    (window as unknown as { __smash: typeof hooks }).__smash = hooks;
  }

  /** Engine teardown (not part of ISmashHost; dev pages). */
  dispose(): void {
    this.deactivate();
    this.effects?.dispose();
    this.items?.dispose();
    this.magnifier?.dispose();
    this.debug?.dispose();
    this.audio.dispose();
    this.resizeObserver?.disconnect();
    window.removeEventListener('resize', this.onResize);
    this.renderer?.dispose();
    this.canvas?.remove();
    this.uiRoot.remove();
  }
}

