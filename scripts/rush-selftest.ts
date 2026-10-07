/**
 * Party Rush headless self-test: every minigame × player counts × heat levels, with bots, random
 * mid-round leavers and touch players. Fails (exit 1) on any exception or insane ranking.
 *
 *   npx tsx scripts/rush-selftest.ts                      # everything
 *   npx tsx scripts/rush-selftest.ts --game darts --players 16 --verbose
 */
import { MINIGAMES } from '../src/games/rush/minigames/index';
import { BOTS } from '../src/games/rush/bots';
import { runHeadless } from '../src/games/rush/headless';
import type { Heat } from '../src/games/rush/types';

const args = process.argv.slice(2);
const arg = (k: string): string | undefined => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = arg('game');
const counts = arg('players') ? [Number(arg('players'))] : [1, 2, 3, 4, 8, 16];
const verbose = args.includes('--verbose');

let failures = 0;
let runs = 0;
for (const def of MINIGAMES) {
  if (only && def.meta.id !== only) continue;
  for (const n of counts) {
    if (n < def.meta.minPlayers) continue;
    for (const heat of [1, 2, 3] as Heat[]) {
      for (const variant of [
        { seed: 1, leaveRate: 0, touchRate: 0 },
        { seed: 2, leaveRate: 0.3, touchRate: 0.3 },
      ]) {
        runs++;
        let rep;
        try {
          rep = runHeadless(def, BOTS[def.meta.id], { players: n, heat, ...variant });
        } catch (err) {
          failures++;
          console.log(`FAIL ${def.meta.id} n=${n} heat=${heat} seed=${variant.seed}: threw ${(err as Error).stack}`);
          continue;
        }
        if (rep.problems.length) {
          failures++;
          console.log(`FAIL ${def.meta.id} n=${n} heat=${heat} seed=${variant.seed}: ${rep.problems.join('; ')}`);
        } else if (verbose) {
          const top = rep.result.ranking.slice(0, 4).map((r) => `${r.place}.${r.id}(${r.stat})`).join(' ');
          console.log(`ok   ${def.meta.id} n=${n} heat=${heat} ${rep.seconds.toFixed(1)}s${rep.endedEarly ? ' early' : ''} ev=${rep.events} st=${rep.streamSamples} cues=${rep.cuesFired} left=${rep.left.length} | ${top}`);
          for (const s of rep.result.superlatives ?? []) console.log(`       ★ ${s.id}: ${s.text}`);
        }
      }
    }
  }
}
console.log(`${runs - failures}/${runs} headless runs passed`);
process.exit(failures ? 1 : 0);
