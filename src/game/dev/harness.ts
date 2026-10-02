/**
 * DEV-ONLY engine harness (dev/engine.html; not part of the production build).
 * Drives `Game` through IGameHost without the party layer.
 *
 * URL params:
 *   mode=demo|race|solo|idle (default demo)
 *   players=1..4   phone humans driven by fake inputs (mode=race)
 *   local=1        human 0 uses the host keyboard instead of a fake phone
 *   track=<id> laps=N cc=50|100|150 tips=1 intro=0 ui=party|solo tv=1
 *   fake=0         don't send fake phone inputs (karts sit still)
 *   panel=0        hide the button panel (screenshots)
 */
import { Game } from '../Game';
import type { HumanDriver, PartyRaceConfig, RaceResult } from '../api';
import { SLOT_COLORS } from '../../net/protocol';
import { CHARACTERS } from '../../kart/roster';
import { TRACKS } from '../../track/tracks';
import { wrap01 } from '../../core/math';

const q = new URLSearchParams(location.search);
const app = document.getElementById('app')!;
const game = new Game(app);

if (q.get('tv') === '1') {
  document.documentElement.classList.add('tv');
  document.documentElement.style.setProperty('--ui-scale', '1.6');
  document.documentElement.style.setProperty('--safe', '5vh');
  game.setTvMode(true);
}

const log: { phases: string[]; results: RaceResult[][]; pauseRequests: number; soloExits: number } = {
  phases: [],
  results: [],
  pauseRequests: 0,
  soloExits: 0,
};
game.onPhaseChange = (p) => log.phases.push(p);
game.onRaceComplete = (r) => log.results.push(r);
game.onPauseRequest = () => {
  log.pauseRequests++;
  if (game.phase === 'paused') game.resume();
  else game.pause();
};
game.onSoloExit = () => {
  log.soloExits++;
};

// ------------------------------------------------------------- fake phones
let fakeOn = q.get('fake') !== '0';
const presses = [0, 0, 0, 0];
const fakeSteerOverride: (number | null)[] = [null, null, null, null];
let humansCount = 0;
let localHuman = false;

function fakeTick(): void {
  requestAnimationFrame(fakeTick);
  if (!fakeOn || humansCount === 0) return;
  const s = game.debugSession();
  for (let i = 0; i < humansCount; i++) {
    if (i === 0 && localHuman) continue;
    let steer = 0;
    if (s && s.karts[i]) {
      // Pure pursuit toward a point ~14 m ahead on the centreline.
      const st = s.karts[i].state;
      const len = Math.max(100, s.track.length);
      const target = s.track.sample(wrap01(st.trackT + 14 / len)).position;
      const dx = target.x - st.position.x;
      const dz = target.z - st.position.z;
      const fx = -Math.sin(st.heading);
      const fz = -Math.cos(st.heading);
      const cross = fx * dz - fz * dx;
      const dot = fx * dx + fz * dz;
      const ang = Math.atan2(cross, dot);
      steer = Math.max(-1, Math.min(1, ang * 2.2));
    }
    const o = fakeSteerOverride[i];
    game.setHumanInput(i, {
      steer: o ?? steer,
      throttle: 1,
      brake: 0,
      drift: false,
      itemHeld: false,
      lookBack: false,
      itemPresses: presses[i] & 255,
    });
  }
}
requestAnimationFrame(fakeTick);

function humans(n: number, local: boolean): HumanDriver[] {
  const names = ['ALEX', 'SAM', 'JORDAN', 'RIVER'];
  const out: HumanDriver[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      playerId: i === 0 && local ? 'local' : `p${i}`,
      name: names[i],
      characterId: CHARACTERS[(i * 2) % CHARACTERS.length].id,
      color: SLOT_COLORS[i],
      source: i === 0 && local ? 'local' : 'phone',
    });
  }
  return out;
}

function race(n: number, extra: Partial<PartyRaceConfig> = {}): void {
  localHuman = q.get('local') === '1';
  humansCount = n;
  const cfg: PartyRaceConfig = {
    trackId: q.get('track') ?? TRACKS[0].id,
    cc: (Number(q.get('cc')) || 150) as 50 | 100 | 150,
    laps: Number(q.get('laps')) || 2,
    humans: humans(n, localHuman),
    showTips: q.get('tips') === '1',
    introFlyover: q.get('intro') !== '0',
    ui: q.get('ui') === 'solo' ? 'solo' : 'party',
    ...extra,
  };
  game.startRace(cfg);
}

const harness = {
  game,
  log,
  race,
  demo: () => {
    humansCount = 0;
    game.showDemo();
  },
  solo: () => {
    humansCount = 0;
    game.openSoloMenu();
  },
  setFake: (on: boolean) => {
    fakeOn = on;
  },
  pressItem: (slot: number) => {
    presses[slot] = (presses[slot] + 1) & 255;
  },
  steer: (slot: number, v: number | null) => {
    fakeSteerOverride[slot] = v;
  },
};
(window as unknown as { __harness: typeof harness }).__harness = harness;

// ------------------------------------------------------------- button panel
if (q.get('panel') !== '0') {
  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;right:8px;top:50%;transform:translateY(-50%);z-index:500;display:flex;flex-direction:column;gap:4px;font:12px system-ui;';
  const btn = (label: string, fn: () => void): void => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'padding:4px 8px;border-radius:6px;border:1px solid #888;background:#222c;color:#fff;cursor:pointer';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      (e.currentTarget as HTMLElement).blur();
      fn();
    });
    panel.appendChild(b);
  };
  btn('Demo', harness.demo);
  for (let n = 1; n <= 4; n++) btn(`Race ${n}P`, () => race(n));
  btn('Solo menu', harness.solo);
  btn('Pause', () => game.pause());
  btn('Resume', () => game.resume());
  btn('Restart', () => game.restartRace());
  btn('Quit', () => game.quitRace());
  btn('Finish all', () => game.debugFinishAll());
  btn('Item P1', () => harness.pressItem(0));
  btn('AI P2 on', () => game.setSlotAI(1, true));
  btn('AI P2 off', () => game.setSlotAI(1, false));
  btn('TV', () => {
    const on = !document.documentElement.classList.contains('tv');
    document.documentElement.classList.toggle('tv', on);
    document.documentElement.style.setProperty('--ui-scale', on ? '1.6' : '1');
    document.documentElement.style.setProperty('--safe', on ? '5vh' : '0px');
    game.setTvMode(on);
  });
  document.body.appendChild(panel);
}

// ------------------------------------------------------------- boot
const mode = q.get('mode') ?? 'demo';
if (mode === 'race') race(Math.max(1, Math.min(4, Number(q.get('players')) || 1)));
else if (mode === 'solo') harness.solo();
else if (mode === 'demo') harness.demo();
