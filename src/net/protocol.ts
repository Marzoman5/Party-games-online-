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
/**
 * PARTY RUSH: room-level cap on players (connected seats). Kart Party and Smash Party still seat at most
 * MAX_MATCH_PLAYERS (per-game `GameInfo.maxPlayers`); the rest watch that match.
 */
export const MAX_PLAYERS = 16;
/** Kart / Smash seats per match (the first players by join order play, the rest watch). */
export const MAX_MATCH_PLAYERS = 4;
/** Room codes: 4 uppercase letters, no I/O to avoid confusion with 1/0. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const PROTOCOL_VERSION = 1;

/**
 * Player colours by lobby slot (CSS hex). Phone background tint + host labels. The first 4 are the
 * original kart colours; PARTY RUSH adds 12 more, ordered so neighbours stay well separated in hue and
 * lightness (players are ALSO identified by emoji + name everywhere, never colour alone).
 */
export const SLOT_COLORS = [
  '#ff4d4d', // red
  '#3d8bff', // blue
  '#3ddc5a', // green
  '#ffc21a', // yellow
  '#c86bff', // purple
  '#ff8a1f', // orange
  '#1fd6d0', // teal
  '#ff5fb8', // pink
  '#9be03a', // lime
  '#8d6bff', // indigo
  '#ffffff', // white
  '#d98a4e', // tan
  '#5fd0ff', // sky
  '#e8d27a', // sand
  '#ff9f9f', // salmon
  '#a8b8e0', // periwinkle
] as const;

/** PARTY RUSH: one unique emoji per player (animals/food), assigned on join. */
export const PLAYER_EMOJIS = [
  '🐸', '🦊', '🐼', '🐙', '🦄', '🐔', '🐧', '🦁', '🐷', '🐵', '🐢', '🦀', '🐝', '🦉', '🐳', '🦖',
  '🍕', '🌮', '🍩', '🍉', '🥑', '🍔', '🧁', '🍌',
] as const;

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
  | 'waiting' // late joiner while a race is running
  | 'sandbox'; // PARTY HUB: Smash Party "try it" practice (training stage + dummy) after the tutorial

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
  /** PARTY HUB: team (0 = red, 1 = blue) for team modes. Always present from the hub host. */
  team?: number;
  /** PARTY RUSH: the player's emoji (unique in the party). Always present from the hub host. */
  emoji?: string;
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
  /** PARTY HUB / Smash Party stats (absent for kart rows). */
  kos?: number;
  falls?: number;
  damageDealt?: number;
  /** Time mode score (KOs - falls - SDs). */
  score?: number;
  stocksLeft?: number;
  team?: number;
  /** True for CPU fighters / AI racers. */
  cpu?: boolean;
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

  // ----- PARTY HUB additions (always sent by the hub host; optional for compatibility) -----
  /** The active game. Decides the phone's controller layout, setup and results screens. */
  game?: GameId;
  /** Game picker entries (leader picks in the lobby / after a match). */
  games?: GameInfo[];
  /** The active game's setup (kart: same as `setup`; smash: SmashSetup). Leader edits with `gsetup`. */
  gameSetup?: Record<string, unknown>;
  /** Sandbox ("try it" practice): players who tapped "I'm ready". */
  sandbox?: { done: string[] } | null;
  /** Extra result info for the active game. */
  resultsInfo?: { game: GameId; winner: string; winnerTeam?: number; mode?: string } | null;
  /**
   * PARTY RUSH: why this phone is not playing the running Kart/Smash match: 'full' = the match seats only
   * the first `maxPlayers` by join order ("watching this one"), 'late' = joined after it started.
   */
  watch?: 'full' | 'late' | null;
  /** PARTY RUSH: the host runs in secure (HTTPS) mode, so motion sensors can work. */
  secure?: boolean;
}

// ---------------------------------------------------------------------------
// PARTY HUB — multi-game additions (all additive).
// ---------------------------------------------------------------------------

export type GameId = 'kart' | 'smash' | 'rush';
export const GAME_IDS: readonly GameId[] = ['kart', 'smash', 'rush'];

export interface GameInfo {
  id: GameId;
  title: string;
  tagline: string;
  emoji: string;
  /** CSS colour for cards. */
  color: string;
  minPlayers: number;
  maxPlayers: number;
}

/** Team colours (team 0 red, team 1 blue). */
export const TEAM_COLORS = ['#ff4d4d', '#3d8bff'] as const;

/** Smash Party match setup (leader edits it with `gsetup`). */
export interface SmashSetup {
  stageId: string;
  mode: 'stock' | 'time';
  /** 1..5, default 3. */
  stocks: number;
  /** Time mode length in seconds (60..300), default 120. */
  timeSec: number;
  teams: boolean;
  friendlyFire: boolean;
  /** CPU fighters fill empty slots up to this total fighter count (humans + cpus, 2..4). 0 = no CPUs. */
  fillCpus: number;
  /** CPU level 1..9. */
  cpuLevel: number;
  items: boolean;
  itemFrequency: 'low' | 'medium' | 'high';
  /** Stage hazards / moving platforms (stage 3). */
  hazards: boolean;
}

