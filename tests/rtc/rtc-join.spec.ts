/**
 * R1. Static site (GitHub Pages layout) with the WebRTC transport: the host page creates a room on its
 *     own (no server), shows an in-browser QR code + the version, the join link lives under the project
 *     path, two phones join over WebRTC, name/racer/ready reach the host and the host's state reaches
 *     the phones. The typed /play/ABCD shortcut works without server redirects (404.html).
 */
import { expect, test } from '@playwright/test';
import { collectErrors, shot } from '../helpers';
import { BASE, hostState, joinPhone, lobbyReady, newPhonePage, openRtcHost, phoneState, rtcDebug, waitHost, waitPhone } from './rtcHelpers';

test('static host: room, QR, version, project-path join link; 2 phones join over WebRTC and ready up', async ({ page, browser }) => {
  const hostErrs = collectErrors(page, 'host');
  const st = await openRtcHost(page, { stub: true });
  expect(st.transport).toBe('rtc');
  expect(st.joinUrl).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:\\d+${BASE}play/\\?room=${st.room}&`));

  const qr = page.getByTestId('qr');
  await expect(qr).toBeVisible();
  await expect.poll(() => qr.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), { timeout: 20_000 }).toBe(true);
  expect(await qr.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
  await expect(page.getByTestId('app-version')).toHaveText(/^v\d+\.\d+\.\d+/);
  await expect(page.getByTestId('room-code')).toHaveText(new RegExp(st.room));
  await shot(page, 'r1-static-host-title-laptop.jpg');

  const a = await joinPhone(browser, st.joinUrl);
  const b = await joinPhone(browser, st.joinUrl);
  const aErrs = collectErrors(a, 'phone A');
  const bErrs = collectErrors(b, 'phone B');
  try {
    const pa = await phoneState(a);
    const pb = await phoneState(b);
    expect(pa.transport).toBe('rtc');
    expect(pa.playerId).not.toBe(pb.playerId);
    expect(pa.room).toBe(st.room);
    await waitHost(page, `s.players.length === 2 && s.players.every(p => p.connected) && r.open === 2`, 20_000);

    await lobbyReady(a, 'Ana', 'zippy');
    await lobbyReady(b, 'Ben', 'pixel');
    await waitHost(page, `s.players.length === 2 && s.players.every(p => p.ready) && s.players.some(p => p.name === 'Ana' && p.characterId === 'zippy') && s.players.some(p => p.name === 'Ben')`, 20_000);
    // Host state flows back: each phone sees both players, and the first one is the leader.
    await waitPhone(a, `p.screen === 'lobby'`);
    await expect(a.getByTestId('player-list')).toContainText('Ben');
    await expect(b.getByTestId('player-list')).toContainText('Ana');
    expect((await hostState(page)).players.find((p) => p.name === 'Ana')?.isLeader).toBe(true);
    await shot(a, 'r1-static-phone-lobby.jpg');

    const dbg = await rtcDebug(page);
    expect(dbg?.status.services).toEqual({ peerjs: true, nostr: true });

    hostErrs.expectNone();
    aErrs.expectNone();
    bErrs.expectNone();
  } finally {
    await a.context().close();
    await b.context().close();
  }
});

test('typed shortcut /play/ABCD and the phone page under the project path (no server redirects)', async ({ page, browser }) => {
  const st = await openRtcHost(page, { stub: true });
  const phone = await newPhonePage(browser);
  try {
    // GitHub Pages serves 404.html for unknown paths; it forwards to the controller for that room.
    const res = await phone.request.get(`${BASE}play/${st.room.toLowerCase()}`);
    expect(res.status()).toBe(404);
    expect(await res.text()).toContain('play/?room=');
    await phone.goto(`${BASE}play/${st.room.toLowerCase()}`);
    await expect(phone).toHaveURL(new RegExp(`${BASE}play/\\?room=${st.room}$`));
    // (No signalling overrides on this URL, so it would use the public services; just check the page.)
    await expect(phone.locator('#phone-app')).toBeAttached();

    // The phone page itself, and room-code entry when there is no ?room.
    await phone.goto(`${BASE}play/`);
    await expect(phone.getByTestId('screen-join')).toBeVisible();
    await expect(phone.getByTestId('app-version')).toHaveText(/^v\d+\.\d+\.\d+/);
    // Anything else unknown goes to the game.
    await phone.goto(`${BASE}nope/deeper`);
    await expect(phone).toHaveURL(new RegExp(`${BASE}$`));
  } finally {
    await phone.context().close();
  }
});
