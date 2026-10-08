import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8')) as { version: string };

// Two pages: the HOST game (index.html, served at "/") and the PHONE controller
// (play.html, served at "/play" by the Node server). Everything is bundled so the
// game works on a party Wi-Fi with no internet access.
//
// The same config builds the static GitHub Pages site (scripts/build-static.mjs), which sets
// VITE_TRANSPORT=rtc and a base path such as /Party-games-online-/ via STATIC_BASE.
export default defineConfig({
  base: process.env.STATIC_BASE ?? '/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: { port: 5178, strictPort: false, open: false },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        host: resolve(import.meta.dirname, 'index.html'),
        play: resolve(import.meta.dirname, 'play.html'),
      },
    },
  },
});
