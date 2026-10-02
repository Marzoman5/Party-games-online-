/**
 * Shared helpers for the Smash Party / Party Hub end-to-end specs (tests/smash-*.spec.ts).
 *
 * Conventions (same as tests/helpers.ts): host at `/?quality=0`, phones are BotPhones (or real
 * `/play` pages), predicates over the page-side hooks instead of fixed sleeps, matches are
 * accelerated with `window.__smash` hooks (setDamage / ko / endMatch / timeScale) because headless
 * SwiftShader renders at ~1–10 fps.
 */
import { expect, type Page } from '@playwright/test';
import { BotPhone, type SmashObservation } from '../scripts/bots';
import type { GameId, LobbyPlayer, ResultRow, ScreenId, SmashSetup } from '../src/net/protocol';
import type { SmashDebugHooks } from '../src/games/smash/api';
import { getStage } from '../src/games/smash/stages';
import { BASE_URL, BOT_CHARS, BOT_NAMES, LAPTOP, type GameDbgState, type PartyDbgState, allOnScreen, leaderOf, sleep } from './helpers';

export type SmashDbgState = ReturnType<SmashDebugHooks['getState']>;
export type SmashFighterDbg = SmashDbgState['fighters'][number];

/** `__party.getState()` with the PARTY HUB additions. */
export interface HubDbgState extends Omit<PartyDbgState, 'players' | 'results'> {
  game?: GameId;
  games?: { id: GameId; title: string }[];
  gameSetup?: Record<string, unknown>;
  sandbox?: { done: string[] } | null;
  resultsInfo?: { game: GameId; winner: string; winnerTeam?: number; mode?: string } | null;
  players: LobbyPlayer[];
  results: { rows: ResultRow[]; gpFinal: boolean } | null;
}

type HW = Window & {
  __party?: { getState(): HubDbgState; setTvMode(on: boolean): void };
  __smash?: SmashDebugHooks;
  __game?: { getState(): GameDbgState; finishAll(): void };
};

/** Lean, fast default for test matches (flat stage, no items/hazards, 2 stocks). */
export const LEAN_SETUP: SmashSetup = {
  stageId: 'arena',
  mode: 'stock',
  stocks: 2,
  timeSec: 60,
  teams: false,
  friendlyFire: false,
  fillCpus: 0,
  cpuLevel: 3,
  items: false,
  itemFrequency: 'low',
  hazards: false,
};

// ------------------------------------------------------------------ page-side state

export function hubState(page: Page): Promise<HubDbgState> {
  return page.evaluate(() => (window as unknown as HW).__party!.getState());
}
export function smashState(page: Page): Promise<SmashDbgState | null> {
  return page.evaluate(() => (window as unknown as HW).__smash?.getState() ?? null);
}

/** Call a `window.__smash` hook: `smash(page, 'ko', 1)`. */
export function smash<K extends keyof SmashDebugHooks>(page: Page, fn: K, ...args: Parameters<SmashDebugHooks[K]>): Promise<ReturnType<SmashDebugHooks[K]>> {
  return page.evaluate(
    ([f, a]) => {
      const h = (window as unknown as HW).__smash as unknown as Record<string, (...x: unknown[]) => unknown>;
      return h[f as string](...(a as unknown[]));
    },
    [fn, args] as const,
  ) as Promise<ReturnType<SmashDebugHooks[K]>>;
}

/**
 * Wait for a JS expression over `s` (party state), `m` (`__smash.getState()` or null) and
 * `g` (kart `__game.getState()` or null) to become truthy.
 */
export async function waitHub(page: Page, pred: string, timeout = 60_000): Promise<void> {
  await page.waitForFunction(
    (src) => {
      const w = window as unknown as HW;
      const s = w.__party?.getState();
      if (!s) return false;
      const m = w.__smash ? w.__smash.getState() : null;
      const g = w.__game ? w.__game.getState() : null;
      // eslint-disable-next-line no-new-func
      return !!new Function('s', 'm', 'g', `return (${src});`)(s, m, g);
    },
    pred,
    { timeout, polling: 250 },
  );
}

