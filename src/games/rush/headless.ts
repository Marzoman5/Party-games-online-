/**
 * LEAD — headless minigame runner (Node or browser, no DOM). Runs one minigame with bot players
 * through count → play → results using the same Minigame/MinigameCtx/Bot contracts as the shell, and
 * a no-op canvas so render() code paths execute too. Used by scripts/rush-selftest.ts and by minigame
 * authors while developing:  npx tsx scripts/rush-selftest.ts --game hot-potato --players 8
 */
import type { MgFromPhone, RushCue, RushPhoneMsg } from '../../net/protocol';
import { PLAYER_EMOJIS, SLOT_COLORS } from '../../net/protocol';
import { seededRandom } from './draw';
import type { Bot, BotFactory, Heat, Minigame, MinigameCtx, MinigameDef, MinigameResult, RushInputEvent, RushPlayer } from './types';

export interface HeadlessOptions {
  players: number;
  heat?: Heat;
  seed?: number;
  /** Simulation step (s). */
  dt?: number;
  /** Fraction of players (0..1) that go away at a random moment mid-round. */
  leaveRate?: number;
  /** Players using the touch fallback (bots still produce the same stream/events). */
  touchRate?: number;
  /** Bot skill 0..1 (default: spread 0.2..0.9). */
  skill?: number;
  /** Throw if render() throws (default true). */
  render?: boolean;
}

export interface HeadlessReport {
  id: string;
  players: number;
  heat: Heat;
  /** Simulated play seconds. */
  seconds: number;
  endedEarly: boolean;
  result: MinigameResult;
  left: string[];
  cuesFired: number;
  events: number;
  streamSamples: number;
  problems: string[];
}

