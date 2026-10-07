/**
 * SHELL — the Party Rush endless loop (no DOM): phase machine, roster + away handling, the minigame
 * context, input routing, solo bots, scoring, picker + heat, stingers, snapshot/restore and the phone
 * message state. The module (RushModule) drives `tick()` from requestAnimationFrame AND from a watchdog
 * interval, so the loop keeps moving even when rAF stalls (hidden tab, slow GPU).
 *
 *   lobby ─next/auto─▶ intro (UP NEXT, +safe card) ─▶ count (3-2-1, mg.start) ─GO (mg.go)─▶ play
 *     ▲                                                                                     │
 *     └──────────── results (≈6 s) ◀──── mg.results() ◀── done() / ctx.end() / time cap ────┘
 *   any minigame exception → 'oops' (2.5 s, no points) → lobby
 *
 * Every phase has a hard cap (loop clock, frozen while paused); the scoreboard waits only when
 * auto-advance is off or nobody is present (that's the idle "Scan to join" state, not a hang).
 */
import type { DecodedStream, MgFromPhone, RushEvent } from '../../../net/protocol';
import { PLAYER_EMOJIS, SLOT_COLORS } from '../../../net/protocol';
import { seededRandom } from '../draw';
import { MINIGAMES, minigameById } from '../minigames/index';
import { LOOP } from '../tuning';
import type { BotOut, Heat, MinigameCtx, MinigameDef, MinigameResult, RenderView, RushInputEvent, RushPlayer, RushSfx } from '../types';
import { isBotId, makeBots } from './bots';
import { Picker } from './picker';
import { pickSuperlatives, scoreRanking, sipLine, type SipState } from './scoring';
import { loadSettings, sanitiseSettings, saveSettings, type RushSettings } from './settings';
import type { Entry, ErrorRec, HistoryItem, Phase, ResultCard, RoundState, ShellSfx, Stinger } from './state';

/** What the shell needs from the party session (kept small so the loop can be tested without one). */
export interface ShellHost {
  players(): readonly { playerId: string; slot: number; name: string; emoji?: string; connected: boolean; isLeader: boolean }[];
  /** One host→phone message to one phone. */
  send(playerId: string, msg: unknown): void;
  /** Re-render host UI + save the session snapshot (call after score / roster changes, not per frame). */
  changed(): void;
  kick(playerId: string): void;
}

export interface ShellSound {
  sfx(name: RushSfx | ShellSfx, opts?: { pan?: number; vol?: number; pitch?: number }): void;
}

/** Count-down number length (s) and extra GO beat. */
const OOPS_SEC = 2.6;
const PLAY_GRACE_SEC = 3;
const REMOVED_SHOW_MS = 5000;
const SHOUT_MS = 900;
const STREAM_MAX_HZ = 40;

