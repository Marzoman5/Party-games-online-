/**
 * Game: the KART PARTY engine. Owns the renderer, scene, lights, fixed-step
 * loop, split-screen viewports, the attract-mode demo race and the legacy solo
 * keyboard flow, and implements `IGameHost` (src/game/api.ts) for the party
 * layer. This is the only module allowed to import other workstreams' concrete
 * classes; everything else is typed against the core interfaces.
 *
 * Phase flow (EnginePhase):
 *   idle -> demo (showDemo) / soloMenu (openSoloMenu)
 *   startRace: loading -> intro (~4.5 s flyover, optional) -> countdown (3 s) -> racing
 *              -> finished (>= 1 human crossed the line) -> results (race complete)
 *   pause()/resume(): any of intro/countdown/racing/finished <-> paused
 *   quitRace(): -> demo
 */
import * as THREE from 'three';
import type {
  CharacterDef,
  Difficulty,
  GameState,
  IAIDriver,
  IAudioEngine,
  IItemManager,
  IKart,
  InputState,
  IParticleSystem,
  IPostFX,
  ITrack,
  ItemType,
  MusicTrack,
  RaceStanding,
  TrackDefinition,
} from '../core/types';
import { createEmptyInput } from '../core/types';
import { events } from '../core/events';
import { COUNTDOWN_STEP_SECONDS, FIXED_DT, KART_COUNT } from '../core/constants';
import { clamp, clamp01, damp } from '../core/math';
import { SLOT_COLORS } from '../net/protocol';

import { Kart } from '../kart/Kart';
import { InputManager } from '../kart/InputManager';
import { CHARACTERS, getCharacter } from '../kart/roster';
import { Track } from '../track/Track';
import { TRACKS, getTrackDef } from '../track/tracks';
import { ItemManager } from '../items/ItemManager';
import { buildItemIcon } from '../items/itemVisuals';
import { AIDriver } from '../ai/AIDriver';
import { AudioEngine } from '../audio/AudioEngine';
import { ParticleSystem } from '../fx/ParticleSystem';
import { PostFX } from '../fx/PostFX';

import type {
  EnginePhase,
  HumanDriver,
  HumanInput,
  IGameHost,
  PartyRaceConfig,
  QualityTier,
  RaceResult,
  SlotStatus,
} from './api';
import type { EngineCC } from '../net/protocol';
import { RaceManager } from './RaceManager';
import type { StartResult } from './RaceManager';
import { MenuBackdrop } from './MenuBackdrop';
import type { MenuFraming } from './MenuBackdrop';
import { QualityScaler, TIERS } from './QualityScaler';
import { applyRectToElement, computeLayout, Viewport } from './Viewports';
import type { NormRect } from './Viewports';
import { HumanInputChannel } from './HumanInput';
import { TipSystem } from './TipSystem';
import { IntroFlyover } from './IntroFlyover';
import { DemoDirector } from './DemoDirector';
import { installDebugHooks } from './DebugHooks';
import { HUD } from '../ui/HUD';
import { StandingsPanel } from '../ui/StandingsPanel';
import { MainMenu } from '../ui/MainMenu';
import type { MenuPanel } from '../ui/MainMenu';
import { ResultsScreen } from '../ui/ResultsScreen';
import { PauseMenu } from '../ui/PauseMenu';
import { LoadingScreen } from '../ui/LoadingScreen';
import { cssHex, el, TextField } from '../ui/dom';
import { showToast } from '../ui/toast';

const MIN_LOADING_SECONDS = 0.6;
/** Give up waiting for async shader compilation after this long and just go. */
const MAX_COMPILE_WAIT_SECONDS = 6;
/** Wall-clock delay between "race complete" and the results phase. */
const RESULTS_DELAY_SECONDS = 1.4;
/** Sim time is clamped per frame; low-fps hosts (SwiftShader) still progress ~4x slower than real time at worst. */
const MAX_SIM_FRAME_DT = 0.25;
const LOW_FPS_SIM_FRAME_DT = 0.5;
const MAX_STEPS_PER_FRAME = Math.ceil(LOW_FPS_SIM_FRAME_DT / FIXED_DT);
const SUN_DISTANCE = 90;
const SHADOW_HALF_EXTENT = 30;
const DEMO_LAPS = 2;
const DEMO_NEXT_DELAY = 3;
const DEMO_MAX_SECONDS = 6 * 60;
const EMPTY_KARTS: readonly IKart[] = [];
const MAX_HUMANS = 4;

const CC_DIFFICULTY: Record<EngineCC, Difficulty> = { 50: 'easy', 100: 'normal', 150: 'hard' };
const CC_SPEED: Record<EngineCC, number> = { 50: 0.8, 100: 0.92, 150: 1.0 };
const DIFFICULTY_CC: Record<Difficulty, EngineCC> = { easy: 50, normal: 100, hard: 150 };

const PHASE_TO_STATE: Record<EnginePhase, GameState> = {
  idle: 'boot',
  demo: 'title',
  soloMenu: 'characterSelect',
  loading: 'loading',
  intro: 'countdown',
  countdown: 'countdown',
  racing: 'racing',
  finished: 'finished',
  paused: 'paused',
  results: 'results',
};

function framingFor(panel: MenuPanel): MenuFraming {
  return panel === 'characterSelect' ? 'characters' : panel === 'trackSelect' ? 'tracks' : 'title';
}

/** Runtime state of one human slot inside a race. */
interface HumanRuntime {
  driver: HumanDriver;
  kartId: number;
  channel: HumanInputChannel;
  input: InputState;
  /** Handed to the AI (phone disconnected). */
  aiOn: boolean;
  /** Autopilot after crossing the line. */
  autopilot: boolean;
  /** Debug autopilot (window.__game.autopilot). */
  debugAuto: boolean;
  ai: IAIDriver | null;
  lastSteer: number;
}

interface Session {
  kind: 'race' | 'demo';
  cfg: PartyRaceConfig | null;
  trackDef: TrackDefinition;
  track: ITrack;
  karts: IKart[];
  /** AI driver per kart id (null for human karts). */
  aiDrivers: (IAIDriver | null)[];
  humans: HumanRuntime[];
  items: IItemManager;
  raceManager: RaceManager;
  viewports: Viewport[];
  panel: StandingsPanel | null;
  panelEl: HTMLElement | null;
  /** Single (non split) camera used for demo + intro. */
  director: DemoDirector | null;
  intro: IntroFlyover | null;
  tips: TipSystem | null;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  fill: THREE.DirectionalLight;
  fog: THREE.FogExp2 | null;
  background: THREE.Color;
  unsubs: (() => void)[];
  itemsUsed: number[];
  /** Wall-clock countdown to the results phase once the race is complete (-1 = not yet). */
  completeTimer: number;
  completed: boolean;
  reportedComplete: boolean;
  finalLapMusic: boolean;
  /** Demo: seconds since start / since completion. */
  demoTime: number;
  demoDoneTimer: number;
  localUsePending: boolean;
}

interface PartialBuild {
  track: ITrack | null;
  karts: IKart[];
  items: IItemManager | null;
}

export class Game implements IGameHost {
  // ------------------------------------------------------------ IGameHost callbacks
  onPhaseChange: ((phase: EnginePhase) => void) | null = null;
  onRaceComplete: ((results: RaceResult[]) => void) | null = null;
  onPauseRequest: (() => void) | null = null;
  onSoloExit: (() => void) | null = null;

  private readonly container: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  /** Menu / demo / intro camera (single full-screen view). */
  private readonly camera: THREE.PerspectiveCamera;
  private readonly uiRoot: HTMLElement;
  private readonly vpLayer: HTMLElement;
  private readonly introCard: HTMLElement;
  private readonly introName: TextField;
  private readonly introSub: TextField;

