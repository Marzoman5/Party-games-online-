/**
 * Smash Party combat unit test (pure Node, no page / browser):
 *  1. The frozen knockback helpers (src/games/smash/types.ts) against hand-computed values.
 *  2. Monotonicity: more % -> more knockback; heavier -> less knockback; more kbg/bkb -> more.
 *  3. A real deterministic SmashSim fight on the flat 'arena' stage: the attacker walks up to the
 *     victim and lands the same move at three different % values. The sim's reported knockback
 *     must follow the formula exactly (the move's kbg/bkb are solved from two hits and must
 *     predict the third), damage must be applied, and the victim's horizontal launch motion
 *     during hitstun must equal `launchDisplacement` (tiny tolerance).
 *
 * Run alone without building the app:  KP_NO_SERVER=1 npx playwright test tests/smash-combat.spec.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  HITSTUN_PER_KB,
  LAUNCH_DECAY,
  LAUNCH_SPEED_PER_KB,
  emptySimInput,
  hitstunFor,
  knockbackFormula,
  launchDisplacement,
  launchSpeedFor,
  type SimConfig,
  type SimEvent,
  type SimInput,
} from '../src/games/smash/types';
import * as kbModule from '../src/games/smash/sim/knockback';
import { SmashSim } from '../src/games/smash/sim/SmashSim';
import { getFighter } from '../src/games/smash/roster';
import { getStage } from '../src/games/smash/stages';

// --------------------------------------------------------------------------- formula

test.describe('knockback formula (frozen contract)', () => {
  test('constants', () => {
    expect(LAUNCH_SPEED_PER_KB).toBeCloseTo(0.003, 12);
    expect(LAUNCH_DECAY).toBeCloseTo(0.0051, 12);
    expect(HITSTUN_PER_KB).toBe(0.4);
  });

  test('knockbackFormula matches hand-computed values', () => {
    // ((((p/10 + p*d/20) * (200/(w+100)) * 1.4) + 18) * (kbg/100)) + bkb
    const cases: [p: number, d: number, w: number, kbg: number, bkb: number, expected: number][] = [
      // 5 + 25 = 30; *1 = 30; *1.4 = 42; +18 = 60; *1 = 60; +30 = 90
      [50, 10, 100, 100, 30, 90],
      // 0 + 0 -> 18 * 0.5 + 10 = 19
      [0, 5, 100, 50, 10, 19],
      // 10 + 100 = 110; *200/170 = 129.41176; *1.4 = 181.17647; +18 = 199.17647; *1.2 = 239.01176; +40
      [100, 20, 70, 120, 40, 279.0117647058824],
      // 12 + 96 = 108; *200/225 = 96; *1.4 = 134.4; +18 = 152.4; *0.9 = 137.16; +25
      [120, 16, 125, 90, 25, 162.16],
      // 3 + 4.5 = 7.5; *200/198 = 7.5757576; *1.4 = 10.606061; +18 = 28.606061; *0.7 = 20.024242; +0
      [30, 3, 98, 70, 0, 20.024242424242424],
    ];
    for (const [p, d, w, kbg, bkb, exp] of cases) {
      expect(knockbackFormula(p, d, w, kbg, bkb), `kb(${p},${d},${w},${kbg},${bkb})`).toBeCloseTo(exp, 9);
      // The sim's knockback module re-exports the same functions.
      expect(kbModule.knockbackFormula(p, d, w, kbg, bkb)).toBeCloseTo(exp, 9);
    }
  });

  test('hitstun, launch speed, launch displacement', () => {
    expect(hitstunFor(90)).toBe(36);
    expect(hitstunFor(19)).toBe(7); // 7.6 -> floor
    expect(hitstunFor(279.0117647058824)).toBe(111);
    expect(hitstunFor(0)).toBe(0);
    expect(launchSpeedFor(100)).toBeCloseTo(0.3, 12);
    expect(launchSpeedFor(90)).toBeCloseTo(0.27, 12);

    // kb 100 at 0°, 10 frames: sum_{k=1..10} (0.3 - 0.0051k) = 3 - 0.0051*55 = 2.7195
    const d0 = launchDisplacement(100, 0, 10);
    expect(d0.dx).toBeCloseTo(2.7195, 9);
    expect(d0.dy).toBeCloseTo(0, 9);
    const d90 = launchDisplacement(100, 90, 10);
    expect(d90.dx).toBeCloseTo(0, 9);
    expect(d90.dy).toBeCloseTo(2.7195, 9);
    const d45 = launchDisplacement(100, 45, 10);
    expect(d45.dx).toBeCloseTo(2.7195 / Math.SQRT2, 9);
    expect(d45.dy).toBeCloseTo(2.7195 / Math.SQRT2, 9);
    const d180 = launchDisplacement(100, 180, 10);
    expect(d180.dx).toBeCloseTo(-2.7195, 9);
    // kb 10 -> v0 0.03, default frames = hitstun 4: 0.12 - 0.0051*10 = 0.069
    expect(launchDisplacement(10, 0).dx).toBeCloseTo(0.069, 9);
    // Decay never goes below 0: kb 1 -> v0 0.003 < first decay step -> no motion.
    expect(launchDisplacement(1, 0, 10).dx).toBe(0);
    // Default frame count = hitstun.
    expect(launchDisplacement(90, 30).dx).toBeCloseTo(launchDisplacement(90, 30, hitstunFor(90)).dx, 12);
    // Closed form (while v stays positive): n*v0 - decay*n(n+1)/2
    const n = 36;
    const v0 = launchSpeedFor(90);
    expect(launchDisplacement(90, 0).dx).toBeCloseTo(n * v0 - (LAUNCH_DECAY * n * (n + 1)) / 2, 9);
  });

  test('monotonicity: more % -> more kb; heavier -> less kb; kbg/bkb/damage increase kb', () => {
    for (const w of [70, 100, 125]) {
      let prev = -Infinity;
      for (let p = 0; p <= 300; p += 5) {
        const kb = knockbackFormula(p, 12, w, 100, 20);
        expect(kb).toBeGreaterThan(prev);
        prev = kb;
      }
    }
    for (const p of [10, 60, 120, 200]) {
      let prev = Infinity;
      for (let w = 60; w <= 140; w += 5) {
        const kb = knockbackFormula(p, 12, w, 100, 20);
        expect(kb).toBeLessThan(prev);
        prev = kb;
      }
      expect(knockbackFormula(p, 12, 100, 110, 20)).toBeGreaterThan(knockbackFormula(p, 12, 100, 100, 20));
      expect(knockbackFormula(p, 12, 100, 100, 30)).toBeGreaterThan(knockbackFormula(p, 12, 100, 100, 20));
      expect(knockbackFormula(p, 14, 100, 100, 20)).toBeGreaterThan(knockbackFormula(p, 12, 100, 100, 20));
    }
    // Hitstun and launch distance grow with kb.
    expect(hitstunFor(120)).toBeGreaterThan(hitstunFor(60));
    expect(launchDisplacement(120, 0).dx).toBeGreaterThan(launchDisplacement(60, 0).dx);
  });
});

// --------------------------------------------------------------------------- real sim

type HitEvent = Extract<SimEvent, { type: 'hit' }>;

interface HitSample {
  pctBefore: number;
  damageAfter: number;
  hit: HitEvent;
  /** Victim x per frame, starting with the frame of the hit. */
  xs: number[];
  /** Victim action per frame, starting with the frame of the hit. */
  actions: string[];
  hitlags: number[];
}

