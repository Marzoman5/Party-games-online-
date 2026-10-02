/**
 * TITLE — "KART PARTY" logo over the live demo race, a BIG QR code, the room code, the
 * join URL fallback, and "Press ENTER for keyboard solo".
 */
import type { PartySession } from '../PartySession';
import type { ScreenView, UiContext } from './HostUI';
import { h, setText, toggle } from './dom';
import { QrView, baseJoinUrl } from './qr';

export function logoMarkup(): string {
  return `<div class="kp-logo" aria-label="Kart Party">
    <span class="kp-logo-kart">KART</span><span class="kp-logo-party">PARTY</span>
    <span class="kp-logo-flag" aria-hidden="true"></span>
  </div>`;
}

export class TitleScreen implements ScreenView {
  readonly root: HTMLDivElement;
  private readonly qr: QrView;
  private readonly code: HTMLDivElement;
  private readonly url: HTMLSpanElement;
  private readonly urlCode: HTMLSpanElement;
  private readonly status: HTMLDivElement;
  private readonly card: HTMLDivElement;

  constructor(private readonly ctx: UiContext) {
    this.qr = new QrView(ctx.apiBase, 'kp-qr-big');
    this.qr.root.querySelector('img')!.dataset.tid = 'qr';
    this.code = h('div', { class: 'kp-code', 'data-tid': 'room-code' });
    this.url = h('span', { class: 'kp-url', 'data-tid': 'join-url' });
    this.urlCode = h('b', 'kp-url-code');
    this.status = h('div', 'kp-title-status');

    const left = h('div', 'kp-title-left');
    left.innerHTML = logoMarkup();
    left.append(
      h('div', 'kp-tagline', 'Grab your phone — it’s your controller!'),
      h(
        'ol',
        'kp-steps',
        h('li', {}, h('span', 'kp-step-n', '1'), h('span', {}, 'Scan the QR code with your phone camera')),
        h(
          'li',
          {},
          h('span', 'kp-step-n', '2'),
          h('span', {}, 'or open ', this.url, ' and enter code ', this.urlCode),
        ),
        h('li', {}, h('span', 'kp-step-n kp-wifi', '📶'), h('span', {}, 'Same Wi-Fi as this screen')),
      ),
      this.status,
    );

    this.card = h(
      'div',
      'kp-qr-card',
      h('div', 'kp-qr-card-kicker', 'SCAN TO JOIN'),
      this.qr.root,
      h('div', 'kp-code-label', 'ROOM CODE'),
      this.code,
    );

    const solo = h('button', { class: 'kp-solo', type: 'button' });
    solo.innerHTML = 'Press <kbd>ENTER</kbd> for keyboard solo';
    solo.addEventListener('click', (e) => {
      e.stopPropagation();
      ctx.session.hostOpenSolo();
    });

    this.root = h(
      'div',
      { class: 'kp-title', 'data-tid': 'screen-title' },
      h('div', 'kp-scrim kp-scrim-title'),
      h('div', 'kp-title-grid', left, h('div', 'kp-title-right', this.card)),
      solo,
    );
  }

  update(s: PartySession): void {
    this.qr.set(s.joinUrl);
    setText(this.code, s.room || '····');
    setText(this.url, s.joinUrl ? baseJoinUrl(s.joinUrl) : '…');
    this.url.dataset.url = s.joinUrl;
    setText(this.urlCode, s.room || '····');

    let msg = '';
    let bad = false;
    if (!s.hostedOnce) {
      if (s.netStatus === 'down') {
        bad = true;
        msg =
          'Can’t reach the game server. Start it with “npm start” on this computer, then open the address it prints.';
      } else msg = 'Connecting to the game server…';
    } else if (/\/\/(localhost|127\.|\[::1\])/.test(s.joinUrl)) {
      bad = true;
      msg = 'No Wi-Fi address found — phones can’t reach “localhost”. Connect this computer to Wi-Fi and reload.';
    } else if (s.https) {
      msg = 'Secure mode: phones will show a certificate warning once — tap “Advanced → Proceed”.';
    }
    setText(this.status, msg);
    toggle(this.status, 'kp-on', !!msg);
    toggle(this.status, 'kp-bad', bad);
    toggle(this.card, 'kp-offline', !s.hostedOnce);
  }
}
