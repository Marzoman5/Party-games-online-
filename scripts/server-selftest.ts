/**
 * Server self-test: boots the server in-process on a random port with a fake
 * static dir, then drives a fake host + BotPhones through join / relay /
 * reconnect / kick / room_full / host reclaim / liveness, and measures relay
 * latency. Exits non-zero on failure.
 *
 *   npx tsx scripts/server-selftest.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { MAX_PLAYERS, PROTOCOL_VERSION, WS_PATH, type HostWelcome, type ServerToHost } from '../src/net/protocol';
import { startServer } from '../server/app';
import { BotConnectError, BotPhone } from './bots';

// ------------------------------------------------------------------ helpers

let failures = 0;
let passes = 0;
function ok(cond: unknown, what: string): void {
  if (cond) {
    passes++;
    console.log(`  ok   ${what}`);
  } else {
    failures++;
    console.log(`  FAIL ${what}`);
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Fake host page: raw ws client that records everything it receives. */
class FakeHost {
  msgs: unknown[] = [];
  welcome: HostWelcome | null = null;
  closed: number | null = null;
  private waiters = new Set<() => void>();
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      try {
        const m = JSON.parse(d.toString()) as ServerToHost | unknown[];
        this.msgs.push(m);
        if (!Array.isArray(m) && (m as ServerToHost).t === 'hosted') this.welcome = m as HostWelcome;
      } catch {
        /* ignore */
      }
      for (const w of [...this.waiters]) w();
    });
    ws.on('close', (c) => {
      this.closed = c;
      for (const w of [...this.waiters]) w();
    });
  }
  static async open(wsUrl: string, room?: string, hostToken?: string, opts: WebSocket.ClientOptions = {}): Promise<FakeHost> {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, ...opts });
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
    });
    const h = new FakeHost(ws);
    ws.send(JSON.stringify({ t: 'host_hello', v: PROTOCOL_VERSION, room, hostToken }));
    await h.waitFor(() => !!h.welcome, 2000, 'hosted');
    return h;
  }
  send(m: unknown): void {
    this.ws.send(JSON.stringify(m));
  }
  /** Wait for a message matching pred (searching from `from` index). Returns it. */
  async next<T = unknown>(pred: (m: unknown) => boolean, timeoutMs = 2000, what = 'message', from = 0): Promise<T> {
    let found: unknown;
    await this.waitFor(
      () => {
        for (let i = from; i < this.msgs.length; i++) if (pred(this.msgs[i])) return ((found = this.msgs[i]), true);
        return false;
      },
      timeoutMs,
      what,
    );
    return found as T;
  }
  waitFor(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = (): void => {
        if (pred()) {
          clearTimeout(t);
          this.waiters.delete(check);
          resolve();
        }
      };
      const t = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`host timed out waiting for ${what}`));
      }, timeoutMs);
      this.waiters.add(check);
      check();
    });
  }
}

const isT = (t: string, extra: (m: Record<string, unknown>) => boolean = () => true) => (m: unknown): boolean =>
  typeof m === 'object' && m !== null && !Array.isArray(m) && (m as { t?: unknown }).t === t && extra(m as Record<string, unknown>);

async function expectReject(p: Promise<unknown>, code: string, what: string): Promise<void> {
  try {
    await p;
    ok(false, `${what} (expected ${code}, got success)`);
  } catch (err) {
    ok(err instanceof BotConnectError && err.code === code, `${what} -> ${err instanceof BotConnectError ? err.code : String(err)}`);
  }
}

