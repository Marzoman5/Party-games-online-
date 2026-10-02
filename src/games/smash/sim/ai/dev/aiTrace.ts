/**
 * Trace one CPU match and print action-time histograms + a compact timeline.
 *   npx tsx src/games/smash/sim/ai/dev/aiTrace.ts [stage] [lvA] [lvB] [charA] [charB] [--items] [--timeline]
 */
import { SmashSim } from '../../SmashSim';
import type { SimConfig } from '../../../types';
import { emptySimInput } from '../../../types';

declare const process: { argv: string[] };
const a = process.argv.slice(2).filter((s) => !s.startsWith('--'));
const flags = process.argv.slice(2).filter((s) => s.startsWith('--'));
const stageId = a[0] ?? 'skyline';
const lvA = Number(a[1] ?? 9);
const lvB = Number(a[2] ?? 9);
const chA = a[3] ?? 'max';
const chB = a[4] ?? 'kai';
const cfg: SimConfig = {
  stageId,
  fighters: [
    { characterId: chA, name: 'A', color: '#f00', slot: -1, team: 0, cpuLevel: lvA },
    { characterId: chB, name: 'B', color: '#00f', slot: -1, team: 1, cpuLevel: lvB },
  ],
  rules: { mode: 'stock', stocks: 3, timeSec: 180, teams: false, friendlyFire: false, items: flags.includes('--items'), itemFrequency: 'high', hazards: true },
  seed: Number(a[5] ?? 7),
};
const sim = new SmashSim(cfg);
sim.go();
const hist: Record<string, number>[] = [{}, {}];
let line = '';
for (let fr = 0; fr < 60 * 300 && sim.status !== 'gameSet'; fr++) {
  const ev = sim.step([emptySimInput(), emptySimInput()]);
  sim.fighters.forEach((f, i) => (hist[i][f.action] = (hist[i][f.action] ?? 0) + 1));
  for (const e of ev) {
    if (e.type === 'ko') console.log(`f${sim.frame} KO victim ${e.victim} by ${e.by} side ${e.side} pct ${sim.fighters[e.victim].damage.toFixed(0)}`);
  }
  if (flags.includes('--timeline') && fr % 15 === 0) {
    line = sim.fighters
      .map((f) => `${f.name}:${f.action}${f.move ? '/' + f.move : ''} (${f.x.toFixed(1)},${f.y.toFixed(1)}) ${f.damage.toFixed(0)}%`)
      .join('   ');
    console.log(`${String(sim.frame).padStart(5)} ${line}`);
  }
}
console.log('frames', sim.frame, 'status', sim.status, 'winner', JSON.stringify(sim.winner));
hist.forEach((h, i) => {
  const tot = Object.values(h).reduce((s, v) => s + v, 0);
  console.log(
    `fighter ${i}:`,
    Object.entries(h)
      .sort((x, y) => y[1] - x[1])
      .map(([k, v]) => `${k} ${((100 * v) / tot).toFixed(1)}%`)
      .join(', '),
  );
});
