/**
 * Recovery grid test: drops each fighter (as a CPU, alone with an idle dummy-ish opponent far
 * away) at many off-stage positions with its double jump available and checks it gets back.
 *   npx tsx src/games/smash/sim/ai/dev/aiRecover.ts [level] [stage]
 * Prints success % per character and the failing start positions (dx out from the ledge, dy
 * relative to the ledge).
 */
import { SmashSim } from '../../SmashSim';
import { FIGHTERS } from '../../../roster';
import type { SimConfig } from '../../../types';
import { emptySimInput } from '../../../types';

declare const process: { argv: string[] };
const level = Number(process.argv[2] ?? 9);
const stageId = process.argv[3] ?? 'skyline';

type Mut = { x: number; y: number; vx: number; vy: number; grounded: boolean; action: string; actionFrame: number; jumpsLeft: number; plat: number; prevX: number; prevY: number };

let total = 0;
let okTotal = 0;
for (const def of FIGHTERS) {
  let ok = 0;
  let n = 0;
  const fails: string[] = [];
  for (const side of [-1, 1]) {
    for (const dxOut of [1, 3, 5, 7, 9, 11, 13]) {
      for (const dy of [-9, -7, -5, -3, -1, 1, 3, 6]) {
        const cfg: SimConfig = {
          stageId,
          fighters: [
            { characterId: def.id, name: 'R', color: '#fff', slot: -1, team: 0, cpuLevel: level },
            { characterId: 'max', name: 'D', color: '#fff', slot: -1, team: 1, cpuLevel: null, dummy: true },
          ],
          rules: { mode: 'stock', stocks: 3, timeSec: 180, teams: false, friendlyFire: false, items: false, itemFrequency: 'low', hazards: false },
          seed: 99 + dxOut * 7 + dy,
          sandbox: false,
        };
        const sim = new SmashSim(cfg);
        sim.go();
        sim.step([emptySimInput(), emptySimInput()]);
        const main = sim.stage.platforms.find((p) => p.solid && p.ledges)!;
        const lx = main.x + side * (main.w / 2);
        const f = sim.fighters[0] as unknown as Mut;
        f.x = lx + side * dxOut;
        f.y = main.y + dy;
        f.prevX = f.x;
        f.prevY = f.y;
        f.vx = 0;
        f.vy = 0;
        f.grounded = false;
        f.plat = -1;
        f.action = 'fall';
        f.actionFrame = 0;
        f.jumpsLeft = 1;
        // park the dummy far away in the middle
        let res = 'timeout';
        for (let i = 0; i < 600; i++) {
          const ev = sim.step([emptySimInput(), emptySimInput()]);
          if (ev.some((e) => e.type === 'ko' && e.victim === 0)) {
            res = 'ko';
            break;
          }
          const v = sim.fighters[0];
          if (v.grounded || v.action === 'ledgeHang') {
            res = 'ok';
            break;
          }
        }
        n++;
        if (res === 'ok') ok++;
        else fails.push(`(${dxOut},${dy})${res === 'timeout' ? 'T' : ''}`);
      }
    }
  }
  total += n;
  okTotal += ok;
  console.log(`${def.id.padEnd(7)} ${((100 * ok) / n).toFixed(0).padStart(3)}%  fails: ${fails.join(' ')}`);
}
console.log(`L${level} ${stageId}: overall ${((100 * okTotal) / total).toFixed(1)}%`);
