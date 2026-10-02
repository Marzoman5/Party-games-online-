// Bundles the Node server (server/index.ts) into dist-server/server.mjs.
// Runtime npm deps (express, ws, qrcode, selfsigned) stay external.
import { build } from 'esbuild';

await build({
  entryPoints: ['server/index.ts'],
  outfile: 'dist-server/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  packages: 'external',
  sourcemap: false,
  logLevel: 'warning',
});
console.log('[build] server -> dist-server/server.mjs');
