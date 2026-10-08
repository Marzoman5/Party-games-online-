/**
 * 34. Party Hub with 6 players: Party Rush → Kart Party → Smash Party → Party Rush.
 *     Kart and Smash seat 4 (the first 4 by JOIN ORDER), the other 2 watch: their phones get
 *     `watch:'full'` (screen 'waiting'), the TV shows the "👀 watching this one" chip. Back in Rush,
 *     all 6 play again with their points intact (same sockets, no rejoin).
 *     Host: real build with the kart STUB engine (seating is session logic) + the real Smash engine.
 */
import { expect, test, type Page } from '@playwright/test';
import type { BotPhone } from '../scripts/bots';
import { collectErrors } from './helpers';
import {
  closeBots,
  hostPickRush,
  joinRushBots,
  openRushHost,
  playRound,
  rushSetting,
  rushState,
  waitRush,
} from './rushHelpers';
import { LEAN_SETUP, hubState, smash, smashToSetup, waitHub, waitSmashPhase } from './smashHelpers';

async function expectWatchers(page: Page, bots: BotPhone[], seatedIds: string[], label: string): Promise<void> {
  const watchers = bots.filter((b) => !seatedIds.includes(b.playerId));
  expect(watchers.length, `${label}: 2 watchers`).toBe(2);
  await Promise.all(watchers.map((b) => b.waitFor((x) => x.state?.watch === 'full', 20_000, `${label}: watch full`)));
  for (const b of watchers) expect(b.state!.screen, `${label}: watcher screen`).toBe('waiting');
  for (const b of bots.filter((x) => seatedIds.includes(x.playerId))) expect(b.state?.watch ?? null, `${label}: seated phones don't watch`).toBeNull();
}

test('6 players: Rush → Kart (4 seated by join order, 2 watch) → Smash (same) → back to Rush with all 6', async ({ page }) => {
  test.setTimeout(15 * 60_000);
  const errs = collectErrors(page, 'host');
  const room = await openRushHost(page);
  await hostPickRush(page);
  await rushSetting(page, 'auto', false);
  const bots = await joinRushBots(room, 6);
  const joinOrder = bots.map((b) => b.playerId);
  const first4 = joinOrder.slice(0, 4);
  try {
    // ---- a Rush round with all 6
    let st = await playRound(page, 'shake-race');
    expect(st.phase).toBe('results');
    expect(st.lastResults!.rows.length).toBe(6);
    const rushPts = Object.fromEntries(st.players.map((p) => [p.id, p.pts]));

    // ---- leader leaves Rush (phone "quit") → hub lobby → picks Kart Party
    const leader = bots.find((b) => b.state?.you?.isLeader)!;
    expect(leader.playerId, 'first joiner leads').toBe(joinOrder[0]);
    leader.quit();
    await waitHub(page, `s.screen === 'lobby'`, 20_000);
    leader.game('kart');
    await waitHub(page, `s.game === 'kart' && s.screen === 'lobby'`, 30_000);
    for (const b of bots) b.ready(true);
    await Promise.all(bots.map((b) => b.waitFor((x) => x.state?.you?.ready === true, 20_000, 'ready')));
    leader.start();
    await leader.waitFor((b) => b.state?.screen === 'tutorial' || b.state?.screen === 'setup', 30_000, 'tutorial/setup');
    if (leader.state?.screen === 'tutorial') leader.tutSkip();
    await waitHub(page, `s.screen === 'setup'`, 30_000);
    // Setup already tells who will watch.
    await expect(page.getByTestId('watch-chip')).toHaveClass(/kp-on/, { timeout: 10_000 });
    leader.setup({ mode: 'single', laps: 1, cc: 150 });
    await waitHub(page, `s.setup.laps === 1`, 20_000);
    leader.start();
    await waitHub(page, `s.screen === 'race' || s.screen === 'loading'`, 60_000);
    const ks = await hubState(page);
    expect([...ks.karts].sort(), 'kart seats = first 4 by join order').toEqual([...first4].sort());
    await expectWatchers(page, bots, ks.karts, 'kart');
    await expect(page.getByTestId('watch-chip')).toHaveClass(/kp-on/);
    const watchNames = bots.slice(4).map((b) => b.state!.you!.name);
    for (const n of watchNames) await expect(page.getByTestId('watch-chip')).toContainText(n);
    await page.evaluate(() => (window as unknown as { __game: { finishAll(): void } }).__game.finishAll());
    await waitHub(page, `s.screen === 'results'`, 60_000);
    await expect(page.getByTestId('watch-chip')).toHaveClass(/kp-on/);
    // Results: one switch button per other game (never a blind cycle).
    await expect(page.getByTestId('btn-switch')).toBeVisible();
    await expect(page.locator('[data-testid^="btn-switch-"]')).toHaveCount(1);

    // ---- Switch Game → Smash Party
    leader.post('switch', 'smash');
    await waitHub(page, `s.game === 'smash'`, 120_000);
    await smashToSetup(page, bots, 180_000, false);
    leader.gsetup({ ...LEAN_SETUP, stocks: 1 });
    await waitHub(page, `s.gameSetup.stocks === 1 && s.gameSetup.stageId === 'arena'`, 20_000);
    leader.start();
    await waitSmashPhase(page, ['loading', 'intro', 'countdown', 'fighting'], 180_000);
    const ss = await hubState(page);
    expect([...ss.karts].sort(), 'smash seats = first 4 by join order').toEqual([...first4].sort());
    await expectWatchers(page, bots, ss.karts, 'smash');
    await expect(page.getByTestId('watch-chip')).toHaveClass(/kp-on/);
    await waitSmashPhase(page, ['fighting'], 180_000);
    await smash(page, 'endMatch');
    await waitHub(page, `s.screen === 'results'`, 120_000);

    // ---- Switch Game → back to Party Rush: everyone plays again, points intact
    leader.post('switch', 'rush');
    await waitHub(page, `s.game === 'rush' && s.screen === 'race'`, 60_000);
    await Promise.all(bots.map((b) => b.waitFor((x) => x.state?.screen === 'race' && x.state?.game === 'rush' && (x.state?.watch ?? null) === null, 20_000, 'phones back in rush')));
    // Phones that were tapped in stay in (or tap again if the host asked).
    for (const b of bots) {
      await b.waitForRush((m) => m.me.st !== undefined, 20_000, 'rush msg');
      if (b.rush!.me.st === 'new' || b.rush!.me.st === 'away') b.rushHere(true);
    }
    await rushSetting(page, 'auto', false);
    await waitRush(page, `r.players.filter((p) => p.st === 'play').length === 6`, 20_000);
    st = await rushState(page);
    for (const [id, pts] of Object.entries(rushPts)) expect(st.players.find((p) => p.id === id)?.pts, `${id} kept its Rush points`).toBe(pts);
    st = await playRound(page, 'dont-move');
    expect(st.phase).toBe('results');
    expect(st.lastResults!.rows.map((r) => r.id).sort()).toEqual([...joinOrder].sort());
    for (const b of bots) {
      expect(b.connected).toBe(true);
      expect(b.rejoin).toBe(false);
    }
    expect(st.errors).toEqual([]);
    errs.expectNone();
  } finally {
    await closeBots(bots);
  }
});
