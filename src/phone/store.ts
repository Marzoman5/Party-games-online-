/** Tiny observable app store: connection + latest host snapshots. */
import type { GameId, PhoneFightStatus, PhoneRaceStatus, PhoneState, RushPhoneMsg, ServerError } from '../net/protocol';

/** Phone-local connection errors of the WebRTC transport (never on the wire; see ErrorView). */
export interface LinkError {
  t: 'error';
  /** no_direct: the WebRTC connection to the host failed. no_signal: the joining services are unreachable. */
  code: 'no_direct' | 'no_signal';
  message: string;
}

export type ConnPhase = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface AppState {
  /** Room code ('' = none chosen yet -> join screen). */
  room: string;
  conn: ConnPhase;
  /** True after `joined` on the current socket. */
  joined: boolean;
  playerId: string | null;
  /** Last measured round trip (ms). */
  rtt: number | null;
  /** Host page connected to the server (from `host` messages). */
  hostConnected: boolean;
  /** Fatal-ish error from the server that stops auto-reconnect. */
  error: ServerError | LinkError | null;
  phone: PhoneState | null;
  race: PhoneRaceStatus | null;
  /** performance.now() of the last race status. */
  raceAt: number;
  /** PARTY HUB: last Smash Party fight status (`t:'fight'`). */
  fight: PhoneFightStatus | null;
  fightAt: number;
  /** PARTY RUSH: last minigame-channel view of this phone (`t:'mg'`). */
  rush: RushPhoneMsg | null;
  /** performance.now() when `rush` arrived. */
  rushAt: number;
}

export const state: AppState = {
  room: '',
  conn: 'idle',
  joined: false,
  playerId: null,
  rtt: null,
  hostConnected: true,
  error: null,
  phone: null,
  race: null,
  raceAt: 0,
  fight: null,
  fightAt: 0,
  rush: null,
  rushAt: 0,
};

type Listener = (changed: Partial<AppState>) => void;
const listeners = new Set<Listener>();

export function setState(patch: Partial<AppState>): void {
  Object.assign(state, patch);
  listeners.forEach((fn) => fn(patch));
}

export function subscribe(fn: Listener): void {
  listeners.add(fn);
}

/** Which top-level view the phone should show. */
export type ViewId =
  | 'join'
  | 'error'
  | 'connecting'
  | 'title'
  | 'lobby'
  | 'tutorial'
  | 'setup'
  | 'loading'
  | 'race'
  | 'paused'
  | 'results'
  | 'waiting'
  | 'sandbox';

export function currentView(): ViewId {
  if (!state.room) return 'join';
  if (state.error) return state.error.code === 'no_room' ? 'join' : 'error';
  if (!state.phone) return 'connecting';
  return state.phone.screen;
}

/** The active game (PARTY HUB `PhoneState.game`; a pre-hub host = kart). */
export function activeGame(): GameId {
  const g = state.phone?.game;
  return g === 'smash' || g === 'rush' ? g : 'kart';
}
