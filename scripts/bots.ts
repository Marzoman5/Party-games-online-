/**
 * Bot phones for Party Hub (Kart Party + Smash Party): fake controllers that speak the real
 * wire protocol.
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
 *     --game smash  play Smash Party instead: leader picks Smash, skips the tutorial, bots
 *                   practise in the sandbox and tap "I'm ready", leader sets up a stock match
 *                   (--stocks N, --stage ID, --teams, --cpus N), bots fight with a blind brain,
 *                   leader picks Rematch after each match.
 *
 * Smash Party (library):
 *   bot.game('smash'); bot.gsetup({ stageId: 'arena', stocks: 2 }); bot.team(1); bot.practiceDone();
 *   bot.startFightLoop();                       // 60 Hz fight packets ([1, seq, x, y, buttons, ...])
 *   bot.setFightInput({ x: 1 });                // walk right
 *   bot.press('attack');                        // +1 press counter, held bit, sent at once, released later
 *   bot.flickAttack('right');                   // smash attack
 *   bot.startSmashBrain(); bot.observe(view);   // AI that plays (feed it __smash.getState() at 5–10 Hz)
 */
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import {
  PROTOCOL_VERSION,
  WS_PATH,
  encodeFightInput,
  encodeInput,
  type DecodedFightInput,
  type DecodedInput,
  type GameId,
  type PhoneFightStatus,
  type PhoneFx,
  type PhoneRaceStatus,
  type PhoneState,
  type PhoneToHost,
  type RaceSetup,
  type ScreenId,
  type ServerError,
  type SmashSetup,
} from '../src/net/protocol';

export type BotInput = Omit<DecodedInput, 'seq' | 'itemPresses'>;

/** Held state of the Smash fight controller (press counters are managed by the bot). */
export type FightHeld = Pick<DecodedFightInput, 'x' | 'y' | 'attack' | 'special' | 'jump' | 'shield' | 'grab' | 'flick'>;
export type FightButton = 'attack' | 'special' | 'jump' | 'grab' | 'shield';
export type FlickDir = 'left' | 'right' | 'up' | 'down';

/** One fighter as the Smash bot brain sees it (a subset of `__smash.getState().fighters[i]`). */
export interface SmashObsFighter {
  index: number;
  /** Lobby slot for humans, -1 for CPUs / dummy. */
  slot: number;
  team?: number;
  human?: boolean;
  dummy?: boolean;
  x: number;
  y: number;
  /** World units per frame. */
  vx: number;
  vy: number;
  grounded: boolean;
  action: string;
  damage: number;
  out?: boolean;
  respawning?: boolean;
  facing?: number;
}