export const DEFAULT_SMASH_SETUP: SmashSetup = {
  stageId: 'skyline',
  mode: 'stock',
  stocks: 3,
  timeSec: 120,
  teams: false,
  friendlyFire: false,
  fillCpus: 0,
  cpuLevel: 3,
  items: true,
  itemFrequency: 'medium',
  hazards: true,
};

// ----- Smash input packet (phone -> server -> host) ------------------------
// Phone sends:   [1, seq, x, y, buttons, attackPresses, specialPresses, jumpPresses, grabPresses]
// Server relays: [1, seq, x, y, buttons, attackPresses, specialPresses, jumpPresses, grabPresses, playerId]
//   x, y        int -100..100  analog stick (y > 0 = UP)
//   buttons     bitmask of FBTN_* (held state)
//   *Presses    uint 0..255 wrapping counters, +1 on every touch-down of that button. The host
//               buffers each new press for ~5 frames (input buffering), so mashing over Wi-Fi
//               never loses a press. Tap-jump (flick up) also increments jumpPresses.
// Sent at 60 Hz while in a match / sandbox / tutorial and immediately on any button edge.
export const FBTN_ATTACK = 1;
export const FBTN_SPECIAL = 2;
export const FBTN_JUMP = 4;
export const FBTN_SHIELD = 8;
export const FBTN_GRAB = 16;
/** Stick was flicked (centre -> edge within ~70 ms) in the last ~120 ms: ATTACK now = smash attack. */
export const FBTN_FLICK = 32;

export type FightInputPacket = [1, number, number, number, number, number, number, number, number];
export type RelayedFightInputPacket = [1, number, number, number, number, number, number, number, number, string];

export interface DecodedFightInput {
  seq: number;
  x: number; // -1..1
  y: number; // -1..1 (up positive)
  attack: boolean;
  special: boolean;
  jump: boolean;
  shield: boolean;
  grab: boolean;
  flick: boolean;
  attackPresses: number;
  specialPresses: number;
  jumpPresses: number;
  grabPresses: number;
}

export function encodeFightInput(seq: number, i: Omit<DecodedFightInput, 'seq'>): FightInputPacket {
  const c = (v: number): number => Math.round(Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0)) * 100);
  const b =
    (i.attack ? FBTN_ATTACK : 0) |
    (i.special ? FBTN_SPECIAL : 0) |
    (i.jump ? FBTN_JUMP : 0) |
    (i.shield ? FBTN_SHIELD : 0) |
    (i.grab ? FBTN_GRAB : 0) |
    (i.flick ? FBTN_FLICK : 0);
  return [1, seq | 0, c(i.x), c(i.y), b, i.attackPresses & 255, i.specialPresses & 255, i.jumpPresses & 255, i.grabPresses & 255];
}

export function decodeFightInput(p: readonly unknown[]): DecodedFightInput | null {
  if (!Array.isArray(p) || p[0] !== 1 || p.length < 9) return null;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const b = n(p[4]);
  return {
    seq: n(p[1]),
    x: Math.max(-1, Math.min(1, n(p[2]) / 100)),
    y: Math.max(-1, Math.min(1, n(p[3]) / 100)),
    attack: (b & FBTN_ATTACK) !== 0,
    special: (b & FBTN_SPECIAL) !== 0,
    jump: (b & FBTN_JUMP) !== 0,
    shield: (b & FBTN_SHIELD) !== 0,
    grab: (b & FBTN_GRAB) !== 0,
    flick: (b & FBTN_FLICK) !== 0,
    attackPresses: n(p[5]) & 255,
    specialPresses: n(p[6]) & 255,
    jumpPresses: n(p[7]) & 255,
    grabPresses: n(p[8]) & 255,
  };
}

