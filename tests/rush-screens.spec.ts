/**
 * 35. Party Rush TV screenshots (TV mode on): the scoreboard at 1920×1080 and 3840×2160, UP NEXT,
 *     3-2-1, round results, paused, the Esc menu, and EVERY minigame mid-play at 4 and 16 players
 *     → docs/screenshots/30-rush-*.jpg. Also asserts the round loop stays clean while doing so.
 */
import { expect, test, type Page } from '@playwright/test';
import type { BotPhone } from '../scripts/bots';
import { collectErrors, setTvMode, shot, sleep } from './helpers';
import {
  RUSH_GAMES,
  closeBots,
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
} from './rushHelpers';

/**
 * Wait for `n` REAL animation frames (no time-out fallback, unlike helpers.settle): under heavy load headless
 * Chromium can starve rAF for seconds (the Rush watchdog keeps the loop correct meanwhile, but the canvas
 * then still shows an older frame), so a screenshot must follow a drawn frame.
 */
async function drawn(page: Page, n = 2): Promise<void> {
  await page.evaluate(
    (k) =>
      new Promise<void>((resolve) => {
        let i = 0;
        const tick = (): void => {
          if (++i >= k) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    n,
  );
}

const HD = { width: 1920, height: 1080 } as const;
const UHD = { width: 3840, height: 2160 } as const;

async function scoreboardShots(page: Page, tag: string): Promise<void> {
  if ((await rushState(page)).phase === 'results') await rushCall(page, 'next'); // results → scoreboard
  await waitRush(page, `r.phase === 'lobby'`, 15_000);
  await expect(page.getByTestId('rush-scoreboard')).toBeVisible();
  await sleep(2500); // standings animation
  await drawn(page, 3);
  await shot(page, `30-rush-scoreboard-${tag}-1080.jpg`);
  await page.setViewportSize(UHD);
  await sleep(1200);
  await drawn(page, 3);
  await shot(page, `30-rush-scoreboard-${tag}-4k.jpg`);
  await page.setViewportSize(HD);
  await drawn(page, 2);
}

async function minigameShots(page: Page, n: number, extras: boolean): Promise<string[]> {
  const out: string[] = [];
  for (const id of RUSH_GAMES) {
    const name = `30-rush-${id}-${n}p.jpg`;
    // A screenshot on a loaded machine can take seconds: if the round ended meanwhile, play it again.
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      const first = attempt === 0;
      const before = (await rushState(page)).rid;
      expect(await rushForce(page, id)).toBe(true);
      const st = await waitRush(page, `r.rid > ${before} && r.phase === 'intro'`, 15_000);
      if (first && extras && (id === 'shake-race' || id === 'darts')) {
        await sleep(id === 'shake-race' ? 5600 : 1500); // shake-race: the "Hold your phone tight!" beat
        await drawn(page, 2);
        await shot(page, `30-rush-upnext-${id}.jpg`);
      }
      await rushCall(page, 'next');
      if (first && extras && id === 'darts') {
        const c = await waitRush(page, `r.phase === 'count' || r.phase === 'play'`, 10_000);
        if (c.phase === 'count') {
          await drawn(page, 2);
          await shot(page, '30-rush-countdown.jpg');
        }
      }
      await waitRush(page, `r.phase === 'play' && r.rid === ${st.rid}`, 15_000);
      // Let the bots do things (bombs flying, lines cast, darts thrown…).
      const at = id === 'shake-race' ? 2500 : id === 'quick-draw' ? 7000 : 6000;
      await sleep(at);
      if ((await rushState(page)).phase !== 'play') continue;
      await drawn(page, 2);
      await shot(page, name);
      // The picture must show the round in play (not the next phase after a slow frame).
      const after = await rushState(page);
      ok = after.phase === 'play' && after.rid === st.rid;
      if (ok && extras && id === 'tug-of-war') {
        await rushPause(page, true);
        await drawn(page, 2);
        await shot(page, '30-rush-paused.jpg');
        await rushPause(page, false);
      }
      if ((await rushState(page)).phase !== 'lobby') await rushCall(page, 'skip');
      await waitRush(page, `r.phase === 'lobby'`, 15_000);
      expect((await rushState(page)).errors, `${id}: errors`).toEqual([]);
    }
    expect(ok, `${id}: screenshot taken during play`).toBe(true);
    out.push(name);
  }
  return out;
}

test('TV screenshots: scoreboard (1080p + 4K), UP NEXT, 3-2-1, results, paused, menu, all 10 minigames at 4 and 16 players', async ({ page }) => {
  test.setTimeout(20 * 60_000);
  const errs = collectErrors(page, 'host');
  const room = await openRushHost(page, { viewport: HD });
  await setTvMode(page, true);
  await hostPickRush(page);
  await rushSetting(page, 'auto', false);
  let bots: BotPhone[] = [];
  try {
    // ---------------------------------------------------------------- 4 players
    bots = await joinRushBots(room, 4);
    let st = await playRound(page, 'shake-race');
    expect(st.phase).toBe('results');
    await sleep(1500);
    await drawn(page, 2);
    await shot(page, '30-rush-results-4p.jpg');
    await scoreboardShots(page, '4p');
    await page.keyboard.press('Escape');
    await waitRush(page, `r.menu`, 5_000);
    await expect(page.getByTestId('rush-menu')).toBeVisible();
    await drawn(page, 2);
    await shot(page, '30-rush-menu.jpg');
    await page.keyboard.press('Escape');
    await waitRush(page, `!r.menu && !r.paused`, 5_000);
    await minigameShots(page, 4, true);

    // ---------------------------------------------------------------- 16 players
    bots = bots.concat(await joinRushBots(room, 12, { seed: 777 }));
    await waitRush(page, `r.players.filter((p) => p.st === 'play').length === 16`, 20_000);
    st = await playRound(page, 'dont-move');
    expect(st.phase).toBe('results');
    expect(st.lastResults!.rows.length).toBe(16);
    await sleep(1500);
    await drawn(page, 2);
    await shot(page, '30-rush-results-16p.jpg');
    await scoreboardShots(page, '16p');
    await minigameShots(page, 16, false);
    expect((await rushState(page)).errors).toEqual([]);
    errs.expectNone();
  } finally {
    await closeBots(bots);
  }
});
