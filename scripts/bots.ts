/**
 * Bot phones for Kart Party: fake controllers that speak the real wire protocol.
 *
 * Library use (Node, e.g. Playwright tests):
 *   import { BotPhone } from '../scripts/bots';
 *   const bot = await BotPhone.connect('http://localhost:3000');   // first room with a host
 *   bot.profile('Bot', 'zippy'); bot.ready(true);
 *   await bot.waitForScreen('lobby');
 *   bot.setInput({ throttle: 1, steer: -0.5 }); bot.startDriving();
 *
 * CLI (manual soak tests):
 *   npm run bots -- --url http://localhost:3000 --n 4 [--room ABCD] [--race]
 *     --race      leader skips the tutorial to get racing quickly
 *     --passive   bots never press leader buttons (a human leads)
 *     --laps N    laps for the race the leader sets up (default 2)
 *     --track ID  track for the race (default: whatever the host proposes)
 *     --chaos     every ~15 s drop a random bot and reconnect it with its token
 *     --duration S  exit after S seconds
 */
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import {
  PROTOCOL_VERSION,
  WS_PATH,
  encodeInput,
  type DecodedInput,
  type PhoneFx,
  type PhoneRaceStatus,
  type PhoneState,
  type PhoneToHost,
  type RaceSetup,
  type ScreenId,
  type ServerError,
} from '../src/net/protocol';

export type BotInput = Omit<DecodedInput, 'seq' | 'itemPresses'>;

export class BotConnectError extends Error {
  constructor(
    readonly code: ServerError['code'] | 'timeout' | 'socket',
    message: string,
  ) {
    super(message);
  }
}

interface DebugRoom {
  room: string;
  hostConnected: boolean;
  players: { playerId: string; connected: boolean }[];
}