/** ~10 Hz in-match status for one phone while the active game is Smash Party. */
export interface PhoneFightStatus {
  t: 'fight';
  characterId: string;
  /** Damage percent (0..999). */
  damage: number;
  /** Stocks left (stock mode) or -1 in time mode. */
  stocks: number;
  /** Time mode: current score. */
  score: number;
  kos: number;
  /** Seconds until GO during the countdown (3,2,1), 0 after. */
  countdown: number;
  /** Seconds left in time mode (-1 in stock mode). */
  timeLeft: number;
  /** Out of the match (no stocks left). */
  out: boolean;
  /** Respawning / KO'd right now. */
  respawning: boolean;
  /** CPU is controlling this fighter (phone disconnected). */
  cpu: boolean;
  team: number;
  /** Held item kind ('none' when empty). */
  item: string;
  /** Sudden death in progress. */
  suddenDeath: boolean;
  /** Sandbox only: the training dummy's damage %. */
  dummyDamage?: number;
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
  kind:
    | 'hit'
    | 'miniturbo'
    | 'lap'
    | 'finalLap'
    | 'item'
    | 'go'
    | 'finish'
    | 'boost'
    // PARTY HUB / Smash Party:
    | 'ko' // you were KO'd
    | 'koOther' // you KO'd someone
    | 'shieldBreak'
    | 'land' // you landed a hit (light tick)
    | 'game'; // "GAME!"
  /** 0..1 strength (Smash hits: scales the vibration). */
  strength?: number;
}

// ---------------------------------------------------------------------------
// PARTY RUSH — the generic minigame channel (all additive). See docs/PARTY_RUSH_CONTRACT.md.
// ---------------------------------------------------------------------------

/** Continuous phone sensor streams a minigame can ask for (20 Hz, tag-2 packets). */
export type RushStream = 'shake' | 'tilt' | 'still' | 'pose' | 'aim' | 'pitch';
/** Discrete gesture events a minigame can ask for (`{t:'mg'}` phone→host). */
export type RushEvent = 'flick' | 'raise' | 'pose' | 'tap';
/** Gesture demo animation ids (intro card on the TV + the phone mirror). */
export type RushDemo = 'shake' | 'tilt' | 'flick' | 'yank' | 'still' | 'raise' | 'pose' | 'aim' | 'cast';
/** Loop phase as the phone sees it. */
export type RushPhase = 'lobby' | 'intro' | 'count' | 'play' | 'results' | 'paused';
/**
 * This phone's status: 'new' = connected, has not done the join tap yet; 'play' = in the current
 * minigame; 'next' = joined/returned mid-round, plays from the next minigame; 'away' = idle/hidden, tap to return.
 */
export type RushMe = 'new' | 'play' | 'next' | 'away';
/** Triple-cue style (full-screen flash colour + sound + vibration) fired once when a cue id changes. */
export type RushFx = 'none' | 'go' | 'good' | 'bad' | 'buzz' | 'boom' | 'tick' | 'win';

/** Pose indices (Copy the Pose / pose stream), from gravity only. */
export const RUSH_POSES = ['faceUp', 'faceDown', 'upright', 'upsideDown', 'leftEdge', 'rightEdge'] as const;
export type RushPose = (typeof RUSH_POSES)[number];

/** A per-player cue on the phone. A NEW `id` fires the triple cue once and restarts the phone's reaction timer. */
export interface RushCue {
  id: number;
  fx: RushFx;
  /** Giant word shown instead of `word` while this cue is up ('DRAW!', 'YANK!', 'OUT'). */
  word?: string;
  /** Full-screen background colour while the cue is up (absent = the player's colour). */
  bg?: string;
  /** Special phone visual: 'bomb' (Hot Potato holder), 'pose' (target pose = v), 'fish' (on the hook). */
  show?: 'bomb' | 'pose' | 'fish';
  /** 0..1 intensity (bomb pulse/tick speed) or the pose index for show:'pose'. */
  v?: number;
  /** Bot-only hints (ignored by the phone UI). Keep tiny. */
  hint?: number[];
}

/** Host → phone: the whole Party Rush view of one phone (sent when it changes; always < 1 KB). */
export interface RushPhoneMsg {
  t: 'mg';
  ph: RushPhase;
  /** Round id: bumps on every minigame start. Phone events + stream packets carry it; stale ones are dropped. */
  rid: number;
  /** Rounds played so far (1-based round number of the current/next minigame). */
  round: number;
  heat: number;
  /** Minigame id ('' between minigames). */
  g: string;
  name: string;
  /** One-line instruction (≤ ~8 words). */
  instr: string;
  demo: RushDemo | '';
  /** The giant word during play ('SHAKE!'). */
  word: string;
  /** What the phone must detect during 'count' + 'play' (detectors calibrate at GO). */
  s: RushStream | null;
  ev: RushEvent[];
  /** What a touch-fallback player does ('Mash the button!'). */
  touch: string;
  /** Countdown during ph:'count' (3,2,1, then 0 = GO). */
  cd: number;
  /** Whole seconds left in ph:'play' (-1 = n/a). */
  left: number;
  me: {
    st: RushMe;
    name: string;
    emoji: string;
    color: string;
    /** All-time points. */
    pts: number;
    /** Scoreboard rank (1-based, 0 = unranked). */
    rank: number;
    /** Party leader (may press NEXT). */
    lead: boolean;
    /** Team (team minigames only). */
    team?: number;
  };
  cue: RushCue | null;
  /** This player's round result (ph:'results'). */
  res: { place: number; pts: number; line: string } | null;
  /** Show the "Hold your phone tight!" card. */
  safe: boolean;
  /** The leader's NEXT button is live. */
  canNext: boolean;
  /** Sip mode line for the round results ('' = none). */
  sip: string;
}

