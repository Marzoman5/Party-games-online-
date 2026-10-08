/**
 * Shared helpers for the Party Rush end-to-end specs (tests/rush-*.spec.ts).
 *
 * Conventions (same as tests/helpers.ts): the host runs the production build, by default with the kart
 * STUB engine (`/?stub=1`, no three.js: Rush itself is plain Canvas 2D + DOM, so this is the real Rush
 * code at a fraction of the boot time); phones are BotPhones (scripts/bots.ts, Rush brains from
 * src/games/rush/bots.ts) or real `/play` pages in portrait mobile contexts. Rounds are driven through
 * `window.__rush` (forceGame / next / skip / pause / replay / setSetting) and predicates over its state,
 * never fixed sleeps for correctness.
 */
import { expect, type Browser, type Page } from '@playwright/test';
import { BotPhone } from '../scripts/bots';
import type { GameId } from '../src/net/protocol';
import { BASE_URL, LAPTOP, sleep } from './helpers';
import type { HubDbgState } from './smashHelpers';

// ------------------------------------------------------------------ page-side state (window.__rush)

export interface RushRowDbg {
  id: string;
  name: string;
  emoji: string;
  color: string;
  bot: boolean;
  touch: boolean;
  place: number;
  pts: number;
  stat: string;
}

export interface RushResultsDbg {
  round: number;
  rid: number;
  game: string;
  name: string;
  headline: string;
  rows: RushRowDbg[];
  sups: { id: string; text: string }[];
  sip: string;
}

export interface RushPlayerDbg {
  id: string;
  name: string;
  emoji: string;
  color: string;
  st: 'new' | 'play' | 'next' | 'away';
  pts: number;
  streak: number;
  rank: number;
  touch: boolean;
  bot: boolean;
  connected: boolean;
}

export interface RushDbgState {
  phase: 'lobby' | 'intro' | 'count' | 'play' | 'results' | 'oops';
  round: number;
  roundsPlayed: number;
  heat: number;
  game: string;
  upcoming: string | null;
  rid: number;
  timeLeft: number;
  paused: boolean;
  menu: boolean;
  auto: boolean;
  participants: string[];
  players: RushPlayerDbg[];
  lastResults: RushResultsDbg | null;
  errors: { at: number; where: string; game: string; msg: string }[];
  bag: string[];
  settings: { auto: boolean; autoSec: number; enabled: string[]; maxHeat: number; volume: number; sip: boolean };
  msgBytes: { last: number; max: number; sent: number };
  fps: number;
}

type RW = Window & {
  __rush?: {
    getState(): RushDbgState;
    next(): boolean;
    skip(): void;
    pause(on?: boolean): boolean;
    replay(): boolean;
    forceGame(id: string): boolean;
    setSetting(k: string, v: unknown): boolean;
    fps(): number;
  };
  __party?: { getState(): HubDbgState; pickGame(id: GameId): Promise<boolean>; setTvMode(on: boolean): void };
};

/** The 10 minigames, in registry order. */
export const RUSH_GAMES = ['shake-race', 'quick-draw', 'balance', 'tilt-maze', 'hot-potato', 'dont-move', 'tug-of-war', 'copy-pose', 'fishing', 'darts'] as const;
export type RushGameId = (typeof RUSH_GAMES)[number];

/** Hard caps (s) at heat 1 (meta.duration[0]) — used for timeouts (the shell adds a 3 s grace). */
export const RUSH_CAPS: Record<RushGameId, number> = {
  'shake-race': 12,
  'quick-draw': 25,
  balance: 35,
  'tilt-maze': 40,
  'hot-potato': 30,
  'dont-move': 15,
  'tug-of-war': 30,
  'copy-pose': 30,
  fishing: 40,
  darts: 25,
};

export function rushState(page: Page): Promise<RushDbgState> {
  return page.evaluate(() => (window as unknown as RW).__rush!.getState());
}

export function rushCall(page: Page, fn: 'next' | 'skip' | 'replay'): Promise<unknown> {
  return page.evaluate((f) => ((window as unknown as RW).__rush as unknown as Record<string, () => unknown>)[f](), fn);
}

export function rushForce(page: Page, id: string): Promise<boolean> {
  return page.evaluate((g) => (window as unknown as RW).__rush!.forceGame(g), id);
}

