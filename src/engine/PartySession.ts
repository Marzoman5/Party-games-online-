/**
 * PartySession — the authoritative party state machine (host side), game-agnostic.
 *
 *   title → lobby (game picker) → tutorial (first START of each game per session / on demand)
 *         → [sandbox: "try it" practice, games with `hasSandbox`] → setup → loading → race → results
 *                                                              ↘ paused ↗     (late joiners: 'waiting')
 *
 * It owns the players (lobby slots 0..15), the leader, ready flags, teams, the active game, the
 * tutorial runner, the sandbox, the pause vote and the seat ↔ playerId map of the running match.
 * It drives the active game ONLY through `GameModule` (src/engine/GameModule.ts) and talks to
 * phones only through the NetPort. Players, slots, leader and ready flags survive game switches.
 *
 * Phones get a personalised PhoneState whenever something relevant changes (diffed per player),
 * the module's ~10 Hz status during matches/sandbox, and module fx one-shots (see PhoneSync).
 *
 * PARTY RUSH: up to 16 players (Kart/Smash seat the first `maxPlayers` by join order, the rest watch),
 * and DROP-IN modules (`GameModule.dropIn`): picking one goes straight to screen 'race' with an empty
 * seat map; the module tracks its own roster and gets input/messages/player events by playerId.
 */
import { CHARACTERS } from '../kart/roster';
import {
  GAME_IDS,
  MAX_PLAYERS,
  PLAYER_EMOJIS,
  SLOT_COLORS,
  type GameId,
  type GameInfo,
  type HostToPhone,
  type HostWelcome,
  type PhoneToHost,
  type RaceSetup,
  type ResultRow,
  type ScreenId,
  type LobbyPlayer,
} from '../net/protocol';
import type { AnyInput, GameModule, MatchSeat, PlayerEvent, ResultsInfo, TryIt } from './GameModule';
import { funnyName } from './names';
import type { NetPort, NetStatus } from './net/HostNet';
import {
  STORAGE,
  SANDBOX_ALL_DONE_DELAY_MS,
  TUTORIAL_ACK_WAIT_MS,
  TUTORIAL_ALL_ACKED_DELAY_MS,
  Timers,
  storageGet,
  storageSet,
} from './config';
import { Emitter } from './emitter';
import { PhoneSync } from './PhoneSync';

export interface PlayerRec extends LobbyPlayer {
  team: number;
  /** PARTY RUSH: unique emoji (always set). */
  emoji: string;
  /** Join order (leader succession). */
  joinSeq: number;
  /** Joined while a match was running → 'waiting' until the next one. */
  late: boolean;
  /** Last input packet (lobby/tutorial "try it" edge detection). */
  lastInput: AnyInput | null;
}

export interface TutorialState {
  game: GameId;
  step: number; // 0..total-1 (clamped to the last step during the ack phase)
  total: number;
  phase: 'steps' | 'ack';
  /** Screen to go to afterwards. */
  next: 'setup' | 'sandbox' | 'lobby' | 'title' | 'results';
  /** ms timestamp when the current step / ack phase started (for UI progress bars). */
  stepStartedAt: number;
  ackDeadline: number;
}

/** The running match (or sandbox): seat index ↔ playerId. */
export interface MatchCtx {
  kind: 'match' | 'sandbox';
  game: GameId;
  /** playerId → seat (kart id / fighter index). */
  slotOf: Map<string, number>;
  /** seat → playerId. */
  playerOfSlot: string[];
  seats: MatchSeat[];
}

export interface PauseState {
  by: string;
  voters: Set<string>;
}

export interface ResultsState {
  game: GameId;
  rows: ResultRow[];
  gpFinal: boolean;
  info: ResultsInfo | null;
  /** Module-specific (kart: trackId). */
  meta: Record<string, unknown>;
}

export interface SandboxState {
  /** Players who tapped "I'm ready" (or left). */
  done: Set<string>;
}

export type TryItKind = 'drift' | 'item';

export interface SessionEvents extends Record<string, unknown> {
  change: void;
  tryIt: { playerId: string; kind: TryItKind; label: string };
  toast: { message: string; kind: 'info' | 'error' };
  tutorialStep: { step: number; phase: 'steps' | 'ack' };
  joined: { playerId: string };
  gameChanged: { game: GameId };
}

const RACE_SCREENS: ReadonlySet<ScreenId> = new Set<ScreenId>(['loading', 'race', 'paused']);
const NAME_MAX = 14;
const DEFAULT_RACE_SETUP: RaceSetup = { mode: 'single', trackId: 'sunny', cc: 150, laps: 3 };

interface Snapshot {
  players: { playerId: string; slot: number; name: string; characterId: string; joinSeq: number; leader: boolean; team?: number; emoji?: string }[];
  /** Kart setup (legacy field name). */
  setup?: RaceSetup;
  tipsEnabled: boolean;
  /** Legacy: kart tutorial seen. */
  tutorialSeen: boolean;
  tutorialsSeen?: GameId[];
  sandboxSeen?: boolean;
  racesCompleted: number;
  game?: GameId;
  setups?: Record<string, unknown>;
}

export class PartySession {
  readonly events = new Emitter<SessionEvents>();

  screen: ScreenId = 'title';
  room = '';
  joinUrl = '';
  urls: string[] = [];
  https = false;
  netStatus: NetStatus = 'connecting';
  hostedOnce = false;

  players: PlayerRec[] = [];
  tipsEnabled = true;
  /** Games whose tutorial was seen this session. */
  readonly tutorialsSeen = new Set<GameId>();
  /** The sandbox already ran this session. */
  sandboxSeen = false;
  tutorial: TutorialState | null = null;
  sandbox: SandboxState | null = null;
  pause: PauseState | null = null;
  results: ResultsState | null = null;
  match: MatchCtx | null = null;
  /** Matches completed this session (all games). */
  racesCompleted = 0;
  racesStarted = 0;
  /** Host is in a game's local keyboard mode (kart solo; party overlays hidden). */
  soloActive = false;
  /** A lazy game engine is loading (game switch in progress). */
  switching: GameId | null = null;

  /** Active game. */
  gameId: GameId;
  readonly modules: Record<GameId, GameModule>;

  private joinSeq = 0;
  readonly timers = new Timers();
  readonly sync: PhoneSync;
  private changeQueued = false;
  private disposed = false;

