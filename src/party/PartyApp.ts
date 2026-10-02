/**
 * PartyApp — wires the engine (IGameHost), the relay connection (HostNet), the party state
 * machine (PartySession), the host overlays (HostUI), TV mode / fullscreen / cursor (Display),
 * host keyboard shortcuts, toasts and the `window.__party` test hooks.
 */
import type { IGameHost } from '../game/api';
import type { EnginePhase } from '../game/api';
import type { LobbyPlayer, PhoneState, RaceSetup, ScreenId } from '../net/protocol';
import { showToast } from '../ui/toast';
import { resolveApiBase, resolveWsUrl } from './config';
import { Display } from './display';
import { HostNet } from './net/HostNet';
import { PartySession } from './PartySession';
import { HostUI } from './ui/HostUI';
import { armSfx } from './ui/sfx';

export interface PartyState {
  screen: ScreenId;
  room: string;
  joinUrl: string;
  tvMode: boolean;
  engine: EnginePhase;
  players: LobbyPlayer[];
  tutorial: { step: number; total: number; acks: string[]; phase: 'steps' | 'ack' } | null;
  setup: RaceSetup;
  pause: PhoneState['pause'];
  gp: PhoneState['gp'];
  racesCompleted: number;
  // extras
  net: string;
  soloActive: boolean;
  tipsEnabled: boolean;
  results: PhoneState['results'];
  /** kart index → playerId of the current/last race. */
  karts: string[];
}

export interface PartyHooks {
  getState(): PartyState;
  setTvMode(on: boolean): void;
  skipTutorial(): void;
  /** Extras for tests / debugging. */
  howTo(): void;
  phoneState(playerId: string): PhoneState | null;
}

declare global {
  interface Window {
    __party?: PartyHooks;
  }
}

export interface PartyAppOptions {
  /** Element the `#party` overlay root is appended to (default document.body). */
  mount?: HTMLElement;
  wsUrl?: string;
}

export class PartyApp {
  readonly session: PartySession;
  readonly net: HostNet;
  readonly display: Display;
  readonly ui: HostUI;
  private readonly offs: (() => void)[] = [];

  constructor(
    readonly game: IGameHost,
    opts: PartyAppOptions = {},
  ) {
    const wsUrl = opts.wsUrl ?? resolveWsUrl();
    const apiBase = resolveApiBase(wsUrl);

    // The session needs the net port and the net needs the session's handlers: late-bind.
    let session!: PartySession;
    this.net = new HostNet(wsUrl, {
      onHosted: (w, first) => session.onHosted(w, first),
      onPlayerJoined: (p, rejoin) => session.onPlayerJoined(p, rejoin),
      onPlayerLeft: (p) => session.onPlayerLeft(p),
      onPhoneMessage: (p, m) => session.onPhoneMessage(p, m),
      onInput: (p, i) => session.onInput(p, i),
      onStatus: (st) => session.onNetStatus(st),
      onServerError: (e) => {
        if (e.code !== 'host_gone') console.warn('[party] server error', e);
      },
    });
    session = new PartySession(game, this.net);
    this.session = session;
    this.display = new Display(game);
    this.ui = new HostUI({ session, display: this.display, apiBase, reclaim: () => this.net.reclaim() });
    (opts.mount ?? document.body).appendChild(this.ui.root);

    // Engine callbacks.
    game.onPhaseChange = (ph) => {
      session.onEnginePhase(ph);
      this.ui.render();
    };
    game.onRaceComplete = (results) => session.onRaceComplete(results);
    game.onPauseRequest = () => session.onPauseRequest();
    game.onSoloExit = () => session.onSoloExit();

    // Session → UI.
    this.offs.push(
      session.events.on('change', () => this.ui.render()),
      session.events.on('toast', (t) => showToast(t.message, t.kind)),
      session.events.on('tryIt', (t) => this.ui.tryIt(t.playerId, t.kind)),
      session.events.on('tutorialStep', () => this.ui.tutorialStep()),
      armSfx(),
    );

    window.addEventListener('keydown', this.onKey);
    this.offs.push(() => window.removeEventListener('keydown', this.onKey));

    this.installHooks();
    try {
      game.showDemo();
    } catch (err) {
      console.error('[party] showDemo failed', err);
    }
    this.ui.renderNow();
    this.net.connect();
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.repeat && e.key !== 'Escape') return;
    const s = this.session;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    // In the legacy solo flow the engine owns the keyboard (except F for fullscreen).
    if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (s.soloActive && s.game.phase === 'soloMenu') return; // may be typing in a menu
      this.display.toggleFullscreen();
      return;
    }
    if (s.soloActive) return;
    switch (e.key) {
      case 'Enter':
        if (s.screen === 'title') {
          e.preventDefault();
          s.hostOpenSolo();
        }
        break;
      case 'Escape':
        if (s.screen === 'tutorial') {
          e.preventDefault();
          s.hostSkipTutorial();
        }
        // During races the engine reports Esc via onPauseRequest.
        break;
      case 't':
      case 'T':
        if (s.screen === 'title' || s.screen === 'lobby') this.display.toggleTv();
        break;
    }
  };

  private installHooks(): void {
    const s = this.session;
    window.__party = {
      getState: (): PartyState => {
        const t = s.tutorial;
        return {
          screen: s.screen,
          room: s.room,
          joinUrl: s.joinUrl,
          tvMode: this.display.tvMode,
          engine: s.game.phase,
          players: s.players.map((p) => ({
            playerId: p.playerId,
            slot: p.slot,
            name: p.name,
            characterId: p.characterId,
            ready: p.ready,
            connected: p.connected,
            isLeader: p.isLeader,
            tutorialDone: p.tutorialDone,
          })),
          tutorial: t ? { step: Math.min(t.step, t.total - 1), total: t.total, acks: s.tutorialAcks, phase: t.phase } : null,
          setup: { ...s.setup },
          pause: s.pause ? { by: s.pause.by, votes: s.pause.voters.size, needed: s.resumeNeeded } : null,
          gp: s.gpView,
          racesCompleted: s.racesCompleted,
          net: s.netStatus,
          soloActive: s.soloActive,
          tipsEnabled: s.tipsEnabled,
          results: s.results ? { rows: s.results.rows, gpFinal: s.results.gpFinal } : null,
          karts: s.race ? [...s.race.playerOfKart] : [],
        };
      },
      setTvMode: (on: boolean) => this.display.setTvMode(!!on),
      skipTutorial: () => s.hostSkipTutorial(),
      howTo: () => s.hostHowTo(),
      phoneState: (id: string) => {
        const p = s.player(id);
        return p ? s.sync.buildState(p) : null;
      },
    };
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.game.onPhaseChange = null;
    this.game.onRaceComplete = null;
    this.game.onPauseRequest = null;
    this.game.onSoloExit = null;
    this.net.dispose();
    this.session.dispose();
    this.display.dispose();
    this.ui.dispose();
    if (window.__party) delete window.__party;
  }
}
