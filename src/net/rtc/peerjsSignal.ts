/**
 * Signalling over a PeerJS server (default: the free public 0.peerjs.com), speaking its small
 * WebSocket protocol directly (no PeerJS client library needed; our WebRTC code is in ./peer.ts):
 *
 *   connect  <url>&id=<id>&token=<token>
 *   server → {type:'OPEN'}                                 registered
 *   server → {type:'ID-TAKEN'} / {type:'ERROR'}            refused
 *   either → {type:'OFFER'|'ANSWER'|'CANDIDATE', dst/src, payload}
 *   client → {type:'HEARTBEAT'} every 5 s
 *
 * Reconnecting with the same id AND token is accepted silently (no OPEN), even while the old socket
 * still exists: the host derives its token from the room's secret hostToken, so a reloaded host page
 * (or a tab taking the room over) gets its id back at once. Messages to an id that is momentarily
 * offline are queued by the server for ~5 s, which covers a host reload.
 */
import { backoff, isSignalMsg, type SignalMsg, type Signaller } from './signal';

const HEARTBEAT_MS = 5000;
/** A same-token reconnect gets no OPEN: assume success if nothing bad arrived by then. */
const SILENT_OPEN_MS = 1200;

const TYPES: Record<SignalMsg['kind'], string> = { offer: 'OFFER', answer: 'ANSWER', candidate: 'CANDIDATE' };

export class PeerJsSignal implements Signaller {
  readonly name = 'peerjs';
  onmessage: Signaller['onmessage'] = null;
  onstatus: Signaller['onstatus'] = null;
  ontaken: Signaller['ontaken'] = null;
  private ws: WebSocket | null = null;
  private isUp = false;
  private closed = false;
  private attempt = 0;
  private urlIdx = 0;
  private retryTimer = 0;
  private beatTimer = 0;
  private openTimer = 0;

  constructor(
    private readonly urls: string[],
    private readonly id: string,
    private readonly token: string,
  ) {}

  get up(): boolean {
    return this.isUp;
  }

  start(): void {
    if (this.closed || this.ws || this.urls.length === 0) return;
    const base = this.urls[this.urlIdx % this.urls.length];
    const sep = base.includes('?') ? '&' : '?';
    const url = `${base}${sep}id=${encodeURIComponent(this.id)}&token=${encodeURIComponent(this.token)}&version=1.5.5`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.retry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.openTimer = window.setTimeout(() => this.setUp(true), SILENT_OPEN_MS);
      this.beatTimer = window.setInterval(() => this.raw({ type: 'HEARTBEAT' }), HEARTBEAT_MS);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws || typeof ev.data !== 'string') return;
      let m: { type?: unknown; src?: unknown; payload?: unknown };
      try {
        m = JSON.parse(ev.data) as typeof m;
      } catch {
        return;
      }
      switch (m.type) {
        case 'OPEN':
          this.setUp(true);
          break;
        case 'ID-TAKEN':
          this.ontaken?.();
          break;
        case 'ERROR':
          console.warn('[rtc] peerjs error', m.payload);
          break;
        case 'OFFER':
        case 'ANSWER':
        case 'CANDIDATE':
          if (typeof m.src === 'string' && isSignalMsg(m.payload)) this.onmessage?.(m.src, m.payload);
          break;
        default:
          break; // LEAVE / EXPIRE / HEARTBEAT: nothing to do (timeouts cover a peer that never answers)
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.drop();
      this.retry();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  send(to: string, msg: SignalMsg): void {
    if (this.isUp) this.raw({ type: TYPES[msg.kind], dst: to, payload: msg });
  }

  close(): void {
    this.closed = true;
    window.clearTimeout(this.retryTimer);
    this.drop();
  }

  private raw(m: object): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(m));
      } catch {
        /* closing */
      }
    }
  }

  private setUp(up: boolean): void {
    window.clearTimeout(this.openTimer);
    if (up) this.attempt = 0;
    if (this.isUp === up) return;
    this.isUp = up;
    this.onstatus?.(up);
  }

  private drop(): void {
    const ws = this.ws;
    this.ws = null;
    window.clearInterval(this.beatTimer);
    window.clearTimeout(this.openTimer);
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.setUp(false);
  }

  private retry(): void {
    if (this.closed) return;
    window.clearTimeout(this.retryTimer);
    this.urlIdx++;
    this.retryTimer = window.setTimeout(() => this.start(), backoff(this.attempt++));
  }
}
