/**
 * Headless CPU-vs-CPU soak test for the Smash Party AI.
 *   npx tsx src/games/smash/sim/ai/dev/aiSoak.ts [--quick] [--seed N] [--measure]
 *
 * Prints match length, KO counts, average KO %, self-destructs per level, recovery success
 * rates per level and the L9-vs-L1 win rate. --measure prints each fighter's up-special reach.
 */
import { SmashSim } from '../../SmashSim';
import { CpuController } from '../CpuController';
import { FIGHTERS } from '../../../roster';
import { PICKABLE_STAGES } from '../../../stages';
import type { FighterView, SimConfig, SimEvent, SimFighterConfig, SimRules } from '../../../types';
import { emptySimInput } from '../../../types';

declare const process: { argv: string[] };
const args = process.argv.slice(2);
const quick = args.includes('--quick');
const seedArg = args.indexOf('--seed');
let seed = seedArg >= 0 ? Number(args[seedArg + 1]) || 1 : 12345;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];

interface LevelStats {
  fighters: number;
  sds: number;
  falls: number;
  recTries: number;
  recOk: number;
  recSelfFail: number;
}
const perLevel: LevelStats[] = [];
for (let i = 0; i <= 9; i++) perLevel.push({ fighters: 0, sds: 0, falls: 0, recTries: 0, recOk: 0, recSelfFail: 0 });

const perChar: Record<string, { tries: number; ok: number; sds: number; falls: number; wins: number; games: number }> = {};
const moveUse: Record<string, number>[] = [];
for (let i = 0; i <= 9; i++) moveUse.push({});
const misc: Record<string, number> = {};
const bump = (o: Record<string, number>, k: string, n = 1) => (o[k] = (o[k] ?? 0) + n);
let totalMatches = 0;
let unfinished = 0;
let errors = 0;
const lengths: number[] = [];
const lengthsHi: number[] = [];
let koCount = 0;
let koPctSum = 0;
let koPctN = 0;
let nanCount = 0;
let thinkTimeMs = 0;
let thinkCalls = 0;

function rules(over: Partial<SimRules>): SimRules {
  return { mode: 'stock', stocks: 3, timeSec: 180, teams: false, friendlyFire: false, items: false, itemFrequency: 'medium', hazards: true, ...over };
}

function mainStage(sim: SmashSim) {
  const p = sim.stage.platforms.find((q) => q.solid && q.ledges) ?? sim.stage.platforms[0];
  return { left: p.x - p.w / 2, right: p.x + p.w / 2, top: p.y };
}

interface Episode {
  active: boolean;
  hitDuring: boolean;
}

