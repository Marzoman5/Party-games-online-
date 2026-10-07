/**
 * SHELL — the host Esc menu (mouse-clickable DOM): auto-advance on/off + delay, enabled minigames, max
 * heat, volume, sip mode, reset scores (confirm), remove a player (confirm), Back to hub, Resume.
 * Opening it pauses the loop; closing it resumes (unless the host had paused before).
 */
import { MINIGAMES } from '../../minigames/index';
import { h, setText, toggle } from '../../../../party/ui/dom';
import type { RushShell } from '../loop';
import { AUTO_SEC_CHOICES } from '../settings';
import { disc } from './tokens';

export interface MenuActions {
  close(): void;
  backToHub(): void;
  removePlayer(id: string): void;
}

export class RushMenu {
  readonly root: HTMLDivElement;
  private readonly autoBtn: HTMLButtonElement;
  private readonly autoSel: HTMLSelectElement;
  private readonly heatBtns: HTMLButtonElement[] = [];
  private readonly vol: HTMLInputElement;
  private readonly volVal = h('span', 'rush-m-val');
  private readonly sipBtn: HTMLButtonElement;
  private readonly games = new Map<string, HTMLInputElement>();
  private readonly resetBtn: HTMLButtonElement;
  private readonly resetConfirm: HTMLDivElement;
  private readonly players = h('div', 'rush-m-players');
  private confirmRemove = '';
  private key = '';

