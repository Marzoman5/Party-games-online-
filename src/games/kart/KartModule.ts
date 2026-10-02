/**
 * Kart Party as a party-engine GameModule: wraps the kart engine (`IGameHost`: Game, or the
 * `?stub=1` StubGame), the race setup, Grand Prix bookkeeping, RaceFx haptics, the 6-step
 * tutorial and the kart setup/results host overlays. Behaviour is identical to the pre-hub
 * Kart Party (same testids, same `__party` fields).
 */
import type { EnginePhase, HumanDriver, IGameHost, PartyRaceConfig, RaceResult } from '../../game/api';
import { getCharacter } from '../../kart/roster';
import { TRACKS } from '../../track/tracks/index';
import { SLOT_COLORS, type EngineCC, type GameInfo, type HostToPhone, type PhoneRaceStatus, type RaceSetup, type ResultRow } from '../../net/protocol';
import type { AnyInput, CharacterLook, GameModule, MatchSeat, ModulePost, ModuleViews, TryIt } from '../../engine/GameModule';
import type { PartySession } from '../../engine/PartySession';
import type { UiContext } from '../../party/ui/HostUI';
import { GrandPrix } from './gp';
import { RaceFx } from './RaceFx';
import { KART_TUTORIAL } from './tutorial';
import { KartSetupScreen } from './ui/SetupScreen';
import { KartResultsOverlay } from './ui/ResultsOverlay';

export const KART_INFO: GameInfo = {
  id: 'kart',
  title: 'Kart Party',
  tagline: 'Race, drift & throw stuff at your friends',
  emoji: '🏎️',
  color: '#ff3ab8',
  minPlayers: 1,
  maxPlayers: 4,
};

const LIVE: ReadonlySet<EnginePhase> = new Set<EnginePhase>(['intro', 'countdown', 'racing', 'finished']);

export class KartModule implements GameModule {
  readonly id = 'kart' as const;
  readonly info = KART_INFO;
  readonly layout = 'kart' as const;
  readonly tutorial = KART_TUTORIAL;
  readonly hasSandbox = false;
  readonly loaded = true;

  setup: RaceSetup = { mode: 'single', trackId: TRACKS[0].id, cc: 150, laps: 3 };
  gp: GrandPrix | null = null;
  /** Track of the current / last race. */
  trackId = TRACKS[0].id;
  /** Kart races completed (tips are shown in the first one only). */
  racesCompleted = 0;
  private s!: PartySession;
  private fx: RaceFx | null = null;

  constructor(readonly game: IGameHost) {}

  bind(s: PartySession): void {
    this.s = s;
    this.fx = new RaceFx(s);
    const g = this.game;
    g.onPhaseChange = (ph) => {
      if (ph === 'soloMenu') s.onSoloStarted();
      s.onModulePhase(this);
    };
    g.onRaceComplete = (results) => this.onRaceComplete(results);
    g.onPauseRequest = () => {
      if (s.gameId === 'kart') s.onPauseRequest();
    };
    g.onSoloExit = () => s.onSoloExit();
  }

  load(): Promise<void> {
    return Promise.resolve();
  }

  activate(): void {
    this.game.setSuspended?.(false);
    this.game.showDemo();
  }

  deactivate(): void {
    if (this.game.setSuspended) this.game.setSuspended(true);
    else this.game.showDemo();
  }

  showAttract(): void {
    this.game.showDemo();
  }

  setTvMode(on: boolean): void {
    this.game.setTvMode(on);
  }

  /** Legacy keyboard solo flow (Enter on the title). */
  openSolo(): void {
    this.game.openSoloMenu();
  }

  // ------------------------------------------------------------------ phase

  get phase(): string {
    return this.game.phase;
  }
  isLive(): boolean {
    return LIVE.has(this.game.phase);
  }
  isStopped(): boolean {
    const p = this.game.phase;
    return p === 'demo' || p === 'idle';
  }
  canPause(): boolean {
    return LIVE.has(this.game.phase);
  }

  // ------------------------------------------------------------------ setup

  getSetup(): Record<string, unknown> {
    return { ...this.setup };
  }

  raceSetup(): RaceSetup {
    return { ...this.setup };
  }

  applySetup(patch: unknown): void {
    if (!patch || typeof patch !== 'object') return;
    const s = patch as Partial<RaceSetup>;
    const next = { ...this.setup };
    if (s.mode === 'single' || s.mode === 'gp') next.mode = s.mode;
    if (typeof s.trackId === 'string' && TRACKS.some((t) => t.id === s.trackId)) next.trackId = s.trackId;
    if (s.cc === 50 || s.cc === 100 || s.cc === 150) next.cc = s.cc as EngineCC;
    if (typeof s.laps === 'number' && Number.isFinite(s.laps)) next.laps = Math.max(1, Math.min(5, Math.round(s.laps)));
    this.setup = next;
  }

  snapshot(): unknown {
    return { setup: this.setup, racesCompleted: this.racesCompleted };
  }

  restore(snap: unknown): void {
    if (!snap || typeof snap !== 'object') return;
    const o = snap as { setup?: unknown; racesCompleted?: unknown };
    if (o.setup) this.applySetup(o.setup);
    if (typeof o.racesCompleted === 'number') this.racesCompleted = o.racesCompleted;
  }

