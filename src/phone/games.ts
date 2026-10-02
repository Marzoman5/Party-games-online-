/** Game catalogue on the phone (from `PhoneState.games`, with offline fallbacks). */
import type { GameId, GameInfo, SmashSetup } from '../net/protocol';
import { DEFAULT_SMASH_SETUP } from '../net/protocol';
import { activeGame, state } from './store';

export const FALLBACK_GAMES: GameInfo[] = [
  { id: 'kart', title: 'Kart Party', tagline: 'Drift, boost and bump to the finish line', emoji: '🏎️', color: '#ffb020', minPlayers: 1, maxPlayers: 4 },
  { id: 'smash', title: 'Smash Party', tagline: 'Knock your friends off the stage', emoji: '🥊', color: '#ff4d6d', minPlayers: 1, maxPlayers: 4 },
];

export function gameList(): GameInfo[] {
  const g = state.phone?.games;
  return g && g.length ? g : state.phone?.game ? FALLBACK_GAMES : [];
}

export function gameInfo(id: GameId): GameInfo {
  return gameList().find((g) => g.id === id) ?? FALLBACK_GAMES.find((g) => g.id === id) ?? FALLBACK_GAMES[0];
}

export function otherGame(id: GameId = activeGame()): GameId {
  const list = gameList();
  return list.find((g) => g.id !== id)?.id ?? (id === 'kart' ? 'smash' : 'kart');
}

/** The current Smash setup (host's `gameSetup`, sanitised over the defaults). */
export function smashSetup(): SmashSetup {
  const raw = (state.phone?.game === 'smash' ? state.phone?.gameSetup : null) ?? {};
  const s: SmashSetup = { ...DEFAULT_SMASH_SETUP };
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(DEFAULT_SMASH_SETUP) as (keyof SmashSetup)[]) {
    const v = r[k];
    if (typeof v === typeof DEFAULT_SMASH_SETUP[k]) (s as unknown as Record<string, unknown>)[k] = v;
  }
  return s;
}
