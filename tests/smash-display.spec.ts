/**
 * Smash Party rendering at real screen sizes:
 * 24/25. Host at 1366x768 and 3840x2160 (TV mode) on the setup screen, during a match and on the
 *     results screen (screenshots + the canvas/overlays fill the screen).
 * 30–33. The real phone controller (/play) at iPhone (844x390) and Android (915x412) landscape:
 *     the game switch flips the phone to the fighter layout without a reload; sandbox + match
 *     fighter controller (ATTACK / SPECIAL / JUMP / SHIELD / GRAB / pause inside the viewport,
 *     real touches reach the host), damage % from the host, results.
 */
import { expect, test, type Browser, type CDPSession, type Page } from '@playwright/test';
import { BotPhone } from '../scripts/bots';
import { BASE_URL, LAPTOP, TV, collectErrors, setTvMode, settle, shot, sleep } from './helpers';
import {
  expectInViewport,
  fighterOf,
  hubState,
  hubWithSmashMatch,
  koUntilGameSet,
  observeAndFight,
  openHub,
  smash,
  smashState,
  startSmashMatch,
  waitHub,
  waitSmashPhase,
  waitSmashResults,
} from './smashHelpers';

async function canvasFills(page: Page, vp: { width: number; height: number }): Promise<void> {
  const box = await page.evaluate(() => {
    let best: { w: number; h: number; x: number; y: number } | null = null;
    for (const c of Array.from(document.querySelectorAll('canvas'))) {
      const r = c.getBoundingClientRect();
      const st = getComputedStyle(c);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) continue;
      if (!best || r.width * r.height > best.w * best.h) best = { w: r.width, h: r.height, x: r.x, y: r.y };
    }
    return best;
  });
  expect(box, 'a visible game canvas').not.toBeNull();
  expect(box!.w).toBeGreaterThanOrEqual(vp.width * 0.9);
  expect(box!.h).toBeGreaterThanOrEqual(vp.height * 0.9);
}

async function both(page: Page, prefix: string, check: (vp: { width: number; height: number }) => Promise<void>): Promise<void> {
  for (const [vp, tv, tag] of [
    [LAPTOP, false, 'laptop'],
    [TV, true, 'tv'],
  ] as const) {
    await page.setViewportSize(vp);
    await setTvMode(page, tv);
    await settle(page, 2);
    await check(vp);
    await shot(page, `${prefix}-${tag}.jpg`);
  }
  await page.setViewportSize(LAPTOP);
  await setTvMode(page, false);
  await settle(page);
}

test('host renders Smash Party at 1366x768 and 4K TV: setup, match (HUD), results', async ({ page }) => {
  test.setTimeout(600_000);
  const errs = collectErrors(page, 'host');
  const { set } = await hubWithSmashMatch(page, 2, { stageId: 'skyline', stocks: 2, fillCpus: 3 });
  const { bots } = set;
  const obs = observeAndFight(page, bots);
  try {
    await waitHub(page, `!!m && m.hits > 0`, 120_000).catch(() => undefined);
    await smash(page, 'setDamage', 0, 64);
    await both(page, '24-host-smash-match', async (vp) => {
      await canvasFills(page, vp);
      const m = (await smashState(page))!;
      expect(['fighting', 'paused']).toContain(m.phase);
      expect(m.fighters.length).toBe(3);
      // Damage HUD: one panel per fighter, on screen, showing the 64% we set.
      const panels = page.locator('.sm-panel');
      await expect(panels).toHaveCount(m.fighters.length);
      for (let i = 0; i < m.fighters.length; i++) {
        const b = await panels.nth(i).boundingBox();
        expect(b, `HUD panel ${i}`).not.toBeNull();
        expect(b!.y + b!.height).toBeLessThanOrEqual(vp.height + 1);
        expect(b!.x + b!.width).toBeLessThanOrEqual(vp.width + 1);
      }
      await expect
        .poll(async () => Math.max(...(await page.locator('.sm-dmg-num').allInnerTexts()).map((t) => Number(t) || 0)), { timeout: 20_000 })
        .toBeGreaterThanOrEqual(64);
      // The camera keeps the fighters in view.
      for (const f of m.fighters.filter((x) => !x.out && !x.respawning && x.action !== 'ko')) expect(f.offscreen).toBe(false);
    });
    obs.stop();
    const keep = fighterOf((await smashState(page))!, bots[0])!.index;
    await koUntilGameSet(page, keep);
    await waitSmashResults(page, bots);
    await both(page, '25-host-smash-results', async (vp) => {
      await expectInViewport(page, ['smash-results', 'winner-banner'], vp);
    });
    // Change Settings -> setup screen at both sizes.
    bots[0].post('track');
    await waitHub(page, `s.screen === 'setup' && s.game === 'smash'`, 30_000);
    await both(page, '23-host-smash-setup-size', async (vp) => {
      await expectInViewport(page, ['screen-setup', 'stage-card-skyline'], vp);
    });
    errs.expectNone();
  } finally {
    obs.stop();
    await set.closeAll();
  }
});

