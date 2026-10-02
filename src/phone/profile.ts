/**
 * Player profile (name + racer) with local persistence and optimistic edits.
 * The host is authoritative; local choices are shown immediately and synced.
 */
import type { PhoneState } from '../net/protocol';
import { net } from './net';
import { lsGet, lsSet } from './settings';
import { state } from './store';

export const MAX_NAME = 12;
const OPTIMISTIC_MS = 1800;

export const profile = {
  name: (lsGet('kp.name') ?? '').slice(0, MAX_NAME),
  characterId: lsGet('kp.char') ?? '',
  /** Profile pushed to the host since the last `joined`. */
  synced: false,
  charAt: 0,
  readyLocal: false,
  readyAt: 0,
};

let nameTimer = 0;

export function defaultName(): string {
  const you = state.phone?.you;
  return you ? `Player ${you.slot + 1}` : 'Player';
}

function nameToSend(): string {
  const n = profile.name.trim().slice(0, MAX_NAME);
  return n || state.phone?.you?.name || defaultName();
}

function takenByOthers(ps: PhoneState | null, id: string): boolean {
  if (!ps || !id) return false;
  if (ps.you && ps.you.characterId === id) return false;
  return ps.takenCharacters.includes(id);
}

function sendProfile(): void {
  const ps = state.phone;
  let characterId = profile.characterId;
  if (!characterId || takenByOthers(ps, characterId)) characterId = ps?.you?.characterId ?? characterId;
  net.send({ t: 'profile', name: nameToSend(), characterId });
}

/** Call on every `joined` so the next snapshot re-syncs our saved profile. */
export function profileOnJoined(): void {
  profile.synced = false;
}

/** Call on every PhoneState. */
export function profileOnState(ps: PhoneState): void {
  const you = ps.you;
  if (!you || profile.synced) return;
  profile.synced = true;
  const wantName = profile.name.trim();
  const wantChar = profile.characterId;
  const nameDiff = wantName !== '' && wantName !== you.name;
  const charDiff = wantChar !== '' && wantChar !== you.characterId && !takenByOthers(ps, wantChar);
  if (nameDiff || charDiff) sendProfile();
}

export function setName(raw: string): void {
  profile.name = raw.slice(0, MAX_NAME);
  lsSet('kp.name', profile.name);
  clearTimeout(nameTimer);
  nameTimer = window.setTimeout(sendProfile, 350);
}

export function flushName(): void {
  if (nameTimer) {
    clearTimeout(nameTimer);
    nameTimer = 0;
    sendProfile();
  }
}

export function setCharacter(id: string): void {
  profile.characterId = id;
  profile.charAt = performance.now();
  lsSet('kp.char', id);
  sendProfile();
}

/** Racer to highlight: the local pick right after a tap, else the host's. */
export function shownCharacter(): string {
  const you = state.phone?.you;
  if (performance.now() - profile.charAt < OPTIMISTIC_MS || !you) return profile.characterId || you?.characterId || '';
  return you.characterId;
}

export function setReady(ready: boolean): void {
  profile.readyLocal = ready;
  profile.readyAt = performance.now();
  net.send({ t: 'ready', ready });
}

export function shownReady(): boolean {
  const you = state.phone?.you;
  if (performance.now() - profile.readyAt < OPTIMISTIC_MS || !you) return profile.readyLocal;
  return you.ready;
}

export function isTakenByOthers(id: string): boolean {
  return takenByOthers(state.phone, id);
}
