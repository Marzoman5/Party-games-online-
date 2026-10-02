/**
 * WebSocket connection to the relay server: join/reclaim, ping, auto-reconnect.
 * Implements the phone side of src/net/protocol.ts exactly.
 */
import {
  PROTOCOL_VERSION,
  WS_PATH,
  type FightInputPacket,
  type InputPacket,
  type PhoneToHost,
  type ServerToPhone,
} from '../net/protocol';
import { lsGet, lsSet } from './settings';
import { setState, state } from './store';

type MsgHandler = (m: ServerToPhone) => void;

const PING_MS = 2000;
/** No traffic for this long on an "open" socket -> assume it's dead (Wi-Fi drop, iOS sleep). */
const STALE_MS = 7000;

export function tokenKey(room: string): string {
  return `kp.token.${room}`;
}

function newToken(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* insecure context on some browsers */
  }
  let t = '';
  for (let i = 0; i < 32; i++) t += Math.floor(Math.random() * 16).toString(16);
  return t;
}

export function normalizeRoom(code: string): string {
  return code
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 4);
}

function wsUrl(): string {
  const override = new URLSearchParams(location.search).get('ws');
  if (override) return override;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${WS_PATH}`;
}

export class Net {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private reconnectTimer = 0;
  private pingTimer = 0;
  private pingId = 0;
  private pingSent = new Map<number, number>();
  private lastRx = 0;
  /** Stop reconnecting (fatal error or user left). */
  private halted = true;
  onMessage: MsgHandler = () => {};

  constructor() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || this.halted) return;
      // iOS freezes/kills sockets in the background: check right away when we come back.
      if (!this.ws || this.ws.readyState > 1 || performance.now() - this.lastRx > STALE_MS) {
        this.reconnectNow();
      } else {
        this.ping();
      }
    });
    window.addEventListener('online', () => {
      if (!this.halted && (!this.ws || this.ws.readyState > 1)) this.reconnectNow();
    });
  }

  /** Connect (or switch) to a room. */
  connect(room: string): void {
    this.halted = false;
    this.attempt = 0;
    setState({ room, error: null, joined: false, phone: null, race: null, hostConnected: true });
    this.open();
  }

  /** Stop and forget the current socket (no reconnect). */
  halt(): void {
    this.halted = true;
    clearTimeout(this.reconnectTimer);
    this.closeSocket();
    setState({ conn: 'closed', joined: false });
  }

  retry(): void {
    if (!state.room) return;
    this.connect(state.room);
  }

  reconnectNow(): void {
    clearTimeout(this.reconnectTimer);
    this.attempt = 0;
    this.open();
  }

  get isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN && state.joined;
  }

  send(m: PhoneToHost): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && state.joined) {
      try {
        this.ws.send(JSON.stringify(m));
      } catch {
        /* closing */
      }
    }
  }

  sendInput(p: InputPacket | FightInputPacket): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && state.joined) {
      try {
        this.ws.send(JSON.stringify(p));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------

  private closeSocket(): void {
    const ws = this.ws;
    this.ws = null;
    clearInterval(this.pingTimer);
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  private open(): void {
    if (this.halted || !state.room) return;
    this.closeSocket();
    setState({ conn: state.phone ? 'reconnecting' : 'connecting', joined: false });
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.lastRx = performance.now();
    ws.onopen = () => {
      if (this.ws !== ws) return;
      const room = state.room;
      // Create our identity BEFORE the first join: if this socket dies before 'joined' arrives, the retry
      // reclaims the same seat instead of leaving an orphan "Player N (disconnected)" card on the TV.
      let token = lsGet(tokenKey(room)) ?? undefined;
      if (!token) {
        token = newToken();
        lsSet(tokenKey(room), token);
      }
      ws.send(JSON.stringify({ t: 'join', room, token, v: PROTOCOL_VERSION }));
      this.lastRx = performance.now();
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.tick(), PING_MS);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastRx = performance.now();
      let m: ServerToPhone;
      try {
        m = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as ServerToPhone;
      } catch {
        return;
      }
      if (!m || typeof m !== 'object' || Array.isArray(m)) return;
      this.handle(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.pingTimer);
      setState({ joined: false });
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private tick(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (performance.now() - this.lastRx > STALE_MS) {
      // Half-open socket: tear it down and reconnect.
      this.closeSocket();
      setState({ joined: false });
      this.scheduleReconnect(true);
      return;
    }
    this.ping();
  }

  private ping(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const id = ++this.pingId;
    this.pingSent.set(id, performance.now());
    if (this.pingSent.size > 8) {
      const first = this.pingSent.keys().next().value;
      if (first !== undefined) this.pingSent.delete(first);
    }
    try {
      this.ws.send(JSON.stringify({ t: 'ping', id }));
    } catch {
      /* ignore */
    }
  }

  private scheduleReconnect(immediate = false): void {
    if (this.halted) {
      setState({ conn: 'closed' });
      return;
    }
    clearTimeout(this.reconnectTimer);
    const base = Math.min(8000, 500 * Math.pow(2, this.attempt));
    const delay = immediate ? 100 : base * (0.75 + Math.random() * 0.5);
    this.attempt++;
    setState({ conn: 'reconnecting' });
    this.reconnectTimer = window.setTimeout(() => this.open(), delay);
  }

  private handle(m: ServerToPhone): void {
    switch (m.t) {
      case 'joined': {
        this.attempt = 0;
        const room = m.room ? m.room.toUpperCase() : state.room;
        lsSet(tokenKey(room), m.token);
        lsSet('kp.lastRoom', room);
        setState({ conn: 'open', joined: true, playerId: m.playerId, room, error: null });
        this.ping();
        break;
      }
      case 'pong': {
        const sent = this.pingSent.get(m.id);
        if (sent !== undefined) {
          this.pingSent.delete(m.id);
          const rtt = performance.now() - sent;
          // Light smoothing so the number doesn't flicker.
          const prev = state.rtt;
          setState({ rtt: prev === null ? rtt : prev * 0.6 + rtt * 0.4 });
        }
        break;
      }
      case 'error': {
        const code = m.code;
        if (code === 'host_gone') {
          // Room exists but its host left; keep trying (host may reload).
          setState({ hostConnected: false });
          break;
        }
        if (code === 'kicked') lsSet(tokenKey(state.room), null);
        this.halted = true;
        clearTimeout(this.reconnectTimer);
        this.closeSocket();
        setState({ error: m, conn: 'closed', joined: false });
        break;
      }
      case 'host':
        setState({ hostConnected: !!m.connected });
        break;
      default:
        break;
    }
    this.onMessage(m);
  }
}

export const net = new Net();
