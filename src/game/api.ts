/**
 * FROZEN CONTRACT — the interface between the game ENGINE (src/game/**, owned by
 * the engine workstream) and the PARTY layer (src/party/**: networking, lobby,
 * tutorial, overlays, which orchestrates everything).
 *
 * `Game` implements `IGameHost`. The party layer only talks to the engine
 * through this interface plus the global event bus (src/core/events.ts).
 *
 * Kart ids: human i of `PartyRaceConfig.humans` drives kart id i (0..n-1) and
 * renders in viewport i. AI karts fill ids n..7. So "slot" === kart id for humans.
 */
import type { ItemType } from '../core/types';
import type { EngineCC } from '../net/protocol';

export type QualityTier = 0 | 1 | 2 | 3; // 0 = potato (tests / 4 views on 4K), 3 = full

export interface HumanDriver {
  /** Network player id, or 'local' for the host keyboard/gamepad. */
  playerId: string;
  name: string;
  characterId: string;
  /** CSS colour of the player's slot (viewport label, minimap dot). */
  color: string;
  source: 'phone' | 'local';
}

export interface PartyRaceConfig {
  trackId: string;
  cc: EngineCC; // 50 -> easy AI & 0.8x speed, 100 -> normal 0.92x, 150 -> hard 1.0x
  laps: number;
  /** 1..4 humans; humans[i] drives kart i and gets viewport i. */
  humans: HumanDriver[];
  /** Contextual tips ("Hold DRIFT through this corner!") during this race. */
  showTips: boolean;
  /** Play the short intro flyover before the countdown. Default true. */
  introFlyover?: boolean;
  /**
   * 'party': engine shows NO menus of its own (no pause menu / results screen);
   *          the party layer renders those overlays. Esc/P on the host keyboard
   *          calls `onPauseRequest` instead of pausing directly.
   * 'solo' : legacy single-player keyboard flow with the engine's own menus.
   */
  ui: 'party' | 'solo';
}

/** Per-phone input. Steering etc. are absolute; `itemPresses` is a wrapping counter (see protocol). */
export interface HumanInput {
  steer: number; // -1..1
  throttle: number; // 0..1
  brake: number; // 0..1
  drift: boolean;
  itemHeld: boolean;
  lookBack: boolean;
  itemPresses: number; // 0..255, every increment = one useItem edge
}

export type EnginePhase =
  | 'idle' // nothing running (boot)
  | 'demo' // AI-only attract race behind the title / lobby / tutorial / setup overlays
  | 'soloMenu' // legacy keyboard menus (character / track select)
  | 'loading'
  | 'intro' // flyover before countdown
  | 'countdown'
  | 'racing'
  | 'finished' // >=1 human finished, others still racing
  | 'paused'
  | 'results'; // race complete, world keeps rendering behind overlays

export interface SlotStatus {
  kartId: number;
  place: number;
  lap: number; // 1-based, clamped to laps
  laps: number;
  item: ItemType;
  itemCount: number;
  roulette: boolean;
  driftStage: 0 | 1 | 2 | 3;
  countdown: number; // 3,2,1 during countdown, 0 otherwise
  finished: boolean;
  /** AI is currently driving this human's kart (disconnect handover or post-finish autopilot). */
  aiControlled: boolean;
  speed: number;
}

export interface RaceResult {
  kartId: number;
  place: number;
  name: string;
  characterId: string;
  color: string; // CSS colour (player slot colour, or character colour for AI)
  /** Seconds, -1 if not finished (estimated order). */
  time: number;
  /** Human index (= kart id) or -1 for AI. */
  slot: number;
}

export interface IGameHost {
  readonly phase: EnginePhase;

  /** Start / keep the all-AI attract race (title, lobby, tutorial, setup screens). Idempotent. */
  showDemo(): void;
  /** Build and start a race: loading -> intro flyover -> countdown -> racing. */
  startRace(cfg: PartyRaceConfig): void;
  /** Latest input for human `slot` (kart id). Called whenever a packet arrives. */
  setHumanInput(slot: number, input: HumanInput): void;
  /** Hand a human kart to the AI (phone disconnected) or give it back (reclaimed). */
  setSlotAI(slot: number, ai: boolean): void;
  pause(): void;
  resume(): void;
  restartRace(): void;
  /** Abort the race and go back to the demo. */
  quitRace(): void;
  getSlotStatus(slot: number): SlotStatus | null;
  /** Final (or provisional) standings of the current/last race, all 8 karts. */
  getResults(): RaceResult[] | null;
  /** Open the legacy keyboard solo menus (character/track select). */
  openSoloMenu(): void;
  /** Toggle 10-foot UI sizing for the engine HUD (party layer owns the decision). */
  setTvMode(on: boolean): void;

  // Callbacks (assigned by the party layer).
  /** Phase changed. */
  onPhaseChange: ((phase: EnginePhase) => void) | null;
  /** Race complete (all karts finished or grace timeout). Party shows results. */
  onRaceComplete: ((results: RaceResult[]) => void) | null;
  /** Host keyboard asked to pause during a 'party' race. */
  onPauseRequest: (() => void) | null;
  /** The solo keyboard flow returned to the title (user picked Main Menu / Quit). */
  onSoloExit: (() => void) | null;
}

/**
 * Debug / test hooks installed by the engine at `window.__game` (ALWAYS, not just in dev:
 * Playwright tests run against the production build).
 */
export interface GameDebugHooks {
  /** Start a race directly. Defaults: first track, 1 lap, 150cc, one local human, ui 'solo'. */
  startRace(cfg?: Partial<PartyRaceConfig>): void;
  /** Make human `slot` (default 0) cross the finish line now. */
  finishPlayer(slot?: number): void;
  /** Finish every kart immediately (in plausible order) -> results. */
  finishAll(): void;
  /** AI drives human `slot` (default 0) while on. */
  autopilot(on: boolean, slot?: number): void;
  /** Put an item in a kart's slot (skips roulette). */
  giveItem(slot: number, item: ItemType): void;
  /** Force a quality tier (null = automatic scaler). */
  setQuality(tier: QualityTier | null): void;
  getState(): {
    phase: EnginePhase;
    viewports: number;
    qualityTier: QualityTier;
    fps: number;
    raceTime: number;
    /** renderer.info.memory + programs, to detect leaks across races. */
    memory: { geometries: number; textures: number; programs: number };
    /** Number of races started since page load. */
    racesStarted: number;
    karts: {
      id: number;
      human: boolean;
      aiControlled: boolean;
      x: number;
      y: number;
      z: number;
      heading: number;
      speed: number;
      lap: number;
      place: number;
      item: ItemType;
      driftStage: number;
      isDrifting: boolean;
      isSpinning: boolean;
      isBoosting: boolean;
      finished: boolean;
      /** Count of useItem actions performed by this kart this race. */
      itemsUsed: number;
      /** Last human input applied (for tests). */
      lastSteer: number;
    }[];
  };
}