export async function waitSmashPhase(page: Page, phases: string[], timeout = 120_000): Promise<string> {
  await waitHub(page, `!!m && ${JSON.stringify(phases)}.includes(m.phase)`, timeout);
  return (await smashState(page))!.phase;
}

// ------------------------------------------------------------------ host + bots

/** Open a fresh host page (new room). Only needs `__party` (games may load lazily). */
export async function openHub(page: Page, viewport: { width: number; height: number } = LAPTOP, query?: string): Promise<string> {
  await page.setViewportSize(viewport);
  await page.goto(`/?${['quality=0', query].filter(Boolean).join('&')}`);
  await page.waitForFunction(() => /^[A-Z]{4}$/.test((window as unknown as HW).__party?.getState().room ?? ''), undefined, { timeout: 90_000, polling: 250 });
  return (await hubState(page)).room;
}

export interface SmashBots {
  bots: BotPhone[];
  closeAll(): Promise<void>;
}

/** Connect N bots with distinct names + characters (same roster for both games), ready them. */
export async function joinBots(room: string, n: number, chars: readonly string[] = BOT_CHARS): Promise<SmashBots> {
  const bots: BotPhone[] = [];
  const set: SmashBots = {
    bots,
    async closeAll() {
      await Promise.all(bots.map((b) => b.close().catch(() => undefined)));
    },
  };
  try {
    for (let i = 0; i < n; i++) {
      const b = await BotPhone.connect(BASE_URL, room, undefined, 10_000);
      bots.push(b);
      await b.waitFor((x) => !!x.state?.you, 20_000, 'first state');
      b.profile(BOT_NAMES[i], chars[i]);
      await b.waitFor((x) => x.state?.you?.characterId === chars[i], 20_000, `character ${chars[i]}`);
      b.ready(true);
      await b.waitFor((x) => x.state?.you?.ready === true, 20_000, 'ready');
    }
  } catch (err) {
    await set.closeAll();
    throw err;
  }
  return set;
}

/** Leader picks Smash Party in the lobby; host + every phone agree. Re-readies bots if the pick reset ready flags. */
export async function pickSmash(page: Page, bots: BotPhone[]): Promise<void> {
  const leader = leaderOf(bots);
  leader.game('smash');
  // (the Smash engine is loaded lazily on first pick: slow on a busy CI box)
  await waitHub(page, `s.game === 'smash'`, 120_000);
  await Promise.all(bots.map((b) => b.waitFor((x) => x.state?.game === 'smash', 20_000, 'state.game smash')));
  for (const b of bots) if (!b.state?.you?.ready) b.ready(true);
  await Promise.all(bots.map((b) => b.waitFor((x) => x.state?.you?.ready === true, 20_000, 'ready after game pick')));
}

/**
 * From the lobby/results with Smash picked: leader START -> tutorial (skipped) -> sandbox (everyone
 * taps "I'm ready", leader START) -> setup. Handles each step only if it shows up.
 * `pressStart = false` when the flow is already moving (e.g. after `post switch`).
 */
