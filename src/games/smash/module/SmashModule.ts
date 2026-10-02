/**
 * Smash Party as a party-engine GameModule: drives `ISmashHost` (SmashGame, constructed lazily via
 * dynamic import the first time the game is picked), sanitises the leader's setup, builds the match
 * config (CPU fill, teams), runs the "try it" sandbox, maps fighter status → `t:'fight'`, engine fx →
 * phone fx, and match results → ResultRows + resultsInfo. Host overlays live in ./ui.
 */
import {
  TEAM_COLORS,
  type DecodedFightInput,
  type GameInfo,
  type HostToPhone,
  type PhoneFightStatus,
  type ResultRow,
  type SmashSetup,
} from '../../../net/protocol';
import { getCharacter } from '../../../kart/roster';
import type { AnyInput, CharacterLook, GameModule, MatchSeat, ModulePost, ModuleViews, TryIt } from '../../../engine/GameModule';
import type { PartySession } from '../../../engine/PartySession';
import type { UiContext } from '../../../party/ui/HostUI';
import type { ISmashHost, SmashMatchConfig, SmashPhase, SmashResult } from '../api';
import { getFighter } from '../roster';
import { getStage } from '../stages';
import { defaultSmashSetup, planMatch, sanitiseSmashSetup } from './setup';
import { SMASH_TUTORIAL } from './tutorial';
import { SmashSetupScreen } from './ui/SmashSetupScreen';
import { SmashResultsOverlay } from './ui/SmashResultsOverlay';
import { SandboxOverlay } from './ui/SandboxOverlay';
import './ui/smash-hub.css';

export const SMASH_INFO: GameInfo = {
  id: 'smash',
  title: 'Smash Party',
  tagline: 'Brawl your friends off the stage!',
  emoji: '🥊',
  color: '#ff7a2f',
  minPlayers: 1,
  maxPlayers: 4,
};

const LIVE: ReadonlySet<SmashPhase> = new Set<SmashPhase>(['intro', 'countdown', 'fighting', 'gameSet']);
const PAUSABLE: ReadonlySet<SmashPhase> = new Set<SmashPhase>(['intro', 'countdown', 'fighting']);

export class SmashModule implements GameModule {
  readonly id = 'smash' as const;
  readonly info = SMASH_INFO;
  readonly layout = 'fighter' as const;
  readonly tutorial = SMASH_TUTORIAL;
  readonly hasSandbox = true;

  setup: SmashSetup = defaultSmashSetup();
  /** The engine (null until loaded). */
  host: ISmashHost | null = null;
  /** Config of the current / last match. */
  lastConfig: SmashMatchConfig | null = null;
  lastResult: SmashResult | null = null;
  private s!: PartySession;
  private loading: Promise<void> | null = null;
  private active = false;
  private portraitTimer = 0;
  private portraitTries = 0;
  /** Last fight input per seat (press counters → edges are handled by the engine). */
  private readonly lastInput = new Map<number, DecodedFightInput>();

  constructor(private readonly container: HTMLElement) {}

  bind(s: PartySession): void {
    this.s = s;
  }

  get loaded(): boolean {
    return !!this.host;
  }

