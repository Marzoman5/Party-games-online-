/**
 * 10. The real phone controller (/play) at iPhone (844x390) and Android (915x412) landscape, as
 *     touch/mobile contexts, joined to a real host room. Lobby -> tutorial -> setup -> race ->
 *     pause -> results, with screenshots at each step, a layout check of the race controller,
 *     and real touches on DRIFT / ITEM / steer that reach the host engine.
 */
import { expect, test, type Browser, type CDPSession, type Locator, type Page } from '@playwright/test';
import {
  collectErrors,
  finishAll,
  gameState,
  giveItem,
  openHost,
  partyState,
  shot,
  sleep,
  waitEnginePhase,
  waitParty,
} from './helpers';

const DEVICES = [
  { tag: 'iphone', viewport: { width: 844, height: 390 }, char: 'juno', name: 'Iris' },
  { tag: 'android', viewport: { width: 915, height: 412 }, char: 'kai', name: 'Andy' },
] as const;

type PhoneDbg = {
  connected: boolean;
  screen: string | null;
  view: string;
  playerId: string;
  lastInput: { steer: number; drift: boolean; itemPresses: number; throttle: number };
};

function phoneState(phone: Page): Promise<PhoneDbg> {
  return phone.evaluate(() => (window as unknown as { __phone: { getState(): PhoneDbg } }).__phone.getState());
}

async function center(l: Locator): Promise<{ x: number; y: number }> {
  const b = await l.boundingBox();
  if (!b) throw new Error('no bounding box');
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

type Pt = { x: number; y: number; id: number };
async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', points: Pt[]): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id, radiusX: 4, radiusY: 4, force: 1 })),
  });
}

async function newPhone(browser: Browser, viewport: { width: number; height: number }): Promise<Page> {
  const ctx = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  return ctx.newPage();
}

const ROUND = new Set(['btn-gas', 'btn-drift', 'btn-item', 'btn-brake']);

/** Every rect inside the viewport, none overlapping. */
function checkLayout(boxes: Record<string, { x: number; y: number; width: number; height: number }>, vw: number, vh: number): void {
  const names = Object.keys(boxes);
  for (const n of names) {
    const b = boxes[n];
    expect(b.width, `${n} width`).toBeGreaterThan(30);
    expect(b.height, `${n} height`).toBeGreaterThan(30);
    expect(b.x, `${n} left`).toBeGreaterThanOrEqual(-1);
    expect(b.y, `${n} top`).toBeGreaterThanOrEqual(-1);
    expect(b.x + b.width, `${n} right`).toBeLessThanOrEqual(vw + 1);
    expect(b.y + b.height, `${n} bottom`).toBeLessThanOrEqual(vh + 1);
  }
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = boxes[names[i]];
      const b = boxes[names[j]];
      if (ROUND.has(names[i]) && ROUND.has(names[j])) {
        // Round thumb buttons: compare as circles (their square boxes may touch diagonally).
        const d = Math.hypot(a.x + a.width / 2 - (b.x + b.width / 2), a.y + a.height / 2 - (b.y + b.height / 2));
        expect(d, `${names[i]} overlaps ${names[j]}`).toBeGreaterThanOrEqual(a.width / 2 + b.width / 2 - 1);
        continue;
      }
      const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      expect(ox > 1 && oy > 1, `${names[i]} overlaps ${names[j]}`).toBe(false);
    }
  }
}

