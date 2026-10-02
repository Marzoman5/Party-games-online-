/**
 * Room registry + relay logic. Transport-agnostic: it talks to sockets through
 * the tiny `Sock` interface so it can be unit-tested and so ws details stay in
 * server/ws.ts.
 *
 * Identity model (see src/net/protocol.ts):
 *   - A HOST connection sends `host_hello` first. Without a valid room+hostToken
 *     it gets a brand new room; with them it reclaims its room (newest host
 *     connection wins - an older tab is told and closed).
 *   - A PHONE connection sends `join` first. A known token reclaims its seat
 *     (same playerId, rejoin:true; an older socket for that token is closed).
 *     Unknown/absent token -> new seat with a fresh token + playerId.
 *   - Seats survive disconnects so phones can come back. At most MAX_PLAYERS
 *     seats exist; a new joiner evicts the oldest *disconnected* seat if needed,
 *     and gets `room_full` if MAX_PLAYERS seats are connected.
 *   - Rooms survive ROOM_TTL without a host (host reload, laptop sleep...).
 */
import crypto from 'node:crypto';
import {
  MAX_PLAYERS,
  PROTOCOL_VERSION,
  ROOM_CODE_ALPHABET,
  type FromPhone,
  type HostStatus,
  type HostWelcome,
  type PhoneToHost,
  type PhoneWelcome,
  type PlayerJoined,
  type PlayerLeft,
  type Pong,
  type RelayedFightInputPacket,
  type RelayedInputPacket,
  type ServerError,
} from '../src/net/protocol';
import type { Logger } from './log';

/** Close codes (4000-4999 are application-defined). Clients may inspect these. */
export const CLOSE_REPLACED = 4001; // a newer connection took over this identity (host tab / phone token)
export const CLOSE_KICKED = 4002; // host kicked this player
export const CLOSE_NO_ROOM = 4004; // room does not exist (or expired)
export const CLOSE_ROOM_FULL = 4005;
export const CLOSE_BAD_VERSION = 4006;
export const CLOSE_HOST_GONE = 4007; // room expired after the host stayed away too long
export const CLOSE_HELLO_TIMEOUT = 4008;

/** Minimal socket surface the hub needs. */
export interface Sock {
  send(data: string): void;
  close(code: number, reason: string): void;
  isOpen(): boolean;
}

/** Per-connection state. Created by the transport, owned by the hub afterwards. */
export interface Client {
  sock: Sock;
  /** Remote address, for logs. */
  remote: string;
  /** HTTP Host header of the upgrade request (fallback for join URLs). */
  reqHost: string | undefined;
  role: 'none' | 'host' | 'phone';
  room: Room | null;
  seat: Seat | null;
}

export interface Seat {
  playerId: string;
  token: string;
  client: Client | null;
  joinedAt: number;
  /** When the seat last lost its socket (0 while connected). */
  disconnectedAt: number;
}

export interface Room {
  code: string;
  hostToken: string;
  host: Client | null;
  /** When the host last disconnected (0 while connected). */
  hostLeftAt: number;
  createdAt: number;
  /** token -> seat */
  seats: Map<string, Seat>;
  /** playerId -> seat */
  byId: Map<string, Seat>;
  nextPlayerNum: number;
}

export interface HubOptions {
  log: Logger;
  /** Rooms without a host are deleted after this long. Default 30 min. */
  roomTtlMs?: number;
  /** Builds LAN base URLs (best first) for HostWelcome; reqHost is the host page's Host header. */
  urlsFor: (reqHost: string | undefined) => { urls: string[]; https: boolean };
}

const PHONE_MSG_TYPES = new Set<PhoneToHost['t']>([
  'profile',
  'ready',
  'howto',
  'tut_ok',
  'tut_skip',
  'setup',
  'start',
  'pause',
  'resume',
  'restart',
  'quit',
  'post',
  'leader',
  'tips',
  'leave',
  // PARTY HUB
  'game',
  'gsetup',
  'team',
  'practice_done',
]);

const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function normalizeRoomCode(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  if (s.length !== 4) return null;
  for (const ch of s) if (!ROOM_CODE_ALPHABET.includes(ch)) return null;
  return s;
}

export class Hub {
  readonly rooms = new Map<string, Room>();
  private readonly log: Logger;
  private readonly ttl: number;
  private readonly urlsFor: HubOptions['urlsFor'];

  constructor(opts: HubOptions) {
    this.log = opts.log;
    this.ttl = opts.roomTtlMs ?? 30 * 60_000;
    this.urlsFor = opts.urlsFor;
  }