export async function smashToSetup(page: Page, bots: BotPhone[], timeout = 120_000, pressStart = true): Promise<void> {
  const leader = leaderOf(bots);
  if (pressStart && leader.state?.screen !== 'setup') leader.start();
  const deadline = Date.now() + timeout;
  const acted = new Set<string>();
  let lastStart = Date.now();
  while (Date.now() < deadline) {
    const sc = leader.state?.screen;
    if (pressStart && sc === 'lobby' && Date.now() - lastStart > 5000) {
      // START may be dropped while the host is busy (e.g. a game still loading): tap again.
      lastStart = Date.now();
      leader.start();
    }
    if (sc === 'setup' && bots.every((b) => !b.connected || b.state?.screen === 'setup')) break;
    if (sc === 'tutorial' && !acted.has('skip')) {
      acted.add('skip');
      leader.tutSkip();
    } else if (sc === 'sandbox') {
      // Everyone taps "I'm ready" (the hub may auto-advance). If the host is still in the sandbox
      // after a while, end it HOST-side (atomic, a no-op elsewhere) instead of a phone START, which
      // would start a match if it arrived after the auto-advance to setup.
      const done = leader.state?.sandbox?.done ?? [];
      for (const b of bots) if (!done.includes(b.playerId)) b.practiceDone();
      await leader.waitFor((b) => b.state?.screen !== 'sandbox', 6000, 'leave sandbox').catch(() => undefined);
      if (leader.state?.screen === 'sandbox') await endSandbox(page);
      await leader.waitFor((b) => b.state?.screen !== 'sandbox', 6000, 'leave sandbox').catch(() => undefined);
    }
    await sleep(250);
  }
  await allOnScreen(bots, 'setup', 30_000);
  await waitHub(page, `s.screen === 'setup' && s.game === 'smash'`, 30_000);
}

/** Leader applies `setup` (merged over LEAN_SETUP) and STARTs; waits until the fight runs. */
export async function startSmashMatch(page: Page, bots: BotPhone[], setup: Partial<SmashSetup> = {}, waitFighting = true): Promise<SmashSetup> {
  const leader = leaderOf(bots);
  const full: SmashSetup = { ...LEAN_SETUP, ...setup };
  leader.gsetup(full);
  const checks = Object.entries(full)
    .map(([k, v]) => `s.gameSetup[${JSON.stringify(k)}] === ${JSON.stringify(v)}`)
    .join(' && ');
  await waitHub(page, `!!s.gameSetup && ${checks}`, 20_000);
  leader.start();
  await allOnScreen(bots, 'race', 120_000);
  await waitSmashPhase(page, ['loading', 'intro', 'countdown', 'fighting'], 120_000);
  if (waitFighting) await waitSmashPhase(page, ['fighting'], 180_000);
  return full;
}

/** Full fast path: host, N bots, Smash picked, tutorial skipped, sandbox done, match fighting. */
export async function hubWithSmashMatch(page: Page, n: number, setup: Partial<SmashSetup> = {}): Promise<{ room: string; set: SmashBots }> {
  const room = await openHub(page);
  const set = await joinBots(room, n);
  try {
    await pickSmash(page, set.bots);
    await smashToSetup(page, set.bots);
    await startSmashMatch(page, set.bots, setup);
  } catch (err) {
    await set.closeAll();
    throw err;
  }
  return { room, set };
}

/** Host-side: leave the sandbox (only if the hub is still in it). */
export async function endSandbox(page: Page): Promise<void> {
  await page.evaluate(() => {
    const p = (window as unknown as { __party?: { getState(): { screen: string }; skipSandbox?: () => void } }).__party;
    if (p && p.getState().screen === 'sandbox') p.skipSandbox?.();
  });
}

/** Leader taps START (again every 5 s, like an impatient human) until it leaves `from`. */
export async function startUntilLeaves(bot: BotPhone, from: ScreenId, timeout = 60_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (bot.state?.screen === from && Date.now() < deadline) {
    bot.start();
    await bot.waitFor((b) => b.state?.screen !== from, 5000, `leave ${from}`).catch(() => undefined);
  }
  expect(bot.state?.screen, `left ${from}`).not.toBe(from);
}

/** The fighter (from `__smash.getState()`) that belongs to this bot (by lobby slot). */
export function fighterOf(m: SmashDbgState, bot: BotPhone): SmashFighterDbg | undefined {
  const slot = bot.state?.you?.slot;
  return m.fighters.find((f) => f.human && f.slot === slot);
}

// ------------------------------------------------------------------ bot brains fed with positions