function runMatch(stageId: string, levels: number[], r: SimRules, maxSec: number): { winnerLevel: number[]; frames: number; finished: boolean; sim: SmashSim } {
  const fighters: SimFighterConfig[] = levels.map((lv, i) => ({
    characterId: pick(FIGHTERS).id,
    name: `CPU${i + 1}`,
    color: '#fff',
    slot: -1,
    team: r.teams ? i % 2 : i,
    cpuLevel: lv,
  }));
  for (const fc of fighters) perChar[fc.characterId] ??= { tries: 0, ok: 0, sds: 0, falls: 0, wins: 0, games: 0 };
  const cfg: SimConfig = { stageId, fighters, rules: r, seed: Math.floor(rnd() * 1e9) };
  const sim = new SmashSim(cfg);
  sim.go();
  const inputs = fighters.map(() => emptySimInput());
  const ms = mainStage(sim);
  const eps: Episode[] = fighters.map(() => ({ active: false, hitDuring: false }));
  const lastDamage: number[] = fighters.map(() => 0);
  const lastHit: number[] = fighters.map(() => -9999);
  let frames = 0;
  const maxFrames = maxSec * 60;
  while (sim.status !== 'gameSet' && frames < maxFrames) {
    const pre: number[] = sim.fighters.map((f) => f.damage);
    const t0 = performance.now();
    let ev: SimEvent[];
    try {
      ev = sim.step(inputs);
    } catch (e) {
      errors++;
      if (errors < 5) console.error('sim.step threw', e);
      break;
    }
    thinkTimeMs += performance.now() - t0;
    thinkCalls += fighters.length;
    frames++;
    for (const f of sim.fighters) {
      if (!Number.isFinite(f.x) || !Number.isFinite(f.y)) nanCount++;
      lastDamage[f.index] = Number.isFinite(f.damage) ? f.damage : lastDamage[f.index];
    }
    for (const e of ev) {
      if (e.type === 'hit' && !e.shielded && e.victim >= 0) {
        lastHit[e.victim] = frames;
        if (eps[e.victim].active) eps[e.victim].hitDuring = true;
      }
      if (e.type === 'swing' || e.type === 'special') bump(moveUse[levels[e.fighter]], e.move);
      if (e.type === 'dodge') bump(misc, `dodge L${levels[e.fighter] >= 5 ? '5-9' : '1-4'}`);
      if (e.type === 'itemPickup') bump(misc, `pickup ${e.kind}`);
      if (e.type === 'itemThrow') bump(misc, `throw ${e.kind}`);
      if (e.type === 'finalSmash') bump(misc, 'finalSmash');
      if (e.type === 'heal') bump(misc, 'heals');
      if (e.type === 'itemSpawn') bump(misc, `spawn ${e.kind}`);
      if (e.type === 'powerUp') bump(misc, 'powerUp');
      if (e.type === 'grab') bump(misc, 'grab');
      if (e.type === 'throw') bump(misc, `throw ${e.move}`);
      if (e.type === 'ledgeGrab') bump(misc, 'ledgeGrab');
      if (e.type === 'hit' && e.shielded) bump(misc, 'shieldedHits');
      if (e.type === 'hit' && !e.shielded && e.attacker >= 0) {
        const v = sim.fighters[e.victim];
        const offv = v.x < ms.left - 0.2 || v.x > ms.right + 0.2 || v.y < ms.top - 0.5;
        if (offv) bump(misc, `offstage hits by L${levels[e.attacker] >= 7 ? '7-9' : levels[e.attacker] >= 4 ? '4-6' : '1-3'}`);
      }
      if (e.type === 'hit' && e.attacker < 0) bump(misc, e.kind === 'fire' ? `lava hits L${levels[e.victim]}` : 'ownerless hits');
      if (e.type === 'ko') {
        koCount++;
        const pct = pre[e.victim];
        if (Number.isFinite(pct)) {
          koPctSum += pct;
          koPctN++;
        }
        const lv = levels[e.victim];
        perLevel[lv].falls++;
        const pc = perChar[fighters[e.victim].characterId];
        pc.falls++;
        // a real self-destruct: no hit in the last 4 seconds (the sim's KO credit window is
        // shorter than a long tumble, so its `by` alone over-counts SDs)
        if (e.by < 0) bump(misc, 'uncredited KOs');
        if ((e.by < 0 || e.by === e.victim) && frames - lastHit[e.victim] > 240) {
          perLevel[lv].sds++;
          pc.sds++;
        }
        const ep = eps[e.victim];
        if (ep.active) {
          if (!ep.hitDuring) perLevel[lv].recSelfFail++;
          ep.active = false;
        }
      }
    }
    // recovery episodes: a fighter that has control while off stage
    for (const f of sim.fighters) {
      const ep = eps[f.index];
      const lv = levels[f.index];
      if (f.out || f.action === 'ko' || f.respawning) {
        ep.active = false;
        continue;
      }
      const off = !f.grounded && (f.x < ms.left - 0.3 || f.x > ms.right + 0.3) && f.y < ms.top + 3;
      const controllable = !['hitstun', 'thrown', 'ledgeHang', 'grabbed'].includes(f.action) && f.launchSpeed < 0.05;
      if (!ep.active && off && controllable) {
        ep.active = true;
        ep.hitDuring = false;
        perLevel[lv].recTries++;
        perChar[f.characterId].tries++;
      } else if (ep.active && (f.grounded || f.action === 'ledgeHang')) {
        ep.active = false;
        perLevel[lv].recOk++;
        perChar[f.characterId].ok++;
      }
    }
  }
  const finished = sim.status === 'gameSet';
  const res = sim.results();
  const winners = res.filter((q) => q.place === 1).map((q) => levels[q.fighter]);
  for (const q of res) {
    perChar[fighters[q.fighter].characterId].games++;
    if (q.place === 1) perChar[fighters[q.fighter].characterId].wins++;
  }
  for (let i = 0; i < levels.length; i++) perLevel[levels[i]].fighters++;
  return { winnerLevel: winners, frames, finished, sim };
}