  newClient(sock: Sock, remote: string, reqHost: string | undefined): Client {
    return { sock, remote, reqHost, role: 'none', room: null, seat: null };
  }

  // -------------------------------------------------------------------------
  // Entry points from the transport
  // -------------------------------------------------------------------------

  /** Handle one text frame. Never throws. */
  onMessage(c: Client, raw: string): void {
    try {
      if (raw.length === 0) return;
      // Hot path: phone input packets are JSON arrays.
      if (raw.charCodeAt(0) === 91 /* [ */) {
        if (c.role === 'phone') this.relayInput(c, raw);
        return;
      }
      let msg: unknown;
      try {
        msg = JSON.parse(raw);
      } catch {
        return; // malformed JSON: ignore
      }
      if (!isObj(msg) || typeof msg.t !== 'string') return;
      if (msg.t === 'ping') {
        const pong: Pong = { t: 'pong', id: typeof msg.id === 'number' ? msg.id : 0 };
        send(c, pong);
        return;
      }
      switch (c.role) {
        case 'none':
          if (msg.t === 'host_hello') this.hostHello(c, msg);
          else if (msg.t === 'join') this.phoneJoin(c, msg);
          return;
        case 'host':
          this.fromHost(c, msg);
          return;
        case 'phone':
          this.fromPhone(c, msg);
          return;
      }
    } catch (err) {
      this.log.error('message handler failed:', err);
    }
  }

  /** Socket closed (any reason). Never throws. */
  onClose(c: Client): void {
    try {
      const room = c.room;
      if (!room) return;
      if (c.role === 'host') {
        if (room.host !== c) return; // replaced by a newer host connection
        room.host = null;
        room.hostLeftAt = Date.now();
        this.log.info(`room ${room.code}: host disconnected (room kept for ${Math.round(this.ttl / 60000)} min)`);
        const st: HostStatus = { t: 'host', connected: false };
        this.broadcastPhones(room, JSON.stringify(st));
      } else if (c.role === 'phone') {
        const seat = c.seat;
        if (!seat || seat.client !== c || room.byId.get(seat.playerId) !== seat) return; // replaced or kicked
        seat.client = null;
        seat.disconnectedAt = Date.now();
        this.log.info(`room ${room.code}: ${seat.playerId} disconnected`);
        const left: PlayerLeft = { t: 'p_leave', p: seat.playerId };
        this.toHost(room, JSON.stringify(left));
      }
    } catch (err) {
      this.log.error('close handler failed:', err);
    }
  }

  /** Delete rooms whose host has been gone longer than the TTL. Call periodically. */
  sweep(now = Date.now()): void {
    for (const room of this.rooms.values()) {
      if (room.host || now - room.hostLeftAt < this.ttl) continue;
      const err: ServerError = { t: 'error', code: 'host_gone', message: 'The game screen closed. Ask the host for the new room code.' };
      const data = JSON.stringify(err);
      for (const seat of room.seats.values()) {
        const cl = seat.client;
        if (cl && cl.sock.isOpen()) {
          cl.sock.send(data);
          cl.sock.close(CLOSE_HOST_GONE, 'host gone');
        }
        seat.client = null;
      }
      this.rooms.delete(room.code);
      this.log.info(`room ${room.code}: expired (no host for ${Math.round(this.ttl / 60000)} min)`);
    }
  }

  /** Snapshot for GET /api/debug/rooms. */
  debugRooms(): { room: string; hostConnected: boolean; players: { playerId: string; connected: boolean }[] }[] {
    return [...this.rooms.values()].map((r) => ({
      room: r.code,
      hostConnected: !!r.host,
      players: [...r.byId.values()].map((s) => ({ playerId: s.playerId, connected: !!s.client })),
    }));
  }

  // -------------------------------------------------------------------------
  // Host
  // -------------------------------------------------------------------------

