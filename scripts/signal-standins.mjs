// Local stand-ins for the public signalling services, so automated tests never depend on a
// third-party service being up:
//   - a real PeerJS server (the `peer` package, same code as 0.peerjs.com)  ws://127.0.0.1:<port>/peerjs?key=peerjs
//   - a minimal Nostr relay (REQ / EVENT / CLOSE, `kinds` + `#t` filters; checks event ids and
//     Schnorr signatures like real relays do)                                 ws://127.0.0.1:<port+1>[/?delay=ms]
//
//   node scripts/signal-standins.mjs [--port 9000]
//
// GET http://127.0.0.1:<port+1>/stats -> {"events":N,"subs":N} (used by tests to prove which path was used).
import http from 'node:http';
import { createHash } from 'node:crypto';
import { PeerServer } from 'peer';
import { WebSocketServer } from 'ws';
import { schnorr } from '@noble/curves/secp256k1.js';

const args = process.argv.slice(2);
const i = args.indexOf('--port');
const port = Number(i >= 0 ? args[i + 1] : process.env.SIGNAL_PORT ?? 9000);

// ------------------------------------------------------------------ PeerJS
PeerServer({ port, host: '127.0.0.1', path: '/', key: 'peerjs', allow_discovery: false }, () => {
  console.log(`[standins] peerjs  ws://127.0.0.1:${port}/peerjs?key=peerjs`);
});

// ------------------------------------------------------------------ Nostr
const stats = { events: 0, rejected: 0, subs: 0 };
const server = http.createServer((req, res) => {
  if (req.url === '/stats') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(stats));
    return;
  }
  res.statusCode = 200;
  res.end('nostr stand-in');
});
// `?delay=<ms>` on the relay URL holds the connection that long first: lets tests make one service
// come up later than the other on one side, like the real internet does.
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const delay = Math.min(30_000, Number(new URL(req.url ?? '/', 'http://x').searchParams.get('delay')) || 0);
  setTimeout(() => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)), delay);
});
/** ws -> Map<subId, filter> */
const subs = new Map();

function validEvent(ev) {
  try {
    const id = createHash('sha256')
      .update(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]))
      .digest('hex');
    if (id !== ev.id) return false;
    return schnorr.verify(Buffer.from(ev.sig, 'hex'), Buffer.from(ev.id, 'hex'), Buffer.from(ev.pubkey, 'hex'));
  } catch {
    return false;
  }
}

function matches(f, ev) {
  if (Array.isArray(f.kinds) && !f.kinds.includes(ev.kind)) return false;
  for (const [k, vals] of Object.entries(f)) {
    if (!k.startsWith('#') || !Array.isArray(vals)) continue;
    const tag = k.slice(1);
    if (!ev.tags.some((t) => t[0] === tag && vals.includes(t[1]))) return false;
  }
  return true;
}

wss.on('connection', (ws) => {
  subs.set(ws, new Map());
  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!Array.isArray(m)) return;
    if (m[0] === 'REQ') {
      subs.get(ws).set(m[1], m[2] ?? {});
      stats.subs++;
      ws.send(JSON.stringify(['EOSE', m[1]]));
    } else if (m[0] === 'CLOSE') {
      subs.get(ws).delete(m[1]);
    } else if (m[0] === 'EVENT') {
      const ev = m[1];
      if (!ev || !validEvent(ev)) {
        stats.rejected++;
        ws.send(JSON.stringify(['OK', ev?.id ?? '', false, 'invalid: bad id or signature']));
        return;
      }
      stats.events++;
      ws.send(JSON.stringify(['OK', ev.id, true, '']));
      for (const [peer, ps] of subs) {
        for (const [subId, f] of ps) if (matches(f, ev) && peer.readyState === 1) peer.send(JSON.stringify(['EVENT', subId, ev]));
      }
    }
  });
  ws.on('close', () => subs.delete(ws));
});
server.listen(port + 1, '127.0.0.1', () => console.log(`[standins] nostr   ws://127.0.0.1:${port + 1}`));
