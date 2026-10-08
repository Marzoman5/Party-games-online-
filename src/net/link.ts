/**
 * Transport seam. HostNet (host page) and Net (phone) speak src/net/protocol.ts over a `Link`: a
 * text-message pipe to "the relay". Two implementations exist:
 *
 *   - `wsLink(url)`: a WebSocket to the Node server (`npm start`, local / offline play).
 *   - WebRTC (static site): the host page runs the relay itself (src/engine/net/rtc/RoomServer.ts)
 *     and phones reach it over a direct data channel (src/phone/rtcLink.ts).
 *
 * Everything above a Link (join/reclaim, pings, reconnect backoff, the games) is identical for both.
 */

export interface LinkClose {
  /** Application close code (4000-4999 as in src/net/hub.ts), or 1000/1006 for normal/abnormal. */
  code: number;
  reason: string;
}

export interface Link {
  readonly isOpen: boolean;
  /** In-memory link (the host page talking to its own room server): it can't go silent, skip liveness checks. */
  readonly local?: boolean;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  /** Fires once, after open or instead of it (connection failed). Not fired by close(). */
  onclose: ((ev: LinkClose) => void) | null;
}

export type LinkFactory = () => Link;

/** Which transport this build / page uses. */
export type TransportKind = 'ws' | 'rtc';

/**
 * `?net=ws|rtc` overrides; otherwise the build decides (`VITE_TRANSPORT`, set by `npm run build:static`).
 */
export function transportKind(): TransportKind {
  try {
    const q = new URLSearchParams(window.location.search).get('net');
    if (q === 'ws' || q === 'rtc') return q;
  } catch {
    /* ignore */
  }
  return import.meta.env.VITE_TRANSPORT === 'rtc' ? 'rtc' : 'ws';
}

/** A Link over a browser WebSocket. */
export function wsLink(url: string): Link {
  const ws = new WebSocket(url);
  let closed = false;
  const link: Link = {
    get isOpen() {
      return !closed && ws.readyState === WebSocket.OPEN;
    },
    send(data) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    close() {
      closed = true;
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
    onopen: null,
    onmessage: null,
    onclose: null,
  };
  ws.onopen = () => link.onopen?.();
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') link.onmessage?.(ev.data);
  };
  ws.onclose = (ev) => {
    closed = true;
    link.onclose?.({ code: ev.code, reason: ev.reason });
  };
  ws.onerror = () => {
    /* onclose follows */
  };
  return link;
}
