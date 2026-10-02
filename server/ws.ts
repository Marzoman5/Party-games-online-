/**
 * WebSocket transport: binds `ws` to one or more HTTP(S) servers on WS_PATH and
 * feeds frames into the Hub. Also does liveness: a ws-level ping every
 * `pingIntervalMs` (3 s); a socket that misses 2 in a row is terminated, which
 * fires the normal close path (host notified, seat kept for reconnect).
 */
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { WS_PATH } from '../src/net/protocol';
import { CLOSE_HELLO_TIMEOUT, type Client, type Hub } from './rooms';
import type { Logger } from './log';

export interface WsOptions {
  pingIntervalMs?: number;
  /** Close connections that never identify themselves after this long. */
  helloTimeoutMs?: number;
  /** Kill a socket whose send buffer grows beyond this (stalled client). */
  maxBufferedBytes?: number;
}

interface Tracked {
  client: Client;
  missed: number;
}

export interface WsRelay {
  attach(server: HttpServer): void;
  close(): void;
  readonly wss: WebSocketServer;
}

export function createWsRelay(hub: Hub, log: Logger, opts: WsOptions = {}): WsRelay {
  const pingEvery = opts.pingIntervalMs ?? 3000;
  const helloTimeout = opts.helloTimeoutMs ?? 15000;
  const maxBuffered = opts.maxBufferedBytes ?? 2 * 1024 * 1024;
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 16 * 1024 });
  const tracked = new Map<WebSocket, Tracked>();

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const remote = (req.socket.remoteAddress ?? '?').replace(/^::ffff:/, '');
    const client = hub.newClient(
      {
        send: (data) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (ws.bufferedAmount > maxBuffered) {
            log.warn(`terminating stalled socket ${remote} (${ws.bufferedAmount} bytes queued)`);
            ws.terminate();
            return;
          }
          ws.send(data);
        },
        close: (code, reason) => {
          try {
            ws.close(code, reason);
          } catch {
            ws.terminate();
          }
        },
        isOpen: () => ws.readyState === WebSocket.OPEN,
      },
      remote,
      req.headers.host,
    );
    const t: Tracked = { client, missed: 0 };
    tracked.set(ws, t);

    const helloTimer = setTimeout(() => {
      if (client.role === 'none' && ws.readyState === WebSocket.OPEN) ws.close(CLOSE_HELLO_TIMEOUT, 'no hello');
    }, helloTimeout);

    ws.on('message', (data: RawData, isBinary: boolean) => {
      t.missed = 0;
      if (isBinary) return; // protocol is text-only
      const raw = Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Array.isArray(data)
          ? Buffer.concat(data).toString('utf8')
          : Buffer.from(data).toString('utf8');
      hub.onMessage(client, raw);
    });
    ws.on('pong', () => {
      t.missed = 0;
    });
    ws.on('error', (err) => log.info(`socket error (${remote}): ${err.message}`));
    ws.on('close', () => {
      clearTimeout(helloTimer);
      tracked.delete(ws);
      hub.onClose(client);
    });
  });

  const pinger = setInterval(() => {
    for (const [ws, t] of tracked) {
      if (t.missed >= 2) {
        log.info(`dropping unresponsive socket (${t.client.remote})`);
        ws.terminate();
        continue;
      }
      t.missed++;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, pingEvery);
  pinger.unref();

  function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let pathname = '';
    try {
      pathname = new URL(req.url ?? '/', 'http://x').pathname;
    } catch {
      /* fallthrough */
    }
    if (pathname !== WS_PATH && pathname !== `${WS_PATH}/`) {
      socket.destroy();
      return;
    }
    socket.on('error', () => socket.destroy());
    const s = socket as Duplex & { setNoDelay?: (b: boolean) => void };
    s.setNoDelay?.(true);
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  }

  return {
    wss,
    attach(server) {
      server.on('upgrade', onUpgrade);
    },
    close() {
      clearInterval(pinger);
      for (const ws of tracked.keys()) ws.terminate();
      tracked.clear();
      wss.close();
    },
  };
}
