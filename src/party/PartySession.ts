/**
 * PartySession — the authoritative party state machine (host side).
 *
 *   title → lobby → tutorial (first START of the session / on demand) → setup → loading → race → results
 *                                                              ↘ paused ↗          (late joiners: 'waiting')
 *
 * It owns the players (lobby slots 0..3), the leader, ready flags, the race setup, the GP,
 * the pause vote, and the kartIndex ↔ playerId map of the running race. It drives the engine
 * only through IGameHost and talks to phones only through the NetPort.
 *
 * Phones get a personalised PhoneState whenever something relevant changes (diffed per player),
 * a PhoneRaceStatus at ~10 Hz during races, and PhoneFx one-shots from the engine event bus
 * (see PhoneSync / RaceFx).
 */
import { CHARACTERS, getCharacter } from '../kart/roster';
import { TRACKS } from '../track/tracks/index';
import {
  MAX_PLAYERS,
  SLOT_COLORS,
  type DecodedInput,
  type EngineCC,
  type HostWelcome,
  type LobbyPlayer,
  type PhoneToHost,
  type RaceSetup,
  type ResultRow,
  type ScreenId,
} from '../net/protocol';
import type { EnginePhase, HumanDriver, IGameHost, PartyRaceConfig, RaceResult } from '../game/api';
import type { NetPort, NetStatus } from './net/HostNet';
import {
  STORAGE,
  TUTORIAL_ACK_WAIT_MS,
  TUTORIAL_ALL_ACKED_DELAY_MS,
  TUTORIAL_STEPS,
  TUTORIAL_STEP_MS,
  Timers,
  storageGet,
  storageSet,
} from './config';
import { Emitter } from './emitter';
import { GrandPrix } from './gp';
import { PhoneSync } from './PhoneSync';
import { RaceFx } from './RaceFx';

export interface PlayerRec extends LobbyPlayer {
  /** Join order (leader succession). */
  joinSeq: number;
  /** Joined while a race was running → 'waiting' until the next race. */
  late: boolean;
  /** For tutorial/lobby "try it" reactions. */
  lastDrift: boolean;
  lastItemPresses: number | null;
}

export interface TutorialState {
  step: number; // 0..TUTORIAL_STEPS-1 (clamped to the last step during the ack phase)
  total: number;
  phase: 'steps' | 'ack';
  /** Screen to go to afterwards. */
  next: 'setup' | 'lobby' | 'title' | 'results';
  /** ms timestamp when the current step / ack phase started (for UI progress bars). */
  stepStartedAt: number;
  ackDeadline: number;
}

export interface RaceCtx {
  cfg: PartyRaceConfig;
  /** playerId → kart index. */
  kartOf: Map<string, number>;
  /** kart index → playerId. */
  playerOfKart: string[];
  trackId: string;
}

export interface PauseState {
  by: string;
  voters: Set<string>;
}

export interface ResultsState {
  rows: ResultRow[];
  gpFinal: boolean;
  trackId: string;
}

export type TryItKind = 'drift' | 'item';

export interface SessionEvents extends Record<string, unknown> {
  change: void;
  tryIt: { playerId: string; kind: TryItKind };
  toast: { message: string; kind: 'info' | 'error' };
  tutorialStep: { step: number; phase: 'steps' | 'ack' };
  joined: { playerId: string };
}

const RACE_SCREENS: ReadonlySet<ScreenId> = new Set<ScreenId>(['loading', 'race', 'paused']);
const PAUSABLE: ReadonlySet<EnginePhase> = new Set<EnginePhase>(['intro', 'countdown', 'racing', 'finished']);
const RACING_PHASES: ReadonlySet<EnginePhase> = new Set<EnginePhase>(['intro', 'countdown', 'racing', 'finished']);
const NAME_MAX = 14;

