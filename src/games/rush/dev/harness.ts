/**
 * DEV ONLY (LEAD) — renders one minigame with bot players in the browser, no server/phones needed.
 *   npx vite  →  http://localhost:5178/src/games/rush/dev/harness.html?game=darts&players=8&heat=1
 * Params: game, players (1..16), heat (1..3), seed, touch (0..1), leave (0..1),
 *         at=SECONDS → fast-forward that many seconds synchronously, then render frozen (for screenshots);
 *         phase=count|play|results (with `at`), speed (real-time multiplier).
 * `window.__harness = { ready, report }` for scripts/rush-shot.ts.
 */
import { MINIGAMES } from '../minigames/index';
import { BOTS } from '../bots';
import { createHeadless } from '../headless';
import { drawText } from '../draw';
import { STAGE_H, STAGE_W, type Heat } from '../types';

const q = new URLSearchParams(location.search);
const id = q.get('game') ?? MINIGAMES[0].meta.id;
const def = MINIGAMES.find((m) => m.meta.id === id) ?? MINIGAMES[0];
const players = Math.max(1, Math.min(16, Number(q.get('players') ?? 4)));
const heat = Math.max(1, Math.min(3, Number(q.get('heat') ?? 1))) as Heat;
const at = q.get('at') !== null ? Number(q.get('at')) : null;
const phase = (q.get('phase') ?? 'play') as 'count' | 'play' | 'results';
const speed = Number(q.get('speed') ?? 1);

const sim = createHeadless(def, BOTS[def.meta.id], {
  players,
  heat,
  seed: Number(q.get('seed') ?? 7),
  touchRate: Number(q.get('touch') ?? 0.25),
  leaveRate: Number(q.get('leave') ?? 0),
});

const canvas = document.getElementById('c') as HTMLCanvasElement;
const g = canvas.getContext('2d')!;
const info = document.getElementById('info')!;
const w = window as unknown as { __harness: { ready: boolean; report: unknown } };
w.__harness = { ready: false, report: null };

function frame(t: number, ph: 'count' | 'play' | 'results'): void {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#000';
  g.fillRect(0, 0, canvas.width, canvas.height);
  const s = Math.min(canvas.width / STAGE_W, canvas.height / STAGE_H);
  g.setTransform(s, 0, 0, s, (canvas.width - STAGE_W * s) / 2, (canvas.height - STAGE_H * s) / 2);
  g.save();
  g.beginPath();
  g.rect(0, 0, STAGE_W, STAGE_H);
  g.clip();
  sim.render(g, ph, t, s);
  // fake shell HUD bar so layouts respect it
  g.fillStyle = 'rgba(0,0,0,0.45)';
  g.fillRect(0, 0, STAGE_W, 110);
  drawText(g, `${def.meta.icon} ${def.meta.name.toUpperCase()}`, 40, 55, 52, '#fff', { align: 'left' });
  drawText(g, `${Math.ceil(sim.ctx.timeLeft)}`, STAGE_W - 60, 55, 60, '#fff', { align: 'right' });
  const sh = sim.lastShout;
  if (sh && sim.time - sh.at < 0.9) drawText(g, sh.text, STAGE_W / 2, STAGE_H / 2, 140, sh.color ?? '#fff');
  g.restore();
  info.textContent = `${def.meta.id} players=${players} heat=${heat} t=${sim.time.toFixed(1)}s${sim.over ? ' OVER' : ''}`;
}

if (at !== null) {
  if (phase !== 'count') {
    while (sim.time < at && !sim.over) sim.step(1 / 60);
  }
  if (phase === 'results' || sim.over) w.__harness.report = sim.finish();
  frame(phase === 'count' ? 0 : sim.time, phase);
  w.__harness.ready = true;
} else {
  let last = performance.now();
  let start = last;
  const loop = (now: number): void => {
    const dt = Math.min(0.1, (now - last) / 1000) * speed;
    last = now;
    const ph = now - start < 2400 ? 'count' : sim.over ? 'results' : 'play';
    if (ph === 'play') sim.step(dt);
    if (sim.over && !w.__harness.report) {
      w.__harness.report = sim.finish();
      console.log('[harness] report', w.__harness.report);
    }
    frame((now - start) / 1000, ph);
    w.__harness.ready = true;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