function measure(): void {
  // up-special reach from standing on the arena: straight up (x=0) and steered (x=1)
  for (const def of FIGHTERS) {
    const outRow: string[] = [];
    for (const sx of [0, 1]) {
      const cfg: SimConfig = {
        stageId: 'arena',
        fighters: [{ characterId: def.id, name: 'M', color: '#fff', slot: 0, team: 0, cpuLevel: null }],
        rules: rules({ mode: 'time', timeSec: 999 }),
        seed: 1,
      };
      const sim = new SmashSim(cfg);
      sim.go();
      for (let i = 0; i < 30; i++) sim.step([emptySimInput()]);
      const x0 = sim.fighters[0].x;
      const y0 = sim.fighters[0].y;
      let maxH = 0;
      let xAtMax = 0;
      let maxX = 0;
      let framesToMax = 0;
      let left = false;
      for (let i = 0; i < 200; i++) {
        const inp = emptySimInput();
        inp.y = 1;
        inp.x = sx;
        inp.special = i < 30;
        if (i === 0) inp.specialPressed = true;
        sim.step([inp]);
        const f = sim.fighters[0];
        if (f.y - y0 > maxH) {
          maxH = f.y - y0;
          xAtMax = Math.abs(f.x - x0);
          framesToMax = i;
        }
        maxX = Math.max(maxX, Math.abs(f.x - x0));
        if (!f.grounded) left = true;
        if (left && f.grounded) break;
      }
      outRow.push(`x=${sx}: up ${maxH.toFixed(2)} dx@top ${xAtMax.toFixed(2)} maxdx ${maxX.toFixed(2)} f${framesToMax}`);
    }
    const g = def.gravity;
    const dj = (def.doubleJumpVel * def.doubleJumpVel) / (2 * g);
    console.log(`${def.id.padEnd(7)} ${def.archetype.padEnd(10)} dj ${dj.toFixed(2)} | ${outRow.join(' | ')}`);
  }
}

