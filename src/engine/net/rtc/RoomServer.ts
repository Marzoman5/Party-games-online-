/**
 * RoomServer — on the static site the host page IS the server. It runs the same room/relay logic as
 * the Node server (src/net/hub.ts: room code, player ids, reconnect tokens, routing), with:
 *
 *   - the host's own HostNet attached through an in-memory Link (`link()`), and
 *   - each phone attached through a direct WebRTC data channel (./../../../net/rtc/peer.ts), found via
 *     the signalling services (PeerJS primary + Nostr fallback; src/net/rtc/config.ts).
 *
 * What the Node server gave us for free and this class re-creates:
 *   - Host reload keeps the room: the room (code, hostToken, seats) is saved to sessionStorage on
 *     every change and restored on load; the PeerJS id is re-taken with the same token at once.
 *   - A second host tab takes the room over: tabs coordinate over a BroadcastChannel. The new tab
 *     asks, the old one hands over its latest room snapshot, drops its phones and shows the same
 *     "opened in another tab" panel as before; phones reconnect to the new tab within seconds.
 *   - Dead phones are noticed: a phone silent for 9 s (it pings every 2 s) is dropped (seat kept).
 */
import { Hub, normalizeRoomCode, type Client, type Logger, type Room, type RoomSnapshot, type Sock } from '../../../net/hub';
import type { Link } from '../../../net/link';
import { hostPeerId, rtcConfig, rtcOverrideQuery, type RtcConfig } from '../../../net/rtc/config';
import { NostrSignal } from '../../../net/rtc/nostrSignal';
import { RtcPeer } from '../../../net/rtc/peer';
import { PeerJsSignal } from '../../../net/rtc/peerjsSignal';
import { randomId, type SignalMsg, type Signaller } from '../../../net/rtc/signal';
import { ROOM_CODE_ALPHABET, type HostHello } from '../../../net/protocol';
import { storageGet, storageSet } from '../../config';

const SNAPSHOT_KEY = 'kartparty.rtcRoom'; // sessionStorage: RoomSnapshot of the room this tab hosts
const CHANNEL = 'partyhub-host';
/** Phones ping every 2 s: this much silence means the connection is dead. */
const PHONE_SILENT_MS = 9000;
/** A phone link must say `join` within this long (same as the Node server). */
const HELLO_TIMEOUT_MS = 15_000;
/** An offer whose connection never opens is forgotten after this long. */
const PENDING_MAX_MS = 30_000;
const MAX_PENDING_PEERS = 48;
/** Wait for another tab to hand the room over. */
const CLAIM_WAIT_MS = 600;
/** Picking a fresh room code: wait this long for the PeerJS server to say the id is free. */
const PROBE_WAIT_MS = 4000;

const CLOSE_REPLACED = 4001;

export interface SignalStatus {
  /** Per service: registered and reachable. */
  services: Record<string, boolean>;
  /** At least one service up: phones can join. */
  anyUp: boolean;
}

interface PeerEntry {
  peer: RtcPeer;
  from: string;
  client: Client | null;
  createdAt: number;
  openedAt: number;
  lastRx: number;
  closing: boolean;
}

interface LoopLink extends Link {
  client: Client;
  open: boolean;
}

type BcMsg =
  | { t: 'claim'; room: string; tab: string }
  | { t: 'released'; room: string; tab: string; snap: RoomSnapshot | null };

const log: Logger = {
  info: (...a) => console.info('[room]', ...a),
  warn: (...a) => console.warn('[room]', ...a),
  error: (...a) => console.error('[room]', ...a),
};

/** Public URL of the site root, without trailing slash (works under the GitHub Pages project path). */
export function siteBaseUrl(): string {
  const base = import.meta.env.BASE_URL || '/';
  return new URL(base, window.location.href).href.replace(/\/$/, '');
}

function peerToken(hostToken: string): string {
  return hostToken.replace(/[^A-Za-z0-9]/g, '').slice(0, 32) || randomId();
}

export class RoomServer {
  readonly hub: Hub;
  onstatus: ((st: SignalStatus) => void) | null = null;
  private readonly cfg: RtcConfig;
  private readonly tabId = randomId();
  private readonly bc: BroadcastChannel | null;
  private readonly peers = new Map<string, PeerEntry>();
  private readonly earlyCands = new Map<string, { from: string; at: number; cands: (RTCIceCandidateInit | null | undefined)[] }>();
  private signals: Signaller[] = [];
  private code: string | null = null;
  private current: LoopLink | null = null;
  private claimWaiter: ((snap: RoomSnapshot | null) => void) | null = null;
  private liveness = 0;
  private taken = false;

