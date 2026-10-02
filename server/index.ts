/**
 * Kart Party server entry (bundled to dist-server/server.mjs).
 *
 *   node dist-server/server.mjs [--port N] [--https] [--https-port N] [--host-ip X]
 *                               [--static DIR] [--quiet] [--no-open]
 */
import { DEFAULT_HTTPS_PORT, DEFAULT_PORT } from '../src/net/protocol';
import { startServer, type ServerOptions } from './app';
import { printBanner } from './banner';
import { openBrowser } from './open';

interface Cli extends ServerOptions {
  open: boolean;
}

function usage(): string {
  return `Kart Party server

Usage: node dist-server/server.mjs [options]
  --port N         HTTP port (default env PORT or ${DEFAULT_PORT}; tries the next ports if busy)
  --https          Also serve HTTPS (self-signed cert in ./certs/) and use https join links
  --https-port N   HTTPS port (default ${DEFAULT_HTTPS_PORT})
  --host-ip X      LAN IP to put in join links / QR code (overrides auto-detection)
  --static DIR     Built game directory (default dist)
  --quiet          Less logging
  --no-open        Don't open the game in the browser on start
  -h, --help       Show this help`;
}

function parseArgs(argv: string[]): Cli {
  const o: Cli = { open: true };
  const num = (v: string | undefined, flag: string): number => {
    const n = Number(v);
    if (v === undefined || !Number.isInteger(n) || n < 0 || n > 65535) {
      console.error(`Invalid value for ${flag}: ${v ?? '(missing)'}`);
      process.exit(2);
    }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const eq = raw.indexOf('=');
    const flag = raw.startsWith('--') && eq > 0 ? raw.slice(0, eq) : raw;
    const next = (): string | undefined => (raw.startsWith('--') && eq > 0 ? raw.slice(eq + 1) : argv[++i]);
    switch (flag) {
      case '--port':
      case '-p':
        o.port = num(next(), flag);
        break;
      case '--https':
        o.https = true;
        break;
      case '--https-port':
        o.httpsPort = num(next(), flag);
        break;
      case '--host-ip':
        o.hostIp = next();
        break;
      case '--static':
        o.staticDir = next();
        break;
      case '--quiet':
      case '-q':
        o.quiet = true;
        break;
      case '--no-open':
        o.open = false;
        break;
      case '-h':
      case '--help':
        console.log(usage());
        process.exit(0);
        break;
      default:
        console.warn(`(ignoring unknown option ${raw})`);
    }
  }
  if (process.env.CI) o.open = false;
  return o;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));

  // A party must not end because of one bad packet: log and keep going.
  process.on('uncaughtException', (err) => console.error('[kart-party] uncaught exception (continuing):', err));
  process.on('unhandledRejection', (err) => console.error('[kart-party] unhandled rejection (continuing):', err));

  let server;
  try {
    server = await startServer(cli);
  } catch (err) {
    console.error(`\n  Kart Party could not start: ${err instanceof Error ? err.message : String(err)}\n`);
    console.error('  Is another copy already running? Try:  npm run serve -- --port 4000\n');
    process.exit(1);
  }
  printBanner(server);
  if (cli.open && server.staticOk) openBrowser(`http://localhost:${server.port}/`);

  let stopping = false;
  const stop = (): void => {
    if (stopping) process.exit(0); // second Ctrl+C: force
    stopping = true;
    console.log('\nStopping Kart Party... bye!');
    const force = setTimeout(() => process.exit(0), 2000);
    force.unref();
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

void main();
