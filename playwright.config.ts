import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests: the real production build served by the real Node server.
 * Host pages run in headless Chromium (WebGL via SwiftShader), phones are either
 * bot WebSocket clients (scripts/bots.ts) or real /play pages at mobile viewports.
 */
const PORT = Number(process.env.KP_TEST_PORT ?? 3199);
/** KP_NO_SERVER=1: don't build/start the server (pure-Node specs such as tests/smash-combat.spec.ts). */
const NO_SERVER = !!process.env.KP_NO_SERVER;

export default defineConfig({
  testDir: 'tests',
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    launchOptions: {
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
    },
    trace: 'off',
    screenshot: 'off',
  },
  webServer: NO_SERVER
    ? undefined
    : {
        command: `npm run build && node dist-server/server.mjs --port ${PORT} --no-open --quiet`,
        url: `http://127.0.0.1:${PORT}/api/info`,
        timeout: 180_000,
        reuseExistingServer: false,
      },
});