export function rushPause(page: Page, on?: boolean): Promise<boolean> {
  return page.evaluate((v) => (window as unknown as RW).__rush!.pause(v ?? undefined), on ?? null);
}

export function rushSetting(page: Page, k: string, v: unknown): Promise<boolean> {
  return page.evaluate(([kk, vv]) => (window as unknown as RW).__rush!.setSetting(kk as string, vv), [k, v] as const);
}

/** Wait for a JS expression over `r` (`__rush.getState()`) and `s` (`__party.getState()`). */
export async function waitRush(page: Page, pred: string, timeout = 60_000): Promise<RushDbgState> {
  await page.waitForFunction(
    (src) => {
      const w = window as unknown as RW;
      if (!w.__rush || !w.__party) return false;
      const r = w.__rush.getState();
      const s = w.__party.getState();
      // eslint-disable-next-line no-new-func
      return !!new Function('r', 's', `return (${src});`)(r, s);
    },
    pred,
    { timeout, polling: 200 },
  );
  return rushState(page);
}

// ------------------------------------------------------------------ host

export interface RushHostOpts {
  viewport?: { width: number; height: number };
  /** Use the real kart engine instead of the stub (needed for Kart/Smash switching specs). */
  real?: boolean;
  query?: string;
}

/** Open a fresh host page (new room); returns the room code. `__rush` exists from boot (module constructed eagerly). */
export async function openRushHost(page: Page, opts: RushHostOpts = {}): Promise<string> {
  await page.setViewportSize(opts.viewport ?? LAPTOP);
  const q = ['quality=0', opts.real ? '' : 'stub=1', opts.query ?? ''].filter(Boolean).join('&');
  await page.goto(`/?${q}`);
  await page.waitForFunction(() => /^[A-Z]{4}$/.test((window as unknown as RW).__party?.getState().room ?? '') && !!(window as unknown as RW).__rush, undefined, {
    timeout: 90_000,
    polling: 250,
  });
  // Fresh settings for every test (localStorage survives within a context only, but be explicit).
  await page.evaluate(() => {
    const r = (window as unknown as RW).__rush!;
    r.setSetting('auto', true);
    r.setSetting('autoSec', 10);
    r.setSetting('maxHeat', 3);
    r.setSetting('sip', false);
    r.setSetting('volume', 0);
  });
  return page.evaluate(() => (window as unknown as RW).__party!.getState().room);
}

/** Host-side pick (same rules as the leader's phone) and wait until the endless loop runs. */
export async function hostPickRush(page: Page): Promise<RushDbgState> {
  await page.evaluate(() => (window as unknown as RW).__party!.pickGame('rush'));
  return waitRush(page, `s.game === 'rush' && s.screen === 'race' && r.phase !== undefined`, 60_000);
}

// ------------------------------------------------------------------ bots

export interface RushBotOpts {
  /** Do the join tap right away (default true). */
  here?: boolean;
  /** Start the minigame brain (default true). */
  brain?: boolean;
  skill?: number;
  /** Seed base for the brains (deterministic per bot index). */
  seed?: number;
}

/** Connect `n` bot phones. With Rush active, they tap in and play (opts). */
export async function joinRushBots(room: string, n: number, opts: RushBotOpts = {}): Promise<BotPhone[]> {
  const bots: BotPhone[] = [];
  try {
    for (let i = 0; i < n; i++) {
      const b = await BotPhone.connect(BASE_URL, room, undefined, 10_000);
      bots.push(b);
      await b.waitFor((x) => !!x.state?.you, 20_000, 'first state');
    }
    await Promise.all(bots.map((b) => rushReady(b, opts, bots.indexOf(b))));
  } catch (err) {
    await closeBots(bots);
    throw err;
  }
  return bots;
}

/** Wait for the first RushPhoneMsg, then tap in + start the brain (per opts). */
export async function rushReady(b: BotPhone, opts: RushBotOpts = {}, idx = 0): Promise<void> {
  await b.waitFor((x) => !!x.rush, 20_000, 'first rush msg');
  if (opts.brain !== false && !b.rushBrainRunning) b.startRushBrain(opts.skill ?? 0.6, (opts.seed ?? 4242) + idx * 7919);
  if (opts.here !== false) {
    b.rushHere(true);
    await b.waitForRush((m) => m.me.st === 'play' || m.me.st === 'next', 20_000, 'tapped in');
  }
}

