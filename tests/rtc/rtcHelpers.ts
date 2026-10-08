/**
 * Helpers for the WebRTC (static site) end-to-end suite.
 *
 * The host page is the static build served like GitHub Pages under /Party-games-online-/ (see
 * playwright.config.ts, project `rtc`); phones are real /play/ pages in their own browser contexts,
 * connected to the host over WebRTC data channels. Signalling uses local stand-ins
 * (scripts/signal-standins.mjs), selected per page with the `?peerjs=` / `?nostr=` overrides that the
 * host copies into the join link.
 */
import { chromium, expect, type Browser, type CDPSession, type Page } from '@playwright/test';

/** Set by `--project=live`: test the deployed site with the real public signalling services. */
export const LIVE = !!process.env.KP_LIVE_URL;
export const BASE = LIVE ? new URL(process.env.KP_LIVE_URL!).pathname.replace(/\/?$/, '/') : '/Party-games-online-/';
export const SIGNAL_PORT = Number(process.env.KP_SIGNAL_PORT ?? 9199);
export const PEERJS_URL = `ws://127.0.0.1:${SIGNAL_PORT}/peerjs?key=peerjs`;
export const NOSTR_URL = `ws://127.0.0.1:${SIGNAL_PORT + 1}`;
/** Nothing listens here: a signalling service that is "down". */
export const DEAD_URL = 'ws://127.0.0.1:9';

export const LAPTOP = { width: 1366, height: 768 } as const;
export const PHONE_PORTRAIT = { width: 390, height: 844 } as const;
export const PHONE_LANDSCAPE = { width: 844, height: 390 } as const;

export interface Signals {
  /** true = local stand-in (default), false = a dead service, '' = disabled. */
  peerjs?: boolean | '';
  nostr?: boolean | '';
}

export function sigQuery(s: Signals = {}): string {
  if (LIVE) return ''; // the site's own (public) services
  const v = (on: boolean | '' | undefined, url: string): string => (on === '' ? '' : on === false ? DEAD_URL : url);
  return `peerjs=${encodeURIComponent(v(s.peerjs ?? true, PEERJS_URL))}&nostr=${encodeURIComponent(v(s.nostr ?? true, NOSTR_URL))}`;
}

export interface HostState {
  room: string;
  joinUrl: string;
  screen: string;
  net: string;
  transport: string;
  joinService: string;
  players: { playerId: string; name: string; ready: boolean; connected: boolean; isLeader: boolean; characterId: string }[];
}

export interface RtcDebug {
  room: string | null;
  peers: number;
  open: number;
  status: { services: Record<string, boolean>; anyUp: boolean };
  takenOnPeerjs: boolean;
}

type HW = Window & { __party?: { getState(): HostState; rtc(): RtcDebug | null; pickGame(id: string): Promise<boolean>; skipTutorial(): void; skipSandbox(): void } };

export function hostState(page: Page): Promise<HostState> {
  return page.evaluate(() => (window as unknown as HW).__party!.getState());
}

export function rtcDebug(page: Page): Promise<RtcDebug | null> {
  return page.evaluate(() => (window as unknown as HW).__party!.rtc());
}

/** Wait for a JS expression over `s` (host party state) and `r` (RoomServer debug). */
export async function waitHost(page: Page, pred: string, timeout = 30_000): Promise<HostState> {
  await page.waitForFunction(
    (src) => {
      const w = window as unknown as HW;
      if (!w.__party) return false;
      // eslint-disable-next-line no-new-func
      return !!new Function('s', 'r', `return (${src});`)(w.__party.getState(), w.__party.rtc());
    },
    pred,
    { timeout, polling: 200 },
  );
  return hostState(page);
}

export interface RtcHostOpts {
  signals?: Signals;
  /** Lightweight kart stub instead of the real engine (faster; fine unless the test races karts). */
  stub?: boolean;
  query?: string;
}