  constructor(cfg: RtcConfig = rtcConfig()) {
    this.cfg = cfg;
    this.hub = new Hub({
      log,
      urlsFor: () => ({ urls: [siteBaseUrl()], https: window.location.protocol === 'https:' }),
      joinUrlFor: (base, room) => `${base}/play/?room=${room}${rtcOverrideQuery()}`,
      onRoomChange: (room) => this.persist(room),
    });
    const saved = this.loadSnapshot();
    if (saved) this.hub.importRoom(saved);
    this.bc = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
    if (this.bc) this.bc.onmessage = (ev: MessageEvent<BcMsg>) => this.onTabMessage(ev.data);
    this.liveness = window.setInterval(() => this.checkPeers(), 1000);
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('pageshow', this.onPageShow);
  }

  /** LinkFactory for HostNet: an in-memory connection to this room server. */
  readonly link = (): Link => {
    if (this.current) this.closeLoop(this.current, null);
    const sock: Sock = {
      send: (data) => {
        if (l.open) queueMicrotask(() => l.open && l.onmessage?.(data));
      },
      close: (code, reason) => this.closeLoop(l, { code, reason }),
      isOpen: () => l.open,
    };
    const client = this.hub.newClient(sock, 'this tab', undefined);
    const l: LoopLink = {
      client,
      open: false,
      local: true,
      get isOpen() {
        return l.open;
      },
      send: (data) => this.fromHost(l, data),
      close: () => this.closeLoop(l, null),
      onopen: null,
      onmessage: null,
      onclose: null,
    };
    this.current = l;
    window.setTimeout(() => {
      if (this.current !== l) return;
      l.open = true;
      l.onopen?.();
    }, 0);
    return l;
  };

  status(): SignalStatus {
    const services: Record<string, boolean> = {};
    for (const s of this.signals) services[s.name] = s.up;
    return { services, anyUp: this.signals.some((s) => s.up) };
  }

  /** Debug snapshot (tests). */
  debug(): { room: string | null; peers: number; open: number; status: SignalStatus; takenOnPeerjs: boolean } {
    let open = 0;
    for (const e of this.peers.values()) if (e.client) open++;
    return { room: this.code, peers: this.peers.size, open, status: this.status(), takenOnPeerjs: this.taken };
  }

  dispose(): void {
    window.clearInterval(this.liveness);
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('pageshow', this.onPageShow);
    this.stopService();
    this.bc?.close();
  }

  // ================================================================== host side

  private fromHost(l: LoopLink, data: string): void {
    if (!l.open || this.current !== l) return;
    if (l.client.role === 'none') {
      let msg: HostHello | null = null;
      try {
        msg = JSON.parse(data) as HostHello;
      } catch {
        return;
      }
      if (msg && msg.t === 'host_hello') void this.hello(l, msg);
      else this.hub.onMessage(l.client, data); // ping before hello etc.
      return;
    }
    this.hub.onMessage(l.client, data);
  }

  private async hello(l: LoopLink, msg: HostHello): Promise<void> {
    const savedCode = normalizeRoomCode(msg.room);
    let probe: PeerJsSignal | null = null;
    let hello: HostHello = msg;
    if (savedCode && typeof msg.hostToken === 'string') {
      // Reload / reclaim: ask any other tab hosting this room to hand it over.
      const snap = await this.claim(savedCode);
      if (snap && snap.hostToken === msg.hostToken) {
        this.hub.rooms.delete(savedCode);
        this.hub.importRoom(snap);
      } else if (!this.hub.rooms.has(savedCode)) {
        // Taking the room back after handing it over, and the other tab is gone: use what we saved.
        const own = this.loadSnapshot();
        if (own && own.code === savedCode && own.hostToken === msg.hostToken) this.hub.importRoom(own);
      }
    } else {
      const hostToken = globalThis.crypto.randomUUID();
      const picked = await this.pickCode(hostToken);
      probe = picked.probe;
      this.hub.importRoom({ code: picked.code, hostToken, nextPlayerNum: 1, seats: [] });
      hello = { ...msg, room: picked.code, hostToken };
    }
    if (this.current !== l || !l.open) {
      probe?.close();
      return;
    }
    this.hub.onMessage(l.client, JSON.stringify(hello));
    const room = l.client.room;
    if (room) this.serve(room, probe);
    else probe?.close();
  }