  private readonly input: InputManager;
  private readonly audio: IAudioEngine;
  private readonly particles: IParticleSystem;
  private readonly postfx: IPostFX;
  private postfxOk = true;
  readonly quality = new QualityScaler();

  private readonly backdrop: MenuBackdrop;
  private readonly mainMenu: MainMenu;
  private readonly results: ResultsScreen;
  private readonly pauseMenu: PauseMenu;
  private readonly loading: LoadingScreen;
  private readonly muteIndicator: HTMLElement;
  private backdropAttached = false;

  private phaseValue: EnginePhase = 'idle';
  private prePausePhase: EnginePhase = 'racing';
  private session: Session | null = null;
  private pendingCfg: PartyRaceConfig | null = null;
  private lastCfg: PartyRaceConfig | null = null;
  private pendingDemo = false;
  private demoTrackIndex = -1;
  private loadingElapsed = 0;
  private loadingFrames = 0;
  private loadingProgress = 0;
  private shadersReady = false;
  private pendingDebug: 'finishAll' | null = null;
  private racesStartedCount = 0;
  private tvMode = false;

  private readonly channels: HumanInputChannel[] = [];
  private readonly slotAIRequest: boolean[] = [false, false, false, false];

  private rafId = 0;
  private lastTime = -1;
  private elapsed = 0;
  private accumulator = 0;
  private currentMusic: MusicTrack = 'none';
  private audioStarted = false;
  private disposed = false;
  private sizeDirty = true;
  private cssW = 1;
  private cssH = 1;
  private pixelRatio = 1;
  private resizeObserver: ResizeObserver | null = null;
  private appliedShadowSize = -1;

  private readonly unsubs: (() => void)[] = [];
  private readonly sunDir = new THREE.Vector3(0.4, 0.8, 0.3);
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpC = new THREE.Vector3();
  private speedFx = 0;
  private boostFx = 0;
  private hitFx = 0;
  private menuInput: InputState = createEmptyInput();

  constructor(container: HTMLElement) {
    this.container = container;

    // ---------------------------------------------------------- renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x0b0b1a, 1);
    this.renderer.domElement.className = 'game-canvas';
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1200);
    this.camera.position.set(0, 3, 8);
    this.scene.add(this.camera);

    this.uiRoot = el('div', '', undefined, container);
    this.uiRoot.id = 'ui';
    this.vpLayer = el('div', 'vp-layer', undefined, this.uiRoot);
    this.introCard = el('div', 'intro-card', undefined, this.uiRoot);
    el('div', 'intro-kicker', 'NEXT RACE', this.introCard);
    this.introName = new TextField(el('div', 'intro-name', '', this.introCard));
    this.introSub = new TextField(el('div', 'intro-sub', '', this.introCard));

    for (let i = 0; i < MAX_HUMANS; i++) this.channels.push(new HumanInputChannel());

    // ---------------------------------------------------------- systems
    this.input = new InputManager();
    this.audio = new AudioEngine();
    this.particles = new ParticleSystem();
    this.scene.add(this.particles.object);
    this.postfx = new PostFX();
    try {
      this.postfx.init(this.renderer, this.scene, this.camera);
    } catch (err) {
      console.error('[Game] PostFX init failed, using plain rendering', err);
      this.postfxOk = false;
    }
    this.quality.onChange = () => this.applyQuality();

    // ---------------------------------------------------------- ui
    this.backdrop = new MenuBackdrop();
    this.mainMenu = new MainMenu(this.uiRoot, CHARACTERS as readonly CharacterDef[], TRACKS as readonly TrackDefinition[]);
    this.mainMenu.onHighlight = (id) => this.backdrop.setCharacter(getCharacter(id));
    this.mainMenu.onPanelChange = (panel) => this.onMenuPanel(panel);
    this.mainMenu.onStart = (settings) =>
      this.startRace({
        trackId: settings.trackId,
        cc: DIFFICULTY_CC[settings.difficulty] ?? 100,
        laps: settings.laps,
        humans: [
          { playerId: 'local', name: 'YOU', characterId: settings.characterId, color: SLOT_COLORS[0], source: 'local' },
        ],
        showTips: false,
        introFlyover: true,
        ui: 'solo',
      });

    this.results = new ResultsScreen(this.uiRoot);
    this.results.onRaceAgain = () => this.restartRace();
    this.results.onChangeTrack = () => this.openSoloMenu('trackSelect');
    this.results.onMainMenu = () => this.exitSolo();

    this.pauseMenu = new PauseMenu(this.uiRoot);
    this.pauseMenu.onResume = () => this.resume();
    this.pauseMenu.onRestart = () => {
      this.leavePause();
      this.restartRace();
    };
    this.pauseMenu.onQuit = () => {
      this.leavePause();
      this.exitSolo();
    };

    this.loading = new LoadingScreen(this.uiRoot);
    this.muteIndicator = el('div', 'mute-indicator', '🔇 MUTED', this.uiRoot);

