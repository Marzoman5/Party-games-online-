/**
 * SHELL — the compact "phone says not private?" walkthrough next to the QR in secure (HTTPS) mode:
 * the exact taps for iPhone (Safari) and Android (Chrome), each with a little phone-screen picture drawn
 * in code (inline SVG). And the one-line notice when the hub runs without HTTPS.
 */
import { h } from '../../../../party/ui/dom';

function miniPhone(title: string, lines: string[], button: string, accent: string): string {
  const txt = lines.map((l, i) => `<text x="60" y="${86 + i * 14}" text-anchor="middle" font-size="10" fill="#c8c8d8" font-family="Arial, sans-serif">${l}</text>`).join('');
  return `<svg viewBox="0 0 120 200" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="4" y="4" width="112" height="192" rx="16" fill="#0d0b18" stroke="#fff" stroke-width="4"/>
    <rect x="12" y="16" width="96" height="168" rx="6" fill="#26233a"/>
    <path d="M60 30 L76 58 L44 58 Z" fill="#ffcc00" stroke="#0d0b18" stroke-width="2"/>
    <text x="60" y="54" text-anchor="middle" font-size="16" font-weight="900" fill="#0d0b18" font-family="Arial, sans-serif">!</text>
    <text x="60" y="72" text-anchor="middle" font-size="10.5" font-weight="700" fill="#fff" font-family="Arial, sans-serif">${title}</text>
    ${txt}
    <rect x="20" y="146" width="80" height="26" rx="13" fill="${accent}" stroke="#fff" stroke-width="2.5"/>
    <text x="60" y="163" text-anchor="middle" font-size="11" font-weight="900" fill="#fff" font-family="Arial, sans-serif">${button}</text>
  </svg>`;
}

/** Certificate walkthrough block (`data-tid="rush-cert-help"`). */
export function certHelp(): HTMLDivElement {
  const ios = h('div', 'rush-cert-col');
  ios.innerHTML = `<div class="rush-cert-pic">${miniPhone('Not Private', ['This Connection Is', 'Not Private'], 'Show Details', '#3d8bff')}</div>
    <div class="rush-cert-steps"><b>🍎 iPhone</b><ol><li>Show Details</li><li>visit this website</li><li>Visit Website</li></ol></div>`;
  const android = h('div', 'rush-cert-col');
  android.innerHTML = `<div class="rush-cert-pic">${miniPhone('Not private', ['Your connection', 'is not private'], 'Advanced', '#3ddc5a')}</div>
    <div class="rush-cert-steps"><b>🤖 Android</b><ol><li>Advanced</li><li>Proceed to … (unsafe)</li></ol></div>`;
  return h(
    'div',
    { class: 'rush-cert', 'data-rtid': 'rush-cert-help' },
    h('div', { class: 'rush-cert-title', text: 'Phone warns “not private”? It’s your own party — tap through:' }),
    h('div', 'rush-cert-cols', ios, android),
  );
}

export function httpsNotice(): HTMLDivElement {
  const n = h('div', { class: 'rush-https', 'data-rtid': 'rush-https-notice' });
  n.innerHTML = 'Motion controls need secure mode — start with <b>Start Party Hub (Tilt Steering)</b>';
  return n;
}
