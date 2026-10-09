/**
 * R3. The Node server's reliability guarantees, re-created in the host page for the static site:
 *       - a phone that drops (closed tab, lost Wi-Fi) gets its seat back when it returns;
 *       - reloading the host page keeps the room code, the players and their seats; phones reconnect
 *         on their own;
 *       - a second host tab (duplicated tab) takes the room over, the first shows "opened in another
 *         tab" with a button to take it back, and phones follow the active tab.
 */
import { expect, test } from '@playwright/test';
import { collectErrors } from '../helpers';
import { BASE, hostState, joinPhone, lobbyReady, newPhonePage, openRtcHost, phoneState, sigQuery, toggleReady, waitHost, waitPhone } from './rtcHelpers';

test('phone drops and comes back: same seat (playerId, name) via its saved token', async ({ page, browser }) => {
  const hostErrs = collectErrors(page, 'host');
  const st = await openRtcHost(page, { stub: true });
  const phone = await joinPhone(browser, st.joinUrl);
  try {
    await lobbyReady(phone, 'Dora', 'zippy');
    const { playerId } = await phoneState(phone);
    await waitHost(page, `s.players.length === 1 && s.players[0].ready`);

    // Network drop: close the page (its WebRTC connection dies); the host keeps the seat.
    const ctx = phone.context();
    await phone.close();
    await waitHost(page, `s.players.length === 1 && !s.players[0].connected`, 20_000);

    // Same phone (same browser storage = same token) opens the link again.
    const again = await ctx.newPage();
    await again.goto(st.joinUrl);
    const back = await waitPhone(again, `p.connected && !!p.playerId`, 45_000);
    expect(back.playerId).toBe(playerId);
    await waitHost(page, `s.players.length === 1 && s.players[0].connected && s.players[0].name === 'Dora'`, 20_000);
    hostErrs.expectNone();
  } finally {
    await phone.context().close();
  }
});

test('host reload keeps the room: same code, same players, phones reconnect by themselves', async ({ page, browser }) => {
  const st = await openRtcHost(page, { stub: true });
  const a = await joinPhone(browser, st.joinUrl);
  const b = await joinPhone(browser, st.joinUrl);
  try {
    await lobbyReady(a, 'Ana', 'zippy');
    await lobbyReady(b, 'Ben', 'pixel');
    await waitHost(page, `s.players.length === 2 && s.players.every(p => p.ready)`);
    const ids = [(await phoneState(a)).playerId, (await phoneState(b)).playerId];

    await page.reload();
    const after = await waitHost(page, `s.room === ${JSON.stringify(st.room)} && s.joinService === 'ok' && s.players.length === 2 && s.players.every(p => p.connected)`, 60_000);
    expect(after.room).toBe(st.room);
    expect(after.players.map((p) => p.playerId).sort()).toEqual([...ids].sort());
    expect(after.players.map((p) => p.name).sort()).toEqual(['Ana', 'Ben']);
    // The phones kept their identity (no new seats, no error screen).
    for (const [i, ph] of [a, b].entries()) {
      const s = await waitPhone(ph, `p.connected`, 30_000);
      expect(s.playerId).toBe(ids[i]);
      expect(s.error).toBeNull();
    }
    // A second reload right away (no join in between) still has everyone: the restored room was saved again.
    await page.reload();
    await waitHost(page, `s.room === ${JSON.stringify(st.room)} && s.players.length === 2 && s.players.every(p => p.connected)`, 60_000);
    expect((await hostState(page)).players.map((p) => p.playerId).sort()).toEqual([...ids].sort());
    const errs = collectErrors(page, 'host after reload');
    // Messages flow again after the reload: Ana's ready toggle reaches the new page.
    // Tap only once the phone shows the reloaded host's view (a reload resets READY).
    const was = (await hostState(page)).players.find((p) => p.name === 'Ana')!.ready;
    await waitPhone(a, `p.connected && p.screen === 'lobby' && !!p.you && p.you.ready === ${was}`, 20_000);
    await toggleReady(a, page, 'Ana', !was);
    errs.expectNone();
  } finally {
    await a.context().close();
    await b.context().close();
  }
});

test('second host tab takes the room over; the first can take it back', async ({ page, browser, context }) => {
  const st = await openRtcHost(page, { stub: true });
  const phone = await joinPhone(browser, st.joinUrl);
  try {
    await lobbyReady(phone, 'Tom', 'zippy');
    const { playerId } = await phoneState(phone);
    await waitHost(page, `s.players.length === 1 && s.players[0].ready`);

    // "Duplicate tab": a new tab in the same browser with this tab's session storage.
    const session = await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(sessionStorage))));
    const tab2 = await context.newPage();
    await tab2.addInitScript((s) => {
      if (!sessionStorage.length) for (const [k, v] of Object.entries(JSON.parse(s) as Record<string, string>)) sessionStorage.setItem(k, v);
    }, session);
    await tab2.setViewportSize({ width: 1366, height: 768 });
    await tab2.goto(`${BASE}?quality=0&stub=1&${sigQuery()}`);
    const t2 = await waitHost(tab2, `s.room === ${JSON.stringify(st.room)} && s.joinService === 'ok' && s.players.length === 1 && s.players[0].connected`, 60_000);
    expect(t2.players[0].playerId).toBe(playerId);
    // The first tab stepped down, like with the Node server.
    await waitHost(page, `s.net === 'replaced'`, 20_000);
    await expect(page.locator('.kp-replaced.kp-on')).toBeVisible();
    // The phone is now driven by tab 2 (once it has rejoined it and shows the lobby again).
    // Tap only once the phone shows tab 2's view (it may still display tab 1's READY for a moment).
    const was = (await hostState(tab2)).players[0].ready;
    await waitPhone(phone, `p.connected && p.screen === 'lobby' && !!p.you && p.you.ready === ${was}`, 30_000);
    await toggleReady(phone, tab2, 'Tom', !was);

    // Take it back from the first tab.
    await page.locator('.kp-replaced.kp-on button').first().click();
    await waitHost(page, `s.net === 'open' && s.players.length === 1 && s.players[0].connected && s.players[0].name === 'Tom'`, 60_000);
    await waitHost(tab2, `s.net === 'replaced'`, 20_000);
    expect((await phoneState(phone)).playerId).toBe(playerId);
    expect((await hostState(page)).room).toBe(st.room);
    await tab2.close();
  } finally {
    await phone.context().close();
  }
});

test('a fresh phone with a wrong room code gets "room not found", not an endless spinner', async ({ page, browser }) => {
  await openRtcHost(page, { stub: true });
  const phone = await newPhonePage(browser);
  try {
    await phone.goto(`${BASE}play/?room=ZZZZ&${sigQuery()}`);
    await waitPhone(phone, `p.error && p.error.code === 'no_room'`, 40_000);
    await expect(phone.getByTestId('join-msg')).toContainText('ZZZZ not found');
  } finally {
    await phone.context().close();
  }
});
