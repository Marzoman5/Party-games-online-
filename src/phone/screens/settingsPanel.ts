/** ⚙️ Settings sheet (per-phone, persisted). */
import { settings, setSetting, onSettings, type PhoneSettings } from '../settings';
import { tilt, tiltSupported } from '../tilt';
import { button, h, setText, show, toast, toggleClass } from '../ui';
import { haptic } from '../haptics';
import { requestFullscreen, isFullscreen, fullscreenSupported } from '../system';

type BoolKey = { [K in keyof PhoneSettings]: PhoneSettings[K] extends boolean ? K : never }[keyof PhoneSettings];

function toggleRow(label: string, sub: string, key: BoolKey, testid: string, onTap?: () => void): HTMLElement {
  const sw = h('button', { class: 'tgl', testid, type: 'button', role: 'switch' }, h('i'));
  sw.addEventListener('click', () => {
    haptic('tick');
    if (onTap) onTap();
    else setSetting(key, !settings[key]);
  });
  const row = h('div', { class: 'set-row', 'data-key': key }, h('div', { class: 'set-text' }, h('b', { text: label }), h('small', { text: sub })), sw);
  return row;
}

function rangeRow(label: string, key: 'touchSensitivity' | 'tiltSensitivity', testid: string): HTMLElement {
  const input = h('input', { type: 'range', min: '0.5', max: '2', step: '0.1', testid, class: 'range', 'aria-label': label });
  const val = h('span', { class: 'range-val' });
  input.addEventListener('input', () => setSetting(key, Number(input.value)));
  const row = h('div', { class: 'set-row range-row', 'data-key': key }, h('div', { class: 'set-text' }, h('b', { text: label }), val), input);
  (row as HTMLElement & { sync?: () => void }).sync = () => {
    if (document.activeElement !== input) input.value = String(settings[key]);
    setText(val, `${settings[key].toFixed(1)}×`);
  };
  return row;
}

export class SettingsPanel {
  readonly el: HTMLElement;
  private rows: HTMLElement[] = [];
  private tiltExtra: HTMLElement;
  private tiltStatus: HTMLElement;
  private fsBtn: HTMLButtonElement;

  constructor() {
    const vibOk = typeof (navigator as Navigator & { vibrate?: unknown }).vibrate === 'function';
    const auto = toggleRow('Auto-accelerate', 'Kart drives itself forward — BRAKE to slow down', 'autoAccelerate', 'set-auto');
    const vib = toggleRow('Vibration', vibOk ? 'Buzz on hits, boosts and laps' : 'Not supported on this phone', 'vibration', 'set-vibration');
    const lefty = toggleRow('Left-handed layout', 'Buttons on the left, steering on the right', 'leftHanded', 'set-lefthanded');
    const touchSens = rangeRow('Touch steering sensitivity', 'touchSensitivity', 'set-touch-sens');

    let tiltBlock: HTMLElement;
    this.tiltStatus = h('small', { class: 'tilt-status', testid: 'tilt-status' });
    if (tiltSupported()) {
      const tiltRow = toggleRow('Tilt steering', 'Steer by tilting the phone like a wheel', 'tilt', 'set-tilt', () => void this.toggleTilt());
      const tiltSens = rangeRow('Tilt sensitivity', 'tiltSensitivity', 'set-tilt-sens');
      const cal = button('🎯 Calibrate (hold level, tap)', 'btn-calibrate', () => {
        tilt.calibrate();
        toast(tilt.hasData ? 'Tilt centred!' : 'No tilt data yet — move the phone a little');
      }, 'btn btn-alt btn-small');
      this.tiltExtra = h('div', { class: 'tilt-extra' }, tiltSens, h('div', { class: 'set-row' }, cal, this.tiltStatus));
      this.rows.push(tiltRow, tiltSens);
      tiltBlock = h('div', null, tiltRow, this.tiltExtra);
    } else {
      this.tiltExtra = h('div');
      tiltBlock = h(
        'div',
        { class: 'set-row note', testid: 'tilt-unavailable' },
        h(
          'div',
          { class: 'set-text' },
          h('b', { text: 'Tilt steering' }),
          h('small', {
            text: window.isSecureContext
              ? 'This browser has no motion sensor support.'
              : 'Needs the secure https:// link (start the game with npm run start:https). Touch steering works great too!',
          }),
        ),
      );
    }
    this.fsBtn = button('⛶ Full screen', 'btn-fullscreen', () => requestFullscreen(true), 'btn btn-alt btn-small');
    show(this.fsBtn, fullscreenSupported());

    this.rows.push(auto, vib, lefty, touchSens);
    const close = button('Done ✓', 'btn-settings-close', () => this.close(), 'btn btn-start');
    const sheet = h(
      'div',
      { class: 'sheet scrollable' },
      h('div', { class: 'sheet-head' }, h('b', { text: '⚙️ Controller settings' })),
      auto,
      touchSens,
      tiltBlock,
      vib,
      lefty,
      h('div', { class: 'sheet-foot' }, this.fsBtn, close),
    );
    this.el = h('div', { class: 'modal', testid: 'settings-panel' }, sheet);
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    show(this.el, false);
    onSettings(() => this.sync());
    this.sync();
  }

  private async toggleTilt(): Promise<void> {
    if (settings.tilt) {
      tilt.disable();
      setSetting('tilt', false);
      return;
    }
    const ok = await tilt.enable();
    if (!ok) {
      toast('Motion access was denied — touch steering it is!');
      setSetting('tilt', false);
      return;
    }
    setSetting('tilt', true);
    // Auto-centre on the way the phone is held right now.
    setTimeout(() => {
      if (tilt.hasData) tilt.calibrate();
      this.sync();
    }, 400);
  }

  open(): void {
    this.sync();
    show(this.el, true);
    this.el.classList.add('on');
  }

  close(): void {
    show(this.el, false);
    this.el.classList.remove('on');
  }

  get isOpen(): boolean {
    return this.el.style.display !== 'none';
  }

  sync(): void {
    this.el.querySelectorAll<HTMLElement>('.set-row[data-key]').forEach((row) => {
      const key = row.getAttribute('data-key') as keyof PhoneSettings;
      const sw = row.querySelector('.tgl');
      if (sw) {
        const on = Boolean(settings[key]);
        toggleClass(sw, 'on', on);
        sw.setAttribute('aria-checked', String(on));
      }
      (row as HTMLElement & { sync?: () => void }).sync?.();
    });
    show(this.tiltExtra, settings.tilt);
    setText(
      this.tiltStatus,
      !settings.tilt ? '' : tilt.hasData ? `angle ${(tilt.raw - tilt.offset).toFixed(0)}°` : 'waiting for sensor…',
    );
    show(this.fsBtn, fullscreenSupported() && !isFullscreen());
  }
}