  constructor(
    modules: GameModule[],
    private readonly net: NetPort,
    defaultGame: GameId = 'kart',
  ) {
    const map = {} as Record<GameId, GameModule>;
    for (const m of modules) map[m.id] = m;
    this.modules = map;
    this.gameId = map[defaultGame] ? defaultGame : modules[0].id;
    this.sync = new PhoneSync(this, net);
    for (const m of modules) m.bind(this);
    this.restoreSnapshot();
  }

  // =================================================================== queries

  /** The active game module. */
  get game(): GameModule {
    return this.modules[this.gameId];
  }

  get gameInfos(): GameInfo[] {
    return GAME_IDS.filter((id) => this.modules[id]).map((id) => this.modules[id].info);
  }

  /** Kart race setup (legacy `PhoneState.setup`, `__party.setup`). */
  get setup(): RaceSetup {
    for (const id of GAME_IDS) {
      const m = this.modules[id];
      if (m?.raceSetup) return m.raceSetup();
    }
    return { ...DEFAULT_RACE_SETUP };
  }

  get tutorialSeen(): boolean {
    return this.tutorialsSeen.has(this.gameId);
  }

  player(id: string): PlayerRec | undefined {
    return this.players.find((p) => p.playerId === id);
  }

  get leader(): PlayerRec | undefined {
    return this.players.find((p) => p.isLeader);
  }

  get connectedPlayers(): PlayerRec[] {
    return this.players.filter((p) => p.connected);
  }

  /** Players seated in the current match/sandbox (by seat order). */
  get racers(): PlayerRec[] {
    if (!this.match) return [];
    const out: PlayerRec[] = [];
    for (const id of this.match.playerOfSlot) {
      const p = this.player(id);
      if (p) out.push(p);
    }
    return out;
  }

  /** The active game is a drop-in game (Party Rush) and its endless loop is running. */
  get dropInLive(): boolean {
    return !!this.game.dropIn && !!this.match && this.match.kind === 'match' && RACE_SCREENS.has(this.screen);
  }

  /**
   * Why a connected player is not in the running Kart/Smash match: 'full' (the match seats only the first
   * `maxPlayers` by join order) or 'late' (joined after it started). null when playing / not applicable.
   */
  watchStatus(p: PlayerRec): 'full' | 'late' | null {
    const m = this.match;
    if (this.game.dropIn || !m || m.kind !== 'match' || !RACE_SCREENS.has(this.screen) && this.screen !== 'results') return null;
    if (m.slotOf.has(p.playerId)) return null;
    return p.late ? 'late' : 'full';
  }

  /** Connected players watching the running match because it is full (TV chip). */
  get watchers(): PlayerRec[] {
    return this.connectedPlayers.filter((p) => this.watchStatus(p) === 'full');
  }

  /** Seated in the running match (not the sandbox). */
  isRacing(id: string): boolean {
    return !!this.match && this.match.kind === 'match' && this.match.slotOf.has(id) && RACE_SCREENS.has(this.screen);
  }

  /** What a given phone should show. */
  screenFor(p: PlayerRec): ScreenId {
    const s = this.screen;
    // Drop-in games: everyone connected plays (the module decides who takes part in each round).
    if (this.game.dropIn && RACE_SCREENS.has(s)) return 'race';
    if (RACE_SCREENS.has(s) && !(this.match && this.match.kind === 'match' && this.match.slotOf.has(p.playerId))) return 'waiting';
    // Joined after the lobby (e.g. during setup) and not ready yet: let them pick + ready up first.
    if (s === 'setup' && !p.ready) return 'lobby';
    // Not part of the practice: pick + ready in the lobby screen meanwhile.
    if (s === 'sandbox' && !(this.match && this.match.kind === 'sandbox' && this.match.slotOf.has(p.playerId))) return 'lobby';
    return s;
  }

  takenCharacters(exceptId?: string): string[] {
    return this.players.filter((p) => p.playerId !== exceptId).map((p) => p.characterId);
  }

  allConnectedReady(): boolean {
    const c = this.connectedPlayers;
    return c.length > 0 && c.every((p) => p.ready);
  }

  /** Votes needed to resume (majority of connected racers). */
  get resumeNeeded(): number {
    const n = this.racers.filter((p) => p.connected).length;
    return Math.max(1, Math.floor(n / 2) + 1);
  }

  get gpView(): { race: number; of: number } | null {
    return this.game.stateExtras?.().gp ?? null;
  }

  get tutorialAcks(): string[] {
    return this.players.filter((p) => p.tutorialDone).map((p) => p.playerId);
  }

  /** Sandbox view for phones / hooks. */
  get sandboxView(): { done: string[] } | null {
    if (this.screen !== 'sandbox' || !this.sandbox) return null;
    return { done: Array.from(this.sandbox.done) };
  }

  /** Seat of a player in the current match/sandbox, or undefined. */
  seatOf(id: string): number | undefined {
    return this.match?.slotOf.get(id);
  }

  // =================================================================== net events

  onNetStatus(s: NetStatus): void {
    this.netStatus = s;
    if (s === 'down' && this.screen === 'race' && this.match && this.game.canPause()) {
      // Phones can't steer while the relay is gone: freeze the match instead of letting it run on
      // stale input. Leader (or the host mouse) resumes once everyone's back.
      this.doPause('Connection lost');
    }
    this.changed();
  }