  constructor(
    private readonly sh: RushShell,
    private readonly act: MenuActions,
  ) {
    const btn = (label: string, cls: string, fn: () => void, tid?: string): HTMLButtonElement => {
      const b = h('button', { class: `rush-m-btn ${cls}`, type: 'button', 'data-rtid': tid });
      b.innerHTML = label;
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        fn();
        this.refresh(true);
      });
      return b;
    };

    this.autoBtn = btn('', 'rush-m-toggle', () => sh.setSetting('auto', !sh.settings.auto), 'rush-menu-auto');
    this.autoSel = h('select', { class: 'rush-m-select', 'aria-label': 'Auto-advance delay' });
    for (const s of AUTO_SEC_CHOICES) this.autoSel.appendChild(h('option', { value: String(s), text: `${s} s` }));
    this.autoSel.addEventListener('change', () => {
      sh.setSetting('autoSec', Number(this.autoSel.value));
      this.refresh(true);
    });
    const heatRow = h('div', 'rush-m-seg');
    for (const n of [1, 2, 3] as const) {
      const b = btn(`${'🔥'.repeat(n)}`, 'rush-m-segbtn', () => sh.setSetting('maxHeat', n));
      this.heatBtns.push(b);
      heatRow.appendChild(b);
    }
    this.vol = h('input', { type: 'range', min: '0', max: '100', step: '5', class: 'rush-m-range', 'aria-label': 'Volume' });
    this.vol.addEventListener('input', () => {
      sh.setSetting('volume', Number(this.vol.value) / 100);
      setText(this.volVal, `${this.vol.value}%`);
    });
    this.sipBtn = btn('', 'rush-m-toggle', () => sh.setSetting('sip', !sh.settings.sip), 'rush-menu-sip');

    const gameGrid = h('div', 'rush-m-games');
    for (const m of MINIGAMES) {
      const cb = h('input', { type: 'checkbox' });
      cb.addEventListener('change', () => {
        if (!sh.toggleGame(m.meta.id, cb.checked)) cb.checked = true;
        this.refresh(true);
      });
      this.games.set(m.meta.id, cb);
      const lab = h('label', 'rush-m-game', cb, h('span', { class: 'rush-m-game-icon', text: m.meta.icon }), h('span', { text: m.meta.name }));
      lab.addEventListener('click', (ev) => ev.stopPropagation());
      gameGrid.appendChild(lab);
    }

    this.resetConfirm = h(
      'div',
      'rush-m-confirm',
      h('span', { text: 'Really reset ALL scores?' }),
      btn('Yes, reset', 'rush-m-danger', () => {
        sh.resetScores();
        toggle(this.resetConfirm, 'rush-on', false);
      }),
      btn('Cancel', '', () => toggle(this.resetConfirm, 'rush-on', false)),
    );
    this.resetBtn = btn('🧹 Reset scores', '', () => toggle(this.resetConfirm, 'rush-on', true), 'rush-menu-reset');

    const row = (label: string, ...ctl: (Node | string)[]): HTMLDivElement => h('div', 'rush-m-row', h('div', { class: 'rush-m-label', text: label }), h('div', 'rush-m-ctl', ...ctl));

    const settings = h(
      'div',
      'rush-m-col',
      h('div', { class: 'rush-m-h', text: 'Settings' }),
      row('Auto-advance', this.autoBtn, this.autoSel),
      row('Max heat', heatRow),
      row('Volume', this.vol, this.volVal),
      row('Sip mode', this.sipBtn),
      h('div', { class: 'rush-m-h2', text: 'Minigames' }),
      gameGrid,
      h('div', 'rush-m-row', this.resetBtn, this.resetConfirm),
    );
    const people = h('div', 'rush-m-col rush-m-col-people', h('div', { class: 'rush-m-h', text: 'Players' }), this.players);
    const foot = h(
      'div',
      'rush-m-foot',
      btn('▶ Resume <kbd>Esc</kbd>', 'rush-m-primary', () => act.close(), 'rush-menu-resume'),
      btn('🏠 Back to hub', '', () => act.backToHub(), 'rush-menu-hub'),
    );
    const panel = h('div', 'rush-m-panel', h('div', { class: 'rush-m-title', text: '⚡ Party Rush — Menu' }), h('div', 'rush-m-cols', settings, people), foot);
    panel.addEventListener('click', (ev) => ev.stopPropagation());
    panel.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    this.root = h('div', { class: 'rush-layer rush-menu', 'data-rtid': 'rush-menu' }, panel);
    this.root.addEventListener('click', (ev) => {
      ev.stopPropagation();
      act.close();
    });
  }

  refresh(force = false): void {
    const sh = this.sh;
    const s = sh.settings;
    const key = `${sh.version}|${JSON.stringify(s)}|${this.confirmRemove}`;
    if (!force && key === this.key) return;
    this.key = key;
    this.autoBtn.innerHTML = s.auto ? 'ON' : 'OFF';
    toggle(this.autoBtn, 'rush-m-on', s.auto);
    this.autoSel.value = String(AUTO_SEC_CHOICES.includes(s.autoSec as never) ? s.autoSec : 10);
    if (!AUTO_SEC_CHOICES.includes(s.autoSec as never)) {
      const o = h('option', { value: String(s.autoSec), text: `${s.autoSec} s` });
      this.autoSel.appendChild(o);
      this.autoSel.value = String(s.autoSec);
    }
    this.autoSel.disabled = !s.auto;
    this.heatBtns.forEach((b, i) => toggle(b, 'rush-m-on', s.maxHeat === i + 1));
    if (document.activeElement !== this.vol) this.vol.value = String(Math.round(s.volume * 100));
    setText(this.volVal, `${Math.round(s.volume * 100)}%`);
    this.sipBtn.innerHTML = s.sip ? 'ON 🍹' : 'OFF';
    toggle(this.sipBtn, 'rush-m-on', s.sip);
    for (const [id, cb] of this.games) cb.checked = s.enabled.includes(id);

    const list = [...sh.entries.values()].filter((e) => !e.removedAt && !e.hidden).sort((a, b) => a.slot - b.slot);
    this.players.replaceChildren(
      ...(list.length
        ? list.map((e) => {
            const name = h('span', { class: 'rush-m-pname', text: e.name });
            name.style.color = e.color;
            const st = h('span', { class: 'rush-m-pst', text: !e.connected ? 'offline' : e.st === 'new' ? 'not joined' : e.st === 'away' ? 'away' : e.st === 'next' ? 'next round' : `${e.pts} pts` });
            const confirming = this.confirmRemove === e.id;
            const b = h('button', { class: `rush-m-btn rush-m-small ${confirming ? 'rush-m-danger' : ''}`, type: 'button', text: confirming ? 'Sure? Remove' : 'Remove' });
            b.addEventListener('click', (ev) => {
              ev.stopPropagation();
              if (this.confirmRemove === e.id) {
                this.confirmRemove = '';
                this.act.removePlayer(e.id);
              } else this.confirmRemove = e.id;
              this.refresh(true);
            });
            return h('div', 'rush-m-player', disc(e, 44), name, st, b);
          })
        : [h('div', { class: 'rush-dim', text: 'Nobody here yet — scan the QR code!' })]),
    );
  }

  opened(): void {
    this.confirmRemove = '';
    toggle(this.resetConfirm, 'rush-on', false);
    this.refresh(true);
  }
}
