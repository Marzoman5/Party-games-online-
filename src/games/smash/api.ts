/**
 * FROZEN CONTRACT — the interface between the Smash Party ENGINE (SmashGame: renderer, sim,
 * audio, in-match HUD) and the PARTY HUB layer (src/party/**, src/engine/**).
 * Mirrors the Kart engine's IGameHost (src/game/api.ts). Owned by the LEAD; additive changes only.
 *
 * "slot" in this API = index into `humans` of the current match/sandbox config
 * (= fighter index; CPUs follow the humans). It is NOT the lobby slot.
 */
import type { DecodedFightInput, PhoneFx, SmashSetup } from '../../net/protocol';
import type { ActionState, ItemKind, MoveId } from './types';

export type SmashPhase =
  | 'idle' // not active (canvas hidden, nothing running)
  | 'attract' // CPU-vs-CPU demo behind the hub overlays (no HUD)
  | 'loading'
  | 'intro' // camera zooms across the fighters (~2.5 s)
  | 'countdown' // 3-2-1-GO!
  | 'fighting'
  | 'paused'
  | 'gameSet' // "GAME!" freeze (~2.5 s), then onMatchComplete
  | 'results' // winner victory pose keeps rendering behind the results overlay
  | 'sandbox'; // training stage "try it" practice with a dummy

export interface SmashHuman {
  playerId: string;
  name: string;
  characterId: string;
  /** CSS slot colour (P1 red, P2 blue, ...) — used for name tags / panels; team colour wins in team mode. */
  color: string;
  /** Lobby slot 0..3 (for the "P1".."P4" tags). */
  slot: number;
  team: number;
}

export interface SmashCpu {
  characterId: string;
  name: string;
  color: string;
  level: number; // 1..9
  team: number;
}

export interface SmashMatchConfig {
  setup: SmashSetup;
  humans: SmashHuman[];
  cpus: SmashCpu[];
  /** Intro zoom before the countdown (default true). */
  intro?: boolean;
  seed?: number;
}

export interface SmashSandboxConfig {
  humans: SmashHuman[];
}

export interface FighterStatus {
  fighter: number;
  characterId: string;
  damage: number;
  /** Stocks left, -1 in time mode. */
  stocks: number;
  score: number;
  kos: number;
  /** 3,2,1 during the countdown (also 3 during loading/intro), 0 otherwise. */
  countdown: number;
  /** Seconds left (time mode / sudden death), -1 otherwise. */
  timeLeft: number;
  out: boolean;
  respawning: boolean;
  cpu: boolean;
  team: number;
  item: ItemKind | 'none';
  suddenDeath: boolean;
  /** Sandbox: training dummy damage %. */
  dummyDamage?: number;
}

export interface SmashResultRow {
  fighter: number;
  /** Lobby slot for humans, -1 for CPUs. */
  slot: number;
  playerId: string | null;
  name: string;
  characterId: string;
  color: string;
  team: number;
  cpu: boolean;
  place: number;
  kos: number;
  falls: number;
  sds: number;
  damageDealt: number;
  damageTaken: number;
  stocksLeft: number;
  score: number;
}

export interface SmashResult {
  /** Ordered by place (1 first; ties share a place). */
  rows: SmashResultRow[];
  winnerFighter: number;
  /** Winning team in team mode, -1 in free-for-all. */
  winnerTeam: number;
  mode: 'stock' | 'time';
  /** Match length in seconds. */
  duration: number;
}

/** One-shot phone feedback for human `slot`. */
export interface SmashFx {
  slot: number;
  kind: PhoneFx['kind'];
  /** 0..1 */
  strength: number;
}

export interface ISmashHost {
  readonly phase: SmashPhase;

