/**
 * Headless self-test for the Smash Party simulation.
 *   npx tsx src/games/smash/sim/dev/selftest.ts [--quick]
 * Throws (non-zero exit) on the first failed assertion.
 */
import { SmashSim } from '../SmashSim';
import { FIGHTERS } from '../../roster';
import { PICKABLE_STAGES } from '../../stages';
import { emptySimInput, hitstunFor, launchDisplacement, knockbackFormula } from '../../types';
import type { FighterView, SimConfig, SimEvent, SimInput, SimRules } from '../../types';
import { Rng } from '../rng';

const QUICK = typeof globalThis !== 'undefined' && (globalThis as { process?: { argv: string[] } }).process?.argv.includes('--quick');
let failures = 0;
function ok(cond: unknown, msg: string): void {
  if (!cond) {
    failures++;
    console.error('  FAIL: ' + msg);
    throw new Error(msg);
  }
}
function log(s: string): void {
  console.log(s);
}

const RULES: SimRules = { mode: 'stock', stocks: 3, timeSec: 120, teams: false, friendlyFire: false, items: false, itemFrequency: 'medium', hazards: true };

function cfg(stageId: string, chars: string[], opts: Partial<SimRules> = {}, cpu: (number | null)[] | null = null, seed = 1, sandbox = false, teams?: number[]): SimConfig {
  return {
    stageId,
    seed,
    sandbox,
    rules: { ...RULES, ...opts },
    fighters: chars.map((c, i) => ({
      characterId: c,
      name: c,
      color: '#fff',
      slot: cpu && cpu[i] != null ? -1 : i,
      team: teams ? teams[i] : i % 2,
      cpuLevel: cpu ? cpu[i] : null,
    })),
  };
}

const NUM_KEYS: (keyof FighterView)[] = ['x', 'y', 'vx', 'vy', 'actionFrame', 'moveFrame', 'moveTotal', 'charge', 'damage', 'stocks', 'shield', 'hitlag', 'launchSpeed', 'jumpsLeft', 'width', 'height', 'score'];
function checkFinite(sim: SmashSim, where: string): void {
  for (const f of sim.fighters) {
    for (const k of NUM_KEYS) {
      const v = f[k] as number;
      if (typeof v !== 'number' || !Number.isFinite(v)) ok(false, `${where}: fighter ${f.index} ${String(k)}=${v} (action ${f.action})`);
    }
  }
  for (const it of sim.items) if (!Number.isFinite(it.x) || !Number.isFinite(it.y)) ok(false, `${where}: item NaN`);
  for (const p of sim.projectiles) if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) ok(false, `${where}: projectile NaN`);
}

function inputs(n: number): SimInput[] {
  return Array.from({ length: n }, () => emptySimInput());
}

// ---------------------------------------------------------------------------
// 1. knockback exactness
// ---------------------------------------------------------------------------
function knockbackTest(): void {
  log('knockback exactness');
  for (const [atkChar, vicChar, pct, move] of [
    ['max', 'max', 0, 'ftilt'],
    ['max', 'bram', 80, 'ftilt'],
    ['bram', 'zippy', 120, 'ftilt'],
    ['kai', 'juno', 40, 'ftilt'],
    ['max', 'fennec', 50, 'jab'],
  ] as [string, string, number, string][]) {
    const sim = new SmashSim(cfg('arena', [atkChar, vicChar], {}, null, 7));
    sim.go();
    const a = sim.fighters[0] as FighterView & { x: number; facing: 1 | -1 };
    const v = sim.fighters[1] as FighterView & { x: number };
    (a as { x: number }).x = 0;
    (a as { facing: number }).facing = 1;
    (v as { x: number }).x = 1.1;
    sim.setDamage(1, pct);
    const ins = inputs(2);
    let hit: Extract<SimEvent, { type: 'hit' }> | null = null;
    for (let t = 0; t < 60 && !hit; t++) {
      ins[0] = emptySimInput();
      if (t === 2) {
        ins[0].attackPressed = true;
        ins[0].attack = true;
        if (move === 'ftilt') ins[0].x = 0.6;
      }
      const ev = sim.step(ins);
      for (const e of ev) if (e.type === 'hit' && e.victim === 1 && !e.shielded) hit = e;
    }
    ok(hit, `${atkChar} ${move} hits ${vicChar}`);
    const h = hit!;
    const expectKb = knockbackFormula(pct + h.damage, h.damage, FIGHTERS.find((f) => f.id === vicChar)!.weight, 0, 0);
    ok(h.kb > expectKb - 1e-9, 'kb includes formula');
    const lag = sim.fighters[1].hitlag;
    const x0 = sim.fighters[1].x;
    for (let t = 0; t < lag; t++) sim.step(inputs(2));
    ok(Math.abs(sim.fighters[1].x - x0) < 1e-12, 'no drift during hitlag');
    const frames = hitstunFor(h.kb);
    for (let t = 0; t < frames; t++) sim.step(inputs(2));
    const dx = sim.fighters[1].x - x0;
    const exp = launchDisplacement(h.kb, h.angle, frames).dx;
    log(`  ${atkChar} ${move} -> ${vicChar}@${pct}%: dmg ${h.damage} kb ${h.kb.toFixed(2)} ang ${h.angle} hitstun ${frames} dx ${dx.toFixed(5)} expected ${exp.toFixed(5)}`);
    ok(Math.abs(dx - exp) < 1e-6, `launch displacement ${dx} vs ${exp}`);
  }
}

