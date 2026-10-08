/**
 * PartyApp — the Party Hub host shell: wires the game modules (src/games/registry.ts), the relay
 * connection (HostNet), the party state machine (PartySession), the host overlays (HostUI),
 * TV mode / fullscreen / cursor (Display), host keyboard shortcuts, toasts and the
 * `window.__party` test hooks.
 */
import type { GameId, GameInfo, LobbyPlayer, PhoneState, RaceSetup, ScreenId } from '../net/protocol';
import { showToast } from '../ui/toast';
import type { GameModule } from '../engine/GameModule';
import { resolveApiBase, resolveWsUrl } from '../engine/config';
import { Display } from '../engine/display';
import { HostNet } from '../engine/net/HostNet';
import { RoomServer } from '../engine/net/rtc/RoomServer';
import { transportKind, wsLink, type LinkFactory } from '../net/link';
import { PartySession } from '../engine/PartySession';
import { HostUI } from './ui/HostUI';
import { armSfx } from './ui/sfx';

export interface PartyState {
  screen: ScreenId;
  room: string;
  joinUrl: string;
  tvMode: boolean;
  /** Active game's engine phase. */
  engine: string;
  players: LobbyPlayer[];
  tutorial: { step: number; total: number; acks: string[]; phase: 'steps' | 'ack' } | null;
  /** Kart race setup (legacy). */
  setup: RaceSetup;
  pause: PhoneState['pause'];
  gp: PhoneState['gp'];
  racesCompleted: number;
  // extras
  net: string;
  /** 'ws' (Node server) or 'rtc' (static site, WebRTC). */
  transport: 'ws' | 'rtc';
  /** WebRTC: signalling availability ('n/a' with the Node server). */
  joinService: string;
  soloActive: boolean;
  tipsEnabled: boolean;
  results: PhoneState['results'];
  /** seat (kart index / fighter index) → playerId of the current/last match. */
  karts: string[];
  // PARTY HUB
  game: GameId;
  games: GameInfo[];
  gameSetup: Record<string, unknown>;
  sandbox: { done: string[] } | null;
  resultsInfo: PhoneState['resultsInfo'];
  /** A lazy engine is loading (game switch in progress). */
  switching: GameId | null;
  tutorialsSeen: GameId[];
}

export interface PartyHooks {
  getState(): PartyState;
  setTvMode(on: boolean): void;
  skipTutorial(): void;
  /** Extras for tests / debugging. */
  howTo(): void;
  phoneState(playerId: string): PhoneState | null;
  /** Host-side game pick (same rules as the leader's `{t:'game'}`). Resolves when the switch is done. */
  pickGame(id: GameId): Promise<boolean>;
  /** Host Esc on the sandbox. */
  skipSandbox(): void;
  /** WebRTC room server internals (null with the Node server). */
  rtc(): ReturnType<RoomServer['debug']> | null;
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
  /** Static site only: this page's in-browser room server (WebRTC). Null with the Node server. */
  readonly roomServer: RoomServer | null;
  readonly display: Display;
  readonly ui: HostUI;
  private readonly offs: (() => void)[] = [];

