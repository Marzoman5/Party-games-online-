/**
 * 33. Party Rush host controls and robustness:
 *     - host keys (Space / P / S / R / Esc menu) mashed at random moments for ~3 minutes with 4 playing
 *       bot phones: never stuck (no phase outlives its hard cap while unpaused), no errors, the loop
 *       always moves on, and the board stays consistent;
 *     - a minigame that throws → "Oops — skipping that one!" (`rush-oops`), no points, the loop goes on
 *       (failure injected through `window.__partyApp` → the Rush shell's running round);
 *     - plain HTTP: the "Motion controls need secure mode" notice on the hub card and the scoreboard.
 */
import { expect, test, type Page } from '@playwright/test';
import { BotPhone } from '../scripts/bots';
import { BASE_URL, collectErrors, sleep } from './helpers';
import {
  boardTotal,
  closeBots,
  expectContractPoints,
  hostPickRush,
  joinRushBots,
  openRushHost,
  playRound,
  rushCall,
  rushForce,
  rushPause,
  rushSetting,
  rushState,
  waitRush,
  type RushDbgState,
} from './rushHelpers';

/** Max seconds a phase may last on the loop clock (contract hard caps) + a margin. */
function phaseCap(st: RushDbgState): number {
  const margin = 6;
  switch (st.phase) {
    case 'lobby':
      return st.settings.auto ? st.settings.autoSec + margin : Infinity;
    case 'intro':
      return 5 + 2 + margin;
    case 'count':
      return 3 * 0.8 + margin;
    case 'play':
      return 40 + 3 + margin;
    case 'results':
      return 6 + margin;
    case 'oops':
      return 2.6 + margin;
  }
  return 60;
}

test('host keys at random moments (Space/P/S/R/Esc): never stuck, never errors, always advances', async ({ page }) => {
  test.setTimeout(10 * 60_000);
  const errs = collectErrors(page, 'host');
  const room = await openRushHost(page);
  await hostPickRush(page);
  await rushSetting(page, 'autoSec', 3);
  const bots = await joinRushBots(room, 4);
  let rand = 12345;
  const rnd = (): number => ((rand = (rand * 16807) % 2147483647) - 1) / 2147483646;
  try {
    // Watcher: per phase, wall time spent unpaused (and outside the menu).
    let cur = '';
    let acc = 0;
    let last = Date.now();
    let worst = { phase: '', secs: 0 };
    const seen = new Set<string>();
    const keys: Record<string, number> = {};
    let rounds0 = (await rushState(page)).roundsPlayed;
    const check = async (): Promise<RushDbgState> => {
      const st = await rushState(page);
      const now = Date.now();
      const key = `${st.phase}:${st.rid}`;
      if (key !== cur) {
        cur = key;
        acc = 0;
      } else if (!st.paused && !st.menu) acc += (now - last) / 1000;
      last = now;
      seen.add(st.phase);
      if (acc > worst.secs) worst = { phase: st.phase, secs: acc };
      expect(acc, `phase ${st.phase} stuck for ${acc.toFixed(1)} s`).toBeLessThan(phaseCap(st));
      expect(st.errors, 'shell errors').toEqual([]);
      return st;
    };
    const until = Date.now() + 3 * 60_000;
    let menuOpen = false;
    while (Date.now() < until) {
      await check();
      const r = rnd();
      let k: string;
      if (menuOpen) {
        k = 'Escape';
        menuOpen = false;
      } else if (r < 0.4) k = ' ';
      else if (r < 0.55) k = 'p';
      else if (r < 0.72) k = 's';
      else if (r < 0.85) k = 'r';
      else {
        k = 'Escape';
        menuOpen = true;
      }
      keys[k] = (keys[k] ?? 0) + 1;
      await page.keyboard.press(k);
      // Random pause between presses; poll the watcher meanwhile.
      const wait = 400 + rnd() * 3600;
      const t = Date.now() + wait;
      while (Date.now() < t) {
        await sleep(250);
        await check();
      }
    }
    // Calm down: close the menu, unpause, and the loop must keep going on its own (auto-advance).
    let st = await rushState(page);
    if (st.menu) await page.keyboard.press('Escape');
    await waitRush(page, `!r.menu`, 5_000);
    st = await rushState(page);
    if (st.paused) await rushPause(page, false);
    rounds0 = st.roundsPlayed;
    st = await waitRush(page, `r.roundsPlayed > ${rounds0} && r.phase === 'lobby'`, 120_000);
    expect(st.errors).toEqual([]);
    expect(st.paused).toBe(false);
    const res = st.lastResults!;
    expectContractPoints(res.rows, 'after key chaos');
    expect(new Set(st.players.map((p) => p.id)).size).toBe(st.players.length);
    expect(st.players.every((p) => Number.isFinite(p.pts) && p.pts >= 0)).toBe(true);
    console.log(`[rush keys] presses=${JSON.stringify(keys)} phases=${[...seen].join(',')} worst=${worst.phase} ${worst.secs.toFixed(1)}s rounds=${st.roundsPlayed}`);
    expect([...seen]).toEqual(expect.arrayContaining(['lobby', 'intro', 'count', 'play']));
    errs.expectNone();
  } finally {
    await closeBots(bots);
  }
});

type ShellPeek = {
  phase: string;
  round: { def: { meta: { id: string }; create: () => unknown }; mg: Record<string, unknown> | null } | null;
};

