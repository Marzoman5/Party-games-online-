/**
 * Shared helpers for the Kart Party end-to-end suite.
 *
 * - Host pages run the real production build (`/`) with `?quality=0` (potato tier: headless
 *   SwiftShader renders at ~1–10 fps, so races are finished through `window.__game` hooks).
 * - Phones are BotPhone WebSocket clients (scripts/bots.ts) speaking the real protocol, or real
 *   `/play` pages in mobile contexts (phone-ui.spec.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, type TestInfo } from '@playwright/test';
import { BotPhone } from '../scripts/bots';
import type { ScreenId } from '../src/net/protocol';

export const PORT = Number(process.env.KP_TEST_PORT ?? 3199);
export const BASE_URL = `http://127.0.0.1:${PORT}`;
export const SHOTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'screenshots');

export const LAPTOP = { width: 1366, height: 768 } as const;
export const TV = { width: 3840, height: 2160 } as const;

/** Distinct racers for up to 4 bots. */
export const BOT_CHARS = ['zippy', 'pixel', 'fennec', 'max'] as const;
export const BOT_NAMES = ['Ana', 'Ben', 'Cleo', 'Dev'] as const;

// ------------------------------------------------------------------ types (page-side hooks)

export interface KartDbg {
  id: number;
  human: boolean;
  aiControlled: boolean;
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
  lap: number;
  place: number;
  item: string;
  driftStage: number;
  isDrifting: boolean;
  isSpinning: boolean;
  isBoosting: boolean;
  finished: boolean;
  itemsUsed: number;
  lastSteer: number;
}

export interface GameDbgState {
  phase: string;
  viewports: number;
  qualityTier: number;
  fps: number;
  raceTime: number;
  memory: { geometries: number; textures: number; programs: number };
  racesStarted: number;
  karts: KartDbg[];
}

export interface PartyDbgState {
  screen: ScreenId;
  room: string;
  joinUrl: string;
  tvMode: boolean;
  engine: string;
  players: { playerId: string; slot: number; name: string; characterId: string; ready: boolean; connected: boolean; isLeader: boolean; tutorialDone: boolean }[];
  tutorial: { step: number; total: number; acks: string[]; phase: 'steps' | 'ack' } | null;
  setup: { mode: string; trackId: string; cc: number; laps: number };
  pause: { by: string; votes: number; needed: number } | null;
  gp: { race: number; of: number } | null;
  racesCompleted: number;
  results: { rows: unknown[]; gpFinal: boolean } | null;
  karts: string[];
  soloActive: boolean;
  net: string;
}

type W = Window & {
  __game?: {
    getState(): GameDbgState;
    finishAll(): void;
    finishPlayer(slot?: number): void;
    giveItem(slot: number, item: string): void;
    autopilot(on: boolean, slot?: number): void;
    setQuality(t: number | null): void;
    startRace(cfg?: unknown): void;
  };
  __party?: { getState(): PartyDbgState; skipTutorial(): void; howTo(): void; setTvMode(on: boolean): void };
};

export function gameState(page: Page): Promise<GameDbgState> {
  return page.evaluate(() => (window as unknown as W).__game!.getState());
}
export function partyState(page: Page): Promise<PartyDbgState> {
  return page.evaluate(() => (window as unknown as W).__party!.getState());
}
export function finishAll(page: Page): Promise<void> {
  return page.evaluate(() => (window as unknown as W).__game!.finishAll());
}
export function giveItem(page: Page, slot: number, item: string): Promise<void> {
  return page.evaluate(([s, i]) => (window as unknown as W).__game!.giveItem(s as number, i as string), [slot, item] as const);
}
export function setTvMode(page: Page, on: boolean): Promise<void> {
  return page.evaluate((v) => (window as unknown as W).__party!.setTvMode(v), on);
}

// ------------------------------------------------------------------ error collection