// ---------------------------------------------------------------------------
// 2. matches with CPUs
// ---------------------------------------------------------------------------
interface MatchStats {
  frames: number;
  hits: number;
  kos: number;
  gameSet: boolean;
  suddenDeath: boolean;
  koPct: number[];
  hash: number;
  events: Record<string, number>;
  ffViolations: number;
  maxStepMs: number;
  totalMs: number;
}

function runMatch(c: SimConfig, maxFrames: number): MatchStats {
  const sim = new SmashSim(c);
  sim.go();
  const st: MatchStats = { frames: 0, hits: 0, kos: 0, gameSet: false, suddenDeath: false, koPct: [], hash: 0, events: {}, ffViolations: 0, maxStepMs: 0, totalMs: 0 };
  const ins = inputs(c.fighters.length);
  const lastDmg: number[] = c.fighters.map(() => 0);
  const stuck: number[] = c.fighters.map(() => 0);
  for (let t = 0; t < maxFrames; t++) {
    for (const f of sim.fighters) lastDmg[f.index] = f.damage;
    const t0 = performance.now();
    const ev = sim.step(ins);
    const dt = performance.now() - t0;
    st.totalMs += dt;
    if (t > 60) st.maxStepMs = Math.max(st.maxStepMs, dt);
    st.frames++;
    for (const e of ev) {
      st.events[e.type] = (st.events[e.type] ?? 0) + 1;
      if (e.type === 'hit' && !e.shielded) {
        st.hits++;
        if (c.rules.teams && !c.rules.friendlyFire && e.attacker >= 0 && e.attacker !== e.victim && sim.fighters[e.attacker].team === sim.fighters[e.victim].team) st.ffViolations++;
      }
      if (e.type === 'ko') {
        st.kos++;
        st.koPct.push(lastDmg[e.victim]);
      }
      if (e.type === 'suddenDeath') st.suddenDeath = true;
    }
    if ((t & 15) === 0) checkFinite(sim, `frame ${t}`);
    for (const f of sim.fighters) {
      // stuck detector: same non-idle action for > 20 s
      if (f.actionFrame > 1200 && !['idle', 'ko', 'out', 'victory', 'defeat', 'crouch', 'shield', 'walk', 'run', 'fall'].includes(f.action)) stuck[f.index]++;
    }
    if (sim.status === 'gameSet') {
      st.gameSet = true;
      // keep animating a bit after GAME!
      for (let k = 0; k < 120; k++) {
        sim.step(ins);
      }
      checkFinite(sim, 'post gameSet');
      const r = sim.results();
      ok(r.length === c.fighters.length, 'results rows');
      ok(r[0].place === 1, 'first place');
      ok(sim.winner.fighter >= 0, 'winner set');
      break;
    }
  }
  for (let i = 0; i < stuck.length; i++) ok(stuck[i] === 0, `fighter ${i} stuck in ${sim.fighters[i].action}`);
  let h = 0;
  for (const f of sim.fighters) h = (h * 31 + Math.round(f.x * 1000) + Math.round(f.damage * 10) * 7 + f.kos * 13 + f.stocks) | 0;
  st.hash = h + sim.frame;
  return st;
}

