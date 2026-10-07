/**
 * FROZEN CONTRACT (LEAD) — Party Rush minigame plug-in interface (host side).
 *
 * The SHELL (src/games/rush/RushModule.ts + shell/**) owns the endless loop, timers, intro card,
 * countdown, scoreboard, results animation, audio + music, player strip, QR, the watchdog and the
 * per-phone `RushPhoneMsg` sync. Each MINIGAME is an isolated plug-in (src/games/rush/minigames/<id>.ts)
 * that only sees this file, `draw.ts`, `tuning.ts` and the protocol types.
 *
 * Coordinates: minigames render into a fixed LOGICAL STAGE of STAGE_W × STAGE_H (1920 × 1080) units.
 * The shell scales/letterboxes it to the screen and applies TV-mode overscan margins, so a minigame never
 * deals with devicePixelRatio, window size or TV mode. Keep important things ≥ 40 units from the edges
 * and leave the top 110 units free (the shell's HUD bar: minigame name, timer, small QR).
 *
 * Time: the shell calls `update(dt)` at the display refresh rate (dt in seconds, clamped to ≤ 0.1) only
 * during the PLAY phase, and `render()` every frame of the COUNT, PLAY and RESULTS phases (so the
 * minigame's opening layout is visible during 3-2-1 and its final state behind the results).
 *
 * Errors: anything a minigame throws ends that round with "Oops — skipping that one!" (no points); the
 * loop continues. Never rely on that — but never try to catch-and-hide your own bugs either.
 */
import type { MgFromPhone, RushCue, RushDemo, RushEvent, RushPhoneMsg, RushStream } from '../../net/protocol';

export const STAGE_W = 1920;
export const STAGE_H = 1080;
/** Top HUD bar height reserved by the shell. */
export const HUD_H = 110;

export type Heat = 1 | 2 | 3;

/** One participant of a round (human phone or a host-side solo bot). */
export interface RushPlayer {
  readonly id: string;
  readonly name: string;
  /** Unique emoji (animal/food). */
  readonly emoji: string;
  /** CSS colour (SLOT_COLORS). */
  readonly color: string;
  /** Host-side bot (solo play / tests). */
  readonly bot: boolean;
  /** Uses the touch fallback (no motion sensors). Show a small 👆 next to them. */
  readonly touch: boolean;
}

/** A stream sample (raw ints -1000..1000, see the tag-2 packet docs in protocol.ts for the meaning per stream). */
export interface StreamSample {
  a: number;
  b: number;
  c: number;
}

/** A phone gesture event (already validated + rid-checked by the shell). */
export interface RushInputEvent {
  k: RushEvent;
  /** flick: strength 0..100 (≥ ~15 already means "a real small wrist flick"); pose: pose index; else 0. */
  v: number;
  /** flick direction (-100..100, x right, y up), 0 if unknown. */
  x: number;
  y: number;
  /**
   * Reaction time measured ON THE PHONE (ms since cue `cueId` arrived there), or null when no cue was up.
   * Sanity-clamped by the shell to 0..10000. Use it (not host arrival time) for timing games.
   */
  ms: number | null;
  /** The cue id the phone had when the gesture happened (null = none). */
  cueId: number | null;
  /** Host time (seconds since GO) the event arrived. */
  at: number;
}

/** Sound effects the shell can play on the TV (procedural). */
export type RushSfx =
  | 'tick' // light UI tick
  | 'go' // GO! stinger
  | 'whoosh' // something flies
  | 'pop' // balloon / bubble pop
  | 'boom' // explosion
  | 'ding' // success / point
  | 'buzz' // wrong / out
  | 'splash' // water
  | 'thud' // dart hit / bump
  | 'drum' // a drum hit (Tug of War beat)
  | 'boing' // silly bounce
  | 'honk' // silly horn (Don't Move distractions)
  | 'fanfare' // winner
  | 'reel' // fishing reel click
  | 'crowd'; // crowd "ooh"

/** Options for a big centred TV callout. */
export interface ShoutOpts {
  color?: string;
  /** Duration (ms), default 900. */
  ms?: number;
  /** Size multiplier (1 = 140 units). */
  size?: number;
}

/** What the shell gives a running minigame. */
export interface MinigameCtx {
  readonly heat: Heat;
  /** Everyone in this round (fixed for the round; mid-round joiners wait for the next one). */
  readonly players: readonly RushPlayer[];
  /** Seeded RNG in [0, 1). Use it instead of Math.random (replays + tests). */
  rand(): number;
  /** Seconds since GO. */
  readonly time: number;
  /** Seconds left before the hard cap. */
  readonly timeLeft: number;
  /** Hard cap for this round (seconds) = meta.duration[heat-1]. */
  readonly duration: number;
  /** False once a player went away / disconnected / was removed mid-round (`onLeave` was called). */
  isPresent(id: string): boolean;
  /**
   * Set (or clear with null) a player's phone cue. A new cue id is allocated when `fire` is true (default):
   * the phone flashes + plays a sound + vibrates once and restarts its reaction timer. `fire:false` updates
   * the visual of the current cue (e.g. the bomb's `v`) without re-firing. Returns the cue id.
   */
  cue(id: string, cue: Omit<RushCue, 'id'> | null, fire?: boolean): number;
  /** Override the giant word on one phone ('' = back to meta.word). */
  word(id: string, word: string): void;
  /** Play a TV sound effect. `pan` -1..1 (optional), `vol` 0..1. */
  sfx(name: RushSfx, opts?: { pan?: number; vol?: number; pitch?: number }): void;
  /** Big centred TV callout ("DRAW!", "BOOM!"). */
  shout(text: string, opts?: ShoutOpts): void;
  /** End the round now (everyone finished / all out). The shell then calls results(). */
  end(): void;
}

