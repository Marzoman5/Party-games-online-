/**
 * PhoneSync — builds each phone's personalised PhoneState and only sends it when it
 * actually changed (JSON diff per player), plus the ~10 Hz PhoneRaceStatus during races.
 */
import type { LobbyPlayer, PhoneRaceStatus, PhoneState } from '../net/protocol';
import type { NetPort } from './net/HostNet';
import type { PartySession, PlayerRec } from './PartySession';
import { RACE_STATUS_MS } from './config';

function lobbyView(p: PlayerRec): LobbyPlayer {
  return {
    playerId: p.playerId,
    slot: p.slot,
    name: p.name,
    characterId: p.characterId,
    ready: p.ready,
    connected: p.connected,
    isLeader: p.isLeader,
    tutorialDone: p.tutorialDone,
  };
}

export class PhoneSync {
  private readonly lastState = new Map<string, string>();
  private readonly lastRace = new Map<string, string>();
  private readonly forced = new Set<string>();
  private forceEveryone = false;
  private raceTimer = 0;

  constructor(
    private readonly s: PartySession,
    private readonly net: NetPort,
  ) {}

  /** Resend this player's state on the next sync even if unchanged (reconnect / rejected pick). */
  force(playerId: string): void {
    this.forced.add(playerId);
    this.lastRace.delete(playerId);
    this.s.changed();
  }

  forceAll(): void {
    this.forceEveryone = true;
    this.lastRace.clear();
    this.s.changed();
  }

  forget(playerId: string): void {
    this.lastState.delete(playerId);
    this.lastRace.delete(playerId);
    this.forced.delete(playerId);
  }

  buildState(p: PlayerRec): PhoneState {
    const s = this.s;
    const players = s.players.map(lobbyView);
    const t = s.tutorial;
    return {
      t: 'state',
      screen: s.screenFor(p),
      room: s.room,
      you: lobbyView(p),
      players,
      takenCharacters: s.takenCharacters(p.playerId),
      setup: { ...s.setup },
      gp: s.gpView,
      tutorial: t ? { step: Math.min(t.step, t.total - 1), total: t.total } : null,
      pause: s.pause ? { by: s.pause.by, votes: s.pause.voters.size, needed: s.resumeNeeded } : null,
      results: s.results ? { rows: s.results.rows, gpFinal: s.results.gpFinal } : null,
      tipsEnabled: s.tipsEnabled,
    };
  }

  syncStates(): void {
    if (!this.net.isOpen) return; // HostNet re-syncs everyone (forceAll) after reconnecting
    for (const p of this.s.players) {
      if (!p.connected) continue;
      const msg = this.buildState(p);
      const json = JSON.stringify(msg);
      const id = p.playerId;
      if (this.forceEveryone || this.forced.has(id) || this.lastState.get(id) !== json) {
        this.lastState.set(id, json);
        this.net.sendTo(id, msg);
      }
    }
    this.forced.clear();
    this.forceEveryone = false;
  }

  startRaceStatus(): void {
    this.lastRace.clear();
    window.clearInterval(this.raceTimer);
    this.raceTimer = window.setInterval(this.raceTick, RACE_STATUS_MS);
  }

  stopRaceStatus(): void {
    window.clearInterval(this.raceTimer);
    this.raceTimer = 0;
  }

  private readonly raceTick = (): void => {
    const s = this.s;
    const race = s.race;
    if (!race) return;
    // Belt and braces: engine may have skipped straight past 'loading' without a phase callback.
    if (s.screen === 'loading') {
      const ph = s.game.phase;
      if (ph === 'intro' || ph === 'countdown' || ph === 'racing' || ph === 'finished') {
        s.screen = 'race';
        s.changed();
      }
    }
    if (!this.net.isOpen) return;
    const phase = s.game.phase;
    for (const [id, k] of race.kartOf) {
      const p = s.player(id);
      if (!p || !p.connected) continue;
      let st;
      try {
        st = s.game.getSlotStatus(k);
      } catch {
        st = null;
      }
      if (!st) continue;
      let countdown = st.countdown;
      if (phase === 'loading' || phase === 'intro') countdown = 3;
      else if (phase !== 'countdown') countdown = 0;
      const msg: PhoneRaceStatus = {
        t: 'race',
        place: st.place,
        lap: st.lap,
        laps: st.laps,
        item: st.item,
        itemCount: st.itemCount,
        roulette: st.roulette,
        driftStage: st.driftStage,
        countdown,
        finished: st.finished,
        ai: st.aiControlled,
      };
      const json = JSON.stringify(msg);
      if (this.lastRace.get(id) !== json) {
        this.lastRace.set(id, json);
        this.net.sendTo(id, msg);
      }
    }
  };

  dispose(): void {
    this.stopRaceStatus();
    this.lastState.clear();
    this.lastRace.clear();
  }
}