/** Resolve http(s)://host:port -> ws(s)://host:port/ws */
function wsUrlFor(baseUrl: string): string {
  const u = new URL(baseUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = WS_PATH;
  u.search = '';
  return u.toString();
}

export class BotPhone {
  playerId = '';
  token = '';
  room = '';
  /** True if the last join was a reclaim of a known token. */
  rejoin = false;
  connected = false;
  hostConnected = false;
  /** Latest full menu snapshot from the host. */
  state: PhoneState | null = null;
  /** Latest in-race status from the host. */
  race: PhoneRaceStatus | null = null;
  /** All fx events received (oldest first). */
  fx: PhoneFx[] = [];
  /** Last server error received (e.g. kicked). */
  lastError: ServerError | null = null;
  /** Close code of the socket once closed. */
  closeCode: number | null = null;
  /** Every message received (parsed), for debugging/tests. Capped at 500. */
  log: unknown[] = [];

  private ws: WebSocket;
  private listeners = new Set<() => void>();
  private input: BotInput = { steer: 0, throttle: 0, brake: 0, drift: false, itemHeld: false, lookBack: false };
  private itemPresses = 0;
  private seq = 0;
  private driveTimer: NodeJS.Timeout | null = null;
  private autoTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private pingId = 0;
  private pendingPings = new Map<number, (ms: number) => void>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
  }

  /**
   * Connect and join a room. Without `room`, joins the first room (from
   * /api/debug/rooms) whose host is connected. With `token`, reclaims that identity.
   * Rejects with BotConnectError (code 'no_room' | 'room_full' | ...).
   */
  static async connect(baseUrl: string, room?: string, token?: string, timeoutMs = 5000): Promise<BotPhone> {
    let code = room;
    if (!code) code = await BotPhone.findRoom(baseUrl, timeoutMs);
    const ws = new WebSocket(wsUrlFor(baseUrl), { perMessageDeflate: false, rejectUnauthorized: false });
    const bot = new BotPhone(ws);
    ws.on('message', (data, isBinary) => {
      if (!isBinary) bot.onMessage(data.toString());
    });
    ws.on('error', () => undefined); // surfaced via close / connect rejection
    ws.on('close', (c) => {
      bot.closeCode = c;
      bot.connected = false;
      bot.stopTimers();
      bot.notify();
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new BotConnectError('timeout', `join timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      ws.once('open', () => {
        const hello = { t: 'join', room: code, v: PROTOCOL_VERSION, ...(token ? { token } : {}) };
        ws.send(JSON.stringify(hello));
      });
      const check = (): void => {
        if (bot.connected) {
          clearTimeout(timer);
          bot.listeners.delete(check);
          resolve();
        } else if (bot.lastError) {
          clearTimeout(timer);
          bot.listeners.delete(check);
          reject(new BotConnectError(bot.lastError.code, bot.lastError.message));
        } else if (bot.closeCode !== null) {
          clearTimeout(timer);
          bot.listeners.delete(check);
          reject(new BotConnectError('socket', `socket closed (${bot.closeCode}) before joining`));
        }
      };
      bot.listeners.add(check);
      ws.once('error', (err) => {
        clearTimeout(timer);
        bot.listeners.delete(check);
        reject(new BotConnectError('socket', err.message));
      });
    });
    // App-level liveness ping, like the real phone (every 2 s).
    bot.pingTimer = setInterval(() => bot.ws.readyState === WebSocket.OPEN && bot.ws.send(JSON.stringify({ t: 'ping', id: ++bot.pingId })), 2000);
    bot.pingTimer.unref();
    return bot;
  }

  /** First room with a connected host (polls /api/debug/rooms until timeout). */
  static async findRoom(baseUrl: string, timeoutMs = 5000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const res = await fetch(new URL('/api/debug/rooms', baseUrl));
        const rooms = (await res.json()) as DebugRoom[];
        const r = rooms.find((x) => x.hostConnected);
        if (r) return r.room;
      } catch {
        // server not up yet
      }
      if (Date.now() > deadline) throw new BotConnectError('no_room', 'no room with a connected host found');
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // ----------------------------------------------------------------- receive

  private onMessage(raw: string): void {
    let m: unknown;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (this.log.length >= 500) this.log.shift();
    this.log.push(m);
    if (typeof m !== 'object' || m === null || Array.isArray(m)) return;
    const msg = m as { t?: unknown } & Record<string, unknown>;
    switch (msg.t) {
      case 'joined':
        this.playerId = String(msg.playerId);
        this.token = String(msg.token);
        this.room = String(msg.room);
        this.rejoin = msg.rejoin === true;
        this.connected = true;
        break;
      case 'error':
        this.lastError = msg as unknown as ServerError;
        break;
      case 'host':
        this.hostConnected = msg.connected === true;
        break;
      case 'pong': {
        const cb = this.pendingPings.get(Number(msg.id));
        if (cb) {
          this.pendingPings.delete(Number(msg.id));
          cb(performance.now());
        }
        break;
      }
      case 'state':
        this.state = msg as unknown as PhoneState;
        break;
      case 'race':
        this.race = msg as unknown as PhoneRaceStatus;
        break;
      case 'fx':
        this.fx.push(msg as unknown as PhoneFx);
        if (this.fx.length > 200) this.fx.shift();
        break;
    }
    this.notify();
  }

  private notify(): void {
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        // a broken predicate must not break the bot
      }
    }
  }

  /** Resolve once `pred(this)` is true (checked on every message). Rejects after timeoutMs. */
  waitFor(pred: (b: BotPhone) => boolean, timeoutMs = 10000, what = 'condition'): Promise<this> {
    return new Promise((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer);
        clearInterval(poll);
        this.listeners.delete(check);
      };
      const check = (): void => {
        let ok = false;
        try {
          ok = pred(this);
        } catch {
          ok = false;
        }
        if (ok) {
          done();
          resolve(this);
        }
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`[bot ${this.playerId || '?'}] timed out after ${timeoutMs} ms waiting for ${what} (screen=${this.state?.screen ?? 'none'})`));
      }, timeoutMs);
      const poll = setInterval(check, 50);
      this.listeners.add(check);
      check();
    });
  }

  waitForScreen(screen: ScreenId, timeoutMs = 10000): Promise<this> {
    return this.waitFor((b) => b.state?.screen === screen, timeoutMs, `screen '${screen}'`);
  }

  // -------------------------------------------------------------------- send

  /** Send a raw phone->host message (object) or input packet. No-op if closed. */
  send(m: PhoneToHost | readonly unknown[]): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  profile(name: string, characterId: string): void {
    this.send({ t: 'profile', name, characterId });
  }
  ready(ready = true): void {
    this.send({ t: 'ready', ready });
  }
  howto(): void {
    this.send({ t: 'howto' });
  }
  tutOk(): void {
    this.send({ t: 'tut_ok' });
  }
  tutSkip(): void {
    this.send({ t: 'tut_skip' });
  }
  start(): void {
    this.send({ t: 'start' });
  }
  setup(setup: Partial<RaceSetup>): void {
    this.send({ t: 'setup', setup });
  }
  pause(): void {
    this.send({ t: 'pause' });
  }
  resume(): void {
    this.send({ t: 'resume' });
  }
  restart(): void {
    this.send({ t: 'restart' });
  }
  quit(): void {
    this.send({ t: 'quit' });
  }
  post(action: 'next' | 'replay' | 'track' | 'lobby'): void {
    this.send({ t: 'post', action });
  }
  leader(to: string): void {
    this.send({ t: 'leader', to });
  }
  tips(enabled: boolean): void {
    this.send({ t: 'tips', enabled });
  }
  leave(): void {
    this.send({ t: 'leave' });
  }

  /** App-level ping round trip to the server, in ms. */
  ping(timeoutMs = 3000): Promise<number> {
    const id = ++this.pingId;
    const t0 = performance.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPings.delete(id);
        reject(new Error('ping timeout'));
      }, timeoutMs);
      this.pendingPings.set(id, (t1) => {
        clearTimeout(timer);
        resolve(t1 - t0);
      });
      this.send({ t: 'ping', id } as unknown as PhoneToHost);
    });
  }

  // ------------------------------------------------------------------- input

  /** Merge into the current input state (sent by the 60 Hz loop / sendInput). */
  setInput(i: Partial<BotInput>): void {
    this.input = { ...this.input, ...i };
  }
  getInput(): Readonly<BotInput> {
    return this.input;
  }
  /** Send one input packet now with the current state. */
  sendInput(): void {
    this.send(encodeInput(this.seq++, { ...this.input, itemPresses: this.itemPresses }));
  }
  /** One ITEM tap: bumps the press counter and sends immediately. */
  pressItem(): void {
    this.itemPresses = (this.itemPresses + 1) & 255;
    this.sendInput();
  }
  /** Start sending input packets at ~60 Hz. */
  startDriving(hz = 60): void {
    if (this.driveTimer) return;
    this.driveTimer = setInterval(() => this.sendInput(), 1000 / hz);
  }
  stopDriving(): void {
    if (this.driveTimer) clearInterval(this.driveTimer);
    this.driveTimer = null;
  }
  get driving(): boolean {
    return this.driveTimer !== null;
  }

  /** Simple scripted driving: full throttle, sinusoidal steering, drift bursts, item taps. */
  startAutoDrive(seed = Math.random() * 10): void {
    this.stopAutoDrive();
    const t0 = Date.now();
    let lastItem = t0;
    this.autoTimer = setInterval(() => {
      const t = (Date.now() - t0) / 1000 + seed;
      const steer = Math.sin(t * 0.9) * 0.6 + Math.sin(t * 2.3) * 0.2;
      const drift = t % 5 > 3.6; // ~1.4 s drift every 5 s
      this.setInput({ throttle: 1, brake: 0, steer: drift ? Math.sign(steer || 1) * 0.9 : steer, drift });
      if (Date.now() - lastItem > 3000) {
        lastItem = Date.now();
        this.pressItem();
      }
    }, 50);
    this.startDriving();
  }
  stopAutoDrive(): void {
    if (this.autoTimer) clearInterval(this.autoTimer);
    this.autoTimer = null;
    this.stopDriving();
    this.setInput({ throttle: 0, steer: 0, drift: false, brake: 0 });
  }

  // --------------------------------------------------------------- lifecycle

  private stopTimers(): void {
    this.stopDriving();
    if (this.autoTimer) clearInterval(this.autoTimer);
    this.autoTimer = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  /** Hard drop (like a phone losing Wi-Fi). Keeps `token` so you can reconnect with it. */
  disconnect(): void {
    this.stopTimers();
    this.connected = false;
    this.ws.terminate();
  }

  /** Clean close. Resolves when the socket is closed. */
  close(): Promise<void> {
    this.stopTimers();
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once('close', () => resolve());
      try {
        this.ws.close(1000, 'bye');
      } catch {
        this.ws.terminate();
      }
      setTimeout(() => {
        this.ws.terminate();
        resolve();
      }, 1000).unref();
    });
  }
}

// ===========================================================================
// CLI
// ===========================================================================

const ROSTER = ['zippy', 'pixel', 'fennec', 'max', 'juno', 'kai', 'bram', 'rosa'];

interface CliOpts {
  url: string;
  n: number;
  room?: string;
  race: boolean;
  passive: boolean;
  laps: number;
  track?: string;
  chaos: boolean;
  duration: number;
}

function parseCli(argv: string[]): CliOpts {
  const o: CliOpts = { url: 'http://localhost:3000', n: 4, race: false, passive: false, laps: 2, chaos: false, duration: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = (): string => argv[++i] ?? '';
    if (a === '--url') o.url = v();
    else if (a === '--n') o.n = Math.max(1, Math.min(4, Number(v()) || 1));
    else if (a === '--room') o.room = v().toUpperCase();
    else if (a === '--race') o.race = true;
    else if (a === '--passive') o.passive = true;
    else if (a === '--laps') o.laps = Math.max(1, Math.min(5, Number(v()) || 2));
    else if (a === '--track') o.track = v();
    else if (a === '--chaos') o.chaos = true;
    else if (a === '--duration') o.duration = Number(v()) || 0;
    else if (a === '-h' || a === '--help') {
      console.log('npm run bots -- --url http://localhost:3000 --n 4 [--room ABCD] [--race] [--passive] [--laps N] [--track ID] [--chaos] [--duration S]');
      process.exit(0);
    }
  }
  return o;
}

async function runCli(): Promise<void> {
  const o = parseCli(process.argv.slice(2));
  const room = o.room ?? (await BotPhone.findRoom(o.url, 30000));
  console.log(`[bots] joining room ${room} at ${o.url} with ${o.n} bot(s)`);
  const bots: BotPhone[] = [];
  const names = new Map<BotPhone, string>();

  /** Pick a racer not taken by anyone else (based on the host's state). */
  const pickChar = (b: BotPhone, idx: number): string => {
    const taken = new Set(b.state?.takenCharacters ?? []);
    return ROSTER.find((c, k) => k >= idx * 2 && !taken.has(c)) ?? ROSTER.find((c) => !taken.has(c)) ?? ROSTER[idx % ROSTER.length];
  };

  for (let i = 0; i < o.n; i++) {
    try {
      const b = await BotPhone.connect(o.url, room);
      bots.push(b);
      names.set(b, `Bot ${i + 1}`);
      console.log(`[bots] Bot ${i + 1} joined as ${b.playerId}`);
      await new Promise((r) => setTimeout(r, 300));
    } catch (err) {
      console.error(`[bots] Bot ${i + 1} could not join: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!bots.length) process.exit(1);

  // Per-bot flow, driven by the host's PhoneState mirror. Runs every 250 ms.
  const lastAct = new Map<string, number>();
  const once = (key: string, everyMs: number): boolean => {
    const now = Date.now();
    if (now - (lastAct.get(key) ?? 0) < everyMs) return false;
    lastAct.set(key, now);
    return true;
  };
  const tick = (): void => {
    bots.forEach((b, idx) => {
      if (!b.connected) return;
      const st = b.state;
      const you = st?.you;
      const id = b.playerId;
      const leader = !o.passive && !!you?.isLeader;
      const screen = st?.screen;
      const racing = screen === 'race' || screen === 'tutorial';
      if (racing && !b.driving) b.startAutoDrive(idx * 1.7);
      if (!racing && b.driving) b.stopAutoDrive();

      if (screen === 'lobby' || screen === 'waiting' || screen === 'title') {
        if (you && (!you.name || !you.characterId) && once(`${id}:profile`, 2000)) b.profile(names.get(b) ?? 'Bot', pickChar(b, idx));
        else if (you && !you.ready && once(`${id}:ready`, 1500)) b.ready(true);
        if (leader && st && screen === 'lobby' && st.players.filter((p) => p.connected).every((p) => p.ready) && once(`${id}:start`, 3000)) b.start();
      } else if (screen === 'tutorial') {
        if (leader && o.race && once(`${id}:skip`, 3000)) b.tutSkip();
        else if (you && !you.tutorialDone && once(`${id}:tut`, 4000)) b.tutOk();
      } else if (screen === 'setup' && leader) {
        if (once(`${id}:setup`, 4000)) {
          b.setup({ mode: 'single', cc: 150, laps: o.laps, ...(o.track ? { trackId: o.track } : {}) });
          setTimeout(() => b.start(), 800);
        }
      } else if (screen === 'paused' && once(`${id}:resume`, 3000)) {
        b.resume();
      } else if (screen === 'results' && leader && once(`${id}:next`, 5000)) {
        setTimeout(() => b.post('next'), 2500);
      }
    });
  };
  // Make sure everyone has a profile ASAP even if the host hasn't sent state yet.
  bots.forEach((b, idx) => {
    b.profile(names.get(b) ?? 'Bot', ROSTER[(idx * 2) % ROSTER.length]);
    b.ready(true);
  });
  const flow = setInterval(tick, 250);

  const status = setInterval(() => {
    const line = bots
      .map((b) => {
        const r = b.race;
        const s = b.state?.screen ?? '-';
        const race = s === 'race' && r ? ` P${r.place} L${r.lap}/${r.laps}${r.finished ? ' FIN' : ''}${r.item !== 'none' ? ` [${r.item}]` : ''}` : '';
        return `${names.get(b)}(${b.playerId}${b.connected ? '' : ' OFF'}): ${s}${race}`;
      })
      .join(' | ');
    console.log(`[bots] ${line}`);
  }, 2000);

  let chaos: NodeJS.Timeout | null = null;
  if (o.chaos) {
    chaos = setInterval(() => {
      const victims = bots.filter((b) => b.connected && !b.state?.you?.isLeader);
      const v = victims[Math.floor(Math.random() * victims.length)];
      if (!v) return;
      const k = bots.indexOf(v);
      console.log(`[bots] chaos: dropping ${names.get(v)} (${v.playerId})`);
      v.disconnect();
      setTimeout(() => {
        BotPhone.connect(o.url, room, v.token)
          .then((nb) => {
            bots[k] = nb;
            names.set(nb, names.get(v) ?? 'Bot');
            console.log(`[bots] chaos: ${names.get(nb)} back as ${nb.playerId} (rejoin=${nb.rejoin})`);
          })
          .catch((err: unknown) => console.error(`[bots] chaos reconnect failed: ${String(err)}`));
      }, 2000);
    }, 15000);
  }

  const shutdown = async (): Promise<void> => {
    clearInterval(flow);
    clearInterval(status);
    if (chaos) clearInterval(chaos);
    await Promise.all(bots.map((b) => b.close()));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  if (o.duration > 0) setTimeout(() => void shutdown(), o.duration * 1000);
}

// Run the CLI only when executed directly (not when imported by tests).
const isMain = (() => {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();
if (isMain) {
  runCli().catch((err: unknown) => {
    console.error('[bots] fatal:', err);
    process.exit(1);
  });
}
