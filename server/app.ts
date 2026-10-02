/**
 * Party Hub server: Express (static pages + small JSON/QR API) and the
 * WebSocket relay, over HTTP and optionally HTTPS (self-signed).
 *
 * `startServer()` is importable so tests/selftests can boot it in-process.
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import QRCode from 'qrcode';
import { DEFAULT_HTTPS_PORT, DEFAULT_PORT } from '../src/net/protocol';
import { loadOrCreateCert } from './certs';
import { lanIPs } from './lan';
import { createLogger, type Logger } from './log';
import { Hub } from './rooms';
import { createWsRelay, type WsOptions } from './ws';

export interface ServerOptions {
  /** HTTP port. Default env PORT or 3000. 0 = random free port. */
  port?: number;
  /** If the port is busy, try the next ones (up to +10). Default true. */
  portFallback?: boolean;
  /** Also serve HTTPS (self-signed) and advertise https join URLs. */
  https?: boolean;
  /** HTTPS port (default 3443, with the same fallback). 0 = random. */
  httpsPort?: number;
  /** Override LAN IP detection. */
  hostIp?: string;
  /** Directory with the vite build (index.html, play.html, assets/). Default 'dist'. */
  staticDir?: string;
  /** Where the self-signed cert is cached. Default './certs'. */
  certDir?: string;
  /** Silence join/leave logs. */
  quiet?: boolean;
  /** Bind address. Default all interfaces. */
  bind?: string;
  /** Rooms without a host are deleted after this long (default 30 min). */
  roomTtlMs?: number;
  /** WebSocket liveness tuning (tests use short intervals). */
  ws?: WsOptions;
  logger?: Logger;
}

export interface RunningServer {
  port: number;
  httpsPort: number | null;
  /** LAN base URLs, best first (https ones first in --https mode). */
  urls: string[];
  /** True if a LAN IP was found (otherwise phones probably can't connect). */
  lanFound: boolean;
  staticDir: string;
  staticOk: boolean;
  hub: Hub;
  close(): Promise<void>;
}