// ---------------------------------------------------------------------------- phones

const DEVICES = [
  { tag: 'iphone', viewport: { width: 844, height: 390 }, char: 'juno', name: 'Iris' },
  { tag: 'android', viewport: { width: 915, height: 412 }, char: 'kai', name: 'Andy' },
] as const;

interface PhoneDbg {
  connected: boolean;
  screen: string | null;
  playerId: string;
  game?: string;
  layout?: 'kart' | 'fighter';
  fight?: { damage: number; stocks: number } | null;
  lastFightInput?: { attackPresses: number; jumpPresses: number; x: number; y: number } | null;
}

function phoneState(phone: Page): Promise<PhoneDbg> {
  return phone.evaluate(() => (window as unknown as { __phone: { getState(): PhoneDbg } }).__phone.getState());
}

async function newPhone(browser: Browser, viewport: { width: number; height: number }): Promise<Page> {
  const ctx = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  return ctx.newPage();
}

async function tapTouch(cdp: CDPSession, phone: Page, testId: string, id: number, holdMs = 80): Promise<void> {
  const b = await phone.getByTestId(testId).first().boundingBox();
  if (!b) throw new Error(`no box for ${testId}`);
  const pt = { x: b.x + b.width / 2, y: b.y + b.height / 2, id, radiusX: 4, radiusY: 4, force: 1 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
  await sleep(holdMs);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** Fighter buttons are inside the viewport and don't (substantially) overlap each other. */
async function checkFighterLayout(phone: Page, vp: { width: number; height: number }): Promise<void> {
  const required = ['btn-attack', 'btn-special', 'btn-jump', 'btn-shield'];
  const optional = ['btn-grab', 'btn-pause'];
  const present = [...required];
  for (const id of optional) if ((await phone.getByTestId(id).count()) > 0) present.push(id);
  await expectInViewport(phone, present, vp);
  const boxes = await Promise.all(present.map(async (id) => ({ id, b: (await phone.getByTestId(id).first().boundingBox())! })));
  for (const { id, b } of boxes.filter((x) => required.includes(x.id))) expect(b.width, `${id} thumb-sized`).toBeGreaterThanOrEqual(40);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i].b;
      const c = boxes[j].b;
      const ox = Math.max(0, Math.min(a.x + a.width, c.x + c.width) - Math.max(a.x, c.x));
      const oy = Math.max(0, Math.min(a.y + a.height, c.y + c.height) - Math.max(a.y, c.y));
      const small = Math.min(a.width * a.height, c.width * c.height);
      expect((ox * oy) / small, `${boxes[i].id} overlaps ${boxes[j].id}`).toBeLessThan(0.2);
    }
  }
  // Buttons on the right, stick area on the left half.
  for (const id of ['btn-attack', 'btn-special']) {
    const b = boxes.find((x) => x.id === id)!.b;
    expect(b.x + b.width / 2, `${id} on the right half`).toBeGreaterThan(vp.width / 2);
  }
}

