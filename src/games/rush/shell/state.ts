/**
 * SHELL — shared state types of the Party Rush loop (read by the views, the phone sync and `__rush`).
 */
import type { RushCue, RushMe } from '../../../net/protocol';
import type { Bot, Heat, Minigame, MinigameDef, RushPlayer } from '../types';

/**
 * Loop phases:  lobby (scoreboard) → intro (UP NEXT) → count (3-2-1) → play → results → lobby.
 * 'oops' = a minigame threw: short stinger, no points, back to the scoreboard.
 */
export type Phase = 'lobby' | 'intro' | 'count' | 'play' | 'results' | 'oops';

/** Extra TV / UI sounds of the shell on top of the minigame `RushSfx`. */
export type ShellSfx = 'count' | 'join' | 'heat' | 'crown' | 'oops' | 'card' | 'pts' | 'pause';

/** One human on the party roster (bots live only inside a round). */
export interface Entry {
  readonly id: string;
  name: string;
  emoji: string;
  color: string;
  slot: number;
  st: RushMe;
  connected: boolean;
  /** Touch fallback (phone sent mode v=0). */
  touch: boolean;
  /** All-time points. */
  pts: number;
  wins: number;
  rounds: number;
  /** Points per round (only the last LOOP.streakRounds rounds are kept). */
  hist: { r: number; p: number }[];
  /** Did the join tap at least once. */
  everHere: boolean;
  /** Wall ms until which the phone shows "Hold your phone tight!" (first join). */
  safeUntil: number;
  /** Wall ms of the first join tap (scoreboard "just joined"). */
  joinedAt: number;
  /** Wall ms when the player went away (0 = not away). */
  awaySince: number;
  awayWhy: '' | 'idle' | 'hidden' | 'disc';
  /** Wall ms when removed / kicked (0 = not removed). */
  removedAt: number;
  /** Not shown on the board (removed a while ago / away > 10 min). Score kept. */
  hidden: boolean;
  /** Points + place of the last round this player scored in (scoreboard "+N" chip). */
  lastRound: number;
  lastPts: number;
}

export interface CueRec {
  cue: RushCue;
  /** Loop clock (s) when the cue id was allocated. */
  at: number;
}

export interface StreamRec {
  seq: number;
  at: number;
  a: number;
  b: number;
  c: number;
  moves: number;
  /** Rate-limit token bucket. */
  tokens: number;
  real: number;
}

export interface BotRec {
  p: RushPlayer;
  bot: Bot | null;
  acc: number;
}

/** The running (or just finished) minigame round. */
export interface RoundState {
  readonly def: MinigameDef;
  /** Round id (phones tag events / stream packets with it). */
  readonly rid: number;
  /** 1-based round number. */
  readonly n: number;
  readonly heat: Heat;
  readonly duration: number;
  readonly energetic: boolean;
  /** Loop clock when the round was created (intro start). */
  readonly createdAt: number;
  mg: Minigame | null;
  /** Created at COUNT start: participant id → player object handed to the minigame. */
  parts: Map<string, RushPlayer>;
  /** Participants still present (not left mid-round). */
  present: Set<string>;
  /** Participants that showed activity during PLAY. */
  active: Set<string>;
  cues: Map<string, CueRec>;
  words: Map<string, string>;
  streams: Map<string, StreamRec>;
  bots: Map<string, BotRec>;
  /** Seconds since GO. */
  time: number;
  /** ctx.end() was called. */
  endReq: boolean;
  /** results() was called (exactly once). */
  finished: boolean;
  shout: { text: string; at: number; ms: number; color: string; size: number } | null;
  /** Loop clock of the creation of the minigame object (render `t`). */
  mgAt: number;
  seed: number;
}

export interface ResultRowView {
  id: string;
  name: string;
  emoji: string;
  color: string;
  bot: boolean;
  touch: boolean;
  place: number;
  pts: number;
  stat: string;
}

/** The results card of a finished round. */
export interface ResultCard {
  round: number;
  rid: number;
  game: string;
  name: string;
  icon: string;
  color: string;
  headline: string;
  rows: ResultRowView[];
  sups: { id: string; text: string }[];
  sip: string;
}

export interface Stinger {
  kind: 'heat' | 'crown' | 'skip' | 'join' | 'info';
  text: string;
  sub: string;
  color: string;
  /** Wall ms. */
  at: number;
  ms: number;
}

export interface HistoryItem {
  r: number;
  g: string;
  win: string[];
}

export interface ErrorRec {
  at: number;
  where: string;
  game: string;
  msg: string;
}