  constructor(
    readonly modules: GameModule[],
    opts: PartyAppOptions = {},
  ) {
    // Transport: WebSocket to the Node server (`npm start`), or this page as the room server with
    // phones connected over WebRTC (static site). Everything below is the same for both.
    let openLink: LinkFactory;
    let apiBase = '';
    if (transportKind() === 'rtc') {
      this.roomServer = new RoomServer();
      openLink = this.roomServer.link;
    } else {
      this.roomServer = null;
      const wsUrl = opts.wsUrl ?? resolveWsUrl();
      apiBase = resolveApiBase(wsUrl);
      openLink = () => wsLink(wsUrl);
    }

    // The session needs the net port and the net needs the session's handlers: late-bind.
    let session!: PartySession;
    this.net = new HostNet(openLink, {
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
    session = new PartySession(modules, this.net, 'kart');
    this.session = session;
    session.transport = this.roomServer ? 'rtc' : 'ws';
    if (this.roomServer) this.roomServer.onstatus = (st) => session.onJoinService(st.anyUp);
    this.display = new Display((on) => {
      for (const m of modules) {
        if (!m.loaded) continue;
        try {
          m.setTvMode(on);
        } catch (err) {
          console.warn('[party] setTvMode failed', err);
        }
      }
    });
    this.ui = new HostUI({ session, display: this.display, apiBase, reclaim: () => this.net.reclaim() });
    (opts.mount ?? document.body).appendChild(this.ui.root);

    // Session → UI.
    this.offs.push(
      session.events.on('change', () => this.ui.render()),
      session.events.on('toast', (t) => showToast(t.message, t.kind)),
      session.events.on('tryIt', (t) => this.ui.tryIt(t.playerId, t.kind, t.label)),
      session.events.on('tutorialStep', () => this.ui.tutorialStep()),
      session.events.on('gameChanged', () => {
        // A freshly loaded engine picks up the current TV mode.
        try {
          session.game.setTvMode(this.display.tvMode);
        } catch {
          /* ignore */
        }
        this.ui.render();
      }),
      armSfx(),
    );

    window.addEventListener('keydown', this.onKey);
    this.offs.push(() => window.removeEventListener('keydown', this.onKey));

    this.installHooks();
    try {
      session.game.activate();
    } catch (err) {
      console.error('[party] activate failed', err);
    }
    // Host page reloaded while another game was active: bring it back.
    if (session.restoredGame && session.restoredGame !== session.gameId) void session.switchGame(session.restoredGame, false);
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
    try {
      if (s.game.onHostKey?.(e)) return;
    } catch (err) {
      console.error('[party] onHostKey failed', err);
    }
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
        } else if (s.screen === 'sandbox') {
          e.preventDefault();
          s.hostSkipSandbox();
        }
        // During matches the engine reports Esc via onPauseRequest.
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
        const r = s.results;
        let gameSetup: Record<string, unknown> = {};
        try {
          gameSetup = s.game.getSetup();
        } catch {
          /* ignore */
        }
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
            team: p.team,
            emoji: p.emoji,
          })),
          tutorial: t ? { step: Math.min(t.step, t.total - 1), total: t.total, acks: s.tutorialAcks, phase: t.phase } : null,
          setup: { ...s.setup },
          pause: s.pause ? { by: s.pause.by, votes: s.pause.voters.size, needed: s.resumeNeeded } : null,
          gp: s.gpView,
          racesCompleted: s.racesCompleted,
          net: s.netStatus,
          transport: s.transport,
          joinService: s.joinService,
          soloActive: s.soloActive,
          tipsEnabled: s.tipsEnabled,
          results: r ? { rows: r.rows, gpFinal: r.gpFinal } : null,
          karts: s.match ? [...s.match.playerOfSlot] : [],
          game: s.gameId,
          games: s.gameInfos,
          gameSetup,
          sandbox: s.sandboxView,
          resultsInfo: r ? r.info : null,
          switching: s.switching,
          tutorialsSeen: Array.from(s.tutorialsSeen),
        };
      },
      setTvMode: (on: boolean) => this.display.setTvMode(!!on),
      skipTutorial: () => s.hostSkipTutorial(),
      howTo: () => s.hostHowTo(),
      phoneState: (id: string) => {
        const p = s.player(id);
        return p ? s.sync.buildState(p) : null;
      },
      pickGame: async (id: GameId) => {
        if (id === s.gameId) {
          // Re-picking a drop-in game (Party Rush) from the hub jumps back into it.
          if (s.game.dropIn) s.hostPickGame(id);
          return true;
        }
        const where = s.screen;
        if (where !== 'lobby' && where !== 'title' && where !== 'setup' && where !== 'results') return false;
        return s.switchGame(id, where === 'setup' || where === 'results');
      },
      skipSandbox: () => s.hostSkipSandbox(),
      rtc: () => this.roomServer?.debug() ?? null,
    };
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.net.dispose();
    this.roomServer?.dispose();
    this.session.dispose();
    this.display.dispose();
    this.ui.dispose();
    if (window.__party) delete window.__party;
  }
}