    // ---------------------------------------------------------- listeners
    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('pointerdown', this.onGesture, { passive: true });
    window.addEventListener('keydown', this.onGesture);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibility);
    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(() => {
        this.sizeDirty = true;
      });
      this.resizeObserver.observe(container);
    }
    this.unsubs.push(
      events.on('item:use', (e) => {
        const s = this.session;
        if (s && e.kartId >= 0 && e.kartId < s.itemsUsed.length) s.itemsUsed[e.kartId]++;
      }),
    );

    this.applyQuality();
    this.updateSize(true);
    installDebugHooks(this);
    this.lastTime = -1;
    this.rafId = requestAnimationFrame(this.loop);
  }

  // =================================================================== IGameHost

  get phase(): EnginePhase {
    return this.phaseValue;
  }

  showDemo(): void {
    if (this.disposed) return;
    this.hideMenus();
    if (this.phaseValue === 'demo' && (this.session?.kind === 'demo' || this.pendingDemo)) return;
    this.disposeSession();
    this.pendingCfg = null;
    this.loading.hide();
    this.pendingDemo = true;
    this.setPhase('demo');
    this.playMusic('menu');
  }

  startRace(cfg: PartyRaceConfig): void {
    if (this.disposed) return;
    const norm = this.normalizeConfig(cfg);
    this.lastCfg = norm;
    this.racesStartedCount++;
    this.hideMenus();
    this.disposeSession();
    this.pendingDemo = false;
    this.safe(() => this.particles.reset());
    for (let i = 0; i < this.slotAIRequest.length; i++) this.slotAIRequest[i] = false;
    for (const ch of this.channels) ch.resetAnalog();
    this.pendingCfg = norm;
    this.loadingElapsed = 0;
    this.loadingFrames = 0;
    this.loadingProgress = 0;
    this.shadersReady = false;
    this.pendingDebug = null;
    this.loading.show(getTrackDef(norm.trackId) as TrackDefinition, norm.laps);
    this.scene.background = new THREE.Color(0x0b0b1a);
    this.scene.fog = null;
    this.setPhase('loading');
  }

  setHumanInput(slot: number, input: HumanInput): void {
    const ch = this.channels[slot | 0];
    if (!ch || !input) return;
    const live = this.phaseValue === 'racing' || this.phaseValue === 'finished';
    ch.receive(input, live);
  }

  setSlotAI(slot: number, ai: boolean): void {
    if (slot < 0 || slot >= MAX_HUMANS) return;
    this.slotAIRequest[slot] = ai;
    const h = this.session?.humans[slot];
    if (h) {
      h.aiOn = ai;
      if (ai) this.ensureHumanAI(h);
      h.channel.clearPending();
    }
  }

  pause(): void {
    const p = this.phaseValue;
    if (p !== 'intro' && p !== 'countdown' && p !== 'racing' && p !== 'finished') return;
    this.prePausePhase = p;
    this.setPhase('paused');
    if (this.session?.cfg?.ui === 'solo') this.pauseMenu.show();
    events.emit('game:pause', {});
  }

  resume(): void {
    if (this.phaseValue !== 'paused') return;
    this.pauseMenu.hide();
    this.accumulator = 0;
    if (this.session) this.session.localUsePending = false;
    for (const ch of this.channels) ch.clearPending();
    this.setPhase(this.prePausePhase);
    events.emit('game:resume', {});
  }

  restartRace(): void {
    const cfg = this.lastCfg;
    if (this.phaseValue === 'paused') this.leavePause();
    if (cfg) this.startRace(cfg);
    else this.showDemo();
  }

  quitRace(): void {
    if (this.phaseValue === 'paused') this.leavePause();
    this.disposeSession();
    this.pendingCfg = null;
    this.loading.hide();
    this.showDemo();
  }

  getSlotStatus(slot: number): SlotStatus | null {
    const s = this.session;
    if (!s || s.kind !== 'race') return null;
    const h = s.humans[slot];
    if (!h) return null;
    const st = s.karts[h.kartId].state;
    const laps = s.raceManager.totalLaps;
    return {
      kartId: h.kartId,
      place: st.place,
      lap: clamp(st.lap, 1, laps),
      laps,
      item: st.item,
      itemCount: st.itemCount,
      roulette: st.itemRouletteActive,
      driftStage: st.driftStage,
      countdown: this.phaseValue === 'countdown' || (this.phaseValue === 'paused' && this.prePausePhase === 'countdown')
        ? s.raceManager.countdownValue
        : 0,
      finished: st.finished,
      aiControlled: this.isAIControlled(h),
      speed: st.speed,
    };
  }

  getResults(): RaceResult[] | null {
    const s = this.session;
    if (!s || s.kind !== 'race') return null;
    const out: RaceResult[] = [];
    const rm = s.raceManager;
    for (const k of s.karts) {
      const st = k.state;
      const h = s.humans[st.id];
      const time = st.finished && !rm.isDnf(st.id) && st.finishTime > 0 ? st.finishTime : -1;
      out.push({
        kartId: st.id,
        place: st.place,
        name: h ? h.driver.name : st.character.name,
        characterId: st.character.id,
        color: h ? h.driver.color : cssHex(st.character.color),
        time,
        slot: h ? st.id : -1,
      });
    }
    out.sort((a, b) => a.place - b.place);
    return out;
  }

  openSoloMenu(panel: MenuPanel = 'characterSelect'): void {
    if (this.disposed) return;
    this.disposeSession();
    this.pendingDemo = false;
    this.pendingCfg = null;
    this.loading.hide();
    this.results.hide();
    this.pauseMenu.hide();
    this.scene.fog = null;
    this.scene.background = null;
    this.backdrop.setCharacter(this.mainMenu.highlightedCharacter);
    this.backdrop.setFraming(framingFor(panel), true);
    if (!this.backdropAttached) {
      this.backdrop.attach(this.scene, this.camera, this.renderer);
      this.backdropAttached = true;
    }
    this.mainMenu.show(panel);
    this.setPhase('soloMenu');
    this.playMusic('menu');
  }

  setTvMode(on: boolean): void {
    this.tvMode = !!on;
    this.uiRoot.classList.toggle('tv', this.tvMode);
  }

  /** Legacy entry point (old main.ts): opens the solo title menu if nothing else is running. */
  start(): void {
    if (this.phaseValue === 'idle' && !this.session) this.openSoloMenu('title');
  }

  // ============================================================ debug accessors

  get racesStarted(): number {
    return this.racesStartedCount;
  }

  /** @internal used by DebugHooks */
  debugSession(): Session | null {
    return this.session;
  }

  /** @internal */
  debugRenderer(): THREE.WebGLRenderer {
    return this.renderer;
  }

  /** @internal */
  debugIsAIControlled(slot: number): boolean {
    const h = this.session?.humans[slot];
    return !!h && this.isAIControlled(h);
  }

  /** @internal */
  debugLastSteer(kartId: number): number {
    const h = this.session?.humans[kartId];
    return h ? h.lastSteer : 0;
  }

  /** @internal Make human `slot` cross the line now. */
  debugFinishPlayer(slot: number): void {
    const s = this.session;
    if (!s || s.kind !== 'race') return;
    if (this.phaseValue === 'intro') this.enterCountdown();
    if (this.phaseValue === 'paused') this.resume();
    const h = s.humans[slot];
    if (!h) return;
    s.raceManager.forceFinish(h.kartId);
  }

  /** @internal Finish every kart -> results. */
  debugFinishAll(): void {
    if (this.phaseValue === 'loading') {
      this.pendingDebug = 'finishAll';
      return;
    }
    const s = this.session;
    if (!s || s.kind !== 'race') return;
    if (this.phaseValue === 'paused') this.resume();
    if (this.phaseValue === 'intro') this.enterCountdown();
    // Humans first (in their current order), then everyone else.
    const humans = [...s.humans].sort((a, b) => s.karts[a.kartId].state.place - s.karts[b.kartId].state.place);
    for (const h of humans) s.raceManager.forceFinish(h.kartId);
    s.raceManager.forceFinishAll();
    s.completeTimer = Math.min(s.completeTimer < 0 ? 0.3 : s.completeTimer, 0.3);
  }

  /** @internal */
  debugAutopilot(on: boolean, slot: number): void {
    const h = this.session?.humans[slot];
    if (!h) return;
    h.debugAuto = on;
    if (on) this.ensureHumanAI(h);
  }

  /** @internal */
  debugGiveItem(slot: number, item: ItemType): void {
    const s = this.session;
    if (!s) return;
    const kart = s.karts[slot];
    if (!kart) return;
    const st = kart.state;
    st.itemRouletteActive = false;
    st.item = item;
    st.itemCount = item === 'none' ? 0 : item.startsWith('triple_') || item === 'golden_mushroom' ? 3 : 1;
  }

  /** @internal */
  debugViewportCount(): number {
    const s = this.session;
    if (!s) return 0;
    if (s.kind === 'demo' || this.phaseValue === 'intro' || this.phaseValue === 'loading') return 1;
    return s.viewports.length;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('pointerdown', this.onGesture);
    window.removeEventListener('keydown', this.onGesture);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.resizeObserver?.disconnect();
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.disposeSession();
    if (this.backdropAttached) this.backdrop.detach(this.scene);
    this.backdrop.dispose();
    this.mainMenu.dispose();
    this.results.dispose();
    this.pauseMenu.dispose();
    this.loading.dispose();
    this.muteIndicator.remove();
    this.input.dispose();
    this.safe(() => this.audio.dispose());
    this.safe(() => this.particles.dispose());
    this.safe(() => this.postfx.dispose());
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.uiRoot.remove();
  }

  // ================================================================== main loop

  private readonly loop = (now: number): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.loop);
    if (this.lastTime < 0) this.lastTime = now;
    let raw = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (!(raw >= 0)) raw = 0;
    // Headless / software-GL hosts (a few fps) get a larger cap so races still progress.
    const dt = Math.min(raw, this.quality.fps < 8 ? LOW_FPS_SIM_FRAME_DT : MAX_SIM_FRAME_DT);
    this.elapsed += dt;

    const p = this.phaseValue;
    const measuring = p === 'demo' || p === 'countdown' || p === 'racing' || p === 'finished' || p === 'results';
    this.quality.update(raw, measuring && !document.hidden);

    this.menuInput = this.input.update();
    try {
      if (this.sizeDirty) this.updateSize(false);
      this.frame(dt, Math.min(raw, 1), this.menuInput);
    } catch (err) {
      console.error('[Game] frame error', err);
      events.emit('ui:error', {});
    }
  };

  private frame(dt: number, wallDt: number, input: InputState): void {
    switch (this.phaseValue) {
      case 'idle':
        this.renderer.setScissorTest(false);
        this.renderer.setViewport(0, 0, this.cssW, this.cssH);
        this.renderer.clear();
        return;
      case 'soloMenu':
        this.mainMenu.handleInput(input);
        if (this.phaseValue !== 'soloMenu') return;
        this.backdrop.update(dt, this.camera);
        this.particles.update(dt, EMPTY_KARTS, this.camera);
        this.audio.update(dt, EMPTY_KARTS, -1, this.camera);
        this.renderSingle(dt, this.camera, null);
        return;
      case 'demo':
        this.frameDemo(dt, wallDt);
        return;
      case 'loading':
        this.frameLoading(dt);
        return;
      case 'intro':
      case 'countdown':
      case 'racing':
      case 'finished': {
        if (input.pause) {
          if (this.session?.cfg?.ui === 'party') {
            this.onPauseRequest?.();
          } else {
            this.pause();
          }
          if ((this.phaseValue as EnginePhase) === 'paused') {
            this.renderSession(0);
            return;
          }
        }
        this.simulate(dt, input);
        this.updateRaceFlow(dt, wallDt);
        this.renderSession(dt);
        return;
      }
      case 'paused':
        if (this.session?.cfg?.ui === 'solo') {
          this.pauseMenu.handleInput(input);
          if (input.pause && this.phaseValue === 'paused') this.resume();
        } else if (input.pause) {
          // Party mode: the party layer decides (it owns the pause overlay / votes).
          this.onPauseRequest?.();
        }
        for (const vp of this.session?.viewports ?? []) vp.hud?.tickTimed(0);
        this.renderSession(0);
        return;
      case 'results':
        if (this.session?.cfg?.ui === 'solo') this.results.handleInput(input);
        if (this.phaseValue !== 'results') return;
        this.simulate(dt, input);
        this.renderSession(dt);
        return;
    }
  }

  // ------------------------------------------------------------------ demo

  private frameDemo(dt: number, wallDt: number): void {
    if (this.pendingDemo) {
      this.pendingDemo = false;
      try {
        this.buildDemo();
      } catch (err) {
        console.error('[Game] failed to build demo race', err);
        this.disposeSession();
      }
      return;
    }
    const s = this.session;
    if (!s) {
      this.renderer.setScissorTest(false);
      this.renderer.clear();
      return;
    }
    this.simulate(dt, this.menuInput);
    s.demoTime += dt;
    if (s.raceManager.allFinished || s.demoTime > DEMO_MAX_SECONDS) {
      s.demoDoneTimer += wallDt;
      if (s.demoDoneTimer >= DEMO_NEXT_DELAY) {
        // Next demo on the next track.
        this.disposeSession();
        this.pendingDemo = true;
        return;
      }
    }
    this.renderSession(dt);
  }

  private buildDemo(): void {
    const n = TRACKS.length;
    if (n === 0) return;
    if (this.demoTrackIndex < 0) this.demoTrackIndex = Math.floor(Math.random() * n);
    else this.demoTrackIndex = (this.demoTrackIndex + 1) % n;
    const def = TRACKS[this.demoTrackIndex] as TrackDefinition;
    const cfg: PartyRaceConfig = {
      trackId: def.id,
      cc: 100,
      laps: DEMO_LAPS,
      humans: [],
      showTips: false,
      introFlyover: false,
      ui: 'party',
    };
    this.quality.pickInitial(1, this.cssW, this.cssH, window.devicePixelRatio || 1, 2);
    const s = this.buildSession(cfg, 'demo');
    s.raceManager.startImmediately();
    s.director = new DemoDirector(this.camera, s.track);
    s.director.start(s.karts);
    // Settle the camera before the first frame.
    s.director.update(0, s.karts);
    this.warmShaders(this.camera);
  }

  // --------------------------------------------------------------- loading

  private frameLoading(dt: number): void {
    this.loading.update(dt);
    this.loadingElapsed += dt;
    this.loadingFrames++;
    // Give the loading screen a frame to paint before the synchronous build.
    if (!this.session && this.loadingFrames >= 2 && this.pendingCfg) {
      const cfg = this.pendingCfg;
      try {
        this.buildRace(cfg);
      } catch (err) {
        console.error('[Game] failed to build race', err);
        showToast('Could not build the race. Check the console for details.', 'error');
        this.pendingCfg = null;
        this.loading.hide();
        this.disposeSession();
        this.showDemo();
        return;
      }
      const built = this.session as Session | null;
      const vp0 = built ? built.viewports[0] : undefined;
      this.warmShaders(vp0 ? vp0.camera : this.camera);
    }

    const s = this.session;
    const ready = s !== null && (this.shadersReady || this.loadingElapsed > MAX_COMPILE_WAIT_SECONDS);
    const target = !s ? 0.12 : ready ? 1 : 0.9;
    this.loadingProgress = damp(this.loadingProgress, target, ready ? 14 : 1.4, dt);
    this.loading.setProgress(this.loadingProgress);

    if (s && ready) {
      // Warm the remaining passes (shadow depth, post-processing) behind the overlay.
      this.renderSession(dt);
      const debugRush = this.pendingDebug !== null;
      if (debugRush || (this.loadingElapsed >= MIN_LOADING_SECONDS && this.loadingProgress > 0.985)) {
        this.pendingCfg = null;
        this.loading.hide();
        if (s.cfg?.introFlyover !== false && !debugRush) this.enterIntro();
        else this.enterCountdown();
        if (this.pendingDebug === 'finishAll') {
          this.pendingDebug = null;
          this.debugFinishAll();
        }
      }
    }
  }

  /** Kick off parallel shader compilation for the freshly built scene. */
  private warmShaders(camera: THREE.Camera): void {
    const s = this.session;
    this.shadersReady = false;
    if (!s) return;
    const renderer = this.renderer as { compileAsync?: (sc: THREE.Object3D, c: THREE.Camera) => Promise<unknown> };
    if (typeof renderer.compileAsync !== 'function') {
      this.shadersReady = true;
      return;
    }
    let promise: Promise<unknown>;
    try {
      promise = renderer.compileAsync.call(this.renderer, this.scene, camera);
    } catch (err) {
      console.warn('[Game] compileAsync threw; falling back to synchronous compile', err);
      this.shadersReady = true;
      return;
    }
    const done = (): void => {
      if (this.session === s) this.shadersReady = true;
    };
    promise.then(done, (err: unknown) => {
      console.warn('[Game] compileAsync failed; falling back to synchronous compile', err);
      done();
    });
  }

  // ------------------------------------------------------------ simulation

  private simulate(dt: number, input: InputState): void {
    const s = this.session;
    if (!s) return;
    if (input.useItem) s.localUsePending = true;
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      this.step(FIXED_DT, s, input);
      this.accumulator -= FIXED_DT;
      steps++;
      if (this.session !== s) return;
    }
    if (steps >= MAX_STEPS_PER_FRAME) this.accumulator = 0;
    if (s.tips) s.tips.update(dt, s.karts);
  }

  private step(dt: number, s: Session, local: InputState): void {
    const { track, karts, items } = s;
    const live = this.phaseValue === 'racing' || this.phaseValue === 'finished' || this.phaseValue === 'results';
    const rubber = this.rubberBandTarget(s);

    // Humans: phone / local input, or AI (handover, autopilot after finish).
    for (let i = 0; i < s.humans.length; i++) {
      const h = s.humans[i];
      const kart = karts[h.kartId];
      if (this.isAIControlled(h)) {
        const ai = this.ensureHumanAI(h);
        h.channel.clearPending();
        if (ai) ai.update(dt, track, karts, items, rubber);
        continue;
      }
      if (h.driver.source === 'local') {
        const p = h.input;
        p.throttle = local.throttle;
        p.brake = local.brake;
        p.steer = local.steer;
        p.drift = local.drift;
        p.useItem = s.localUsePending && live;
        p.useItemHeld = local.useItemHeld;
        p.lookBack = local.lookBack;
        p.pause = p.confirm = p.back = false;
        p.menuUp = p.menuDown = p.menuLeft = p.menuRight = false;
        s.localUsePending = false;
        kart.setInput(p);
      } else {
        const st = kart.state;
        const hasItem = st.item !== 'none' || st.itemRouletteActive;
        const canUse = st.item !== 'none' && !st.itemRouletteActive && !st.isSpinning && !st.isFrozen;
        h.channel.writeTo(h.input, live && h.channel.takeUse(dt, hasItem, canUse));
        kart.setInput(h.input);
      }
      h.lastSteer = h.input.steer;
    }

    for (let i = 0; i < s.aiDrivers.length; i++) {
      const ai = s.aiDrivers[i];
      if (ai) ai.update(dt, track, karts, items, rubber);
    }

    for (let i = 0; i < karts.length; i++) karts[i].update(dt, track, karts);

    for (let i = 0; i < karts.length; i++) {
      const k = karts[i];
      const inp = k.input;
      if (inp.useItem && !k.state.itemRouletteActive && k.state.item !== 'none') {
        items.requestUse(k, inp.brake > 0.5 || inp.lookBack);
      }
    }

    items.update(dt);
    s.raceManager.update(dt);
  }

  /** AI rubber-band against the best-placed human still racing (null in the demo). */
  private rubberBandTarget(s: Session): IKart | null {
    let best: IKart | null = null;
    for (const h of s.humans) {
      const k = s.karts[h.kartId];
      if (k.state.finished) continue;
      if (!best || k.state.place < best.state.place) best = k;
    }
    return best;
  }

  private isAIControlled(h: HumanRuntime): boolean {
    return h.aiOn || h.autopilot || h.debugAuto;
  }

  private ensureHumanAI(h: HumanRuntime): IAIDriver | null {
    if (h.ai) return h.ai;
    const s = this.session;
    if (!s) return null;
    try {
      h.ai = new AIDriver(s.karts[h.kartId], 'normal', 100 + h.kartId);
    } catch (err) {
      console.warn('[Game] could not create AI driver for human kart', err);
      h.ai = null;
    }
    return h.ai;
  }

  private updateRaceFlow(dt: number, wallDt: number): void {
    const s = this.session;
    if (!s) return;
    if (this.phaseValue === 'intro' && s.intro) {
      s.intro.update(dt, this.camera);
      if (s.intro.done) this.enterCountdown();
    }
    if (s.completed && !s.reportedComplete) {
      s.completeTimer -= wallDt;
      if (s.completeTimer <= 0) this.enterResults();
    }
  }

  // ------------------------------------------------------------- rendering

  /** Render the current session (demo / intro = single view, race = split views). */
  private renderSession(dt: number): void {
    const s = this.session;
    if (!s) {
      this.renderer.setScissorTest(false);
      this.renderer.clear();
      return;
    }
    for (let i = 0; i < s.karts.length; i++) s.karts[i].updateVisuals(dt);
    s.track.update(dt, this.elapsed);

    const single = s.kind === 'demo' || this.phaseValue === 'intro' || this.phaseValue === 'loading';
    if (single) {
      let focus: IKart | null = s.karts[0] ?? null;
      if (s.director) {
        if (dt > 0) s.director.update(dt, s.karts);
        focus = s.karts[s.director.focusId] ?? focus;
      } else if (s.intro) {
        focus = null;
      }
      this.particles.update(dt, s.karts, this.camera);
      this.audio.update(dt, s.karts, s.humans.length > 0 ? 0 : -1, this.camera);
      this.positionSun(s, focus, this.camera);
      this.renderSingle(dt, this.camera, null);
      return;
    }

    // Race views.
    const views = s.viewports;
    const totalLaps = s.raceManager.totalLaps;
    const raceTime = s.raceManager.raceTime;
    for (const vp of views) {
      const h = s.humans[vp.index];
      const kart = s.karts[vp.kartId];
      const lookBack = !!h && !this.isAIControlled(h) && this.phaseValue === 'racing' && kart.input.lookBack;
      if (dt > 0) vp.follow.update(dt, kart, lookBack);
      vp.hud?.update(dt, kart, s.karts, raceTime, totalLaps, !!h && this.isAIControlled(h));
    }
    if (s.panel) s.panel.update(dt, s.karts, totalLaps);
    const cam0 = views[0]?.camera ?? this.camera;
    this.particles.update(dt, s.karts, cam0);
    this.audio.update(dt, s.karts, views[0]?.kartId ?? -1, cam0);

    if (views.length === 1) {
      const kart = s.karts[views[0].kartId];
      this.positionSun(s, kart, cam0);
      this.updatePostFxFeel(dt, kart);
      this.renderSingle(dt, cam0, kart);
      return;
    }

    // Split screen: one renderer, scissored viewports, plain rendering (no PostFX).
    const r = this.renderer;
    r.setScissorTest(false);
    r.setViewport(0, 0, this.cssW, this.cssH);
    r.clear();
    r.setScissorTest(true);
    for (const vp of views) {
      const rect = this.pixelRect(vp.rect);
      r.setViewport(rect.x, rect.y, rect.w, rect.h);
      r.setScissor(rect.x, rect.y, rect.w, rect.h);
      this.positionSun(s, s.karts[vp.kartId], vp.camera);
      r.render(this.scene, vp.camera);
    }
    r.setScissorTest(false);
    r.setViewport(0, 0, this.cssW, this.cssH);
  }

  private renderSingle(dt: number, camera: THREE.Camera, focus: IKart | null): void {
    const r = this.renderer;
    r.setScissorTest(false);
    r.setViewport(0, 0, this.cssW, this.cssH);
    if (this.postfxOk && this.quality.settings.postfx) {
      try {
        this.postfx.setCamera(camera);
        this.postfx.render(dt);
        return;
      } catch (err) {
        console.error('[Game] PostFX render failed; falling back to plain rendering', err);
        this.postfxOk = false;
        this.safe(() => this.postfx.setEnabled(false));
      }
    }
    void focus;
    r.render(this.scene, camera);
  }

  /** Normalised top-left rect -> GL viewport rect in CSS pixels (bottom-left origin). */
  private pixelRect(n: NormRect): { x: number; y: number; w: number; h: number } {
    const W = this.cssW;
    const H = this.cssH;
    const x = Math.round(n.x * W);
    const w = Math.round((n.x + n.w) * W) - x;
    const top = Math.round(n.y * H);
    const bottom = Math.round((n.y + n.h) * H);
    return { x, y: H - bottom, w, h: bottom - top };
  }

  private positionSun(s: Session, focus: IKart | null, camera: THREE.Camera): void {
    const p = focus ? focus.state.position : this.tmpB.copy(camera.position);
    // Snap the shadow frustum to a coarse grid to avoid edge shimmer while driving.
    const snap = 2;
    this.tmpA.set(Math.round(p.x / snap) * snap, Math.round(p.y / snap) * snap, Math.round(p.z / snap) * snap);
    s.sun.target.position.copy(this.tmpA);
    s.sun.position.copy(this.tmpA).addScaledVector(this.sunDir, SUN_DISTANCE);
    s.sun.updateMatrixWorld();
    s.sun.target.updateMatrixWorld();
    if (s.fill.visible) {
      s.fill.position.copy(camera.position);
      s.fill.position.y += 2;
      s.fill.target.position.copy(p);
      s.fill.updateMatrixWorld();
      s.fill.target.updateMatrixWorld();
    }
  }

  private updatePostFxFeel(dt: number, kart: IKart): void {
    if (!this.postfxOk) return;
    const st = kart.state;
    const top = Math.max(1, kart.topSpeed());
    const speedTarget = clamp01((Math.abs(st.speed) - top * 0.55) / (top * 0.9));
    const boostTarget = st.isBoosting ? clamp01(0.45 + st.boostStrength) : st.isInvincible ? 0.35 : 0;
    this.speedFx = damp(this.speedFx, speedTarget, 5, dt);
    this.boostFx = damp(this.boostFx, boostTarget, st.isBoosting ? 12 : 4, dt);
    if (this.hitFx > 0) {
      this.hitFx = damp(this.hitFx, 0, 3, dt);
      if (this.hitFx < 0.005) this.hitFx = 0;
    }
    this.postfx.setSpeedEffect(this.speedFx);
    this.postfx.setBoostEffect(this.boostFx);
    this.postfx.setHitEffect(this.hitFx);
  }

  // ----------------------------------------------------------------- quality

  private applyQuality(): void {
    const tier = this.quality.tier;
    const set = TIERS[tier];
    const ps = this.particles as IParticleSystem & { setQuality?: (t: 0 | 1 | 2 | 3) => void };
    if (typeof ps.setQuality === 'function') this.safe(() => ps.setQuality!(set.particles));
    this.applyShadowQuality();
    this.sizeDirty = true;
  }

  private applyShadowQuality(): void {
    const s = this.session;
    const size = TIERS[this.quality.tier].shadowMapSize;
    if (!s) {
      this.appliedShadowSize = -1;
      return;
    }
    // Decoration density follows the quality tier (cheap to re-apply).
    const tier = this.quality.tier;
    this.safe(() => s.track.setDetail?.(tier));
    if (size === this.appliedShadowSize) return;
    this.appliedShadowSize = size;
    const sun = s.sun;
    sun.castShadow = size > 0;
    if (size > 0 && sun.shadow.mapSize.x !== size) {
      if (sun.shadow.map) {
        sun.shadow.map.dispose();
        (sun.shadow as { map: THREE.WebGLRenderTarget | null }).map = null;
      }
      sun.shadow.mapSize.set(size, size);
    }
  }

  private updateSize(force: boolean): void {
    this.sizeDirty = false;
    const w = Math.max(1, this.container.clientWidth || window.innerWidth);
    const h = Math.max(1, this.container.clientHeight || window.innerHeight);
    const pr = this.quality.pixelRatioFor(w, h, window.devicePixelRatio || 1);
    const changed = force || w !== this.cssW || h !== this.cssH || Math.abs(pr - this.pixelRatio) > 1e-3;
    this.cssW = w;
    this.cssH = h;
    if (changed) {
      this.pixelRatio = pr;
      this.renderer.setPixelRatio(pr);
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      if (this.postfxOk) {
        try {
          this.postfx.setSize(w, h, pr);
        } catch (err) {
          console.error('[Game] PostFX resize failed', err);
          this.postfxOk = false;
        }
      }
    }
    this.layoutViewports();
  }

  private layoutViewports(): void {
    const s = this.session;
    if (!s || s.viewports.length === 0) return;
    const layout = computeLayout(s.viewports.length, this.cssW, this.cssH);
    s.viewports.forEach((vp, i) => vp.setRect(layout.views[i] ?? layout.views[0], this.cssW, this.cssH));
    if (s.panelEl && layout.panel) applyRectToElement(s.panelEl, layout.panel);
  }

  // ------------------------------------------------------------- race build

  private normalizeConfig(cfg: PartyRaceConfig): PartyRaceConfig {
    let trackId = cfg.trackId;
    try {
      trackId = (getTrackDef(trackId) as TrackDefinition).id;
    } catch {
      trackId = (TRACKS[0] as TrackDefinition).id;
    }
    if (!TRACKS.some((t) => t.id === trackId)) trackId = (TRACKS[0] as TrackDefinition).id;
    const cc: EngineCC = cfg.cc === 50 || cfg.cc === 100 || cfg.cc === 150 ? cfg.cc : 150;
    const laps = clamp(Math.floor(Number(cfg.laps) || 3), 1, 9);
    let humans = Array.isArray(cfg.humans) ? cfg.humans.slice(0, MAX_HUMANS) : [];
    if (humans.length === 0) {
      humans = [{ playerId: 'local', name: 'YOU', characterId: CHARACTERS[0].id, color: SLOT_COLORS[0], source: 'local' }];
    }
    humans = humans.map((h, i) => ({
      playerId: String(h.playerId ?? `p${i}`),
      name: String(h.name ?? `P${i + 1}`).slice(0, 16) || `P${i + 1}`,
      characterId: String(h.characterId ?? CHARACTERS[i % CHARACTERS.length].id),
      color: String(h.color || SLOT_COLORS[i % SLOT_COLORS.length]),
      source: h.source === 'local' ? 'local' : 'phone',
    }));
    return {
      trackId,
      cc,
      laps,
      humans,
      showTips: !!cfg.showTips,
      introFlyover: cfg.introFlyover !== false,
      ui: cfg.ui === 'solo' ? 'solo' : 'party',
    };
  }

  private buildRace(cfg: PartyRaceConfig): void {
    const n = cfg.humans.length;
    this.quality.pickInitial(n, this.cssW, this.cssH, window.devicePixelRatio || 1, 3);
    const s = this.buildSession(cfg, 'race');

    // Viewports + HUDs.
    const humanColors = new Map<number, string>();
    const names = new Map<number, string>();
    s.humans.forEach((h) => {
      humanColors.set(h.kartId, h.driver.color);
      names.set(h.kartId, h.driver.name);
    });
    const party = cfg.ui === 'party';
    for (let i = 0; i < n; i++) {
      const vp = new Viewport(i, i, this.vpLayer);
      vp.follow.setTrack(s.track);
      vp.element.style.setProperty('--slot', s.humans[i].driver.color);
      const hud = new HUD(vp.element, buildItemIcon, {
        kartId: i,
        compact: n > 1,
        name: party ? s.humans[i].driver.name : undefined,
        color: s.humans[i].driver.color,
        minimap: n !== 3,
        humanColors,
      });
      hud.setTrack(s.track);
      vp.hud = hud;
      s.viewports.push(vp);
    }
    if (n === 3) {
      s.panelEl = el('div', 'vp vp-panel', undefined, this.vpLayer);
      s.panel = new StandingsPanel(s.panelEl, names, humanColors, s.karts.length);
      s.panel.setTrack(s.track);
      s.panelEl.classList.add('hidden');
    }
    this.layoutViewports();
    for (const vp of s.viewports) vp.follow.snapTo(s.karts[vp.kartId]);

    // Slot AI requests made after startRace() but before the build.
    s.humans.forEach((h, i) => {
      if (this.slotAIRequest[i]) {
        h.aiOn = true;
        this.ensureHumanAI(h);
      }
    });

    s.raceManager.onStartResult = (kartId: number, result: StartResult) => {
      const vp = s.viewports.find((v) => v.kartId === kartId);
      vp?.hud?.showStartResult(result);
    };

    if (cfg.showTips) {
      const huds = s.viewports.map((v) => v.hud).filter((h): h is HUD => h !== null);
      s.tips = new TipSystem(s.track, huds);
    }

    // Initial camera for the intro / loading frames.
    if (cfg.introFlyover !== false) {
      s.intro = new IntroFlyover(s.track);
      s.intro.update(0, this.camera);
    } else {
      const k0 = s.karts[0];
      this.camera.position.copy(k0.state.position).add(this.tmpA.set(0, 8, 12));
      this.camera.lookAt(k0.state.position);
    }

    s.unsubs.push(
      events.on('race:start', () => {
        if (this.session !== s) return;
        if (this.phaseValue === 'countdown') this.setPhase('racing');
        else if (this.phaseValue === 'paused' && this.prePausePhase === 'countdown') this.prePausePhase = 'racing';
        if (s.tips) s.tips.active = true;
      }),
      events.on('race:lap', (e) => {
        if (this.session !== s || !s.humans[e.kartId]) return;
        if (e.isFinalLap && !s.finalLapMusic) {
          s.finalLapMusic = true;
          this.playMusic('finalLap');
        }
      }),
      events.on('race:finish', (e) => {
        if (this.session !== s) return;
        const h = s.humans[e.kartId];
        if (!h) return;
        h.autopilot = true;
        this.ensureHumanAI(h);
        if (this.postfxOk && s.viewports.length === 1) this.safe(() => this.postfx.flash(0xffffff, 0.35));
        if (this.phaseValue === 'racing' || this.phaseValue === 'countdown') this.setPhase('finished');
        else if (this.phaseValue === 'paused' && (this.prePausePhase === 'racing' || this.prePausePhase === 'countdown')) {
          this.prePausePhase = 'finished';
        }
      }),
      events.on('race:allFinished', () => {
        if (this.session !== s || s.completed) return;
        s.completed = true;
        s.completeTimer = RESULTS_DELAY_SECONDS;
      }),
      events.on('item:hit', (e) => {
        if (this.session !== s || e.kartId !== s.viewports[0]?.kartId) return;
        this.hitFx = 1;
      }),
      events.on('item:lightning', () => {
        if (this.session !== s || !this.postfxOk || s.viewports.length !== 1) return;
        this.safe(() => this.postfx.flash(0xffffff, 0.3));
      }),
    );
  }

  /** Track + karts + AI + items + race manager + lights (shared by races and the demo). */
  private buildSession(cfg: PartyRaceConfig, kind: 'race' | 'demo'): Session {
    const partial: PartialBuild = { track: null, karts: [], items: null };
    try {
      return this.buildSessionInner(cfg, kind, partial);
    } catch (err) {
      const { items, karts, track } = partial;
      if (items) this.safe(() => items.dispose());
      for (const k of karts) this.safe(() => k.dispose());
      if (track) this.safe(() => track.dispose());
      throw err;
    }
  }

  private buildSessionInner(cfg: PartyRaceConfig, kind: 'race' | 'demo', partial: PartialBuild): Session {
    const trackDef = getTrackDef(cfg.trackId) as TrackDefinition;
    const track: ITrack = new Track(trackDef);
    partial.track = track;
    const env = trackDef.environment;
    const karts = partial.karts;
    const humansCfg = kind === 'race' ? cfg.humans : [];

    // Characters: humans keep their pick, AI take the unused ones (shuffled).
    const all = CHARACTERS as readonly CharacterDef[];
    const pick = (id: string): CharacterDef => {
      try {
        return (getCharacter(id) as CharacterDef) ?? all[0];
      } catch {
        return all[0];
      }
    };
    const used = new Set<string>();
    const humanChars = humansCfg.map((h) => {
      const c = pick(h.characterId);
      used.add(c.id);
      return c;
    });
    const others = all.filter((c) => !used.has(c.id));
    for (let i = others.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = others[i];
      others[i] = others[j];
      others[j] = t;
    }
    const pool = others.length > 0 ? others : [...all];
    for (let id = 0; id < KART_COUNT; id++) {
      if (id < humansCfg.length) karts.push(new Kart(id, humanChars[id], true));
      else karts.push(new Kart(id, pool[(id - humansCfg.length) % pool.length], false));
    }

    const difficulty: Difficulty = CC_DIFFICULTY[cfg.cc] ?? 'normal';
    const speed = CC_SPEED[cfg.cc] ?? 1;
    for (const k of karts) {
      const ks = k as IKart & { setSpeedScale?: (v: number) => void };
      if (typeof ks.setSpeedScale === 'function') this.safe(() => ks.setSpeedScale!(speed));
    }

    const aiDrivers: (IAIDriver | null)[] = [];
    for (let id = 0; id < karts.length; id++) {
      aiDrivers.push(id < humansCfg.length ? null : new AIDriver(karts[id], difficulty, id));
    }

    const items: IItemManager = new ItemManager(this.particles);
    partial.items = items;
    items.init(track, karts);

    const raceManager = new RaceManager(track, karts, {
      characterId: karts[0].state.character.id,
      trackId: trackDef.id,
      difficulty,
      laps: cfg.laps,
    });

    // Lights from the track environment.
    const sun = new THREE.DirectionalLight(env.sunColor, env.sunIntensity);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -SHADOW_HALF_EXTENT;
    sc.right = SHADOW_HALF_EXTENT;
    sc.top = SHADOW_HALF_EXTENT;
    sc.bottom = -SHADOW_HALF_EXTENT;
    sc.near = 1;
    sc.far = SUN_DISTANCE + SHADOW_HALF_EXTENT * 3;
    sc.updateProjectionMatrix();
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.03;
    this.sunDir.set(env.sunDirection.x, env.sunDirection.y, env.sunDirection.z);
    if (this.sunDir.lengthSq() < 1e-6) this.sunDir.set(0.4, 0.8, 0.3);
    if (this.sunDir.y < 0) this.sunDir.y = -this.sunDir.y;
    if (this.sunDir.y < 0.15) this.sunDir.y = 0.15;
    this.sunDir.normalize();
    const hemi = new THREE.HemisphereLight(env.ambientSky, env.ambientGround, env.ambientIntensity);
    // Camera-following fill: strong on dim night tracks, zero on sunny ones.
    const darkness = clamp(0.9 - env.ambientIntensity, 0, 0.6) + clamp((1.6 - env.sunIntensity) * 0.3, 0, 0.3);
    const fill = new THREE.DirectionalLight(0xd9e4ff, darkness);
    fill.castShadow = false;
    fill.visible = darkness > 0.01;
    const fog = env.fogDensity > 0 ? new THREE.FogExp2(env.fogColor, env.fogDensity) : null;
    const background = new THREE.Color(env.skyHorizon);

    this.scene.add(track.object);
    for (const k of karts) this.scene.add(k.object);
    this.scene.add(items.object);
    this.scene.add(sun, sun.target, hemi, fill, fill.target);
    this.scene.fog = fog;
    this.scene.background = background;

    const humans: HumanRuntime[] = humansCfg.map((driver, i) => ({
      driver,
      kartId: i,
      channel: this.channels[i],
      input: createEmptyInput(),
      aiOn: false,
      autopilot: false,
      debugAuto: false,
      ai: null,
      lastSteer: 0,
    }));

    const s: Session = {
      kind,
      cfg,
      trackDef,
      track,
      karts,
      aiDrivers,
      humans,
      items,
      raceManager,
      viewports: [],
      panel: null,
      panelEl: null,
      director: null,
      intro: null,
      tips: null,
      sun,
      hemi,
      fill,
      fog,
      background,
      unsubs: [],
      itemsUsed: new Array<number>(karts.length).fill(0),
      completeTimer: -1,
      completed: false,
      reportedComplete: false,
      finalLapMusic: false,
      demoTime: 0,
      demoDoneTimer: 0,
      localUsePending: false,
    };
    this.session = s;
    this.accumulator = 0;
    this.speedFx = 0;
    this.boostFx = 0;
    this.hitFx = 0;
    this.appliedShadowSize = -1;
    this.applyShadowQuality();
    this.sizeDirty = true;

    // Sync visuals once so the first rendered frame is sane.
    for (const k of karts) k.updateVisuals(0);
    this.positionSun(s, karts[0], this.camera);
    return s;
  }

  // -------------------------------------------------------------- race flow

  private enterIntro(): void {
    const s = this.session;
    if (!s) return;
    if (!s.intro) s.intro = new IntroFlyover(s.track);
    const cfg = s.cfg!;
    this.introName.set(s.trackDef.name.toUpperCase());
    this.introSub.set(`${cfg.cc}cc  ·  ${cfg.laps} LAP${cfg.laps > 1 ? 'S' : ''}`);
    this.introCard.classList.remove('show');
    void this.introCard.offsetWidth;
    this.introCard.classList.add('show');
    this.setPhase('intro');
    this.playMusic('race');
  }

  private enterCountdown(): void {
    const s = this.session;
    if (!s) return;
    this.introCard.classList.remove('show');
    for (const vp of s.viewports) vp.hud?.show();
    s.panelEl?.classList.remove('hidden');

    // Each viewport swoops from the intro's final pose (or a wide grid shot) into its chase cam.
    let from: THREE.Vector3;
    let look: THREE.Vector3;
    let fromFov = 46;
    if (s.intro) {
      from = s.intro.position.clone();
      look = s.intro.look.clone();
      fromFov = this.camera.fov;
    } else {
      const grid = s.track.startGrid;
      const center = this.tmpA.set(0, 0, 0);
      const n = Math.min(grid.length, KART_COUNT);
      if (n > 0) {
        for (let i = 0; i < n; i++) center.add(grid[i].position);
        center.multiplyScalar(1 / n);
      } else {
        center.copy(s.karts[0].state.position);
      }
      const forward = this.tmpB;
      s.karts[0].forwardDir(forward);
      if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
      forward.y = 0;
      forward.normalize();
      const right = this.tmpC.set(-forward.z, 0, forward.x);
      from = center.clone().addScaledVector(forward, 18).addScaledVector(right, 11);
      from.y += 6.5;
      look = center.clone();
      look.y += 0.8;
    }
    for (const vp of s.viewports) {
      vp.follow.snapTo(s.karts[vp.kartId]);
      vp.follow.setCinematic(from, look, 3 * COUNTDOWN_STEP_SECONDS, fromFov);
    }
    s.intro = null;
    s.raceManager.startCountdown();
    this.setPhase('countdown');
    if (this.currentMusic !== 'race') this.playMusic('race');
  }

  private enterResults(): void {
    const s = this.session;
    if (!s || s.reportedComplete) return;
    s.reportedComplete = true;
    for (const vp of s.viewports) vp.hud?.hide();
    s.panelEl?.classList.add('hidden');
    if (s.tips) s.tips.active = false;
    this.setPhase('results');
    this.playMusic('results');
    if (s.cfg?.ui === 'solo') {
      const standings: RaceStanding[] = s.raceManager.getStandings().map((st) => ({
        ...st,
        finishTime: s.raceManager.isDnf(st.kartId) ? -1 : st.finishTime,
      }));
      this.results.show(standings);
    }
    const results = this.getResults();
    if (results) {
      try {
        this.onRaceComplete?.(results);
      } catch (err) {
        console.error('[Game] onRaceComplete threw', err);
      }
    }
  }

  /** Leave the paused state without returning to the race (restart / quit). */
  private leavePause(): void {
    this.pauseMenu.hide();
    if (this.phaseValue === 'paused') events.emit('game:resume', {});
  }

  private exitSolo(): void {
    this.hideMenus();
    this.showDemo();
    if (this.onSoloExit) {
      try {
        this.onSoloExit();
      } catch (err) {
        console.error('[Game] onSoloExit threw', err);
      }
    }
  }

  private onMenuPanel(panel: MenuPanel): void {
    if (this.phaseValue !== 'soloMenu') return;
    if (panel === 'title' && this.onSoloExit) {
      // Backing out of character select returns to the party title screen.
      this.exitSolo();
      return;
    }
    this.backdrop.setFraming(framingFor(panel));
  }

  private hideMenus(): void {
    this.mainMenu.hide();
    this.results.hide();
    this.pauseMenu.hide();
    this.introCard.classList.remove('show');
    if (this.backdropAttached) {
      this.backdrop.detach(this.scene);
      this.backdropAttached = false;
    }
  }

  private setPhase(next: EnginePhase): void {
    if (next === this.phaseValue) return;
    const prev = this.phaseValue;
    this.phaseValue = next;
    this.uiRoot.dataset.phase = next;
    const from = PHASE_TO_STATE[prev];
    const to = PHASE_TO_STATE[next];
    if (from !== to) events.emit('game:stateChange', { from, to });
    try {
      this.onPhaseChange?.(next);
    } catch (err) {
      console.error('[Game] onPhaseChange threw', err);
    }
  }

  private disposeSession(): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    for (const u of s.unsubs) u();
    s.unsubs.length = 0;
    s.raceManager.onStartResult = null;

    this.scene.remove(s.track.object);
    for (const k of s.karts) this.scene.remove(k.object);
    this.scene.remove(s.items.object);
    this.scene.remove(s.sun, s.sun.target, s.hemi, s.fill, s.fill.target);
    s.sun.dispose();
    s.hemi.dispose();
    s.fill.dispose();
    this.scene.fog = null;
    this.scene.background = null;

    for (const vp of s.viewports) this.safe(() => vp.dispose());
    s.viewports.length = 0;
    if (s.panel) this.safe(() => s.panel!.dispose());
    s.panelEl?.remove();
    if (s.director) this.safe(() => s.director!.dispose());
    if (s.tips) this.safe(() => s.tips!.dispose());
    this.introCard.classList.remove('show');

    this.safe(() => s.items.dispose());
    for (const k of s.karts) this.safe(() => k.dispose());
    this.safe(() => s.track.dispose());
    s.raceManager.dispose();
    s.karts.length = 0;
    s.aiDrivers.length = 0;
    for (const h of s.humans) h.ai = null;
    this.safe(() => this.particles.reset());
    if (this.postfxOk) {
      this.safe(() => {
        this.postfx.setSpeedEffect(0);
        this.postfx.setBoostEffect(0);
        this.postfx.setHitEffect(0);
      });
    }
    this.accumulator = 0;
    this.appliedShadowSize = -1;
  }

  // ---------------------------------------------------------------- audio

  private playMusic(track: MusicTrack): void {
    this.currentMusic = track;
    this.safe(() => this.audio.playMusic(track));
  }

  private readonly onGesture = (): void => {
    if (this.audioStarted) return;
    this.audioStarted = true;
    window.removeEventListener('pointerdown', this.onGesture);
    window.removeEventListener('keydown', this.onGesture);
    this.audio
      .init()
      .then(() => {
        if (this.currentMusic !== 'none') this.safe(() => this.audio.playMusic(this.currentMusic));
      })
      .catch((err: unknown) => {
        console.warn('[Game] audio init failed', err);
        this.audioStarted = false;
        window.addEventListener('pointerdown', this.onGesture, { passive: true });
        window.addEventListener('keydown', this.onGesture);
      });
  };

  private toggleMute(): void {
    const muted = !this.audio.muted;
    this.safe(() => this.audio.setMuted(muted));
    this.muteIndicator.classList.toggle('visible', muted);
  }

  // ------------------------------------------------------------- listeners

  private readonly onResize = (): void => {
    this.sizeDirty = true;
  };

  private readonly onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.repeat) return;
    const t = ev.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (ev.key === 'm' || ev.key === 'M') this.toggleMute();
  };

  private readonly onBlur = (): void => {
    // Party mode never auto-pauses (the host window may lose focus while phones play).
    if (this.session?.cfg?.ui !== 'solo') return;
    const p = this.phaseValue;
    if (p === 'racing' || p === 'countdown' || p === 'intro') this.pause();
  };

  private readonly onVisibility = (): void => {
    if (document.hidden) this.onBlur();
  };

  private safe(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error('[Game]', err);
    }
  }
}

export type { Session as GameSession };