/** Phone → host minigame message (relayed like every PhoneToHost control message). */
export interface MgFromPhone {
  t: 'mg';
  /**
   * 'here' = the join / come-back tap; 'away' = tab hidden; 'next' = leader NEXT; 'mode' = sensors (v=1) or
   * touch fallback (v=0); 'act' = activity heartbeat (≤ 1/s while the phone is hand-held or touched);
   * 'flick' | 'raise' | 'pose' | 'tap' = gesture events.
   */
  k: 'here' | 'away' | 'next' | 'mode' | 'act' | RushEvent;
  /** Round id from the latest RushPhoneMsg (ignored for here/away/next/mode). */
  rid: number;
  /** flick: strength 0..100; pose: pose index; mode: 1 sensors, 0 touch. */
  v?: number;
  /** flick direction, screen coords -100..100 (x right, y up). */
  x?: number;
  y?: number;
  /** Reaction time measured ON THE PHONE: ms since cue `c` arrived (only when a cue is up). */
  ms?: number;
  /** The cue id `ms` refers to. */
  c?: number;
}

// ----- Party Rush stream packet (phone -> server -> host) -----------------
// Phone sends:   [2, seq, rid, a, b, c]           (20 Hz, only while a minigame asks for a stream)
// Server relays: [2, seq, rid, a, b, c, playerId]
//   a, b, c   ints -1000..1000, meaning depends on RushPhoneMsg.s:
//     shake  a = shake energy 0..1000, b = shakes counted since GO (0..1000), c = 0
//     tilt   a = right tilt, b = forward tilt (±1000 ≈ ±30° from the neutral captured at GO), c = 0
//     still  a = movement right now 0..1000, b = 1 if the phone looks like it rests on a table, c = accumulated movement since GO 0..1000
//     pose   a = stable pose index (RUSH_POSES, -1 none), b = confidence 0..1000, c = 0
//     aim    a = x, b = y (±1000 = edge of the board; gyro-integrated, re-centred at each dart / double tap), c = 0
//     pitch  a = pitch in tenths of a degree (-900 = top edge pointing at the floor, 0 = level, 900 = up), b = c = 0
export type StreamPacket = [2, number, number, number, number, number];
export type RelayedStreamPacket = [2, number, number, number, number, number, string];

export interface DecodedStream {
  seq: number;
  rid: number;
  a: number;
  b: number;
  c: number;
}

export function encodeStream(seq: number, rid: number, a: number, b: number, c: number): StreamPacket {
  const k = (v: number): number => Math.round(Math.max(-1000, Math.min(1000, Number.isFinite(v) ? v : 0)));
  return [2, seq | 0, rid | 0, k(a), k(b), k(c)];
}

export function decodeStream(p: readonly unknown[]): DecodedStream | null {
  if (!Array.isArray(p) || p[0] !== 2 || p.length < 6) return null;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const k = (v: unknown): number => Math.max(-1000, Math.min(1000, n(v)));
  return { seq: n(p[1]), rid: n(p[2]), a: k(p[3]), b: k(p[4]), c: k(p[5]) };
}

export type HostToPhone = PhoneState | PhoneRaceStatus | PhoneFx | PhoneFightStatus | RushPhoneMsg;

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
  | { t: 'post'; action: 'next' | 'replay' | 'track' | 'lobby' | 'switch'; game?: GameId } // leader, results screen (replay = Rematch, track = Change Settings, switch = Switch Game)
  | { t: 'leader'; to: string } // leader hands over
  | { t: 'tips'; enabled: boolean } // leader toggles contextual tips
  | { t: 'leave' } // player leaves the party
  // ----- PARTY HUB additions -----
  | { t: 'game'; game: GameId } // leader picks the active game (lobby / setup / results)
  | { t: 'gsetup'; setup: Record<string, unknown> } // leader edits the active game's setup (smash: Partial<SmashSetup>)
  | { t: 'team'; team: number } // a player picks their team (team modes)
  | { t: 'practice_done' } // sandbox: "I'm ready" (leaves the practice)
  // ----- PARTY RUSH additions -----
  | MgFromPhone;

export type ServerToHost = HostWelcome | PlayerJoined | PlayerLeft | FromPhone | ServerError | Pong;
export type ServerToPhone = PhoneWelcome | ServerError | Pong | HostStatus | HostToPhone;
export type HostToServer = HostHello | HostSend | HostKick | Ping;
export type PhoneToServer = PhoneHello | Ping | PhoneToHost | InputPacket | FightInputPacket | StreamPacket;