  // ------------------------------------------------------------------ match

  startFromSetup(seats: MatchSeat[]): boolean {
    if (this.setup.mode === 'gp') {
      this.gp = new GrandPrix(TRACKS.length);
      return this.startRace(TRACKS[0].id, seats);
    }
    this.gp = null;
    return this.startRace(this.setup.trackId, seats);
  }

  post(action: ModulePost, seats: MatchSeat[]): boolean {
    const last = this.trackId;
    if (action === 'replay') return this.startRace(last, seats); // GP: re-running a race overwrites its points
    if (this.gp) {
      if (this.gp.isFinalRace) {
        this.gp = new GrandPrix(TRACKS.length);
        return this.startRace(TRACKS[0].id, seats);
      }
      this.gp.race++;
      return this.startRace(TRACKS[(this.gp.race - 1) % TRACKS.length].id, seats);
    }
    const i = TRACKS.findIndex((t) => t.id === last);
    const next = TRACKS[(i + 1) % TRACKS.length].id;
    this.setup = { ...this.setup, trackId: next };
    return this.startRace(next, seats);
  }

  private startRace(trackId: string, seats: MatchSeat[]): boolean {
    const drivers: HumanDriver[] = seats.map((p) => ({
      playerId: p.playerId,
      name: p.name,
      characterId: p.characterId,
      color: p.color,
      source: 'phone',
    }));
    const cfg: PartyRaceConfig = {
      trackId,
      cc: this.setup.cc,
      laps: this.setup.laps,
      humans: drivers,
      showTips: this.s.tipsEnabled && this.racesCompleted === 0,
      introFlyover: true,
      ui: 'party',
    };
    this.trackId = trackId;
    try {
      this.game.setSuspended?.(false);
      this.game.startRace(cfg);
    } catch (err) {
      console.error('[kart] startRace failed', err);
      this.s.toast('Could not start the race — try another track', 'error');
      return false;
    }
    return true;
  }

  private onRaceComplete(results: RaceResult[]): void {
    const s = this.s;
    const m = s.match;
    if (s.gameId !== 'kart' || s.soloActive || !m || m.kind !== 'match') return;
    const sorted = [...results].sort((a, b) => a.place - b.place);
    const keys: string[] = [];
    let rows: ResultRow[] = sorted.map((r) => {
      const pid = r.slot >= 0 ? (m.playerOfSlot[r.kartId] ?? m.playerOfSlot[r.slot]) : undefined;
      const p = pid ? s.player(pid) : undefined;
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
    this.racesCompleted++;
    const winner = gpFinal && this.gp ? this.gp.standings()[0]?.name : rows[0]?.name;
    s.onMatchComplete(this, rows, {
      gpFinal,
      info: { game: 'kart', winner: winner ?? '', mode: this.gp ? 'gp' : 'single' },
      meta: { trackId: this.trackId },
    });
  }

  endSeries(): void {
    this.gp = null;
  }

  restart(): void {
    this.game.restartRace();
  }
  quit(): void {
    this.game.quitRace();
    this.gp = null;
  }
  pause(): void {
    this.game.pause();
  }
  resume(): void {
    this.game.resume();
  }
  setSeatAI(seat: number, ai: boolean): void {
    this.game.setSlotAI(seat, ai);
  }

  input(seat: number, input: AnyInput): void {
    if (input.tag === 0) this.game.setHumanInput(seat, input.input);
  }

  status(seat: number): HostToPhone | null {
    const st = this.game.getSlotStatus(seat);
    if (!st) return null;
    const phase = this.game.phase;
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
    return msg;
  }

  tryIt(input: AnyInput, prev: AnyInput | null): TryIt | null {
    if (input.tag !== 0) return null;
    const p = prev && prev.tag === 0 ? prev.input : null;
    if (input.input.drift && !(p?.drift ?? false)) return { kind: 'drift', label: 'DRIFT!' };
    // First packet after (re)connect: the counter starts at 0 on a fresh phone.
    if (input.input.itemPresses !== (p?.itemPresses ?? 0)) return { kind: 'item', label: 'ITEM!' };
    return null;
  }

  look(characterId: string): CharacterLook {
    return { portrait: null, sub: getCharacter(characterId).name };
  }

  matchLabel(): string {
    const gp = this.gp;
    const name = TRACKS.find((t) => t.id === this.trackId)?.name ?? '';
    return `${gp ? `GRAND PRIX · RACE ${gp.race}/${gp.of} · ` : ''}${name.toUpperCase()}`;
  }

  stateExtras(): { gp: { race: number; of: number } | null } {
    return { gp: this.gp ? { race: this.gp.race, of: this.gp.of } : null };
  }

  createViews(ctx: unknown): ModuleViews {
    const c = ctx as UiContext;
    return { setup: new KartSetupScreen(c), results: new KartResultsOverlay(c, this) };
  }

  dispose(): void {
    this.fx?.dispose();
    this.game.onPhaseChange = null;
    this.game.onRaceComplete = null;
    this.game.onPauseRequest = null;
    this.game.onSoloExit = null;
  }
}