const RULES: SimConfig['rules'] = {
  mode: 'stock',
  stocks: 3,
  timeSec: 120,
  teams: false,
  friendlyFire: false,
  items: false,
  itemFrequency: 'low',
  hazards: false,
};

function makeSim(attacker: string, victim: string): SmashSim {
  return new SmashSim({
    stageId: 'arena',
    seed: 1234,
    rules: RULES,
    fighters: [
      { characterId: attacker, name: 'A', color: '#ff4d4d', slot: 0, team: 0, cpuLevel: null },
      { characterId: victim, name: 'V', color: '#3d8bff', slot: 1, team: 1, cpuLevel: null },
    ],
  });
}

function inp(p: Partial<SimInput> = {}): SimInput {
  return { ...emptySimInput(), ...p };
}

/**
 * Fresh sim: attacker (fighter 0) walks up to the idle victim (fighter 1), victim set to `pct`,
 * attacker presses forward tilt (falls back to jab after a while). Returns the first unshielded
 * hit on the victim and the victim's x over the following frames.
 */
function landHit(attacker: string, victim: string, pct: number, follow = 40): HitSample {
  const sim = makeSim(attacker, victim);
  sim.go();
  const idle = inp();
  const A = (): (typeof sim.fighters)[number] => sim.fighters[0];
  const V = (): (typeof sim.fighters)[number] => sim.fighters[1];
  const stepBoth = (a: SimInput): SimEvent[] => sim.step([a, idle]);

  // Let everyone settle on the ground.
  for (let i = 0; i < 30; i++) stepBoth(idle);
  // Approach: run, then walk, until close.
  for (let i = 0; i < 600; i++) {
    const dx = V().x - A().x;
    if (Math.abs(dx) < 1.15) break;
    stepBoth(inp({ x: Math.abs(dx) > 3 ? Math.sign(dx) : Math.sign(dx) * 0.3 }));
  }
  // Stop and settle (skid / turn).
  for (let i = 0; i < 25; i++) stepBoth(idle);
  const dist = Math.abs(V().x - A().x);
  expect(dist, 'attacker reached the victim').toBeLessThan(2);

  sim.setDamage(1, pct);
  const dir = Math.sign(V().x - A().x) || 1;
  let hit: HitEvent | null = null;
  let damageAfter = 0;
  for (let attempt = 0; attempt < 8 && !hit; attempt++) {
    // ftilt first (|x| > 0.4, no flick), then jabs.
    const press = attempt < 4 ? inp({ x: 0.6 * dir, attack: true, attackPressed: true }) : inp({ attack: true, attackPressed: true });
    let evs = stepBoth(press);
    for (let f = 0; f < 50 && !hit; f++) {
      hit = (evs.find((e) => e.type === 'hit' && e.victim === 1 && e.attacker === 0 && !e.shielded) as HitEvent | undefined) ?? null;
      if (hit) break;
      evs = stepBoth(idle);
    }
    if (!hit) for (let i = 0; i < 20; i++) stepBoth(idle);
  }
  expect(hit, `attacker ${attacker} lands a hit on ${victim} at ${pct}%`).not.toBeNull();
  damageAfter = V().damage;
  const xs = [V().x];
  const actions: string[] = [V().action];
  const hitlags = [V().hitlag];
  for (let i = 0; i < follow; i++) {
    stepBoth(idle);
    xs.push(V().x);
    actions.push(V().action);
    hitlags.push(V().hitlag);
  }
  return { pctBefore: pct, damageAfter, hit: hit!, xs, actions, hitlags };
}

