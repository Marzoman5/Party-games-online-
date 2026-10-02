/**
 * 28. Smash Party: a phone dropping mid-match hands its fighter to a CPU (the match keeps going);
 *     reconnecting with the same token reclaims the same fighter (same playerId, CPU off, phone
 *     back on the match screen, its inputs drive the fighter again).
 */
import { expect, test } from '@playwright/test';
import { BotPhone } from '../scripts/bots';
import { BASE_URL, collectErrors, shot } from './helpers';
import { fighterOf, hubState, hubWithSmashMatch, smashState, waitHub } from './smashHelpers';

test('smash: disconnect -> CPU takes the fighter; reconnect with token -> same player reclaims it', async ({ page }) => {
  test.setTimeout(420_000);
  const errs = collectErrors(page, 'host');
  const { room, set } = await hubWithSmashMatch(page, 3, { stageId: 'arena', stocks: 3 });
  let back: BotPhone | null = null;
  try {
    const { bots } = set;
    const victim = bots[1];
    const { playerId, token } = victim;
    const m0 = (await smashState(page))!;
    const fi = fighterOf(m0, victim)!.index;
    expect(m0.fighters[fi].cpu).toBe(false);
    expect(m0.fighters[fi].human).toBe(true);

    victim.disconnect();
    await waitHub(page, `!!m && m.fighters[${fi}].cpu === true && s.players.some(p => p.playerId === '${playerId}' && !p.connected)`, 30_000);
    // The match keeps going; the others are still human-controlled.
    const m1 = (await smashState(page))!;
    expect(m1.phase).toBe('fighting');
    for (const f of m1.fighters) if (f.index !== fi && f.human) expect(f.cpu).toBe(false);
    // The CPU actually plays the fighter (it moves).
    const p0 = { x: m1.fighters[fi].x, y: m1.fighters[fi].y };
    await expect
      .poll(async () => {
        const f = (await smashState(page))!.fighters[fi];
        return Math.hypot(f.x - p0.x, f.y - p0.y);
      }, { timeout: 90_000, intervals: [1000] })
      .toBeGreaterThan(0.3);
    await shot(page, '28-host-smash-disconnected-cpu-laptop.jpg');

    back = await BotPhone.connect(BASE_URL, room, token, 10_000);
    expect(back.rejoin).toBe(true);
    expect(back.playerId).toBe(playerId);
    await back.waitForScreen('race', 20_000);
    await waitHub(page, `!!m && m.fighters[${fi}].cpu === false && s.players.some(p => p.playerId === '${playerId}' && p.connected)`, 30_000);
    expect((await hubState(page)).players.length).toBe(3);
    await back.waitFor((b) => !!b.fight && b.fight.cpu === false, 20_000, 'phone fight status cpu=false');

    // Its inputs drive the fighter again: hold right, then left.
    back.startFightLoop(30);
    const mx = (await smashState(page))!.fighters[fi].x;
    const dir = mx > 0 ? -1 : 1; // walk toward the centre
    back.setFightInput({ x: dir });
    await expect
      .poll(async () => ((await smashState(page))!.fighters[fi].x - mx) * dir, { timeout: 60_000, intervals: [500] })
      .toBeGreaterThan(0.5);
    back.setFightInput({ x: 0 });
    back.stopFightLoop();
    errs.expectNone();
  } finally {
    await set.closeAll();
    await back?.close();
  }
});
