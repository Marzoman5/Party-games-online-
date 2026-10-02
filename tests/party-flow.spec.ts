/**
 * 2. Four bot phones join, pick distinct racers and ready up -> host lobby cards + __party agree.
 * 3. How-to-play: steps advance over time, "Got it!" acks show on the host, then setup.
 *    Separate case: the leader skips the tutorial.
 */
import { expect, test } from '@playwright/test';
import { BOT_CHARS, BOT_NAMES, allOnScreen, collectErrors, connectBots, hostShots, leaderOf, openHost, partyState, shot, waitParty } from './helpers';

test.describe('party flow: lobby + tutorial', () => {
  test('4 bots join, pick distinct racers, ready up -> host shows 4 ready cards', async ({ page }) => {
    const errs = collectErrors(page, 'host');
    const room = await openHost(page);
    const set = await connectBots(room, 4, false);
    try {
      const { bots } = set;
      await waitParty(page, `s.screen === 'lobby' && s.players.length === 4`);
      await expect(page.getByTestId('screen-lobby')).toBeVisible();

      // A racer that is already taken is rejected (stays on its own pick).
      bots[1].profile(BOT_NAMES[1], BOT_CHARS[0]);
      await bots[1].waitFor((b) => (b.state?.takenCharacters ?? []).includes(BOT_CHARS[0]), 10_000, 'taken list');
      await new Promise((r) => setTimeout(r, 500));
      expect(bots[1].state?.you?.characterId).toBe(BOT_CHARS[1]);

      // Not ready yet: cards say so.
      for (let i = 0; i < 4; i++) await expect(page.getByTestId(`player-card-${i}`)).toContainText(BOT_NAMES[i]);
      await expect(page.locator('[data-testid^="player-card-"].kp-ready')).toHaveCount(0);
      await shot(page, '02-host-lobby-picking-laptop.jpg');

      for (const b of bots) b.ready(true);
      await waitParty(page, `s.players.length === 4 && s.players.every(p => p.ready && p.connected)`);

      for (let i = 0; i < 4; i++) {
        const card = page.getByTestId(`player-card-${i}`);
        await expect(card).toBeVisible();
        await expect(card).toHaveClass(/kp-ready/);
        await expect(card).toContainText('READY');
        await expect(card).toContainText(BOT_NAMES[i]);
      }

      const s = await partyState(page);
      expect(s.screen).toBe('lobby');
      expect(s.players.map((p) => p.name)).toEqual([...BOT_NAMES]);
      expect(s.players.map((p) => p.characterId)).toEqual([...BOT_CHARS]);
      expect(new Set(s.players.map((p) => p.characterId)).size).toBe(4);
      expect(new Set(s.players.map((p) => p.slot))).toEqual(new Set([0, 1, 2, 3]));
      expect(s.players.filter((p) => p.isLeader).map((p) => p.playerId)).toEqual([bots[0].playerId]);
      // Phones mirror the same lobby.
      for (const b of bots) {
        expect(b.state?.screen).toBe('lobby');
        expect(b.state?.players.length).toBe(4);
      }
      expect(bots[0].state?.you?.isLeader).toBe(true);

      await hostShots(page, '02-host-lobby-ready');
      errs.expectNone();
    } finally {
      await set.closeAll();
    }
  });

  test('how-to-play plays, steps advance, "Got it!" acks show, then setup', async ({ page }) => {
    const errs = collectErrors(page, 'host');
    const room = await openHost(page);
    const set = await connectBots(room, 4);
    try {
      const { bots } = set;
      const leader = leaderOf(bots);
      leader.start();
      await allOnScreen(bots, 'tutorial');
      await waitParty(page, `s.screen === 'tutorial' && s.tutorial && s.tutorial.step === 0`, 20_000);
      await expect(page.getByTestId('screen-tutorial')).toBeVisible();
      await expect(page.getByTestId('tutorial-step-0')).toBeVisible();
      expect(bots[0].state?.tutorial).toMatchObject({ step: 0, total: 6 });
      await shot(page, '03-host-tutorial-step0-laptop.jpg');

      // Steps advance on their own (3.8 s each).
      await waitParty(page, `s.tutorial && s.tutorial.step >= 1`, 20_000);
      const st = await partyState(page);
      await expect(page.getByTestId(`tutorial-step-${st.tutorial!.step}`)).toBeVisible();
      await bots[0].waitFor((b) => (b.state?.tutorial?.step ?? 0) >= 1, 10_000, 'phone tutorial step >= 1');
      await shot(page, `03-host-tutorial-step-advanced-laptop.jpg`);

      // "Try it": DRIFT during the tutorial makes that player's avatar react on the host.
      bots[1].setInput({ drift: true });
      bots[1].sendInput();
      await expect(page.locator('.kp-ack .kp-tryit-sparks')).toHaveCount(1, { timeout: 10_000 });
      bots[1].setInput({ drift: false });
      bots[1].sendInput();

      // Three players tap "Got it!" early: their check marks appear, the tutorial keeps going.
      for (const b of bots.slice(0, 3)) b.tutOk();
      await waitParty(page, `s.tutorial && s.tutorial.acks.length === 3`, 15_000);
      for (let slot = 0; slot < 3; slot++) {
        await expect(page.locator(`.kp-ack.kp-done [data-testid="tutorial-ack-${slot}"]`)).toBeVisible();
      }
      await expect(page.locator('.kp-ack.kp-done')).toHaveCount(3);
      expect((await partyState(page)).screen).toBe('tutorial');

      // Last step -> "GOT IT" phase, waits for the 4th player.
      await waitParty(page, `s.tutorial && s.tutorial.phase === 'ack'`, 40_000);
      await expect(page.getByTestId('tutorial-gotit')).toBeVisible();
      await hostShots(page, '03-host-tutorial-gotit');
      // (the 10 s ack timeout may have elapsed during the 4K screenshot on a slow CI box)
      const now = await partyState(page);
      if (now.screen === 'tutorial') {
        bots[3].tutOk();
        await expect(page.locator('.kp-ack.kp-done')).toHaveCount(4, { timeout: 10_000 }).catch(() => undefined);
      }

      await waitParty(page, `s.screen === 'setup'`, 20_000);
      await allOnScreen(bots, 'setup');
      await expect(page.getByTestId('screen-setup')).toBeVisible();
      expect((await partyState(page)).tutorial).toBeNull();
      await hostShots(page, '03-host-setup');

      errs.expectNone();
    } finally {
      await set.closeAll();
    }
  });

  test('leader skips the tutorial -> setup immediately', async ({ page }) => {
    const errs = collectErrors(page, 'host');
    const room = await openHost(page);
    const set = await connectBots(room, 2);
    try {
      const { bots } = set;
      const leader = leaderOf(bots);
      leader.start();
      await allOnScreen(bots, 'tutorial');
      await waitParty(page, `s.screen === 'tutorial'`, 10_000);
      // Non-leader skip is ignored.
      bots[1].tutSkip();
      await new Promise((r) => setTimeout(r, 800));
      expect((await partyState(page)).screen).toBe('tutorial');

      const t0 = Date.now();
      leader.tutSkip();
      await allOnScreen(bots, 'setup', 10_000);
      await waitParty(page, `s.screen === 'setup' && s.tutorial === null`, 10_000);
      expect(Date.now() - t0).toBeLessThan(10_000);
      await expect(page.getByTestId('screen-setup')).toBeVisible();

      // Leader edits the setup: host shows it live.
      leader.setup({ laps: 1, cc: 100, trackId: 'neon_nexus' });
      await waitParty(page, `s.setup.laps === 1 && s.setup.cc === 100 && s.setup.trackId === 'neon_nexus'`, 10_000);
      await bots[1].waitFor((b) => b.state?.setup.trackId === 'neon_nexus' && b.state.setup.cc === 100, 10_000, 'setup mirrored');
      // Non-leader cannot edit.
      bots[1].setup({ laps: 5 });
      await new Promise((r) => setTimeout(r, 800));
      expect((await partyState(page)).setup.laps).toBe(1);
      await shot(page, '03-host-setup-after-skip-laptop.jpg');
      errs.expectNone();
    } finally {
      await set.closeAll();
    }
  });
});
