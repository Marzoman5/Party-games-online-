/**
 * Party Hub + Smash Party pre-match flow:
 * 20. Hub shows the QR; 4 bots join once; characters are exclusive; the leader (only) picks
 *     Smash Party -> host game card selected, every phone switches to the Smash game/layout.
 * 21–23. Tutorial (6 steps, advancing, phones mirror) -> leader skip -> sandbox ("try it" on the
 *     training stage: bots' fight inputs move their fighters and damage the dummy) -> "I'm ready"
 *     -> setup (stage select, team pick; non-leader edits ignored).
 */
import { expect, test } from '@playwright/test';
import { BOT_CHARS, BOT_NAMES, collectErrors, hostShots, leaderOf, shot, sleep } from './helpers';
import { endSandbox, hubState, joinBots, startUntilLeaves, observeAndFight, openHub, pickSmash, smashState, waitHub, waitSmashPhase } from './smashHelpers';

test.describe('Party Hub: pick Smash Party, tutorial, sandbox, setup', () => {
  test('QR + 4 bots join once; characters exclusive; leader picks Smash Party; phones switch game', async ({ page }) => {
    test.setTimeout(240_000);
    const errs = collectErrors(page, 'host');
    const room = await openHub(page);
    await expect(page.getByTestId('qr')).toBeVisible();
    await expect(page.getByTestId('room-code')).toContainText(room);
    const set = await joinBots(room, 4);
    try {
      const { bots } = set;
      const ids = bots.map((b) => b.playerId);
      await waitHub(page, `s.players.length === 4 && s.players.every(p => p.connected && p.ready)`, 30_000);

      // A character that is already taken is rejected (same roster for both games).
      bots[1].profile(BOT_NAMES[1], BOT_CHARS[0]);
      await sleep(800);
      expect(bots[1].state?.you?.characterId).toBe(BOT_CHARS[1]);
      expect(bots[1].state?.takenCharacters).toContain(BOT_CHARS[0]);

      // The game picker lists all three games (PARTY RUSH added the third: Party Rush).
      const s0 = await hubState(page);
      expect((s0.games ?? []).map((g) => g.id).sort()).toEqual(['kart', 'rush', 'smash']);
      expect((bots[0].state?.games ?? []).map((g) => g.id).sort()).toEqual(['kart', 'rush', 'smash']);
      await expect(page.getByTestId('game-card-kart')).toBeVisible();
      await expect(page.getByTestId('game-card-smash')).toBeVisible();

      // Start from Kart so the switch is observable, then a non-leader pick is ignored.
      const leader = leaderOf(bots);
      expect(leader.playerId).toBe(ids[0]);
      leader.game('kart');
      await waitHub(page, `s.game === 'kart'`, 20_000);
      bots[2].game('smash');
      await sleep(1000);
      expect((await hubState(page)).game).toBe('kart');

      await pickSmash(page, bots);
      await expect(page.getByTestId('game-card-smash')).toHaveClass(/kp-selected/);
      await expect(page.getByTestId('game-card-kart')).not.toHaveClass(/kp-selected/);
      for (const b of bots) {
        expect(b.state?.game).toBe('smash');
        expect(b.state?.screen).toBe('lobby');
      }
      // Same players, same sockets: nobody rejoined.
      const s1 = await hubState(page);
      expect(s1.players.map((p) => p.playerId)).toEqual(ids);
      expect(bots.every((b) => b.connected && !b.rejoin)).toBe(true);
      expect(new Set(s1.players.map((p) => p.characterId)).size).toBe(4);
      await hostShots(page, '20-host-hub-smash-picked');
      errs.expectNone();
    } finally {
      await set.closeAll();
    }
  });

  test('tutorial advances + phones mirror; skip -> sandbox: fight inputs hit the dummy; ready -> setup: stage + team select', async ({ page }) => {
    test.setTimeout(420_000);
    const errs = collectErrors(page, 'host');
    const room = await openHub(page);
    const set = await joinBots(room, 2);
    try {
      const { bots } = set;
      const leader = leaderOf(bots);
      await pickSmash(page, bots);

      // ---- tutorial
      await startUntilLeaves(leader, 'lobby');
      await Promise.all(bots.map((b) => b.waitForScreen('tutorial', 30_000)));
      await waitHub(page, `s.screen === 'tutorial' && !!s.tutorial && s.tutorial.step === 0`, 20_000);
      await expect(page.getByTestId('screen-tutorial')).toBeVisible();
      // (steps advance every few seconds: on a slow box step 0 may already be over)
      const step = (await hubState(page)).tutorial?.step ?? 0;
      if (step < 5) await expect(page.locator('[data-testid^="tutorial-step-"]').first()).toBeVisible();
      expect(bots[0].state?.tutorial?.total).toBe(6);
      await shot(page, '21-host-smash-tutorial-step0-laptop.jpg');
      await waitHub(page, `s.tutorial && s.tutorial.step >= 1`, 30_000);
      await bots[1].waitFor((b) => (b.state?.tutorial?.step ?? 0) >= 1, 15_000, 'phone tutorial step >= 1');
      // Non-leader skip is ignored; leader skip works.
      bots[1].tutSkip();
      await sleep(800);
      expect((await hubState(page)).screen).toBe('tutorial');
      leader.tutSkip();

      // ---- sandbox
      await Promise.all(bots.map((b) => b.waitForScreen('sandbox', 30_000)));
      await waitHub(page, `s.screen === 'sandbox'`, 20_000);
      await waitSmashPhase(page, ['sandbox'], 120_000);
      const m0 = (await smashState(page))!;
      expect(m0.stageId).toBe('training');
      expect(m0.fighters.filter((f) => f.dummy).length).toBe(1);
      expect(m0.fighters.filter((f) => f.human).length).toBe(2);
      const start = m0.fighters.filter((f) => f.human).map((f) => ({ x: f.x, y: f.y }));

      const obs = observeAndFight(page, bots);
      try {
        // Fight packets drive the fighters...
        await expect
          .poll(async () => {
            const m = await smashState(page);
            return !!m && m.fighters.filter((f) => f.human).some((f, i) => Math.hypot(f.x - start[i].x, f.y - start[i].y) > 0.5);
          }, { timeout: 90_000, intervals: [1000] })
          .toBe(true);
        // ...and the bots beat up the training dummy.
        await waitHub(page, `!!m && m.fighters.some(f => f.dummy && f.damage > 0)`, 180_000);
        await bots[0].waitFor((b) => (b.fight?.dummyDamage ?? 0) > 0, 20_000, 'phone sees dummy damage');
        await shot(page, '22-host-smash-sandbox-laptop.jpg');
      } finally {
        obs.stop();
      }
      test.info().annotations.push({ type: 'brain', description: JSON.stringify(bots.map((b) => b.brainActions)) });

      // "I'm ready": both tap it, leader START (or auto-advance) -> setup.
      bots[1].practiceDone();
      await waitHub(page, `!!s.sandbox && s.sandbox.done.includes('${bots[1].playerId}')`, 20_000);
      bots[0].practiceDone();
      // Everyone is ready -> the hub may move on by itself; otherwise end the sandbox host-side.
      await waitHub(page, `s.screen !== 'sandbox'`, 10_000).catch(() => endSandbox(page));
      await Promise.all(bots.map((b) => b.waitForScreen('setup', 60_000)));
      await waitHub(page, `s.screen === 'setup' && s.game === 'smash'`, 30_000);

      // ---- stage select
      leader.gsetup({ stageId: 'forge' });
      await waitHub(page, `s.gameSetup && s.gameSetup.stageId === 'forge'`, 15_000);
      await expect(page.getByTestId('stage-card-forge')).toHaveClass(/selected/);
      await expect(page.getByTestId('stage-card-skyline')).not.toHaveClass(/selected/);
      await bots[1].waitFor((b) => b.state?.gameSetup?.stageId === 'forge', 10_000, 'phone setup mirrored');
      // Non-leader edits are ignored.
      bots[1].gsetup({ stageId: 'arena' });
      await sleep(800);
      expect((await hubState(page)).gameSetup?.stageId).toBe('forge');
      // The training stage is not pickable.
      leader.gsetup({ stageId: 'training' });
      await sleep(800);
      expect((await hubState(page)).gameSetup?.stageId).not.toBe('training');

      // ---- team pick
      leader.gsetup({ stageId: 'skyline', teams: true });
      await waitHub(page, `s.gameSetup && s.gameSetup.teams === true && s.gameSetup.stageId === 'skyline'`, 15_000);
      bots[0].team(1);
      bots[1].team(0);
      await waitHub(page, `s.players[0].team === 1 && s.players[1].team === 0`, 15_000);
      await bots[0].waitFor((b) => b.state?.you?.team === 1, 10_000, 'phone sees its team');
      await hostShots(page, '23-host-smash-setup');
      errs.expectNone();
    } finally {
      await set.closeAll();
    }
  });
});
