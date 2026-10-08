/**
 * 32. Party Rush roster rules (drop-in / drop-out, "never punish absence"):
 *     - a phone that joins mid-round is 'next' (not in this round) and plays the next one;
 *     - a phone that does nothing for a whole round quietly becomes 'away' (no row, 0 points), and its
 *       next tap (`here`) brings it back; a hidden tab (`away`) is away immediately and leaves the round;
 *     - a disconnect + reconnect with the same token is the same player with the same points;
 *     - a host reload restores the scoreboard (points, rounds) and the loop carries on.
 */
import { expect, test } from '@playwright/test';
import { BotPhone } from '../scripts/bots';
import { BASE_URL, collectErrors } from './helpers';
import {
  closeBots,
  expectContractPoints,
  hostPickRush,
  joinRushBots,
  openRushHost,
  playRound,
  rushCall,
  rushForce,
  rushReady,
  rushSetting,
  rushState,
  waitRush,
} from './rushHelpers';

const stOf = (st: Awaited<ReturnType<typeof rushState>>, id: string): string | undefined => st.players.find((p) => p.id === id)?.st;
const ptsOf = (st: Awaited<ReturnType<typeof rushState>>, id: string): number | undefined => st.players.find((p) => p.id === id)?.pts;

test('mid-round join plays next round; idle round → away, tap → back; hidden tab → away at once', async ({ page }) => {
  test.setTimeout(8 * 60_000);
  const errs = collectErrors(page, 'host');
  const room = await openRushHost(page);
  await hostPickRush(page);
  await rushSetting(page, 'auto', false);
  const bots = await joinRushBots(room, 3);
  let late: BotPhone | null = null;
  try {
    const [a, b, c] = bots;

    // ---- round 1 (Don't Move!, 15 s): a 4th phone joins during play
    expect(await rushForce(page, 'dont-move')).toBe(true);
    const r1 = await waitRush(page, `r.game === 'dont-move' && r.phase === 'intro'`, 15_000);
    await rushCall(page, 'next');
    await waitRush(page, `r.phase === 'play' && r.rid === ${r1.rid}`, 15_000);
    late = await BotPhone.connect(BASE_URL, room, undefined, 10_000);
    await late.waitFor((x) => !!x.state?.you, 20_000, 'late first state');
    await late.waitForRush((m) => m.me.st === 'new', 20_000, 'late: new');
    await rushReady(late, { seed: 99 });
    expect(late.rush!.me.st, 'joined mid-round → next round').toBe('next');
    let st = await rushState(page);
    expect(stOf(st, late.playerId)).toBe('next');
    expect(st.participants).not.toContain(late.playerId);
    expect(late.rush!.s, 'no stream asked from a waiting phone').toBeNull();
    st = await waitRush(page, `r.phase === 'results' && r.lastResults.rid === ${r1.rid}`, 40_000);
    expect(st.lastResults!.rows.map((r) => r.id).sort()).toEqual([a, b, c].map((x) => x.playerId).sort());
    expect(st.lastResults!.rows.some((r) => r.id === late!.playerId)).toBe(false);
    expect(ptsOf(st, late.playerId)).toBe(0);

    // ---- between rounds: the late phone is in; B stops doing anything (phone on the table)
    await rushCall(page, 'next'); // results → scoreboard
    await waitRush(page, `r.phase === 'lobby'`, 10_000);
    await late.waitForRush((m) => m.me.st === 'play', 10_000, 'late: play on the scoreboard');
    const bPts = ptsOf(await rushState(page), b.playerId)!;
    b.rushAway(false); // idle: no act, no stream, no events

    // ---- round 2: late phone plays; B idles the whole round → away (no row, no points)
    st = await playRound(page, 'dont-move');
    expect(st.phase).toBe('results');
    const ids2 = st.lastResults!.rows.map((r) => r.id);
    expect(ids2, 'late joiner plays the next round').toContain(late.playerId);
    expect(ids2, 'idle player is not ranked (never shown as a loser)').not.toContain(b.playerId);
    expectContractPoints(st.lastResults!.rows, 'round 2');
    expect(st.lastResults!.rows.length).toBe(3);
    expect(stOf(st, b.playerId), 'idle for a whole round → away').toBe('away');
    expect(ptsOf(st, b.playerId), 'away keeps its score, no penalty').toBe(bPts);
    await b.waitForRush((m) => m.me.st === 'away', 10_000, 'B: away on the phone');

    // ---- B taps back in (results phase → plays from the next round)
    b.rushHere(true);
    await b.waitForRush((m) => m.me.st === 'next' || m.me.st === 'play', 10_000, 'B back');
    await rushCall(page, 'next');
    await waitRush(page, `r.phase === 'lobby'`, 10_000);
    await waitRush(page, `r.players.find((p) => p.id === ${JSON.stringify(b.playerId)}).st === 'play'`, 10_000);

    // ---- round 3: C hides the tab mid-round → away immediately, leaves the round
    expect(await rushForce(page, 'dont-move')).toBe(true);
    const r3 = await waitRush(page, `r.game === 'dont-move' && r.phase === 'intro'`, 15_000);
    await rushCall(page, 'next');
    await waitRush(page, `r.phase === 'play' && r.rid === ${r3.rid}`, 15_000);
    c.rushAway(true);
    const t0 = Date.now();
    st = await waitRush(page, `r.players.find((p) => p.id === ${JSON.stringify(c.playerId)}).st === 'away'`, 5_000);
    expect(Date.now() - t0, 'hidden tab → away within a second or two').toBeLessThan(3000);
    await c.waitForRush((m) => m.me.st === 'away' && m.s === null, 5_000, 'C: away, no stream asked');
    st = await waitRush(page, `r.phase === 'results' && r.lastResults.rid === ${r3.rid}`, 40_000);
    const ids3 = st.lastResults!.rows.map((r) => r.id);
    expect(ids3).not.toContain(c.playerId);
    expect(ids3.sort()).toEqual([a, b, late].map((x) => x.playerId).sort());
    expectContractPoints(st.lastResults!.rows, 'round 3');

    // ---- C comes back
    c.rushHere(true);
    await c.waitForRush((m) => m.me.st === 'next' || m.me.st === 'play', 10_000, 'C back');
    await rushCall(page, 'next');
    await waitRush(page, `r.phase === 'lobby' && r.players.filter((p) => p.st === 'play').length === 4`, 10_000);
    st = await rushState(page);
    expect(st.errors).toEqual([]);
    expect(new Set(st.players.map((p) => p.id)).size, 'no duplicated rows').toBe(st.players.length);
    errs.expectNone();
  } finally {
    await closeBots(late ? [...bots, late] : bots);
  }
});

