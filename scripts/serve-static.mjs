// Serves the static site (dist-static/) the way GitHub Pages does, for local preview and the
// WebRTC end-to-end tests: files under the project path (default /Party-games-online-/),
// directory index.html, "/dir" -> "/dir/" redirects, and 404.html (status 404) for unknown paths.
//
//   node scripts/serve-static.mjs [--port 4173] [--dir dist-static] [--base /Party-games-online-/]
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const port = Number(opt('port', process.env.PORT ?? 4173));
const dir = path.resolve(opt('dir', 'dist-static'));
let base = opt('base', process.env.STATIC_BASE ?? '/Party-games-online-/');
if (!base.endsWith('/')) base += '/';

if (!fs.existsSync(path.join(dir, 'index.html'))) {
  console.error(`[serve-static] ${dir}/index.html not found. Run "npm run build:static" first.`);
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.get('/', (_req, res) => res.redirect(302, base));
app.use(base, express.static(dir, { redirect: true, extensions: ['html'] }));
app.use((_req, res) => {
  res.status(404).sendFile(path.join(dir, '404.html'));
});
app.listen(port, '0.0.0.0', () => {
  console.log(`[serve-static] http://localhost:${port}${base}  (${dir})`);
});