/** Convert `__smash.getState()` into the bot brain's observation (stage edges from the stage catalogue). */
export function toObservation(m: SmashDbgState, teams = false): SmashObservation {
  const st = getStage(m.stageId ?? 'arena');
  const main = st.platforms.find((p) => p.solid) ?? st.platforms[0];
  return {
    teams,
    stage: { left: main.x - main.w / 2, right: main.x + main.w / 2, y: main.y },
    fighters: m.fighters.map((f) => ({
      index: f.index,
      slot: f.slot,
      team: f.team,
      human: f.human,
      dummy: f.dummy,
      x: f.x,
      y: f.y,
      vx: f.vx,
      vy: f.vy,
      grounded: f.grounded,
      action: f.action,
      damage: f.damage,
      out: f.out,
      respawning: f.respawning,
      facing: f.facing,
    })),
  };
}

export interface Observer {
  stop(): void;
  /** Observations delivered so far. */
  readonly count: number;
}

/** Start the bots' Smash brains and feed them positions from the host at ~`hz` Hz. */
export function observeAndFight(page: Page, bots: BotPhone[], hz = 6, teams = false): Observer {
  bots.forEach((b, i) => b.startSmashBrain(0.17 + i * 0.23));
  let stopped = false;
  let count = 0;
  let busy = false;
  const timer = setInterval(() => {
    if (stopped || busy || page.isClosed()) return;
    busy = true;
    smashState(page)
      .then((m) => {
        if (!m || stopped) return;
        const obs = toObservation(m, teams);
        for (const b of bots) if (b.connected) b.observe(obs);
        count++;
      })
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  }, 1000 / hz);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      for (const b of bots) b.stopSmashBrain();
    },
    get count() {
      return count;
    },
  };
}

// ------------------------------------------------------------------ finishing matches

/**
 * Finish a running match quickly: KO everyone but `keep` (fighter index) stock by stock with
 * `__smash.ko` until "GAME!", falling back to `endMatch()`. Returns when the phase is gameSet/results.
 */
export async function koUntilGameSet(page: Page, keep = 0, timeout = 120_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const m = await smashState(page);
    if (!m) break;
    if (m.phase === 'gameSet' || m.phase === 'results') return;
    if (m.phase === 'fighting') {
      for (const f of m.fighters) {
        if (f.index !== keep && !f.out && !f.respawning && f.action !== 'ko' && !f.dummy) await smash(page, 'ko', f.index);
      }
    }
    await sleep(1500);
  }
  await smash(page, 'endMatch');
  await waitSmashPhase(page, ['gameSet', 'results'], 60_000);
}

/** Wait for the hub results screen of a Smash match, on the host and every connected bot. */
export async function waitSmashResults(page: Page, bots: BotPhone[], timeout = 90_000): Promise<HubDbgState> {
  await waitHub(page, `s.screen === 'results' && !!s.results && s.results.rows.length > 0 && (!s.resultsInfo || s.resultsInfo.game === 'smash')`, timeout);
  await allOnScreen(bots, 'results', 30_000);
  return hubState(page);
}

/** Every element is visible and its box is inside the viewport. */
export async function expectInViewport(page: Page, testIds: string[], vp: { width: number; height: number }): Promise<void> {
  for (const id of testIds) {
    const l = page.getByTestId(id).first();
    await expect(l, id).toBeVisible();
    const b = await l.boundingBox();
    expect(b, `${id} box`).not.toBeNull();
    expect(b!.width, `${id} width`).toBeGreaterThan(10);
    expect(b!.height, `${id} height`).toBeGreaterThan(10);
    expect(b!.x, `${id} left`).toBeGreaterThanOrEqual(-1);
    expect(b!.y, `${id} top`).toBeGreaterThanOrEqual(-1);
    expect(b!.x + b!.width, `${id} right`).toBeLessThanOrEqual(vp.width + 1);
    expect(b!.y + b!.height, `${id} bottom`).toBeLessThanOrEqual(vp.height + 1);
  }
}

export type { ScreenId };
