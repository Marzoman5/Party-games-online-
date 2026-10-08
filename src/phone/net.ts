/**
 * Connection to the relay: join/reclaim, ping, auto-reconnect. Implements the phone side of
 * src/net/protocol.ts exactly, over a `Link` (src/net/link.ts): a WebSocket to the Node server, or a
 * direct WebRTC data channel to the host page on the static site (./rtcLink.ts).
 */
import {
  PROTOCOL_VERSION,
  WS_PATH,
  type FightInputPacket,
  type InputPacket,
  type PhoneToHost,
  type ServerError,
  type ServerToPhone,
  type StreamPacket,
} from '../net/protocol';
import { transportKind, wsLink, type Link, type LinkClose } from '../net/link';
import { openRtcLink, RTC_CLOSE_NO_DIRECT, RTC_CLOSE_NO_ROOM, RTC_CLOSE_NO_SIGNAL } from './rtcLink';
import { lsGet, lsSet } from './settings';
import { setState, state, type LinkError } from './store';

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

/** Close codes of the WebRTC link that mean "stop retrying and tell the player". */
const LINK_ERRORS: Record<number, LinkError['code']> = {
  [RTC_CLOSE_NO_DIRECT]: 'no_direct',
  [RTC_CLOSE_NO_SIGNAL]: 'no_signal',
};

export class Net {
  private ws: Link | null = null;
  /** Ever joined in this page (a WebRTC "room not found" is then a host reload, not a typo). */
  private everJoined = false;
  private readonly openLink: (room: string) => Link =
    transportKind() === 'rtc' ? (room) => openRtcLink(room) : () => wsLink(wsUrl());
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
      if (!this.ws || !this.ws.isOpen || performance.now() - this.lastRx > STALE_MS) {
        this.reconnectNow();
      } else {
        this.ping();
      }
    });
    window.addEventListener('online', () => {
      if (!this.halted && (!this.ws || !this.ws.isOpen)) this.reconnectNow();
    });
  }

  /** Connect (or switch) to a room. */
  connect(room: string): void {
    this.halted = false;
    this.attempt = 0;
    setState({ room, error: null, joined: false, phone: null, race: null, rush: null, hostConnected: true });
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
    return !!this.ws && this.ws.isOpen && state.joined;
  }

  send(m: PhoneToHost): void {
    if (this.ws && this.ws.isOpen && state.joined) {
      try {
        this.ws.send(JSON.stringify(m));
      } catch {
        /* closing */
      }
    }
  }

  sendInput(p: InputPacket | FightInputPacket | StreamPacket): boolean {
    if (this.ws && this.ws.isOpen && state.joined) {
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
      ws.onopen = ws.onmessage = ws.onclose = null;
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
    let ws: Link;
    try {
      ws = this.openLink(state.room);
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
    ws.onmessage = (data) => {
      if (this.ws !== ws) return;
      this.lastRx = performance.now();
      let m: ServerToPhone;
      try {
        m = JSON.parse(data) as ServerToPhone;
      } catch {
        return;
      }
      if (!m || typeof m !== 'object' || Array.isArray(m)) return;
      this.handle(m);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.pingTimer);
      setState({ joined: false });
      if (this.linkFailed(ev)) return;
      this.scheduleReconnect();
    };
  }

  /**
   * WebRTC link failures that need the player (blocked direct connection, joining service down, or a
   * room code nobody hosts). Returns true if handled (auto-reconnect stopped, error screen shown).
   */
  private linkFailed(ev: LinkClose): boolean {
    if (ev.code === RTC_CLOSE_NO_ROOM) {
      // The host page is the room: during a host reload it is briefly unreachable. A phone that was
      // already in this party keeps retrying (with the "game screen disconnected" banner); a fresh
      // join with a wrong code gets the same "room not found" screen as the Node server gives.
      if (this.everJoined) {
        setState({ hostConnected: false });
        return false;
      }
      this.stop({ t: 'error', code: 'no_room', message: `Room ${state.room} not found. Check the code on the TV.` });
      return true;
    }
    const code = LINK_ERRORS[ev.code];
    if (!code) return false;
    // Signalling is only needed to (re)connect: a phone already in the party keeps trying quietly.
    if (code === 'no_signal' && this.everJoined) return false;
    this.stop({ t: 'error', code, message: ev.reason });
    return true;
  }

  private stop(error: ServerError | LinkError): void {
    this.halted = true;
    clearTimeout(this.reconnectTimer);
    this.closeSocket();
    setState({ error, conn: 'closed', joined: false });
  }

  private tick(): void {
    if (!this.ws || !this.ws.isOpen) return;
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
    if (!this.ws || !this.ws.isOpen) return;
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
        this.everJoined = true;
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