test('disconnect + reconnect keeps the score; host reload restores the scoreboard and the loop goes on', async ({ page }) => {
  test.setTimeout(8 * 60_000);
  const errs = collectErrors(page, 'host');
  const room = await openRushHost(page);
  await hostPickRush(page);
  await rushSetting(page, 'auto', false);
  const bots = await joinRushBots(room, 3);
  const extra: BotPhone[] = [];
  try {
    let st = await playRound(page, 'shake-race');
    expect(st.phase).toBe('results');
    const a = bots[0];
    const aId = a.playerId;
    const aPts = ptsOf(st, aId)!;
    expect(aPts).toBeGreaterThan(0);

    // ---- Wi-Fi blip: hard drop, then the same token comes back
    a.disconnect();
    st = await waitRush(page, `r.players.find((p) => p.id === ${JSON.stringify(aId)}).connected === false`, 15_000);
    expect(stOf(st, aId)).toBe('away');
    expect(ptsOf(st, aId)).toBe(aPts);
    const a2 = await BotPhone.connect(BASE_URL, room, a.token, 10_000);
    extra.push(a2);
    bots[0] = a2;
    expect(a2.playerId, 'same token → same player id').toBe(aId);
    expect(a2.rejoin).toBe(true);
    await rushReady(a2, { here: false, seed: 7 });
    await a2.waitForRush((m) => m.me.pts === aPts && (m.me.st === 'play' || m.me.st === 'next'), 15_000, 'A back with its points');
    st = await waitRush(page, `r.players.find((p) => p.id === ${JSON.stringify(aId)}).connected === true`, 10_000);
    expect(ptsOf(st, aId)).toBe(aPts);
    expect(st.players.filter((p) => p.id === aId).length, 'one row, not a ghost + a new one').toBe(1);
    await rushCall(page, 'next');
    await waitRush(page, `r.phase === 'lobby'`, 10_000);

    st = await playRound(page, 'shake-race');
    expect(st.phase).toBe('results');
    const row = st.lastResults!.rows.find((r) => r.id === aId);
    expect(row, 'the reconnected phone plays and scores').toBeTruthy();
    expect(ptsOf(st, aId)).toBe(aPts + row!.pts);

    // ---- host reload: the scoreboard (points, rounds) comes back, phones reattach, the loop goes on
    await rushCall(page, 'next');
    const before = await waitRush(page, `r.phase === 'lobby'`, 10_000);
    const pts = Object.fromEntries(before.players.map((p) => [p.id, p.pts]));
    await page.reload();
    await page.waitForFunction(() => !!(window as unknown as { __rush?: unknown }).__rush && (window as unknown as { __party?: { getState(): { screen: string } } }).__party?.getState().screen === 'race', undefined, { timeout: 60_000, polling: 250 });
    st = await waitRush(page, `r.phase === 'lobby' && r.players.filter((p) => p.connected).length === 3`, 30_000);
    expect(st.roundsPlayed, 'rounds restored').toBe(before.roundsPlayed);
    for (const [id, p] of Object.entries(pts)) expect(ptsOf(st, id), `points of ${id} restored`).toBe(p);
    expect(new Set(st.players.map((p) => p.id)).size).toBe(st.players.length);
    await rushSetting(page, 'auto', false);
    // Phones that never left are playing again without a new tap.
    await waitRush(page, `r.players.filter((p) => p.st === 'play').length === 3`, 15_000);
    st = await playRound(page, 'shake-race');
    expect(st.phase).toBe('results');
    expect(st.lastResults!.rows.length).toBe(3);
    expect(st.roundsPlayed).toBe(before.roundsPlayed + 1);
    expectContractPoints(st.lastResults!.rows, 'after reload');
    expect(st.errors).toEqual([]);
    errs.expectNone();
  } finally {
    await closeBots([...bots, ...extra]);
  }
});