for (const dev of DEVICES) {
  test(`phone fighter UI @ ${dev.tag} ${dev.viewport.width}x${dev.viewport.height}: layout switch, sandbox, match, results`, async ({ page, browser }) => {
    test.setTimeout(480_000);
    const hostErrs = collectErrors(page, 'host');
    const room = await openHub(page);
    // A bot joins first and leads; the real phone is player 2.
    const leader = await BotPhone.connect(BASE_URL, room, undefined, 10_000);
    const phone = await newPhone(browser, dev.viewport);
    const phoneErrs = collectErrors(phone, 'phone');
    const vp = dev.viewport;
    const p = (n: string): string => `${n}-${dev.tag}.jpg`;
    try {
      await leader.waitFor((b) => !!b.state?.you, 20_000, 'leader state');
      leader.profile('Lea', 'bram');
      leader.ready(true);
      leader.game('kart');
      await waitHub(page, `s.game === 'kart'`, 20_000);

      await phone.goto(`/play?room=${room}`);
      await expect.poll(async () => (await phoneState(phone)).screen, { timeout: 30_000 }).toBe('lobby');
      await phone.getByTestId('name-input').fill(dev.name);
      await phone.getByTestId('name-input').press('Enter');
      await phone.getByTestId(`char-${dev.char}`).tap();
      await phone.getByTestId('btn-ready').tap();
      await waitHub(page, `s.players.length === 2 && s.players.every(p => p.ready) && s.players[1].name === '${dev.name}' && s.players[1].characterId === '${dev.char}'`, 30_000);
      expect((await phoneState(phone)).layout).toBe('kart');

      // ---- leader picks Smash: the phone switches layout live (no reload).
      await phone.evaluate(() => ((window as unknown as { __noReload: boolean }).__noReload = true));
      leader.game('smash');
      await expect.poll(async () => (await phoneState(phone)).game, { timeout: 20_000 }).toBe('smash');
      await expect.poll(async () => (await phoneState(phone)).layout, { timeout: 20_000 }).toBe('fighter');
      expect(await phone.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
      await shot(phone, p('30-phone-smash-lobby'));

      // ---- tutorial -> sandbox: the fighter controller
      // (if picking a game reset the ready flags, ready up again)
      await sleep(1000);
      const hs = await hubState(page);
      if (!hs.players[0].ready) leader.ready(true);
      if (!hs.players[1].ready) await phone.getByTestId('btn-ready').tap();
      await waitHub(page, `s.players.every(p => p.ready)`, 20_000);
      leader.start();
      await leader.waitForScreen('tutorial', 30_000);
      await expect.poll(async () => (await phoneState(phone)).screen, { timeout: 20_000 }).toBe('tutorial');
      await shot(phone, p('31-phone-smash-tutorial'));
      leader.tutSkip();
      await expect.poll(async () => (await phoneState(phone)).screen, { timeout: 30_000 }).toBe('sandbox');
      await expect(phone.getByTestId('screen-fighter')).toBeVisible();
      await expect(phone.getByTestId('btn-attack')).toBeVisible();
      await waitSmashPhase(page, ['sandbox'], 120_000);
      const cdp = await phone.context().newCDPSession(phone);
      const a0 = (await phoneState(phone)).lastFightInput?.attackPresses ?? 0;
      await tapTouch(cdp, phone, 'btn-attack', 1);
      await expect.poll(async () => (await phoneState(phone)).lastFightInput?.attackPresses ?? 0, { timeout: 10_000 }).toBeGreaterThan(a0);
      await shot(phone, p('31-phone-smash-sandbox'));

      // ---- leader START -> setup -> match
      leader.practiceDone();
      await sleep(500);
      leader.start();
      await leader.waitForScreen('setup', 60_000);
      await expect.poll(async () => (await phoneState(phone)).screen, { timeout: 30_000 }).toBe('setup');
      await shot(phone, p('32-phone-smash-setup'));
      await startSmashMatch(page, [leader], { stageId: 'arena', stocks: 2 }, false);
      await expect.poll(async () => (await phoneState(phone)).screen, { timeout: 60_000 }).toBe('race');
      await waitSmashPhase(page, ['fighting'], 180_000);
      await expect(phone.getByTestId('screen-fighter')).toBeVisible();
      await checkFighterLayout(phone, vp);

      // Real touches reach the host: JUMP makes the phone's fighter leave the ground.
      const m = (await smashState(page))!;
      const fi = m.fighters.find((f) => f.human && f.slot === 1)!.index;
      const j0 = (await phoneState(phone)).lastFightInput?.jumpPresses ?? 0;
      let airborne = false;
      for (let i = 0; i < 5 && !airborne; i++) {
        await tapTouch(cdp, phone, 'btn-jump', 2, 150);
        for (let k = 0; k < 10 && !airborne; k++) {
          airborne = !(await smashState(page))!.fighters[fi].grounded;
          if (!airborne) await sleep(300);
        }
      }
      expect((await phoneState(phone)).lastFightInput?.jumpPresses ?? 0).toBeGreaterThan(j0);
      expect(airborne, 'host fighter jumps from a real phone tap').toBe(true);

      // Damage % from the host shows on the phone.
      await smash(page, 'setDamage', fi, 42);
      await expect.poll(async () => (await phoneState(phone)).fight?.damage, { timeout: 20_000 }).toBe(42);
      await expect(phone.getByTestId('fight-damage')).toContainText('42');
      await shot(phone, p('33-phone-smash-fighter'));
      // Results on the phone.
      await koUntilGameSet(page, fi);
      await waitSmashResults(page, [leader]);
      await expect.poll(async () => (await phoneState(phone)).screen, { timeout: 30_000 }).toBe('results');
      await expect(phone.getByText(dev.name).first()).toBeVisible();
      await shot(phone, p('34-phone-smash-results'));
      expect((await hubState(page)).screen).toBe('results');
      hostErrs.expectNone();
      phoneErrs.expectNone();
    } finally {
      await leader.close();
      await phone.context().close();
    }
  });
}
