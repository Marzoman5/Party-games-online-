/**
 * PARTY ENGINE — the game-module interface.
 *
 * The party engine (src/engine/**) owns everything that is the same for every game: the relay
 * connection, room/QR, players + slots + reconnect tokens, the leader and succession, ready flags,
 * the screens state machine, the tutorial runner, the pause/resume vote, phone state sync, the
 * ~10 Hz status ticker, TV mode and the host shell UI (src/party/**).
 *
 * Each GAME plugs in as a `GameModule` (src/games/<id>/…, listed in src/games/registry.ts).
 * The session talks to the active game ONLY through this interface:
 *
 *   lobby ──START──▶ tutorial (first start of each game per session) ──▶ [sandbox] ──▶ setup
 *         ──START──▶ module.startFromSetup(seats) ──▶ loading ──(module.isLive())──▶ race
 *         ──module calls session.onMatchComplete(rows, info)──▶ results ──post──▶ …
 *
 * "seat" = index into the `seats` array the session handed to `startFromSetup` / `replay` /
 * `startSandbox` (humans sorted by lobby slot). It is the kart id / fighter index of that human.
 *
 * Adding a third game = a new module + a registry entry (+ a phone controller layout).
 */
import type {
  DecodedFightInput,
  DecodedInput,
  DecodedStream,
  MgFromPhone,
  GameId,
  GameInfo,
  HostToPhone,
  PhoneState,
  RaceSetup,
  ResultRow,
} from '../net/protocol';
import type { PartySession, PlayerRec } from './PartySession';

/** Which phone controller layout the game uses (`PhoneState.game` decides it on the phone). */
export type ControllerLayout = 'kart' | 'fighter' | 'rush';

/** A decoded phone input packet: tag 0 = kart, tag 1 = fighter, tag 2 = Party Rush stream (see protocol). */
export type AnyInput = { tag: 0; input: DecodedInput } | { tag: 1; input: DecodedFightInput } | { tag: 2; input: DecodedStream };

/** PARTY RUSH: party-level player events delivered to drop-in modules. */
export type PlayerEvent = 'join' | 'rejoin' | 'leave' | 'remove' | 'profile';

/** One human taking part in a match / sandbox. Index in the seats array = engine slot. */
export interface MatchSeat {
  playerId: string;
  name: string;
  characterId: string;
  /** Lobby slot 0..3. */
  slot: number;
  /** CSS slot colour. */
  color: string;
  /** Team (team modes). */
  team: number;
}

/** Extra result info (→ `PhoneState.resultsInfo`). */
export type ResultsInfo = NonNullable<PhoneState['resultsInfo']>;

/** "Try it" feedback during lobby / tutorial: the host avatar reacts to a button press. */
export interface TryIt {
  /** Visual style: 'drift' = hop + sparks, 'item' = wiggle + pop. */
  kind: 'drift' | 'item';
  /** Speech-bubble word, e.g. 'DRIFT!', 'JUMP!'. */
  label: string;
}

/** One tutorial step (host side). The phone shows its own text for the same index. */
export interface TutorialStepDef {
  /** Phone-art zone to highlight (must exist in `phoneMarkup` as `data-zone`). */
  zone: string;
  /** Callout bubble text on the phone illustration. */
  label: string;
  title: string;
  sub: string;
  /** Small animated demo (HTML markup, our own code only) for this step. */
  demo(characterId: string): string;
}

/** Everything the generic tutorial runner + screen needs from a game. */
export interface TutorialDef {
  steps: TutorialStepDef[];
  /** Duration of each step (ms). */
  stepMs: number;
  /** Optional longer first step (ms): people are still looking up from their phones. */
  firstStepMs?: number;
  /** Inline SVG of the phone controller (landscape), zones marked with `class="kp-zone" data-zone`. */
  phoneMarkup(slotColor: string): string;
  /** SVG viewBox size of `phoneMarkup`. */
  phoneSize: [number, number];
  /** Callout anchor point per zone (SVG coords). */
  zoneAnchor: Record<string, [number, number]>;
  /** Hint under the avatars row ("Try it now: …"). */
  tryItHint: string;
}

/** Host overlay views a module contributes (built once, reused). */
export interface ModuleViews {
  /** Required unless the module is `dropIn`. */
  setup?: ModuleScreenView;
  /** Required unless the module is `dropIn`. */
  results?: ModuleScreenView;
  /** Optional: replaces the generic race/loading overlay. */
  race?: ModuleScreenView;
  /** Required when `hasSandbox`. */
  sandbox?: ModuleScreenView;
}

/** Same shape as the party UI's ScreenView (kept structural to avoid an import cycle). */
export interface ModuleScreenView {
  readonly root: HTMLElement;
  update(s: PartySession): void;
  show?(): void;
  hide?(): void;
  dispose?(): void;
}

/** How a player is shown on the hub (lobby cards, setup line-up). */
export interface CharacterLook {
  /** Rendered portrait (data: URL) or null → the procedural kart avatar is used. */
  portrait: string | null;
  /** Line under the name, e.g. the racer name or a fighter archetype ('HEAVY BRUISER'). */
  sub: string;
}

/** Post-match actions a module handles itself (the session does 'lobby', 'switch' and 'track'). */
export type ModulePost = 'next' | 'replay';

export interface GameModule {
  readonly id: GameId;
  readonly info: GameInfo;
  readonly layout: ControllerLayout;
  readonly tutorial: TutorialDef;
  /** Show the "try it" practice sandbox after the first tutorial of the session. */
  readonly hasSandbox: boolean;