/** The Rush shell inside the host page (reached through window.__partyApp → modules). */
function withShell<T>(page: Page, fn: string): Promise<T> {
  return page.evaluate((src) => {
    const app = (window as unknown as { __partyApp: { modules: { id: string; shell?: ShellPeek }[] } }).__partyApp;
    const shell = app.modules.find((m) => m.id === 'rush')!.shell!;
    // eslint-disable-next-line no-new-func
    return new Function('shell', src)(shell) as T;
  }, fn);
}

test('a minigame that throws → "Oops — skipping that one!", no points, the loop goes on', async ({ page }) => {
  test.setTimeout(5 * 60_000);
  const errs = collectErrors(page, 'host');
  const room = await openRushHost(page);
  await hostPickRush(page);
  await rushSetting(page, 'auto', false);
  const bots = await joinRushBots(room, 3);
  try {
    // ---- 1: update() throws during play
    expect(await rushForce(page, 'darts')).toBe(true);
    let st = await waitRush(page, `r.game === 'darts' && r.phase === 'intro'`, 15_000);
    await rushCall(page, 'next');
    await waitRush(page, `r.phase === 'play' && r.rid === ${st.rid}`, 15_000);
    const total0 = boardTotal(await rushState(page));
    const ok = await withShell<boolean>(page, `const mg = shell.round && shell.round.mg; if (!mg) return false; mg.update = () => { throw new Error('TEST: injected update failure'); }; return true;`);
    expect(ok).toBe(true);
    st = await waitRush(page, `r.phase === 'oops'`, 5_000);
    await expect(page.getByTestId('rush-oops')).toBeVisible();
    await expect(page.getByTestId('rush-oops')).toContainText('Oops');
    expect(st.errors.length).toBe(1);
    expect(st.errors[0].msg).toContain('injected update failure');
    expect(st.errors[0].game).toBe('darts');
    expect(boardTotal(st), 'no points for a broken round').toBe(total0);
    // Phones never show a broken round: they go back to the scoreboard view.
    await Promise.all(bots.map((b) => b.waitForRush((m) => m.ph === 'lobby' && m.s === null, 10_000, 'phone back in lobby')));
    st = await waitRush(page, `r.phase === 'lobby'`, 10_000);
    await expect(page.getByTestId('rush-scoreboard')).toBeVisible();

    // ---- 2: create() throws (the round never starts); the registry entry is restored afterwards
    expect(await rushForce(page, 'balance')).toBe(true);
    st = await waitRush(page, `r.game === 'balance' && r.phase === 'intro'`, 15_000);
    await withShell(page, `const d = shell.round.def; d.__orig = d.create; d.create = () => { throw new Error('TEST: injected create failure'); };`);
    await rushCall(page, 'next');
    st = await waitRush(page, `r.phase === 'oops'`, 5_000);
    expect(st.errors.map((e) => e.msg).join('|')).toContain('injected create failure');
    await waitRush(page, `r.phase === 'lobby'`, 10_000);
    // Restore the shared MinigameDef: force balance again, put the original create back before COUNT.
    expect(await rushForce(page, 'balance')).toBe(true);
    await waitRush(page, `r.game === 'balance' && r.phase === 'intro'`, 15_000);
    await withShell(page, `const d = shell.round.def; if (d.__orig) { d.create = d.__orig; delete d.__orig; }`);
    await rushCall(page, 'skip');
    await waitRush(page, `r.phase === 'lobby'`, 10_000);

    // ---- 3: the loop is healthy: a normal round scores again
    st = await playRound(page, 'shake-race');
    expect(st.phase).toBe('results');
    expect(st.errors.length, 'no new errors').toBe(2);
    expectContractPoints(st.lastResults!.rows, 'after oops');
    expect(st.lastResults!.rows.length).toBe(3);
    // The two injected failures are logged with console.error by the shell: expected here, nothing else.
    const unexpected = errs.errors.filter((e) => !/injected (update|create) failure/.test(e));
    expect(unexpected, unexpected.join('\n')).toEqual([]);
  } finally {
    await closeBots(bots);
  }
});

test('plain HTTP: "motion controls need secure mode" on the hub card and on the Rush scoreboard', async ({ page }) => {
  test.setTimeout(3 * 60_000);
  const errs = collectErrors(page, 'host');
  const room = await openRushHost(page);
  const bots = [await BotPhone.connect(BASE_URL, room, undefined, 10_000)];
  try {
    await bots[0].waitFor((b) => !!b.state?.you, 20_000, 'first state');
    const hub = await page.evaluate(() => (window as unknown as { __party: { getState(): { screen: string; game: string } } }).__party.getState());
    expect(hub.screen).toBe('lobby');
    await expect(page.getByTestId('game-card-rush')).toBeVisible();
    await expect(page.getByTestId('rush-secure-note')).toBeVisible();
    await expect(page.getByTestId('rush-secure-note')).toContainText(/secure mode/i);
    await hostPickRush(page);
    await expect(page.getByTestId('rush-scoreboard')).toBeVisible();
    await expect(page.getByTestId('rush-https-notice')).toBeVisible();
    await expect(page.getByTestId('rush-https-notice')).toContainText(/Start Party Hub \(Tilt Steering\)/);
    await expect(page.getByTestId('rush-cert-help')).toHaveCount(0); // walkthrough only in HTTPS mode
    await expect(page.getByTestId('rush-qr')).toBeVisible();
    await expect(page.getByTestId('rush-room-code')).toContainText(room);
    // Phones learn the host is not secure.
    await bots[0].waitFor((b) => b.state?.secure === false, 10_000, 'secure=false on phone');
    errs.expectNone();
  } finally {
    await closeBots(bots);
  }
});
