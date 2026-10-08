// Builds the static website (GitHub Pages) into dist-static/:
//   - the same two pages as `npm run build`, with the WebRTC transport (VITE_TRANSPORT=rtc): the host
//     page is the room server and phones connect to it directly, so no Node server is needed;
//   - asset URLs under the project path (STATIC_BASE, default /Party-games-online-/);
//   - play/index.html so the phone link is <base>/play/?room=ABCD;
//   - 404.html that turns the typed shortcut <base>/play/ABCD into <base>/play/?room=ABCD
//     (GitHub Pages serves 404.html for unknown paths; no server redirects needed);
//   - .nojekyll so Pages serves the files as they are.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'vite';

const root = resolve(import.meta.dirname, '..');
let base = process.env.STATIC_BASE || '/Party-games-online-/';
if (!base.startsWith('/')) base = `/${base}`;
if (!base.endsWith('/')) base += '/';
const outDir = resolve(root, process.env.STATIC_OUT || 'dist-static');

process.env.STATIC_BASE = base;
process.env.VITE_TRANSPORT = 'rtc';
await build({ root, configFile: resolve(root, 'vite.config.ts'), logLevel: 'warn', build: { outDir, emptyOutDir: true } });

mkdirSync(resolve(outDir, 'play'), { recursive: true });
copyFileSync(resolve(outDir, 'play.html'), resolve(outDir, 'play', 'index.html'));
writeFileSync(resolve(outDir, '.nojekyll'), '');
writeFileSync(
  resolve(outDir, '404.html'),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Party Hub</title>
<style>html,body{margin:0;height:100%;background:#14102a;color:#fff;font-family:system-ui,sans-serif}
main{display:grid;place-items:center;height:100%;text-align:center}a{color:#ffb020}</style>
<script>
  // <base>/play/ABCD (or <base>/ABCD) -> the phone controller for room ABCD; anything else -> the game.
  (function () {
    var base = ${JSON.stringify(base)};
    var path = location.pathname;
    var rest = path.indexOf(base) === 0 ? path.slice(base.length) : path.replace(/^\\//, '');
    var m = rest.match(/^(?:play\\/)?([A-Za-z]{4})\\/?$/);
    location.replace(base + (m ? 'play/?room=' + m[1].toUpperCase() : ''));
  })();
</script>
</head>
<body><main><p>Opening <a href="${base}">Party Hub</a>…</p></main></body>
</html>
`,
);
console.log(`[build:static] ${outDir} (base ${base})`);
