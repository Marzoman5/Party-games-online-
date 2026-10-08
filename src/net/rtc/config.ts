/**
 * WebRTC transport settings (static site). Change them here, or at build time with env vars
 * (GitHub Actions passes repository variables of the same names, see .github/workflows/deploy.yml):
 *
 *   VITE_ICE_SERVERS  JSON RTCIceServer[]  e.g. add a TURN server:
 *                     [{"urls":"stun:stun.l.google.com:19302"},
 *                      {"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]
 *   VITE_PEERJS       comma-separated PeerJS server WebSocket URLs (primary signalling)
 *   VITE_NOSTR        comma-separated Nostr relay URLs (fallback signalling)
 *
 * Test/debug only: the same three can be overridden per page with `?ice=`, `?peerjs=`, `?nostr=`
 * (an empty value disables that signaller). The host copies these overrides into the phones' join
 * link so both ends use the same services.
 */

export interface RtcConfig {
  iceServers: RTCIceServer[];
  /** PeerJS-protocol signalling servers, as WebSocket URLs with `key` (no id/token). Tried in order. */
  peerjs: string[];
  /** Nostr relays (all used at once). */
  nostr: string[];
}

/** Free public STUN: lets phones on the same network (and many others) find a direct route. No TURN by default. */
const DEFAULT_ICE: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/** The free public PeerJS cloud server (no account). */
const DEFAULT_PEERJS = ['wss://0.peerjs.com/peerjs?key=peerjs'];

/** Free public Nostr relays (no account). Used as a fallback channel when PeerJS is down. */
const DEFAULT_NOSTR = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.nostr.band'];

/** Query parameters that override the config (and get copied into join links). */
export const RTC_OVERRIDE_PARAMS = ['ice', 'peerjs', 'nostr'] as const;

function list(v: string | undefined | null): string[] | null {
  if (v === undefined || v === null) return null;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function ice(v: string | undefined | null): RTCIceServer[] | null {
  if (!v) return null;
  try {
    const parsed: unknown = JSON.parse(v);
    if (Array.isArray(parsed)) return parsed as RTCIceServer[];
  } catch {
    console.warn('[rtc] ignoring invalid ICE server JSON');
  }
  return null;
}

function query(): URLSearchParams {
  try {
    return new URLSearchParams(window.location.search);
  } catch {
    return new URLSearchParams();
  }
}

export function rtcConfig(): RtcConfig {
  const q = query();
  const env = import.meta.env;
  return {
    iceServers: ice(q.get('ice')) ?? ice(env.VITE_ICE_SERVERS) ?? DEFAULT_ICE,
    // An empty build variable means "not set" (CI passes unset repository variables as ''); an empty
    // URL override means "disable this signaller".
    peerjs: list(q.get('peerjs')) ?? list(env.VITE_PEERJS || null) ?? DEFAULT_PEERJS,
    nostr: list(q.get('nostr')) ?? list(env.VITE_NOSTR || null) ?? DEFAULT_NOSTR,
  };
}

/** `&peerjs=…&nostr=…` for the overrides present on this page ('' if none). */
export function rtcOverrideQuery(): string {
  const q = query();
  let out = '';
  for (const k of RTC_OVERRIDE_PARAMS) {
    const v = q.get(k);
    if (v !== null) out += `&${k}=${encodeURIComponent(v)}`;
  }
  return out;
}

/** Signalling id of the host page for a room code. Namespaced: the public servers are shared with other apps. */
export function hostPeerId(room: string): string {
  return `partyhub-mz5-v1-${room.toUpperCase()}`;
}
