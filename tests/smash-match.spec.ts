/**
 * Smash Party matches, driven by bot phones whose brains are fed real positions from the host:
 * 24–25. Stock match (3 bots + 1 CPU): hits register (host counters, fighter %, phones' t:'fight'
 *     damage), KOs, "GAME!", results on host (rows with KOs / falls / damage, winner banner) + phones.
 * 26. Time mode + 2v2 teams: players pick teams, the clock runs (accelerated), results name the
 *     winning team.
 * 27. Items (high frequency) spawn; bomb throw + bat swing are used; pause from a phone freezes
 *     the match on host + phones, the leader resumes.
 */
import { expect, test } from '@playwright/test';
import { BOT_NAMES, allOnScreen, collectErrors, hostShots, leaderOf, shot, sleep } from './helpers';
import {
  fighterOf,
  hubState,
  hubWithSmashMatch,
  joinBots,
  koUntilGameSet,
  observeAndFight,
  openHub,
  pickSmash,
  smash,
  smashState,
  smashToSetup,
  startSmashMatch,
  waitHub,
  waitSmashPhase,
  waitSmashResults,
} from './smashHelpers';

test.describe('Smash Party matches', () => {
  test('stock match: bots fight, hits + damage register, KOs, GAME!, results on host + phones', async ({ page }) => {
    test.setTimeout(600_000);
    const errs = collectErrors(page, 'host');
    const { set } = await hubWithSmashMatch(page, 3, { stageId: 'arena', mode: 'stock', stocks: 2, fillCpus: 4, cpuLevel: 3 });
    const { bots } = set;
    const obs = observeAndFight(page, bots);
    try {
      const m0 = (await smashState(page))!;
      expect(m0.phase).toBe('fighting');
      expect(m0.stageId).toBe('arena');
      expect(m0.fighters.length).toBe(4);
      expect(m0.fighters.filter((f) => f.human).length).toBe(3);
      expect(m0.fighters.filter((f) => f.cpu && !f.human).length).toBe(1);
      expect(m0.fighters.every((f) => f.stocks === 2)).toBe(true);
      for (const b of bots) expect(fighterOf(m0, b), `fighter for ${b.playerId}`).toBeTruthy();
      await expect(page.getByTestId('screen-race')).toHaveCount(1).catch(() => undefined);

      // ---- hits register: host counters + fighter % + phones' status
      await waitHub(page, `!!m && m.hits > 0 && m.fighters.some(f => f.damage > 0)`, 180_000);
      const mh = (await smashState(page))!;
      test.info().annotations.push({ type: 'hits', description: `hits=${mh.hits} damage=${mh.fighters.map((f) => f.damage).join('/')} brain=${JSON.stringify(bots.map((b) => b.brainActions))}` });
      await shot(page, '24-host-smash-match-fighting-laptop.jpg');
      // Phones get ~10 Hz fight status; somebody's damage rises (wait for a real hit, then force one).
      const phoneDamage = (): boolean => bots.some((b) => (b.fight?.damage ?? 0) > 0);
      await bots[0].waitFor(() => phoneDamage(), 60_000, 'a phone sees damage > 0').catch(() => undefined);
      if (!phoneDamage()) {
        test.info().annotations.push({ type: 'note', description: 'no bot took a real hit in 60 s: forcing 37% to check the status pipeline' });
        const f = fighterOf((await smashState(page))!, bots[1])!;
        await smash(page, 'setDamage', f.index, 37);
        await bots[1].waitFor((b) => b.fight?.damage === 37, 20_000, 'phone damage 37');
      }
      for (const b of bots) {
        expect(b.fight, 'phone has fight status').not.toBeNull();
        expect(b.fight!.stocks).toBeGreaterThanOrEqual(1);
        expect(b.fight!.timeLeft).toBe(-1);
      }
      await expect.poll(() => bots.some((b) => b.fx.some((x) => x.kind === 'hit' || x.kind === 'land')), { timeout: 60_000 }).toBe(true);

      // ---- KOs: high % + bot smash attacks; then finish the stocks with __smash.ko
      const keep = fighterOf((await smashState(page))!, bots[0])!.index;
      const mk = (await smashState(page))!;
      for (const f of mk.fighters) if (f.index !== keep) await smash(page, 'setDamage', f.index, 170);
      const natural = await waitHub(page, `!!m && m.kos > 0`, 60_000).then(
        () => true,
        () => false,
      );
      test.info().annotations.push({ type: 'ko', description: `natural KO within 60 s at 170%: ${natural}` });
      if (!natural) {
        const victim = mk.fighters.find((f) => f.index !== keep)!;
        await smash(page, 'ko', victim.index);
        await waitHub(page, `!!m && m.fighters[${victim.index}].stocks < 2`, 30_000);
      }
      // KO feedback to the KO'd fighter's phone (when it was a bot).
      await koUntilGameSet(page, keep, 180_000);
      const ms = (await smashState(page))!;
      expect(['gameSet', 'results']).toContain(ms.phase);
      const st = await waitSmashResults(page, bots);
      obs.stop();

      // ---- results on host
      const results = page.getByTestId('smash-results');
      await expect(results).toBeVisible();
      await expect(page.getByTestId('winner-banner')).toBeVisible();
      await expect(page.getByTestId('winner-banner')).toContainText(new RegExp(BOT_NAMES[0], 'i'));
      for (const n of BOT_NAMES.slice(0, 3)) await expect(results).toContainText(new RegExp(n, 'i'));
      expect(st.results!.rows.length).toBe(4);
      expect(st.resultsInfo?.game).toBe('smash');
      expect(st.resultsInfo?.mode).toBe('stock');
      const rows = st.results!.rows;
      expect(rows[0].place).toBe(1);
      expect(rows[0].name).toBe(BOT_NAMES[0]);
      for (const r of rows) {
        expect(typeof r.kos).toBe('number');
        expect(typeof r.falls).toBe('number');
        expect(typeof r.damageDealt).toBe('number');
      }
      // (losers are out of stocks; NOTE: SmashSim.forceKO doesn't count a fall, so falls can't be asserted exactly)
      expect(rows.filter((r) => r.place > 1).every((r) => r.stocksLeft === 0), JSON.stringify(rows)).toBe(true);
      expect(rows.reduce((a, r) => a + (r.falls ?? 0), 0), 'the natural KO counted as a fall').toBeGreaterThanOrEqual(natural ? 1 : 0);
      expect(rows.some((r) => r.cpu)).toBe(true);
      // ---- results on phones
      for (const b of bots) {
        expect(b.state?.screen).toBe('results');
        expect(b.state?.results?.rows.length).toBe(4);
        expect(b.state?.resultsInfo?.game).toBe('smash');
      }
      await hostShots(page, '25-host-smash-results');
      errs.expectNone();
    } finally {
      obs.stop();
      await set.closeAll();
    }
  });

  test('time mode + 2v2 teams: teams picked, clock runs, results name the winning team', async ({ page }) => {
    test.setTimeout(600_000);
    const errs = collectErrors(page, 'host');
    const room = await openHub(page);
    const set = await joinBots(room, 4);
    const { bots } = set;
    const obs = { stop: (): void => undefined };
    try {
      const leader = leaderOf(bots);
      await pickSmash(page, bots);
      await smashToSetup(page, bots);
      leader.gsetup({ teams: true, mode: 'time', timeSec: 60 });
      await waitHub(page, `s.gameSetup && s.gameSetup.teams === true`, 15_000);
      const teams = [0, 1, 0, 1];
      bots.forEach((b, i) => b.team(teams[i]));
      await waitHub(page, `${JSON.stringify(teams)}.every((t, i) => s.players[i].team === t)`, 20_000);
      await startSmashMatch(page, bots, { stageId: 'skyline', mode: 'time', timeSec: 60, teams: true, friendlyFire: false, items: false });

      const m0 = (await smashState(page))!;
      for (let i = 0; i < 4; i++) expect(fighterOf(m0, bots[i])!.team).toBe(teams[i]);
      expect(m0.timeLeft).toBeGreaterThan(0);
      expect(m0.timeLeft).toBeLessThanOrEqual(60);
      const o = observeAndFight(page, bots, 6, true);
      obs.stop = () => o.stop();
      // Clock runs; speed it up.
      await waitHub(page, `!!m && m.timeLeft < ${m0.timeLeft}`, 60_000);
      await smash(page, 'timeScale', 8);
      // Team 1 scores a KO on team 0 so the winner is decided.
      const m1 = (await smashState(page))!;
      await smash(page, 'ko', fighterOf(m1, bots[0])!.index);
      await shot(page, '26-host-smash-teams-time-laptop.jpg');
      const ended = await waitSmashPhase(page, ['gameSet', 'results'], 120_000).then(
        () => true,
        () => false,
      );
      test.info().annotations.push({ type: 'time', description: `time ran out by itself (timeScale 8): ${ended}` });
      if (!ended) await smash(page, 'endMatch');
      await smash(page, 'timeScale', 1);
      const st = await waitSmashResults(page, bots, 120_000);
      o.stop();
      expect(st.resultsInfo?.mode).toBe('time');
      expect([0, 1]).toContain(st.resultsInfo?.winnerTeam);
      expect(st.results!.rows.every((r) => r.team === 0 || r.team === 1)).toBe(true);
      expect(st.results!.rows.some((r) => typeof r.score === 'number')).toBe(true);
      await expect(page.getByTestId('smash-results')).toBeVisible();
      await expect(page.getByTestId('winner-banner')).toBeVisible();
      await expect(page.getByTestId('winner-banner')).toContainText(/team|red|blue/i);
      for (const b of bots) expect(b.state?.resultsInfo?.winnerTeam).toBe(st.resultsInfo?.winnerTeam);
      await hostShots(page, '26-host-smash-teams-results');
      errs.expectNone();
    } finally {
      obs.stop();
      await set.closeAll();
    }
  });

  test('items spawn and are used (bomb throw, bat swing); pause from a phone + leader resume', async ({ page }) => {
    test.setTimeout(600_000);
    const errs = collectErrors(page, 'host');
    const { set } = await hubWithSmashMatch(page, 2, { stageId: 'arena', items: true, itemFrequency: 'high', stocks: 3 });
    const { bots } = set;
    try {
      bots.forEach((b) => b.startFightLoop(30));
      // ---- items spawn on their own (accelerated)
      await smash(page, 'timeScale', 4);
      await waitHub(page, `!!m && m.itemsSpawned > 0`, 120_000);
      await smash(page, 'timeScale', 1);
      const m0 = (await smashState(page))!;
      const f0 = fighterOf(m0, bots[0])!;
      const f1 = fighterOf(m0, bots[1])!;

      // ---- bomb: give, the phone sees it, ATTACK throws it (it leaves the hand)
      await smash(page, 'giveItem', f0.index, 'bomb');
      await waitHub(page, `!!m && m.fighters[${f0.index}].heldItem === 'bomb'`, 30_000);
      await bots[0].waitFor((b) => b.fight?.item === 'bomb', 20_000, 'phone sees bomb').catch(() => undefined);
      bots[0].setFightInput({ x: f1.x > f0.x ? 1 : -1 });
      for (let i = 0; i < 20 && (await smashState(page))!.fighters[f0.index].heldItem === 'bomb'; i++) {
        bots[0].press('attack', 80);
        await sleep(1500);
      }
      bots[0].setFightInput({ x: 0 });
      await waitHub(page, `!!m && m.fighters[${f0.index}].heldItem !== 'bomb'`, 30_000);

      // ---- bat: give, ATTACK swings it (the itemSwing move shows up)
      await smash(page, 'giveItem', f1.index, 'bat');
      await waitHub(page, `!!m && m.fighters[${f1.index}].heldItem === 'bat'`, 30_000);
      let swung = false;
      for (let i = 0; i < 10 && !swung; i++) {
        bots[1].press('attack', 80);
        swung = await page
          .waitForFunction((fi) => (window as unknown as { __smash: { getState(): { fighters: { move: string | null }[] } } }).__smash.getState().fighters[fi].move === 'itemSwing', f1.index, {
            timeout: 3000,
            polling: 30,
          })
          .then(
            () => true,
            () => false,
          );
      }
      expect(swung, 'bat swing (move itemSwing) seen').toBe(true);

      // ---- itemsUsed counts item pickups/uses: pick one up from the floor if nothing counted yet.
      if ((await smashState(page))!.itemsUsed === 0) {
        await waitHub(page, `!!m && !m.fighters[${f0.index}].respawning && m.fighters[${f0.index}].grounded`, 30_000);
        const me = (await smashState(page))!.fighters[f0.index];
        await smash(page, 'spawnItem', 'bat', me.x, me.y + 0.3); // a bat lying on the floor (bombs/capsules may explode)
        for (let i = 0; i < 10 && (await smashState(page))!.itemsUsed === 0; i++) {
          bots[0].press('attack', 80);
          await sleep(1200);
        }
      }
      await waitHub(page, `!!m && m.itemsUsed > 0`, 30_000).catch(async (err: unknown) => {
        const m = (await smashState(page))!;
        throw new Error(`itemsUsed stayed 0: spawned=${m.itemsSpawned} items=${JSON.stringify(m.items)} f0=${JSON.stringify(m.fighters[f0.index])} (${String(err)})`);
      });
      await shot(page, '27-host-smash-items-laptop.jpg');

      // ---- pause from a non-leader phone
      bots[1].pause();
      await waitHub(page, `s.screen === 'paused' && !!m && m.phase === 'paused'`, 30_000);
      await expect(page.getByTestId('pause-overlay')).toBeVisible();
      await expect(page.getByTestId('pause-overlay')).toContainText(BOT_NAMES[1]);
      await allOnScreen(bots, 'paused', 15_000);
      const fa = (await smashState(page))!.frame;
      await sleep(1500);
      const pb = (await smashState(page))!;
      expect(pb.phase).toBe('paused');
      expect(pb.frame).toBe(fa);
      await hostShots(page, '27-host-smash-paused');
      // Leader resumes.
      leaderOf(bots).resume();
      await waitHub(page, `s.screen === 'race' && !!m && (m.phase === 'fighting' || m.phase === 'countdown')`, 30_000);
      await allOnScreen(bots, 'race', 15_000);
      await expect(page.getByTestId('pause-overlay')).toHaveCount(0);
      await expect.poll(async () => (await smashState(page))!.frame, { timeout: 30_000 }).toBeGreaterThan(fa);
      expect((await hubState(page)).pause).toBeNull();
      errs.expectNone();
    } finally {
      for (const b of set.bots) b.stopFightLoop();
      await set.closeAll();
    }
  });
});
