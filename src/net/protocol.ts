/**
 * FROZEN CONTRACT — Kart Party network protocol.
 *
 * Shared by the Node relay server (server/**), the HOST page (src/party/**) and
 * the PHONE controller (src/phone/**). Pure types + tiny helpers, no imports, so
 * it compiles in both the browser and Node tsconfigs.
 *
 * Topology: phones <-> server <-> host (one WebSocket each, path WS_PATH).
 * The server is a dumb relay plus identity registry (room code, player ids,
 * reconnect tokens). The HOST browser is authoritative for all game state.
 *
 * Encoding: every frame is JSON text. Input packets are a compact JSON array
 * (see InputPacket) so they're tiny and fast to parse at ~60 Hz per phone.
 */

export const WS_PATH = '/ws';
export const DEFAULT_PORT = 3000;
export const DEFAULT_HTTPS_PORT = 3443;
export const MAX_PLAYERS = 4;
/** Room codes: 4 uppercase letters, no I/O to avoid confusion with 1/0. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const PROTOCOL_VERSION = 1;

/** Kart/team colours by player slot (CSS hex). Phone background tint + host labels. */
export const SLOT_COLORS = ['#ff4d4d', '#3d8bff', '#3ddc5a', '#ffc21a'] as const;

// ---------------------------------------------------------------------------
// Input packet (phone -> server -> host). Sent ~60 Hz while in race/tutorial,
// and immediately on any button edge.
//
// Phone sends:   [0, seq, steer, throttle, brake, buttons, itemPresses]
// Server relays: [0, seq, steer, throttle, brake, buttons, itemPresses, playerId]
//   steer       int -100..100   (-100 = full left)
//   throttle    int 0..100
//   brake       int 0..100      (brake / reverse)
//   buttons     bitmask of BTN_*
//   itemPresses uint 0..255 counter, incremented on every ITEM touch-down
//               (wraps). Host fires `useItem` once per increment, so taps are
//               never lost even if shorter than one packet interval.
// ---------------------------------------------------------------------------
export const BTN_DRIFT = 1;
export const BTN_ITEM_HELD = 2;
export const BTN_LOOKBACK = 4;

export type InputPacket = [0, number, number, number, number, number, number];
export type RelayedInputPacket = [0, number, number, number, number, number, number, string];

export interface DecodedInput {
  seq: number;
  steer: number; // -1..1
  throttle: number; // 0..1
  brake: number; // 0..1
  drift: boolean;
  itemHeld: boolean;
  lookBack: boolean;
  itemPresses: number; // 0..255
}

export function encodeInput(seq: number, i: Omit<DecodedInput, 'seq'>): InputPacket {
  const b = (i.drift ? BTN_DRIFT : 0) | (i.itemHeld ? BTN_ITEM_HELD : 0) | (i.lookBack ? BTN_LOOKBACK : 0);
  return [
    0,
    seq | 0,
    Math.round(Math.max(-1, Math.min(1, i.steer)) * 100),
    Math.round(Math.max(0, Math.min(1, i.throttle)) * 100),
    Math.round(Math.max(0, Math.min(1, i.brake)) * 100),
    b,
    i.itemPresses & 255,
  ];
}

export function decodeInput(p: readonly unknown[]): DecodedInput | null {
  if (!Array.isArray(p) || p[0] !== 0 || p.length < 7) return null;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const b = n(p[5]);
  return {
    seq: n(p[1]),
    steer: Math.max(-1, Math.min(1, n(p[2]) / 100)),
    throttle: Math.max(0, Math.min(1, n(p[3]) / 100)),
    brake: Math.max(0, Math.min(1, n(p[4]) / 100)),
    drift: (b & BTN_DRIFT) !== 0,
    itemHeld: (b & BTN_ITEM_HELD) !== 0,
    lookBack: (b & BTN_LOOKBACK) !== 0,
    itemPresses: n(p[6]) & 255,
  };
}

// ---------------------------------------------------------------------------
// Control messages (JSON objects with a `t` discriminator).
// ---------------------------------------------------------------------------

// ----- phone -> server ------------------------------------------------------
/** First message from a phone. `token` (from localStorage) reclaims a previous identity. */
export interface PhoneHello {
  t: 'join';
  room: string;
  token?: string;
  v: number; // PROTOCOL_VERSION
}
/** Liveness ping (phone sends every 2 s; server answers 'pong' with the same id). */
export interface Ping {
  t: 'ping';
  id: number;
}

// ----- server -> phone ------------------------------------------------------
export interface PhoneWelcome {
  t: 'joined';
  playerId: string;
  token: string;
  room: string;
  /** True if this token was already known (reclaim). */
  rejoin: boolean;
}
export interface ServerError {
  t: 'error';
  code: 'no_room' | 'room_full' | 'bad_version' | 'host_gone' | 'kicked';
  message: string;
}
export interface Pong {
  t: 'pong';
  id: number;
}
/** Server tells phones the host page is (dis)connected so they can show a banner. */
export interface HostStatus {
  t: 'host';
  connected: boolean;
}

// ----- host -> server -------------------------------------------------------
/** First message from the host page. `room` + `hostToken` reclaim the room after a host reload. */
export interface HostHello {
  t: 'host_hello';
  room?: string;
  hostToken?: string;
  v: number;
}
/** Deliver `m` to one phone (playerId) or all phones ('*'). */
export interface HostSend {
  t: 'to';
  p: string | '*';
  m: HostToPhone;
}
/** Forget a player entirely (frees the seat; their token stops working). */
export interface HostKick {
  t: 'kick';
  p: string;
}

