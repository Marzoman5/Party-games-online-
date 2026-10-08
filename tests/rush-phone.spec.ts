/**
 * 31. Party Rush on a REAL phone page (/play) in portrait iPhone + Android mobile contexts (isMobile,
 *     hasTouch): one tap joins (TAP TO PLAY → a scoreboard row on the TV, status 'play'), no sensors in
 *     headless → touch fallback; the phone plays real rounds with its touch pad (mash in Shake Race,
 *     drag-to-aim + tap-to-throw in Darts, tap to pass the bomb in Hot Potato) and gets its result; then
 *     the motion injector (`__phone.motion.gesture('flick')`) switches it to the sensor path, which passes
 *     the bomb on the host too. Phone screenshots → docs/screenshots/31-rush-phone-*.jpg.
 */
import { expect, test, type Page } from '@playwright/test';
import { collectErrors, shot, sleep } from './helpers';
import {
  PHONES,
  hostPickRush,
  newPhonePage,
  openRushHost,
  phoneRush,
  rushCall,
  rushForce,
  rushSetting,
  rushState,
  waitPhone,
  waitRush,
} from './rushHelpers';

async function centerOf(phone: Page, testid: string): Promise<{ x: number; y: number }> {
  const b = await phone.getByTestId(testid).boundingBox();
  if (!b) throw new Error(`no box for ${testid}`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Force a minigame, skip the UP NEXT card, wait until the phone is in play. Returns the round id. */
async function startRound(page: Page, phone: Page, id: string): Promise<number> {
  const before = (await rushState(page)).rid;
  expect(await rushForce(page, id)).toBe(true);
  const st = await waitRush(page, `r.rid > ${before} && r.phase === 'intro'`, 20_000);
  await rushCall(page, 'next');
  await waitPhone(phone, `p.rush && p.rush.rid === ${st.rid} && p.rush.ph === 'play'`, 20_000);
  return st.rid;
}

for (const dev of PHONES) {
  test(`real phone @ ${dev.tag} portrait: one-tap join, touch-fallback rounds, results, motion injector`, async ({ page, browser }) => {
    test.setTimeout(8 * 60_000);
    const hostErrs = collectErrors(page, 'host');
    const room = await openRushHost(page);
    await hostPickRush(page);
    await rushSetting(page, 'auto', false);
    const phone = await newPhonePage(browser, dev);
    const phoneErrs = collectErrors(phone, 'phone');
    const p = (n: string): string => `31-rush-phone-${n}-${dev.tag}.jpg`;
    try {
      // ------------------------------------------------------------------ join with ONE tap
      await phone.goto(`/play?room=${room}`);
      await waitPhone(phone, `p.layout === 'rush' && !!p.rush && p.rush.me.st === 'new'`, 30_000);
      const tapBtn = phone.getByTestId('rush-tap-to-play');
      await expect(tapBtn).toBeVisible();
      const tb = (await tapBtn.boundingBox())!;
      expect(tb.width * tb.height, 'the join tap covers (almost) the whole screen').toBeGreaterThan(dev.viewport.width * dev.viewport.height * 0.5);
      const pid = (await phoneRush(phone)).playerId;
      await expect(page.locator(`[data-testid="rush-row"][data-player-id="${pid}"]`)).toHaveCount(0);
      await shot(phone, p('tap-to-play'));

      await tapBtn.tap();
      // motion.enable() waits up to 1.5 s for sensor data before falling back to touch.
      const joined = await waitPhone(phone, `p.rush && p.rush.me.st === 'play'`, 15_000);
      expect(joined.rushTapped).toBe(true);
      expect(joined.rushTouch, 'no sensors in headless → touch fallback').toBe(true);
      expect(joined.rushSent.here).toBeGreaterThanOrEqual(1);
      expect(joined.rushSent.mode).toBeGreaterThanOrEqual(1);
      await expect(page.locator(`[data-testid="rush-row"][data-player-id="${pid}"]`)).toBeVisible({ timeout: 10_000 });
      await waitRush(page, `r.players.some((x) => x.id === ${JSON.stringify(pid)} && x.st === 'play' && x.touch)`, 10_000);
      await expect(phone.getByTestId('rush-tap-to-play')).toBeHidden();
      await expect(phone.getByTestId('rush-word')).toHaveText(/Look at the TV/i);
      await shot(phone, p('lobby'));

      // ------------------------------------------------------------------ Shake Race: mash the button
      const rid1 = await startRound(page, phone, 'shake-race');
      await expect(phone.getByTestId('rush-mash')).toBeVisible();
      await expect(phone.getByTestId('rush-touch-pad')).toBeVisible();
      const mb = (await phone.getByTestId('rush-touch-pad').boundingBox())!;
      expect(mb.height, 'touch target ≥ half the screen').toBeGreaterThanOrEqual(dev.viewport.height * 0.4);
      const mash = await centerOf(phone, 'rush-mash');
      let shotTaken = false;
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        const st = await phoneRush(phone);
        if (st.rush?.ph !== 'play' || st.rush.rid !== rid1) break;
        for (let i = 0; i < 4; i++) await phone.touchscreen.tap(mash.x + (i % 2) * 6, mash.y);
        if (!shotTaken) {
          shotTaken = true;
          await shot(phone, p('play-mash'));
        }
      }
      const r1 = await waitRush(page, `r.phase === 'results' && r.lastResults && r.lastResults.rid === ${rid1}`, 30_000);
      const row1 = r1.lastResults!.rows.find((r) => r.id === pid);
      expect(row1, 'the phone is ranked').toBeTruthy();
      expect(r1.lastResults!.rows.length, '1 human + 2 solo bots').toBe(3);
      expect(row1!.touch).toBe(true);
      expect(row1!.stat, 'mashing moved the runner').not.toBe('0%');
      const ps1 = await waitPhone(phone, `p.rush && p.rush.ph === 'results' && !!p.rush.res`, 10_000);
      expect(ps1.rush!.res!.place).toBe(row1!.place);
      expect(ps1.rush!.res!.pts).toBe(row1!.pts);
      expect(ps1.rushSent.stream, '20 Hz stream sent').toBeGreaterThan(50);
      await expect(phone.getByTestId('rush-result')).toBeVisible();
      await shot(phone, p('results'));

      // ------------------------------------------------------------------ Darts: drag to aim, tap to throw
      const rid2 = await startRound(page, phone, 'darts');
      await expect(phone.getByTestId('rush-touch-aim')).toBeVisible();
      const aim = await centerOf(phone, 'rush-touch-pad');
      const flicks0 = (await phoneRush(phone)).rushSent.events.flick ?? 0;
      for (let dart = 0; dart < 3; dart++) {
        await phone.mouse.move(aim.x, aim.y);
        await phone.mouse.down();
        await phone.mouse.move(aim.x + 12, aim.y - 8, { steps: 4 });
        await phone.mouse.up();
        await sleep(250);
        await phone.touchscreen.tap(aim.x, aim.y);
        await sleep(1300);
      }
      const ps2 = await phoneRush(phone);
      expect((ps2.rushSent.events.flick ?? 0) - flicks0, 'three taps = three throws').toBeGreaterThanOrEqual(3);
      await rushCall(page, 'skip'); // don't wait for the cap; skipping is part of the contract too
      await waitRush(page, `r.phase === 'lobby' && r.rid === ${rid2}`, 15_000);

      // ------------------------------------------------------------------ Hot Potato: the bomb, tap to pass
      const rid3 = await startRound(page, phone, 'hot-potato');
      await waitPhone(phone, `p.rush && p.rush.rid === ${rid3} && p.rush.cue && p.rush.cue.show === 'bomb'`, 40_000);
      await expect(phone.getByTestId('rush-bomb')).toBeVisible();
      await sleep(900); // let the triple-cue strobe (0.6 s) finish
      await shot(phone, p('bomb'));
      const bombCue = (await phoneRush(phone)).rush!.cue!.id;
      const tapsBefore = (await phoneRush(phone)).rushSent.events.flick ?? 0;
      const pad = await centerOf(phone, 'rush-touch-pad');
      // Pass cooldown 0.8 s after a catch: tap until the bomb leaves this phone.
      for (let i = 0; i < 10; i++) {
        await phone.touchscreen.tap(pad.x, pad.y);
        const s = await phoneRush(phone);
        if (!s.rush?.cue || s.rush.cue.id !== bombCue || s.rush.cue.show !== 'bomb') break;
        await sleep(400);
      }
      await waitPhone(phone, `!p.rush || !p.rush.cue || p.rush.cue.id !== ${bombCue} || p.rush.ph !== 'play'`, 5_000);
      expect(((await phoneRush(phone)).rushSent.events.flick ?? 0) - tapsBefore).toBeGreaterThanOrEqual(1);

      // ------------------------------------------------------------------ motion injector → sensor path
      await phone.evaluate(() => (window as unknown as { __phone: { motion: { gesture(k: string, v?: number): void } } }).__phone.motion.gesture('flick', 40));
      await waitPhone(phone, `p.rushTouch === false`, 5_000);
      await waitRush(page, `r.players.some((x) => x.id === ${JSON.stringify(pid)} && !x.touch)`, 10_000);
      // Wait for the bomb to come back and pass it with a sensor flick (no touch at all).
      const sensorDeadline = Date.now() + 60_000;
      let passedBySensor = false;
      while (Date.now() < sensorDeadline && !passedBySensor) {
        const s = await phoneRush(phone);
        if (!s.rush || s.rush.ph !== 'play') {
          // Round over before the bomb came back: play another one.
          await waitRush(page, `r.phase === 'results' || r.phase === 'lobby'`, 40_000);
          await startRound(page, phone, 'hot-potato');
          continue;
        }
        if (s.rush.cue?.show !== 'bomb') {
          await sleep(200);
          continue;
        }
        const cueId = s.rush.cue.id;
        const sent0 = s.rushSent.events.flick ?? 0;
        for (let i = 0; i < 8; i++) {
          await phone.evaluate(() => (window as unknown as { __phone: { motion: { gesture(k: string, v?: number): void } } }).__phone.motion.gesture('flick', 55));
          await sleep(350);
          const t = await phoneRush(phone);
          if (!t.rush?.cue || t.rush.cue.id !== cueId) {
            passedBySensor = (t.rushSent.events.flick ?? 0) > sent0;
            break;
          }
        }
      }
      expect(passedBySensor, 'an injected sensor flick passed the bomb on the host').toBe(true);
      await shot(phone, p('play-word-sensors'));
      await waitRush(page, `r.phase === 'results'`, 45_000);
      const fin = await rushState(page);
      expect(fin.errors).toEqual([]);
      expect(fin.players.find((x) => x.id === pid)!.pts).toBeGreaterThan(0);
      hostErrs.expectNone();
      phoneErrs.expectNone();
    } finally {
      await phone.context().close();
    }
  });
}
