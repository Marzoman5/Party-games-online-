/**
 * 4. Leader starts a race: 4-way split screen (viewports === 4), countdown/racing.
 * 5. Bots steer, drift and use items; their karts move and react.
 * 6. Pause from a phone -> host overlay + engine paused + phones 'paused'; leader resumes.
 * 7. Race finishes -> results on host + phones; Next Race x3 back-to-back; no page errors;
 *    renderer memory does not grow unboundedly between race 1 and race 3.
 */
import { expect, test } from '@playwright/test';
import {
  type GameDbgState,
  allOnScreen,
  collectErrors,
  connectBots,
  finishAll,
  gameState,
  giveItem,
  hostShots,
  leaderOf,
  lobbyToSetup,
  openHost,
  partyState,
  setupToRace,
  shot,
  sleep,
  waitEnginePhase,
  waitParty,
  waitRacing,
} from './helpers';

test.describe('race', () => {
  test('4-player split screen; bots steer, drift, use items; pause + resume', async ({ page }) => {
    test.setTimeout(420_000);
    const errs = collectErrors(page, 'host');
    const room = await openHost(page);
    const set = await connectBots(room, 4);
    try {
      const { bots } = set;
      await lobbyToSetup(page, bots);
      await setupToRace(page, bots);

      // ---- 4. split screen
      // (the intro flyover is a single full-screen camera; split screen starts at the countdown)
      await waitEnginePhase(page, ['countdown', 'racing'], 120_000);
      const g0 = await gameState(page);
      expect(g0.viewports).toBe(4);
      expect(g0.karts.length).toBe(8);
      expect(g0.karts.filter((k) => k.human).length).toBe(4);
      expect(g0.qualityTier).toBe(0);
      const ps = await partyState(page);
      expect(ps.screen).toBe('race');
      expect(ps.karts).toEqual(bots.map((b) => b.playerId));
      await expect(page.getByTestId('screen-race')).toBeVisible();
      await hostShots(page, '04-host-race-4p-countdown');

      await waitRacing(page);
      const start = await gameState(page);
      expect(start.viewports).toBe(4);

      // ---- 5. bots drive: throttle + opposite steering per bot, then drift, then items
      const steers = [-0.8, 0.8, -0.5, 0.5];
      bots.forEach((b, i) => {
        b.setInput({ throttle: 1, brake: 0, steer: steers[i], drift: false });
        b.startDriving(30);
      });

      // Steering input reaches the engine.
      await expect
        .poll(async () => (await gameState(page)).karts.slice(0, 4).map((k) => Math.round(k.lastSteer * 10) / 10), { timeout: 60_000 })
        .toEqual(steers);

      // Karts move.
      await expect
        .poll(
          async () => {
            const g = await gameState(page);
            return g.karts.slice(0, 4).every((k, i) => Math.hypot(k.x - start.karts[i].x, k.z - start.karts[i].z) > 2);
          },
          { timeout: 90_000, intervals: [1000] },
        )
        .toBe(true);
      const moved = await gameState(page);
      for (let i = 0; i < 4; i++) expect(moved.karts[i].speed).toBeGreaterThan(0);

      // Drift: hold DRIFT with full lock; sample until some human kart is seen drifting.
      bots.forEach((b, i) => b.setInput({ drift: true, steer: i % 2 ? 1 : -1 }));
      const driftSeen = new Set<number>();
      let maxStage = 0;
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline && driftSeen.size < 2) {
        const g = await gameState(page);
        g.karts.slice(0, 4).forEach((k, i) => {
          if (k.isDrifting) driftSeen.add(i);
          maxStage = Math.max(maxStage, k.driftStage);
        });
        await sleep(300);
      }
      expect(driftSeen.size, 'human karts seen drifting').toBeGreaterThan(0);
      test.info().annotations.push({ type: 'drift', description: `drifting karts ${[...driftSeen]}, max driftStage ${maxStage}` });
      // Phones get drift stage in their status packets too.
      bots.forEach((b) => b.setInput({ drift: false, steer: 0 }));

      // Items: give every human a mushroom, tap ITEM, itemsUsed increments.
      const before = (await gameState(page)).karts.slice(0, 4).map((k) => k.itemsUsed);
      for (let i = 0; i < 4; i++) await giveItem(page, i, 'mushroom');
      await expect.poll(async () => (await gameState(page)).karts.slice(0, 4).map((k) => k.item), { timeout: 30_000 }).toEqual(Array(4).fill('mushroom'));
      await bots[0].waitFor((b) => b.race?.item === 'mushroom', 15_000, 'phone sees item');
      for (const b of bots) b.pressItem();
      await expect
        .poll(async () => (await gameState(page)).karts.slice(0, 4).map((k, i) => k.itemsUsed > before[i]), { timeout: 60_000 })
        .toEqual([true, true, true, true]);
      await expect.poll(async () => (await gameState(page)).karts.slice(0, 4).map((k) => k.item), { timeout: 30_000 }).toEqual(Array(4).fill('none'));
      await shot(page, '05-host-race-4p-driving-laptop.jpg');

      // Phones receive race status.
      for (const b of bots) {
        expect(b.race).not.toBeNull();
        expect(b.race!.laps).toBe(1);
        expect(b.race!.place).toBeGreaterThanOrEqual(1);
      }

      // ---- 6. pause from a non-leader phone
      bots[2].pause();
      await waitParty(page, `s.screen === 'paused' && g.phase === 'paused'`, 30_000);
      await expect(page.getByTestId('pause-overlay')).toBeVisible();
      await expect(page.getByTestId('pause-overlay')).toContainText(/Cleo/);
      await allOnScreen(bots, 'paused', 15_000);
      const p = await partyState(page);
      expect(p.pause?.by).toBe('Cleo');
      // Frozen while paused.
      const pa = await gameState(page);
      await sleep(1500);
      const pb = await gameState(page);
      expect(pb.phase).toBe('paused');
      expect(pb.raceTime).toBeCloseTo(pa.raceTime, 3);
      await hostShots(page, '06-host-paused');

      // Leader resumes.
      leaderOf(bots).resume();
      await waitParty(page, `s.screen === 'race' && (g.phase === 'racing' || g.phase === 'countdown')`, 30_000);
      await allOnScreen(bots, 'race', 15_000);
      await expect(page.getByTestId('pause-overlay')).toHaveCount(0);
      const t1 = (await gameState(page)).raceTime;
      await expect.poll(async () => (await gameState(page)).raceTime, { timeout: 30_000 }).toBeGreaterThan(t1);

      for (const b of bots) b.stopDriving();
      errs.expectNone();
    } finally {
      await set.closeAll();
    }
  });

  test('race -> results -> Next Race, 3 races back-to-back, no errors, no leaks', async ({ page }) => {
    test.setTimeout(600_000);
    const errs = collectErrors(page, 'host');
    const room = await openHost(page);
    const set = await connectBots(room, 4);
    try {
      const { bots } = set;
      const leader = leaderOf(bots);
      await lobbyToSetup(page, bots);
      await setupToRace(page, bots, 'sunny_circuit');

      const mem: GameDbgState['memory'][] = [];
      const tracks: string[] = [];
      for (let race = 1; race <= 3; race++) {
        await waitEnginePhase(page, ['countdown', 'racing'], 150_000);
        if (race === 1) await waitRacing(page); // race 1: really start racing before finishing
        const g = await gameState(page);
        expect(g.viewports).toBe(4);
        expect(g.racesStarted).toBe(race);
        mem.push(g.memory);
        tracks.push((await partyState(page)).setup.trackId);
        bots.forEach((b) => b.startAutoDrive(1));
        await sleep(1000);

        await finishAll(page);
        await waitParty(page, `s.screen === 'results' && s.racesCompleted === ${race}`, 60_000);
        await allOnScreen(bots, 'results', 15_000);
        bots.forEach((b) => b.stopAutoDrive());
        const results = page.getByTestId('results');
        await expect(results).toBeVisible();
        for (const name of ['Ana', 'Ben', 'Cleo', 'Dev']) await expect(results).toContainText(name);
        const ps = await partyState(page);
        expect(ps.results?.rows.length).toBe(8);
        expect(bots[0].state?.results?.rows.length).toBe(8);
        expect(ps.engine).toBe('results');
        if (race === 1) {
          await hostShots(page, '07-host-results');
        }
        if (race < 3) {
          leader.post('next');
          await allOnScreen(bots, 'race', 120_000);
        }
      }
      // Next Race advances through tracks.
      expect(new Set(tracks).size).toBe(3);

      // Memory: no unbounded growth from race 1 to race 3 (same 4-view layout; tracks differ a bit).
      test.info().annotations.push({ type: 'memory', description: JSON.stringify(mem) });
      console.log(`[memory] race1..3: ${JSON.stringify(mem)}`);
      const [m1, , m3] = mem;
      expect(m3.geometries).toBeLessThanOrEqual(m1.geometries * 1.5 + 50);
      expect(m3.textures).toBeLessThanOrEqual(m1.textures * 1.5 + 10);
      expect(m3.programs).toBeLessThanOrEqual(m1.programs * 1.5 + 10);

      // Back to the lobby works too.
      leader.post('lobby');
      await allOnScreen(bots, 'lobby', 30_000);
      await waitParty(page, `s.screen === 'lobby' && g.phase === 'demo'`, 60_000);
      errs.expectNone();
    } finally {
      await set.closeAll();
    }
  });
});