  /** A room code whose host id is free on the PeerJS server (unknown if it can't be reached). */
  private async pickCode(hostToken: string): Promise<{ code: string; probe: PeerJsSignal | null }> {
    for (let tries = 0; tries < 6; tries++) {
      let code = '';
      for (let i = 0; i < 4; i++) {
        const b = new Uint32Array(1);
        globalThis.crypto.getRandomValues(b);
        code += ROOM_CODE_ALPHABET[b[0] % ROOM_CODE_ALPHABET.length];
      }
      if (this.hub.rooms.has(code)) continue;
      if (this.cfg.peerjs.length === 0) return { code, probe: null };
      const probe = new PeerJsSignal(this.cfg.peerjs, hostPeerId(code), peerToken(hostToken));
      const verdict = await new Promise<'free' | 'taken' | 'unknown'>((resolve) => {
        const t = window.setTimeout(() => resolve('unknown'), PROBE_WAIT_MS);
        probe.onstatus = (up) => {
          if (up) {
            window.clearTimeout(t);
            resolve('free');
          }
        };
        probe.ontaken = () => {
          window.clearTimeout(t);
          resolve('taken');
        };
        probe.start();
      });
      probe.onstatus = probe.ontaken = null;
      if (verdict === 'taken') {
        probe.close();
        continue;
      }
      return { code, probe };
    }
    // Extremely unlikely: fall back to the last random code without the check.
    return this.pickCodeUnchecked();
  }

  private pickCodeUnchecked(): { code: string; probe: null } {
    let code = '';
    for (let i = 0; i < 4; i++) code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
    return { code, probe: null };
  }

  private closeLoop(l: LoopLink, ev: { code: number; reason: string } | null): void {
    if (this.current === l) this.current = null;
    const wasOpen = l.open;
    l.open = false;
    this.hub.onClose(l.client);
    // close() by HostNet itself fires nothing; a server-side close (replaced) is reported.
    if (ev && wasOpen) window.setTimeout(() => l.onclose?.(ev), 0);
  }

  // ================================================================== signalling + phones

  /** Start answering phones for `room`. */
  private serve(room: Room, probe: PeerJsSignal | null): void {
    if (this.code === room.code && this.signals.length) {
      probe?.close();
      return;
    }
    this.stopService();
    this.code = room.code;
    this.taken = false;
    const id = hostPeerId(room.code);
    const signals: Signaller[] = [];
    if (this.cfg.peerjs.length) signals.push(probe ?? new PeerJsSignal(this.cfg.peerjs, id, peerToken(room.hostToken)));
    if (this.cfg.nostr.length) signals.push(new NostrSignal(this.cfg.nostr, id, room.code));
    for (const s of signals) {
      s.onmessage = (from, m) => this.onSignal(from, m);
      s.onstatus = () => this.emitStatus();
      s.ontaken = () => {
        // Someone else holds this room's id on the PeerJS server (normally our own previous page,
        // which frees it within seconds). Phones can still come in through the other service.
        if (!this.taken) console.warn(`[room] PeerJS id for ${room.code} is in use; retrying`);
        this.taken = true;
        this.emitStatus();
      };
      s.start();
    }
    this.signals = signals;
    this.emitStatus();
  }

  private stopService(): void {
    for (const s of this.signals) {
      s.onmessage = s.onstatus = s.ontaken = null;
      s.close();
    }
    this.signals = [];
    for (const e of [...this.peers.values()]) this.dropPeer(e);
    this.earlyCands.clear();
    this.code = null;
  }

  private emitStatus(): void {
    this.onstatus?.(this.status());
  }

  private replyTo(to: string, m: SignalMsg): void {
    for (const s of this.signals) if (s.up) s.send(to, m);
  }

  private onSignal(from: string, m: SignalMsg): void {
    if (!this.code || typeof from !== 'string' || from.length > 80) return;
    if (m.kind === 'offer') {
      if (!m.sdp || this.peers.has(m.cid)) return; // duplicate through the other service
      if (this.peers.size >= MAX_PENDING_PEERS) return;
      this.acceptPhone(from, m.cid, m.sdp);
    } else if (m.kind === 'candidate') {
      const e = this.peers.get(m.cid);
      if (e) {
        if (e.from === from) e.peer.addCandidate(m.cand);
        return;
      }
      // Candidates can overtake their offer (relays don't keep order): hold them briefly.
      let early = this.earlyCands.get(m.cid);
      if (!early) {
        if (this.earlyCands.size > 64) this.earlyCands.clear();
        early = { from, at: performance.now(), cands: [] };
        this.earlyCands.set(m.cid, early);
      }
      if (early.from === from && early.cands.length < 32) early.cands.push(m.cand);
    }
  }