// ----- server -> host -------------------------------------------------------
export interface HostWelcome {
  t: 'hosted';
  room: string;
  hostToken: string;
  /** e.g. ["http://192.168.1.23:3000"] — LAN base URLs, best first. */
  urls: string[];
  /** Full controller URL for the QR code: `${urls[0]}/play?room=${room}`. */
  joinUrl: string;
  https: boolean;
  /** Players the server still knows about (after a host reload). */
  players: { playerId: string; connected: boolean }[];
}
export interface PlayerJoined {
  t: 'p_join';
  p: string;
  rejoin: boolean;
}
export interface PlayerLeft {
  t: 'p_leave';
  p: string;
}
/** A control message from a phone, tagged with its playerId. */
export interface FromPhone {
  t: 'from';
  p: string;
  m: PhoneToHost;
}

// ---------------------------------------------------------------------------
// Application messages: phone <-> host (relayed verbatim by the server).
// ---------------------------------------------------------------------------

export type ScreenId =
  | 'title' // attract/demo race; phone shows "join" pending
  | 'lobby' // pick name/racer, ready up
  | 'tutorial' // how-to-play
  | 'setup' // leader picks mode/track/cc/laps; others wait
  | 'loading'
  | 'race' // countdown + racing + finished (still driving)
  | 'paused'
  | 'results'
  | 'waiting'; // late joiner while a race is running

export type RaceMode = 'single' | 'gp';
export type EngineCC = 50 | 100 | 150;

export interface LobbyPlayer {
  playerId: string;
  slot: number; // 0..3, colour = SLOT_COLORS[slot]
  name: string;
  characterId: string;
  ready: boolean;
  connected: boolean;
  isLeader: boolean;
  /** Tutorial "Got it!" tapped. */
  tutorialDone: boolean;
}

export interface RaceSetup {
  mode: RaceMode;
  trackId: string;
  cc: EngineCC;
  laps: number; // 1..5
}

export interface ResultRow {
  place: number;
  name: string;
  characterId: string;
  color: string;
  /** Seconds, or -1 if did not finish. */
  time: number;
  /** Player slot, or -1 for an AI racer. */
  slot: number;
  /** GP only: points earned this race / running total. */
  points?: number;
  total?: number;
}

/** Full menu/session snapshot. Host sends it to each phone whenever it changes (personalised `you`). */
export interface PhoneState {
  t: 'state';
  screen: ScreenId;
  room: string;
  you: LobbyPlayer | null;
  players: LobbyPlayer[];
  /** Racer ids already taken by other players (phone greys them out). */
  takenCharacters: string[];
  setup: RaceSetup;
  /** GP progress, e.g. race 2 of 4 (null in single race mode). */
  gp: { race: number; of: number } | null;
  tutorial: { step: number; total: number } | null;
  pause: { by: string; votes: number; needed: number } | null;
  results: { rows: ResultRow[]; gpFinal: boolean } | null;
  /** Settings the host applies to everyone (tips etc.). */
  tipsEnabled: boolean;
}

/** Low-rate (~10 Hz) in-race status for one phone. */
export interface PhoneRaceStatus {
  t: 'race';
  place: number; // 1..8
  lap: number; // 1-based current lap
  laps: number;
  item: string; // ItemType ('none' when empty)
  itemCount: number;
  roulette: boolean;
  driftStage: 0 | 1 | 2 | 3;
  /** Seconds until GO during countdown (3,2,1), 0 after start. */
  countdown: number;
  finished: boolean;
  /** True while the AI is driving this kart (e.g. after finishing). */
  ai: boolean;
}

/** One-shot feedback events for haptics/sfx on the phone. */
export interface PhoneFx {
  t: 'fx';
  kind: 'hit' | 'miniturbo' | 'lap' | 'finalLap' | 'item' | 'go' | 'finish' | 'boost';
}

export type HostToPhone = PhoneState | PhoneRaceStatus | PhoneFx;

export type PhoneToHost =
  | { t: 'profile'; name: string; characterId: string }
  | { t: 'ready'; ready: boolean }
  | { t: 'howto' } // leader: replay the how-to-play intro
  | { t: 'tut_ok' } // "Got it!"
  | { t: 'tut_skip' } // leader: skip the tutorial
  | { t: 'setup'; setup: Partial<RaceSetup> } // leader edits
  | { t: 'start' } // leader: lobby -> tutorial/setup, setup -> race
  | { t: 'pause' }
  | { t: 'resume' } // leader resumes; others vote
  | { t: 'restart' } // leader
  | { t: 'quit' } // leader: back to lobby
  | { t: 'post'; action: 'next' | 'replay' | 'track' | 'lobby' } // leader, results screen
  | { t: 'leader'; to: string } // leader hands over
  | { t: 'tips'; enabled: boolean } // leader toggles contextual tips
  | { t: 'leave' }; // player leaves the party

export type ServerToHost = HostWelcome | PlayerJoined | PlayerLeft | FromPhone | ServerError | Pong;
export type ServerToPhone = PhoneWelcome | ServerError | Pong | HostStatus | HostToPhone;
export type HostToServer = HostHello | HostSend | HostKick | Ping;
export type PhoneToServer = PhoneHello | Ping | PhoneToHost | InputPacket;
