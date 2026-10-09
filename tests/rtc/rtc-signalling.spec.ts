/**
 * R4. Signalling resilience and honest failures:
 *       - PeerJS down: phones still join through the Nostr fallback (and vice versa);
 *       - no signalling service at all: the phone says it seems offline instead of spinning;
 *       - no direct route (UDP blocked, like guest Wi-Fi isolation): the phone says so and suggests
 *         joining the host's Wi-Fi.
 */
import { expect, test } from '@playwright/test';
import { collectErrors } from '../helpers';
import { BASE, NOSTR_URL, PEERJS_URL, joinPhone, launchBlockedBrowser, newPhonePage, nostrEvents, openRtcHost, phoneState, rtcDebug, sigQuery, waitHost, waitPhone } from './rtcHelpers';

test('PeerJS down: host and phone find each other through the Nostr relays', async ({ page, browser }) => {
  const hostErrs = collectErrors(page, 'host');
  const st = await openRtcHost(page, { stub: true, signals: { peerjs: false } });
  expect((await rtcDebug(page))!.status.services).toEqual({ peerjs: false, nostr: true });
  const before = await nostrEvents();
  const phone = await joinPhone(browser, st.joinUrl);
  try {
    expect((await phoneState(phone)).signals).toEqual({ peerjs: false, nostr: true });
    expect(await nostrEvents(), 'offer/answer/candidates went through the relay').toBeGreaterThan(before + 2);
    await waitHost(page, `s.players.length === 1 && s.players[0].connected`);
    // Console noise from the dead PeerJS URL is expected here (connection refused), nothing else.
    expect(hostErrs.errors.filter((e) => !/127\.0\.0\.1:9|ERR_CONNECTION_REFUSED/.test(e))).toEqual([]);
  } finally {
    await phone.context().close();
  }
});

test('host reachable only through Nostr, phone has both: the offer still gets through on the first try', async ({ page, browser }) => {
  // The phone sends its offer through whichever service is up first (often PeerJS, where this host is
  // missing) and replays it to services that come up later, so it must not wait for a second attempt.
  const st = await openRtcHost(page, { stub: true, signals: { peerjs: false } });
  const phone = await newPhonePage(browser);
  try {
    const t0 = Date.now();
    // The phone's Nostr connection comes up 2.5 s after its PeerJS one.
    const late = `${BASE}play/?room=${st.room}&peerjs=${encodeURIComponent(PEERJS_URL)}&nostr=${encodeURIComponent(`${NOSTR_URL}/?delay=2500`)}`;
    await phone.goto(late);
    const s = await waitPhone(phone, `p.connected && !!p.playerId`, 30_000);
    expect(s.signals).toEqual({ peerjs: true, nostr: true });
    expect(Date.now() - t0, 'joined within the first attempt (no answer timeout)').toBeLessThan(11_000);
    await waitHost(page, `s.players.length === 1 && s.players[0].connected`);
  } finally {
    await phone.context().close();
  }
});

test('Nostr down: PeerJS alone is enough', async ({ page, browser }) => {
  const st = await openRtcHost(page, { stub: true, signals: { nostr: false } });
  expect((await rtcDebug(page))!.status.services).toEqual({ peerjs: true, nostr: false });
  const before = await nostrEvents();
  const phone = await joinPhone(browser, st.joinUrl);
  try {
    expect((await phoneState(phone)).signals).toEqual({ peerjs: true, nostr: false });
    expect(await nostrEvents()).toBe(before);
    await waitHost(page, `s.players.length === 1 && s.players[0].connected`);
  } finally {
    await phone.context().close();
  }
});

test('no signalling service reachable: the phone says it looks offline (no endless spinner)', async ({ browser }) => {
  const phone = await newPhonePage(browser);
  try {
    await phone.goto(`${BASE}play/?room=ABCD&${sigQuery({ peerjs: false, nostr: false })}`);
    await waitPhone(phone, `p.error && p.error.code === 'no_signal'`, 30_000);
    await expect(phone.getByTestId('screen-error')).toBeVisible();
    await expect(phone.getByTestId('error-title')).toHaveText(/offline/i);
    await expect(phone.getByTestId('btn-retry')).toBeVisible();
  } finally {
    await phone.context().close();
  }
});

test('host title warns when phones cannot reach it (no signalling)', async ({ page }) => {
  await page.goto(`${BASE}?quality=0&stub=1&${sigQuery({ peerjs: false, nostr: false })}`);
  await waitHost(page, `/^[A-Z]{4}$/.test(s.room) && s.joinService === 'down'`, 60_000);
  await expect(page.locator('.kp-title-status.kp-bad')).toContainText('joining service');
});

test('direct connection blocked: the phone explains and suggests the host Wi-Fi', async ({ page }) => {
  test.setTimeout(120_000);
  const st = await openRtcHost(page, { stub: true });
  const blocked = await launchBlockedBrowser();
  try {
    const phone = await newPhonePage(blocked);
    await phone.goto(st.joinUrl);
    const s = await waitPhone(phone, `p.error && p.error.code === 'no_direct'`, 60_000);
    expect(s.connected).toBe(false);
    await expect(phone.getByTestId('screen-error')).toBeVisible();
    await expect(phone.getByTestId('screen-error')).toContainText('same Wi-Fi');
    await expect(phone.getByTestId('btn-retry')).toBeVisible();
    // The host never got a player out of it.
    expect((await waitHost(page, 'true')).players.length).toBe(0);
  } finally {
    await blocked.close();
  }
});
