/**
 * HostNet — the host page's single link to the relay (a WebSocket to the Node server, or the
 * in-page WebRTC room server on the static site; see src/net/link.ts).
 *
 * - Sends `host_hello` with the room + hostToken saved in sessionStorage, so a host reload
 *   (or a server blip) reclaims the same room code and its players.
 * - Auto-reconnects with exponential backoff; pings the server and treats a silent socket
 *   as dead (laptop sleep, Wi-Fi hiccup) so recovery is quick.
 * - Input packets (JSON arrays) are decoded and handed out IMMEDIATELY (no batching). All tags
 *   are understood: `[0, …kart…, playerId]`, `[1, …fighter…, playerId]` and `[2, …rush stream…, playerId]`
 *   (playerId = last element).
 * - Control messages are dispatched to the handler (the PartySession).
 */
import {
  PROTOCOL_VERSION,
  decodeFightInput,
  decodeInput,
  decodeStream,
  type HostHello,
  type HostToPhone,
  type HostWelcome,
  type PhoneToHost,
  type ServerError,
  type ServerToHost,
} from '../../net/protocol';
import type { Link, LinkFactory } from '../../net/link';
import {
  PING_MS,
  PING_TIMEOUT_MS,
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  STORAGE,
  storageGet,
  storageSet,
} from '../config';
import type { AnyInput } from '../GameModule';

export type NetStatus = 'connecting' | 'open' | 'down' | 'replaced';

export interface HostNetHandler {
  onHosted(w: HostWelcome, firstTime: boolean): void;
  onPlayerJoined(playerId: string, rejoin: boolean): void;
  onPlayerLeft(playerId: string): void;
  onPhoneMessage(playerId: string, m: PhoneToHost): void;
  /** A relayed input packet (tag 0 = kart, tag 1 = fighter), decoded. */
  onInput(playerId: string, input: AnyInput): void;
  onStatus(status: NetStatus): void;
  onServerError(e: ServerError): void;
}

/** What the session needs to talk to phones. */
export interface NetPort {
  sendTo(playerId: string | '*', m: HostToPhone): void;
  kick(playerId: string): void;
  readonly isOpen: boolean;
}

/** Close code the server uses when a newer host tab took over the room. */
const CLOSE_REPLACED = 4001;

export class HostNet implements NetPort {
  private ws: Link | null = null;
  private status: NetStatus = 'connecting';
  private retryMs = RECONNECT_MIN_MS;
  private retryTimer = 0;
  private pingTimer = 0;
  private pingId = 0;
  private lastHeard = 0;
  private lastPingTick = 0;
  private hostedOnce = false;
  private disposed = false;

  constructor(
    private readonly openLink: LinkFactory,
    private readonly handler: HostNetHandler,
  ) {}

  get isOpen(): boolean {
    return this.status === 'open' && this.ws !== null && this.ws.isOpen;
  }

  get currentStatus(): NetStatus {
    return this.status;
  }

