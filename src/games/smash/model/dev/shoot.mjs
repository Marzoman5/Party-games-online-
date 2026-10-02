// Usage: node src/games/smash/model/dev/shoot.mjs <outdir> state:frame[:facing] ... [--focus=id] [--team]
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const out = args[0];
const opts = args.filter((a) => a.startsWith('--'));
const shots = args.slice(1).filter((a) => !a.startsWith('--'));
const q = new URLSearchParams({ freeze: '1' });
for (const o of opts) {
  const [k, v] = o.slice(2).split('=');
  q.set(k, v ?? '1');
}
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }).catch(() => chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }));
const page = await browser.newPage({ viewport: { width: 1600, height: 640 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('console:', m.text()); });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto('http://localhost:5191/src/games/smash/model/dev/models.html?' + q.toString());
await page.waitForFunction(() => window.__dev, null, { timeout: 60000 });
for (const s of shots) {
  const [name, frame, facing] = s.split(':');
  await page.evaluate(([n, f, fa]) => window.__dev.show(n, Number(f), fa === '-1' ? -1 : 1), [name, frame ?? '10', facing ?? '1']);
  const file = `${out}/${name}-${frame ?? 10}${facing === '-1' ? 'L' : ''}${q.get('focus') ? '-' + q.get('focus') : ''}.png`;
  await page.screenshot({ path: file });
  console.log(file);
}
const stats = await page.locator('#stats').textContent();
console.log(stats);
await browser.close();