for (const dev of DEVICES) {
  test(`phone UI @ ${dev.tag} ${dev.viewport.width}x${dev.viewport.height}: join, tutorial, setup, race controller, pause, results`, async ({ page, browser }) => {
    test.setTimeout(420_000);
    const hostErrs = collectErrors(page, 'host');
    const room = await openHost(page);
    const phone = await newPhone(browser, dev.viewport);
    const phoneErrs = collectErrors(phone, 'phone');
    const vw = dev.viewport.width;
    const vh = dev.viewport.height;
    const p = (n: string) => `10-phone-${n}-${dev.tag}.jpg`;
    try {
      // ---------------------------------------------------------------- lobby
      await phone.goto(`/play?room=${room}`);
      await expect.poll(async () => (await phoneState(phone)).screen, { timeout: 30_000 }).toBe('lobby');
      await expect(phone.getByTestId('screen-lobby')).toBeVisible();
      await expect(phone.getByTestId('rotate-overlay')).toBeHidden();
      await expect(phone.getByTestId('room-code')).toContainText(room);
      await expect(phone.getByTestId('conn-dot')).toBeVisible();
      await shot(phone, p('02-lobby'));

      await phone.getByTestId('name-input').fill(dev.name);
      await phone.getByTestId('name-input').press('Enter');
      await phone.getByTestId(`char-${dev.char}`).tap();
      await expect(phone.getByTestId(`char-${dev.char}`)).toHaveClass(/sel/);
      await phone.getByTestId('btn-ready').tap();
      await waitParty(page, `s.players.length === 1 && s.players[0].ready && s.players[0].name === '${dev.name}' && s.players[0].characterId === '${dev.char}'`, 20_000);
      await expect(page.getByTestId('player-card-0')).toContainText(dev.name);
      await expect(page.getByTestId('player-card-0')).toHaveClass(/kp-ready/);
      await expect(phone.getByTestId('btn-start')).toBeEnabled();
      await shot(phone, p('02-lobby-ready'));

      // ------------------------------------------------------------- tutorial
      await phone.getByTestId('btn-start').tap();
      await expect.poll(async () => (await phoneState(phone)).screen, { timeout: 20_000 }).toBe('tutorial');
      await expect(phone.getByTestId('screen-tutorial')).toBeVisible();
      await expect(phone.getByTestId('tutorial-card')).toBeVisible();
      await expect(phone.getByTestId('btn-gotit')).toBeVisible();
      await shot(phone, p('03-tutorial'));

      // Real touches on DRIFT and ITEM during the tutorial make the avatar react on the host.
      const cdp = await phone.context().newCDPSession(phone);
      const driftC = await center(phone.getByTestId('btn-drift'));
      await touch(cdp, 'touchStart', [{ ...driftC, id: 1 }]);
      await expect.poll(async () => (await phoneState(phone)).lastInput.drift, { timeout: 5_000 }).toBe(true);
      await expect(page.locator('.kp-ack .kp-tryit-sparks')).toHaveCount(1, { timeout: 15_000 });
      await touch(cdp, 'touchEnd', []);
      const itemC = await center(phone.getByTestId('btn-item'));
      await touch(cdp, 'touchStart', [{ ...itemC, id: 2 }]);
      await touch(cdp, 'touchEnd', []);
      await expect(page.locator('.kp-ack .kp-tryit-item')).toHaveCount(1, { timeout: 15_000 });
      await shot(page, `10-host-tutorial-tryit-from-${dev.tag}-laptop.jpg`);

      // The 6 steps auto-advance on a wall-clock timer (6 × 3.8 s ≈ 23 s): on a loaded machine the screenshots
      // + touch checks above can outlast them, so the tutorial may already wait for acks ('ack'). Both are fine:
      // "Got it!" is accepted in either phase. It must not be over yet, though.
      expect(['steps', 'ack']).toContain((await partyState(page)).tutorial?.phase);
      await phone.getByTestId('btn-gotit').tap();
      await shot(phone, p('03-tutorial-gotit'));
      // With a single player, their ack ends the tutorial ~1.2 s later (the host chip may already be gone),
      // so check the session: acked, or already moved on to setup well before the steps would have ended.
      await waitParty(page, `(s.tutorial && s.tutorial.acks.length === 1) || s.screen === 'setup'`, 8_000);
      // Only player acked -> tutorial ends shortly (or the leader can skip).
      await expect.poll(async () => (await phoneState(phone)).screen, { timeout: 40_000 }).toBe('setup');

      // ---------------------------------------------------------------- setup
      await expect(phone.getByTestId('screen-setup')).toBeVisible();
      await phone.getByTestId('mode-single').tap();
      await phone.getByTestId('cc-100').tap();
      await phone.getByTestId('track-dune_drift').tap();
      for (let i = 0; i < 5; i++) {
        if ((await phone.getByTestId('laps-value').innerText()).trim().startsWith('1')) break;
        await phone.getByTestId('btn-laps-minus').tap();
        await sleep(300);
      }
      await waitParty(page, `s.setup.laps === 1 && s.setup.cc === 100 && s.setup.trackId === 'dune_drift' && s.setup.mode === 'single'`, 15_000);
      await expect(phone.getByTestId('btn-start-race')).toBeVisible();
      await shot(phone, p('04-setup'));
      await phone.getByTestId('btn-start-race').tap();

      // ----------------------------------------------------------------- race
      await expect.poll(async () => (await phoneState(phone)).screen, { timeout: 60_000 }).toBe('race');
      await waitEnginePhase(page, ['countdown', 'racing'], 150_000);
      await expect(phone.getByTestId('screen-race')).toBeVisible();
      await shot(phone, p('05-race-countdown'));

      // Layout: all controls visible, inside the viewport, no overlaps, steer zone = left half.
      const ids = ['steer-zone', 'btn-gas', 'btn-drift', 'btn-item', 'btn-brake', 'btn-pause'];
      const boxes: Record<string, { x: number; y: number; width: number; height: number }> = {};
      for (const id of ids) {
        const l = phone.getByTestId(id);
        await expect(l, id).toBeVisible();
        const b = await l.boundingBox();
        expect(b, id).not.toBeNull();
        boxes[id] = b!;
      }
      const sz = boxes['steer-zone'];
      expect(sz.x).toBeLessThanOrEqual(vw * 0.05);
      expect(sz.x + sz.width).toBeGreaterThanOrEqual(vw * 0.45);
      expect(sz.height).toBeGreaterThanOrEqual(vh * 0.6);
      for (const id of ['btn-gas', 'btn-drift', 'btn-item', 'btn-brake']) {
        expect(boxes[id].x, `${id} on the right side`).toBeGreaterThanOrEqual(sz.x + sz.width - 1);
        expect(boxes[id].width, `${id} thumb-sized`).toBeGreaterThanOrEqual(44);
      }
      // The pause button sits in the top strip and may overlap the steer zone's box edge; check buttons pairwise.
      const { 'steer-zone': _sz, ...btns } = boxes;
      checkLayout(btns, vw, vh);
      checkLayout({ 'steer-zone': sz }, vw, vh);

      await waitEnginePhase(page, ['racing'], 150_000);

      // Auto-accelerate is on: wait for drift speed (> 45 % of top speed), then steer with a finger
      // on the left half + hold DRIFT with another finger (multi-touch). Retry if the kart hit a wall.
      const zc = await center(phone.getByTestId('steer-zone'));
      const dc = await center(phone.getByTestId('btn-drift'));
      let drifted = false;
      let sawSteer = false;
      const samples: string[] = [];
      for (let attempt = 0; attempt < 4 && !drifted; attempt++) {
        await expect.poll(async () => (await gameState(page)).karts[0].speed, { timeout: 90_000, intervals: [500] }).toBeGreaterThan(11);
        await touch(cdp, 'touchStart', [{ ...zc, id: 10 }]);
        await touch(cdp, 'touchMove', [{ x: zc.x + 200, y: zc.y, id: 10 }]);
        await touch(cdp, 'touchStart', [{ x: zc.x + 200, y: zc.y, id: 10 }, { ...dc, id: 11 }]);
        await expect
          .poll(async () => {
            const st = await phoneState(phone);
            return st.lastInput.steer > 0.3 && st.lastInput.drift;
          }, { timeout: 10_000 })
          .toBe(true);
        for (let i = 0; i < 60 && !drifted; i++) {
          const k = (await gameState(page)).karts[0];
          if (k.lastSteer > 0.3) sawSteer = true;
          if (i % 5 === 0) samples.push(`a${attempt} spd=${k.speed.toFixed(1)} steer=${k.lastSteer.toFixed(2)} drift=${k.isDrifting} spin=${k.isSpinning}`);
          drifted = k.isDrifting || k.driftStage > 0;
          if (!drifted) await sleep(500);
        }
        if (drifted) await shot(phone, p('05-race-steer-drift'));
        await touch(cdp, 'touchEnd', []);
      }
      test.info().annotations.push({ type: 'drift', description: `host kart drifted from phone touches: ${drifted}` });
      expect(sawSteer, 'host kart receives the phone steering').toBe(true);
      expect(drifted, `host kart drifts while the phone holds DRIFT + steer; samples:\n${samples.join('\n')}`).toBe(true);

      // ITEM tap uses an item on the host.
      await giveItem(page, 0, 'banana');
      await expect.poll(async () => (await phoneState(phone)).screen && (await phone.getByTestId('item-label').innerText()), { timeout: 30_000 }).not.toBe('');
      await shot(phone, p('05-race-item'));
      const used0 = (await gameState(page)).karts[0].itemsUsed;
      await phone.getByTestId('btn-item').tap();
      await expect.poll(async () => (await gameState(page)).karts[0].itemsUsed, { timeout: 30_000 }).toBeGreaterThan(used0);

      // ---------------------------------------------------------------- pause
      await phone.getByTestId('btn-pause').tap();
      await waitParty(page, `s.screen === 'paused' && g.phase === 'paused'`, 20_000);
      await expect.poll(async () => (await phoneState(phone)).screen, { timeout: 15_000 }).toBe('paused');
      await expect(phone.getByTestId('btn-resume')).toBeVisible();
      await expect(phone.getByTestId('btn-restart')).toBeVisible();
      await expect(phone.getByTestId('btn-quit')).toBeVisible();
      await shot(phone, p('06-paused'));
      await phone.getByTestId('btn-resume').tap();
      await waitParty(page, `s.screen === 'race' && g.phase === 'racing'`, 20_000);

      // -------------------------------------------------------------- results
      await finishAll(page);
      await expect.poll(async () => (await phoneState(phone)).screen, { timeout: 60_000 }).toBe('results');
      await expect(phone.getByTestId('results-list')).toBeVisible();
      await expect(phone.getByTestId('results-list')).toContainText(dev.name);
      for (const id of ['btn-next', 'btn-replay', 'btn-track', 'btn-lobby']) await expect(phone.getByTestId(id)).toBeVisible();
      await shot(phone, p('07-results'));
      expect((await partyState(page)).screen).toBe('results');

      // Back to lobby from the phone.
      await phone.getByTestId('btn-lobby').tap();
      await expect.poll(async () => (await phoneState(phone)).screen, { timeout: 20_000 }).toBe('lobby');

      hostErrs.expectNone();
      phoneErrs.expectNone();
    } finally {
      await phone.context().close();
    }
  });
}