  load(): Promise<void> {
    if (this.host) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const { SmashGame } = await import('../SmashGame');
        const host: ISmashHost = new SmashGame(this.container);
        this.wire(host);
        this.host = host;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  private wire(host: ISmashHost): void {
    host.onPhaseChange = () => {
      if (this.active) this.s.onModulePhase(this);
    };
    host.onMatchComplete = (r) => this.onMatchComplete(r);
    host.onPauseRequest = () => {
      if (this.active && this.s.gameId === 'smash') this.s.onPauseRequest();
    };
    host.onFx = (fx) => {
      const s = this.s;
      if (!this.active || !s.match || s.match.game !== 'smash') return;
      if (s.screen !== 'race' && s.screen !== 'loading' && s.screen !== 'sandbox') return;
      const p = s.connectedAtSeat(fx.slot);
      if (!p) return;
      s.send(p.playerId, { t: 'fx', kind: fx.kind, strength: Math.max(0, Math.min(1, fx.strength)) });
    };
  }

  private need(): ISmashHost {
    if (!this.host) throw new Error('Smash Party engine not loaded');
    return this.host;
  }

  activate(): void {
    const h = this.need();
    this.active = true;
    h.activate();
    this.watchPortraits();
  }

  deactivate(): void {
    this.active = false;
    window.clearInterval(this.portraitTimer);
    this.portraitTimer = 0;
    this.lastInput.clear();
    this.host?.deactivate();
  }

  showAttract(): void {
    const h = this.host;
    if (!h) return;
    if (h.phase === 'idle') h.activate();
    else if (h.phase !== 'attract') h.quitMatch();
  }

  setTvMode(on: boolean): void {
    this.host?.setTvMode(on);
  }

  /** Rendered portraits (data URLs) and the characters the UI asked for. */
  private readonly portraits = new Map<string, string>();
  private readonly wanted = new Set<string>();

  /**
   * Portraits are rendered by the engine synchronously (expensive on weak GPUs), so the hub UI never
   * triggers a render itself: `look()` only reads this cache and queues the id; this timer renders
   * at most ONE missing portrait per tick and re-renders the hub when one arrives.
   */
  private watchPortraits(): void {
    if (this.portraitTimer) return;
    this.portraitTries = 0;
    this.portraitTimer = window.setInterval(() => {
      const h = this.host;
      if (!h || !this.active) return;
      for (const p of this.s.players) if (!this.portraits.has(p.characterId)) this.wanted.add(p.characterId);
      const id = Array.from(this.wanted).find((x) => !this.portraits.has(x));
      if (!id) return;
      this.wanted.delete(id);
      let url: string | null = null;
      try {
        url = h.getPortrait(id);
      } catch {
        url = null;
      }
      if (url) {
        this.portraits.set(id, url);
        this.s.changed();
      } else if (++this.portraitTries < 40) this.wanted.add(id);
    }, 600);
  }

  /** Cached portrait (never renders synchronously). */
  portrait(id: string): string | null {
    const p = this.portraits.get(id);
    if (p) return p;
    if (this.host) this.wanted.add(id);
    return null;
  }

  // ------------------------------------------------------------------ phase

  get phase(): string {
    return this.host?.phase ?? 'idle';
  }
  isLive(): boolean {
    return !!this.host && LIVE.has(this.host.phase);
  }
  isStopped(): boolean {
    const p = this.host?.phase ?? 'idle';
    return p === 'attract' || p === 'idle';
  }
  canPause(): boolean {
    return !!this.host && PAUSABLE.has(this.host.phase);
  }

  // ------------------------------------------------------------------ setup

  getSetup(): Record<string, unknown> {
    return { ...this.setup };
  }

  applySetup(patch: unknown): void {
    this.setup = sanitiseSmashSetup(this.setup, patch);
  }

  snapshot(): unknown {
    return { ...this.setup };
  }

  restore(snap: unknown): void {
    this.setup = sanitiseSmashSetup(defaultSmashSetup(), snap);
  }

  /** Seed of the next match (decides the CPU characters, so the setup preview matches). */
  private nextSeed = SmashModule.newSeed();

  private static newSeed(): number {
    return (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) & 0x7fffffff;
  }

  /** Preview of the line-up the current setup would produce (host setup screen). */
  preview(seats: MatchSeat[]): SmashMatchConfig {
    return planMatch(this.setup, seats, this.nextSeed).config;
  }

  // ------------------------------------------------------------------ match

  startFromSetup(seats: MatchSeat[]): boolean {
    return this.start(seats);
  }

  post(_action: ModulePost, seats: MatchSeat[]): boolean {
    // 'next' and 'replay' are both a Rematch with the current setup (+ anyone who joined meanwhile).
    return this.start(seats);
  }

  private start(seats: MatchSeat[]): boolean {
    const h = this.need();
    const seed = this.nextSeed;
    this.nextSeed = SmashModule.newSeed();
    const plan = planMatch(this.setup, seats, seed);
    for (const n of plan.notes) this.s.toast(n);
    this.lastConfig = plan.config;
    this.lastResult = null;
    this.lastInput.clear();
    try {
      h.startMatch(plan.config);
    } catch (err) {
      console.error('[smash] startMatch failed', err);
      this.s.toast('Could not start the match — try another stage', 'error');
      return false;
    }
    return true;
  }

  private onMatchComplete(result: SmashResult): void {
    const s = this.s;
    const m = s.match;
    if (!this.active || s.gameId !== 'smash' || !m || m.kind !== 'match') return;
    this.lastResult = result;
    const rows: ResultRow[] = [...result.rows]
      .sort((a, b) => a.place - b.place)
      .map((r) => {
        const pid = r.playerId ?? (r.fighter < m.playerOfSlot.length ? m.playerOfSlot[r.fighter] : undefined);
        const p = pid ? s.player(pid) : undefined;
        const human = !!p && !(r.cpu && r.slot < 0);
        return {
          place: r.place,
          name: human ? p!.name : r.name,
          characterId: r.characterId,
          color: r.color,
          time: -1,
          slot: human ? p!.slot : -1,
          kos: r.kos,
          falls: r.falls,
          damageDealt: Math.round(r.damageDealt),
          score: r.score,
          stocksLeft: r.stocksLeft,
          team: r.team,
          cpu: !human,
        };
      });
    let winner = '';
    if (result.winnerTeam >= 0 && this.lastConfig?.setup.teams) winner = result.winnerTeam === 1 ? 'BLUE TEAM' : 'RED TEAM';
    else {
      const w = result.rows.find((r) => r.fighter === result.winnerFighter);
      const wp = w?.playerId ? s.player(w.playerId) : undefined;
      winner = wp ? wp.name : (w?.name ?? rows[0]?.name ?? '');
    }
    s.onMatchComplete(this, rows, {
      info: {
        game: 'smash',
        winner,
        ...(result.winnerTeam >= 0 && this.lastConfig?.setup.teams ? { winnerTeam: result.winnerTeam } : {}),
        mode: result.mode,
      },
      meta: { duration: result.duration, stageId: this.lastConfig?.setup.stageId ?? this.setup.stageId },
    });
  }

  restart(): void {
    this.lastInput.clear();
    this.need().restartMatch();
  }
  quit(): void {
    this.host?.quitMatch();
  }
  pause(): void {
    this.need().pause();
  }
  resume(): void {
    this.need().resume();
  }
  setSeatAI(seat: number, ai: boolean): void {
    this.host?.setSlotAI(seat, ai);
  }

  input(seat: number, input: AnyInput): void {
    if (input.tag !== 1 || !this.host) return;
    this.lastInput.set(seat, input.input);
    this.host.setHumanInput(seat, input.input);
  }

  status(seat: number): HostToPhone | null {
    const st = this.host?.getFighterStatus(seat);
    if (!st) return null;
    const msg: PhoneFightStatus = {
      t: 'fight',
      characterId: st.characterId,
      damage: Math.round(st.damage),
      stocks: st.stocks,
      score: st.score,
      kos: st.kos,
      countdown: st.countdown,
      timeLeft: st.timeLeft < 0 ? -1 : Math.ceil(st.timeLeft),
      out: st.out,
      respawning: st.respawning,
      cpu: st.cpu,
      team: st.team,
      item: st.item,
      suddenDeath: st.suddenDeath,
    };
    if (typeof st.dummyDamage === 'number') msg.dummyDamage = Math.round(st.dummyDamage);
    return msg;
  }

  tryIt(input: AnyInput, prev: AnyInput | null): TryIt | null {
    if (input.tag !== 1) return null;
    const i = input.input;
    const p = prev && prev.tag === 1 ? prev.input : null;
    if (i.jumpPresses !== (p?.jumpPresses ?? 0)) return { kind: 'drift', label: 'JUMP!' };
    if (i.attackPresses !== (p?.attackPresses ?? 0)) return { kind: 'item', label: 'POW!' };
    if (i.specialPresses !== (p?.specialPresses ?? 0)) return { kind: 'item', label: 'SPECIAL!' };
    if (i.grabPresses !== (p?.grabPresses ?? 0)) return { kind: 'item', label: 'GRAB!' };
    if (i.shield && !(p?.shield ?? false)) return { kind: 'drift', label: 'SHIELD!' };
    return null;
  }

  look(characterId: string): CharacterLook {
    const portrait = this.portrait(characterId);
    let arche = '';
    try {
      arche = getFighter(characterId).archetypeLabel;
    } catch {
      arche = '';
    }
    const name = getCharacter(characterId).name;
    return { portrait, sub: arche ? `${name}\n${arche}` : name };
  }

  matchLabel(): string {
    const id = this.lastConfig?.setup.stageId ?? this.setup.stageId;
    let name = id;
    try {
      name = getStage(id).name;
    } catch {
      /* ignore */
    }
    const st = this.lastConfig?.setup ?? this.setup;
    const rules = st.mode === 'stock' ? `${st.stocks} STOCK${st.stocks > 1 ? 'S' : ''}` : `${Math.round(st.timeSec / 60)} MIN`;
    return `${name.toUpperCase()} · ${rules}${st.teams ? ' · TEAMS' : ''}`;
  }

  // ------------------------------------------------------------------ sandbox

  startSandbox(seats: MatchSeat[]): void {
    const h = this.need();
    this.lastInput.clear();
    h.startSandbox({
      humans: seats.map((s, i) => ({
        playerId: s.playerId,
        name: s.name,
        characterId: s.characterId,
        color: s.color,
        slot: s.slot,
        team: i,
      })),
    });
  }

  retireFromSandbox(seat: number): void {
    this.host?.retireFromSandbox(seat);
  }

  stopSandbox(): void {
    this.host?.quitMatch();
  }

  /** Training dummy % (sandbox overlay). */
  dummyDamage(): number | null {
    const st = this.host?.getFighterStatus(0);
    return st && typeof st.dummyDamage === 'number' ? st.dummyDamage : null;
  }

  teamColor(team: number): string {
    return TEAM_COLORS[team === 1 ? 1 : 0];
  }

  // ------------------------------------------------------------------ host UI

  createViews(ctx: unknown): ModuleViews {
    const c = ctx as UiContext;
    return {
      setup: new SmashSetupScreen(c, this),
      results: new SmashResultsOverlay(c, this),
      sandbox: new SandboxOverlay(c, this),
    };
  }
}
