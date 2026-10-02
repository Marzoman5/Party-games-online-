/**
 * Robustness fuzz: random humans (random inputs) + CPUs, random rules, debug-helper abuse
 * (setCpu toggles, forceKO, setDamage, spawn/give items, retire, forceGameSet). Asserts the AI
 * never throws (CpuController.errors) and never outputs NaN.
 *   npx tsx src/games/smash/sim/ai/dev/aiFuzz.ts [matches]
 */
import { SmashSim } from '../../SmashSim';
import { CpuController } from '../CpuController';
import { FIGHTERS } from '../../../roster';
import { STAGES } from '../../../stages';
import type { ItemKind, SimInput } from '../../../types';
import { emptySimInput } from '../../../types';

declare const process: { argv: string[]; exitCode?: number };
const N = Number(process.argv[2] ?? 40);
let seed = 4242;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const ri = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const kinds: ItemKind[] = ['bat', 'bomb', 'food', 'capsule', 'orb'];
let nan = 0;
let simErr = 0;
let thinkMs = 0;
let thinkN = 0;

for (let m = 0; m < N; m++) {
  const stage = STAGES[m % STAGES.length];
  const sandbox = !!stage.training;
  const n = ri(2, 4);
  const fighters = Array.from({ length: n }, (_, i) => ({
    characterId: FIGHTERS[ri(0, FIGHTERS.length - 1)].id,
    name: 'F' + i,
    color: '#fff',
    slot: i,
    team: ri(0, 1),
    cpuLevel: rnd() < 0.6 ? ri(1, 9) : null,
  }));
  if (sandbox) fighters.push({ characterId: 'max', name: 'dummy', color: '#fff', slot: -1, team: 9, cpuLevel: null, dummy: true } as never);
  const sim = new SmashSim({
    stageId: stage.id,
    sandbox,
    fighters,
    rules: { mode: rnd() < 0.5 ? 'stock' : 'time', stocks: ri(1, 3), timeSec: 60, teams: rnd() < 0.5, friendlyFire: rnd() < 0.5, items: rnd() < 0.7, itemFrequency: 'high', hazards: true },
    seed: ri(1, 1e9),
  });
  // shadow controllers: call think() directly to time it and check outputs
  const shadow = fighters.map((_, i) => new CpuController(i, ri(1, 9), ri(1, 1e6)));
  sim.go();
  for (let fr = 0; fr < 60 * 90; fr++) {
    const inputs: SimInput[] = fighters.map(() => {
      const r = emptySimInput();
      r.x = rnd() * 2 - 1;
      r.y = rnd() * 2 - 1;
      r.attackPressed = rnd() < 0.05;
      r.specialPressed = rnd() < 0.03;
      r.jumpPressed = rnd() < 0.03;
      r.shield = rnd() < 0.1;
      r.shieldPressed = rnd() < 0.02;
      r.grabPressed = rnd() < 0.02;
      r.flick = rnd() < 0.2;
      return r;
    });
    if (rnd() < 0.002) sim.setCpu(ri(0, n - 1), rnd() < 0.5 ? null : ri(1, 9));
    if (rnd() < 0.001) sim.forceKO(ri(0, n - 1));
    if (rnd() < 0.002) sim.setDamage(ri(0, n - 1), ri(0, 300));
    if (rnd() < 0.002) sim.spawnItem(kinds[ri(0, 4)]);
    if (rnd() < 0.001) sim.giveItem(ri(0, n - 1), kinds[ri(0, 3)]);
    if (rnd() < 0.0003) sim.retire(ri(0, n - 1));
    try {
      sim.step(inputs);
    } catch (e) {
      simErr++;
      if (simErr < 3) console.error('sim threw', e);
      break;
    }
    const t0 = performance.now();
    for (const c of shadow) {
      const o = c.think(sim);
      for (const v of Object.values(o)) if (typeof v === 'number' && !Number.isFinite(v)) nan++;
    }
    thinkMs += performance.now() - t0;
    thinkN += shadow.length;
    if (sim.status === 'gameSet' && fr > 600 && rnd() < 0.01) break;
  }
  if (m % 7 === 0) sim.forceGameSet();
}
console.log(`fuzz matches ${N}: AI errors ${CpuController.errors}, NaN outputs ${nan}, sim errors ${simErr}, think ${(thinkMs / Math.max(1, thinkN)).toFixed(4)} ms/call`);
if (CpuController.errors || nan) process.exitCode = 1;