  connect(): void {
    if (this.disposed) return;
    window.clearTimeout(this.retryTimer);
    this.retryTimer = 0;
    this.teardownSocket();
    this.setStatus('connecting');
    let ws: Link;
    try {
      ws = this.openLink();
    } catch (err) {
      console.warn('[HostNet] cannot open socket', err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.lastHeard = performance.now();
      const saved = this.loadHost();
      const hello: HostHello = { t: 'host_hello', v: PROTOCOL_VERSION };
      if (saved) {
        hello.room = saved.room;
        hello.hostToken = saved.hostToken;
      }
      this.rawSend(JSON.stringify(hello));
      window.clearInterval(this.pingTimer);
      this.lastPingTick = 0;
      this.pingTimer = window.setInterval(this.ping, PING_MS);
    };
    ws.onmessage = (data) => {
      if (this.ws !== ws) return;
      this.lastHeard = performance.now();
      this.onFrame(data);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      window.clearInterval(this.pingTimer);
      this.pingTimer = 0;
      if (ev.code === CLOSE_REPLACED) {
        this.setStatus('replaced');
        return;
      }
      this.scheduleReconnect();
    };
  }

  /** Re-take the room after another tab replaced us. */
  reclaim(): void {
    this.retryMs = RECONNECT_MIN_MS;
    this.connect();
  }

  sendTo(playerId: string | '*', m: HostToPhone): void {
    this.rawSend(JSON.stringify({ t: 'to', p: playerId, m }));
  }

  kick(playerId: string): void {
    this.rawSend(JSON.stringify({ t: 'kick', p: playerId }));
  }

  dispose(): void {
    this.disposed = true;
    window.clearTimeout(this.retryTimer);
    window.clearInterval(this.pingTimer);
    this.teardownSocket();
  }

  // ------------------------------------------------------------------ internals

  private onFrame(data: string): void {
    // Fast path: relayed input packets
    //   kart    `[0, seq, steer, throttle, brake, buttons, itemPresses, playerId]`
    //   fighter `[1, seq, x, y, buttons, a, s, j, g, playerId]`
    //   rush    `[2, seq, rid, a, b, c, playerId]`
    if (data.charCodeAt(0) === 91 /* [ */) {
      let arr: unknown;
      try {
        arr = JSON.parse(data);
      } catch {
        return;
      }
      if (!Array.isArray(arr) || arr.length < 2) return;
      const pid = arr[arr.length - 1];
      if (typeof pid !== 'string') return;
      if (arr[0] === 0) {
        const input = decodeInput(arr);
        if (input) this.handler.onInput(pid, { tag: 0, input });
      } else if (arr[0] === 1) {
        const input = decodeFightInput(arr);
        if (input) this.handler.onInput(pid, { tag: 1, input });
      } else if (arr[0] === 2) {
        const input = decodeStream(arr);
        if (input) this.handler.onInput(pid, { tag: 2, input });
      }
      return;
    }
    let msg: ServerToHost;
    try {
      msg = JSON.parse(data) as ServerToHost;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'hosted': {
        storageSet('session', STORAGE.host, JSON.stringify({ room: msg.room, hostToken: msg.hostToken }));
        this.retryMs = RECONNECT_MIN_MS;
        const first = !this.hostedOnce;
        this.hostedOnce = true;
        this.setStatus('open');
        this.handler.onHosted(msg, first);
        break;
      }
      case 'p_join':
        this.handler.onPlayerJoined(msg.p, !!msg.rejoin);
        break;
      case 'p_leave':
        this.handler.onPlayerLeft(msg.p);
        break;
      case 'from':
        if (msg.m && typeof msg.m === 'object' && typeof (msg.m as { t?: unknown }).t === 'string') {
          this.handler.onPhoneMessage(msg.p, msg.m);
        }
        break;
      case 'error':
        this.handler.onServerError(msg);
        if (msg.code === 'host_gone') this.setStatus('replaced');
        break;
      case 'pong':
        break;
      default:
        break;
    }
  }

  private readonly ping = (): void => {
    const ws = this.ws;
    if (!ws || !ws.isOpen) return;
    const now = performance.now();
    // If this timer itself fired late, the page was stalled (heavy frame, background tab, sleep):
    // queued frames may not have been processed yet, so don't judge the socket on this tick.
    const stalled = this.lastPingTick > 0 && now - this.lastPingTick > PING_MS * 2;
    this.lastPingTick = now;
    if (stalled || ws.local) {
      this.lastHeard = Math.max(this.lastHeard, now - PING_MS);
    } else if (now - this.lastHeard > PING_TIMEOUT_MS) {
      // Silent socket (sleep / Wi-Fi drop): force a reconnect.
      console.warn('[HostNet] server silent, reconnecting');
      this.teardownSocket();
      this.scheduleReconnect();
      return;
    }
    this.rawSend(JSON.stringify({ t: 'ping', id: ++this.pingId }));
  };

  private rawSend(s: string): void {
    const ws = this.ws;
    if (!ws || !ws.isOpen) return;
    try {
      ws.send(s);
    } catch {
      /* closing */
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.status === 'replaced') return;
    this.setStatus('down');
    window.clearTimeout(this.retryTimer);
    const wait = this.retryMs * (0.85 + Math.random() * 0.3);
    this.retryMs = Math.min(RECONNECT_MAX_MS, this.retryMs * 1.7);
    this.retryTimer = window.setTimeout(() => this.connect(), wait);
  }

  private teardownSocket(): void {
    const ws = this.ws;
    this.ws = null;
    window.clearInterval(this.pingTimer);
    this.pingTimer = 0;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }

  private setStatus(s: NetStatus): void {
    if (this.status === s) return;
    // 'connecting' between retries is still an outage from the UI's point of view.
    if (s === 'connecting' && this.status === 'down') return;
    this.status = s;
    this.handler.onStatus(s);
  }

  private loadHost(): { room: string; hostToken: string } | null {
    const raw = storageGet('session', STORAGE.host);
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as { room?: unknown; hostToken?: unknown };
      if (typeof v.room === 'string' && typeof v.hostToken === 'string') return { room: v.room, hostToken: v.hostToken };
    } catch {
      /* ignore */
    }
    return null;
  }
}
