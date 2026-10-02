/**
 * Kart Party — party-layer tuning knobs and small shared helpers.
 * Everything time-related for the party flow lives here so it is easy to tweak.
 */
import { DEFAULT_PORT, WS_PATH } from '../net/protocol';

/** Tutorial: duration of each of the 6 steps (ms). 6 × 3.8 s ≈ 23 s. */
export const TUTORIAL_STEP_MS = 3800;
export const TUTORIAL_STEPS = 6;
/** Tutorial: after the last step, wait at most this long for every "Got it!". */
export const TUTORIAL_ACK_WAIT_MS = 10_000;
/** Tutorial: short beat after everyone acked so the last checkmark is visible. */
export const TUTORIAL_ALL_ACKED_DELAY_MS = 1200;
/** In-race status packets to phones (~10 Hz). */
export const RACE_STATUS_MS = 100;
/** GP points by finishing place (1st..8th). */
export const GP_POINTS = [15, 12, 10, 8, 6, 4, 2, 1] as const;
/** Host <-> server liveness. */
export const PING_MS = 2000;
export const PING_TIMEOUT_MS = 9000;
/** Reconnect backoff. */
export const RECONNECT_MIN_MS = 400;
export const RECONNECT_MAX_MS = 5000;
/** Show the "can't reach server" help after the first connect has failed for this long. */
export const SERVER_UNREACHABLE_MS = 4000;
/** "Reconnecting…" banner appears only if the outage lasts longer than this. */
export const BANNER_DELAY_MS = 1200;
/** Cursor re-appears for this long after the mouse moves during a race. */
export const CURSOR_SHOW_MS = 2000;

export const STORAGE = {
  host: 'kartparty.host', // sessionStorage: { room, hostToken }
  session: 'kartparty.session', // sessionStorage: player profiles etc. (survive host reload)
  tv: 'kartparty.tv', // localStorage: '1' | '0'
} as const;

export function params(): URLSearchParams {
  try {
    return new URLSearchParams(window.location.search);
  } catch {
    return new URLSearchParams();
  }
}

/**
 * WebSocket URL. `?ws=ws://host:port/ws` overrides (tests / mock servers). In the Vite dev
 * server (no relay on the same origin) default to the relay on DEFAULT_PORT.
 */
export function resolveWsUrl(): string {
  const override = params().get('ws');
  if (override) return override;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (import.meta.env.DEV) return `${proto}//${window.location.hostname}:${DEFAULT_PORT}${WS_PATH}`;
  return `${proto}//${window.location.host}${WS_PATH}`;
}

/** HTTP base of the relay server (for /api/qr.svg), derived from the WS URL. */
export function resolveApiBase(wsUrl: string): string {
  try {
    const u = new URL(wsUrl);
    const http = u.protocol === 'wss:' ? 'https:' : 'http:';
    if (u.host === window.location.host) return '';
    return `${http}//${u.host}`;
  } catch {
    return '';
  }
}

export function storageGet(kind: 'session' | 'local', key: string): string | null {
  try {
    return (kind === 'session' ? window.sessionStorage : window.localStorage).getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(kind: 'session' | 'local', key: string, value: string | null): void {
  try {
    const s = kind === 'session' ? window.sessionStorage : window.localStorage;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    /* private mode / quota: ignore */
  }
}

/** Named timeouts/intervals that can all be cleared at once (no timers left behind). */
export class Timers {
  private readonly map = new Map<string, { id: number; interval: boolean }>();

  timeout(name: string, ms: number, fn: () => void): void {
    this.clear(name);
    const id = window.setTimeout(() => {
      this.map.delete(name);
      fn();
    }, ms);
    this.map.set(name, { id, interval: false });
  }

  interval(name: string, ms: number, fn: () => void): void {
    this.clear(name);
    const id = window.setInterval(fn, ms);
    this.map.set(name, { id, interval: true });
  }

  has(name: string): boolean {
    return this.map.has(name);
  }

  clear(name: string): void {
    const t = this.map.get(name);
    if (!t) return;
    if (t.interval) window.clearInterval(t.id);
    else window.clearTimeout(t.id);
    this.map.delete(name);
  }

  clearAll(): void {
    for (const name of Array.from(this.map.keys())) this.clear(name);
  }
}

export function formatTime(sec: number): string {
  if (!(sec >= 0) || !Number.isFinite(sec)) return '—';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(3)}`;
}

export function ordinal(n: number): string {
  const s = ['TH', 'ST', 'ND', 'RD'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
