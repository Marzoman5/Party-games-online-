/**
 * Party Rush SOAK test: one real host page (headless Chromium, production build) + N bot phones over the
 * real relay, playing the endless loop for many rounds while everything that can go wrong at a party does:
 * random joins / leaves / disconnects + reconnects with the same token / hidden tabs / idle phones, random
 * host key presses (Space, P…P, S, R, Esc…Esc), max-heat changes on top of the natural heat climb, and an
 * occasional host page reload.
 *
 * It fails (exit 1) on: a stuck phase (a phase outliving its hard cap + margin while unpaused), any
 * uncaught page error / console.error, any `__rush` error, or an inconsistent scoreboard (round awards that
 * break the placement rules, all-time points ≠ the sum of the awards seen, duplicated rows, NaN).
 *
 * Usage (no npm needed; needs a built + running server, e.g. `node dist-server/server.mjs --port 3302`):
 *
 *   npx tsx scripts/rush-soak.ts --base http://127.0.0.1:3302 --bots 16 --rounds 200 --heat
 *
 * Flags:
 *   --base URL      server base URL (default http://127.0.0.1:3000)
 *   --bots N        bot phones (1..16, default 16)
 *   --rounds N      stop after N completed (scored) rounds (default 200)
 *   --minutes M     ...or after M minutes, whichever comes first (default 240)
 *   --heat          change the max-heat setting (1..3) every ~20 rounds (natural heat climb is always on)
 *   --no-chaos      no joins / leaves / disconnects / away
 *   --no-keys       no random host key presses (the host still presses Space on UP NEXT / results)
 *   --no-reload     never reload the host page
 *   --patient       don't press Space on UP NEXT / results (real-time loop, slower)
 *   --seed N        RNG seed (default 1)
 *   --out FILE      write the JSON summary there (default: stdout only)
 *   --headed        show the host browser
 *
 * Progress: one line per completed round on stdout ([soak] …). Run it in the background and tail the output.
 */
import fs from 'node:fs';
import { chromium, type Page } from '@playwright/test';
import { BotPhone } from './bots';

// ------------------------------------------------------------------ CLI

const argv = process.argv.slice(2);
const flag = (k: string): boolean => argv.includes(`--${k}`);
const opt = (k: string, d: string): string => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
};
const BASE = opt('base', 'http://127.0.0.1:3000');
const NBOTS = Math.max(1, Math.min(16, Number(opt('bots', '16')) || 16));
const ROUNDS = Math.max(1, Number(opt('rounds', '200')) || 200);
const MINUTES = Math.max(1, Number(opt('minutes', '240')) || 240);
const HEAT = flag('heat');
const CHAOS = !flag('no-chaos');
const KEYS = !flag('no-keys');
const RELOAD = !flag('no-reload');
const PATIENT = flag('patient');
const OUT = opt('out', '');
let seed = Number(opt('seed', '1')) || 1;
const rnd = (): number => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const mins = (): string => ((Date.now() - t0) / 60000).toFixed(1);
const log = (s: string): void => console.log(`[soak ${mins()}m] ${s}`);

// ------------------------------------------------------------------ page-side types

interface Row {
  id: string;
  name: string;
  bot: boolean;
  place: number;
  pts: number;
}
interface St {
  phase: string;
  round: number;
  roundsPlayed: number;
  heat: number;
  game: string;
  rid: number;
  paused: boolean;
  menu: boolean;
  participants: string[];
  players: { id: string; st: string; pts: number; connected: boolean; bot: boolean }[];
  lastResults: { rid: number; round: number; game: string; rows: Row[] } | null;
  errors: { where: string; game: string; msg: string }[];
  settings: { auto: boolean; autoSec: number; maxHeat: number };
  msgBytes: { last: number; max: number; sent: number };
}
type RW = Window & { __rush?: { getState(): St; setSetting(k: string, v: unknown): boolean; pause(on?: boolean): boolean; next(): boolean }; __party?: { getState(): { room: string; screen: string }; pickGame(id: string): Promise<boolean>; setTvMode(on: boolean): void } };

// ------------------------------------------------------------------ results bookkeeping