  onHosted(w: HostWelcome, firstTime: boolean): void {
    this.room = w.room;
    this.urls = w.urls;
    this.https = w.https;
    let join = w.joinUrl || '';
    if (!/^https?:\/\//.test(join)) join = `${window.location.origin}/play?room=${w.room}`;
    this.joinUrl = join;
    this.hostedOnce = true;

    const known = new Map(w.players.map((p) => [p.playerId, p.connected]));
    // Players the server knows: (re)attach. Others: mark disconnected (server restarted / evicted).
    for (const [id, connected] of known) {
      let p = this.player(id);
      if (!p) p = this.addPlayer(id) ?? undefined;
      if (p) p.connected = connected;
    }
    for (const p of this.players) {
      if (!known.has(p.playerId) && p.connected) this.markDisconnected(p, false);
    }
    if (this.match && this.match.kind === 'match' && RACE_SCREENS.has(this.screen)) {
      for (const p of this.racers) {
        const k = this.match.slotOf.get(p.playerId)!;
        this.safe(() => this.game.setSeatAI(k, !p.connected));
      }
    }
    if (firstTime && this.game.dropIn && this.game.loaded) {
      // Host reload with a drop-in game active (or picked before the first connection): straight back in.
      for (const p of this.players) p.ready = false;
      if (!this.dropInLive) this.startEndless();
    } else if (firstTime) {
      // Fresh page (or host reload): nothing is running yet.
      for (const p of this.players) p.ready = false;
      this.screen = this.players.length ? 'lobby' : 'title';
    } else if (this.screen === 'title' && this.players.length && !this.soloActive) {
      this.screen = 'lobby';
    }
    this.ensureLeader();
    this.sync.forceAll();
    if (this.game.dropIn) for (const p of this.players) this.playerEvent(p.playerId, p.connected ? 'rejoin' : 'leave');
    this.changed();
  }

  onPlayerJoined(id: string, rejoin: boolean): void {
    let p = this.player(id);
    const isNew = !p;
    if (!p) p = this.addPlayer(id) ?? undefined;
    if (!p) {
      // No lobby slot free (should not happen: server caps connected players).
      this.net.kick(id);
      return;
    }
    p.connected = true;
    p.lastInput = null;
    const m = this.match;
    if (this.dropInLive) {
      // The drop-in module announces joins itself.
    } else if (m && m.kind === 'match' && RACE_SCREENS.has(this.screen)) {
      const k = m.slotOf.get(id);
      if (k !== undefined) {
        this.safe(() => this.game.setSeatAI(k, false));
        if (!isNew) this.toast(`${p.name} is back in control!`);
      } else if (isNew) {
        p.late = true;
        p.ready = true; // they clearly want to play: they join the next match automatically
        this.toast(`${p.name} joined — they'll play next time`);
      }
    } else if (isNew && this.screen !== 'title' && this.screen !== 'lobby') {
      // (In the lobby the new card itself is the announcement.)
      this.toast(`${p.name} joined the party!`);
    } else if (rejoin && this.screen !== 'title' && this.screen !== 'lobby') {
      this.toast(`${p.name} reconnected`);
    }
    if (this.screen === 'title') this.screen = 'lobby';
    this.ensureLeader();
    this.checkPauseVotes();
    this.checkTutorialAcks();
    this.sync.force(id);
    this.playerEvent(id, isNew ? 'join' : 'rejoin');
    this.events.emit('joined', { playerId: id });
    this.changed();
  }

  onPlayerLeft(id: string): void {
    const p = this.player(id);
    if (!p || !p.connected) return;
    this.markDisconnected(p, true);
    this.playerEvent(id, 'leave');
    this.ensureLeader();
    this.checkPauseVotes();
    this.checkTutorialAcks();
    this.checkSandboxDone();
    this.changed();
  }

  onInput(id: string, input: AnyInput): void {
    if (this.game.dropIn) {
      if (this.dropInLive) {
        try {
          this.game.inputFrom?.(id, input);
        } catch (err) {
          console.error('[party] input failed', err);
        }
      }
      return;
    }
    const m = this.match;
    if (m && ((m.kind === 'match' && RACE_SCREENS.has(this.screen)) || (m.kind === 'sandbox' && this.screen === 'sandbox'))) {
      const k = m.slotOf.get(id);
      if (k !== undefined) {
        try {
          this.game.input(k, input);
        } catch (err) {
          console.error('[party] input failed', err);
        }
      }
    }
    const p = this.player(id);
    if (!p) return;
    if (this.screen === 'tutorial' || this.screen === 'lobby' || this.screen === 'setup') {
      let t: TryIt | null = null;
      try {
        t = this.game.tryIt(input, p.lastInput && p.lastInput.tag === input.tag ? p.lastInput : null);
      } catch {
        t = null;
      }
      if (t) this.events.emit('tryIt', { playerId: id, kind: t.kind, label: t.label });
    }
    p.lastInput = input;
  }

  onPhoneMessage(id: string, m: PhoneToHost): void {
    const p = this.player(id);
    if (!p) return;
    const lead = p.isLeader;
    switch (m.t) {
      case 'profile':
        this.setProfile(p, m.name, m.characterId);
        this.playerEvent(id, 'profile');
        break;
      case 'mg':
        // PARTY RUSH minigame channel: only meaningful while a drop-in game runs. High rate → no changed().
        if (this.dropInLive) {
          try {
            this.game.onMg?.(id, m);
          } catch (err) {
            console.error('[party] mg failed', err);
          }
        }
        return;
      case 'ready':
        if (!RACE_SCREENS.has(this.screen)) p.ready = !!m.ready;
        else if (p.late || !this.isRacing(id)) p.ready = !!m.ready;
        break;
      case 'howto':
        if (lead) this.startTutorial(false);
        break;
      case 'tut_ok':
        if (this.screen === 'tutorial') {
          p.tutorialDone = true;
          this.checkTutorialAcks();
        }
        break;
      case 'tut_skip':
        if (lead) this.finishTutorial();
        break;
      case 'setup':
        // Legacy kart setup message: applies to the kart module whatever game is active.
        if (lead && (this.screen === 'lobby' || this.screen === 'setup' || this.screen === 'results')) {
          const kart = this.modules.kart;
          if (kart) this.safe(() => kart.applySetup(m.setup));
        }
        break;
      case 'gsetup':
        if (lead && (this.screen === 'lobby' || this.screen === 'setup' || this.screen === 'results')) {
          this.safe(() => this.game.applySetup(m.setup));
        }
        break;
      case 'team':
        this.setTeam(p, m.team);
        break;
      case 'game':
        if (lead) this.pickGame(m.game);
        break;
      case 'practice_done':
        this.practiceDone(p);
        break;
      case 'start':
        if (lead) this.leaderStart();
        break;
      case 'pause':
        if (this.isRacing(id) && this.screen === 'race') this.doPause(p.name);
        break;
      case 'resume':
        if (this.screen !== 'paused' || !this.pause) break;
        if (lead) this.doResume();
        else if (this.match?.slotOf.has(id)) {
          this.pause.voters.add(id);
          this.checkPauseVotes();
        }
        break;
      case 'restart':
        if (lead) this.doRestart();
        break;
      case 'quit':
        if (lead && RACE_SCREENS.has(this.screen)) this.quitToLobby();
        break;
      case 'post':
        if (lead && this.screen === 'results') this.postAction(m.action, m.game);
        break;
      case 'leader': {
        const to = this.player(m.to);
        if (lead && to && to.connected && to !== p) {
          for (const q of this.players) q.isLeader = q === to;
          this.toast(`${to.name} is now the leader 👑`);
        } else this.sync.force(id);
        break;
      }
      case 'tips':
        if (lead) this.tipsEnabled = !!m.enabled;
        break;
      case 'leave':
        this.removePlayer(p, true);
        break;
      default:
        return;
    }
    this.changed();
  }

  // =================================================================== module callbacks

  /** The active module's engine phase changed. */
  onModulePhase(mod: GameModule): void {
    if (mod !== this.game) return;
    if (!this.soloActive) {
      if (this.screen === 'loading' && this.match?.kind === 'match' && mod.isLive()) this.screen = 'race';
      // Engine dropped the match on its own (error / demo): don't leave phones stuck in a race.
      if (!this.quitting && RACE_SCREENS.has(this.screen) && this.match?.kind === 'match' && mod.isStopped()) {
        this.toast('The match was stopped', 'error');
        this.toLobby(false);
      }
    }
    this.changed();
  }

  /** The active module finished a match. Rows are ordered by place. */
  onMatchComplete(mod: GameModule, rows: ResultRow[], opts: { gpFinal?: boolean; info?: ResultsInfo | null; meta?: Record<string, unknown> } = {}): void {
    if (mod !== this.game || this.soloActive || !this.match || this.match.kind !== 'match' || !RACE_SCREENS.has(this.screen)) return;
    this.results = { game: mod.id, rows, gpFinal: !!opts.gpFinal, info: opts.info ?? null, meta: opts.meta ?? {} };
    this.racesCompleted++;
    this.pause = null;
    this.screen = 'results';
    for (const p of this.players) p.late = false;
    this.sync.stopStatus();
    this.changed();
  }

  /** Host keyboard asked to pause (Esc/P during a match). */
  onPauseRequest(): void {
    if (this.soloActive) return;
    if (this.screen === 'race') this.doPause('Host');
    else if (this.screen === 'paused') this.doResume();
  }

  /** A game entered its local keyboard mode (kart solo menus). */
  onSoloStarted(): void {
    if (!this.soloActive) {
      this.soloActive = true;
      this.changed();
    }
  }

  /** The local keyboard flow returned to the title. */
  onSoloExit(): void {
    this.soloActive = false;
    this.screen = this.players.length ? 'lobby' : 'title';
    this.safe(() => this.game.showAttract());
    this.changed();
  }

  // =================================================================== host (mouse/keyboard) actions

  hostOpenSolo(): void {
    if (this.screen !== 'title' || this.soloActive) return;
    const kart = this.modules.kart as (GameModule & { openSolo?(): void }) | undefined;
    if (!kart?.openSolo) return;
    if (this.gameId !== 'kart') {
      if (!kart.loaded) return;
      this.activateGame('kart');
    }
    this.soloActive = true;
    this.safe(() => kart.openSolo!());
    this.changed();
  }

  hostHowTo(): void {
    this.startTutorial(false);
    this.changed();
  }

  hostSkipTutorial(): void {
    this.finishTutorial();
    this.changed();
  }

  hostSkipSandbox(): void {
    this.finishSandbox();
    this.changed();
  }

  hostStart(): void {
    this.leaderStart();
    this.changed();
  }

  hostResume(): void {
    if (this.screen === 'paused') this.doResume();
    this.changed();
  }

  hostRestart(): void {
    this.doRestart();
    this.changed();
  }

  hostQuit(): void {
    if (RACE_SCREENS.has(this.screen)) this.quitToLobby();
    this.changed();
  }

  hostPost(action: 'next' | 'replay' | 'track' | 'lobby' | 'switch', game?: GameId): void {
    if (this.screen === 'results') this.postAction(action, game);
    this.changed();
  }

  hostBackToLobby(): void {
    if (this.screen === 'setup') {
      this.screen = 'lobby';
      for (const p of this.players) p.ready = false;
    }
    this.changed();
  }

  hostRemovePlayer(id: string): void {
    const p = this.player(id);
    if (p && !p.connected) this.removePlayer(p, true);
    this.changed();
  }

  /** Host removes a player (connected or not): their phone is told and their seat is freed. */
  hostKickPlayer(id: string): void {
    const p = this.player(id);
    if (p) this.removePlayer(p, true);
    this.changed();
  }

  /** Host click on a game card (same rules as the leader's phone). */
  hostPickGame(id: GameId): void {
    this.pickGame(id);
    this.changed();
  }

  // =================================================================== game switching

  /**
   * Leader / host picks a game. Lobby & title: just switch the active game (the hub shows its attract
   * demo behind). Setup & results: switch and go to that game's tutorial (first time) or setup.
   */
  pickGame(id: GameId): void {
    if (!this.modules[id] || this.soloActive) return;
    const where = this.screen;
    if (where !== 'lobby' && where !== 'title' && where !== 'setup' && where !== 'results') return;
    if (id === this.gameId) {
      // Re-picking the active drop-in game from the hub jumps (back) into it.
      if (this.game.dropIn && this.game.loaded) this.startEndless();
      return;
    }
    void this.switchGame(id, where === 'setup' || where === 'results');
  }

  /** Switch the active game (loads lazy engines first). `proceed`: continue to tutorial/setup. */
  async switchGame(id: GameId, proceed: boolean): Promise<boolean> {
    const mod = this.modules[id];
    if (!mod || this.switching) return false;
    if (!mod.loaded) {
      this.switching = id;
      this.changed();
      try {
        await mod.load();
      } catch (err) {
        console.error(`[party] could not load ${id}`, err);
        this.switching = null;
        this.startQueued = false;
        this.toast(`${mod.info.title} couldn’t start on this computer — staying on ${this.game.info.title}`, 'error');
        this.changed();
        return false;
      }
      this.switching = null;
      if (this.disposed) return false;
    }
    const queued = this.startQueued;
    this.startQueued = false;
    if (queued) queueMicrotask(() => {
      if (!this.disposed && !this.switching) {
        this.leaderStart();
        this.changed();
      }
    });
    // Things may have moved on while loading.
    const where = this.screen;
    if (where !== 'lobby' && where !== 'title' && where !== 'setup' && where !== 'results') {
      this.changed();
      return false;
    }
    if (!this.activateGame(id)) {
      this.changed();
      return false;
    }
    this.results = null;
    this.match = null;
    this.pause = null;
    this.sync.stopStatus();
    if (mod.dropIn) {
      // Drop-in games start right away with whoever is there (even nobody: the TV shows the join QR).
      if (!this.soloActive && (this.hostedOnce || this.screen !== 'title')) this.startEndless();
    } else if (proceed && this.players.length) {
      if (!this.tutorialsSeen.has(id)) this.startTutorial(true);
      else this.screen = 'setup';
    }
    this.changed();
    return true;
  }

  /** Deactivate the current engine, activate `id`. Synchronous; the module must be loaded. */
  private activateGame(id: GameId): boolean {
    const next = this.modules[id];
    if (!next || !next.loaded) return false;
    if (id === this.gameId) return true;
    const prev = this.game;
    this.safe(() => prev.endSeries?.());
    this.safe(() => prev.deactivate());
    this.gameId = id;
    try {
      next.activate();
    } catch (err) {
      console.error(`[party] activating ${id} failed`, err);
      this.toast(`${next.info.title} couldn’t start — back to ${prev.info.title}`, 'error');
      this.safe(() => next.deactivate());
      this.gameId = prev.id;
      this.safe(() => prev.activate());
      return false;
    }
    this.events.emit('gameChanged', { game: id });
    this.sync.forceAll();
    return true;
  }

  // =================================================================== transitions

  /** Leader pressed START while a game engine was still loading: replay it once loading ends. */
  private startQueued = false;

  private leaderStart(): void {
    if (this.soloActive) return;
    if (this.switching) {
      this.startQueued = true;
      return;
    }
    if (this.game.dropIn && (this.screen === 'lobby' || this.screen === 'setup' || this.screen === 'results' || this.screen === 'tutorial')) {
      // Drop-in games never wait for ready-ups, tutorials or setup.
      if (this.screen === 'tutorial') this.finishTutorial();
      this.startEndless();
      return;
    }
    if (this.screen === 'lobby') {
      if (!this.allConnectedReady()) {
        this.sync.forceAll();
        return;
      }
      if (!this.tutorialSeen) this.startTutorial(true);
      else this.screen = 'setup';
    } else if (this.screen === 'setup') {
      this.startMatch((seats) => this.game.startFromSetup(seats));
    } else if (this.screen === 'tutorial') {
      this.finishTutorial();
    } else if (this.screen === 'sandbox') {
      this.finishSandbox();
    }
  }

  startTutorial(fromStart: boolean): void {
    if (this.soloActive || RACE_SCREENS.has(this.screen)) return;
    // Drop-in games explain themselves in 5 seconds per minigame: no tutorial screen.
    if (this.game.dropIn) return;
    if (this.screen === 'tutorial') return;
    if (this.screen === 'sandbox') this.finishSandbox();
    const mod = this.game;
    const next: TutorialState['next'] = fromStart
      ? mod.hasSandbox && mod.startSandbox && !this.sandboxSeen
        ? 'sandbox'
        : 'setup'
      : this.screen === 'results'
        ? 'results'
        : this.screen === 'title'
          ? 'title'
          : this.screen === 'setup'
            ? 'setup'
            : 'lobby';
    for (const p of this.players) p.tutorialDone = false;
    this.tutorial = {
      game: mod.id,
      step: 0,
      total: mod.tutorial.steps.length,
      phase: 'steps',
      next,
      stepStartedAt: performance.now(),
      ackDeadline: 0,
    };
    this.screen = 'tutorial';
    if (!this.results) this.safe(() => mod.showAttract());
    this.events.emit('tutorialStep', { step: 0, phase: 'steps' });
    const def = mod.tutorial;
    if (def.firstStepMs && def.firstStepMs !== def.stepMs) {
      this.timers.timeout('tutorial', def.firstStepMs, () => {
        this.tutorialTick();
        if (this.tutorial && this.tutorial.phase === 'steps' && this.screen === 'tutorial') {
          this.timers.interval('tutorial', def.stepMs, () => this.tutorialTick());
        }
      });
    } else this.timers.interval('tutorial', def.stepMs, () => this.tutorialTick());
  }

  private tutorialTick(): void {
    const t = this.tutorial;
    if (!t || this.screen !== 'tutorial') {
      this.timers.clear('tutorial');
      return;
    }
    if (t.step < t.total - 1) {
      t.step++;
      t.stepStartedAt = performance.now();
      this.events.emit('tutorialStep', { step: t.step, phase: 'steps' });
    } else {
      this.timers.clear('tutorial');
      t.phase = 'ack';
      t.stepStartedAt = performance.now();
      t.ackDeadline = performance.now() + TUTORIAL_ACK_WAIT_MS;
      this.events.emit('tutorialStep', { step: t.step, phase: 'ack' });
      this.timers.timeout('tutorialAck', TUTORIAL_ACK_WAIT_MS, () => {
        this.finishTutorial();
        this.changed();
      });
      this.checkTutorialAcks();
    }
    this.changed();
  }

  private checkTutorialAcks(): void {
    if (this.screen !== 'tutorial' || !this.tutorial) return;
    const c = this.connectedPlayers;
    if (c.length === 0 || !c.every((p) => p.tutorialDone)) return;
    if (this.timers.has('tutorialAllAcked')) return;
    this.timers.timeout('tutorialAllAcked', TUTORIAL_ALL_ACKED_DELAY_MS, () => {
      this.finishTutorial();
      this.changed();
    });
  }

  finishTutorial(): void {
    if (this.screen !== 'tutorial' || !this.tutorial) return;
    this.timers.clear('tutorial');
    this.timers.clear('tutorialAck');
    this.timers.clear('tutorialAllAcked');
    const next = this.tutorial.next;
    const game = this.tutorial.game;
    this.tutorial = null;
    // Only counts as "seen" if phones were there to see it (a host demo from the title doesn't).
    if (this.connectedPlayers.length > 0) this.tutorialsSeen.add(game);
    if (next === 'title') this.screen = this.players.length ? 'lobby' : 'title';
    else if (next === 'results' && this.results) this.screen = 'results';
    else if (next === 'sandbox' && this.players.length) {
      if (!this.startSandbox()) this.screen = 'setup';
    } else if ((next === 'setup' || next === 'sandbox') && this.players.length) this.screen = 'setup';
    else this.screen = this.players.length ? 'lobby' : 'title';
  }

  // ------------------------------------------------------------------ sandbox

  private startSandbox(): boolean {
    const mod = this.game;
    if (!mod.startSandbox) return false;
    const humans = this.connectedPlayers
      .filter((p) => !p.late)
      .sort((a, b) => a.joinSeq - b.joinSeq)
      .slice(0, mod.info.maxPlayers)
      .sort((a, b) => a.slot - b.slot);
    if (!humans.length) return false;
    const seats = humans.map((p) => this.seatFor(p));
    try {
      mod.startSandbox(seats);
    } catch (err) {
      console.error('[party] startSandbox failed', err);
      this.toast('Practice couldn’t start — straight to setup', 'error');
      return false;
    }
    this.sandboxSeen = true;
    this.match = this.makeMatch('sandbox', seats);
    this.sandbox = { done: new Set() };
    this.screen = 'sandbox';
    this.sync.startStatus();
    return true;
  }

  private practiceDone(p: PlayerRec): void {
    if (this.screen !== 'sandbox' || !this.sandbox || !this.match) return;
    if (this.sandbox.done.has(p.playerId)) return;
    this.sandbox.done.add(p.playerId);
    const seat = this.match.slotOf.get(p.playerId);
    if (seat !== undefined) this.safe(() => this.game.retireFromSandbox?.(seat));
    this.checkSandboxDone();
  }

  private checkSandboxDone(): void {
    if (this.screen !== 'sandbox' || !this.sandbox || !this.match) return;
    const seated = this.racers.filter((p) => p.connected);
    if (seated.length > 0 && !seated.every((p) => this.sandbox!.done.has(p.playerId))) return;
    if (this.timers.has('sandboxDone')) return;
    this.timers.timeout('sandboxDone', SANDBOX_ALL_DONE_DELAY_MS, () => {
      this.finishSandbox();
      this.changed();
    });
  }

  /** Leave the sandbox → setup. */
  finishSandbox(): void {
    if (this.screen !== 'sandbox') return;
    this.timers.clear('sandboxDone');
    this.sync.stopStatus();
    this.sandbox = null;
    this.match = null;
    this.safe(() => (this.game.stopSandbox ? this.game.stopSandbox() : this.game.showAttract()));
    this.screen = this.players.length ? 'setup' : 'title';
  }

  // ------------------------------------------------------------------ match

  private seatFor(p: PlayerRec): MatchSeat {
    return { playerId: p.playerId, name: p.name, characterId: p.characterId, slot: p.slot, color: SLOT_COLORS[p.slot], team: p.team };
  }

  private makeMatch(kind: MatchCtx['kind'], seats: MatchSeat[]): MatchCtx {
    const slotOf = new Map<string, number>();
    seats.forEach((s, i) => slotOf.set(s.playerId, i));
    return { kind, game: this.gameId, slotOf, playerOfSlot: seats.map((s) => s.playerId), seats };
  }

  /**
   * Seats for a new match: connected + ready + not late; with more players than the game seats, the
   * first `maxPlayers` by JOIN ORDER play (the rest watch this one). Seats are then ordered by slot.
   */
  matchSeats(): MatchSeat[] {
    return this.players
      .filter((p) => p.connected && p.ready && !p.late)
      .sort((a, b) => a.joinSeq - b.joinSeq)
      .slice(0, Math.min(MAX_PLAYERS, this.game.info.maxPlayers))
      .sort((a, b) => a.slot - b.slot)
      .map((p) => this.seatFor(p));
  }

  /** Start a match via `starter(seats)` (the module builds + starts its engine). */
  private startMatch(starter: (seats: MatchSeat[]) => boolean): boolean {
    const seats = this.matchSeats();
    if (seats.length === 0) {
      this.toast('Nobody is ready to play — ready up on your phone!', 'error');
      return false;
    }
    const prevScreen = this.screen;
    const prevMatch = this.match;
    const prevResults = this.results;
    this.match = this.makeMatch('match', seats);
    this.pause = null;
    this.results = null;
    this.tutorial = null;
    this.timers.clear('tutorial');
    this.screen = 'loading';
    for (const p of this.players) {
      p.late = false;
      p.lastInput = null;
    }
    let ok = false;
    try {
      ok = starter(seats);
    } catch (err) {
      console.error('[party] start failed', err);
      this.toast('Could not start — try other settings', 'error');
      ok = false;
    }
    if (!ok) {
      this.match = prevMatch;
      this.results = prevResults;
      this.screen = prevScreen === 'results' && prevResults ? 'results' : 'setup';
      if (this.screen === 'setup') this.match = null;
      return false;
    }
    this.racesStarted++;
    if (this.screen === 'loading' && this.game.isLive()) this.screen = 'race';
    this.sync.startStatus();
    return true;
  }

  /** Enter a drop-in game's endless loop (screen 'race', empty seat map). Idempotent. */
  private startEndless(): void {
    const mod = this.game;
    if (!mod.dropIn || this.soloActive) return;
    if (this.dropInLive) return;
    this.timers.clear('tutorial');
    this.timers.clear('tutorialAck');
    this.timers.clear('tutorialAllAcked');
    this.tutorial = null;
    this.sandbox = null;
    this.pause = null;
    this.results = null;
    this.match = this.makeMatch('match', []);
    for (const p of this.players) {
      p.late = false;
      p.lastInput = null;
    }
    this.screen = 'race';
    this.racesStarted++;
    try {
      mod.startEndless?.();
    } catch (err) {
      console.error('[party] startEndless failed', err);
      this.toast(`${mod.info.title} couldn’t start`, 'error');
      this.match = null;
      this.screen = this.players.length ? 'lobby' : 'title';
    }
    this.sync.forceAll();
  }

  /** Deliver a party player event to the active drop-in module. */
  private playerEvent(id: string, ev: PlayerEvent): void {
    if (!this.game.dropIn) return;
    try {
      this.game.onPlayer?.(id, ev);
    } catch (err) {
      console.error('[party] onPlayer failed', err);
    }
  }

  private doPause(by: string): void {
    if (this.screen !== 'race' || !this.game.canPause()) return;
    this.safe(() => this.game.pause());
    this.pause = { by, voters: new Set() };
    this.screen = 'paused';
  }

  private doResume(): void {
    if (this.screen !== 'paused') return;
    this.pause = null;
    this.screen = 'race';
    this.safe(() => this.game.resume());
  }

  private checkPauseVotes(): void {
    if (this.screen !== 'paused' || !this.pause) return;
    for (const v of Array.from(this.pause.voters)) {
      const p = this.player(v);
      if (!p || !p.connected) this.pause.voters.delete(v);
    }
    if (this.pause.voters.size >= this.resumeNeeded && this.pause.voters.size > 0) this.doResume();
  }

  private doRestart(): void {
    if (!this.match || this.match.kind !== 'match' || !RACE_SCREENS.has(this.screen)) return;
    this.pause = null;
    this.screen = 'loading';
    for (const p of this.players) p.lastInput = null;
    this.safe(() => this.game.restart());
    if (this.screen === 'loading' && this.game.isLive()) this.screen = 'race';
    this.sync.startStatus();
  }

  /** True while we ask the engine to quit (its phase drop is expected, not an error). */
  private quitting = false;

  private quitToLobby(): void {
    this.quitting = true;
    try {
      this.safe(() => this.game.quit());
    } finally {
      this.quitting = false;
    }
    this.toLobby(true);
  }

  private toLobby(showAttract: boolean): void {
    this.safe(() => this.game.endSeries?.());
    this.sync.stopStatus();
    this.pause = null;
    this.results = null;
    this.match = null;
    this.sandbox = null;
    this.tutorial = null;
    this.timers.clear('tutorial');
    for (const p of this.players) {
      p.ready = false;
      p.late = false;
    }
    this.screen = this.players.length ? 'lobby' : 'title';
    if (showAttract) this.safe(() => this.game.showAttract());
  }

  private postAction(action: 'next' | 'replay' | 'track' | 'lobby' | 'switch', game?: GameId): void {
    switch (action) {
      case 'next':
      case 'replay':
        this.startMatch((seats) => this.game.post(action, seats));
        break;
      case 'track':
        this.safe(() => this.game.endSeries?.());
        this.results = null;
        this.match = null;
        this.screen = 'setup';
        this.safe(() => this.game.showAttract());
        break;
      case 'lobby':
        this.toLobby(true);
        break;
      case 'switch': {
        const target = game && game !== this.gameId && this.modules[game] ? game : this.otherGame();
        if (target) void this.switchGame(target, true);
        break;
      }
    }
  }

  /** The next game in the registry after the active one (fallback when a 'switch' names no game). */
  otherGame(): GameId | null {
    const ids = GAME_IDS.filter((id) => this.modules[id]);
    if (ids.length < 2) return null;
    return ids[(ids.indexOf(this.gameId) + 1) % ids.length];
  }

  // =================================================================== players

  private addPlayer(id: string): PlayerRec | null {
    let slot = this.freeSlot();
    if (slot < 0) {
      // Evict the oldest disconnected seat (mirrors the server's policy).
      const stale = this.players.filter((p) => !p.connected).sort((a, b) => a.joinSeq - b.joinSeq)[0];
      if (!stale) return null;
      this.removePlayer(stale, false);
      slot = this.freeSlot();
      if (slot < 0) return null;
    }
    const snap = this.snapshotPlayers.get(id);
    const taken = new Set(this.takenCharacters());
    let characterId = snap && !taken.has(snap.characterId) ? snap.characterId : '';
    if (!characterId) {
      // First free racer, rotated by slot so player 2 doesn't always get the 2nd roster entry.
      const order = [0, 3, 5, 2, 1, 4, 6, 7];
      for (const i of order) {
        const c = CHARACTERS[(i + slot * 3) % CHARACTERS.length];
        if (!taken.has(c.id)) {
          characterId = c.id;
          break;
        }
      }
    }
    // More players than racers (> 8): duplicates are fine — Kart/Smash only seat the first 4 anyway.
    if (!characterId) characterId = CHARACTERS[(slot * 3) % CHARACTERS.length].id;
    const realSlot = snap && this.slotFree(snap.slot) ? snap.slot : slot;
    const usedEmoji = new Set(this.players.map((q) => q.emoji));
    let emoji = snap?.emoji && !usedEmoji.has(snap.emoji) ? snap.emoji : '';
    if (!emoji) {
      const free = PLAYER_EMOJIS.filter((e) => !usedEmoji.has(e));
      emoji = free.length ? free[Math.floor(Math.random() * free.length)] : PLAYER_EMOJIS[realSlot % PLAYER_EMOJIS.length];
    }
    const p: PlayerRec = {
      playerId: id,
      slot: realSlot,
      name: snap?.name || funnyName(this.players.map((q) => q.name)),
      emoji,
      characterId,
      ready: false,
      connected: false,
      isLeader: false,
      tutorialDone: false,
      team: typeof snap?.team === 'number' ? snap.team : realSlot % 2,
      joinSeq: snap?.joinSeq ?? ++this.joinSeq,
      late: false,
      lastInput: null,
    };
    if (snap?.leader && !this.leader) p.isLeader = true;
    this.joinSeq = Math.max(this.joinSeq, p.joinSeq);
    this.players.push(p);
    this.players.sort((a, b) => a.slot - b.slot);
    return p;
  }

  private removePlayer(p: PlayerRec, kick: boolean): void {
    if (this.match && this.match.kind === 'match' && RACE_SCREENS.has(this.screen)) {
      const k = this.match.slotOf.get(p.playerId);
      if (k !== undefined) this.safe(() => this.game.setSeatAI(k, true));
    }
    if (this.match && this.match.kind === 'sandbox' && this.sandbox) {
      const k = this.match.slotOf.get(p.playerId);
      if (k !== undefined && !this.sandbox.done.has(p.playerId)) {
        this.sandbox.done.add(p.playerId);
        this.safe(() => this.game.retireFromSandbox?.(k));
      }
    }
    this.players = this.players.filter((q) => q !== p);
    this.sync.forget(p.playerId);
    if (kick) this.net.kick(p.playerId);
    this.playerEvent(p.playerId, 'remove');
    if (p.isLeader) {
      p.isLeader = false;
      this.ensureLeader();
    }
    if (this.players.length === 0 && (this.screen === 'lobby' || this.screen === 'setup' || this.screen === 'sandbox')) {
      if (this.screen === 'sandbox') this.finishSandbox();
      this.screen = 'title';
    }
    this.checkPauseVotes();
    this.checkTutorialAcks();
    this.checkSandboxDone();
  }

  private markDisconnected(p: PlayerRec, announce: boolean): void {
    p.connected = false;
    p.lastInput = null;
    const m = this.match;
    if (m && m.kind === 'match' && RACE_SCREENS.has(this.screen)) {
      const k = m.slotOf.get(p.playerId);
      if (k !== undefined) {
        this.safe(() => this.game.setSeatAI(k, true));
        if (announce) this.toast(`${p.name} disconnected — ${this.gameId === 'kart' ? 'AI is driving' : 'CPU takes over'}`, 'error');
        return;
      }
    }
    if (m && m.kind === 'sandbox' && this.sandbox && m.slotOf.has(p.playerId) && !this.sandbox.done.has(p.playerId)) {
      this.sandbox.done.add(p.playerId);
      const k = m.slotOf.get(p.playerId)!;
      this.safe(() => this.game.retireFromSandbox?.(k));
    }
    // Drop-in games: leaving is silent (the module greys the player out).
    if (announce && !this.dropInLive) this.toast(`${p.name} disconnected`, 'error');
  }

  private ensureLeader(): void {
    const cur = this.leader;
    if (cur && cur.connected) return;
    const next = this.connectedPlayers.sort((a, b) => a.joinSeq - b.joinSeq)[0];
    if (!next) return; // nobody connected: keep the crown where it is
    for (const p of this.players) p.isLeader = p === next;
    if (cur && cur !== next) this.toast(`${next.name} is now the leader 👑`);
  }

  private freeSlot(): number {
    for (let s = 0; s < MAX_PLAYERS; s++) if (this.slotFree(s)) return s;
    return -1;
  }

  private slotFree(s: number): boolean {
    return s >= 0 && s < MAX_PLAYERS && !this.players.some((p) => p.slot === s);
  }

  private setProfile(p: PlayerRec, rawName: unknown, rawChar: unknown): void {
    if (typeof rawName === 'string') {
      // eslint-disable-next-line no-control-regex
      const name = rawName.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, NAME_MAX);
      p.name = name || p.name || funnyName(this.players.map((q) => q.name));
    }
    if (typeof rawChar === 'string' && rawChar !== p.characterId) {
      const valid = CHARACTERS.some((c) => c.id === rawChar);
      const taken = this.takenCharacters(p.playerId).includes(rawChar);
      if (valid && !taken) p.characterId = rawChar;
      else this.sync.force(p.playerId); // reject: resend their state so the phone snaps back
    }
  }