function main(): void {
  if (args.includes('--measure')) {
    measure();
    return;
  }
  const stages = PICKABLE_STAGES.map((s) => s.id);
  const nMain = quick ? 12 : 48;
  const t0 = Date.now();

  // 1) mixed-level free-for-alls (all stages / modes / items / teams)
  for (let m = 0; m < nMain; m++) {
    const stageId = stages[m % stages.length];
    const teams = m % 4 === 3;
    const items = m % 2 === 1;
    const mode = m % 6 === 5 ? 'time' : 'stock';
    const levels = [0, 1, 2, 3].map(() => 1 + Math.floor(rnd() * 9));
    const r = rules({ mode, teams, items, timeSec: 120 });
    const out = runMatch(stageId, levels, r, mode === 'time' ? 200 : 600);
    totalMatches++;
    if (!out.finished) unfinished++;
    lengths.push(out.frames / 60);
  }

  // 2) high-level 4-CPU stock-3 matches (target: usually < 4 min)
  const nHi = quick ? 6 : 18;
  for (let m = 0; m < nHi; m++) {
    const levels = [0, 1, 2, 3].map(() => 5 + Math.floor(rnd() * 5));
    const out = runMatch(stages[m % stages.length], levels, rules({ items: m % 2 === 0 }), 600);
    totalMatches++;
    if (!out.finished) unfinished++;
    lengthsHi.push(out.frames / 60);
  }

  // 3) L9 vs L1 1v1
  const nDuel = quick ? 10 : 40;
  let l9wins = 0;
  for (let m = 0; m < nDuel; m++) {
    const levels = m % 2 === 0 ? [9, 1] : [1, 9];
    const out = runMatch(stages[m % stages.length], levels, rules({ items: false }), 480);
    totalMatches++;
    if (!out.finished) unfinished++;
    if (out.winnerLevel.length === 1 && out.winnerLevel[0] === 9) l9wins++;
  }

  // 3b) level ladder: higher level vs lower level 1v1 win rates
  const ladder: string[] = [];
  for (const [hi, lo] of [[2, 1], [3, 1], [5, 3], [7, 5], [9, 7], [9, 5]]) {
    let w = 0;
    const n = quick ? 6 : 20;
    for (let m = 0; m < n; m++) {
      const levels = m % 2 === 0 ? [hi, lo] : [lo, hi];
      const out = runMatch(stages[m % stages.length], levels, rules({ items: false }), 480);
      totalMatches++;
      if (out.winnerLevel.length === 1 && out.winnerLevel[0] === hi) w++;
    }
    ladder.push(`L${hi}>L${lo} ${((100 * w) / n).toFixed(0)}%`);
  }

  // 4) same-level 1v1s for per-level SD / recovery stats
  const nSame = quick ? 9 : 27;
  for (let m = 0; m < nSame; m++) {
    const lv = 1 + (m % 9);
    runMatch(stages[m % stages.length], [lv, lv], rules({ items: m % 2 === 0 }), 480);
    totalMatches++;
  }

  const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
  console.log(`matches ${totalMatches}  unfinished ${unfinished}  errors ${errors}  AI errors ${CpuController.errors}  NaN ${nanCount}  wall ${(Date.now() - t0) / 1000}s`);
  console.log(`mixed: avg length ${avg(lengths).toFixed(0)}s  median ${med(lengths).toFixed(0)}s`);
  console.log(`L5-9 x4 stock3: avg ${avg(lengthsHi).toFixed(0)}s  median ${med(lengthsHi).toFixed(0)}s  max ${Math.max(0, ...lengthsHi).toFixed(0)}s`);
  console.log(`KOs ${koCount}  avg KO % ${(koPctSum / Math.max(1, koPctN)).toFixed(0)}`);
  console.log(`ladder: ${ladder.join('  ')}`);
  console.log(`L9 vs L1 win rate ${((100 * l9wins) / nDuel).toFixed(0)}% (${l9wins}/${nDuel})`);
  console.log(`sim step (incl. AI) ${(thinkTimeMs / Math.max(1, thinkCalls)).toFixed(4)} ms per fighter-frame`);
  console.log('lvl fighters falls SD  SD/fighter  recTries recOk%  unforcedRecFail');
  for (let i = 1; i <= 9; i++) {
    const s = perLevel[i];
    console.log(
      `L${i}  ${String(s.fighters).padStart(5)} ${String(s.falls).padStart(5)} ${String(s.sds).padStart(3)}  ${(s.sds / Math.max(1, s.fighters)).toFixed(2).padStart(6)}     ${String(s.recTries).padStart(5)}  ${((100 * s.recOk) / Math.max(1, s.recTries)).toFixed(0).padStart(4)}%   ${s.recSelfFail}`,
    );
  }
}

main();
console.log('per character: tries recOk% falls SD win%');
for (const [k, v] of Object.entries(perChar)) console.log(`  ${k.padEnd(7)} ${String(v.tries).padStart(4)} ${((100 * v.ok) / Math.max(1, v.tries)).toFixed(0).padStart(4)}% ${String(v.falls).padStart(4)} ${String(v.sds).padStart(3)} ${((100 * v.wins) / Math.max(1, v.games)).toFixed(0).padStart(4)}%`);
console.log('moves L1:', JSON.stringify(moveUse[1]));
console.log('moves L5:', JSON.stringify(moveUse[5]));
console.log('moves L9:', JSON.stringify(moveUse[9]));
console.log('misc:', JSON.stringify(misc));
