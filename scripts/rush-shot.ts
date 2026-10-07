/**
 * Screenshot a minigame in the dev harness (needs `npx vite --port 5178` running, or pass --base).
 *   npx tsx scripts/rush-shot.ts --game darts --players 16 --at 8 [--heat 2] [--phase results] [--out /tmp/x.png] [--tv]
 * Prints the harness report (ranking) as JSON.
 */
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const arg = (k: string, d?: string): string | undefined => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const base = arg('base', 'http://127.0.0.1:5178')!;
const game = arg('game', 'shake-race')!;
const players = arg('players', '4')!;
const at = arg('at', '6')!;
const heat = arg('heat', '1')!;
const phase = arg('phase', 'play')!;
const out = arg('out', `/tmp/rush-${game}-${players}p-${at}s.png`)!;
const tv = args.includes('--tv');

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: tv ? { width: 1920, height: 1080 } : { width: 1366, height: 768 } });
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[page error]', m.text());
});
page.on('pageerror', (e) => console.log('[page exception]', e.message));
await page.goto(`${base}/src/games/rush/dev/harness.html?game=${game}&players=${players}&at=${at}&heat=${heat}&phase=${phase}&seed=${arg('seed', '7')}`);
await page.waitForFunction(() => (window as unknown as { __harness?: { ready: boolean } }).__harness?.ready === true, null, { timeout: 30000 });
await page.waitForTimeout(300);
await page.screenshot({ path: out });
const report = await page.evaluate(() => (window as unknown as { __harness: { report: unknown } }).__harness.report);
console.log(out);
if (report) console.log(JSON.stringify(report, null, 1).slice(0, 3000));
await browser.close();