/** X-term of the formula: (p/10 + p*d/20) * (200/(w+100)) * 1.4 */
function xTerm(p: number, d: number, w: number): number {
  return (p / 10 + (p * d) / 20) * (200 / (w + 100)) * 1.4;
}

function simIsSkeleton(): boolean {
  // The SIM agent's placeholder file starts with "SKELETON" and never produces hits.
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'games', 'smash', 'sim', 'SmashSim.ts');
  try {
    return /^\/\*\*\s*SKELETON/.test(fs.readFileSync(file, 'utf8'));
  } catch {
    return true;
  }
}

test.describe('SmashSim: real hits follow the knockback formula', () => {
  test('ftilt at 3 different % on a flat stage: kb formula, damage, launch displacement', () => {
    test.skip(simIsSkeleton(), 'SmashSim is still the skeleton (no combat implemented yet)');
    const stage = getStage('arena');
    expect(stage.id).toBe('arena');
    const attacker = 'max';
    const victim = 'max';
    const w = getFighter(victim).weight;

    const samples = [40, 80, 120].map((p) => landHit(attacker, victim, p));
    const moves = samples.map((s) => s.hit.move);
    expect(new Set(moves).size, `same move every time (${moves.join(',')})`).toBe(1);
    const d = samples[0].hit.damage;
    for (const s of samples) {
      // Same move, same damage (no stale-move negation across fresh sims).
      expect(s.hit.damage).toBeCloseTo(d, 9);
      expect(s.hit.kb).toBeGreaterThan(0);
      // Damage was applied to the victim.
      expect(s.damageAfter).toBeCloseTo(s.pctBefore + s.hit.damage, 6);
    }
    // More % -> more kb.
    expect(samples[1].hit.kb).toBeGreaterThan(samples[0].hit.kb);
    expect(samples[2].hit.kb).toBeGreaterThan(samples[1].hit.kb);

    // Solve the move's kbg/bkb from the first two hits (p = damage AFTER the hit), predict the third.
    const P = samples.map((s) => s.damageAfter);
    const X = P.map((p) => xTerm(p, d, w));
    const kbg = (100 * (samples[1].hit.kb - samples[0].hit.kb)) / (X[1] - X[0]);
    const bkb = samples[0].hit.kb - ((X[0] + 18) * kbg) / 100;
    test.info().annotations.push({ type: 'move', description: `${moves[0]} d=${d} kbg=${kbg.toFixed(3)} bkb=${bkb.toFixed(3)} kb=${samples.map((s) => s.hit.kb.toFixed(2)).join('/')}` });
    expect(kbg).toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) expect(samples[i].hit.kb).toBeCloseTo(knockbackFormula(P[i], d, w, kbg, bkb), 6);

    // Launch: during hitstun the victim's horizontal motion is only the launch velocity's x.
    for (const s of samples) {
      const { kb, angle } = s.hit;
      const cos = Math.cos((angle * Math.PI) / 180);
      if (Math.abs(cos) < 0.15) {
        test.info().annotations.push({ type: 'launch', description: `angle ${angle}° is ~vertical: horizontal check skipped` });
        continue;
      }
      const dxs = s.xs.slice(1).map((x, i) => x - s.xs[i]);
      const start = dxs.findIndex((v) => Math.abs(v) > 1e-9);
      expect(start, `victim starts moving after the hit (hitlag ${s.hitlags.slice(0, 12).join(',')})`).toBeGreaterThanOrEqual(0);
      const frames = Math.min(hitstunFor(kb), 15, dxs.length - start);
      expect(frames).toBeGreaterThan(3);
      const measured = dxs.slice(start, start + frames).reduce((a, b) => a + b, 0);
      const expected = launchDisplacement(kb, angle, frames).dx;
      test.info().annotations.push({
        type: 'launch',
        description: `p=${s.damageAfter} kb=${kb.toFixed(2)} angle=${angle} hitstun=${hitstunFor(kb)} frames=${frames} measured dx=${measured.toFixed(5)} expected=${expected.toFixed(5)} actions=${s.actions.slice(0, 6).join(',')}`,
      });
      // First moving frame = k=1 of the decay sequence.
      expect(dxs[start]).toBeCloseTo(cos * Math.max(0, launchSpeedFor(kb) - LAUNCH_DECAY), 5);
      expect(Math.abs(measured - expected), `launch dx over ${frames} frames`).toBeLessThan(1e-4);
    }
    // Higher % -> launched farther.
    const dist = (s: HitSample): number => Math.abs(s.xs[s.xs.length - 1] - s.xs[0]);
    expect(dist(samples[2])).toBeGreaterThan(dist(samples[0]));
  });

  test('heavier victim takes less knockback from the same move at the same %', () => {
    test.skip(simIsSkeleton(), 'SmashSim is still the skeleton (no combat implemented yet)');
    const light = landHit('max', 'zippy', 90, 5);
    const heavy = landHit('max', 'bram', 90, 5);
    expect(light.hit.move).toBe(heavy.hit.move);
    expect(getFighter('zippy').weight).toBeLessThan(getFighter('bram').weight);
    expect(light.hit.kb).toBeGreaterThan(heavy.hit.kb);
  });

  test('determinism: same inputs -> same frames, positions and events', () => {
    test.skip(simIsSkeleton(), 'SmashSim is still the skeleton (no combat implemented yet)');
    const a = landHit('kai', 'juno', 60, 30);
    const b = landHit('kai', 'juno', 60, 30);
    expect(b.hit).toEqual(a.hit);
    expect(b.xs).toEqual(a.xs);
  });
});