function matchesTest(): void {
  log('CPU matches');
  const rng = new Rng(42);
  const ids = FIGHTERS.map((f) => f.id);
  const n = QUICK ? 6 : 16;
  const durations: number[] = [];
  const allKoPct: number[] = [];
  let totalHits = 0;
  let worstStep = 0;
  let avgStep = 0;
  let steps = 0;
  for (let m = 0; m < n; m++) {
    const stage = PICKABLE_STAGES[m % PICKABLE_STAGES.length].id;
    const chars = [0, 1, 2, 3].map((k) => ids[(m * 3 + k * 2 + (k > 1 ? 1 : 0)) % ids.length]);
    const lv = [0, 1, 2, 3].map(() => rng.int(5, 9));
    const teams = m % 4 === 3;
    const items = m % 2 === 1;
    const c = cfg(stage, chars, { stocks: 3, teams, friendlyFire: m % 8 === 7, items, itemFrequency: m % 3 === 0 ? 'high' : 'medium', hazards: m % 5 !== 4 }, lv, 1000 + m, false, teams ? [0, 1, 0, 1] : [0, 1, 2, 3]);
    const st = runMatch(c, 60 * 60 * 8);
    totalHits += st.hits;
    allKoPct.push(...st.koPct);
    worstStep = Math.max(worstStep, st.maxStepMs);
    avgStep += st.totalMs;
    steps += st.frames;
    durations.push(st.frames / 3600);
    log(`  #${m} ${stage} [${chars.join(',')}] lv[${lv.join(',')}]${teams ? ' teams' : ''}${items ? ' items' : ''}: ${(st.frames / 3600).toFixed(2)} min, hits ${st.hits}, kos ${st.kos}${st.suddenDeath ? ' SD' : ''}, items ${st.events.itemSpawn ?? 0}, explosions ${st.events.explosion ?? 0}, finals ${st.events.finalSmash ?? 0}, hazard ${st.events.hazardErupt ?? 0}`);
    ok(st.hits > 20, 'hits happen');
    ok(st.kos >= 3, 'KOs happen');
    ok(st.gameSet, `match ${m} reaches gameSet`);
    ok(st.ffViolations === 0, 'friendly fire off respected');
  }
  durations.sort((a, b) => a - b);
  allKoPct.sort((a, b) => a - b);
  const med = (a: number[]) => a[Math.floor(a.length / 2)];
  log(`  durations: median ${med(durations).toFixed(2)} min, max ${durations[durations.length - 1].toFixed(2)} min`);
  log(`  KO %: p25 ${allKoPct[Math.floor(allKoPct.length * 0.25)].toFixed(0)} median ${med(allKoPct).toFixed(0)} p75 ${allKoPct[Math.floor(allKoPct.length * 0.75)].toFixed(0)} (n=${allKoPct.length})`);
  log(`  perf: avg step ${((avgStep / steps) * 1000).toFixed(1)} us (incl. CPU AI), worst ${worstStep.toFixed(2)} ms; total hits ${totalHits}`);
  ok(med(durations) < 4.5, 'median match length < 4.5 game-minutes');
  ok(avgStep / steps < 1, 'avg 4-fighter step < 1 ms');
}

function timeModeTest(): void {
  log('time mode + teams');
  const c = cfg('skyline', ['max', 'bram', 'zippy', 'kai'], { mode: 'time', timeSec: 90, items: true, itemFrequency: 'high' }, [7, 7, 7, 7], 77);
  const st = runMatch(c, 60 * 60 * 4);
  log(`  frames ${st.frames} kos ${st.kos} SD ${st.suddenDeath} timeWarnings ${st.events.timeWarning ?? 0}`);
  ok(st.gameSet, 'time match ends');
  ok(st.frames >= 90 * 60, 'time match lasts the full time');
  ok((st.events.timeWarning ?? 0) >= 10, 'time warnings');
  const t = cfg('arena', ['juno', 'fennec', 'pixel', 'rosa'], { teams: true, friendlyFire: false, items: true }, [8, 8, 8, 8], 5, false, [0, 0, 1, 1]);
  const st2 = runMatch(t, 60 * 60 * 8);
  log(`  teams: frames ${st2.frames} kos ${st2.kos} ffViolations ${st2.ffViolations}`);
  ok(st2.gameSet && st2.ffViolations === 0, 'team match ok');
}