const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class RushShell {
  // ------------------------------------------------------------------ public state (read-only for views)
  phase: Phase = 'lobby';
  /** Loop clock (s), frozen while paused. */
  clock = 0;
  /** Seconds in the current phase (loop clock). */
  phaseT = 0;
  paused = false;
  menuOpen = false;
  running = false;
  heat: Heat = 1;
  /** Rounds completed (with points). */
  roundsPlayed = 0;
  rid = 0;
  round: RoundState | null = null;
  lastResults: ResultCard | null = null;
  /** The teased next minigame (scoreboard). */
  upcoming: string | null = null;
  /** Forced next minigame (R = replay, `__rush.forceGame`). */
  forced: string | null = null;
  settings: RushSettings;
  readonly entries = new Map<string, Entry>();
  readonly errors: ErrorRec[] = [];
  readonly history: HistoryItem[] = [];
  stinger: Stinger | null = null;
  /** Count-down number on screen (3, 2, 1, 0 = GO). */
  cd = 3;
  /** Bumped on every change the DOM views must reflect (not per frame). */
  version = 0;
  /** True while the UP NEXT card is in its "Hold your phone tight!" segment. */
  safeNow = false;
  /** Heat went up when this round was picked (UP NEXT shows "HEAT 2!"). */
  heatUp = false;
  /** Reason of the last oops (UI). */
  oopsMsg = '';

  // ------------------------------------------------------------------ private
  private readonly picker = new Picker();
  private cueSeq = 0;
  private lastReal = 0;
  private houseAcc = 0;
  private sip: SipState = { count: 0, lastTarget: '' };
  private readonly sent = new Map<string, string>();
  private menuPaused = false;
  private ctx: MinigameCtx | null = null;
  /** Wall ms of the last tick (watchdog decides whether rAF is alive). */
  lastTickReal = 0;
  /** Bytes of the largest phone message sent (diagnostics). */
  maxMsgBytes = 0;
  lastMsgBytes = 0;
  msgsSent = 0;

  constructor(
    private readonly host: ShellHost,
    private readonly sound: ShellSound,
  ) {
    this.settings = loadSettings();
  }

  // =================================================================== lifecycle

  /** Enter the endless loop (idempotent). */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.menuOpen = false;
    this.lastReal = nowMs();
    this.reconcile();
    this.enterLobby(false);
  }

  /** Leave the loop (back to the hub). Drops any running round without points. */
  stop(): void {
    if (!this.running) return;
    this.disposeRound();
    this.running = false;
    this.paused = false;
    this.menuOpen = false;
    this.phase = 'lobby';
    this.sent.clear();
    this.bump();
  }

  /** Advance the loop. Called every animation frame and by the watchdog when frames stall. */
  tick(real = nowMs()): void {
    const dt = Math.max(0, Math.min(0.25, (real - (this.lastReal || real)) / 1000));
    this.lastReal = real;
    this.lastTickReal = real;
    if (!this.running) return;
    if (!this.paused) {
      this.clock += dt;
      this.phaseT += dt;
    }
    try {
      if (!this.paused) this.step(dt);
    } catch (err) {
      this.logError('shell', err);
      // A broken transition must never wedge the party: back to the scoreboard.
      try {
        this.disposeRound();
        this.enterLobby(false);
      } catch {
        /* ignore */
      }
    }
    this.houseAcc += dt || 0.016;
    if (this.houseAcc >= 1) {
      this.houseAcc = 0;
      this.housekeeping();
    }
    this.syncPhones();
  }

  private step(dt: number): void {
    switch (this.phase) {
      case 'lobby': {
        if (this.presentHumans().length === 0 || !this.settings.auto || this.menuOpen) {
          this.phaseT = 0; // ring restarts when someone shows up / auto turns on
        } else if (this.phaseT >= this.settings.autoSec) this.enterIntro();
        break;
      }
      case 'intro': {
        const r = this.round;
        const base = LOOP.upNextSec;
        const total = base + (r?.energetic ? LOOP.safeCardSec : 0);
        const safe = !!r?.energetic && this.phaseT >= base;
        if (safe !== this.safeNow) {
          this.safeNow = safe;
          this.bump();
        }
        if (this.phaseT >= total) this.enterCount();
        break;
      }
      case 'count': {
        const n = Math.max(0, 3 - Math.floor(this.phaseT / LOOP.countStepSec));
        if (n !== this.cd && n > 0) {
          this.cd = n;
          this.sound.sfx('count', { pitch: 1 });
          this.bump();
        }
        if (this.phaseT >= 3 * LOOP.countStepSec) this.enterPlay();
        break;
      }
      case 'play':
        this.stepPlay(dt);
        break;
      case 'results':
        if (this.phaseT >= LOOP.resultsSec) this.enterLobby(true);
        break;
      case 'oops':
        if (this.phaseT >= OOPS_SEC) this.enterLobby(false);
        break;
    }
  }

  private stepPlay(dt: number): void {
    const r = this.round;
    if (!r || !r.mg) {
      this.enterLobby(false);
      return;
    }
    // Hard cap (watchdog): even if update() keeps not ending the round.
    if (this.phaseT > r.duration + PLAY_GRACE_SEC) {
      this.finishRound();
      return;
    }
    let left = dt;
    let steps = 0;
    while (left > 1e-6 && steps < 4 && this.phase === 'play') {
      const h = Math.min(0.1, left);
      left -= h;
      steps++;
      r.time = Math.min(r.duration, r.time + h);
      this.stepBots(r, h);
      if (this.phase !== 'play') return;
      if (!this.guard('update', () => r.mg!.update(h))) return;
      let done = false;
      if (!this.guard('done', () => (done = r.mg!.done()))) return;
      if (done || r.endReq || r.time >= r.duration) {
        this.finishRound();
        return;
      }
    }
    // Everyone (human) left: nothing to play for (bot-only demo rounds just run).
    if (this.hadHumans(r) && !this.anyHumanPresent(r)) {
      this.abortRound('empty');
    }
  }

  // =================================================================== phases

  private enterLobby(fromResults: boolean): void {
    this.disposeRound();
    this.phase = 'lobby';
    this.phaseT = 0;
    this.safeNow = false;
    this.heatUp = false;
    for (const e of this.entries.values()) if (e.st === 'next' && e.connected) e.st = 'play';
    if (fromResults && this.roundsPlayed > 0 && this.roundsPlayed % LOOP.crownEvery === 0) {
      const top = this.board()[0];
      if (top && top.pts > 0) {
        this.setStinger({ kind: 'crown', text: '👑 CROWN CHECK!', sub: `${top.emoji} ${top.name} rules the party`, color: top.color, ms: 4500 });
        this.sound.sfx('crown');
      }
    }
    this.refreshUpcoming();
    this.bump(true);
  }

  private enterIntro(): void {
    const est = this.estimateParticipants();
    let id: string | null = null;
    let newPass = false;
    if (this.forced && minigameById(this.forced)) {
      id = this.forced;
    } else {
      // The game teased on the scoreboard is the one that plays (drawn from the bag once).
      this.ensureDrawn(est);
      id = this.drawn;
      newPass = this.drawnPass;
      this.drawn = null;
      this.drawnPass = false;
    }
    this.forced = null;
    const def = id ? minigameById(id) : undefined;
    if (!def) {
      this.phaseT = 0;
      return;
    }
    this.picker.last = def.meta.id;
    const prevHeat = this.heat;
    this.heat = Math.max(1, Math.min(this.settings.maxHeat, 1 + this.picker.passes)) as Heat;
    this.heatUp = newPass && this.heat > prevHeat;
    if (this.heatUp) {
      this.setStinger({ kind: 'heat', text: `HEAT ${this.heat}!`, sub: 'Faster rounds, faster music 🔥', color: '#ff7a2f', ms: 2600 });
      this.sound.sfx('heat');
    }
    this.disposeRound();
    this.rid++;
    const seed = (Math.random() * 0x7fffffff) | 0;
    this.round = {
      def,
      rid: this.rid,
      n: this.roundsPlayed + 1,
      heat: this.heat,
      duration: Math.max(3, Number(def.meta.duration[this.heat - 1]) || 20),
      energetic: !!def.meta.energetic,
      createdAt: this.clock,
      mg: null,
      parts: new Map(),
      present: new Set(),
      active: new Set(),
      cues: new Map(),
      words: new Map(),
      streams: new Map(),
      bots: new Map(),
      time: 0,
      endReq: false,
      finished: false,
      shout: null,
      mgAt: this.clock,
      seed,
    };
    this.phase = 'intro';
    this.phaseT = 0;
    this.safeNow = false;
    this.upcoming = null;
    this.sound.sfx('card');
    this.bump(true);
  }

  private enterCount(): void {
    const r = this.round;
    if (!r) {
      this.enterLobby(false);
      return;
    }
    const meta = r.def.meta;
    // Participants are fixed now: present humans who did the join tap.
    const humans = [...this.entries.values()].filter((e) => e.st === 'play' && e.connected && !e.removedAt).sort((a, b) => a.slot - b.slot);
    if (humans.length > 16) humans.length = 16;
    for (const e of humans) {
      r.parts.set(e.id, { id: e.id, name: e.name, emoji: e.emoji, color: e.color, bot: false, touch: e.touch });
      r.present.add(e.id);
    }
    let nBots = 0;
    if (humans.length <= 1) nBots = Math.max(0, LOOP.soloTotal - humans.length);
    nBots = Math.max(nBots, meta.minPlayers - humans.length);
    nBots = Math.min(nBots, 6);
    if (nBots > 0) {
      r.bots = makeBots(meta.id, nBots, new Set(humans.map((e) => e.color)), r.seed);
      for (const [id, b] of r.bots) {
        r.parts.set(id, b.p);
        r.present.add(id);
      }
    }
    this.phase = 'count';
    this.phaseT = 0;
    this.cd = 3;
    this.safeNow = false;
    let mg = null as RoundState['mg'];
    if (!this.guard('create', () => (mg = r.def.create()))) return;
    r.mg = mg;
    r.mgAt = this.clock;
    this.ctx = this.makeCtx(r);
    if (!this.guard('start', () => r.mg!.start(this.ctx!))) return;
    this.sound.sfx('count', { pitch: 1 });
    this.bump(true);
  }

  private enterPlay(): void {
    const r = this.round;
    if (!r || !r.mg) {
      this.enterLobby(false);
      return;
    }
    this.phase = 'play';
    this.phaseT = 0;
    this.cd = 0;
    r.time = 0;
    this.sound.sfx('go');
    if (!this.guard('go', () => r.mg!.go?.())) return;
    this.bump();
  }

  /** Time cap / done(): rank, score, results card. */
  private finishRound(): void {
    const r = this.round;
    if (!r || !r.mg || r.finished) return;
    r.finished = true;
    let res: MinigameResult | null = null;
    if (!this.guard('results', () => (res = r.mg!.results()))) return;
    const result = res as MinigameResult | null;
    if (!result || !Array.isArray(result.ranking)) {
      this.fail('results', new Error('results() returned no ranking'));
      return;
    }
    // Idle for the whole round → away (no penalty, not shown as a loser).
    const wall = Date.now();
    for (const id of r.parts.keys()) {
      if (isBotId(id) || !r.present.has(id) || r.active.has(id)) continue;
      const e = this.entries.get(id);
      if (e && e.st === 'play') {
        e.st = 'away';
        e.awayWhy = 'idle';
        e.awaySince = wall;
      }
    }
    const keep = (id: string): boolean => r.parts.has(id) && r.present.has(id) && (isBotId(id) || r.active.has(id));
    const scored = scoreRanking(result.ranking, keep);
    const rand = seededRandom(r.seed ^ 0x2545f491);
    const sups = pickSuperlatives(scored, result.superlatives, rand);
    const rows = scored.map((s) => {
      const p = r.parts.get(s.id)!;
      return { id: s.id, name: p.name, emoji: p.emoji, color: p.color, bot: p.bot, touch: p.touch, place: s.place, pts: s.pts, stat: s.stat };
    });
    if (!rows.length) {
      // Nobody did anything: quietly back to the scoreboard.
      this.abortRound('empty');
      return;
    }
    for (const s of scored) {
      const e = this.entries.get(s.id);
      if (!e) continue;
      e.pts += s.pts;
      e.rounds++;
      if (s.place === 1) e.wins++;
      e.hist.push({ r: r.n, p: s.pts });
      while (e.hist.length > LOOP.streakRounds) e.hist.shift();
      e.lastRound = r.n;
      e.lastPts = s.pts;
    }
    const winners = rows.filter((x) => x.place === 1);
    let headline = typeof result.headline === 'string' && result.headline.trim() ? result.headline.trim().slice(0, 40) : '';
    if (!headline) {
      if (winners.length === 1) headline = `${winners[0].name} WINS!`;
      else if (winners.length <= 3) headline = `${winners.map((w) => w.name).join(' & ')} WIN!`;
      else headline = `${winners.length} WINNERS!`;
    }
    let sip = '';
    if (this.settings.sip) sip = sipLine(rows, this.sip, rand).text;
    this.roundsPlayed = r.n;
    this.lastResults = {
      round: r.n,
      rid: r.rid,
      game: r.def.meta.id,
      name: r.def.meta.name,
      icon: r.def.meta.icon,
      color: r.def.meta.color,
      headline,
      rows,
      sups,
      sip,
    };
    this.history.push({ r: r.n, g: r.def.meta.id, win: winners.map((w) => w.id) });
    while (this.history.length > 20) this.history.shift();
    for (const id of r.parts.keys()) {
      r.cues.delete(id);
    }
    this.phase = 'results';
    this.phaseT = 0;
    this.sound.sfx('fanfare');
    this.bump(true);
  }

  /** Drop the round without points. */
  private abortRound(why: 'skip' | 'oops' | 'empty'): void {
    this.disposeRound();
    if (why === 'oops') {
      this.phase = 'oops';
      this.phaseT = 0;
      this.sound.sfx('oops');
      this.bump(true);
      return;
    }
    if (why === 'skip') this.setStinger({ kind: 'skip', text: 'Skipped!', sub: '', color: '#ffd23a', ms: 1500 });
    this.enterLobby(false);
  }

  private disposeRound(): void {
    const r = this.round;
    if (!r) return;
    this.round = null;
    this.ctx = null;
    if (r.mg) {
      const mg = r.mg;
      r.mg = null;
      try {
        mg.dispose?.();
      } catch (err) {
        this.logError('dispose', err, r.def.meta.id);
      }
    }
  }

  // =================================================================== host controls

  /** Space / Enter / leader NEXT. */
  next(): boolean {
    if (!this.running) return false;
    if (this.paused) {
      this.setPaused(false);
      return true;
    }
    switch (this.phase) {
      case 'lobby':
        this.enterIntro();
        return true;
      case 'intro':
        this.enterCount();
        return true;
      case 'results':
      case 'oops':
        this.enterLobby(this.phase === 'results');
        return true;
      default:
        return false;
    }
  }

  /** Would `next()` do something right now (leader NEXT button live)? */
  get canNext(): boolean {
    if (!this.running || this.menuOpen) return false;
    if (this.paused) return true;
    return this.phase === 'lobby' || this.phase === 'intro' || this.phase === 'results' || this.phase === 'oops';
  }

  setPaused(on: boolean): void {
    if (!this.running || on === this.paused) return;
    this.paused = on;
    if (!on) this.menuPaused = false;
    this.lastReal = nowMs();
    this.sound.sfx('pause');
    this.bump();
  }

  /** S: skip the current minigame (no points). On the scoreboard: re-roll the teased game. */
  skip(): void {
    if (!this.running) return;
    if (this.paused) this.setPaused(false);
    switch (this.phase) {
      case 'intro':
      case 'count':
      case 'play':
        this.abortRound('skip');
        break;
      case 'results':
      case 'oops':
        this.enterLobby(this.phase === 'results');
        break;
      case 'lobby':
        if (this.forced) this.forced = null;
        else {
          // Drop the teased game for this bag pass and draw another one.
          this.drawn = null;
        }
        this.refreshUpcoming();
        this.bump();
        break;
    }
  }

  /** R: replay the last minigame next. */
  replay(): boolean {
    const last = this.lastResults?.game || this.picker.last;
    if (!last || !minigameById(last)) return false;
    this.forced = last;
    this.setStinger({ kind: 'info', text: '🔁 Replay!', sub: `${minigameById(last)!.meta.name} is up next`, color: '#2de2e6', ms: 1800 });
    if (this.phase === 'lobby') this.refreshUpcoming();
    this.bump();
    return true;
  }

  /** Test hook: next minigame = id, then advance to UP NEXT. */
  forceGame(id: string): boolean {
    if (!minigameById(id) || !this.running) return false;
    this.forced = id;
    if (this.paused) this.setPaused(false);
    if (this.phase !== 'lobby') this.disposeRound();
    this.enterIntro();
    return true;
  }

  setMenu(open: boolean): void {
    if (open === this.menuOpen) return;
    this.menuOpen = open;
    if (open && !this.paused) {
      this.setPaused(true);
      this.menuPaused = true;
    } else if (!open && this.menuPaused) {
      this.menuPaused = false;
      this.setPaused(false);
    }
    this.bump();
  }

  setSetting(k: string, v: unknown): boolean {
    const before = JSON.stringify(this.settings);
    this.settings = sanitiseSettings({ [k]: v }, this.settings);
    if (JSON.stringify(this.settings) === before) return false;
    saveSettings(this.settings);
    if (this.heat > this.settings.maxHeat) this.heat = this.settings.maxHeat;
    if (this.phase === 'lobby') {
      if (k === 'auto' || k === 'autoSec') this.phaseT = 0;
      this.refreshUpcoming();
    }
    this.bump(true);
    return true;
  }

  toggleGame(id: string, on: boolean): boolean {
    const en = new Set(this.settings.enabled);
    if (on) en.add(id);
    else {
      if (en.size <= 1) return false;
      en.delete(id);
    }
    return this.setSetting('enabled', MINIGAMES.map((m) => m.meta.id).filter((x) => en.has(x)));
  }

  resetScores(): void {
    for (const e of this.entries.values()) {
      e.pts = 0;
      e.wins = 0;
      e.rounds = 0;
      e.hist = [];
      e.lastPts = 0;
      e.lastRound = 0;
    }
    this.roundsPlayed = 0;
    this.history.length = 0;
    this.lastResults = null;
    this.picker.reset();
    this.drawn = null;
    this.drawnPass = false;
    this.heat = 1;
    this.sip = { count: 0, lastTarget: '' };
    if (this.phase === 'results') this.enterLobby(false);
    else if (this.phase === 'lobby') this.refreshUpcoming();
    this.bump(true);
  }

  /** Remove a player from the party (Esc menu). */
  removePlayer(id: string): void {
    const e = this.entries.get(id);
    if (e) this.markRemoved(e);
    try {
      this.host.kick(id);
    } catch (err) {
      console.warn('[rush] kick failed', err);
    }
    this.bump(true);
  }

  // =================================================================== party events

  onPlayer(id: string, ev: 'join' | 'rejoin' | 'leave' | 'remove' | 'profile'): void {
    const sp = this.host.players().find((p) => p.playerId === id);
    switch (ev) {
      case 'join': {
        const e = this.ensure(id);
        if (e.removedAt) {
          e.removedAt = 0;
          e.hidden = false;
          e.st = 'new';
        }
        e.connected = true;
        this.sent.delete(id);
        break;
      }
      case 'rejoin': {
        const e = this.ensure(id);
        e.connected = sp ? sp.connected : true;
        e.removedAt = 0;
        this.sent.delete(id);
        if (e.st === 'away' && e.awayWhy === 'disc' && e.connected) this.comeBack(e, false);
        break;
      }
      case 'leave': {
        const e = this.entries.get(id);
        if (!e) break;
        e.connected = false;
        this.goAway(e, 'disc');
        this.sent.delete(id);
        break;
      }
      case 'remove': {
        const e = this.entries.get(id);
        if (e) this.markRemoved(e);
        this.sent.delete(id);
        break;
      }
      case 'profile':
        break;
    }
    this.reconcile();
    this.bump(true);
  }

  onMg(id: string, m: MgFromPhone): void {
    if (!this.running || !m || typeof m !== 'object') return;
    const e = this.entries.get(id) ?? (this.host.players().some((p) => p.playerId === id) ? this.ensure(id) : null);
    if (!e) return;
    switch (m.k) {
      case 'here':
        e.connected = true;
        this.markActive(e.id);
        if (e.st === 'new' || e.st === 'away') this.comeBack(e, true);
        return;
      case 'away':
        this.goAway(e, 'hidden');
        return;
      case 'next':
        if (this.leaderId() === id && this.canNext) this.next();
        return;
      case 'mode': {
        const touch = m.v === 0;
        if (touch !== e.touch) {
          e.touch = touch;
          const rp = this.round?.parts.get(id);
          if (rp) (rp as { touch: boolean }).touch = touch;
          this.bump();
        }
        return;
      }
      case 'act':
        this.markActive(e.id);
        return;
      default:
        this.onGesture(e, m);
    }
  }

  private onGesture(e: Entry, m: MgFromPhone): void {
    const r = this.round;
    if (this.phase !== 'play' || this.paused || !r || !r.mg) return;
    if (m.rid !== r.rid) return;
    const p = r.parts.get(e.id);
    if (!p || !r.present.has(e.id)) return;
    const k = m.k as RushEvent;
    if (k !== 'tap' && !r.def.meta.events.includes(k)) return;
    if (k !== 'tap' && k !== 'flick' && k !== 'raise' && k !== 'pose') return;
    this.markActive(e.id);
    if (e.st !== 'play') return;
    const ev = this.toEvent(r, e.id, m);
    if (r.mg.onEvent) this.guard('onEvent', () => r.mg!.onEvent!(p, ev));
  }

  private toEvent(r: RoundState, id: string, m: Pick<MgFromPhone, 'k' | 'v' | 'x' | 'y' | 'ms' | 'c'>): RushInputEvent {
    const num = (v: unknown, lo: number, hi: number, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
    const cur = r.cues.get(id);
    const cueId = typeof m.c === 'number' && Number.isFinite(m.c) ? m.c : cur ? cur.cue.id : null;
    const ms = typeof m.ms === 'number' && Number.isFinite(m.ms) ? Math.max(0, Math.min(10000, m.ms)) : null;
    const k = m.k as RushEvent;
    return {
      k,
      v: k === 'pose' ? Math.round(num(m.v, -1, 5, -1)) : num(m.v, 0, 100),
      x: num(m.x, -100, 100),
      y: num(m.y, -100, 100),
      ms,
      cueId,
      at: r.time,
    };
  }

  inputFrom(id: string, s: DecodedStream): void {
    const r = this.round;
    if (!this.running || this.phase !== 'play' || this.paused || !r || !r.mg) return;
    if (s.rid !== r.rid) return;
    const meta = r.def.meta;
    if (!meta.stream) return;
    const p = r.parts.get(id);
    if (!p || !r.present.has(id)) return;
    const prev = r.streams.get(id);
    if (prev) {
      // Stale / duplicate packet (allow a sequence reset after a phone reload).
      if (s.seq <= prev.seq && prev.seq - s.seq < 2000) return;
      // Never faster than ~40 Hz on average (token bucket: protects the minigame from a flooding client,
      // while network-bunched packets still all get through).
      const real = nowMs();
      prev.tokens = Math.min(4, prev.tokens + ((real - prev.real) / 1000) * STREAM_MAX_HZ);
      prev.real = real;
      if (prev.tokens < 1) return;
      prev.tokens -= 1;
    }
    const rec = prev ?? { seq: s.seq, at: this.clock, a: s.a, b: s.b, c: s.c, moves: 0, tokens: 3, real: nowMs() };
    if (prev && meaningful(meta.stream, prev, s)) rec.moves++;
    else if (!prev && (meta.stream === 'shake' ? s.a > 150 : meta.stream === 'still' ? s.a > 120 : false)) rec.moves++;
    rec.seq = s.seq;
    rec.at = this.clock;
    rec.a = s.a;
    rec.b = s.b;
    rec.c = s.c;
    r.streams.set(id, rec);
    if (rec.moves >= 3) this.markActive(id);
    const e = this.entries.get(id);
    if (e && e.st !== 'play') return;
    if (r.mg.onStream) this.guard('onStream', () => r.mg!.onStream!(p, { a: s.a, b: s.b, c: s.c }));
  }

  // =================================================================== roster

  private ensure(id: string): Entry {
    let e = this.entries.get(id);
    if (e) return e;
    const sp = this.host.players().find((p) => p.playerId === id);
    const slot = sp?.slot ?? 0;
    e = {
      id,
      name: sp?.name ?? 'Player',
      emoji: sp?.emoji || PLAYER_EMOJIS[slot % PLAYER_EMOJIS.length],
      color: SLOT_COLORS[slot % SLOT_COLORS.length],
      slot,
      st: 'new',
      connected: sp ? sp.connected : false,
      touch: false,
      pts: 0,
      wins: 0,
      rounds: 0,
      hist: [],
      everHere: false,
      safeUntil: 0,
      joinedAt: 0,
      awaySince: 0,
      awayWhy: '',
      removedAt: 0,
      hidden: false,
      lastRound: 0,
      lastPts: 0,
    };
    this.entries.set(id, e);
    return e;
  }

  /** Sync names / colours / connection with the session's player list. */
  reconcile(): void {
    const list = this.host.players();
    const ids = new Set<string>();
    for (const sp of list) {
      ids.add(sp.playerId);
      const e = this.ensure(sp.playerId);
      const color = SLOT_COLORS[sp.slot % SLOT_COLORS.length];
      const emoji = sp.emoji || e.emoji;
      if (e.name !== sp.name || e.color !== color || e.emoji !== emoji || e.slot !== sp.slot) {
        e.name = sp.name;
        e.color = color;
        e.emoji = emoji;
        e.slot = sp.slot;
        this.version++;
      }
      if (e.removedAt) {
        e.removedAt = 0;
        e.hidden = false;
      }
      if (e.connected !== sp.connected) {
        e.connected = sp.connected;
        if (!sp.connected) this.goAway(e, 'disc');
        else if (e.st === 'away' && e.awayWhy === 'disc') this.comeBack(e, false);
        this.version++;
      }
    }
    for (const e of this.entries.values()) {
      if (!ids.has(e.id) && !e.removedAt) this.markRemoved(e);
    }
  }

  private markRemoved(e: Entry): void {
    if (e.removedAt) return;
    this.goAway(e, 'disc');
    e.connected = false;
    e.removedAt = Date.now();
    this.sent.delete(e.id);
  }

  private comeBack(e: Entry, tap: boolean): void {
    const wall = Date.now();
    if (tap && !e.everHere) {
      e.everHere = true;
      e.safeUntil = wall + LOOP.safeCardSec * 1000;
      e.joinedAt = wall;
      this.sound.sfx('join');
    }
    if (!tap && !e.everHere) return; // reconnect of a phone that never joined: still 'new'
    e.awaySince = 0;
    e.awayWhy = '';
    e.hidden = false;
    const r = this.round;
    if (r && (this.phase === 'count' || this.phase === 'play') && r.parts.has(e.id)) {
      if (!r.present.has(e.id) && r.mg?.onReturn) {
        r.present.add(e.id);
        e.st = 'play';
        const p = r.parts.get(e.id)!;
        this.guard('onReturn', () => r.mg!.onReturn!(p));
      } else e.st = r.present.has(e.id) ? 'play' : 'next';
    } else if (this.phase === 'lobby' || this.phase === 'intro') e.st = 'play';
    else e.st = 'next';
    this.bump(true);
  }

  private goAway(e: Entry, why: 'idle' | 'hidden' | 'disc'): void {
    if (e.st === 'new') return;
    if (e.st !== 'away') {
      e.st = 'away';
      e.awaySince = Date.now();
      e.awayWhy = why;
    } else if (why === 'disc') e.awayWhy = 'disc';
    const r = this.round;
    if (r && r.present.has(e.id) && (this.phase === 'count' || this.phase === 'play')) {
      r.present.delete(e.id);
      r.cues.delete(e.id);
      const p = r.parts.get(e.id);
      if (p && r.mg?.onLeave) this.guard('onLeave', () => r.mg!.onLeave!(p));
    } else if (r) r.present.delete(e.id);
    this.bump(true);
  }

  private markActive(id: string): void {
    const r = this.round;
    if (r && this.phase === 'play' && r.parts.has(id)) r.active.add(id);
  }

  private housekeeping(): void {
    const wall = Date.now();
    let changed = false;
    for (const e of this.entries.values()) {
      if (e.hidden) continue;
      if (e.removedAt && wall - e.removedAt > REMOVED_SHOW_MS) {
        e.hidden = true;
        changed = true;
      } else if (e.st === 'away' && e.awaySince && wall - e.awaySince > LOOP.dropAfterAwayMs) {
        e.hidden = true;
        changed = true;
      }
    }
    if (this.phase === 'lobby' && !this.forced) {
      // Roster changes can make the teased game unplayable (min players): re-draw so tease == play.
      const before = this.upcoming;
      this.refreshUpcoming();
      if (before !== this.upcoming) changed = true;
    }
    if (this.stinger && wall - this.stinger.at > this.stinger.ms) {
      this.stinger = null;
      changed = true;
    }
    if (changed) this.bump(true);
  }

  /** Humans who are in (tapped join, connected, not away). */
  presentHumans(): Entry[] {
    return [...this.entries.values()].filter((e) => e.connected && !e.removedAt && (e.st === 'play' || e.st === 'next'));
  }

  private hadHumans(r: RoundState): boolean {
    for (const id of r.parts.keys()) if (!isBotId(id)) return true;
    return false;
  }

  private anyHumanPresent(r: RoundState): boolean {
    for (const id of r.present) if (!isBotId(id)) return true;
    return false;
  }

  private estimateParticipants(): number {
    const n = this.presentHumans().length;
    return n <= 1 ? LOOP.soloTotal : n;
  }

  /** Scoreboard rows: visible humans, best first. */
  board(): Entry[] {
    return [...this.entries.values()]
      .filter((e) => !e.hidden && (e.everHere || e.pts > 0))
      .sort((a, b) => b.pts - a.pts || b.wins - a.wins || a.slot - b.slot);
  }

  streak(e: Entry): number {
    const from = this.roundsPlayed - LOOP.streakRounds;
    let s = 0;
    for (const h of e.hist) if (h.r > from) s += h.p;
    return s;
  }

  leaderId(): string | null {
    return this.host.players().find((p) => p.isLeader)?.playerId ?? null;
  }

  /** Bag-drawn next game (kept until it plays; re-drawn only if it became disabled / ineligible). */
  private drawn: string | null = null;
  private drawnPass = false;

  private ensureDrawn(players: number): void {
    if (this.drawn) {
      const d = minigameById(this.drawn);
      if (d && this.settings.enabled.includes(this.drawn) && d.meta.minPlayers <= Math.max(1, players)) return;
      // Not playable right now: back to the front of the bag for later.
      if (d && this.settings.enabled.includes(this.drawn)) this.picker.bag.unshift(this.drawn);
      this.drawn = null;
    }
    const t = this.picker.take(this.settings.enabled, players);
    if (t) {
      this.drawn = t.id;
      this.drawnPass = this.drawnPass || t.newPass;
    }
  }

  private refreshUpcoming(): void {
    if (this.forced && minigameById(this.forced)) this.upcoming = this.forced;
    else {
      this.ensureDrawn(this.estimateParticipants());
      this.upcoming = this.drawn;
    }
  }

  // =================================================================== minigame context + bots

  private makeCtx(r: RoundState): MinigameCtx {
    const self = this;
    const rand = seededRandom(r.seed);
    const players = [...r.parts.values()];
    return {
      heat: r.heat,
      players,
      rand,
      get time() {
        return r.time;
      },
      get timeLeft() {
        return Math.max(0, r.duration - r.time);
      },
      duration: r.duration,
      isPresent: (id) => r.present.has(id),
      cue(id, cue, fire = true) {
        if (!r.parts.has(id)) return 0;
        if (cue === null || cue === undefined) {
          r.cues.delete(id);
          return 0;
        }
        const cur = r.cues.get(id);
        const clean = { ...cue } as Record<string, unknown>;
        if (Array.isArray(cue.hint)) clean.hint = cue.hint.slice(0, 8).map((x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : 0));
        if (typeof cue.word === 'string') clean.word = cue.word.slice(0, 14);
        if (fire || !cur) {
          const nid = ++self.cueSeq;
          r.cues.set(id, { cue: { ...(clean as Omit<typeof cue, 'id'>), id: nid }, at: self.clock });
          return nid;
        }
        cur.cue = { ...(clean as Omit<typeof cue, 'id'>), id: cur.cue.id };
        return cur.cue.id;
      },
      word(id, w) {
        if (!r.parts.has(id)) return;
        if (!w) r.words.delete(id);
        else r.words.set(id, String(w).slice(0, 14));
      },
      sfx(name, o) {
        if (self.round === r) self.sound.sfx(name, o);
      },
      shout(text, o) {
        if (self.round !== r) return;
        r.shout = { text: String(text).slice(0, 24), at: self.clock, ms: o?.ms ?? SHOUT_MS, color: o?.color ?? '#ffffff', size: o?.size ?? 1 };
      },
      end() {
        r.endReq = true;
      },
    };
  }

  private stepBots(r: RoundState, dt: number): void {
    if (!r.bots.size || !r.mg) return;
    const meta = r.def.meta;
    for (const [id, b] of r.bots) {
      if (!b.bot || !r.present.has(id)) continue;
      const cue = r.cues.get(id);
      let hint: number[] | undefined;
      if (r.mg.botHint) {
        if (!this.guard('botHint', () => (hint = r.mg!.botHint!(id)))) return;
      }
      let out: BotOut = {};
      try {
        out = b.bot.step({ msg: this.botMsg(r, id), dt, time: r.time, cueAgeMs: cue ? (this.clock - cue.at) * 1000 : null, hint }) ?? {};
      } catch (err) {
        this.logError('bot', err, meta.id);
        b.bot = null;
        continue;
      }
      b.acc += dt;
      if (out.stream && meta.stream && b.acc >= 0.05 && r.mg.onStream) {
        b.acc = Math.min(0.05, b.acc - 0.05);
        const k = (v: unknown): number => Math.max(-1000, Math.min(1000, Math.round(typeof v === 'number' && Number.isFinite(v) ? v : 0)));
        const sample = { a: k(out.stream[0]), b: k(out.stream[1]), c: k(out.stream[2]) };
        if (!this.guard('onStream', () => r.mg!.onStream!(b.p, sample))) return;
      } else if (b.acc > 0.2) b.acc = 0.05;
      for (const e of out.events ?? []) {
        if (!r.mg.onEvent || !e) continue;
        if (e.k !== 'tap' && !meta.events.includes(e.k as never)) continue;
        if (e.k !== 'tap' && e.k !== 'flick' && e.k !== 'raise' && e.k !== 'pose') continue;
        const ev = this.toEvent(r, id, e);
        if (!this.guard('onEvent', () => r.mg!.onEvent!(b.p, ev))) return;
      }
      if (this.phase !== 'play') return;
    }
  }

  /** The RushPhoneMsg a phone would get (bots see exactly this). */
  private botMsg(r: RoundState, id: string): import('../../../net/protocol').RushPhoneMsg {
    const meta = r.def.meta;
    const p = r.parts.get(id)!;
    return {
      t: 'mg',
      ph: this.phase === 'count' ? 'count' : 'play',
      rid: r.rid,
      round: r.n,
      heat: r.heat,
      g: meta.id,
      name: meta.name,
      instr: meta.instr,
      demo: meta.demo,
      word: r.words.get(id) || meta.word,
      s: meta.stream,
      ev: meta.events,
      touch: meta.touch,
      cd: this.phase === 'count' ? this.cd : 0,
      left: Math.ceil(Math.max(0, r.duration - r.time)),
      me: ((t) => (t === undefined ? { st: 'play' as const, name: p.name, emoji: p.emoji, color: p.color, pts: 0, rank: 0, lead: false } : { st: 'play' as const, name: p.name, emoji: p.emoji, color: p.color, pts: 0, rank: 0, lead: false, team: t }))(this.teamOf(r, id)),
      cue: r.cues.get(id)?.cue ?? null,
      res: null,
      safe: false,
      canNext: false,
      sip: '',
    };
  }

  // =================================================================== rendering hooks

  /** Render the minigame (count / play / results). Returns false if there is nothing to draw. */
  renderMinigame(g: CanvasRenderingContext2D, dt: number, scale: number): boolean {
    const r = this.round;
    if (!r || !r.mg) return false;
    const phase: RenderView['phase'] | null = this.phase === 'count' ? 'count' : this.phase === 'play' ? 'play' : this.phase === 'results' ? 'results' : null;
    if (!phase) return false;
    g.save();
    let ok = false;
    try {
      r.mg.render(g, { t: this.clock - r.mgAt, dt: this.paused ? 0 : dt, phase, scale });
      ok = true;
    } catch (err) {
      ok = false;
      g.restore();
      // A results-phase render error must not erase the points already awarded.
      if (this.phase === 'results') {
        this.logError('render', err, r.def.meta.id);
        r.mg = null;
        return false;
      }
      this.fail('render', err);
      return false;
    }
    g.restore();
    return ok;
  }

  // =================================================================== errors

  /** Run a minigame call; on throw → "Oops — skipping that one!" (no points). Returns false on failure. */
  private guard(where: string, fn: () => void): boolean {
    try {
      fn();
      return true;
    } catch (err) {
      this.fail(where, err);
      return false;
    }
  }

  private fail(where: string, err: unknown): void {
    const game = this.round?.def.meta.id ?? '';
    this.logError(where, err, game);
    if (this.phase === 'results') {
      // Points are in already: just leave the results card up without the minigame.
      if (this.round) this.round.mg = null;
      return;
    }
    this.oopsMsg = game ? minigameById(game)?.meta.name ?? game : '';
    this.abortRound('oops');
  }

  private logError(where: string, err: unknown, game = this.round?.def.meta.id ?? ''): void {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[rush] ${game || 'shell'} ${where} failed:`, err);
    this.errors.push({ at: Date.now(), where, game, msg: msg.slice(0, 200) });
    while (this.errors.length > 30) this.errors.shift();
  }

  // =================================================================== stingers / misc

  setStinger(s: Omit<Stinger, 'at'>): void {
    this.stinger = { ...s, at: Date.now() };
    this.version++;
  }

  private bump(save = false): void {
    this.version++;
    if (save) {
      try {
        this.host.changed();
      } catch {
        /* ignore */
      }
    }
  }

  /** Current UP NEXT segment length (s). */
  introLen(): number {
    return LOOP.upNextSec + (this.round?.energetic ? LOOP.safeCardSec : 0);
  }

  // =================================================================== phone sync

  /** Build the RushPhoneMsg for one human (exact protocol shape). */
  phoneMsg(e: Entry, rank: number, lead: boolean): import('../../../net/protocol').RushPhoneMsg {
    const r = this.round;
    const inRound = !!r && this.phase !== 'lobby' && this.phase !== 'oops';
    const meta = inRound ? r!.def.meta : null;
    const part = !!r && r.parts.has(e.id) && r.present.has(e.id);
    const ph = this.paused ? 'paused' : this.phase === 'oops' ? 'lobby' : this.phase;
    const live = part && (this.phase === 'count' || this.phase === 'play');
    let res: import('../../../net/protocol').RushPhoneMsg['res'] = null;
    let sip = '';
    if (this.phase === 'results' && this.lastResults && r && this.lastResults.rid === r.rid) {
      const row = this.lastResults.rows.find((x) => x.id === e.id);
      if (row) {
        const sup = this.lastResults.sups.find((s) => s.id === e.id);
        res = { place: row.place, pts: row.pts, line: sup ? sup.text : row.place === 1 ? 'You WON! 🏆' : row.place === 2 ? '2nd place! 🥈' : row.place === 3 ? '3rd place! 🥉' : 'Nice try! 💪' };
      }
      sip = this.lastResults.sip;
    }
    const wall = Date.now();
    const team = r && r.parts.has(e.id) && (this.phase === 'count' || this.phase === 'play' || this.phase === 'results') ? this.teamOf(r, e.id) : undefined;
    const safe = (this.phase === 'intro' && this.safeNow && e.st === 'play') || wall < e.safeUntil;
    return {
      t: 'mg',
      ph,
      rid: this.rid,
      round: r ? r.n : this.roundsPlayed + 1,
      heat: this.heat,
      g: meta ? meta.id : '',
      name: meta ? meta.name : '',
      instr: meta ? meta.instr : '',
      demo: meta ? meta.demo : '',
      word: meta ? (part && r!.words.get(e.id)) || meta.word : '',
      s: live && meta ? meta.stream : null,
      ev: live && meta ? [...meta.events] : [],
      touch: meta ? meta.touch : '',
      cd: this.phase === 'count' ? this.cd : 0,
      left: this.phase === 'play' && r ? Math.ceil(Math.max(0, r.duration - r.time)) : -1,
      me: team === undefined ? { st: e.st, name: e.name, emoji: e.emoji, color: e.color, pts: e.pts, rank, lead } : { st: e.st, name: e.name, emoji: e.emoji, color: e.color, pts: e.pts, rank, lead, team },
      cue: live ? r!.cues.get(e.id)?.cue ?? null : null,
      res,
      safe,
      canNext: lead && this.canNext,
      sip,
    };
  }

  /** Team of a participant in a team minigame (never throws; a broken teamOf just shows no team). */
  teamOf(r: RoundState, id: string): number | undefined {
    const mg = r.mg;
    if (!mg || !mg.teamOf) return undefined;
    try {
      const t = mg.teamOf(id);
      return typeof t === 'number' && Number.isFinite(t) ? Math.max(0, Math.min(7, Math.round(t))) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Send every connected phone its message if it changed (JSON diff). Cheap enough to run per frame. */
  syncPhones(): void {
    if (!this.running) return;
    const lead = this.leaderId();
    const ranks = this.ranks();
    for (const sp of this.host.players()) {
      if (!sp.connected) continue;
      const e = this.entries.get(sp.playerId);
      if (!e) continue;
      const msg = this.phoneMsg(e, ranks.get(e.id) ?? 0, lead === e.id);
      const json = JSON.stringify(msg);
      if (this.sent.get(e.id) === json) continue;
      this.sent.set(e.id, json);
      this.lastMsgBytes = json.length;
      if (json.length > this.maxMsgBytes) this.maxMsgBytes = json.length;
      this.msgsSent++;
      try {
        this.host.send(e.id, msg);
      } catch (err) {
        console.warn('[rush] send failed', err);
      }
    }
  }

  private rankCache: { v: number; m: Map<string, number> } | null = null;

  ranks(): Map<string, number> {
    if (this.rankCache && this.rankCache.v === this.version) return this.rankCache.m;
    const list = [...this.entries.values()].filter((e) => !e.hidden && e.pts > 0).sort((a, b) => b.pts - a.pts);
    const m = new Map<string, number>();
    let prev = Number.NaN;
    let prevRank = 0;
    list.forEach((e, i) => {
      const rank = e.pts === prev ? prevRank : i + 1;
      prev = e.pts;
      prevRank = rank;
      m.set(e.id, rank);
    });
    this.rankCache = { v: this.version, m };
    return m;
  }

  /** Forget the per-phone diff so the next sync re-sends (phone reloaded / rejoined). */
  resend(id?: string): void {
    if (id) this.sent.delete(id);
    else this.sent.clear();
  }

  // =================================================================== snapshot

  snapshot(): unknown {
    const players = [...this.entries.values()]
      .filter((e) => e.pts > 0 || e.everHere)
      .slice(0, 64)
      .map((e) => ({ id: e.id, name: e.name, emoji: e.emoji, color: e.color, slot: e.slot, pts: e.pts, wins: e.wins, rounds: e.rounds, hist: e.hist.map((h) => [h.r, h.p]), touch: e.touch }));
    return {
      v: 1,
      round: this.roundsPlayed,
      rid: this.rid,
      cueSeq: this.cueSeq,
      heat: this.heat,
      picker: this.picker.snap(),
      drawn: this.drawn,
      sip: { ...this.sip },
      players,
      history: this.history.slice(-10),
    };
  }

  restore(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const s = raw as Record<string, unknown>;
    if (s.v !== 1) return;
    const int = (v: unknown, lo: number, hi: number, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.floor(v))) : d);
    this.roundsPlayed = int(s.round, 0, 1e6, 0);
    this.rid = int(s.rid, 0, 1e9, 0);
    this.cueSeq = int(s.cueSeq, 0, 1e9, 0);
    this.heat = int(s.heat, 1, 3, 1) as Heat;
    this.picker.restore(s.picker);
    if (typeof s.drawn === 'string' && minigameById(s.drawn)) this.drawn = s.drawn;
    if (s.sip && typeof s.sip === 'object') {
      const sp = s.sip as Record<string, unknown>;
      this.sip = { count: int(sp.count, 0, 1e6, 0), lastTarget: typeof sp.lastTarget === 'string' ? sp.lastTarget.slice(0, 64) : '' };
    }
    if (Array.isArray(s.players)) {
      for (const raw of s.players.slice(0, 64)) {
        if (!raw || typeof raw !== 'object') continue;
        const p = raw as Record<string, unknown>;
        if (typeof p.id !== 'string' || !p.id || p.id.length > 64 || isBotId(p.id)) continue;
        const slot = int(p.slot, 0, 15, 0);
        const e = this.ensure(p.id);
        e.name = typeof p.name === 'string' ? p.name.slice(0, 20) : e.name;
        e.emoji = typeof p.emoji === 'string' && p.emoji.length <= 8 ? p.emoji : e.emoji;
        e.slot = slot;
        e.color = typeof p.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(p.color) ? p.color : SLOT_COLORS[slot];
        e.pts = int(p.pts, 0, 1e7, 0);
        e.wins = int(p.wins, 0, 1e6, 0);
        e.rounds = int(p.rounds, 0, 1e6, 0);
        e.hist = Array.isArray(p.hist)
          ? p.hist
              .filter((h): h is [number, number] => Array.isArray(h) && h.length === 2 && h.every((x) => typeof x === 'number' && Number.isFinite(x)))
              .slice(-LOOP.streakRounds)
              .map(([r, q]) => ({ r: Math.floor(r), p: Math.max(0, Math.floor(q)) }))
          : [];
        e.touch = p.touch === true;
        // Back when their phone reconnects (session sends 'rejoin'); until then: away.
        e.everHere = true;
        e.st = 'away';
        e.awayWhy = 'disc';
        e.awaySince = Date.now();
        e.connected = false;
      }
    }
    if (Array.isArray(s.history)) {
      this.history.length = 0;
      for (const h of s.history.slice(-10)) {
        if (!h || typeof h !== 'object') continue;
        const x = h as Record<string, unknown>;
        if (typeof x.g !== 'string' || !minigameById(x.g)) continue;
        this.history.push({ r: int(x.r, 0, 1e6, 0), g: x.g, win: Array.isArray(x.win) ? x.win.filter((w): w is string => typeof w === 'string').slice(0, 16) : [] });
      }
    }
    this.bump();
  }

  // =================================================================== debug

  getState(fps: number): Record<string, unknown> {
    const r = this.round;
    const ranks = this.ranks();
    const players: Record<string, unknown>[] = [...this.entries.values()]
      .filter((e) => !e.hidden)
      .map((e) => ({ id: e.id, name: e.name, emoji: e.emoji, color: e.color, st: e.st, pts: e.pts, streak: this.streak(e), rank: ranks.get(e.id) ?? 0, touch: e.touch, bot: false, connected: e.connected }));
    if (r) for (const b of r.bots.values()) players.push({ id: b.p.id, name: b.p.name, emoji: b.p.emoji, color: b.p.color, st: 'play', pts: 0, streak: 0, rank: 0, touch: false, bot: true, connected: true });
    return {
      phase: this.phase,
      round: r ? r.n : this.roundsPlayed + 1,
      roundsPlayed: this.roundsPlayed,
      heat: this.heat,
      game: r ? r.def.meta.id : '',
      upcoming: this.upcoming,
      rid: this.rid,
      timeLeft: this.phase === 'play' && r ? Math.max(0, r.duration - r.time) : this.phase === 'lobby' ? (this.settings.auto && this.presentHumans().length ? Math.max(0, this.settings.autoSec - this.phaseT) : -1) : -1,
      paused: this.paused,
      menu: this.menuOpen,
      auto: this.settings.auto,
      participants: r ? [...r.parts.keys()] : [],
      players,
      lastResults: this.lastResults,
      errors: [...this.errors],
      bag: [...this.picker.bag],
      settings: { ...this.settings, enabled: [...this.settings.enabled] },
      msgBytes: { last: this.lastMsgBytes, max: this.maxMsgBytes, sent: this.msgsSent },
      fps,
    };
  }
}

/** Does this stream sample show a hand-held, moving phone (vs one lying flat streaming constants)? */
function meaningful(stream: string, prev: { a: number; b: number; c: number }, s: { a: number; b: number; c: number }): boolean {
  switch (stream) {
    case 'shake':
      return s.a > 150;
    case 'still':
      return s.a > 120;
    case 'pose':
      return s.a !== prev.a;
    case 'pitch':
      return Math.abs(s.a - prev.a) > 60;
    default:
      return Math.abs(s.a - prev.a) + Math.abs(s.b - prev.b) > 60;
  }
}
