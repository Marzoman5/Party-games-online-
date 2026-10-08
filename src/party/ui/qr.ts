/**
 * QR code image, generated in the browser (no server needed, so it works on the static site and
 * offline), with a graceful fallback if generation fails: the URL text stays.
 */
import QRCode from 'qrcode';
import { h } from './dom';

export class QrView {
  readonly root: HTMLDivElement;
  private readonly img: HTMLImageElement;
  private readonly fallback: HTMLDivElement;
  private data = '';

  /**
   * `_apiBase` is unused since QR codes are made in the browser; it stays in the signature because game
   * modules receive it through their context (GameModule ctx.apiBase).
   */
  constructor(
    _apiBase: string,
    cls: string,
    testId?: string,
  ) {
    this.img = h('img', { class: 'kp-qr-img', alt: 'QR code to join', draggable: 'false', 'data-testid': testId });
    this.fallback = h('div', 'kp-qr-fallback');
    this.fallback.innerHTML = '<span class="kp-qr-fallback-icon">📱</span><span>Type the address below<br>on your phone</span>';
    this.root = h('div', `kp-qr ${cls}`, this.img, this.fallback);
    this.img.addEventListener('load', () => this.root.classList.remove('kp-qr-failed'));
    this.img.addEventListener('error', () => {
      if (this.data) this.root.classList.add('kp-qr-failed');
    });
    this.root.classList.add('kp-qr-empty');
  }

  set(data: string): void {
    if (data === this.data) return;
    this.data = data;
    this.root.classList.toggle('kp-qr-empty', !data);
    this.root.classList.remove('kp-qr-failed');
    if (!data) {
      this.img.removeAttribute('src');
      return;
    }
    QRCode.toString(data, { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } })
      .then((svg) => {
        if (this.data === data) this.img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      })
      .catch(() => {
        if (this.data === data) this.root.classList.add('kp-qr-failed');
      });
  }
}

/** Human-friendly join URL: drop the http:// scheme (browsers add it back), keep https://. */
export function displayUrl(url: string): string {
  return url.replace(/^http:\/\//, '');
}

/** The part of the join URL before `?room=` (users type the code separately). */
export function baseJoinUrl(url: string): string {
  return displayUrl(url).replace(/\?room=.*$/, '');
}