/** A Canvas 2D context that accepts every call and returns harmless values. */
export function noopCanvas(): CanvasRenderingContext2D {
  const gradient = { addColorStop() {} };
  const target: Record<string | symbol, unknown> = {
    measureText: (t: string) => ({ width: String(t).length * 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createConicGradient: () => gradient,
    createPattern: () => null,
    getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    isPointInPath: () => false,
    canvas: { width: 1920, height: 1080 },
  };
  return new Proxy(target, {
    get(t, k) {
      if (k in t) return t[k];
      return () => undefined;
    },
    set(t, k, v) {
      t[k] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

interface Sim {
  p: RushPlayer;
  bot: Bot;
  present: boolean;
  leaveAt: number;
  cue: RushCue | null;
  cueAt: number;
  word: string;
}

/** A steppable headless round (used by runHeadless and the browser dev harness). */
export interface HeadlessSim {
  readonly ctx: MinigameCtx;
  readonly mg: Minigame;
  readonly time: number;
  readonly over: boolean;
  /** Advance the simulation by dt seconds (bots + update). */
  step(dt: number): void;
  /** Render one frame. */
  render(g: CanvasRenderingContext2D, phase: 'count' | 'play' | 'results', t: number, scale?: number): void;
  /** End the round and return the checked report. */
  finish(): HeadlessReport;
  /** Last shout (harness display). */
  readonly lastShout: { text: string; at: number; color?: string } | null;
}

export function createHeadless(def: MinigameDef, bots: BotFactory, o: HeadlessOptions): HeadlessSim {
  const heat: Heat = o.heat ?? 1;
  const seed = o.seed ?? 1234;
  const rand = seededRandom(seed);
  const botRand = seededRandom(seed ^ 0x5bd1e995);
  const meta = def.meta;
  const duration = meta.duration[heat - 1];
  const problems: string[] = [];
  let cueSeq = 0;
  let cuesFired = 0;
  let events = 0;
  let streamSamples = 0;
  let time = 0;
  let ended = false;
  let lastShout: HeadlessSim['lastShout'] = null;

  const sims: Sim[] = [];
  for (let i = 0; i < o.players; i++) {
    const touch = o.touchRate ? botRand() < o.touchRate : false;
    const p: RushPlayer = { id: `b${i + 1}`, name: `Bot ${i + 1}`, emoji: PLAYER_EMOJIS[i % PLAYER_EMOJIS.length], color: SLOT_COLORS[i % SLOT_COLORS.length], bot: true, touch };
    const leaves = o.leaveRate ? botRand() < o.leaveRate : false;
    sims.push({
      p,
      bot: bots(seededRandom(seed + i * 7919), o.skill ?? 0.2 + 0.7 * ((i * 0.37) % 1)),
      present: true,
      leaveAt: leaves ? 1 + botRand() * Math.max(1, duration - 2) : Infinity,
      cue: null,
      cueAt: 0,
      word: '',
    });
  }
  const byId = new Map(sims.map((s) => [s.p.id, s]));

  const ctx: MinigameCtx = {
    heat,
    players: sims.map((s) => s.p),
    rand,
    get time() {
      return time;
    },
    get timeLeft() {
      return Math.max(0, duration - time);
    },
    duration,
    isPresent: (id) => !!byId.get(id)?.present,
    cue(id, cue, fire = true) {
      const s = byId.get(id);
      if (!s) return 0;
      if (cue === null) {
        s.cue = null;
        return 0;
      }
      if (fire || !s.cue) {
        s.cue = { ...cue, id: ++cueSeq };
        s.cueAt = time;
        cuesFired++;
      } else s.cue = { ...cue, id: s.cue.id };
      if (s.cue.hint && s.cue.hint.length > 8) problems.push(`cue.hint too long (${s.cue.hint.length})`);
      return s.cue.id;
    },
    word(id, w) {
      const s = byId.get(id);
      if (s) s.word = w;
    },
    sfx() {},
    shout(text, so) {
      lastShout = { text, at: time, color: so?.color };
    },
    end() {
      ended = true;
    },
  };

  const mg = def.create();
  const render = (g: CanvasRenderingContext2D, phase: 'count' | 'play' | 'results', t: number, scale = 0.5) => {
    if (o.render === false) return;
    try {
      mg.render(g, { t, dt: 1 / 60, phase, scale });
    } catch (err) {
      problems.push(`render(${phase}) threw: ${(err as Error).message}`);
    }
  };

  mg.start(ctx);
  render(noopCanvas(), 'count', 0);
  mg.go?.();

  const msgFor = (s: Sim): RushPhoneMsg => ({
    t: 'mg',
    ph: 'play',
    rid: 1,
    round: 1,
    heat,
    g: meta.id,
    name: meta.name,
    instr: meta.instr,
    demo: meta.demo,
    word: s.word || meta.word,
    s: meta.stream,
    ev: meta.events,
    touch: meta.touch,
    cd: 0,
    left: Math.ceil(Math.max(0, duration - time)),
    me: { st: 'play', name: s.p.name, emoji: s.p.emoji, color: s.p.color, pts: 0, rank: 0, lead: false },
    cue: s.cue,
    res: null,
    safe: false,
    canNext: false,
    sip: '',
  });

  let streamAcc = 0;
  const left: string[] = [];
  let report: HeadlessReport | null = null;

  const step = (dt: number) => {
    if (ended || time >= duration) return;
    time += dt;
    for (const s of sims) {
      if (s.present && time >= s.leaveAt) {
        s.present = false;
        left.push(s.p.id);
        mg.onLeave?.(s.p);
      }
    }
    streamAcc += dt;
    const streamTick = streamAcc >= 0.05;
    if (streamTick) streamAcc = 0;
    for (const s of sims) {
      if (!s.present) continue;
      const out = s.bot.step({ msg: msgFor(s), dt, time, cueAgeMs: s.cue ? (time - s.cueAt) * 1000 : null, hint: mg.botHint?.(s.p.id) });
      if (out.stream && meta.stream && streamTick && mg.onStream) {
        streamSamples++;
        mg.onStream(s.p, { a: clampI(out.stream[0]), b: clampI(out.stream[1]), c: clampI(out.stream[2]) });
      }
      for (const e of out.events ?? []) {
        if (!mg.onEvent) continue;
        if (e.k !== 'tap' && !meta.events.includes(e.k as never)) continue;
        events++;
        mg.onEvent(s.p, toEvent(e, s, time));
      }
    }
    mg.update(dt);
    if (mg.done()) ended = true;
  };

  const finish = (): HeadlessReport => {
    if (report) return report;
    const result = mg.results();
    render(noopCanvas(), 'results', time + 1);
    mg.dispose?.();
    const ids = new Set(sims.map((s) => s.p.id));
    const seen = new Set<string>();
    let prevPlace = 0;
    for (const r of result.ranking) {
      if (!ids.has(r.id)) problems.push(`ranking has unknown id ${r.id}`);
      if (seen.has(r.id)) problems.push(`ranking has ${r.id} twice`);
      seen.add(r.id);
      if (!(r.place >= 1) || r.place < prevPlace) problems.push(`bad place ${r.place} after ${prevPlace}`);
      prevPlace = r.place;
      if (typeof r.stat !== 'string') problems.push(`stat for ${r.id} is not a string`);
    }
    for (const s of sims) if (s.present && !seen.has(s.p.id)) problems.push(`present player ${s.p.id} missing from ranking`);
    if (result.ranking.length && result.ranking[0].place !== 1) problems.push('first place is not 1');
    for (const sup of result.superlatives ?? []) if (!ids.has(sup.id)) problems.push(`superlative for unknown id ${sup.id}`);
    report = { id: meta.id, players: o.players, heat, seconds: time, endedEarly: ended && time < duration - 1e-6, result, left, cuesFired, events, streamSamples, problems };
    return report;
  };

  return {
    ctx,
    mg,
    get time() {
      return time;
    },
    get over() {
      return ended || time >= duration;
    },
    get lastShout() {
      return lastShout;
    },
    step,
    render,
    finish,
  };
}

export function runHeadless(def: MinigameDef, bots: BotFactory, o: HeadlessOptions): HeadlessReport {
  const sim = createHeadless(def, bots, o);
  const dt = o.dt ?? 1 / 30;
  const g = noopCanvas();
  let renderAcc = 0;
  while (!sim.over) {
    sim.step(dt);
    renderAcc += dt;
    if (renderAcc > 0.5) {
      renderAcc = 0;
      sim.render(g, 'play', sim.time);
    }
  }
  return sim.finish();
}

function clampI(v: number): number {
  return Math.max(-1000, Math.min(1000, Math.round(Number.isFinite(v) ? v : 0)));
}

function toEvent(e: Omit<MgFromPhone, 't' | 'rid'>, s: Sim, time: number): RushInputEvent {
  const cueId = s.cue ? s.cue.id : null;
  const ms = typeof e.ms === 'number' && cueId !== null ? Math.max(0, Math.min(10000, e.ms)) : null;
  return { k: e.k as RushInputEvent['k'], v: e.v ?? 0, x: e.x ?? 0, y: e.y ?? 0, ms, cueId: typeof e.c === 'number' ? e.c : cueId, at: time };
}
