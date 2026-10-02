/**
 * LAN IP detection: which address should phones use to reach this machine?
 *
 * We list IPv4, non-internal interfaces, drop virtual adapters (docker, VMs,
 * VPN tunnels...) and link-local 169.254.x, then rank private ranges first:
 * 192.168.x > 10.x > 172.16-31.x > anything else. Wi-Fi/ethernet-looking
 * names win ties.
 */
import os from 'node:os';

const VIRTUAL_IF =
  /docker|veth|^br-|bridge|virbr|vbox|virtualbox|vmnet|vmware|utun|^tun|^tap|tailscale|zerotier|^zt|wireguard|^wg|hyper-v|vethernet|wsl|^lo|loopback|awdl|llw|anpi|ham|npcap/i;
const PHYSICAL_IF = /^(en|eth|wlan|wl|wi-?fi|wireless|ethernet)/i;

export interface LanAddress {
  ip: string;
  iface: string;
}

function rangeScore(ip: string): number {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return 2;
  return 3;
}

export function isIPv4(s: string): boolean {
  const parts = s.split('.');
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** All usable LAN IPv4 addresses, best first. */
export function detectLanAddresses(): LanAddress[] {
  const out: (LanAddress & { score: number })[] = [];
  let ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {};
  try {
    ifaces = os.networkInterfaces();
  } catch {
    return [];
  }
  for (const [name, list] of Object.entries(ifaces)) {
    if (!list || VIRTUAL_IF.test(name)) continue;
    for (const a of list) {
      // Node 18.0-18.3 reported family as a number (4/6).
      const fam = a.family as string | number;
      if (fam !== 'IPv4' && fam !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.') || a.address.startsWith('127.')) continue;
      out.push({
        ip: a.address,
        iface: name,
        score: rangeScore(a.address) * 2 + (PHYSICAL_IF.test(name) ? 0 : 1),
      });
    }
  }
  out.sort((a, b) => a.score - b.score);
  const seen = new Set<string>();
  return out.filter((a) => (seen.has(a.ip) ? false : (seen.add(a.ip), true))).map(({ ip, iface }) => ({ ip, iface }));
}

/** LAN IPs to advertise: the --host-ip override (if any) first, then detected ones. */
export function lanIPs(override?: string): string[] {
  const detected = detectLanAddresses().map((a) => a.ip);
  if (override) return [override, ...detected.filter((ip) => ip !== override)];
  return detected;
}
