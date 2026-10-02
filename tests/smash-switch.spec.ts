/**
 * 29. Party Hub game switching with the SAME players (no rejoin, sockets never closed):
 *     Smash match -> results -> "Switch Game" -> Kart Party (tutorial first time -> skip) -> setup
 *     -> a kart race starts with the same playerIds and finishes -> "Switch Game" back to Smash ->
 *     3 consecutive Smash matches via Rematch, no console errors, renderer memory roughly flat.
 */
import { expect, test } from '@playwright/test';
import { allOnScreen, collectErrors, leaderOf, shot, sleep } from './helpers';
import {
  type SmashDbgState,
  fighterOf,
  hubState,
  hubWithSmashMatch,
  koUntilGameSet,
  observeAndFight,
  smashState,
  smashToSetup,
  startSmashMatch,
  waitHub,
  waitSmashPhase,
  waitSmashResults,
} from './smashHelpers';

test('switch Smash -> Kart -> Smash with the same players; 3 smash rematches without errors or leaks', async ({ page }) => {
  test.setTimeout(1_200_000);
  const errs = collectErrors(page, 'host');
  const { set } = await hubWithSmashMatch(page, 3, { stageId: 'arena', stocks: 1 });
  const { bots } = set;
  const ids = bots.map((b) => b.playerId);
  const sameSockets = (): void => {
    for (const b of bots) {
      expect(b.connected, `${b.playerId} still connected`).toBe(true);
      expect(b.closeCode, `${b.playerId} socket never closed`).toBeNull();
      expect(b.rejoin, `${b.playerId} never rejoined`).toBe(false);
    }
  };
  try {
    const leader = leaderOf(bots);
    // ---- smash match 0 -> results
    const keep0 = fighterOf((await smashState(page))!, bots[0])!.index;
    await koUntilGameSet(page, keep0);
    await waitSmashResults(page, bots);

    // ---- Switch Game -> Kart Party
    leader.post('switch', 'kart');
    await waitHub(page, `s.game === 'kart' && (s.screen === 'tutorial' || s.screen === 'setup')`, 60_000);
    await Promise.all(bots.map((b) => b.waitFor((x) => x.state?.game === 'kart', 20_000, 'phones on kart')));
    if ((await hubState(page)).screen === 'tutorial') {
      await shot(page, '29-host-switch-kart-tutorial-laptop.jpg');
      leader.tutSkip();
    }
    await allOnScreen(bots, 'setup', 30_000);
    await waitHub(page, `s.screen === 'setup' && s.game === 'kart'`, 30_000);
    sameSockets();
    leader.setup({ mode: 'single', laps: 1, cc: 150 });
    await waitHub(page, `s.setup.laps === 1`, 20_000);
    leader.start();
    await allOnScreen(bots, 'race', 120_000);
    await waitHub(page, `!!g && ['countdown', 'racing'].includes(g.phase)`, 180_000);
    const ks = await hubState(page);
    expect(ks.karts).toEqual(ids);
    expect(ks.players.map((p) => p.playerId)).toEqual(ids);
    sameSockets();
    await shot(page, '29-host-switch-kart-race-laptop.jpg');
    bots.forEach((b, i) => b.startAutoDrive(i));
    await sleep(1500);
    await page.evaluate(() => (window as unknown as { __game: { finishAll(): void } }).__game.finishAll());
    await waitHub(page, `s.screen === 'results' && s.racesCompleted >= 1`, 90_000);
    await allOnScreen(bots, 'results', 30_000);
    bots.forEach((b) => b.stopAutoDrive());
    expect((await hubState(page)).results?.rows.length).toBe(8);

    // ---- Switch Game -> back to Smash (tutorial already seen this session)
    leader.post('switch', 'smash');
    await waitHub(page, `s.game === 'smash'`, 60_000);
    await Promise.all(bots.map((b) => b.waitFor((x) => x.state?.game === 'smash', 20_000, 'phones on smash')));
    await smashToSetup(page, bots, 120_000, false);
    sameSockets();

    // ---- 3 consecutive smash matches via Rematch
    const mem: SmashDbgState['memory'][] = [];
    const started: number[] = [];
    await startSmashMatch(page, bots, { stageId: 'skyline', stocks: 1 });
    for (let match = 1; match <= 3; match++) {
      await waitSmashPhase(page, ['fighting'], 180_000);
      const m = (await smashState(page))!;
      mem.push(m.memory);
      started.push(m.matchesStarted);
      expect(m.fighters.filter((f) => f.human).length).toBe(3);
      expect(m.fighters.every((f) => f.stocks === 1 && !f.out)).toBe(true);
      const obs = observeAndFight(page, bots);
      await sleep(3000);
      obs.stop();
      const keep = fighterOf(m, bots[match % 3])!.index;
      await koUntilGameSet(page, keep);
      const keptAlive = !(await smashState(page))!.fighters[keep].out;
      const st = await waitSmashResults(page, bots);
      if (keptAlive) expect(st.results!.rows[0].name).toBe(bots[match % 3].state?.you?.name);
      if (match < 3) {
        leader.post('replay');
        await allOnScreen(bots, 'race', 120_000);
      }
    }
    // matchesStarted counts up by one per rematch.
    expect(started[1]).toBe(started[0] + 1);
    expect(started[2]).toBe(started[0] + 2);
    sameSockets();
    expect((await hubState(page)).players.map((p) => p.playerId)).toEqual(ids);

    test.info().annotations.push({ type: 'memory', description: JSON.stringify(mem) });
    console.log(`[smash memory] match1..3: ${JSON.stringify(mem)}`);
    const [m1, , m3] = mem;
    expect(m3.geometries).toBeLessThanOrEqual(m1.geometries * 1.3 + 30);
    expect(m3.textures).toBeLessThanOrEqual(m1.textures * 1.3 + 8);
    expect(m3.programs).toBeLessThanOrEqual(m1.programs * 1.3 + 8);
    errs.expectNone();
  } finally {
    await set.closeAll();
  }
});
