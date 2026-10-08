/**
 * Signalling: how a phone and the host page exchange the few messages (offer, answer, ICE candidates)
 * needed to open a direct WebRTC connection. After that, all game traffic is phone <-> host directly.
 *
 * Two independent public services carry them (src/net/rtc/config.ts); both ends use every service that
 * is reachable and de-duplicate, so one outage doesn't stop people joining:
 *   - PeerJsSignal: a PeerJS server (primary; also tells us when a room id is already taken).
 *   - NostrSignal: public Nostr relays (fallback; messages end-to-end encrypted with the room code).
 */

export interface SignalMsg {
  kind: 'offer' | 'answer' | 'candidate';
  /** Connection attempt id (a phone makes a new one per attempt). */
  cid: string;
  sdp?: string;
  cand?: RTCIceCandidateInit | null;
}

export interface Signaller {
  readonly name: string;
  /** Registered and able to send/receive right now. */
  readonly up: boolean;
  /** Connect and register as `id`. Keeps reconnecting until close(). */
  start(): void;
  send(to: string, msg: SignalMsg): void;
  close(): void;
  onmessage: ((from: string, msg: SignalMsg) => void) | null;
  onstatus: ((up: boolean) => void) | null;
  /** The id is held by someone else (PeerJS only). Reconnecting continues. */
  ontaken: (() => void) | null;
}

export function isSignalMsg(v: unknown): v is SignalMsg {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return (m.kind === 'offer' || m.kind === 'answer' || m.kind === 'candidate') && typeof m.cid === 'string' && m.cid.length <= 64;
}

export function randomId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '');
}

/** Reconnect delays shared by the signallers: 1 s, 2 s, 4 s … capped at 15 s, with jitter. */
export function backoff(attempt: number): number {
  return Math.min(15_000, 1000 * 2 ** Math.min(attempt, 4)) * (0.8 + Math.random() * 0.4);
}
