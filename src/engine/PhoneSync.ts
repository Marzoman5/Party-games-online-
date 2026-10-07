/**
 * PhoneSync — builds each phone's personalised PhoneState and only sends it when it actually
 * changed (JSON diff per player), plus the active game's ~10 Hz status (`t:'race'` / `t:'fight'`)
 * during matches and the sandbox.
 */
import type { LobbyPlayer, PhoneState } from '../net/protocol';
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
    team: p.team,
    emoji: p.emoji,
  };
}

export class PhoneSync {
  private readonly lastState = new Map<string, string>();
  private readonly lastStatus = new Map<string, string>();
  private readonly forced = new Set<string>();
  private forceEveryone = false;
  private statusTimer = 0;

  constructor(
    private readonly s: PartySession,
    private readonly net: NetPort,
  ) {}

  /** Resend this player's state on the next sync even if unchanged (reconnect / rejected pick). */
  force(playerId: string): void {
    this.forced.add(playerId);
    this.lastStatus.delete(playerId);
    this.s.changed();
  }

  forceAll(): void {
    this.forceEveryone = true;
    this.lastStatus.clear();
    this.s.changed();
  }

  forget(playerId: string): void {
    this.lastState.delete(playerId);
    this.lastStatus.delete(playerId);
    this.forced.delete(playerId);
  }

  buildState(p: PlayerRec): PhoneState {
    const s = this.s;
    const players = s.players.map(lobbyView);
    const t = s.tutorial;
    const r = s.results;
    let gameSetup: Record<string, unknown> = {};
    try {
      gameSetup = s.game.getSetup();
    } catch {
      /* ignore */
    }
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
      results: r ? { rows: r.rows, gpFinal: r.gpFinal } : null,
      tipsEnabled: s.tipsEnabled,
      game: s.gameId,
      games: s.gameInfos,
      gameSetup,
      sandbox: s.sandboxView,
      resultsInfo: r ? r.info : null,
      watch: s.watchStatus(p),
      secure: s.https,
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

  /** Start the ~10 Hz per-phone status ticker (match / sandbox). */
  startStatus(): void {
    this.lastStatus.clear();
    window.clearInterval(this.statusTimer);
    this.statusTimer = window.setInterval(this.statusTick, RACE_STATUS_MS);
  }

  stopStatus(): void {
    window.clearInterval(this.statusTimer);
    this.statusTimer = 0;
  }

  /** @deprecated kart-era names. */
  startRaceStatus(): void {
    this.startStatus();
  }
  stopRaceStatus(): void {
    this.stopStatus();
  }

  private readonly statusTick = (): void => {
    const s = this.s;
    const m = s.match;
    if (!m) return;
    // Belt and braces: the engine may have skipped straight past 'loading' without a phase callback.
    if (s.screen === 'loading' && m.kind === 'match' && s.game.isLive()) {
      s.screen = 'race';
      s.changed();
    }
    if (!this.net.isOpen) return;
    for (const [id, seat] of m.slotOf) {
      const p = s.player(id);
      if (!p || !p.connected) continue;
      let msg;
      try {
        msg = s.game.status(seat);
      } catch {
        msg = null;
      }
      if (!msg) continue;
      const json = JSON.stringify(msg);
      if (this.lastStatus.get(id) !== json) {
        this.lastStatus.set(id, json);
        this.net.sendTo(id, msg);
      }
    }
  };

  dispose(): void {
    this.stopStatus();
    this.lastState.clear();
    this.lastStatus.clear();
  }
}
