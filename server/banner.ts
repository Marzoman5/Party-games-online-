/** The big friendly startup banner (people read this from across the room). */
import type { RunningServer } from './app';

export function printBanner(s: RunningServer): void {
  const lines: string[] = [];
  const hostUrl = `http://localhost:${s.port}`;
  const phoneUrls = s.lanFound ? s.urls.map((u) => `${u}/play`) : [];
  lines.push('', '  KART PARTY is running!', '');
  lines.push(`  1) Open on the TV/laptop:   ${hostUrl}`);
  if (phoneUrls.length) {
    lines.push(`  2) Phones join:             ${phoneUrls[0]}`);
    for (const u of phoneUrls.slice(1, 4)) lines.push(`                              ${u}`);
    lines.push('     (or just scan the QR code shown on the TV)');
  } else {
    lines.push('  2) Phones join:             (no LAN IP found!)');
  }
  if (s.httpsPort !== null) {
    lines.push('', `  HTTPS is on (port ${s.httpsPort}, self-signed): phones must tap`);
    lines.push('  "Advanced" -> "Proceed" once to accept the certificate.');
  }
  lines.push('');
  const width = Math.max(...lines.map((l) => l.length)) + 2;
  const bar = '='.repeat(width);
  const out = [bar, ...lines, bar];

  if (!s.lanFound) {
    out.push(
      '',
      '  ! Could not find a Wi-Fi/LAN address. Phones need to be on the SAME Wi-Fi as',
      '    this computer. Check that you are connected to Wi-Fi (not only a cable/VPN),',
      '    or pass the address yourself:  npm run serve -- --host-ip 192.168.x.y',
    );
  }
  out.push(
    '',
    "  Phones can't connect? Allow Node.js through the firewall (Windows: \"Allow access\"",
    '  on Private networks; macOS: System Settings > Network > Firewall), make sure',
    '  guest/"client isolation" Wi-Fi is off, and that phones are not on mobile data.',
  );
  if (!s.staticOk) out.push('', '  ! The game is not built yet: run "npm run build" (or "npm start").');
  out.push('', '  Press Ctrl+C to stop.', '');
  console.log(out.join('\n'));
}