const LOCAL_HOST_RE = /^(localhost|127\.|\[?::1\]?|0\.0\.0\.0)/i;

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const log = opts.logger ?? createLogger(!!opts.quiet);
  const staticDir = path.resolve(opts.staticDir ?? 'dist');
  const indexFile = path.join(staticDir, 'index.html');
  const playFile = path.join(staticDir, 'play.html');
  const staticOk = fs.existsSync(indexFile);
  const envPort = Number(process.env.PORT);
  const wantPort = opts.port ?? (Number.isInteger(envPort) && envPort >= 0 ? envPort : DEFAULT_PORT);
  const fallback = opts.portFallback ?? true;

  // Filled in once we know the bound ports.
  let port = 0;
  let httpsPort: number | null = null;

  /** Base URLs phones can use, best first. */
  function baseUrls(reqHost?: string): string[] {
    const ips = lanIPs(opts.hostIp);
    const urls: string[] = [];
    if (httpsPort !== null) for (const ip of ips) urls.push(`https://${ip}:${httpsPort}`);
    for (const ip of ips) urls.push(`http://${ip}:${port}`);
    if (urls.length === 0) {
      // No LAN IP: use whatever host name the game page was opened with, if it's not loopback.
      const h = reqHost?.trim();
      if (h && !LOCAL_HOST_RE.test(h)) urls.push(`http://${h}`);
      urls.push(`http://localhost:${port}`);
    }
    return urls;
  }

  const hub = new Hub({
    log,
    roomTtlMs: opts.roomTtlMs,
    urlsFor: (reqHost) => ({ urls: baseUrls(reqHost), https: httpsPort !== null }),
  });
  const sweeper = setInterval(() => hub.sweep(), 30_000);
  sweeper.unref();

  // ---------------------------------------------------------------- express
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', true);

  const missingBuild = (res: Response): void => {
    res
      .status(503)
      .type('html')
      .send(
        '<h1>Party Hub: game not built</h1><p>Run <code>npm run build</code> (or <code>npm start</code>) and reload.</p>',
      );
  };
  const sendPage = (file: string) => (_req: Request, res: Response) => {
    if (!fs.existsSync(file)) return missingBuild(res);
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(file);
  };

  app.get('/', sendPage(indexFile));
  app.get(['/play', '/play/'], sendPage(playFile));
  // Convenience: /play/ABCD -> /play?room=ABCD (easy to type on a phone).
  app.get('/play/:room', (req, res) => {
    const room = String(req.params.room ?? '').replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase();
    res.redirect(302, room ? `/play?room=${room}` : '/play');
  });

  app.get('/api/info', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ urls: baseUrls(req.headers.host), port, httpsPort });
  });

  const qrCache = new Map<string, string>();
  app.get('/api/qr.svg', async (req, res) => {
    const data = typeof req.query.data === 'string' ? req.query.data : '';
    if (!data || data.length > 512) {
      res.status(400).type('text').send('data query parameter required (max 512 chars)');
      return;
    }
    try {
      let svg = qrCache.get(data);
      if (!svg) {
        svg = await QRCode.toString(data, {
          type: 'svg',
          margin: 2,
          errorCorrectionLevel: 'M',
          color: { dark: '#000000', light: '#ffffff' },
        });
        if (qrCache.size > 64) qrCache.clear();
        qrCache.set(data, svg);
      }
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.type('image/svg+xml').send(svg);
    } catch (err) {
      log.error('QR generation failed:', err);
      res.status(500).type('text').send('QR generation failed');
    }
  });

  app.get('/api/debug/rooms', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(hub.debugRooms());
  });

  app.use(
    express.static(staticDir, {
      index: false,
      setHeaders(res, filePath) {
        const rel = path.relative(staticDir, filePath).split(path.sep).join('/');
        if (rel.startsWith('assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );
  app.use((_req, res) => {
    res.status(404).type('text').send('Not found');
  });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log.error('HTTP handler error:', err);
    if (!res.headersSent) res.status(500).type('text').send('Internal error');
  });

  // ---------------------------------------------------------------- servers
  const relay = createWsRelay(hub, log, opts.ws);
  const servers: http.Server[] = [];

  const httpServer = http.createServer({ noDelay: true }, app);
  httpServer.on('clientError', (_err, socket) => socket.destroy());
  relay.attach(httpServer);
  servers.push(httpServer);
  port = await listen(httpServer, wantPort, fallback, opts.bind);

  if (opts.https) {
    const ips = lanIPs(opts.hostIp);
    const t0 = Date.now();
    const pair = loadOrCreateCert(path.resolve(opts.certDir ?? 'certs'), ips);
    if (pair.fresh) log.info(`generated self-signed certificate in ${Date.now() - t0} ms`);
    const httpsServer = https.createServer({ key: pair.key, cert: pair.cert, noDelay: true }, app);
    // Phones that don't trust the cert yet produce TLS errors here: ignore them.
    httpsServer.on('clientError', (_err, socket) => socket.destroy());
    httpsServer.on('tlsClientError', () => undefined);
    relay.attach(httpsServer);
    servers.push(httpsServer);
    httpsPort = await listen(httpsServer, opts.httpsPort ?? DEFAULT_HTTPS_PORT, fallback, opts.bind);
  }

  if (!staticOk) {
    log.error(
      `\n  The game build is missing: ${indexFile} not found.\n  Run "npm run build" first (or just "npm start", which builds and runs).\n`,
    );
  }

  let closed: Promise<void> | null = null;
  return {
    port,
    httpsPort,
    urls: baseUrls(),
    lanFound: lanIPs(opts.hostIp).length > 0,
    staticDir,
    staticOk,
    hub,
    close() {
      if (closed) return closed;
      clearInterval(sweeper);
      relay.close();
      closed = Promise.all(
        servers.map(
          (s) =>
            new Promise<void>((resolve) => {
              s.close(() => resolve());
              s.closeAllConnections?.();
            }),
        ),
      ).then(() => undefined);
      return closed;
    },
  };
}

/** Listen on `port`; on EADDRINUSE try port+1 ... port+10 (if allowed). Resolves to the bound port. */
function listen(server: http.Server, port: number, fallback: boolean, bind?: string): Promise<number> {
  const maxTries = fallback && port !== 0 ? 11 : 1;
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = (): void => {
      const p = port === 0 ? 0 : port + attempt;
      const onError = (err: NodeJS.ErrnoException): void => {
        server.off('listening', onListening);
        if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && ++attempt < maxTries) tryListen();
        else reject(new Error(`Could not listen on port ${p}: ${err.code ?? err.message}`));
      };
      const onListening = (): void => {
        server.off('error', onError);
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : p);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      if (bind) server.listen(p, bind);
      else server.listen(p);
    };
    tryListen();
  });
}
