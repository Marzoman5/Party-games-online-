/**
 * 8. A phone dropping mid-race hands its kart to the AI; reconnecting with the same token
 *    reclaims the same seat/kart (same playerId, AI off, phone back on the race screen).
 */
import { expect, test } from '@playwright/test';
import { BotPhone } from '../scripts/bots';
import { BASE_URL, collectErrors, connectBots, gameState, lobbyToSetup, openHost, partyState, setupToRace, shot, waitParty, waitRacing } from './helpers';

test('disconnect -> AI takes the kart; reconnect with token -> same player reclaims it', async ({ page }) => {
  test.setTimeout(300_000);
  const errs = collectErrors(page, 'host');
  const room = await openHost(page);
  const set = await connectBots(room, 3);
  let back: BotPhone | null = null;
  try {
    const { bots } = set;
    await lobbyToSetup(page, bots);
    await setupToRace(page, bots);
    await waitRacing(page);

    const victim = bots[1];
    const { playerId, token } = victim;
    const kart = (await partyState(page)).karts.indexOf(playerId);
    expect(kart).toBe(1);
    expect((await gameState(page)).karts[kart].aiControlled).toBe(false);

    victim.disconnect();
    await waitParty(page, `g.karts[${kart}].aiControlled === true && s.players.some(p => p.playerId === '${playerId}' && !p.connected)`, 30_000);
    // The race keeps going, others are still human-controlled.
    const g = await gameState(page);
    expect(['racing', 'finished']).toContain(g.phase);
    expect(g.karts[0].aiControlled).toBe(false);
    expect(g.karts[2].aiControlled).toBe(false);
    // AI actually drives it.
    const x0 = g.karts[kart];
    await expect
      .poll(async () => {
        const k = (await gameState(page)).karts[kart];
        return Math.hypot(k.x - x0.x, k.z - x0.z);
      }, { timeout: 60_000 })
      .toBeGreaterThan(1);
    await shot(page, '08-host-race-disconnected-ai-laptop.jpg');

    back = await BotPhone.connect(BASE_URL, room, token, 10_000);
    expect(back.rejoin).toBe(true);
    expect(back.playerId).toBe(playerId);
    await back.waitForScreen('race', 20_000);
    await waitParty(page, `g.karts[${kart}].aiControlled === false && s.players.some(p => p.playerId === '${playerId}' && p.connected)`, 30_000);
    expect((await partyState(page)).karts[kart]).toBe(playerId);
    expect((await partyState(page)).players.length).toBe(3);

    // And its input drives the kart again.
    back.setInput({ throttle: 1, steer: 0.6 });
    back.startDriving(30);
    await expect.poll(async () => Math.round((await gameState(page)).karts[kart].lastSteer * 10) / 10, { timeout: 30_000 }).toBe(0.6);
    back.stopDriving();
    errs.expectNone();
  } finally {
    await set.closeAll();
    await back?.close();
  }
});