  private hostHello(c: Client, msg: Json): void {
    if (msg.v !== PROTOCOL_VERSION) {
      this.reject(c, 'bad_version', 'Version mismatch: please reload the game page.', CLOSE_BAD_VERSION);
      return;
    }
    const code = normalizeRoomCode(msg.room);
    const token = typeof msg.hostToken === 'string' && TOKEN_RE.test(msg.hostToken) ? msg.hostToken : null;
    let room: Room | undefined;
    let reclaimed = false;

    if (code && token) {
      const existing = this.rooms.get(code);
      if (existing && existing.hostToken === token) {
        room = existing;
        reclaimed = true;
      } else if (!existing) {
        // Server restarted while the host page stayed open: recreate the same
        // room code so the QR code / phones' saved room still work.
        room = this.createRoom(code, token);
        this.log.info(`room ${code}: recreated for returning host`);
      }
    }
    if (!room) room = this.createRoom(null, null);

    // Newest host connection wins (e.g. game opened in two tabs / reload race).
    const old = room.host;
    if (old && old !== c) {
      old.room = null; // detach so its close doesn't flag the room host-less
      if (old.sock.isOpen()) {
        const e: ServerError = { t: 'error', code: 'host_gone', message: 'The game was opened in another tab/window.' };
        old.sock.send(JSON.stringify(e));
        old.sock.close(CLOSE_REPLACED, 'replaced by newer host');
      }
    }

    c.role = 'host';
    c.room = room;
    room.host = c;
    room.hostLeftAt = 0;

    const { urls, https } = this.urlsFor(c.reqHost);
    const welcome: HostWelcome = {
      t: 'hosted',
      room: room.code,
      hostToken: room.hostToken,
      urls,
      joinUrl: `${urls[0] ?? ''}/play?room=${room.code}`,
      https,
      players: [...room.byId.values()].map((s) => ({ playerId: s.playerId, connected: !!s.client })),
    };
    send(c, welcome);
    this.log.info(`room ${room.code}: host ${reclaimed ? 'reconnected' : 'connected'} (${c.remote})`);
    const st: HostStatus = { t: 'host', connected: true };
    this.broadcastPhones(room, JSON.stringify(st));
  }

  private fromHost(c: Client, msg: Json): void {
    const room = c.room;
    if (!room || room.host !== c) return;
    if (msg.t === 'to') {
      if (!isObj(msg.m) || typeof msg.m.t !== 'string' || typeof msg.p !== 'string') return;
      const data = JSON.stringify(msg.m);
      if (msg.p === '*') this.broadcastPhones(room, data);
      else {
        const cl = room.byId.get(msg.p)?.client;
        if (cl) cl.sock.send(data);
      }
    } else if (msg.t === 'kick') {
      if (typeof msg.p !== 'string') return;
      const seat = room.byId.get(msg.p);
      if (!seat) return;
      room.byId.delete(seat.playerId);
      room.seats.delete(seat.token);
      const cl = seat.client;
      seat.client = null;
      if (cl) {
        cl.seat = null;
        if (cl.sock.isOpen()) {
          const e: ServerError = { t: 'error', code: 'kicked', message: 'You were removed from the game.' };
          cl.sock.send(JSON.stringify(e));
          cl.sock.close(CLOSE_KICKED, 'kicked');
        }
      }
      this.log.info(`room ${room.code}: ${seat.playerId} kicked`);
    }
    // host_hello repeats and unknown types are ignored.
  }

  // -------------------------------------------------------------------------
  // Phones
  // -------------------------------------------------------------------------

  private phoneJoin(c: Client, msg: Json): void {
    if (msg.v !== PROTOCOL_VERSION) {
      this.reject(c, 'bad_version', 'Version mismatch: please reload this page.', CLOSE_BAD_VERSION);
      return;
    }
    const code = normalizeRoomCode(msg.room);
    const room = code ? this.rooms.get(code) : undefined;
    if (!room) {
      this.reject(c, 'no_room', `Room ${code ?? String(msg.room ?? '').slice(0, 8)} not found. Check the code on the TV.`, CLOSE_NO_ROOM);
      return;
    }
    const now = Date.now();
    const token = typeof msg.token === 'string' ? msg.token : '';
    let seat = token ? room.seats.get(token) : undefined;
    let rejoin = false;

    if (seat) {
      rejoin = true;
      const old = seat.client;
      seat.client = c; // set first so the old socket's close is recognised as "replaced"
      if (old && old !== c) {
        old.seat = null;
        if (old.sock.isOpen()) old.sock.close(CLOSE_REPLACED, 'replaced by newer connection');
      }
    } else {
      let connected = 0;
      for (const s of room.seats.values()) if (s.client) connected++;
      if (connected >= MAX_PLAYERS) {
        this.reject(c, 'room_full', `This game already has ${MAX_PLAYERS} players.`, CLOSE_ROOM_FULL);
        return;
      }
      // Free a seat if needed: evict the disconnected seat that left longest ago.
      while (room.seats.size >= MAX_PLAYERS) {
        let victim: Seat | null = null;
        for (const s of room.seats.values()) {
          if (!s.client && (!victim || s.disconnectedAt < victim.disconnectedAt)) victim = s;
        }
        if (!victim) break;
        room.seats.delete(victim.token);
        room.byId.delete(victim.playerId);
        this.log.info(`room ${room.code}: evicted stale seat ${victim.playerId}`);
      }
      seat = {
        playerId: `p${room.nextPlayerNum++}`,
        // Adopt the phone's self-generated token (so a retry after a lost 'joined' reclaims this seat).
        token: /^[A-Za-z0-9-]{16,64}$/.test(token) ? token : crypto.randomUUID(),
        client: c,
        joinedAt: now,
        disconnectedAt: 0,
      };
      room.seats.set(seat.token, seat);
      room.byId.set(seat.playerId, seat);
    }
    seat.disconnectedAt = 0;
    c.role = 'phone';
    c.room = room;
    c.seat = seat;

    const welcome: PhoneWelcome = { t: 'joined', playerId: seat.playerId, token: seat.token, room: room.code, rejoin };
    send(c, welcome);
    const st: HostStatus = { t: 'host', connected: !!room.host };
    send(c, st);
    const pj: PlayerJoined = { t: 'p_join', p: seat.playerId, rejoin };
    this.toHost(room, JSON.stringify(pj));
    this.log.info(`room ${room.code}: ${seat.playerId} ${rejoin ? 'rejoined' : 'joined'} (${c.remote})`);
  }