export async function closeBots(bots: BotPhone[]): Promise<void> {
  await Promise.all(bots.map((b) => b.close().catch(() => undefined)));
}

// ------------------------------------------------------------------ rounds

/**
 * Force minigame `id` now, skip the UP NEXT card (Space), and wait until the round is over
 * (results / oops / back on the scoreboard). Returns the state at the end.
 */
export async function playRound(page: Page, id: string, opts: { skipIntro?: boolean; extraMs?: number } = {}): Promise<RushDbgState> {
  const before = await rushState(page);
  expect(await rushForce(page, id), `forceGame(${id})`).toBe(true);
  const st = await waitRush(page, `r.rid > ${before.rid} && r.game === ${JSON.stringify(id)}`, 20_000);
  if (opts.skipIntro !== false && st.phase === 'intro') await rushCall(page, 'next');
  const cap = (RUSH_CAPS as Record<string, number>)[id] ?? 40;
  return waitRush(
    page,
    `(r.phase === 'results' && r.lastResults && r.lastResults.rid === ${st.rid}) || r.phase === 'oops' || (r.rid === ${st.rid} && r.phase === 'lobby')`,
    (cap + 8 + 10) * 1000 + (opts.extraMs ?? 0),
  );
}

/**
 * Contract scoring: N participants, 1st = N … last = 1, ties share the higher value (competition
 * ranking), +2 for every 1st. Rows must be ordered by place.
 */
export function expectContractPoints(rows: readonly RushRowDbg[], label = ''): void {
  const n = rows.length;
  expect(n, `${label} has rows`).toBeGreaterThan(0);
  expect(rows[0].place, `${label} first row is place 1`).toBe(1);
  const ids = new Set<string>();
  rows.forEach((r, i) => {
    expect(ids.has(r.id), `${label} no duplicate row ${r.id}`).toBe(false);
    ids.add(r.id);
    if (i > 0) {
      const prev = rows[i - 1];
      expect(r.place, `${label} places non-decreasing`).toBeGreaterThanOrEqual(prev.place);
      if (r.place !== prev.place) expect(r.place, `${label} competition rank at row ${i}`).toBe(i + 1);
    }
    const want = n - r.place + 1 + (r.place === 1 ? 2 : 0);
    expect(r.pts, `${label} ${r.name} (place ${r.place} of ${n}) points`).toBe(want);
    expect(Number.isFinite(r.pts)).toBe(true);
  });
}

// ------------------------------------------------------------------ real phone pages (portrait)

export const PHONES = [
  { tag: 'iphone', viewport: { width: 390, height: 844 }, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' },
  { tag: 'android', viewport: { width: 412, height: 915 }, ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36' },
] as const;

export type PhoneDev = (typeof PHONES)[number];

export async function newPhonePage(browser: Browser, dev: PhoneDev): Promise<Page> {
  const ctx = await browser.newContext({ viewport: dev.viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2, userAgent: dev.ua });
  return ctx.newPage();
}

export interface PhoneRushDbg {
  connected: boolean;
  playerId: string;
  screen: string | null;
  layout: string;
  game: string;
  rush: import('../src/net/protocol').RushPhoneMsg | null;
  rushTouch: boolean;
  rushTapped: boolean;
  rushSent: { stream: number; act: number; here: number; away: number; mode: number; next: number; events: Record<string, number> };
}

export function phoneRush(phone: Page): Promise<PhoneRushDbg> {
  return phone.evaluate(() => (window as unknown as { __phone: { getState(): PhoneRushDbg } }).__phone.getState());
}

/** Wait for a JS expression over `p` (`__phone.getState()`) on a real phone page. */
export async function waitPhone(phone: Page, pred: string, timeout = 30_000): Promise<PhoneRushDbg> {
  await phone.waitForFunction(
    (src) => {
      const w = window as unknown as { __phone?: { getState(): unknown } };
      if (!w.__phone) return false;
      // eslint-disable-next-line no-new-func
      return !!new Function('p', `return (${src});`)(w.__phone.getState());
    },
    pred,
    { timeout, polling: 150 },
  );
  return phoneRush(phone);
}

/** Total of all points on the board (humans only). */
export function boardTotal(st: RushDbgState): number {
  return st.players.filter((p) => !p.bot).reduce((a, p) => a + p.pts, 0);
}

export { sleep };
