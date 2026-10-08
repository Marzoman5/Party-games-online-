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
/** KP_NO_SERVER=1: don't build/start the servers (pure-Node specs such as tests/smash-combat.spec.ts). */
const NO_SERVER = !!process.env.KP_NO_SERVER;

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
