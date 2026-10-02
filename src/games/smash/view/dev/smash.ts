/**
 * Standalone dev page for the Smash Party engine (VIEW).
 *   /src/games/smash/view/dev/smash.html?mode=match|sandbox|attract&stage=skyline&humans=2&cpus=2
 *   &time=1 (time mode) &teams=1 &tv=1 &quality=0 &auto=1 (humans on CPU autopilot) &intro=0 &hud=0
 */
import { DEFAULT_SMASH_SETUP, SLOT_COLORS } from '../../../../net/protocol';
import { SmashGame } from '../../SmashGame';
import { FIGHTERS } from '../../roster';
import type { SmashMatchConfig } from '../../api';
import { getCharacter } from '../../../../kart/roster';

const q = new URLSearchParams(location.search);
const tv = q.get('tv') === '1';
const root = document.documentElement;
root.classList.toggle('tv', tv);
root.style.setProperty('--ui-scale', tv ? '1.6' : '1');
root.style.setProperty('--safe', tv ? '5vh' : '0px');

const app = document.getElementById('app')!;
const game = new SmashGame(app);
game.setTvMode(tv);
const dev = document.getElementById('dev')!;
if (q.get('hud') === '0') dev.style.display = 'none';
const log: string[] = [];
game.onPhaseChange = (p) => {
  log.push(p);
  (window as unknown as { __phases: string[] }).__phases = log;
};
game.onMatchComplete = (r) => {
  (window as unknown as { __result: unknown }).__result = r;
};
let fxCount = 0;
game.onFx = () => {
  fxCount++;
};
game.onPauseRequest = () => {
  if (game.phase === 'paused') game.resume();
  else game.pause();
};
game.activate();

const mode = q.get('mode') ?? 'match';
const nh = Number(q.get('humans') ?? 2);
const nc = Number(q.get('cpus') ?? 2);
const chars = FIGHTERS.map((f) => f.id);
const humans = Array.from({ length: nh }, (_, i) => ({
  playerId: `p${i}`,
  name: ['ALEX', 'SAM', 'JORDAN', 'RILEY'][i],
  characterId: chars[(i * 3) % chars.length],
  color: SLOT_COLORS[i],
  slot: i,
  team: i % 2,
}));
const cpus = Array.from({ length: nc }, (_, i) => {
  const id = chars[(nh * 3 + i * 3 + 1) % chars.length];
  return { characterId: id, name: getCharacter(id).name.split(' ')[0].toUpperCase(), color: '#c8c8d8', level: 7, team: (nh + i) % 2 };
});
const cfg: SmashMatchConfig = {
  setup: {
    ...DEFAULT_SMASH_SETUP,
    stageId: q.get('stage') ?? 'skyline',
    mode: q.get('time') === '1' ? 'time' : 'stock',
    stocks: Number(q.get('stocks') ?? 3),
    timeSec: Number(q.get('sec') ?? 120),
    teams: q.get('teams') === '1',
  },
  humans,
  cpus,
  intro: q.get('intro') !== '0',
};
(window as unknown as { __cfg: unknown; __game: unknown }).__cfg = cfg;
(window as unknown as { __game: unknown }).__game = game;

function autopilot(): void {
  if (q.get('auto') === '0') return;
  const h = (window as unknown as { __smash?: { cpu(i: number, l: number | null): void } }).__smash;
  for (let i = 0; i < nh; i++) h?.cpu(i, 7);
}

setTimeout(() => {
  if (mode === 'match') {
    game.startMatch(cfg);
    autopilot();
    const iv = setInterval(() => {
      if (game.phase === 'intro' || game.phase === 'countdown' || game.phase === 'fighting') {
        autopilot();
        clearInterval(iv);
      }
    }, 50);
  } else if (mode === 'sandbox') {
    game.startSandbox({ humans });
    autopilot();
  }
}, 300);

setInterval(() => {
  const s = (window as unknown as { __smash?: { getState(): { fps: number; frame: number; phase: string; memory: unknown } } }).__smash?.getState();
  if (s) dev.textContent = `${s.phase} f${s.frame} ${s.fps}fps fx${fxCount} ${JSON.stringify(s.memory)}`;
}, 500);
