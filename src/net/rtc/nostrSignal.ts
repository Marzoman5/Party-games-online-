/**
 * Fallback signalling over public Nostr relays (no account: each page makes a throwaway key).
 *
 * A message to peer X is an ephemeral event (kind 21891: relays forward it to live subscribers and
 * don't store it) tagged `t = topic(X)`; every page subscribes to its own topic on every relay and
 * de-duplicates by event id. The content is AES-GCM encrypted with a key derived from the room code,
 * so relays and their other users can't read the connection details (IP addresses in the SDP).
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { backoff, isSignalMsg, type SignalMsg, type Signaller } from './signal';

const KIND = 21891;
/** Treat a relay as usable this long after the subscription went out even without EOSE. */
const SUB_GRACE_MS = 1500;

interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

function topic(peerId: string): string {
  return bytesToHex(sha256(utf8ToBytes(`partyhub-mz5|${peerId}`))).slice(0, 40);
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

class Relay {
  ws: WebSocket | null = null;
  ready = false;
  attempt = 0;
  retryTimer = 0;
  graceTimer = 0;
  constructor(readonly url: string) {}
}

export class NostrSignal implements Signaller {
  readonly name = 'nostr';
  onmessage: Signaller['onmessage'] = null;
  onstatus: Signaller['onstatus'] = null;
  ontaken: Signaller['ontaken'] = null;
  private readonly relays: Relay[];
  private readonly sk = schnorr.utils.randomSecretKey();
  private readonly pk = bytesToHex(schnorr.getPublicKey(this.sk));
  private readonly myTopic: string;
  private readonly subId = `ph${Math.random().toString(36).slice(2, 10)}`;
  private readonly seen = new Set<string>();
  private key: Promise<CryptoKey | null>;
  private closed = false;
  private wasUp = false;

  constructor(
    urls: string[],
    private readonly id: string,
    room: string,
  ) {
    this.relays = urls.map((u) => new Relay(u));
    this.myTopic = topic(id);
    const subtle = globalThis.crypto?.subtle;
    this.key = subtle
      ? subtle
          .digest('SHA-256', utf8ToBytes(`partyhub-signal|${room.toUpperCase()}`))
          .then((raw) => subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']))
          .catch(() => null)
      : Promise.resolve(null);
  }

  get up(): boolean {
    return this.relays.some((r) => r.ready);
  }

  start(): void {
    if (this.closed) return;
    for (const r of this.relays) if (!r.ws) this.connect(r);
  }

  send(to: string, msg: SignalMsg): void {
    if (!this.up) return;
    void this.publish(to, msg);
  }

  close(): void {
    this.closed = true;
    for (const r of this.relays) this.drop(r);
    this.status();
  }

  // ------------------------------------------------------------------ internals

  private connect(r: Relay): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(r.url);
    } catch {
      this.retry(r);
      return;
    }
    r.ws = ws;
    ws.onopen = () => {
      if (r.ws !== ws) return;
      ws.send(JSON.stringify(['REQ', this.subId, { kinds: [KIND], '#t': [this.myTopic], since: Math.floor(Date.now() / 1000) - 30 }]));
      r.graceTimer = window.setTimeout(() => this.markReady(r), SUB_GRACE_MS);
    };
    ws.onmessage = (ev) => {
      if (r.ws !== ws || typeof ev.data !== 'string') return;
      let m: unknown;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!Array.isArray(m)) return;
      if (m[0] === 'EOSE' && m[1] === this.subId) this.markReady(r);
      else if (m[0] === 'EVENT' && m[1] === this.subId) void this.receive(m[2] as NostrEvent);
      else if (m[0] === 'CLOSED' && m[1] === this.subId) {
        console.warn(`[rtc] nostr relay ${r.url} closed the subscription: ${String(m[2])}`);
        this.drop(r);
        this.retry(r);
      }
    };
    ws.onclose = () => {
      if (r.ws !== ws) return;
      this.drop(r);
      this.retry(r);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private markReady(r: Relay): void {
    window.clearTimeout(r.graceTimer);
    if (!r.ws || r.ready) return;
    r.ready = true;
    r.attempt = 0;
    this.status();
  }

  private drop(r: Relay): void {
    window.clearTimeout(r.graceTimer);
    window.clearTimeout(r.retryTimer);
    const ws = r.ws;
    r.ws = null;
    r.ready = false;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.status();
  }

  private retry(r: Relay): void {
    if (this.closed) return;
    window.clearTimeout(r.retryTimer);
    r.retryTimer = window.setTimeout(() => this.connect(r), backoff(r.attempt++));
  }

  private status(): void {
    const up = this.up;
    if (up === this.wasUp) return;
    this.wasUp = up;
    this.onstatus?.(up);
  }

  private async publish(to: string, msg: SignalMsg): Promise<void> {
    const key = await this.key;
    if (!key) return;
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const plain = utf8ToBytes(JSON.stringify({ f: this.id, m: msg }));
    const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
    const packed = new Uint8Array(iv.length + ct.length);
    packed.set(iv);
    packed.set(ct, iv.length);
    const created_at = Math.floor(Date.now() / 1000);
    const tags = [['t', topic(to)]];
    const content = b64(packed);
    const id = bytesToHex(sha256(utf8ToBytes(JSON.stringify([0, this.pk, created_at, KIND, tags, content]))));
    const sig = bytesToHex(schnorr.sign(hexToBytes(id), this.sk));
    const ev: NostrEvent = { id, pubkey: this.pk, created_at, kind: KIND, tags, content, sig };
    const frame = JSON.stringify(['EVENT', ev]);
    for (const r of this.relays) {
      if (r.ready && r.ws && r.ws.readyState === WebSocket.OPEN) {
        try {
          r.ws.send(frame);
        } catch {
          /* closing */
        }
      }
    }
  }

  private async receive(ev: NostrEvent): Promise<void> {
    if (!ev || typeof ev.id !== 'string' || typeof ev.content !== 'string' || ev.kind !== KIND) return;
    if (this.seen.has(ev.id)) return; // the same event arrives from every relay
    this.seen.add(ev.id);
    if (this.seen.size > 500) this.seen.clear();
    if (!ev.tags?.some((t) => t[0] === 't' && t[1] === this.myTopic)) return;
    const key = await this.key;
    if (!key) return;
    try {
      const packed = unb64(ev.content);
      const plain = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: packed.slice(0, 12) }, key, packed.slice(12));
      const body = JSON.parse(new TextDecoder().decode(plain)) as { f?: unknown; m?: unknown };
      if (typeof body.f === 'string' && isSignalMsg(body.m)) this.onmessage?.(body.f, body.m);
    } catch {
      /* not for this room (wrong key) or garbage */
    }
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