/** What tests feed `bot.observe()`: fighters + the main stage's edges. */
export interface SmashObservation {
  fighters: SmashObsFighter[];
  /** Main stage top surface: x of its left/right edge and y of the top. */
  stage?: { left: number; right: number; y: number };
  /** Fighter index of this bot (default: the human fighter whose slot = this bot's lobby slot). */
  self?: number;
  /** Team mode: don't chase team mates. */
  teams?: boolean;
}

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
  /** Latest Smash Party in-match status from the host (t:'fight', ~10 Hz). */
  fight: PhoneFightStatus | null = null;
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
  // Smash Party fight controller
  private fightHeld: FightHeld = { x: 0, y: 0, attack: false, special: false, jump: false, shield: false, grab: false, flick: false };
  private presses = { attack: 0, special: 0, jump: 0, grab: 0 };
  private fightSeq = 0;
  private fightTimer: NodeJS.Timeout | null = null;
  private releaseTimers = new Set<NodeJS.Timeout>();
  /** Fight packets sent so far (for tests). */
  fightPacketsSent = 0;
  // Smash bot brain
  private brainTimer: NodeJS.Timeout | null = null;
  private obs: SmashObservation | null = null;
  private obsAt = 0;
  private brain = { busyUntil: 0, t0: 0, step: 0, usedDouble: false, usedUp: false, wasGrounded: true, rand: 1, shieldUntil: 0 };
  /** Brain decisions taken (for tests / logs). */
  brainActions: Record<string, number> = {};

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
      case 'fight':
        this.fight = msg as unknown as PhoneFightStatus;
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
  /** Results screen (leader). 'switch' = Switch Game (optionally naming the game to switch to). */
  post(action: 'next' | 'replay' | 'track' | 'lobby' | 'switch', game?: GameId): void {
    this.send(game ? { t: 'post', action, game } : { t: 'post', action });
  }
  /** PARTY HUB: leader picks the active game. */
  game(id: GameId): void {
    this.send({ t: 'game', game: id });
  }
  /** PARTY HUB: leader edits the active game's setup (smash: Partial<SmashSetup>). */
  gsetup(setup: Partial<SmashSetup> | Record<string, unknown>): void {
    this.send({ t: 'gsetup', setup: setup as Record<string, unknown> });
  }
  /** PARTY HUB: pick a team (0 red, 1 blue) in team modes. */
  team(t: number): void {
    this.send({ t: 'team', team: t });
  }
  /** PARTY HUB: sandbox "I'm ready". */
  practiceDone(): void {
    this.send({ t: 'practice_done' });
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


  // ------------------------------------------------------------- smash input

  /** Merge into the held fight state (sent by the 60 Hz fight loop / sendFightInput). */
  setFightInput(i: Partial<FightHeld>): void {
    this.fightHeld = { ...this.fightHeld, ...i };
  }
  getFightInput(): Readonly<FightHeld> & { attackPresses: number; specialPresses: number; jumpPresses: number; grabPresses: number } {
    return {
      ...this.fightHeld,
      attackPresses: this.presses.attack,
      specialPresses: this.presses.special,
      jumpPresses: this.presses.jump,
      grabPresses: this.presses.grab,
    };
  }
  /** Send one fight packet now: [1, seq, x, y, buttons, attackPresses, specialPresses, jumpPresses, grabPresses]. */
  sendFightInput(): void {
    this.fightPacketsSent++;
    this.send(
      encodeFightInput(this.fightSeq++, {
        ...this.fightHeld,
        attackPresses: this.presses.attack,
        specialPresses: this.presses.special,
        jumpPresses: this.presses.jump,
        grabPresses: this.presses.grab,
      }),
    );
  }
  /**
   * Tap (or hold) a button: bumps its press counter (shield has none), sets the held bit, sends
   * immediately, and releases it after `holdMs` (sending the release at once too).
   */
  press(button: FightButton, holdMs = 70): void {
    if (button !== 'shield') this.presses[button] = (this.presses[button] + 1) & 255;
    this.fightHeld = { ...this.fightHeld, [button]: true };
    this.sendFightInput();
    this.later(holdMs, () => {
      this.fightHeld = { ...this.fightHeld, [button]: false };
      this.sendFightInput();
    });
  }
  /** Flick the stick + ATTACK = smash attack in that direction (hold `holdMs` to charge). */
  flickAttack(dir: FlickDir, holdMs = 90): void {
    const x = dir === 'left' ? -1 : dir === 'right' ? 1 : 0;
    const y = dir === 'up' ? 1 : dir === 'down' ? -1 : 0;
    this.presses.attack = (this.presses.attack + 1) & 255;
    this.fightHeld = { ...this.fightHeld, x, y, flick: true, attack: true };
    this.sendFightInput();
    this.later(holdMs, () => {
      this.fightHeld = { ...this.fightHeld, x: 0, y: 0, flick: false, attack: false };
      this.sendFightInput();
    });
  }
  /** Start sending fight packets at ~60 Hz. */
  startFightLoop(hz = 60): void {
    if (this.fightTimer) return;
    this.fightTimer = setInterval(() => this.sendFightInput(), 1000 / hz);
  }
  stopFightLoop(): void {
    if (this.fightTimer) clearInterval(this.fightTimer);
    this.fightTimer = null;
  }
  get fighting(): boolean {
    return this.fightTimer !== null;
  }
  /** Release everything (stick centred, no buttons held). */
  neutralFight(): void {
    for (const t of this.releaseTimers) clearTimeout(t);
    this.releaseTimers.clear();
    this.fightHeld = { x: 0, y: 0, attack: false, special: false, jump: false, shield: false, grab: false, flick: false };
  }
  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.releaseTimers.delete(t);
      fn();
    }, ms);
    this.releaseTimers.add(t);
  }

  // ------------------------------------------------------------- smash brain

  /** Feed the brain a snapshot of the fight (tests: from `__smash.getState()` at ~5–10 Hz). */
  observe(view: SmashObservation): void {
    this.obs = view;
    this.obsAt = Date.now();
  }
  /** Start the Smash bot brain (also starts the 60 Hz fight loop). Without observations it plays blind. */
  startSmashBrain(seed = Math.random()): void {
    this.stopSmashBrain();
    this.brain = { busyUntil: 0, t0: Date.now(), step: 0, usedDouble: false, usedUp: false, wasGrounded: true, rand: Math.floor(seed * 2147483646) + 1, shieldUntil: 0 };
    this.startFightLoop();
    this.brainTimer = setInterval(() => this.think(), 50);
  }
  stopSmashBrain(): void {
    if (this.brainTimer) clearInterval(this.brainTimer);
    this.brainTimer = null;
    this.neutralFight();
    this.stopFightLoop();
    this.sendFightInput();
  }
  get brainRunning(): boolean {
    return this.brainTimer !== null;
  }

  private rnd(): number {
    // Park-Miller LCG: deterministic per bot seed.
    this.brain.rand = (this.brain.rand * 16807) % 2147483647;
    return (this.brain.rand - 1) / 2147483646;
  }
  private act(name: string, busyMs: number): void {
    this.brainActions[name] = (this.brainActions[name] ?? 0) + 1;
    this.brain.busyUntil = Date.now() + busyMs;
  }

  private think(): void {
    if (!this.connected) return;
    const now = Date.now();
    const obs = this.obs;
    if (!obs || now - this.obsAt > 1500) {
      this.thinkBlind(now);
      return;
    }
    const mySlot = this.state?.you?.slot;
    const me =
      (obs.self !== undefined ? obs.fighters.find((f) => f.index === obs.self) : undefined) ??
      obs.fighters.find((f) => f.slot === mySlot && f.human !== false && !f.dummy);
    if (!me || me.out) {
      this.setFightInput({ x: 0, y: 0 });
      return;
    }
    // Extrapolate (observations are 5–10 Hz, positions in world units, velocities per 60 Hz frame).
    const age = Math.min(12, ((now - this.obsAt) / 1000) * 60);
    const mx = me.x + me.vx * age;
    const my = me.y + me.vy * age;
    const stage = obs.stage ?? { left: -7, right: 7, y: 0 };
    const centre = (stage.left + stage.right) / 2;
    const towardStage = mx < centre ? 1 : -1;
    if (me.grounded) {
      this.brain.usedDouble = false;
      this.brain.usedUp = false;
    }
    if (now < this.brain.busyUntil) return;
    if (me.respawning || me.action === 'respawn') {
      // Step off the respawn platform toward the centre.
      this.setFightInput({ x: centre > mx ? 0.5 : -0.5, y: 0, shield: false });
      return;
    }
    const helpless = me.action === 'helpless' || me.action === 'tumble' || me.action === 'hitstun';

    // ---- RECOVERY: offstage or below the stage -> drift back, double jump, up+special.
    const offX = mx < stage.left - 0.2 || mx > stage.right + 0.2;
    const below = my < stage.y - 0.4;
    if (!me.grounded && (offX || below)) {
      this.setFightInput({ x: towardStage, y: 0, shield: false, attack: false });
      if (me.action === 'ledgeHang') {
        this.setFightInput({ x: towardStage, y: 1 });
        this.act('ledgeClimb', 250);
        return;
      }
      if (helpless && me.action === 'helpless') return; // already used up-special: just drift back
      const falling = me.vy < 0.02;
      if (!this.brain.usedDouble && falling && me.action !== 'hitstun' && me.action !== 'tumble') {
        this.brain.usedDouble = true;
        this.press('jump', 80);
        this.act('doubleJump', 300);
        return;
      }
      if (!this.brain.usedUp && falling && (below || Math.abs(mx - centre) > (stage.right - stage.left) / 2 + 1.5) && me.action !== 'hitstun') {
        this.brain.usedUp = true;
        this.setFightInput({ x: towardStage * 0.5, y: 1 });
        this.press('special', 120);
        this.act('upSpecial', 500);
        return;
      }
      return;
    }

    // ---- pick a target: nearest opponent still in play.
    let best: SmashObsFighter | null = null;
    let bestD = Infinity;
    for (const f of obs.fighters) {
      if (f.index === me.index || f.out || f.respawning || f.action === 'ko' || f.action === 'out') continue;
      if (obs.teams && f.team !== undefined && f.team === me.team) continue;
      const d = Math.hypot(f.x - mx, f.y - my);
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    if (!best) {
      // Nobody to fight: drift to the centre and idle.
      this.setFightInput({ x: Math.abs(centre - mx) > 1 ? Math.sign(centre - mx) * 0.6 : 0, y: 0, shield: false });
      return;
    }
    const tx = best.x + best.vx * age;
    const ty = best.y + best.vy * age;
    const dx = tx - mx;
    const dy = ty - my;
    const dir = dx >= 0 ? 1 : -1;
    const dirName: FlickDir = dir > 0 ? 'right' : 'left';
    // Don't run off the stage chasing someone who is offstage.
    const edgeAhead = me.grounded && ((dir > 0 && mx > stage.right - 0.8) || (dir < 0 && mx < stage.left + 0.8));

    // Shield sometimes when an opponent is attacking right next to us.
    if (me.grounded && Math.abs(dx) < 1.8 && best.action === 'attack' && this.rnd() < 0.25) {
      this.setFightInput({ x: 0, y: 0, shield: true });
      this.later(350, () => this.setFightInput({ shield: false }));
      this.act('shield', 420);
      return;
    }
    this.setFightInput({ shield: false });

    const close = Math.abs(dx) < 1.5 && Math.abs(dy) < 1.4;
    if (close) {
      const r = this.rnd();
      this.setFightInput({ x: 0, y: 0 });
      if (me.grounded) {
        if (best.damage >= 80 && r < 0.6) {
          this.flickAttack(dy > 1 ? 'up' : dirName, 120);
          this.act('smash', 650);
        } else if (dy > 0.9 && r < 0.5) {
          this.setFightInput({ x: 0, y: 0.8 });
          this.press('attack');
          this.later(90, () => this.setFightInput({ y: 0 }));
          this.act('utilt', 350);
        } else if (r < 0.35) {
          this.press('attack');
          this.act('jab', 220);
        } else if (r < 0.65) {
          this.setFightInput({ x: dir * 0.6, y: 0 });
          this.press('attack');
          this.later(90, () => this.setFightInput({ x: 0 }));
          this.act('ftilt', 380);
        } else if (r < 0.8) {
          this.setFightInput({ x: 0, y: 0 });
          this.press('special');
          this.act('nspecial', 500);
        } else if (r < 0.9) {
          this.press('grab');
          this.later(250, () => this.setFightInput({ x: dir }));
          this.later(400, () => this.setFightInput({ x: 0 }));
          this.act('grab', 600);
        } else {
          this.flickAttack(dirName, 100);
          this.act('smash', 600);
        }
      } else {
        // Aerials: toward the target = fair, up = uair, below = dair, else nair.
        const ax = Math.abs(dx) > 0.5 ? dir : 0;
        const ay = dy > 0.8 ? 1 : dy < -0.8 ? -1 : 0;
        this.setFightInput({ x: ax * 0.8, y: ay * 0.8 });
        this.press('attack');
        this.later(90, () => this.setFightInput({ x: 0, y: 0 }));
        this.act('aerial', 380);
      }
      return;
    }

    // Approach.
    if (edgeAhead) {
      this.setFightInput({ x: 0, y: 0 });
      if (this.rnd() < 0.15) {
        this.setFightInput({ x: dir });
        this.press('special', 80); // side-special / projectile toward the target (stays on stage: x released next)
        this.later(100, () => this.setFightInput({ x: 0 }));
        this.act('sideSpecial', 600);
      }
      return;
    }
    this.setFightInput({ x: Math.abs(dx) > 3 ? dir : dir * 0.7, y: 0 });
    if (me.grounded && dy > 1.2 && this.rnd() < 0.3) {
      this.press('jump', 120);
      this.act('jump', 300);
    } else if (Math.abs(dx) > 4 && this.rnd() < 0.05) {
      this.setFightInput({ x: dir, y: 0 });
      this.press('special'); // neutral/side special from range (projectiles)
      this.act('rangeSpecial', 500);
    }
  }

  /** No observations: a harmless routine around the spawn point (never runs off the stage on purpose). */
  private thinkBlind(now: number): void {
    if (now < this.brain.busyUntil) return;
    // Every step sets the whole stick, and walks come in there-and-back pairs, so the fighter
    // stays around its spawn point (no drifting off the stage).
    const step = this.brain.step++ % 12;
    const side = Math.floor(this.brain.step / 12) % 2 === 0 ? 1 : -1;
    const stick = (x: number, y = 0): void => this.setFightInput({ x, y, shield: false });
    switch (step) {
      case 0:
        stick(0.45 * side);
        this.act('blindWalk', 250);
        break;
      case 1:
        stick(-0.45 * side);
        this.act('blindWalk', 250);
        break;
      case 2:
        stick(0);
        this.press('attack');
        this.act('blindJab', 300);
        break;
      case 3:
        stick(0);
        this.press('jump', 100);
        this.act('blindJump', 350);
        break;
      case 4:
        stick(0);
        this.press('attack');
        this.act('blindAerial', 600);
        break;
      case 5:
        // (no blind specials: some travel far, e.g. dashes, and would carry the fighter off stage)
        stick(0, -0.8);
        this.press('attack');
        this.later(90, () => this.setFightInput({ y: 0 }));
        this.act('blindDtilt', 400);
        break;
      case 6:
        this.setFightInput({ x: 0, y: 0, shield: true });
        this.later(400, () => this.setFightInput({ shield: false }));
        this.act('blindShield', 500);
        break;
      case 7:
        stick(0.5 * side);
        this.press('attack');
        this.later(90, () => this.setFightInput({ x: 0 }));
        this.act('blindTilt', 400);
        break;
      case 8:
        this.flickAttack(side > 0 ? 'right' : 'left', 100);
        this.act('blindSmash', 700);
        break;
      case 9:
        stick(0, 0.8);
        this.press('attack');
        this.later(90, () => this.setFightInput({ y: 0 }));
        this.act('blindUtilt', 400);
        break;
      case 10:
        stick(0);
        this.press('grab');
        this.act('blindGrab', 500);
        break;
      default:
        stick(0);
        this.act('blindIdle', 300);
    }
  }


  // --------------------------------------------------------------- lifecycle

  private stopTimers(): void {
    this.stopDriving();
    this.stopFightLoop();
    if (this.brainTimer) clearInterval(this.brainTimer);
    this.brainTimer = null;
    for (const t of this.releaseTimers) clearTimeout(t);
    this.releaseTimers.clear();
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
  /** Which game the leader picks (default kart = the original Kart Party flow). */
  game: GameId;
  stocks: number;
  stage?: string;
  teams: boolean;
  cpus: number;
}

function parseCli(argv: string[]): CliOpts {
  const o: CliOpts = { url: 'http://localhost:3000', n: 4, race: false, passive: false, laps: 2, chaos: false, duration: 0, game: 'kart', stocks: 2, teams: false, cpus: 0 };
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
    else if (a === '--game') o.game = v() === 'smash' ? 'smash' : 'kart';
    else if (a === '--stocks') o.stocks = Math.max(1, Math.min(5, Number(v()) || 2));
    else if (a === '--stage') o.stage = v();
    else if (a === '--teams') o.teams = true;
    else if (a === '--cpus') o.cpus = Math.max(0, Math.min(4, Number(v()) || 0));
    else if (a === '-h' || a === '--help') {
      console.log('npm run bots -- --url http://localhost:3000 --n 4 [--room ABCD] [--race] [--passive] [--laps N] [--track ID] [--chaos] [--duration S] [--game smash [--stocks N] [--stage ID] [--teams] [--cpus N]]');
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
  const smashTick = (b: BotPhone, idx: number): void => {
    const st = b.state;
    const you = st?.you;
    const id = b.playerId;
    const leader = !o.passive && !!you?.isLeader;
    const screen = st?.screen;
    const isSmash = st?.game === 'smash';
    const fightingScreen = isSmash && (screen === 'race' || screen === 'sandbox' || screen === 'tutorial');
    if (fightingScreen && !b.brainRunning) b.startSmashBrain(idx * 0.21 + 0.1);
    if (!fightingScreen && b.brainRunning) b.stopSmashBrain();

    if (screen === 'lobby' || screen === 'waiting' || screen === 'title') {
      if (you && (!you.name || !you.characterId) && once(`${id}:profile`, 2000)) b.profile(names.get(b) ?? 'Bot', pickChar(b, idx));
      else if (you && !you.ready && once(`${id}:ready`, 1500)) b.ready(true);
      if (leader && st && screen === 'lobby') {
        if (!isSmash) {
          if (once(`${id}:game`, 2000)) b.game('smash');
        } else if (st.players.filter((p) => p.connected).every((p) => p.ready) && once(`${id}:start`, 3000)) b.start();
      }
    } else if (screen === 'tutorial') {
      if (leader && once(`${id}:skip`, 3000)) b.tutSkip();
      else if (you && !you.tutorialDone && once(`${id}:tut`, 4000)) b.tutOk();
    } else if (screen === 'sandbox') {
      const since = lastAct.get(`${id}:sandboxAt`) ?? 0;
      if (!since) lastAct.set(`${id}:sandboxAt`, Date.now());
      else if (Date.now() - since > 5000 + idx * 700 && !(st?.sandbox?.done ?? []).includes(id) && once(`${id}:practice`, 3000)) b.practiceDone();
      if (leader && since && Date.now() - since > 9000 && once(`${id}:sbstart`, 4000)) b.start();
    } else if (screen === 'setup' && leader) {
      lastAct.delete(`${id}:sandboxAt`);
      if (!isSmash) {
        if (once(`${id}:game`, 3000)) b.game('smash');
      } else if (once(`${id}:setup`, 4000)) {
        b.gsetup({ mode: 'stock', stocks: o.stocks, teams: o.teams, fillCpus: o.cpus, ...(o.stage ? { stageId: o.stage } : {}) });
        setTimeout(() => b.start(), 800);
      }
    } else if (screen === 'setup' && o.teams && you && once(`${id}:team`, 4000)) {
      b.team(idx % 2);
    } else if (screen === 'paused' && once(`${id}:resume`, 3000)) {
      b.resume();
    } else if (screen === 'results' && leader && once(`${id}:rematch`, 6000)) {
      setTimeout(() => b.post(isSmash ? 'replay' : 'switch', isSmash ? undefined : 'smash'), 3000);
    }
  };

  const tick = (): void => {
    if (o.game === 'smash') {
      bots.forEach((b, idx) => b.connected && smashTick(b, idx));
      return;
    }
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
        const race =
          o.game === 'smash'
            ? b.fight && (s === 'race' || s === 'sandbox')
              ? ` ${b.fight.damage}% stocks=${b.fight.stocks} kos=${b.fight.kos}${b.fight.cpu ? ' CPU' : ''}${b.fight.dummyDamage !== undefined ? ` dummy=${b.fight.dummyDamage}%` : ''}`
              : ''
            : s === 'race' && r
              ? ` P${r.place} L${r.lap}/${r.laps}${r.finished ? ' FIN' : ''}${r.item !== 'none' ? ` [${r.item}]` : ''}`
              : '';
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