  private acceptPhone(from: string, cid: string, sdp: string): void {
    const now = performance.now();
    const peer = new RtcPeer(cid, this.cfg.iceServers);
    const e: PeerEntry = { peer, from, client: null, createdAt: now, openedAt: 0, lastRx: now, closing: false };
    this.peers.set(cid, e);
    peer.onsignal = (m) => this.replyTo(from, m);
    peer.onopen = () => {
      e.openedAt = e.lastRx = performance.now();
      const sock: Sock = {
        send: (data) => peer.send(data),
        close: () => this.closePeerSoon(e),
        isOpen: () => peer.isOpen && !e.closing,
      };
      e.client = this.hub.newClient(sock, `phone ${from.slice(3, 9)}`, undefined);
    };
    peer.onmessage = (data) => {
      e.lastRx = performance.now();
      if (e.client && !e.closing) this.hub.onMessage(e.client, data);
    };
    peer.onend = () => this.dropPeer(e);
    peer
      .acceptOffer(sdp)
      .then(() => {
        const early = this.earlyCands.get(cid);
        this.earlyCands.delete(cid);
        if (early && early.from === from) for (const c of early.cands) peer.addCandidate(c);
      })
      .catch((err) => {
        console.warn('[room] bad offer', err);
        this.dropPeer(e);
      });
  }

  /** Close after the last message (an error/kick notice) has left the buffer. */
  private closePeerSoon(e: PeerEntry): void {
    if (e.closing) return;
    e.closing = true;
    const t0 = performance.now();
    const wait = (): void => {
      if (e.peer.buffered > 0 && performance.now() - t0 < 1000) window.setTimeout(wait, 50);
      else this.dropPeer(e);
    };
    window.setTimeout(wait, 50);
  }

  private dropPeer(e: PeerEntry): void {
    if (this.peers.get(e.peer.cid) === e) this.peers.delete(e.peer.cid);
    e.peer.onend = null;
    e.peer.close();
    const c = e.client;
    e.client = null;
    if (c) this.hub.onClose(c);
  }

  private checkPeers(): void {
    const now = performance.now();
    for (const e of [...this.peers.values()]) {
      if (e.client) {
        if (now - e.lastRx > PHONE_SILENT_MS) this.dropPeer(e);
        else if (e.client.role === 'none' && now - e.openedAt > HELLO_TIMEOUT_MS) this.dropPeer(e);
      } else if (now - e.createdAt > PENDING_MAX_MS) {
        this.dropPeer(e);
      }
    }
    for (const [cid, early] of this.earlyCands) if (now - early.at > 10_000) this.earlyCands.delete(cid);
  }

  // ================================================================== persistence + tabs

  private loadSnapshot(): RoomSnapshot | null {
    const raw = storageGet('session', SNAPSHOT_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as RoomSnapshot;
    } catch {
      return null;
    }
  }

  private persist(room: Room): void {
    const snap = this.hub.exportRoom(room.code);
    if (snap) storageSet('session', SNAPSHOT_KEY, JSON.stringify(snap));
  }

  /** Ask other tabs for `room`; resolves with the handed-over snapshot, or null if nobody has it. */
  private claim(room: string): Promise<RoomSnapshot | null> {
    if (!this.bc) return Promise.resolve(null);
    return new Promise((resolve) => {
      const t = window.setTimeout(() => {
        this.claimWaiter = null;
        resolve(null);
      }, CLAIM_WAIT_MS);
      this.claimWaiter = (snap) => {
        window.clearTimeout(t);
        this.claimWaiter = null;
        resolve(snap);
      };
      this.post({ t: 'claim', room, tab: this.tabId });
    });
  }

  private onTabMessage(m: BcMsg): void {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'claim' && m.tab !== this.tabId && m.room === this.code) {
      this.release(m.tab);
    } else if (m.t === 'released' && m.tab === this.tabId) {
      this.claimWaiter?.(m.snap ?? null);
    }
  }

  /** Another tab takes this room: hand it over and step down (like the server's CLOSE_REPLACED). */
  private release(toTab: string): void {
    const code = this.code;
    if (!code) return;
    const snap = this.hub.exportRoom(code);
    this.post({ t: 'released', room: code, tab: toTab, snap });
    const l = this.current;
    if (l && l.open) {
      l.client.sock.send(JSON.stringify({ t: 'error', code: 'host_gone', message: 'The game was opened in another tab/window.' }));
    }
    this.stopService();
    this.hub.rooms.delete(code);
    if (l) window.setTimeout(() => this.closeLoop(l, { code: CLOSE_REPLACED, reason: 'replaced by newer host' }), 0);
  }

  private post(m: BcMsg): void {
    try {
      this.bc?.postMessage(m);
    } catch {
      /* ignore */
    }
  }

  private readonly onPageHide = (): void => {
    // Reload / close: drop phones now (they notice at once and start reconnecting) and free the
    // signalling ids. The room snapshot is already saved.
    this.stopService();
  };

  /** Back/forward cache brought the page back after pagehide stopped everything: start clean. */
  private readonly onPageShow = (ev: PageTransitionEvent): void => {
    if (ev.persisted) window.location.reload();
  };
}