/** Final placement of one player. */
export interface RankEntry {
  id: string;
  /** 1-based; equal values are ties. Team games: every winner 1, every loser 2. */
  place: number;
  /** Short stat shown on the results card ('0.231 s', '12 m to go', '3 fish · 4.2 kg', 'OUT'). */
  stat: string;
}

export interface MinigameResult {
  /** Everyone who took part, best first. Players who were away for the whole round may be omitted (they score 0, never shown as losers). */
  ranking: RankEntry[];
  /** Funny awards (the shell shows one or two; one for last place when possible). */
  superlatives?: { id: string; text: string }[];
  /** Optional headline instead of "<winner> WINS!" (e.g. 'BLUE TEAM WINS!'). */
  headline?: string;
}

/** Render info for one frame. Draw in STAGE units (the transform is already set). */
export interface RenderView {
  /** Seconds since the minigame was created (keeps animating through count/results). */
  t: number;
  dt: number;
  phase: 'count' | 'play' | 'results';
  /** Rough pixels-per-unit (for hairline widths); usually ≥ 0.3. */
  scale: number;
}

export interface Minigame {
  /** Called once at the start of the COUNT phase (players are final). Lay everything out here. */
  start(ctx: MinigameCtx): void;
  /** Called at GO (start of PLAY). Optional. */
  go?(): void;
  /** 20 Hz stream sample (only if meta.stream is set). */
  onStream?(p: RushPlayer, s: StreamSample): void;
  /** A gesture event (only kinds listed in meta.events, plus 'tap' from touch players). */
  onEvent?(p: RushPlayer, e: RushInputEvent): void;
  /** Player left mid-round (away / disconnected / removed). Must not leave anything stuck (bombs, ropes, turns). */
  onLeave?(p: RushPlayer): void;
  /** Player came back mid-round (same round) — optional; default: they stay out of this round. */
  onReturn?(p: RushPlayer): void;
  update(dt: number): void;
  render(g: CanvasRenderingContext2D, view: RenderView): void;
  /** True when the round is over before the time cap. */
  done(): boolean;
  /** Final ranking (called exactly once, after done() or at the time cap). */
  results(): MinigameResult;
  /** Host-side solo bots: hint numbers for this player's bot brain (e.g. target direction). */
  botHint?(id: string): number[] | undefined;
  dispose?(): void;
}

export interface MinigameMeta {
  /** Stable id (kebab-case), e.g. 'shake-race'. */
  id: string;
  /** Display name, e.g. 'Shake Race'. */
  name: string;
  /** ONE line, ≤ ~8 words: 'Shake to run!' */
  instr: string;
  /** Giant word on the phone during play: 'SHAKE!' */
  word: string;
  demo: RushDemo;
  /** Minimum players (bots count). */
  minPlayers: number;
  /** Hard cap in seconds per heat [1, 2, 3]. */
  duration: [number, number, number];
  /** Stream the phone must send (null = events only). */
  stream: RushStream | null;
  /** Events the phone must detect. 'tap' is implied for touch players. */
  events: RushEvent[];
  /** What a touch-fallback player does, ≤ 4 words: 'Mash the button!' */
  touch: string;
  /** One of the two most energetic games → "Hold your phone tight!" card before it. */
  energetic?: boolean;
  /** Accent colour for the intro card / HUD. */
  color: string;
  /** Emoji for the intro card / scoreboard teaser. */
  icon: string;
}

/** A minigame plug-in. */
export interface MinigameDef {
  readonly meta: MinigameMeta;
  create(): Minigame;
}

// ---------------------------------------------------------------------------------------------
// Bot brains — PURE (no DOM), used by host-side solo bots AND by scripts/bots.ts (Node). A bot sees
// exactly what a phone sees (the RushPhoneMsg) plus, on the host only, the minigame's botHint.
// ---------------------------------------------------------------------------------------------

/** What a bot does this step: a stream sample (if the round has a stream) and gesture events. */
export interface BotOut {
  /** [a, b, c] ints -1000..1000 (same meaning as the phone stream). */
  stream?: [number, number, number];
  /** Events (rid is filled in by the caller). `ms`/`c` like a phone would (measure from cueAgeMs). */
  events?: Omit<MgFromPhone, 't' | 'rid'>[];
}

export interface BotStepInput {
  msg: RushPhoneMsg;
  /** Seconds since the last step. */
  dt: number;
  /** Seconds since GO (0 before). */
  time: number;
  /** ms since the current cue id arrived (null = no cue). */
  cueAgeMs: number | null;
  /** botHint() values (host-side bots only). */
  hint?: number[];
}

export interface Bot {
  step(i: BotStepInput): BotOut;
}

/** `skill` 0..1 (0.5 = average tipsy human). */
export type BotFactory = (rand: () => number, skill: number) => Bot;