/** Open a fresh host page of the static site; resolves when the room exists and phones can join. */
export async function openRtcHost(page: Page, opts: RtcHostOpts = {}): Promise<HostState> {
  await page.setViewportSize(LAPTOP);
  const q = ['quality=0', opts.stub ? 'stub=1' : '', sigQuery(opts.signals), opts.query ?? ''].filter(Boolean).join('&');
  await page.goto(`${BASE}?${q}`);
  return waitHost(page, `/^[A-Z]{4}$/.test(s.room) && s.joinService === 'ok'`, 90_000);
}

export interface PhoneDbg {
  connected: boolean;
  conn: string;
  playerId: string;
  room: string;
  screen: string | null;
  view: string;
  hostConnected: boolean;
  error: { code: string; message: string } | null;
  transport: string;
  signals: Record<string, boolean>;
  game: string;
  layout: string;
  lastInput: { steer: number; drift: boolean; itemPresses: number };
  lastFightInput: { attackPresses: number; jumpPresses: number } | null;
  rush: { rid: number; ph: string; me: { st: string } } | null;
  rushSent: { stream: number };
}

export function phoneState(phone: Page): Promise<PhoneDbg> {
  return phone.evaluate(() => (window as unknown as { __phone: { getState(): PhoneDbg } }).__phone.getState());
}

/** Wait for a JS expression over `p` (`__phone.getState()`). */
export async function waitPhone(phone: Page, pred: string, timeout = 30_000): Promise<PhoneDbg> {
  await phone.waitForFunction(
    (src) => {
      const w = window as unknown as { __phone?: { getState(): unknown } };
      if (!w.__phone) return false;
      // eslint-disable-next-line no-new-func
      return !!new Function('p', `return (${src});`)(w.__phone.getState());
    },
    pred,
    { timeout, polling: 150 },
  );
  return phoneState(phone);
}

export async function newPhonePage(browser: Browser, viewport: { width: number; height: number } = PHONE_PORTRAIT): Promise<Page> {
  const proxy = LIVE && process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;
  const ctx = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2, proxy });
  return ctx.newPage();
}

/** Open the host's join link on a new phone page and wait until it has joined. */
export async function joinPhone(browser: Browser, joinUrl: string, viewport?: { width: number; height: number }): Promise<Page> {
  const phone = await newPhonePage(browser, viewport);
  await phone.goto(joinUrl);
  await waitPhone(phone, `p.connected && !!p.playerId`, 45_000);
  return phone;
}

/** Name + racer + ready from the real lobby UI. */
export async function lobbyReady(phone: Page, name: string, char: string): Promise<void> {
  await waitPhone(phone, `p.screen === 'lobby'`, 30_000);
  await phone.getByTestId('name-input').fill(name);
  await phone.getByTestId('name-input').press('Enter');
  await phone.getByTestId(`char-${char}`).tap();
  await expect(phone.getByTestId(`char-${char}`)).toHaveClass(/sel/);
  await phone.getByTestId('btn-ready').tap();
}

export async function tapTouch(cdp: CDPSession, phone: Page, testId: string, id: number, holdMs = 80): Promise<void> {
  const b = await phone.getByTestId(testId).first().boundingBox();
  if (!b) throw new Error(`no box for ${testId}`);
  const pt = { x: b.x + b.width / 2, y: b.y + b.height / 2, id, radiusX: 4, radiusY: 4, force: 1 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt] });
  await new Promise((r) => setTimeout(r, holdMs));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** Messages the Nostr stand-in relayed so far (proves which signalling path carried a join). */
export async function nostrEvents(): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${SIGNAL_PORT + 1}/stats`);
  return ((await res.json()) as { events: number }).events;
}

/**
 * A separate browser whose WebRTC may not use UDP at all (Chromium policy): like a phone on a
 * network that blocks direct connections (guest Wi-Fi client isolation, some carriers).
 */
export function launchBlockedBrowser(): Promise<Browser> {
  return chromium.launch({ args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
