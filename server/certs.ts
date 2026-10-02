/**
 * Self-signed certificate for --https mode (phones need a secure context for
 * tilt steering / some vibration APIs). Generated once with `selfsigned`,
 * cached in ./certs/ and regenerated when the set of LAN IPs changes (the cert
 * carries every LAN IP + localhost as subjectAltName) or it is about to expire.
 */
import fs from 'node:fs';
import path from 'node:path';
import selfsigned from 'selfsigned';
import { isIPv4 } from './lan';

export interface CertPair {
  key: string;
  cert: string;
  /** True if a new certificate was generated this run (vs loaded from cache). */
  fresh: boolean;
}

interface CertMeta {
  names: string[];
  expires: number;
}

const DAYS = 825;

export function loadOrCreateCert(dir: string, ips: string[]): CertPair {
  const names = Array.from(new Set(['localhost', '127.0.0.1', ...ips])).sort();
  const keyFile = path.join(dir, 'kart-party.key');
  const certFile = path.join(dir, 'kart-party.crt');
  const metaFile = path.join(dir, 'kart-party.json');
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as CertMeta;
    const sameNames = Array.isArray(meta.names) && meta.names.join(',') === names.join(',');
    const notExpiring = typeof meta.expires === 'number' && meta.expires - Date.now() > 7 * 86400_000;
    if (sameNames && notExpiring) {
      return { key: fs.readFileSync(keyFile, 'utf8'), cert: fs.readFileSync(certFile, 'utf8'), fresh: false };
    }
  } catch {
    // no cache (or corrupt) -> generate below
  }

  const altNames = names.map((n) => (isIPv4(n) ? { type: 7, ip: n } : { type: 2, value: n }));
  const pems = selfsigned.generate([{ name: 'commonName', value: 'Party Hub (local)' }], {
    days: DAYS,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(keyFile, pems.private, { mode: 0o600 });
    fs.writeFileSync(certFile, pems.cert);
    const meta: CertMeta = { names, expires: Date.now() + DAYS * 86400_000 };
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  } catch {
    // Read-only dir? Fine - we just regenerate next time.
  }
  return { key: pems.private, cert: pems.cert, fresh: true };
}
