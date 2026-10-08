/**
 * R2. Every game over WebRTC, played from real phone pages far enough to prove that phone input
 *     reaches the host simulation and the host's state reaches the phone:
 *       - Kart Party: lobby -> tutorial -> setup -> race; a finger on the steer zone turns the host's
 *         kart (60 Hz input packets on the unreliable channel), ITEM uses an item, results on the phone.
 *       - Smash Party: picked on the host, sandbox ATTACK + match JUMP from real taps move the host fighter.
 *       - Party Rush: one tap joins the endless loop; mashing in Shake Race moves the runner.
 */
import { expect, test, type Page } from '@playwright/test';
import { collectErrors, shot } from '../helpers';
import {
  PHONE_LANDSCAPE,
  PHONE_PORTRAIT,
  joinPhone,
  lobbyReady,
  openRtcHost,
  phoneState,
  sleep,
  tapTouch,
  waitHost,
  waitPhone,
} from './rtcHelpers';

type GW = Window & {
  __game?: { getState(): { phase: string; karts: { lastSteer: number; itemsUsed: number; speed: number }[] }; finishAll(): void; giveItem(slot: number, item: string): void };
  __smash?: { getState(): { phase: string; fighters: { index: number; human: boolean; slot: number; grounded: boolean }[] } | null };
  __rush?: {
    getState(): { phase: string; rid: number; lastResults: { rid: number; rows: { id: string; stat: string }[] } | null; players: { id: string; st: string }[] };
    forceGame(id: string): boolean;
    next(): void;
    setSetting(k: string, v: unknown): void;
  };
  __party?: { pickGame(id: string): Promise<boolean>; skipTutorial(): void; skipSandbox(): void };
};

function game(page: Page): Promise<NonNullable<ReturnType<NonNullable<GW['__game']>['getState']>>> {
  return page.evaluate(() => (window as unknown as GW).__game!.getState());
}

test('Kart Party over WebRTC: real phone steers the host kart, uses an item, sees results', async ({ page, browser }) => {
  test.setTimeout(420_000);
  const hostErrs = collectErrors(page, 'host');
  const st = await openRtcHost(page);
  const phone = await joinPhone(browser, st.joinUrl, PHONE_LANDSCAPE);
  const phoneErrs = collectErrors(phone, 'phone');
  try {
    await lobbyReady(phone, 'Iris', 'juno');
    await waitHost(page, `s.players.length === 1 && s.players[0].ready`);
    await phone.getByTestId('btn-start').tap();
    await waitPhone(phone, `p.screen === 'tutorial'`, 20_000);
    await page.evaluate(() => (window as unknown as GW).__party!.skipTutorial());
    await waitPhone(phone, `p.screen === 'setup'`, 30_000);
    await phone.getByTestId('btn-start-race').tap();
    await waitPhone(phone, `p.screen === 'race'`, 60_000);
    await page.waitForFunction(() => (window as unknown as GW).__game!.getState().phase === 'racing', undefined, { timeout: 150_000, polling: 250 });

    const cdp = await phone.context().newCDPSession(phone);
    const zone = (await phone.getByTestId('steer-zone').boundingBox())!;
    const c = { x: zone.x + zone.width / 2, y: zone.y + zone.height / 2 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...c, id: 1, radiusX: 4, radiusY: 4, force: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c.x + 200, y: c.y, id: 1, radiusX: 4, radiusY: 4, force: 1 }] });
    await expect.poll(async () => (await phoneState(phone)).lastInput.steer, { timeout: 10_000 }).toBeGreaterThan(0.3);
    await expect.poll(async () => (await game(page)).karts[0].lastSteer, { timeout: 20_000 }).toBeGreaterThan(0.3);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await shot(phone, 'r2-kart-phone-race.jpg');

    await page.evaluate(() => (window as unknown as GW).__game!.giveItem(0, 'banana'));
    await expect.poll(async () => (await phone.getByTestId('item-label').innerText()).trim(), { timeout: 30_000 }).not.toBe('');
    const used0 = (await game(page)).karts[0].itemsUsed;
    await phone.getByTestId('btn-item').tap();
    await expect.poll(async () => (await game(page)).karts[0].itemsUsed, { timeout: 30_000 }).toBeGreaterThan(used0);

    await page.evaluate(() => (window as unknown as GW).__game!.finishAll());
    await waitPhone(phone, `p.screen === 'results'`, 60_000);
    await expect(phone.getByTestId('results-list')).toContainText('Iris');
    hostErrs.expectNone();
    phoneErrs.expectNone();
  } finally {
    await phone.context().close();
  }
});