// --------------------------------------------------------------------- main

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-selftest-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>host</title>HOST');
  fs.writeFileSync(path.join(dir, 'play.html'), '<!doctype html><title>play</title>PHONE');
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'assets', 'a.js'), 'console.log(1)');

  const srv = await startServer({ port: 0, staticDir: dir, quiet: true, ws: { pingIntervalMs: 300 } });
  const base = `http://127.0.0.1:${srv.port}`;
  const wsUrl = `ws://127.0.0.1:${srv.port}${WS_PATH}`;
  console.log(`server on ${base}`);
  const bots: BotPhone[] = [];

  try {
    // ---- HTTP
    console.log('HTTP');
    const r1 = await fetch(`${base}/`);
    ok(r1.status === 200 && (await r1.text()).includes('HOST') && r1.headers.get('cache-control') === 'no-cache', 'GET / serves index.html (no-cache)');
    const r2 = await fetch(`${base}/play`);
    ok(r2.status === 200 && (await r2.text()).includes('PHONE'), 'GET /play serves play.html');
    ok((await fetch(`${base}/play/`)).status === 200, 'GET /play/ works');
    const r3 = await fetch(`${base}/play/abcd`, { redirect: 'manual' });
    ok(r3.status === 302 && r3.headers.get('location') === '/play?room=ABCD', 'GET /play/abcd redirects');
    const r4 = await fetch(`${base}/assets/a.js`);
    ok(r4.status === 200 && (r4.headers.get('cache-control') ?? '').includes('immutable'), 'assets long-cached');
    const info = (await (await fetch(`${base}/api/info`)).json()) as { urls: string[]; port: number; httpsPort: number | null };
    ok(Array.isArray(info.urls) && info.urls.length > 0 && info.port === srv.port && info.httpsPort === null, `/api/info ${JSON.stringify(info)}`);
    const qr = await fetch(`${base}/api/qr.svg?data=${encodeURIComponent('http://192.168.1.2:3000/play?room=ABCD')}`);
    ok(qr.status === 200 && (qr.headers.get('content-type') ?? '').includes('image/svg+xml') && (await qr.text()).startsWith('<svg'), '/api/qr.svg returns svg');
    ok((await fetch(`${base}/api/qr.svg?data=${'x'.repeat(600)}`)).status === 400, '/api/qr.svg rejects >512 chars');
    ok((await fetch(`${base}/nope`)).status === 404, 'unknown path 404');

    // ---- host + join
    console.log('Rooms');
    const host = await FakeHost.open(wsUrl);
    const room = host.welcome!.room;
    ok(/^[A-HJ-NP-Z]{4}$/.test(room), `host got room ${room}`);
    ok(host.welcome!.joinUrl.endsWith(`/play?room=${room}`) && host.welcome!.urls.length > 0, `joinUrl ${host.welcome!.joinUrl}`);
    const dbg = (await (await fetch(`${base}/api/debug/rooms`)).json()) as { room: string; hostConnected: boolean }[];
    ok(dbg.some((r) => r.room === room && r.hostConnected), '/api/debug/rooms lists room');

    const a = await BotPhone.connect(base); // auto-discovers the room
    bots.push(a);
    ok(a.playerId === 'p1' && a.room === room && !a.rejoin && a.token.length > 10, `phone A joined as ${a.playerId}`);
    await host.next(isT('p_join', (m) => m.p === 'p1' && m.rejoin === false), 2000, 'p_join p1');
    ok(true, 'host got p_join p1');
    await a.waitFor((b) => b.hostConnected, 1000, 'host status');
    ok(a.hostConnected, 'phone A told host connected');

    const b = await BotPhone.connect(base, room.toLowerCase());
    bots.push(b);
    ok(b.playerId === 'p2', `phone B joined with lowercase code as ${b.playerId}`);

    // ---- relay
    console.log('Relay');
    let mark = host.msgs.length;
    a.setInput({ steer: -0.5, throttle: 1, drift: true });
    a.pressItem();
    const pkt = await host.next<unknown[]>((m) => Array.isArray(m) && m[7] === 'p1', 2000, 'input', mark);
    ok(pkt.length === 8 && pkt[2] === -50 && pkt[3] === 100 && pkt[5] === 1 && pkt[6] === 1, `relayed input ${JSON.stringify(pkt)}`);
    mark = host.msgs.length;
    a.profile('Alice', 'zippy');
    const from = await host.next<{ m: { name: string } }>(isT('from', (m) => m.p === 'p1'), 2000, 'from', mark);
    ok(from.m.name === 'Alice', 'profile wrapped as FromPhone');
    host.send({ t: 'to', p: 'p1', m: { t: 'state', screen: 'lobby', room, you: null, players: [], takenCharacters: [], setup: { mode: 'single', trackId: 'x', cc: 100, laps: 3 }, gp: null, tutorial: null, pause: null, results: null, tipsEnabled: true } });
    await a.waitForScreen('lobby', 2000);
    ok(a.state?.screen === 'lobby' && b.state === null, 'HostSend to one phone');
    host.send({ t: 'to', p: '*', m: { t: 'fx', kind: 'go' } });
    await Promise.all([a.waitFor((x) => x.fx.length > 0, 2000), b.waitFor((x) => x.fx.length > 0, 2000)]);
    ok(true, 'HostSend broadcast to all phones');

    // ---- PARTY HUB: Smash fight packets (tag 1) + new phone->host message types
    console.log('Party Hub relay');
    mark = host.msgs.length;
    a.setFightInput({ x: -0.5, y: 1, shield: true });
    a.press('attack', 50);
    const fpkt = await host.next<unknown[]>((m) => Array.isArray(m) && m[0] === 1 && m[9] === 'p1', 2000, 'fight input', mark);
    ok(
      fpkt.length === 10 && fpkt[2] === -50 && fpkt[3] === 100 && fpkt[4] === (1 | 8) && fpkt[5] === 1 && fpkt[6] === 0 && fpkt[7] === 0 && fpkt[8] === 0,
      `relayed fight input ${JSON.stringify(fpkt)}`,
    );
    await sleep(120);
    mark = host.msgs.length;
    a.flickAttack('right', 30);
    const flick = await host.next<unknown[]>((m) => Array.isArray(m) && m[0] === 1 && m[9] === 'p1', 2000, 'flick input', mark);
    ok(flick[2] === 100 && (Number(flick[4]) & 32) !== 0 && (Number(flick[4]) & 1) !== 0 && flick[5] === 2, `flick attack packet ${JSON.stringify(flick)}`);
    a.setFightInput({ x: 0, y: 0, shield: false });
    // Raw packets: extra trailing fields are dropped, wrong/short ones ignored, tag 0 unchanged.
    mark = host.msgs.length;
    a.send([1, 77, 10, -20, 4, 9, 8, 7, 6, 'spoofed', 99] as unknown[]);
    const raw1 = await host.next<unknown[]>((m) => Array.isArray(m) && m[0] === 1 && m[1] === 77, 2000, 'raw fight packet', mark);
    ok(JSON.stringify(raw1) === JSON.stringify([1, 77, 10, -20, 4, 9, 8, 7, 6, 'p1']), `fight packet relayed as [1..8, playerId] ${JSON.stringify(raw1)}`);
    mark = host.msgs.length;
    a.send([1, 78, 1, 2, 3, 4, 5, 6] as unknown[]); // too short
    a.send([1, 79, 1, 2, 3, 4, 5, 6, 'x'] as unknown[]); // non-numeric
    a.send([1, 80, 1, 2, 3, NaN, 5, 6, 7] as unknown[]); // NaN -> null in JSON
    a.send([3, 81, 1, 2, 3, 4, 5, 6, 7] as unknown[]); // unknown tag
    a.send([2, 83, 1, 2, 3] as unknown[]); // rush stream too short
    a.send([2, 84, 1, 'x', 3, 4] as unknown[]); // rush stream non-numeric
    a.send([0, 82, 10, 100, 0, 1, 3] as unknown[]); // kart packet still relays (marker)
    const kartAfter = await host.next<unknown[]>((m) => Array.isArray(m) && m[0] === 0 && m[1] === 82, 2000, 'kart marker', mark);
    ok(JSON.stringify(kartAfter) === JSON.stringify([0, 82, 10, 100, 0, 1, 3, 'p1']), 'tag 0 kart packet unchanged');
    ok(!host.msgs.slice(mark).some((m) => Array.isArray(m) && [78, 79, 80, 81, 83, 84].includes(m[1] as number)), 'malformed / unknown-tag packets dropped');
    // PARTY RUSH: tag-2 stream packets relay as [2, seq, rid, a, b, c, playerId] (extra fields dropped).
    mark = host.msgs.length;
    a.send([2, 85, 3, 400, -250, 1000, 'spoofed'] as unknown[]);
    const rush = await host.next<unknown[]>((m) => Array.isArray(m) && m[0] === 2 && m[1] === 85, 2000, 'rush stream packet', mark);
    ok(JSON.stringify(rush) === JSON.stringify([2, 85, 3, 400, -250, 1000, 'p1']), `rush stream relayed as [2..5, playerId] ${JSON.stringify(rush)}`);
    // Hot path ordering: fight packets arrive in send order, immediately.
    mark = host.msgs.length;
    for (let i = 0; i < 50; i++) a.send([1, 1000 + i, 0, 0, 0, 0, 0, 0, 0] as unknown[]);
    await host.next((m) => Array.isArray(m) && m[1] === 1049, 2000, 'burst end', mark);
    const seqs = host.msgs.slice(mark).filter((m) => Array.isArray(m) && m[0] === 1).map((m) => (m as number[])[1]);
    ok(seqs.length === 50 && seqs.every((v, i) => v === 1000 + i), 'fight packet burst relayed in order');
    // New control messages.
    const hubMsgs: [string, () => void, (m: Record<string, unknown>) => boolean][] = [
      ['game', () => a.game('smash'), (m) => m.game === 'smash'],
      ['gsetup', () => a.gsetup({ stageId: 'arena', stocks: 2, items: true }), (m) => (m.setup as { stageId?: string }).stageId === 'arena'],
      ['team', () => a.team(1), (m) => m.team === 1],
      ['practice_done', () => a.practiceDone(), () => true],
      ['post', () => a.post('switch', 'kart'), (m) => m.action === 'switch' && m.game === 'kart'],
      ['post', () => a.post('switch'), (m) => m.action === 'switch' && m.game === undefined],
      ['mg', () => a.send({ t: 'mg', k: 'flick', rid: 4, v: 60, x: 10, y: -5, ms: 312, c: 9 }), (m) => m.k === 'flick' && m.ms === 312],
    ];
    for (const [t, sendIt, check] of hubMsgs) {
      mark = host.msgs.length;
      sendIt();
      const f = await host.next<{ m: Record<string, unknown> }>(isT('from', (m) => m.p === 'p1' && (m.m as { t?: string }).t === t && check(m.m as Record<string, unknown>)), 2000, `from ${t}`, mark);
      ok(!!f, `phone '${t}' relayed to host`);
    }
    // Phones receive the new host->phone t:'fight' status + fx strength.
    host.send({ t: 'to', p: 'p1', m: { t: 'fight', characterId: 'zippy', damage: 42, stocks: 3, score: 0, kos: 1, countdown: 0, timeLeft: -1, out: false, respawning: false, cpu: false, team: 0, item: 'none', suddenDeath: false } });
    host.send({ t: 'to', p: 'p1', m: { t: 'fx', kind: 'hit', strength: 0.7 } });
    await a.waitFor((x) => x.fight?.damage === 42 && x.fx.some((f) => f.kind === 'hit' && f.strength === 0.7), 2000, 'fight status + fx');
    ok(a.fight?.kos === 1, 'bot tracks t:fight status and fx strength');

    // Smash bot brain: recovers when offstage (double jump, then up+special toward the stage) and
    // attacks a nearby opponent.
    console.log('Smash bot brain');
    {
      const stage = { left: -7, right: 7, y: 0 };
      const fighter = (index: number, x: number, y: number, extra: Partial<Record<string, unknown>> = {}) => ({
        index, slot: index, human: true, x, y, vx: 0, vy: -0.05, grounded: false, action: 'fall', damage: 0, ...extra,
      });
      const before = a.getFightInput();
      a.startSmashBrain(0.5);
      const feed = setInterval(() => a.observe({ self: 0, stage, fighters: [fighter(0, -10, -3), fighter(1, 2, 0, { grounded: true, action: 'idle', vy: 0 })] }), 100);
      a.observe({ self: 0, stage, fighters: [fighter(0, -10, -3), fighter(1, 2, 0, { grounded: true, action: 'idle', vy: 0 })] });
      await sleep(1500);
      clearInterval(feed);
      const after = a.getFightInput();
      ok(after.jumpPresses > before.jumpPresses && after.specialPresses > before.specialPresses, `offstage: double jump + up special (${JSON.stringify(a.brainActions)})`);
      ok(after.x > 0, 'offstage: stick held toward the stage');
      const feed2 = setInterval(() => a.observe({ self: 0, stage, fighters: [fighter(0, 0, 0, { grounded: true, action: 'idle', vy: 0 }), fighter(1, 0.8, 0, { grounded: true, action: 'idle', vy: 0, damage: 30 })] }), 100);
      a.observe({ self: 0, stage, fighters: [fighter(0, 0, 0, { grounded: true, action: 'idle', vy: 0 }), fighter(1, 0.8, 0, { grounded: true, action: 'idle', vy: 0, damage: 30 })] });
      const atk0 = a.getFightInput().attackPresses + a.getFightInput().specialPresses + a.getFightInput().grabPresses;
      await sleep(1500);
      clearInterval(feed2);
      const atk1 = a.getFightInput().attackPresses + a.getFightInput().specialPresses + a.getFightInput().grabPresses;
      ok(atk1 - atk0 >= 2, `close opponent: brain attacks (${atk1 - atk0} presses)`);
      // Stale observations -> blind routine keeps sending harmless inputs.
      await sleep(2600);
      ok(Object.keys(a.brainActions).some((k) => k.startsWith('blind')), 'no fresh observations -> blind routine');
      const sent = a.fightPacketsSent;
      await sleep(300);
      ok(a.fightPacketsSent - sent >= 10, `fight loop sends ~60 Hz (${a.fightPacketsSent - sent} in 300 ms)`);
      a.stopSmashBrain();
      ok(!a.brainRunning && !a.fighting, 'brain + fight loop stopped');
    }

    // ---- malformed input never kills the server
    console.log('Robustness');
    const junk = new WebSocket(wsUrl);
    await new Promise((r) => junk.once('open', r));
    for (const s of ['', 'garbage', '{', '[]', '[0]', '[0,"a",1,2,3,4,5]', '{"t":5}', 'null', '{"t":"join"}', '{"t":"join","room":"ZZZZ","v":1}']) junk.send(s);
    junk.send(Buffer.from([1, 2, 3]), { binary: true });
    a.send([0, 'x', 1, 2, 3, 4, 5] as unknown[]);
    a.send({ t: 'nope' } as never);
    a.send([0, 1, NaN, 2, 3, 4, 5] as unknown[]);
    host.send({ t: 'to', p: 'p1', m: 'notanobject' });
    host.send({ t: 'kick' });
    host.ws.send('{{{');
    await sleep(200);
    const pong = await a.ping();
    ok(pong >= 0, `server alive after junk, ping ${pong.toFixed(2)} ms`);
    await expectReject(BotPhone.connect(base, 'QQQQ'), 'no_room', 'unknown room');
    {
      const ws = new WebSocket(wsUrl);
      await new Promise((r) => ws.once('open', r));
      const got = new Promise<string>((r) => ws.once('message', (d) => r(d.toString())));
      ws.send(JSON.stringify({ t: 'join', room, v: 999 }));
      ok(JSON.parse(await got).code === 'bad_version', 'bad_version');
      ws.terminate();
    }

    // ---- latency: phone -> server -> host -> server -> phone
    console.log('Latency');
    {
      const hostEcho = (d: WebSocket.RawData): void => {
        const s = d.toString();
        if (s.startsWith('[') && s.endsWith('"p2"]')) host.ws.send(JSON.stringify({ t: 'to', p: 'p2', m: { t: 'fx', kind: 'boost' } }));
      };
      host.ws.on('message', hostEcho);
      const samples: number[] = [];
      for (let i = 0; i < 200; i++) {
        const n = b.fx.length;
        const t0 = performance.now();
        b.sendInput();
        await b.waitFor((x) => x.fx.length > n || x.fx.length >= 200, 1000);
        samples.push(performance.now() - t0);
      }
      host.ws.off('message', hostEcho);
      samples.sort((x, y) => x - y);
      const avg = samples.reduce((s, x) => s + x, 0) / samples.length;
      const p95 = samples[Math.floor(samples.length * 0.95)];
      console.log(`  relay round trip phone->host->phone: avg ${avg.toFixed(2)} ms, p50 ${samples[100].toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${samples[199].toFixed(2)} ms`);
      ok(p95 < 20, 'relay p95 < 20 ms on localhost');
    }

    // ---- reconnect
    console.log('Reconnect');
    mark = host.msgs.length;
    const aToken = a.token;
    a.disconnect();
    await host.next(isT('p_leave', (m) => m.p === 'p1'), 2000, 'p_leave p1', mark);
    ok(true, 'host got p_leave on drop');
    mark = host.msgs.length;
    const a2 = await BotPhone.connect(base, room, aToken);
    bots.push(a2);
    ok(a2.playerId === 'p1' && a2.rejoin && a2.token === aToken, `reconnect with token -> ${a2.playerId} rejoin=${a2.rejoin}`);
    await host.next(isT('p_join', (m) => m.p === 'p1' && m.rejoin === true), 2000, 'p_join rejoin', mark);
    ok(true, 'host got p_join rejoin:true');

    // newest wins: same token while old socket still open
    mark = host.msgs.length;
    const b2 = await BotPhone.connect(base, room, b.token);
    bots.push(b2);
    await b.waitFor((x) => x.closeCode !== null, 2000, 'old socket closed');
    ok(b2.playerId === 'p2' && b2.rejoin && b.closeCode === 4001, `same token twice: old closed (${b.closeCode}), new is ${b2.playerId}`);
    await sleep(100);
    ok(!host.msgs.slice(mark).some(isT('p_leave')), 'no p_leave when a socket is replaced');

    // ---- capacity (PARTY RUSH: 16 connected phones per room; 4 → 16 is the only change)
    console.log('Capacity');
    const c = await BotPhone.connect(base, room);
    const d = await BotPhone.connect(base, room);
    bots.push(c, d);
    ok(c.playerId === 'p3' && d.playerId === 'p4', `p3/p4 joined (${c.playerId}, ${d.playerId})`);
    const more: BotPhone[] = [];
    for (let i = 5; i <= MAX_PLAYERS; i++) more.push(await BotPhone.connect(base, room));
    bots.push(...more);
    ok(more.length === MAX_PLAYERS - 4 && more[more.length - 1].playerId === `p${MAX_PLAYERS}`, `p5..p${MAX_PLAYERS} joined (${more.length} more)`);
    await expectReject(BotPhone.connect(base, room), 'room_full', `${MAX_PLAYERS + 1}th phone`);
    d.disconnect();
    await host.next(isT('p_leave', (m) => m.p === 'p4'), 2000, 'p_leave p4');
    const e = await BotPhone.connect(base, room);
    bots.push(e);
    const eId = `p${MAX_PLAYERS + 1}`;
    ok(e.playerId === eId && !e.rejoin, `new phone evicts stale seat -> ${e.playerId}`);
    await expectReject(BotPhone.connect(base, room, d.token), 'room_full', 'evicted token cannot reclaim while full');
    const seats = (await (await fetch(`${base}/api/debug/rooms`)).json()) as { room: string; players: { playerId: string }[] }[];
    const expectSeats = ['p1', 'p2', 'p3', ...more.map((b) => b.playerId), eId].join(',');
    ok(seats.find((r) => r.room === room)?.players.map((p) => p.playerId).join(',') === expectSeats, `seats are p1,p2,p3,p5..${eId}`);
    for (const b of more) b.disconnect();

    // ---- kick
    console.log('Kick');
    host.send({ t: 'kick', p: eId });
    await e.waitFor((x) => x.closeCode !== null, 2000, 'kick close');
    ok(e.lastError?.code === 'kicked' && e.closeCode === 4002, `kicked phone got error+close (${e.lastError?.code}, ${e.closeCode})`);
    const e2 = await BotPhone.connect(base, room, e.token);
    bots.push(e2);
    const e2Id = `p${MAX_PLAYERS + 2}`;
    ok(!e2.rejoin && e2.playerId === e2Id, `kicked token is forgotten -> new seat ${e2.playerId}`);

    // ---- host reclaim
    console.log('Host reclaim');
    const hostToken = host.welcome!.hostToken;
    host.ws.terminate();
    await a2.waitFor((x) => !x.hostConnected, 2000, 'host gone');
    ok(true, 'phones told host disconnected');
    const hostB = await FakeHost.open(wsUrl, room.toLowerCase(), hostToken);
    ok(hostB.welcome!.room === room && hostB.welcome!.players.length === MAX_PLAYERS, `host reclaimed ${hostB.welcome!.room} with ${hostB.welcome!.players.length} players`);
    await a2.waitFor((x) => x.hostConnected, 2000, 'host back');
    ok(true, 'phones told host reconnected');

    // second tab with same token: newest wins
    const hostC = await FakeHost.open(wsUrl, room, hostToken);
    await hostB.waitFor(() => hostB.closed !== null, 2000, 'old host closed');
    ok(hostC.welcome!.room === room && hostB.closed === 4001, `second host tab takes over, old closed ${hostB.closed}`);
    const mk = hostC.msgs.length;
    a2.sendInput();
    await hostC.next((m) => Array.isArray(m) && m[7] === 'p1', 2000, 'input to new host', mk);
    ok(true, 'inputs flow to newest host');

    // wrong token / no room -> new room
    const hostD = await FakeHost.open(wsUrl, room, 'wrong-token-123');
    ok(hostD.welcome!.room !== room, `wrong hostToken gets a new room (${hostD.welcome!.room})`);
    const hostE = await FakeHost.open(wsUrl);
    ok(hostE.welcome!.room !== room && hostE.welcome!.room !== hostD.welcome!.room, 'host_hello without room -> new room');
    // server forgot the room (restart): returning host gets the same code back
    const hostF = await FakeHost.open(wsUrl, 'WXYZ', 'abcdef0123456789');
    ok(hostF.welcome!.room === 'WXYZ' && hostF.welcome!.hostToken === 'abcdef0123456789', 'unknown room+token recreated with same code');

    // ---- liveness: a client that never answers ws pings gets dropped
    console.log('Liveness');
    {
      const ws = new WebSocket(wsUrl, { autoPong: false });
      await new Promise((r) => ws.once('open', r));
      const mk2 = hostF.msgs.length;
      ws.send(JSON.stringify({ t: 'join', room: 'WXYZ', v: PROTOCOL_VERSION }));
      const t0 = Date.now();
      const closed = new Promise<void>((r) => ws.once('close', () => r()));
      await hostF.next(isT('p_join'), 2000, 'p_join for silent socket', mk2);
      await hostF.next(isT('p_leave'), 3000, 'p_leave for silent socket', mk2);
      await closed;
      ok(true, `silent socket dropped after ${Date.now() - t0} ms (ping 300 ms)`);
    }
    hostC.ws.close();
    hostD.ws.close();
    hostE.ws.close();
    hostF.ws.close();

    // ---- room expiry (rooms survive 30 min without a host)
    console.log('Expiry');
    await sleep(200);
    srv.hub.sweep(Date.now() + 29 * 60_000);
    ok(srv.hub.rooms.has(room), 'room kept 29 min after host left');
    srv.hub.sweep(Date.now() + 31 * 60_000);
    await a2.waitFor((x) => x.closeCode !== null, 2000, 'expiry close');
    ok(srv.hub.rooms.size === 0 && a2.lastError?.code === 'host_gone', `rooms expired after 30 min, phones told host_gone`);
  } catch (err) {
    failures++;
    console.log(`  FAIL exception: ${err instanceof Error ? err.stack : String(err)}`);
  } finally {
    await Promise.all(bots.map((x) => x.close()));
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

void main();
