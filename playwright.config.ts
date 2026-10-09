import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests, two projects:
 *
 *  - `ws`  (tests/*.spec.ts): the real production build served by the real Node server (`npm start`
 *    path). Phones are bot WebSocket clients (scripts/bots.ts) or real /play pages at mobile viewports.
 *  - `rtc` (tests/rtc/*.spec.ts): the static website build (`npm run build:static`) served like GitHub
 *    Pages under its project path, with phones as real browser pages connected over WebRTC. Signalling
 *    goes to local stand-ins (scripts/signal-standins.mjs: a PeerJS server + a Nostr relay), never to
 *    the public services.
 *
 * Host pages run in headless Chromium (WebGL via SwiftShader).
 */
const PORT = Number(process.env.KP_TEST_PORT ?? 3199);
const STATIC_PORT = Number(process.env.KP_STATIC_PORT ?? 4199);
const SIGNAL_PORT = Number(process.env.KP_SIGNAL_PORT ?? 9199);
/**
 * `--project=live` (npm run test:live): the join + per-game WebRTC specs against the DEPLOYED website
 * (KP_LIVE_URL, default the GitHub Pages URL) with the real public signalling services. No local servers.
 */
if (process.argv.includes('--project=live')) process.env.KP_LIVE_URL ||= 'https://marzoman5.github.io/Party-games-online-/';
// (An env var, not argv, decides: test workers re-read this file and inherit the env, not the arguments.)
const LIVE = !!process.env.KP_LIVE_URL;
/** KP_NO_SERVER=1: don't build/start the servers (pure-Node specs such as tests/smash-combat.spec.ts). */
const NO_SERVER = !!process.env.KP_NO_SERVER || LIVE;
/** Behind an outbound proxy (CI sandboxes), browsers must use it for the public site and services. */
const PROXY = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;

const chromiumArgs = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'];

export default defineConfig({
  testDir: 'tests',
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    launchOptions: { args: chromiumArgs },
    trace: 'off',
    screenshot: 'off',
  },
  projects: [
    {
      name: 'ws',
      testIgnore: 'rtc/**',
      use: { baseURL: `http://127.0.0.1:${PORT}` },
    },
    {
      name: 'rtc',
      testDir: 'tests/rtc',
      use: {
        baseURL: `http://127.0.0.1:${STATIC_PORT}`,
        // Two browser contexts on one machine reach each other through host candidates; Chromium
        // would otherwise hide local IPs behind mDNS names that headless Linux can't resolve.
        launchOptions: { args: [...chromiumArgs, '--disable-features=WebRtcHideLocalIpsWithMdns'] },
      },
    },
    ...(!LIVE ? [] : [{
      name: 'live',
      testDir: 'tests/rtc',
      testMatch: /rtc-(join|games)\.spec\.ts/,
      use: {
        baseURL: process.env.KP_LIVE_URL ? new URL(process.env.KP_LIVE_URL).origin : undefined,
        proxy: PROXY,
        // Real public services can misbehave: keep a trace of any failure to see exactly what happened.
        trace: 'retain-on-failure' as const,
        launchOptions: { args: [...chromiumArgs, '--disable-features=WebRtcHideLocalIpsWithMdns'] },
      },
    }]),
  ],
  webServer: NO_SERVER
    ? undefined
    : [
        {
          command: `npm run build && node dist-server/server.mjs --port ${PORT} --no-open --quiet`,
          url: `http://127.0.0.1:${PORT}/api/info`,
          timeout: 180_000,
          reuseExistingServer: false,
        },
        {
          command: `npm run build:static && node scripts/serve-static.mjs --port ${STATIC_PORT}`,
          url: `http://127.0.0.1:${STATIC_PORT}/Party-games-online-/`,
          timeout: 180_000,
          reuseExistingServer: false,
        },
        {
          command: `node scripts/signal-standins.mjs --port ${SIGNAL_PORT}`,
          url: `http://127.0.0.1:${SIGNAL_PORT + 1}/stats`,
          timeout: 30_000,
          reuseExistingServer: false,
        },
      ],
});
