/**
 * 30. Party Rush — every one of the 10 minigames completes on the real host shell with real bot phones
 *     (scripts/bots.ts Rush brains over the relay) at 1 (the shell adds solo bots up to 3), 4 and 16
 *     players. Per round: a results card whose ranking contains EVERY active participant exactly once,
 *     placement points exactly as the contract says (N..1, ties share the higher value, +2 for 1st),
 *     the all-time board grows by exactly the round's awards, phones get their `res`, zero
 *     `__rush.getState().errors`, zero page errors, and phone messages stay under the 2 KB ceiling.
 */
import { expect, test } from '@playwright/test';
import type { BotPhone } from '../scripts/bots';
import { collectErrors } from './helpers';
import {
  RUSH_GAMES,
  boardTotal,
  closeBots,
  expectContractPoints,
  hostPickRush,
  joinRushBots,
  openRushHost,
  playRound,
  rushSetting,
  rushState,
} from './rushHelpers';

for (const n of [1, 4, 16]) {
  test(`all 10 minigames complete with ${n} bot phone${n > 1 ? 's' : ''}: sane rankings, contract points, no errors`, async ({ page }) => {
    test.setTimeout(20 * 60_000);
    const errs = collectErrors(page, 'host');
    const room = await openRushHost(page);
    await hostPickRush(page);
    await rushSetting(page, 'auto', false); // the test drives every round with forceGame
    let bots: BotPhone[] = [];
    try {
      bots = await joinRushBots(room, n, { skill: 0.6 });
      const summary: string[] = [];
      for (const id of RUSH_GAMES) {
        const before = await rushState(page);
        const t0 = Date.now();
        const st = await playRound(page, id);
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        expect(st.errors, `${id}: shell errors`).toEqual([]);
        expect(st.phase, `${id} ended with a results card (not oops / aborted)`).toBe('results');
        const res = st.lastResults!;
        expect(res.game).toBe(id);
        // Everyone who took part (humans + solo bots) is ranked exactly once.
        const parts = [...st.participants].sort();
        const ranked = res.rows.map((r) => r.id).sort();
        expect(ranked, `${id}: ranking = every active participant`).toEqual(parts);
        const humans = bots.map((b) => b.playerId).sort();
        expect(parts.filter((p) => !p.startsWith('bot:')), `${id}: all ${n} phones took part`).toEqual(humans);
        if (n === 1) expect(parts.filter((p) => p.startsWith('bot:')).length, `${id}: solo bots fill up to 3`).toBe(2);
        else expect(parts.some((p) => p.startsWith('bot:')), `${id}: no solo bots with ${n} humans`).toBe(false);
        expectContractPoints(res.rows, id);
        // The all-time board grows by exactly this round's human awards; bots never appear on it.
        const awarded = res.rows.filter((r) => !r.bot).reduce((a, r) => a + r.pts, 0);
        expect(boardTotal(st), `${id}: board total`).toBe(boardTotal(before) + awarded);
        for (const r of res.rows.filter((x) => !x.bot)) {
          const was = before.players.find((p) => p.id === r.id)?.pts ?? 0;
          const now = st.players.find((p) => p.id === r.id)?.pts;
          expect(now, `${id}: ${r.name} total`).toBe(was + r.pts);
        }
        expect(st.players.filter((p) => !p.bot && !p.id.startsWith('bot:')).every((p) => Number.isFinite(p.pts) && p.st === 'play'), `${id}: nobody went away`).toBe(true);
        // Phones see their own result line.
        await Promise.all(
          bots.map((b) =>
            b.waitForRush((m) => m.ph === 'results' && !!m.res && m.rid === res.rid, 15_000, `${id} result on phone`).then(() => {
              const row = res.rows.find((r) => r.id === b.playerId)!;
              expect(b.rush!.res!.place, `${id}: phone place`).toBe(row.place);
              expect(b.rush!.res!.pts, `${id}: phone pts`).toBe(row.pts);
            }),
          ),
        );
        expect(st.msgBytes.max, 'phone message ≤ 2 KB').toBeLessThanOrEqual(2048);
        summary.push(`${id}: ${secs}s, ${res.rows.length} ranked, winner ${res.rows[0].name} (${res.rows[0].stat}) — "${res.headline}"`);
      }
      console.log(`[rush ${n}p]\n  ${summary.join('\n  ')}`);
      test.info().annotations.push({ type: `rush-${n}p`, description: summary.join(' | ') });
      const fin = await rushState(page);
      expect(fin.errors).toEqual([]);
      expect(fin.roundsPlayed).toBe(RUSH_GAMES.length);
      errs.expectNone();
    } finally {
      await closeBots(bots);
    }
  });
}