interface Snapshot {
  players: { playerId: string; slot: number; name: string; characterId: string; joinSeq: number; leader: boolean }[];
  setup: RaceSetup;
  tipsEnabled: boolean;
  tutorialSeen: boolean;
  racesCompleted: number;
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
  setup: RaceSetup = { mode: 'single', trackId: TRACKS[0].id, cc: 150, laps: 3 };
  tipsEnabled = true;
  tutorialSeen = false;
  tutorial: TutorialState | null = null;
  pause: PauseState | null = null;
  results: ResultsState | null = null;
  gp: GrandPrix | null = null;
  race: RaceCtx | null = null;
  racesCompleted = 0;
  racesStarted = 0;
  /** Host is in the legacy keyboard solo flow (party overlays hidden). */
  soloActive = false;
  enginePhase: EnginePhase;

  private joinSeq = 0;
  private readonly timers = new Timers();
  readonly sync: PhoneSync;
  private readonly fx: RaceFx;
  private changeQueued = false;
  private disposed = false;

  constructor(
    readonly game: IGameHost,
    private readonly net: NetPort,
  ) {
    this.enginePhase = game.phase;
    this.sync = new PhoneSync(this, net);
    this.fx = new RaceFx(this, net);
    this.restoreSnapshot();
  }

  // =================================================================== queries

  player(id: string): PlayerRec | undefined {
    return this.players.find((p) => p.playerId === id);
  }

  get leader(): PlayerRec | undefined {
    return this.players.find((p) => p.isLeader);
  }

  get connectedPlayers(): PlayerRec[] {
    return this.players.filter((p) => p.connected);
  }

  /** Players driving in the current race (by kart index order). */
  get racers(): PlayerRec[] {
    if (!this.race) return [];
    const out: PlayerRec[] = [];
    for (const id of this.race.playerOfKart) {
      const p = this.player(id);
      if (p) out.push(p);
    }
    return out;
  }

  isRacing(id: string): boolean {
    return !!this.race && this.race.kartOf.has(id) && RACE_SCREENS.has(this.screen);
  }

  /** What a given phone should show. */
  screenFor(p: PlayerRec): ScreenId {
    const s = this.screen;
    if (RACE_SCREENS.has(s) && !(this.race && this.race.kartOf.has(p.playerId))) return 'waiting';
    // Joined after the lobby (e.g. during setup) and not ready yet: let them pick + ready up first.
    if (s === 'setup' && !p.ready) return 'lobby';
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
    return this.gp ? { race: this.gp.race, of: this.gp.of } : null;
  }

  get tutorialAcks(): string[] {
    return this.players.filter((p) => p.tutorialDone).map((p) => p.playerId);
  }

  // =================================================================== net events