  /** Show this game: attach canvas + HUD, start the attract demo. Idempotent. */
  activate(): void;
  /**
   * Hide this game: stop sim, rendering and audio, hide canvas + HUD. Keeps the renderer /
   * shared GPU resources so re-activating is fast, but disposes per-match scene objects —
   * activate/deactivate/match cycles must not leak (renderer.info.memory stays flat).
   */
  deactivate(): void;
  /** loading -> intro -> countdown -> fighting -> gameSet -> (onMatchComplete) results. */
  startMatch(cfg: SmashMatchConfig): void;
  /** Training stage practice: every human + a training dummy. Phase 'sandbox' until another call. */
  startSandbox(cfg: SmashSandboxConfig): void;
  /** Sandbox: this player is done practising (fighter vanishes in a puff). */
  retireFromSandbox(slot: number): void;
  setHumanInput(slot: number, input: DecodedFightInput): void;
  /** CPU (level 5) takes over a human's fighter (phone disconnected) — or gives it back. */
  setSlotAI(slot: number, ai: boolean): void;
  pause(): void;
  resume(): void;
  /** Same config, fresh match (Rematch / pause-menu Restart). */
  restartMatch(): void;
  /** Abort and go back to the attract demo. */
  quitMatch(): void;
  getFighterStatus(slot: number): FighterStatus | null;
  /** Result of the last finished match (null before / during a match). */
  getResults(): SmashResult | null;
  /** data: URL portrait (rendered fighter bust) for host/phone UI; null until rendered. */
  getPortrait(characterId: string): string | null;
  setTvMode(on: boolean): void;

  onPhaseChange: ((phase: SmashPhase) => void) | null;
  /** Fired once after the "GAME!" freeze; the engine then shows the winner's victory pose ('results'). */
  onMatchComplete: ((result: SmashResult) => void) | null;
  /** Host keyboard Esc/P during a match. */
  onPauseRequest: (() => void) | null;
  /** Phone haptics / feedback for a human fighter. */
  onFx: ((fx: SmashFx) => void) | null;
}

/**
 * Debug / test hooks installed by SmashGame at `window.__smash` (ALWAYS, production build too:
 * Playwright runs against it). The SmashGame instance is created lazily, so `__smash` exists
 * from the first activate() on.
 */
export interface SmashDebugHooks {
  getState(): {
    phase: SmashPhase;
    stageId: string | null;
    frame: number;
    fps: number;
    matchesStarted: number;
    timeLeft: number;
    suddenDeath: boolean;
    /** Total hits landed (hit events, not shielded) / KOs this match. */
    hits: number;
    kos: number;
    itemsSpawned: number;
    itemsUsed: number;
    debugOverlay: boolean;
    camera: { x: number; y: number; width: number };
    memory: { geometries: number; textures: number; programs: number };
    fighters: {
      index: number;
      slot: number;
      name: string;
      characterId: string;
      human: boolean;
      cpu: boolean;
      dummy: boolean;
      team: number;
      x: number;
      y: number;
      vx: number;
      vy: number;
      facing: number;
      grounded: boolean;
      action: ActionState;
      move: MoveId | null;
      damage: number;
      stocks: number;
      kos: number;
      falls: number;
      damageDealt: number;
      out: boolean;
      respawning: boolean;
      invincible: boolean;
      shield: number;
      heldItem: ItemKind | null;
      offscreen: boolean;
    }[];
    items: { id: number; kind: ItemKind; x: number; y: number; holder: number }[];
    projectiles: number;
  };
  setDamage(fighter: number, pct: number): void;
  ko(fighter: number): void;
  spawnItem(kind: ItemKind, x?: number, y?: number): number;
  giveItem(fighter: number, kind: ItemKind): void;
  /** Decide the match now -> GAME! -> results. */
  endMatch(): void;
  /** Hitbox / hurtbox overlay (also host key H). */
  setDebug(on: boolean): void;
  /** Make a fighter CPU-driven (level) or human again (null) — tests use it as an autopilot. */
  cpu(fighter: number, level: number | null): void;
  /** Sim speed multiplier for tests (1 = real time; e.g. 4 runs 4 sim frames per 60 Hz tick). */
  timeScale(n: number): void;
}