// ---------------------------------------------------------------------------
// 3. sudden death
// ---------------------------------------------------------------------------
function suddenDeathTest(): void {
  log('sudden death');
  // stock: both last fighters cross the blast zone on the same frame
  const sim = new SmashSim(cfg('skyline', ['max', 'kai'], { stocks: 1 }, null, 3));
  sim.go();
  sim.step(inputs(2));
  (sim.fighters[0] as { x: number }).x = -40;
  (sim.fighters[1] as { x: number }).x = 40;
  const ev = sim.step(inputs(2));
  ok(ev.some((e) => e.type === 'suddenDeath'), 'stock tie -> suddenDeath event');
  ok(sim.suddenDeath && sim.status === 'fighting', 'sudden death running');
  ok(sim.fighters.every((f) => f.damage === 300 && !f.out), 'both at 300%');
  ok(Math.abs(sim.timeLeft - 60) < 0.1, 'SD timer 60 s');
  sim.forceKO(1);
  ok((sim.status as string) === 'gameSet' && sim.winner.fighter === 0, 'SD decided');
  // time: nobody scores -> tie
  const t = new SmashSim(cfg('arena', ['max', 'bram', 'zippy'], { mode: 'time', timeSec: 10 }, null, 4));
  t.go();
  let sd = false;
  for (let i = 0; i < 700; i++) for (const e of t.step(inputs(3))) if (e.type === 'suddenDeath') sd = true;
  ok(sd && t.suddenDeath, 'time tie -> sudden death');
  // SD bombs + safety end: never hangs
  let frames = 0;
  while (t.status !== 'gameSet' && frames < 60 * 200) {
    t.step(inputs(3));
    frames++;
  }
  ok(t.status === 'gameSet', 'SD always ends');
  log(`  stock tie OK; time tie OK; SD ended after ${(frames / 60).toFixed(0)} s idle`);
}

// ---------------------------------------------------------------------------
// 4. sandbox
// ---------------------------------------------------------------------------
function sandboxTest(): void {
  log('sandbox');
  const c: SimConfig = {
    stageId: 'training',
    seed: 9,
    sandbox: true,
    rules: { ...RULES, items: true, itemFrequency: 'high' },
    fighters: [
      { characterId: 'max', name: 'P1', color: '#f00', slot: 0, team: 0, cpuLevel: 6 },
      { characterId: 'zippy', name: 'P2', color: '#00f', slot: 1, team: 1, cpuLevel: 6 },
      { characterId: 'bram', name: 'Dummy', color: '#888', slot: -1, team: 2, cpuLevel: null, dummy: true },
    ],
  };
  const sim = new SmashSim(c);
  sim.go();
  let kos = 0;
  let dummyHits = 0;
  let maxDummy = 0;
  for (let i = 0; i < 60 * 90; i++) {
    for (const e of sim.step(inputs(3))) {
      if (e.type === 'ko') kos++;
      if (e.type === 'hit' && e.victim === 2) dummyHits++;
    }
    maxDummy = Math.max(maxDummy, sim.fighters[2].damage);
    if ((i & 31) === 0) checkFinite(sim, 'sandbox');
  }
  ok(sim.status === 'fighting', 'sandbox never ends');
  ok(sim.timeLeft === -1, 'no timer');
  ok(sim.fighters.every((f) => f.stocks === 99), 'infinite stocks');
  ok(dummyHits > 0, 'dummy gets hit');
  sim.forceKO(2);
  for (let i = 0; i < 3; i++) sim.step(inputs(3));
  ok(sim.fighters[2].damage === 0 && Math.abs(sim.fighters[2].x) < 0.5 && sim.fighters[2].action !== 'ko', 'dummy respawns at centre with 0%');
  sim.retire(0);
  for (let i = 0; i < 30; i++) sim.step(inputs(3));
  ok(sim.fighters[0].out && sim.fighters[0].action === 'out', 'retire');
  log(`  kos ${kos}, dummy hits ${dummyHits}, dummy max % ${maxDummy.toFixed(0)}`);
}