  private setTeam(p: PlayerRec, raw: unknown): void {
    if (RACE_SCREENS.has(this.screen) && this.isRacing(p.playerId)) return;
    if (raw !== 0 && raw !== 1) {
      this.sync.force(p.playerId);
      return;
    }
    p.team = raw;
  }

  // =================================================================== plumbing

  /** Send a message to one phone (modules use it for fx). */
  send(playerId: string, m: HostToPhone): void {
    this.net.sendTo(playerId, m);
  }

  /** The player seated at `seat` of the current match/sandbox, if connected. */
  connectedAtSeat(seat: number): PlayerRec | undefined {
    const id = this.match?.playerOfSlot[seat];
    const p = id ? this.player(id) : undefined;
    return p && p.connected ? p : undefined;
  }

  toast(message: string, kind: 'info' | 'error' = 'info'): void {
    this.events.emit('toast', { message, kind });
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error('[party] engine call failed', err);
    }
  }

  /** Something changed: re-render host UI + diff/send phone states (coalesced per microtask). */
  changed(): void {
    if (this.changeQueued || this.disposed) return;
    this.changeQueued = true;
    queueMicrotask(() => {
      this.changeQueued = false;
      if (this.disposed) return;
      this.sync.syncStates();
      this.saveSnapshot();
      this.events.emit('change', undefined);
    });
  }

  private snapshotPlayers = new Map<string, Snapshot['players'][number]>();
  /** Game to re-activate after a host reload (applied by PartyApp once engines are ready). */
  restoredGame: GameId | null = null;

  private restoreSnapshot(): void {
    const raw = storageGet('session', STORAGE.session);
    if (!raw) return;
    try {
      const s = JSON.parse(raw) as Partial<Snapshot>;
      if (Array.isArray(s.players)) for (const p of s.players) this.snapshotPlayers.set(p.playerId, p);
      if (s.setups && typeof s.setups === 'object') {
        for (const id of GAME_IDS) {
          const m = this.modules[id];
          if (m && (s.setups as Record<string, unknown>)[id] !== undefined) this.safe(() => m.restore((s.setups as Record<string, unknown>)[id]));
        }
      } else if (s.setup && this.modules.kart) this.safe(() => this.modules.kart.applySetup(s.setup));
      if (typeof s.tipsEnabled === 'boolean') this.tipsEnabled = s.tipsEnabled;
      if (Array.isArray(s.tutorialsSeen)) {
        for (const g of s.tutorialsSeen) if (GAME_IDS.includes(g)) this.tutorialsSeen.add(g);
      } else if (s.tutorialSeen === true) this.tutorialsSeen.add('kart');
      if (typeof s.sandboxSeen === 'boolean') this.sandboxSeen = s.sandboxSeen;
      if (typeof s.racesCompleted === 'number') this.racesCompleted = s.racesCompleted;
      if (s.game && GAME_IDS.includes(s.game) && this.modules[s.game]) this.restoredGame = s.game;
    } catch {
      /* corrupt snapshot: ignore */
    }
  }

  private saveSnapshot(): void {
    const setups: Record<string, unknown> = {};
    for (const id of GAME_IDS) {
      const m = this.modules[id];
      if (m) {
        try {
          setups[id] = m.snapshot();
        } catch {
          /* ignore */
        }
      }
    }
    const snap: Snapshot = {
      players: this.players.map((p) => ({
        playerId: p.playerId,
        slot: p.slot,
        name: p.name,
        characterId: p.characterId,
        joinSeq: p.joinSeq,
        leader: p.isLeader,
        team: p.team,
        emoji: p.emoji,
      })),
      setup: this.setup,
      tipsEnabled: this.tipsEnabled,
      tutorialSeen: this.tutorialsSeen.has('kart'),
      tutorialsSeen: Array.from(this.tutorialsSeen),
      sandboxSeen: this.sandboxSeen,
      racesCompleted: this.racesCompleted,
      game: this.gameId,
      setups,
    };
    for (const p of snap.players) this.snapshotPlayers.set(p.playerId, p);
    storageSet('session', STORAGE.session, JSON.stringify(snap));
  }

  dispose(): void {
    this.disposed = true;
    this.timers.clearAll();
    this.sync.dispose();
    this.events.clear();
  }
}
