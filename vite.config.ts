import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Two pages: the HOST game (index.html, served at "/") and the PHONE controller
// (play.html, served at "/play" by the Node server). Everything is bundled so the
// game works on a party Wi-Fi with no internet access.
export default defineConfig({
  base: '/',
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