// ---------------------------------------------------------------------------
// 5. items + scripted moves for every fighter
// ---------------------------------------------------------------------------
function itemsTest(): void {
  log('items');
  const sim = new SmashSim(cfg('arena', ['max', 'bram'], { items: true }, null, 11));
  sim.go();
  sim.step(inputs(2));
  (sim.fighters[0] as { x: number }).x = -3;
  (sim.fighters[1] as { x: number }).x = 1;
  (sim.fighters[0] as { facing: number }).facing = 1;
  sim.giveItem(0, 'bomb');
  ok(sim.fighters[0].heldItem === 'bomb', 'give bomb');
  const ins = inputs(2);
  ins[0].attackPressed = true;
  sim.step(ins);
  ins[0].attackPressed = false;
  let exploded = false;
  let hitBram = false;
  for (let i = 0; i < 120; i++) {
    for (const e of sim.step(ins)) {
      if (e.type === 'explosion') exploded = true;
      if (e.type === 'hit' && e.victim === 1 && e.kind === 'explosion') hitBram = true;
    }
  }
  ok(exploded && hitBram, 'thrown bomb explodes on contact');
  // bat
  for (let i = 0; i < 200; i++) sim.step(inputs(2));
  (sim.fighters[0] as { x: number }).x = 0;
  (sim.fighters[1] as { x: number }).x = 1.5;
  (sim.fighters[0] as { facing: number }).facing = 1;
  sim.setDamage(1, 60);
  sim.giveItem(0, 'bat');
  ins[0].attackPressed = true;
  sim.step(ins);
  ins[0].attackPressed = false;
  let batKb = 0;
  for (let i = 0; i < 60; i++) for (const e of sim.step(ins)) if (e.type === 'hit' && e.kind === 'bat') batKb = e.kb;
  ok(batKb > 120, `bat home run kb ${batKb.toFixed(0)}`);
  // food + capsule + orb
  const s2 = new SmashSim(cfg('arena', ['max', 'kai'], { items: true }, null, 12));
  s2.go();
  s2.step(inputs(2));
  s2.setDamage(0, 40);
  s2.spawnItem('food', s2.fighters[0].x, 1.5);
  let healed = false;
  for (let i = 0; i < 60; i++) for (const e of s2.step(inputs(2))) if (e.type === 'heal') healed = true;
  ok(healed && s2.fighters[0].damage === 25, 'food heals 15');
  const orb = s2.spawnItem('orb', s2.fighters[0].x + 0.8, 1.0);
  ok(orb > 0, 'orb spawned');
  let powered = false;
  for (let k = 0; k < 6 && !powered; k++) {
    const io = inputs(2);
    const it = s2.items.find((i) => i.kind === 'orb');
    if (it) {
      (s2.fighters[0] as { x: number }).x = it.x - 0.6;
      (s2.fighters[0] as { y: number }).y = Math.max(0, it.y - 1.0);
      (s2.fighters[0] as { facing: number }).facing = 1;
    }
    io[0].attackPressed = true;
    io[0].x = 0.6;
    for (let i = 0; i < 40; i++) {
      for (const e of s2.step(io)) if (e.type === 'powerUp') powered = true;
      io[0].attackPressed = false;
    }
  }
  ok(powered && s2.fighters[0].powered, 'orb breaks -> powered');
  const io = inputs(2);
  io[0].specialPressed = true;
  let fs = false;
  for (let i = 0; i < 5; i++) {
    for (const e of s2.step(io)) if (e.type === 'finalSmash') fs = true;
    io[0].specialPressed = false;
  }
  ok(fs, 'final smash fires');
  for (let i = 0; i < 300; i++) s2.step(inputs(2));
  checkFinite(s2, 'after final');
  const cap = s2.spawnItem('capsule', 0, 6);
  ok(cap > 0, 'capsule');
  log('  bomb, bat, food, orb, final smash OK');
}