  onNetStatus(s: NetStatus): void {
    this.netStatus = s;
    if (s === 'down' && this.screen === 'race' && this.race && PAUSABLE.has(this.game.phase)) {
      // Phones can't steer while the relay is gone: freeze the race instead of letting karts
      // drive on their last input. Leader (or the host mouse) resumes once everyone's back.
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
    if (this.race && RACE_SCREENS.has(this.screen)) {
      for (const p of this.racers) {
        const k = this.race.kartOf.get(p.playerId)!;
        this.safe(() => this.game.setSlotAI(k, !p.connected));
      }
    }
    if (firstTime) {
      // Fresh page (or host reload): nothing is running yet.
      for (const p of this.players) p.ready = false;
      this.screen = this.players.length ? 'lobby' : 'title';
    } else if (this.screen === 'title' && this.players.length && !this.soloActive) {
      this.screen = 'lobby';
    }
    this.ensureLeader();
    this.sync.forceAll();
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
    p.lastItemPresses = null;
    p.lastDrift = false;
    if (this.race && RACE_SCREENS.has(this.screen)) {
      const k = this.race.kartOf.get(id);
      if (k !== undefined) {
        this.safe(() => this.game.setSlotAI(k, false));
        if (!isNew) this.toast(`${p.name} is back in control!`);
      } else if (isNew) {
        p.late = true;
        p.ready = true; // they clearly want to play: they join the next race automatically
        this.toast(`${p.name} joined — they'll race next time`);
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
    this.events.emit('joined', { playerId: id });
    this.changed();
  }

  onPlayerLeft(id: string): void {
    const p = this.player(id);
    if (!p || !p.connected) return;
    this.markDisconnected(p, true);
    this.ensureLeader();
    this.checkPauseVotes();
    this.checkTutorialAcks();
    this.changed();
  }

  onInput(id: string, input: DecodedInput): void {
    const race = this.race;
    if (race && RACE_SCREENS.has(this.screen)) {
      const k = race.kartOf.get(id);
      if (k !== undefined) this.game.setHumanInput(k, input);
    }
    const p = this.player(id);
    if (!p) return;
    if (this.screen === 'tutorial' || this.screen === 'lobby' || this.screen === 'setup') {
      if (input.drift && !p.lastDrift) this.events.emit('tryIt', { playerId: id, kind: 'drift' });
      // First packet after (re)connect: the counter starts at 0 on a fresh phone.
      if (input.itemPresses !== (p.lastItemPresses ?? 0)) {
        this.events.emit('tryIt', { playerId: id, kind: 'item' });
      }
    }
    p.lastDrift = input.drift;
    p.lastItemPresses = input.itemPresses;
  }

  onPhoneMessage(id: string, m: PhoneToHost): void {
    const p = this.player(id);
    if (!p) return;
    const lead = p.isLeader;
    switch (m.t) {
      case 'profile':
        this.setProfile(p, m.name, m.characterId);
        break;
      case 'ready':
        if (this.screen !== 'loading' && this.screen !== 'race' && this.screen !== 'paused') p.ready = !!m.ready;
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
        if (lead && (this.screen === 'lobby' || this.screen === 'setup' || this.screen === 'results')) {
          this.applySetup(m.setup);
        }
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
        else if (this.race?.kartOf.has(id)) {
          this.pause.voters.add(id);
          this.checkPauseVotes();
        }
        break;
      case 'restart':
        if (lead) this.doRestart();
        break;
      case 'quit':
        if (lead && (this.screen === 'paused' || this.screen === 'race' || this.screen === 'loading')) this.quitToLobby();
        break;
      case 'post':
        if (lead && this.screen === 'results') this.postAction(m.action);
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

  // =================================================================== engine events

  onEnginePhase(phase: EnginePhase): void {
    this.enginePhase = phase;
    if (phase === 'soloMenu' && !this.soloActive) this.soloActive = true;
    if (!this.soloActive) {
      if (this.screen === 'loading' && RACING_PHASES.has(phase)) this.screen = 'race';
      // Engine dropped the race on its own (error / demo): don't leave phones stuck in a race.
      if (RACE_SCREENS.has(this.screen) && (phase === 'demo' || phase === 'idle') && this.race) {
        this.toast('The race was stopped', 'error');
        this.toLobby(false);
      }
    }
    this.changed();
  }

  onRaceComplete(results: RaceResult[]): void {
    if (this.soloActive || !this.race || !RACE_SCREENS.has(this.screen)) return;
    const race = this.race;
    const sorted = [...results].sort((a, b) => a.place - b.place);
    const keys: string[] = [];
    let rows: ResultRow[] = sorted.map((r) => {
      const pid = r.slot >= 0 ? race.playerOfKart[r.kartId] ?? race.playerOfKart[r.slot] : undefined;
      const p = pid ? this.player(pid) : undefined;
      keys.push(pid ? `p:${pid}` : `ai:${r.name}`);
      return {
        place: r.place,
        name: p ? p.name : r.name,
        characterId: r.characterId,
        color: p ? SLOT_COLORS[p.slot] : r.color,
        time: r.time,
        slot: p ? p.slot : -1,
      };
    });
    let gpFinal = false;
    if (this.gp) {
      rows = this.gp.record(rows, keys);
      gpFinal = this.gp.isFinalRace;
    }
    this.results = { rows, gpFinal, trackId: race.trackId };
    this.racesCompleted++;
    this.pause = null;
    this.screen = 'results';
    for (const p of this.players) p.late = false;
    this.sync.stopRaceStatus();
    this.changed();
  }

  onPauseRequest(): void {
    if (this.soloActive) return;
    if (this.screen === 'race') this.doPause('Host');
    else if (this.screen === 'paused') this.doResume();
  }

  onSoloExit(): void {
    this.soloActive = false;
    this.screen = this.players.length ? 'lobby' : 'title';
    this.safe(() => this.game.showDemo());
    this.changed();
  }

  // =================================================================== host (mouse/keyboard) actions

  hostOpenSolo(): void {
    if (this.screen !== 'title' || this.soloActive) return;
    this.soloActive = true;
    this.safe(() => this.game.openSoloMenu());
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

  hostPost(action: 'next' | 'replay' | 'track' | 'lobby'): void {
    if (this.screen === 'results') this.postAction(action);
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

  // =================================================================== transitions

  private leaderStart(): void {
    if (this.soloActive) return;
    if (this.screen === 'lobby') {
      if (!this.allConnectedReady()) {
        this.sync.forceAll();
        return;
      }
      if (!this.tutorialSeen) this.startTutorial(true);
      else this.screen = 'setup';
    } else if (this.screen === 'setup') {
      if (this.setup.mode === 'gp') {
        this.gp = new GrandPrix(TRACKS.length);
        this.startRace(TRACKS[0].id);
      } else {
        this.gp = null;
        this.startRace(this.setup.trackId);
      }
    } else if (this.screen === 'tutorial') {
      this.finishTutorial();
    }
  }

  startTutorial(fromStart: boolean): void {
    if (this.soloActive || RACE_SCREENS.has(this.screen)) return;
    if (this.screen === 'tutorial') return;
    const next: TutorialState['next'] = fromStart
      ? 'setup'
      : this.screen === 'results'
        ? 'results'
        : this.screen === 'title'
          ? 'title'
          : this.screen === 'setup'
            ? 'setup'
            : 'lobby';
    for (const p of this.players) p.tutorialDone = false;
    this.tutorial = {
      step: 0,
      total: TUTORIAL_STEPS,
      phase: 'steps',
      next,
      stepStartedAt: performance.now(),
      ackDeadline: 0,
    };
    this.screen = 'tutorial';
    if (this.game.phase !== 'demo' && this.game.phase !== 'results') this.safe(() => this.game.showDemo());
    this.events.emit('tutorialStep', { step: 0, phase: 'steps' });
    this.timers.interval('tutorial', TUTORIAL_STEP_MS, () => this.tutorialTick());
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
    this.tutorial = null;
    // Only counts as "seen" if phones were there to see it (a host demo from the title doesn't).
    if (this.connectedPlayers.length > 0) this.tutorialSeen = true;
    if (next === 'title') this.screen = this.players.length ? 'lobby' : 'title';
    else if (next === 'results' && this.results) this.screen = 'results';
    else if (next === 'setup' && this.players.length) this.screen = 'setup';
    else this.screen = this.players.length ? 'lobby' : 'title';
  }

  startRace(trackId: string): boolean {
    const humans = this.players
      .filter((p) => p.connected && p.ready && !p.late)
      .sort((a, b) => a.slot - b.slot)
      .slice(0, MAX_PLAYERS);
    if (humans.length === 0) {
      this.toast('Nobody is ready to race — ready up on your phone!', 'error');
      return false;
    }
    const drivers: HumanDriver[] = humans.map((p) => ({
      playerId: p.playerId,
      name: p.name,
      characterId: p.characterId,
      color: SLOT_COLORS[p.slot],
      source: 'phone',
    }));
    const cfg: PartyRaceConfig = {
      trackId,
      cc: this.setup.cc,
      laps: this.setup.laps,
      humans: drivers,
      showTips: this.tipsEnabled && this.racesCompleted === 0,
      introFlyover: true,
      ui: 'party',
    };
    const kartOf = new Map<string, number>();
    humans.forEach((p, i) => kartOf.set(p.playerId, i));
    this.race = { cfg, kartOf, playerOfKart: humans.map((p) => p.playerId), trackId };
    this.pause = null;
    this.results = null;
    this.tutorial = null;
    this.timers.clear('tutorial');
    this.screen = 'loading';
    this.racesStarted++;
    for (const p of this.players) {
      p.late = false;
      p.lastItemPresses = null;
    }
    try {
      this.game.startRace(cfg);
    } catch (err) {
      console.error('[party] startRace failed', err);
      this.toast('Could not start the race — try another track', 'error');
      this.race = null;
      this.screen = 'setup';
      return false;
    }
    if (this.screen === 'loading' && RACING_PHASES.has(this.game.phase)) this.screen = 'race';
    this.sync.startRaceStatus();
    return true;
  }

  private doPause(by: string): void {
    if (this.screen !== 'race' || !PAUSABLE.has(this.game.phase)) return;
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
    if (!this.race || !RACE_SCREENS.has(this.screen)) return;
    this.pause = null;
    this.screen = 'loading';
    for (const p of this.players) p.lastItemPresses = null;
    this.safe(() => this.game.restartRace());
    if (this.screen === 'loading' && RACING_PHASES.has(this.game.phase)) this.screen = 'race';
    this.sync.startRaceStatus();
  }

  private quitToLobby(): void {
    this.safe(() => this.game.quitRace());
    this.toLobby(true);
  }

  private toLobby(showDemo: boolean): void {
    this.sync.stopRaceStatus();
    this.pause = null;
    this.results = null;
    this.race = null;
    this.gp = null;
    this.tutorial = null;
    this.timers.clear('tutorial');
    for (const p of this.players) {
      p.ready = false;
      p.late = false;
    }
    this.screen = this.players.length ? 'lobby' : 'title';
    if (showDemo) this.safe(() => this.game.showDemo());
  }

  private postAction(action: 'next' | 'replay' | 'track' | 'lobby'): void {
    const last = this.results?.trackId ?? this.setup.trackId;
    switch (action) {
      case 'next': {
        if (this.gp) {
          if (this.gp.isFinalRace) {
            this.gp = new GrandPrix(TRACKS.length);
            this.startRace(TRACKS[0].id);
          } else {
            this.gp.race++;
            this.startRace(TRACKS[(this.gp.race - 1) % TRACKS.length].id);
          }
        } else {
          const i = TRACKS.findIndex((t) => t.id === last);
          const next = TRACKS[(i + 1) % TRACKS.length].id;
          this.setup = { ...this.setup, trackId: next };
          this.startRace(next);
        }
        break;
      }
      case 'replay':
        // GP: re-running the same race overwrites that race's points.
        this.startRace(last);
        break;
      case 'track':
        this.gp = null;
        this.results = null;
        this.race = null;
        this.screen = 'setup';
        this.safe(() => this.game.showDemo());
        break;
      case 'lobby':
        this.toLobby(true);
        break;
    }
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
      // Prefer the racer whose colour best matches nothing in particular: just the first free, rotated by slot
      // so player 2 doesn't always get the 2nd roster entry by default.
      const order = [0, 3, 5, 2, 1, 4, 6, 7];
      for (const i of order) {
        const c = CHARACTERS[(i + slot * 3) % CHARACTERS.length];
        if (!taken.has(c.id)) {
          characterId = c.id;
          break;
        }
      }
    }
    if (!characterId) characterId = CHARACTERS[0].id;
    const p: PlayerRec = {
      playerId: id,
      slot: snap && this.slotFree(snap.slot) ? snap.slot : slot,
      name: snap?.name || `Player ${slot + 1}`,
      characterId,
      ready: false,
      connected: false,
      isLeader: false,
      tutorialDone: false,
      joinSeq: snap?.joinSeq ?? ++this.joinSeq,
      late: false,
      lastDrift: false,
      lastItemPresses: null,
    };
    if (snap?.leader && !this.leader) p.isLeader = true;
    this.joinSeq = Math.max(this.joinSeq, p.joinSeq);
    this.players.push(p);
    this.players.sort((a, b) => a.slot - b.slot);
    return p;
  }

  private removePlayer(p: PlayerRec, kick: boolean): void {
    if (this.race && RACE_SCREENS.has(this.screen)) {
      const k = this.race.kartOf.get(p.playerId);
      if (k !== undefined) this.safe(() => this.game.setSlotAI(k, true));
    }
    this.players = this.players.filter((q) => q !== p);
    this.sync.forget(p.playerId);
    if (kick) this.net.kick(p.playerId);
    if (p.isLeader) {
      p.isLeader = false;
      this.ensureLeader();
    }
    if (this.players.length === 0 && (this.screen === 'lobby' || this.screen === 'setup')) {
      this.screen = 'title';
    }
    this.checkPauseVotes();
    this.checkTutorialAcks();
  }

  private markDisconnected(p: PlayerRec, announce: boolean): void {
    p.connected = false;
    p.lastDrift = false;
    p.lastItemPresses = null;
    if (this.race && RACE_SCREENS.has(this.screen)) {
      const k = this.race.kartOf.get(p.playerId);
      if (k !== undefined) {
        this.safe(() => this.game.setSlotAI(k, true));
        if (announce) this.toast(`${p.name} disconnected — AI is driving`, 'error');
        return;
      }
    }
    if (announce) this.toast(`${p.name} disconnected`, 'error');
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
      p.name = name || `Player ${p.slot + 1}`;
    }
    if (typeof rawChar === 'string' && rawChar !== p.characterId) {
      const valid = CHARACTERS.some((c) => c.id === rawChar);
      const taken = this.takenCharacters(p.playerId).includes(rawChar);
      if (valid && !taken) p.characterId = rawChar;
      else this.sync.force(p.playerId); // reject: resend their state so the phone snaps back
    }
  }

  private applySetup(s: Partial<RaceSetup> | undefined): void {
    if (!s || typeof s !== 'object') return;
    const next = { ...this.setup };
    if (s.mode === 'single' || s.mode === 'gp') next.mode = s.mode;
    if (typeof s.trackId === 'string' && TRACKS.some((t) => t.id === s.trackId)) next.trackId = s.trackId;
    if (s.cc === 50 || s.cc === 100 || s.cc === 150) next.cc = s.cc as EngineCC;
    if (typeof s.laps === 'number' && Number.isFinite(s.laps)) next.laps = Math.max(1, Math.min(5, Math.round(s.laps)));
    this.setup = next;
  }

  // =================================================================== plumbing

  private toast(message: string, kind: 'info' | 'error' = 'info'): void {
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

  private restoreSnapshot(): void {
    const raw = storageGet('session', STORAGE.session);
    if (!raw) return;
    try {
      const s = JSON.parse(raw) as Partial<Snapshot>;
      if (Array.isArray(s.players)) for (const p of s.players) this.snapshotPlayers.set(p.playerId, p);
      if (s.setup) this.applySetup(s.setup);
      if (typeof s.tipsEnabled === 'boolean') this.tipsEnabled = s.tipsEnabled;
      if (typeof s.tutorialSeen === 'boolean') this.tutorialSeen = s.tutorialSeen;
      if (typeof s.racesCompleted === 'number') this.racesCompleted = s.racesCompleted;
    } catch {
      /* corrupt snapshot: ignore */
    }
  }

  private saveSnapshot(): void {
    const snap: Snapshot = {
      players: this.players.map((p) => ({
        playerId: p.playerId,
        slot: p.slot,
        name: p.name,
        characterId: p.characterId,
        joinSeq: p.joinSeq,
        leader: p.isLeader,
      })),
      setup: this.setup,
      tipsEnabled: this.tipsEnabled,
      tutorialSeen: this.tutorialSeen,
      racesCompleted: this.racesCompleted,
    };
    for (const p of snap.players) this.snapshotPlayers.set(p.playerId, p);
    storageSet('session', STORAGE.session, JSON.stringify(snap));
  }

  /** Racer display info for UI. */
  characterOf(p: { characterId: string }): ReturnType<typeof getCharacter> {
    return getCharacter(p.characterId);
  }

  dispose(): void {
    this.disposed = true;
    this.timers.clearAll();
    this.sync.dispose();
    this.fx.dispose();
    this.events.clear();
  }
}