  // ------------------------------------------------------------------ lifecycle
  /** Called once by the session (module may keep the reference). */
  bind(session: PartySession): void;
  /** True once the engine exists (lazy modules load on first activation). */
  readonly loaded: boolean;
  /** Load the engine (dynamic import). Rejects on failure; idempotent. */
  load(): Promise<void>;
  /** Make this game visible: canvas + audio on, attract demo running. */
  activate(): void;
  /** Hide this game: stop rendering/audio, hide canvas + HUD (another game takes over). */
  deactivate(): void;
  /** (Re)start the attract demo behind the hub overlays (after quit / back to lobby / setup). */
  showAttract(): void;
  setTvMode(on: boolean): void;

  // ------------------------------------------------------------------ engine phase
  /** Engine phase name (→ `__party.getState().engine`). */
  readonly phase: string;
  /** The match is visibly running (loading → race transition). */
  isLive(): boolean;
  /** The engine is back in attract / idle (a running match was dropped). */
  isStopped(): boolean;
  /** Pause is allowed right now. */
  canPause(): boolean;

  // ------------------------------------------------------------------ setup
  /** The active setup sent to phones as `PhoneState.gameSetup`. */
  getSetup(): Record<string, unknown>;
  /** Sanitise + apply a (partial) setup patch from the leader's phone. */
  applySetup(patch: unknown): void;
  /** Kart only: the legacy `PhoneState.setup` (RaceSetup). */
  raceSetup?(): RaceSetup;
  /** Persisted across host reloads (session snapshot). */
  snapshot(): unknown;
  restore(snap: unknown): void;

  // ------------------------------------------------------------------ match
  /** Leader START on the setup screen. Return false if nothing started. Throws → toast + stay. */
  startFromSetup(seats: MatchSeat[]): boolean;
  /** Post-match 'next' / 'replay'. Return false if not handled. */
  post(action: ModulePost, seats: MatchSeat[]): boolean;
  /** Pause-menu restart (same config). */
  restart(): void;
  /** Abort the match → attract. */
  quit(): void;
  /** The match series is over (back to lobby / setup / other game): forget e.g. the Grand Prix. */
  endSeries?(): void;
  pause(): void;
  resume(): void;
  /** Human seat handed to the AI/CPU (disconnect) or given back (reconnect). */
  setSeatAI(seat: number, ai: boolean): void;
  /** Phone input for a seat (match or sandbox). Packets of the wrong tag are ignored. */
  input(seat: number, input: AnyInput): void;
  /** ~10 Hz per-phone status (`t:'race'` / `t:'fight'`), or null. */
  status(seat: number): HostToPhone | null;
  /** Lobby/tutorial "try it": does this input (vs the previous one) deserve a reaction? */
  tryIt(input: AnyInput, prev: AnyInput | null): TryIt | null;
  /** Lobby/setup look for a character. */
  look(characterId: string): CharacterLook;
  /** Loading-strip title while a match is being built. */
  matchLabel(): string;
  /** Extra per-phone PhoneState fields (kart: gp). */
  stateExtras?(): Partial<Pick<PhoneState, 'gp'>>;
  /** Extra `window.__party.getState()` fields. */
  debugExtras?(): Record<string, unknown>;

  // ------------------------------------------------------------------ sandbox (optional)
  startSandbox?(seats: MatchSeat[]): void;
  retireFromSandbox?(seat: number): void;
  /** Leave the sandbox (→ attract). */
  stopSandbox?(): void;

  // ------------------------------------------------------------------ host UI
  createViews(ctx: unknown): ModuleViews;
  /** Optional host keyboard handling while this game is active (return true if consumed). */
  onHostKey?(e: KeyboardEvent): boolean;

  // ------------------------------------------------------------------ PARTY RUSH: drop-in games (optional)
  /**
   * Drop-in / drop-out endless game: no lobby ready-check, tutorial, setup or results screens. Picking it
   * (or leader START in the lobby) puts the session straight into screen 'race' with an EMPTY seat map;
   * every connected player's phone shows the game's layout. The module tracks its own roster from
   * `session.players` + `onPlayer`, gets input/messages by playerId, and talks to phones itself
   * (`session.send`). `quit()` is called when the host goes back to the hub. Pause/vote, `status()`,
   * `startFromSetup`, `post`, `setSeatAI` and `input(seat)` are never used for drop-in modules.
   */
  readonly dropIn?: boolean;
  /** dropIn: the session entered the endless loop (screen 'race'). Idempotent. */
  startEndless?(): void;
  /** dropIn: party player events (join = new player, rejoin = reconnected, leave = disconnected, remove = left/kicked, profile = name changed). */
  onPlayer?(playerId: string, ev: PlayerEvent): void;
  /** dropIn: a `{t:'mg'}` phone message. */
  onMg?(playerId: string, m: MgFromPhone): void;
  /** dropIn: an input packet (tag 2 stream) from a phone. */
  inputFrom?(playerId: string, input: AnyInput): void;
}

/** Helper for modules: slot-sorted seat rows → ResultRow colour etc. */
export function seatOf(p: PlayerRec, color: string): MatchSeat {
  return { playerId: p.playerId, name: p.name, characterId: p.characterId, slot: p.slot, color, team: p.team ?? 0 };
}

export type { ResultRow };