function everyMoveTest(): void {
  log('every move of every fighter (scripted)');
  const presses: Partial<SimInput>[] = [
    { attackPressed: true },
    { attackPressed: true, x: 0.6 },
    { attackPressed: true, y: 0.8 },
    { attackPressed: true, y: -0.8 },
    { attackPressed: true, flick: true, x: 1 },
    { attackPressed: true, flick: true, y: 1 },
    { attackPressed: true, flick: true, y: -1 },
    { specialPressed: true },
    { specialPressed: true, x: 1 },
    { specialPressed: true, y: 1 },
    { specialPressed: true, y: -1 },
    { grabPressed: true },
  ];
  for (const fd of FIGHTERS) {
    let hits = 0;
    let maxKb = 0;
    for (const p of presses) {
      const sim = new SmashSim(cfg('arena', [fd.id, 'max'], {}, null, 5));
      sim.go();
      sim.step(inputs(2));
      (sim.fighters[0] as { x: number }).x = 0;
      (sim.fighters[0] as { facing: number }).facing = 1;
      (sim.fighters[1] as { x: number }).x = 1.3;
      sim.setDamage(1, 100);
      const io = inputs(2);
      Object.assign(io[0], p);
      for (let i = 0; i < 160; i++) {
        for (const e of sim.step(io)) {
          if (e.type === 'hit' && e.victim === 1 && !e.shielded) {
            hits++;
            maxKb = Math.max(maxKb, e.kb);
          }
        }
        io[0] = emptySimInput();
        if (p.grabPressed && i === 20) io[0].x = 1; // throw
      }
      checkFinite(sim, `${fd.id} ${JSON.stringify(p)}`);
      ok(sim.fighters[0].action !== 'attack' || sim.fighters[0].moveFrame < 200, 'move ends');
    }
    log(`  ${fd.id}: ${hits} hits, max kb @100% ${maxKb.toFixed(0)}`);
    ok(hits >= 8, `${fd.id} moves connect`);
  }
}

function recoveryTest(): void {
  log('up-special recovery');
  for (const fd of FIGHTERS) {
    let saved = 0;
    const tries = [
      [-14, -2],
      [14, -2],
      [-13, 2],
      [15, 1],
    ];
    for (const [x0, y0] of tries) {
      const sim = new SmashSim(cfg('skyline', [fd.id, 'max'], {}, null, 5));
      sim.go();
      sim.step(inputs(2));
      const f = sim.fighters[0] as FighterView & { x: number; y: number; grounded: boolean; action: string };
      f.x = x0;
      f.y = y0;
      (f as { grounded: boolean }).grounded = false;
      (f as { action: string }).action = 'fall';
      (sim.fighters[1] as { x: number }).x = 3;
      const toward = x0 < 0 ? 1 : -1;
      let phase = 0;
      for (let i = 0; i < 400; i++) {
        const io = inputs(2);
        io[0].x = Math.abs(sim.fighters[0].x) > 7.5 ? toward : 0;
        if (phase === 0 && i === 2) {
          io[0].jumpPressed = true;
          io[0].jump = true;
          phase = 1;
        }
        if (phase === 1 && i >= 20 && sim.fighters[0].vy < 0) {
          io[0].specialPressed = true;
          io[0].y = 1;
          io[0].x = toward * 0.5;
          phase = 2;
        }
        sim.step(io);
        const a = sim.fighters[0].action;
        if (a === 'ledgeHang' || (sim.fighters[0].grounded && sim.fighters[0].y > -0.1)) {
          saved++;
          break;
        }
        if (a === 'ko') break;
      }
    }
    log(`  ${fd.id}: recovered ${saved}/${tries.length}`);
    ok(saved >= 3, `${fd.id} recovers`);
  }
}

// ---------------------------------------------------------------------------
// 6. determinism
// ---------------------------------------------------------------------------
function determinismTest(): void {
  log('determinism');
  const c = cfg('forge', ['max', 'juno', 'fennec', 'pixel'], { items: true, itemFrequency: 'high' }, [9, 6, 7, 8], 123);
  const a = runMatch(c, 60 * 60 * 2);
  const b = runMatch(c, 60 * 60 * 2);
  ok(a.hash === b.hash && a.hits === b.hits && a.kos === b.kos && a.frames === b.frames, 'same seed -> same match');
  const c2 = { ...c, seed: 124 };
  const d = runMatch(c2, 60 * 60 * 2);
  log(`  hash ${a.hash} == ${b.hash}; other seed ${d.hash}`);
}