const failures: string[] = [];
const fail = (s: string): void => {
  failures.push(`[${mins()}m] ${s}`);
  log(`FAIL ${s}`);
};
const caps: Record<string, number> = { intro: 7, count: 2.4, play: 43, results: 6, oops: 2.6 };
const MARGIN = 8;
const maxPhase: Record<string, number> = {};
const phaseCount: Record<string, number> = {};
const games: Record<string, number> = {};
const heats: Record<string, number> = {};
const ledger = new Map<string, number>();
const keyCount: Record<string, number> = {};
const chaosCount: Record<string, number> = {};
let resultsSeen = 0;
let lastRid = -1;
let lastRoundsPlayed = -1;
let reloads = 0;
let pageErrors = 0;
let maxShellErrors = 0;

// traffic: the host page's WebSocket (= everything the relay passes to/from the host) + all bots
const traffic = { hostIn: 0, hostOut: 0, hostMaxIn: 0, hostMaxOut: 0, framesIn: 0, framesOut: 0 };
let maxPhoneMsg = 0;

function checkRows(rows: Row[], label: string): void {
  const n = rows.length;
  if (!n) return fail(`${label}: empty ranking`);
  if (rows[0].place !== 1) fail(`${label}: first place is ${rows[0].place}`);
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    if (seen.has(r.id)) fail(`${label}: duplicate row ${r.id}`);
    seen.add(r.id);
    if (i > 0 && r.place < rows[i - 1].place) fail(`${label}: places not sorted`);
    if (i > 0 && r.place !== rows[i - 1].place && r.place !== i + 1) fail(`${label}: bad competition rank ${r.place} at ${i}`);
    const want = n - r.place + 1 + (r.place === 1 ? 2 : 0);
    if (r.pts !== want || !Number.isFinite(r.pts)) fail(`${label}: ${r.id} place ${r.place}/${n} got ${r.pts} pts, want ${want}`);
  });
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  log(`base=${BASE} bots=${NBOTS} rounds=${ROUNDS} heat=${HEAT} chaos=${CHAOS} keys=${KEYS} reload=${RELOAD} patient=${PATIENT}`);
  const browser = await chromium.launch({
    headless: !flag('headed'),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => {
    pageErrors++;
    fail(`pageerror: ${e.message}`);
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/AudioContext|autoplay|favicon|GPU stall|WebGL/i.test(t)) return;
    pageErrors++;
    fail(`console.error: ${t.slice(0, 300)}`);
  });
  page.on('websocket', (ws) => {
    ws.on('framereceived', (f) => {
      const n = typeof f.payload === 'string' ? f.payload.length : f.payload.byteLength;
      traffic.hostIn += n;
      traffic.framesIn++;
      if (n > traffic.hostMaxIn) traffic.hostMaxIn = n;
    });
    ws.on('framesent', (f) => {
      const n = typeof f.payload === 'string' ? f.payload.length : f.payload.byteLength;
      traffic.hostOut += n;
      traffic.framesOut++;
      if (n > traffic.hostMaxOut) traffic.hostMaxOut = n;
    });
  });

  await page.goto(`${BASE}/?stub=1&quality=0`);
  await page.waitForFunction(() => /^[A-Z]{4}$/.test((window as unknown as RW).__party?.getState().room ?? '') && !!(window as unknown as RW).__rush, undefined, { timeout: 90_000 });
  const room = await page.evaluate(() => (window as unknown as RW).__party!.getState().room);
  await page.evaluate(() => (window as unknown as RW).__party!.pickGame('rush'));
  await page.waitForFunction(() => (window as unknown as RW).__party!.getState().screen === 'race', undefined, { timeout: 30_000 });
  const setting = (k: string, v: unknown): Promise<boolean> => page.evaluate(([kk, vv]) => (window as unknown as RW).__rush!.setSetting(kk as string, vv), [k, v] as const);
  await setting('auto', true);
  await setting('autoSec', 3); // the minimum the settings allow
  await setting('maxHeat', 3);
  await setting('volume', 0);
  log(`room ${room}`);

  // ---------------------------------------------------------------- bots
  const bots: BotPhone[] = [];
  const retired: BotPhone[] = [];
  let botSeq = 0;
  const startBot = async (token?: string): Promise<BotPhone | null> => {
    try {
      const b = await BotPhone.connect(BASE, room, token, 10_000);
      await b.waitFor((x) => !!x.rush, 20_000, 'rush msg');
      b.startRushBrain(0.3 + rnd() * 0.6, ++botSeq * 7919);
      b.rushHere(rnd() < 0.7);
      return b;
    } catch (err) {
      log(`bot connect failed: ${String(err)}`);
      return null;
    }
  };
  for (let i = 0; i < NBOTS; i++) {
    const b = await startBot();
    if (b) bots.push(b);
  }
  log(`${bots.length} bots in`);

  const busy = new Set<BotPhone>();
  const chaosStep = async (): Promise<void> => {
    const free = bots.filter((b) => b.connected && !busy.has(b));
    if (free.length < 2 || busy.size >= 4) return;
    const b = pick(free);
    const r = rnd();
    busy.add(b);
    const done = (): void => {
      busy.delete(b);
    };
    if (r < 0.3) {
      // Wi-Fi blip: hard drop, reconnect with the same token after 1–20 s.
      chaosCount.disconnect = (chaosCount.disconnect ?? 0) + 1;
      b.disconnect();
      setTimeout(() => {
        void startBot(b.token).then((nb) => {
          const k = bots.indexOf(b);
          if (nb && k >= 0) {
            if (nb.playerId !== b.playerId) fail(`reconnect with token gave ${nb.playerId}, was ${b.playerId}`);
            bots[k] = nb;
          }
          retired.push(b);
          done();
        });
      }, 1000 + rnd() * 19000);
    } else if (r < 0.55) {
      // Locked phone / hidden tab, back after 5–40 s.
      chaosCount.hidden = (chaosCount.hidden ?? 0) + 1;
      b.rushAway(true);
      setTimeout(() => {
        if (b.connected) b.rushHere(true);
        done();
      }, 5000 + rnd() * 35000);
    } else if (r < 0.75) {
      // Phone on the table: no activity for 30–90 s (→ away after a whole round), then a tap.
      chaosCount.idle = (chaosCount.idle ?? 0) + 1;
      b.rushAway(false);
      setTimeout(() => {
        if (b.connected) b.rushHere(true);
        done();
      }, 30000 + rnd() * 60000);
    } else if (r < 0.88) {
      // Leaves the party for good; a brand-new phone joins a bit later.
      chaosCount.leave = (chaosCount.leave ?? 0) + 1;
      b.leave();
      await sleep(300);
      await b.close();
      const k = bots.indexOf(b);
      setTimeout(() => {
        void startBot().then((nb) => {
          if (nb && k >= 0) bots[k] = nb;
          retired.push(b);
          done();
        });
      }, 2000 + rnd() * 10000);
    } else {
      // Closes the tab (clean socket close, not 'leave'); comes back later with the same token.
      chaosCount.closeTab = (chaosCount.closeTab ?? 0) + 1;
      await b.close();
      setTimeout(() => {
        void startBot(b.token).then((nb) => {
          const k = bots.indexOf(b);
          if (nb && k >= 0) bots[k] = nb;
          retired.push(b);
          done();
        });
      }, 3000 + rnd() * 30000);
    }
  };

  // ---------------------------------------------------------------- host keys
  let keyBusy = false;
  const press = async (k: string): Promise<void> => {
    keyCount[k === ' ' ? 'Space' : k] = (keyCount[k === ' ' ? 'Space' : k] ?? 0) + 1;
    await page.keyboard.press(k).catch(() => undefined);
  };
  const keyStep = async (): Promise<void> => {
    if (keyBusy) return;
    keyBusy = true;
    try {
      const r = rnd();
      if (r < 0.35) await press(' ');
      else if (r < 0.55) {
        await press('p');
        await sleep(1000 + rnd() * 4000);
        await press('p');
      } else if (r < 0.75) await press('s');
      else if (r < 0.88) await press('r');
      else {
        await press('Escape');
        await sleep(1000 + rnd() * 3000);
        await press('Escape');
      }
    } finally {
      keyBusy = false;
    }
  };

  // ---------------------------------------------------------------- watcher loop
  let cur = '';
  let acc = 0;
  let last = Date.now();
  let nextChaos = Date.now() + 8000;
  let nextKey = Date.now() + 5000;
  let nextHeat = 20;
  let nextReload = 45 + Math.floor(rnd() * 20);
  let lastIntroRid = -1;
  let lastResSkip = -1;
  const deadline = t0 + MINUTES * 60_000;

  while (resultsSeen < ROUNDS && Date.now() < deadline) {
    await sleep(400);
    let st: St;
    try {
      st = await page.evaluate(() => {
        const s = (window as unknown as RW).__rush!.getState();
        // keep the payload small: drop what the soak doesn't use
        return { ...s, players: s.players.map((p) => ({ id: p.id, st: p.st, pts: p.pts, connected: p.connected, bot: p.bot })) } as St;
      });
    } catch (err) {
      fail(`getState failed: ${String(err).slice(0, 200)}`);
      await sleep(2000);
      continue;
    }
    const now = Date.now();
    // ---- stuck detection (unpaused, outside the menu)
    const key = `${st.phase}:${st.rid}`;
    if (key !== cur) {
      if (cur) {
        const ph = cur.split(':')[0];
        phaseCount[ph] = (phaseCount[ph] ?? 0) + 1;
      }
      cur = key;
      acc = 0;
    } else if (!st.paused && !st.menu) acc += (now - last) / 1000;
    last = now;
    maxPhase[st.phase] = Math.max(maxPhase[st.phase] ?? 0, acc);
    const present = st.players.filter((p) => !p.bot && p.connected && (p.st === 'play' || p.st === 'next')).length;
    const cap = st.phase === 'lobby' ? (st.settings.auto && present > 0 ? st.settings.autoSec : Infinity) : caps[st.phase] ?? 60;
    if (acc > cap + MARGIN) {
      fail(`STUCK: phase ${st.phase} (rid ${st.rid}, game ${st.game}) for ${acc.toFixed(1)} s unpaused (cap ${cap})`);
      acc = -1e9; // report once per phase
    }
    // ---- shell errors
    if (st.errors.length > maxShellErrors) {
      for (const e of st.errors.slice(maxShellErrors)) fail(`__rush error: ${e.game} ${e.where}: ${e.msg}`);
      maxShellErrors = st.errors.length;
    }
    // ---- scoreboard consistency
    const ids = st.players.map((p) => p.id);
    if (new Set(ids).size !== ids.length) fail(`duplicated rows: ${ids.join(',')}`);
    for (const p of st.players) if (!Number.isFinite(p.pts) || p.pts < 0) fail(`bad points ${p.id}=${p.pts}`);
    const res = st.lastResults;
    if (res && res.rid !== lastRid) {
      lastRid = res.rid;
      resultsSeen++;
      checkRows(res.rows, `round ${res.round} ${res.game}`);
      for (const r of res.rows) if (!r.bot) ledger.set(r.id, (ledger.get(r.id) ?? 0) + r.pts);
      games[res.game] = (games[res.game] ?? 0) + 1;
      heats[String(st.heat)] = (heats[String(st.heat)] ?? 0) + 1;
      if (lastRoundsPlayed >= 0 && st.roundsPlayed !== lastRoundsPlayed + 1) fail(`roundsPlayed jumped ${lastRoundsPlayed} → ${st.roundsPlayed}`);
      lastRoundsPlayed = st.roundsPlayed;
      const el = (Date.now() - t0) / 1000;
      log(`round ${resultsSeen}/${ROUNDS} #${res.round} ${res.game} heat ${st.heat} rows=${res.rows.length} players=${st.players.filter((p) => !p.bot).length} present=${present} rate=${((resultsSeen / el) * 3600).toFixed(0)}/h fails=${failures.length}`);
    }
    // all-time points = sum of awards (only check on a calm scoreboard: lastResults already counted)
    if (st.phase === 'lobby' || st.phase === 'intro') {
      for (const p of st.players) {
        if (p.bot) continue;
        const want = ledger.get(p.id) ?? 0;
        if (p.pts !== want) {
          fail(`points mismatch ${p.id}: board ${p.pts} ≠ sum of awards ${want}`);
          ledger.set(p.id, p.pts); // report once
        }
      }
    }
    for (const b of bots) if (b.maxMsgIn > maxPhoneMsg) maxPhoneMsg = b.maxMsgIn;

    // ---- the impatient host: Space on UP NEXT and on results (legitimate host control, saves ~9 s/round)
    if (!PATIENT && !st.paused && !st.menu) {
      if (st.phase === 'intro' && st.rid !== lastIntroRid) {
        lastIntroRid = st.rid;
        await sleep(800);
        await press(' ');
      } else if (st.phase === 'results' && res && res.rid !== lastResSkip) {
        lastResSkip = res.rid;
        await sleep(1500);
        await press(' ');
      }
    }
    // ---- chaos / keys / heat / reload
    if (CHAOS && now > nextChaos) {
      nextChaos = now + 4000 + rnd() * 12000;
      void chaosStep();
    }
    if (KEYS && now > nextKey) {
      nextKey = now + 3000 + rnd() * 17000;
      void keyStep();
    }
    if (HEAT && resultsSeen >= nextHeat) {
      nextHeat += 15 + Math.floor(rnd() * 15);
      const h = 1 + Math.floor(rnd() * 3);
      await setting('maxHeat', h);
      log(`maxHeat → ${h}`);
    }
    if (RELOAD && resultsSeen >= nextReload && (st.phase === 'lobby' || st.phase === 'play')) {
      nextReload += 50 + Math.floor(rnd() * 30);
      reloads++;
      log(`host reload #${reloads} during ${st.phase}`);
      await page.reload();
      await page.waitForFunction(() => !!(window as unknown as RW).__rush && (window as unknown as RW).__party?.getState().screen === 'race', undefined, { timeout: 60_000 }).catch((e) => fail(`reload: ${String(e)}`));
      await setting('autoSec', 3);
      // A round that was running is dropped without points: the board must equal the ledger again.
      const after = await page.evaluate(() => (window as unknown as RW).__rush!.getState());
      if (after.roundsPlayed !== lastRoundsPlayed) fail(`reload: roundsPlayed ${after.roundsPlayed} ≠ ${lastRoundsPlayed}`);
      lastRid = after.lastResults?.rid ?? lastRid;
      cur = '';
      maxShellErrors = after.errors.length;
    }
  }

  // ---------------------------------------------------------------- summary
  const secs = (Date.now() - t0) / 1000;
  const allBots = [...bots, ...retired];
  const botIn = allBots.reduce((a, b) => a + b.bytesIn, 0);
  const botOut = allBots.reduce((a, b) => a + b.bytesOut, 0);
  const fin = await page.evaluate(() => (window as unknown as RW).__rush!.getState()).catch(() => null);
  const summary = {
    ok: failures.length === 0 && resultsSeen >= ROUNDS,
    rounds: resultsSeen,
    target: ROUNDS,
    minutes: +(secs / 60).toFixed(1),
    roundsPerHour: +((resultsSeen / secs) * 3600).toFixed(1),
    bots: NBOTS,
    phases: phaseCount,
    maxPhaseSeconds: Object.fromEntries(Object.entries(maxPhase).map(([k, v]) => [k, +v.toFixed(1)])),
    games,
    heatAtResults: heats,
    keys: keyCount,
    chaos: chaosCount,
    reloads,
    pageErrors,
    shellErrors: fin?.errors ?? null,
    traffic: {
      hostInBytesPerSec: Math.round(traffic.hostIn / secs),
      hostOutBytesPerSec: Math.round(traffic.hostOut / secs),
      hostFramesInPerSec: +(traffic.framesIn / secs).toFixed(1),
      hostFramesOutPerSec: +(traffic.framesOut / secs).toFixed(1),
      largestHostFrameIn: traffic.hostMaxIn,
      largestHostFrameOut: traffic.hostMaxOut,
      botsInBytesPerSec: Math.round(botIn / secs),
      botsOutBytesPerSec: Math.round(botOut / secs),
      largestPhoneMessage: Math.max(maxPhoneMsg, ...allBots.map((b) => b.maxMsgIn)),
      shellMaxPhoneMsg: fin?.msgBytes.max ?? null,
    },
    finalBoard: fin ? fin.players.filter((p) => !p.bot).map((p) => `${p.id}:${p.pts}:${p.st}`) : null,
    failures: failures.slice(0, 100),
  };
  const json = JSON.stringify(summary, null, 2);
  console.log(json);
  if (OUT) fs.writeFileSync(OUT, json);
  await Promise.all(bots.map((b) => b.close().catch(() => undefined)));
  await browser.close();
  process.exit(summary.ok ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('[soak] fatal', err);
  process.exit(2);
});