/**
 * Console noise we accept, with the reason:
 * - Chromium/SwiftShader GPU warnings ("GPU stall due to ReadPixels", "WebGL: ...") are
 *   driver-performance chatter of the software rasteriser used in CI, not app errors.
 * - AudioContext autoplay complaints: headless has no user gesture / audio device.
 * - favicon 404: browsers probe /favicon.ico on their own.
 * - "[party] server error" with code no_room etc. never expected; NOT allowlisted.
 * - Failed resource loads for the QR image while the room is not yet known (empty src) — the
 *   app deliberately ignores these (see main.ts), Chrome still logs them.
 */
const BENIGN: RegExp[] = [
  /GPU stall due to ReadPixels/i,
  /^WebGL: /i,
  /GL_INVALID|GL ERROR|\[\.WebGL-/i,
  /AudioContext|autoplay/i,
  /favicon\.ico/i,
];

export interface ErrorLog {
  errors: string[];
  /** Assert no unexpected page errors / console errors were captured. */
  expectNone(): void;
}

export function collectErrors(page: Page, label = 'page'): ErrorLog {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`[${label} pageerror] ${err.message}\n${err.stack ?? ''}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (BENIGN.some((r) => r.test(text))) return;
    const loc = msg.location();
    errors.push(`[${label} console.error] ${text} (${loc.url}:${loc.lineNumber})`);
  });
  return {
    errors,
    expectNone() {
      expect(errors, `unexpected errors on ${label}:\n${errors.join('\n')}`).toEqual([]);
    },
  };
}

// ------------------------------------------------------------------ screenshots

/** Save a screenshot to docs/screenshots/<name>. `.jpg` names are saved as JPEG q70. */
export async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const file = path.join(SHOTS_DIR, name);
  const jpeg = /\.jpe?g$/i.test(name);
  await page.screenshot({ path: file, type: jpeg ? 'jpeg' : 'png', ...(jpeg ? { quality: 70 } : {}), timeout: 60_000, animations: 'allow' });
}

/**
 * Screenshot the host at laptop size, then at 4K TV size (TV mode on), then restore laptop.
 * `prefix` like '04-host-race' -> 04-host-race-laptop.jpg + 04-host-race-tv.jpg.
 */
export async function hostShots(page: Page, prefix: string, restore = true): Promise<void> {
  await page.setViewportSize(LAPTOP);
  await setTvMode(page, false);
  await settle(page);
  await shot(page, `${prefix}-laptop.jpg`);
  await page.setViewportSize(TV);
  await setTvMode(page, true);
  await settle(page, 2);
  await shot(page, `${prefix}-tv.jpg`);
  if (restore) {
    await page.setViewportSize(LAPTOP);
    await setTvMode(page, false);
    await settle(page);
  }
}

/** Wait for a couple of animation frames (the page may run at ~1–5 fps under SwiftShader). */
export async function settle(page: Page, frames = 2): Promise<void> {
  await page.evaluate(
    (n) =>
      new Promise<void>((resolve) => {
        let i = 0;
        const tick = (): void => {
          if (++i >= n) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        setTimeout(resolve, 8000); // never hang on a throttled page
      }),
    frames,
  );
}

// ------------------------------------------------------------------ host

export interface HostOpts {
  viewport?: { width: number; height: number };
  /** Extra query string, e.g. 'tv=1'. */
  query?: string;
}

/** Open a fresh host page (new room) and wait until the room code is known. Returns the room code. */
export async function openHost(page: Page, opts: HostOpts = {}): Promise<string> {
  await page.setViewportSize(opts.viewport ?? LAPTOP);
  const q = ['quality=0', opts.query].filter(Boolean).join('&');
  await page.goto(`/?${q}`);
  await page.waitForFunction(
    () => {
      const w = window as unknown as W;
      return !!w.__game && !!w.__party && /^[A-Z]{4}$/.test(w.__party.getState().room);
    },
    undefined,
    { timeout: 90_000, polling: 250 },
  );
  return (await partyState(page)).room;
}

export async function waitParty(page: Page, pred: string, timeout = 60_000): Promise<void> {
  // pred is a JS expression over `s` (party state) and `g` (game state).
  await page.waitForFunction(
    (src) => {
      const w = window as unknown as W;
      const s = w.__party!.getState();
      const g = w.__game!.getState();
      // eslint-disable-next-line no-new-func
      return !!new Function('s', 'g', `return (${src});`)(s, g);
    },
    pred,
    { timeout, polling: 200 },
  );
}

export async function waitEnginePhase(page: Page, phases: string[], timeout = 90_000): Promise<string> {
  await page.waitForFunction((ps) => ps.includes((window as unknown as W).__game!.getState().phase), phases, { timeout, polling: 200 });
  return (await gameState(page)).phase;
}

// ------------------------------------------------------------------ bots

export interface BotSet {
  bots: BotPhone[];
  closeAll(): Promise<void>;
}

/** Connect N bots to `room`, give each a distinct name + racer, optionally ready them up. */
export async function connectBots(room: string, n: number, ready = true): Promise<BotSet> {
  const bots: BotPhone[] = [];
  for (let i = 0; i < n; i++) {
    const b = await BotPhone.connect(BASE_URL, room, undefined, 10_000);
    bots.push(b);
    // Host sends the first PhoneState once it has processed the join.
    await b.waitFor((x) => !!x.state?.you, 20_000, 'first state');
    b.profile(BOT_NAMES[i], BOT_CHARS[i]);
    await b.waitFor((x) => x.state?.you?.characterId === BOT_CHARS[i], 20_000, `racer ${BOT_CHARS[i]}`);
    if (ready) {
      b.ready(true);
      await b.waitFor((x) => x.state?.you?.ready === true, 20_000, 'ready');
    }
  }
  return {
    bots,
    async closeAll() {
      await Promise.all(bots.map((b) => b.close().catch(() => undefined)));
    },
  };
}

export function leaderOf(bots: BotPhone[]): BotPhone {
  const l = bots.find((b) => b.state?.you?.isLeader);
  if (!l) throw new Error('no leader among bots');
  return l;
}

export async function allOnScreen(bots: BotPhone[], screen: ScreenId, timeout = 30_000): Promise<void> {
  await Promise.all(bots.filter((b) => b.connected).map((b) => b.waitForScreen(screen, timeout)));
}

/**
 * From the lobby (all bots ready): leader START -> tutorial (skipped by the leader) -> setup.
 * If the tutorial was already seen this session, START goes straight to setup.
 */
export async function lobbyToSetup(page: Page, bots: BotPhone[]): Promise<void> {
  const leader = leaderOf(bots);
  leader.start();
  await leader.waitFor((b) => b.state?.screen === 'tutorial' || b.state?.screen === 'setup', 30_000, 'tutorial or setup');
  if (leader.state?.screen === 'tutorial') leader.tutSkip();
  await allOnScreen(bots, 'setup');
  await waitParty(page, `s.screen === 'setup'`);
}

/** From setup: leader picks a 1-lap single race and starts it; waits for the race screen + an engine race phase. */
export async function setupToRace(page: Page, bots: BotPhone[], trackId?: string): Promise<void> {
  const leader = leaderOf(bots);
  leader.setup({ mode: 'single', laps: 1, cc: 150, ...(trackId ? { trackId } : {}) });
  await waitParty(page, `s.setup.laps === 1`);
  leader.start();
  await allOnScreen(bots, 'race', 90_000);
  await waitEnginePhase(page, ['intro', 'countdown', 'racing']);
}

/** Wait until the engine is actually racing (after intro flyover 4.5 s + countdown 3 s of game time). */
export async function waitRacing(page: Page, timeout = 150_000): Promise<void> {
  await waitEnginePhase(page, ['racing'], timeout);
}

/** Full fast path: open host, connect N bots, skip the tutorial, start a 1-lap race. */
export async function hostWithRace(page: Page, n: number): Promise<{ room: string; set: BotSet }> {
  const room = await openHost(page);
  const set = await connectBots(room, n);
  await lobbyToSetup(page, set.bots);
  await setupToRace(page, set.bots);
  return { room, set };
}

export function attachJson(testInfo: TestInfo, name: string, data: unknown): Promise<void> {
  return testInfo.attach(name, { body: JSON.stringify(data, null, 2), contentType: 'application/json' });
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