test('Smash Party over WebRTC: real phone taps attack in the sandbox and jumps in a match', async ({ page, browser }) => {
  test.setTimeout(480_000);
  const hostErrs = collectErrors(page, 'host');
  const st = await openRtcHost(page);
  const phone = await joinPhone(browser, st.joinUrl, PHONE_LANDSCAPE);
  const phoneErrs = collectErrors(phone, 'phone');
  try {
    await lobbyReady(phone, 'Fia', 'juno');
    await waitHost(page, `s.players.length === 1 && s.players[0].ready`);
    await page.evaluate(() => (window as unknown as GW).__party!.pickGame('smash'));
    await waitPhone(phone, `p.game === 'smash' && p.layout === 'fighter'`, 60_000);
    await sleep(800);
    if (!(await waitHost(page, `true`)).players[0].ready) await phone.getByTestId('btn-ready').tap();
    await waitHost(page, `s.players[0].ready`);
    await phone.getByTestId('btn-start').tap();
    await waitPhone(phone, `p.screen === 'tutorial'`, 30_000);
    await page.evaluate(() => (window as unknown as GW).__party!.skipTutorial());
    await waitPhone(phone, `p.screen === 'sandbox'`, 60_000);
    await page.waitForFunction(() => (window as unknown as GW).__smash?.getState()?.phase === 'sandbox', undefined, { timeout: 120_000, polling: 250 });

    const cdp = await phone.context().newCDPSession(phone);
    const a0 = (await phoneState(phone)).lastFightInput?.attackPresses ?? 0;
    await tapTouch(cdp, phone, 'btn-attack', 1);
    await expect.poll(async () => (await phoneState(phone)).lastFightInput?.attackPresses ?? 0, { timeout: 10_000 }).toBeGreaterThan(a0);
    await shot(phone, 'r2-smash-phone-sandbox.jpg');

    await page.evaluate(() => (window as unknown as GW).__party!.skipSandbox());
    await waitPhone(phone, `p.screen === 'setup'`, 60_000);
    await phone.getByTestId('btn-start-match').tap();
    await waitPhone(phone, `p.screen === 'race'`, 120_000);
    await page.waitForFunction(() => (window as unknown as GW).__smash?.getState()?.phase === 'fighting', undefined, { timeout: 180_000, polling: 250 });

    const fi = await page.evaluate(() => (window as unknown as GW).__smash!.getState()!.fighters.find((f) => f.human)!.index);
    let airborne = false;
    for (let i = 0; i < 6 && !airborne; i++) {
      await tapTouch(cdp, phone, 'btn-jump', 2, 150);
      for (let k = 0; k < 10 && !airborne; k++) {
        airborne = await page.evaluate((n) => !(window as unknown as GW).__smash!.getState()!.fighters[n].grounded, fi);
        if (!airborne) await sleep(300);
      }
    }
    expect(airborne, 'host fighter jumps from a real phone tap over WebRTC').toBe(true);
    await shot(phone, 'r2-smash-phone-match.jpg');
    hostErrs.expectNone();
    phoneErrs.expectNone();
  } finally {
    await phone.context().close();
  }
});

test('Party Rush over WebRTC: one tap joins, mashing in Shake Race moves the runner', async ({ page, browser }) => {
  test.setTimeout(300_000);
  const hostErrs = collectErrors(page, 'host');
  const st = await openRtcHost(page, { stub: true });
  await page.evaluate(() => {
    const r = (window as unknown as GW).__rush!;
    r.setSetting('auto', false);
    r.setSetting('volume', 0);
  });
  await page.evaluate(() => (window as unknown as GW).__party!.pickGame('rush'));
  const phone = await joinPhone(browser, st.joinUrl, PHONE_PORTRAIT);
  const phoneErrs = collectErrors(phone, 'phone');
  try {
    await waitPhone(phone, `p.layout === 'rush' && !!p.rush && p.rush.me.st === 'new'`, 30_000);
    const pid = (await phoneState(phone)).playerId;
    await phone.getByTestId('rush-tap-to-play').tap();
    await waitPhone(phone, `p.rush && p.rush.me.st === 'play'`, 15_000);
    await page.waitForFunction((id) => (window as unknown as GW).__rush!.getState().players.some((x) => x.id === id && x.st === 'play'), pid, { timeout: 15_000 });

    const before = await page.evaluate(() => (window as unknown as GW).__rush!.getState().rid);
    expect(await page.evaluate(() => (window as unknown as GW).__rush!.forceGame('shake-race'))).toBe(true);
    await page.waitForFunction((b) => {
      const r = (window as unknown as GW).__rush!.getState();
      return r.rid > b && r.phase === 'intro';
    }, before, { timeout: 20_000 });
    const rid = await page.evaluate(() => (window as unknown as GW).__rush!.getState().rid);
    await page.evaluate(() => (window as unknown as GW).__rush!.next());
    await waitPhone(phone, `p.rush && p.rush.rid === ${rid} && p.rush.ph === 'play'`, 20_000);

    const mash = (await phone.getByTestId('rush-mash').boundingBox())!;
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const ps = await phoneState(phone);
      if (ps.rush?.ph !== 'play' || ps.rush.rid !== rid) break;
      for (let i = 0; i < 4; i++) await phone.touchscreen.tap(mash.x + mash.width / 2 + (i % 2) * 6, mash.y + mash.height / 2);
    }
    await page.waitForFunction((n) => {
      const r = (window as unknown as GW).__rush!.getState();
      return r.phase === 'results' && r.lastResults?.rid === n;
    }, rid, { timeout: 40_000 });
    const row = await page.evaluate((id) => (window as unknown as GW).__rush!.getState().lastResults!.rows.find((r) => r.id === id), pid);
    expect(row, 'the phone is ranked').toBeTruthy();
    expect(row!.stat, 'mashing over WebRTC moved the runner').not.toBe('0%');
    expect((await phoneState(phone)).rushSent.stream, '20 Hz stream sent').toBeGreaterThan(50);
    await shot(phone, 'r2-rush-phone.jpg');
    hostErrs.expectNone();
    phoneErrs.expectNone();
  } finally {
    await phone.context().close();
  }
});