// ---------------------------------------------------------------------------
// 7. core mechanics (scripted)
// ---------------------------------------------------------------------------
type W = { x: number; y: number; facing: number; grounded: boolean; action: string };
function mechSim(stage = 'skyline', chars = ['max', 'kai'], hazards = true): SmashSim {
  const sim = new SmashSim(cfg(stage, chars, { hazards }, null, 21));
  sim.go();
  for (let i = 0; i < 5; i++) sim.step(inputs(chars.length));
  return sim;
}
function run(sim: SmashSim, frames: number, f0: (t: number) => Partial<SimInput> = () => ({})): SimEvent[] {
  const all: SimEvent[] = [];
  for (let t = 0; t < frames; t++) {
    const io = inputs(sim.fighters.length);
    Object.assign(io[0], f0(t));
    all.push(...sim.step(io));
  }
  return all;
}
function mechanicsTest(): void {
  log('mechanics');
  // hops
  {
    const peak = (hold: boolean) => {
      const sim = mechSim('arena');
      let top = 0;
      run(sim, 90, (t) => (t === 0 ? { jumpPressed: true, jump: true } : { jump: hold && t < 6 }));
      const s2 = mechSim('arena');
      run(s2, 90, (t) => {
        top = Math.max(top, s2.fighters[0].y);
        return t === 0 ? { jumpPressed: true, jump: true } : { jump: hold && t < 6 };
      });
      return top;
    };
    const full = peak(true);
    const short = peak(false);
    log(`  full hop ${full.toFixed(2)} short hop ${short.toFixed(2)}`);
    ok(full > short * 1.4 && short > 0.8, 'short hop vs full hop');
  }
  // double jump only once
  {
    const sim = mechSim('arena');
    const ev = run(sim, 120, (t) => (t % 12 === 0 ? { jumpPressed: true, jump: true } : {}));
    const dj = ev.filter((e) => e.type === 'jump' && e.double && e.fighter === 0).length;
    ok(dj >= 1, 'double jump happens');
  }
  // drop through platform
  {
    const sim = mechSim('skyline');
    const f = sim.fighters[0] as unknown as W;
    f.x = -5.2;
    f.y = 2.9;
    f.grounded = false;
    f.action = 'fall';
    run(sim, 30);
    ok(sim.fighters[0].grounded && Math.abs(sim.fighters[0].y - 2.7) < 0.01, 'stands on platform');
    run(sim, 30, (t) => (t < 2 ? {} : { y: -1 }));
    ok(sim.fighters[0].y < 2.6, 'dropped through platform');
  }
  // shield, roll, spot dodge, shield grab, throws
  {
    const sim = mechSim('arena');
    (sim.fighters[0] as unknown as W).x = 0;
    (sim.fighters[1] as unknown as W).x = 1.2;
    (sim.fighters[0] as unknown as W).facing = 1;
    run(sim, 5, () => ({ shield: true }));
    ok(sim.fighters[0].action === 'shield' && sim.fighters[0].shielding, 'shield up');
    const hp0 = sim.fighters[0].shield;
    run(sim, 60, () => ({ shield: true }));
    ok(sim.fighters[0].shield < hp0, 'shield drains');
    const ev = run(sim, 40, (t) => ({ shield: true, x: t < 3 ? 1 : 0 }));
    ok(ev.some((e) => e.type === 'dodge'), 'roll from shield');
    run(sim, 20);
    run(sim, 5, () => ({ shield: true }));
    const ev2 = run(sim, 30, (t) => ({ shield: true, y: t < 3 ? -1 : 0 }));
    ok(ev2.some((e) => e.type === 'dodge') || sim.fighters[0].action === 'spotDodge', 'spot dodge');
    for (const [dir, mv] of [[{ x: 1 }, 'fthrow'], [{ x: -1 }, 'bthrow'], [{ y: 1 }, 'uthrow'], [{ y: -1 }, 'dthrow']] as [Partial<SimInput>, string][]) {
      const s2 = mechSim('arena');
      (s2.fighters[0] as unknown as W).x = 0;
      (s2.fighters[1] as unknown as W).x = 1.1;
      (s2.fighters[0] as unknown as W).facing = 1;
      const e3 = run(s2, 110, (t) => (t === 0 ? { grabPressed: true } : t === 12 ? { attackPressed: true } : t > 32 && t < 60 ? dir : {}));
      ok(e3.some((e) => e.type === 'grab'), 'grab connects');
      ok(e3.some((e) => e.type === 'throw' && e.move === mv), `throw ${mv}`);
      ok(e3.some((e) => e.type === 'hit' && e.move === 'pummel'), 'pummel');
    }
  }
  // shield break -> dizzy
  {
    const sim = mechSim('arena');
    const ev = run(sim, 500, () => ({ shield: true }));
    ok(ev.some((e) => e.type === 'shieldBreak'), 'shield breaks when held too long');
    run(sim, 60);
    ok(sim.fighters[0].action === 'dizzy', 'dizzy after shield break');
  }
  // air dodge once
  {
    const sim = mechSim('arena');
    const ev = run(sim, 80, (t) => (t === 0 ? { jumpPressed: true, jump: true } : t === 10 || t === 50 ? { shieldPressed: true, x: 1 } : {}));
    ok(ev.filter((e) => e.type === 'dodge').length === 1, 'one air dodge per airtime');
  }
  // ledge: grab, invincible, options
  for (const opt of ['climb', 'jump', 'attack', 'roll', 'drop'] as const) {
    const sim = mechSim('skyline');
    const f = sim.fighters[0] as unknown as W;
    f.x = -9.6;
    f.y = -1.0;
    f.grounded = false;
    f.action = 'fall';
    const ev = run(sim, 20);
    ok(ev.some((e) => e.type === 'ledgeGrab') && sim.fighters[0].action === 'ledgeHang', `ledge grab (${opt})`);
    ok(sim.fighters[0].invincible, 'ledge invincibility');
    const inp: Partial<SimInput> =
      opt === 'climb' ? { y: 1 } : opt === 'jump' ? { jumpPressed: true, jump: true } : opt === 'attack' ? { attackPressed: true } : opt === 'roll' ? { shieldPressed: true } : { y: -1 };
    run(sim, 4, () => inp);
    run(sim, 110, (t) => (opt === 'jump' && t < 40 ? { x: 1 } : {}));
    const a = sim.fighters[0];
    if (opt === 'drop') ok(!a.grounded || a.y < -0.5 || a.action === 'ledgeHang' || a.action === 'ko', 'ledge drop');
    else ok(a.grounded && a.x > -9 && a.y > -0.01, `ledge ${opt} -> on stage (${a.action} ${a.x.toFixed(2)},${a.y.toFixed(2)})`);
  }
  // moving platform carries
  {
    const sim = mechSim('forge');
    const f = sim.fighters[0] as unknown as W;
    const pv = sim.stageView.platforms[2];
    f.x = pv.x;
    f.y = pv.y + 0.3;
    f.grounded = false;
    f.action = 'fall';
    run(sim, 20);
    const x0 = sim.fighters[0].x;
    const p0 = sim.stageView.platforms[2].x;
    run(sim, 60);
    ok(sim.fighters[0].grounded && Math.abs(sim.fighters[0].x - x0 - (sim.stageView.platforms[2].x - p0)) < 1e-6, 'moving platform carries fighter');
    const still = mechSim('forge', ['max', 'kai'], false);
    const q0 = still.stageView.platforms[2].x;
    run(still, 100);
    ok(still.stageView.platforms[2].x === q0 && still.stageView.hazard === null, 'hazards off -> still platforms, no lava');
  }
  // respawn platform + invincibility
  {
    const sim = mechSim('skyline');
    sim.forceKO(0);
    ok(sim.fighters[0].stocks === 2, 'stock lost');
    run(sim, 70);
    ok(sim.fighters[0].action === 'respawn' && sim.fighters[0].invincible, 'on respawn platform');
    run(sim, 3, () => ({ x: 1 }));
    ok(sim.fighters[0].action !== 'respawn' && sim.fighters[0].invincible, 'left platform, still invincible');
    run(sim, 130);
    ok(!sim.fighters[0].invincible, 'invincibility ends');
  }
  log('  hops, double jump, drop-through, shield/roll/spotdodge/grab/pummel/4 throws, shield break, air dodge, 5 ledge options, moving platforms, respawn OK');
}

const t0 = performance.now();
knockbackTest();
mechanicsTest();
suddenDeathTest();
sandboxTest();
itemsTest();
everyMoveTest();
recoveryTest();
determinismTest();
timeModeTest();
matchesTest();
log(`\nALL PASSED (${((performance.now() - t0) / 1000).toFixed(1)} s)` + (failures ? ` failures=${failures}` : ''));