  private fromPhone(c: Client, msg: Json): void {
    const room = c.room;
    const seat = c.seat;
    if (!room || !seat || seat.client !== c) return;
    if (!PHONE_MSG_TYPES.has(msg.t as PhoneToHost['t'])) return;
    const from: FromPhone = { t: 'from', p: seat.playerId, m: msg as unknown as PhoneToHost };
    this.toHost(room, JSON.stringify(from));
  }

  private relayInput(c: Client, raw: string): void {
    const room = c.room;
    const seat = c.seat;
    if (!room || !seat || seat.client !== c || !room.host) return;
    let arr: unknown;
    try {
      arr = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(arr)) return;
    const tag: unknown = arr[0];
    // Tag 0 = kart input (7 fields), tag 1 = PARTY HUB smash fight input (9 fields).
    const n = tag === 0 ? 7 : tag === 1 ? 9 : 0;
    if (n === 0 || arr.length < n) return;
    for (let i = 1; i < n; i++) {
      const v: unknown = arr[i];
      if (typeof v !== 'number' || !Number.isFinite(v)) return;
    }
    const a = arr as number[];
    if (tag === 0) {
      const out: RelayedInputPacket = [0, a[1], a[2], a[3], a[4], a[5], a[6], seat.playerId];
      room.host.sock.send(JSON.stringify(out));
    } else {
      const out: RelayedFightInputPacket = [1, a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], seat.playerId];
      room.host.sock.send(JSON.stringify(out));
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private createRoom(code: string | null, hostToken: string | null): Room {
    let c = code;
    if (!c || this.rooms.has(c)) {
      for (let tries = 0; ; tries++) {
        let s = '';
        for (let i = 0; i < 4; i++) s += ROOM_CODE_ALPHABET[crypto.randomInt(ROOM_CODE_ALPHABET.length)];
        if (!this.rooms.has(s) || tries > 1000) {
          c = s;
          break;
        }
      }
    }
    const room: Room = {
      code: c,
      hostToken: hostToken ?? crypto.randomUUID(),
      host: null,
      hostLeftAt: 0,
      createdAt: Date.now(),
      seats: new Map(),
      byId: new Map(),
      nextPlayerNum: 1,
    };
    this.rooms.set(c, room);
    return room;
  }

  private reject(c: Client, code: ServerError['code'], message: string, closeCode: number): void {
    const e: ServerError = { t: 'error', code, message };
    send(c, e);
    if (c.sock.isOpen()) c.sock.close(closeCode, code);
    this.log.info(`rejected ${c.remote}: ${code}`);
  }

  private toHost(room: Room, data: string): void {
    const h = room.host;
    if (h && h.sock.isOpen()) h.sock.send(data);
  }

  private broadcastPhones(room: Room, data: string): void {
    for (const s of room.seats.values()) {
      const cl = s.client;
      if (cl && cl.sock.isOpen()) cl.sock.send(data);
    }
  }
}

function send(c: Client, m: object): void {
  if (c.sock.isOpen()) c.sock.send(JSON.stringify(m));
}
