/**
 * SHELL — DOM overlays on the stage (1920×1080 units via `--su`): UP NEXT card (+ gesture demo +
 * "Hold your phone tight!"), 3-2-1-GO, round results (winner big, points popping, superlatives, sip
 * line), PAUSED, "Oops — skipping that one!", stingers (HEAT 2!, crown check, skipped) and the small
 * corner QR + room code during play.
 */
import { minigameById } from '../../minigames/index';
import { h, setText, toggle } from '../../../../party/ui/dom';
import { QrView } from '../../../../party/ui/qr';
import type { RushShell } from '../loop';
import { demoSvg } from './demo';
import { escapeHtml } from './scoreboard';
import { disc } from './tokens';

// ---------------------------------------------------------------------------------------- UP NEXT

export class UpNextCard {
  readonly root: HTMLDivElement;
  private readonly kicker = h('div', 'rush-up-kicker');
  private readonly name = h('div', 'rush-up-name');
  private readonly instr = h('div', 'rush-up-instr');
  private readonly touch = h('div', 'rush-up-touch');
  private readonly demo = h('div', 'rush-up-demo');
  private readonly heat = h('div', 'rush-up-heat');
  private readonly bar = h('div', 'rush-up-bar-fill');
  private readonly who = h('div', 'rush-up-who');
  private readonly safe = h('div', 'rush-up-safe');
  private key = '';

  constructor() {
    this.safe.innerHTML = '<div class="rush-up-safe-icon">✊📱</div><div class="rush-up-safe-text">Hold your phone tight!</div><div class="rush-up-safe-sub">Small wrist moves are plenty</div>';
    const text = h('div', 'rush-up-text', this.kicker, this.name, this.instr, this.touch);
    const card = h('div', 'rush-up-card', this.demo, text, this.heat, h('div', 'rush-up-bar', this.bar));
    this.root = h('div', { class: 'rush-layer rush-up', 'data-rtid': 'rush-upnext' }, card, this.who, this.safe);
  }

  update(sh: RushShell): void {
    const r = sh.round;
    if (!r) return;
    const m = r.def.meta;
    const present = sh.presentHumans().filter((e) => e.st === 'play');
    const key = `${r.rid}|${sh.version}`;
    if (key !== this.key) {
      this.key = key;
      this.root.style.setProperty('--accent', m.color);
      setText(this.kicker, `UP NEXT · ROUND ${r.n}`);
      this.name.innerHTML = `<span class="rush-up-icon">${m.icon}</span> ${escapeHtml(m.name)}`;
      setText(this.instr, m.instr);
      this.touch.innerHTML = `👆 No motion? <b>${escapeHtml(m.touch)}</b>`;
      if (this.demo.dataset.demo !== `${m.demo}|${m.color}`) {
        this.demo.dataset.demo = `${m.demo}|${m.color}`;
        this.demo.innerHTML = demoSvg(m.demo, m.color);
      }
      setText(this.heat, sh.heatUp ? `🔥 HEAT ${r.heat}!` : r.heat > 1 ? `🔥 Heat ${r.heat}` : '');
      toggle(this.heat, 'rush-hide', r.heat <= 1);
      toggle(this.heat, 'rush-up-heat-new', sh.heatUp);
      const bots = present.length <= 1 ? Math.max(0, 3 - present.length) : 0;
      this.who.replaceChildren(
        ...present.slice(0, 16).map((e) => {
          const it = h('div', 'rush-up-who-item', disc(e, 56), h('span', { text: e.name }));
          it.style.color = e.color;
          return it;
        }),
        ...(bots ? [h('div', 'rush-up-who-item rush-dim', h('span', { text: `+ ${bots} 🤖 bots` }))] : []),
      );
    }
    toggle(this.safe, 'rush-on', sh.safeNow);
    const len = sh.introLen();
    this.bar.style.transform = `scaleX(${Math.min(1, sh.phaseT / Math.max(0.1, len))})`;
  }
}

// ---------------------------------------------------------------------------------------- 3-2-1

export class Countdown {
  readonly root: HTMLDivElement;
  private readonly num = h('div', 'rush-cd-num');
  private readonly title = h('div', 'rush-cd-title');
  private shown = '';

  constructor() {
    this.root = h('div', { class: 'rush-layer rush-cd', 'data-rtid': 'rush-countdown' }, this.title, this.num);
  }

  update(sh: RushShell): void {
    const r = sh.round;
    const go = sh.phase === 'play';
    const txt = go ? 'GO!' : String(Math.max(1, sh.cd));
    if (r) this.title.innerHTML = `${r.def.meta.icon} ${escapeHtml(r.def.meta.instr)}`;
    toggle(this.title, 'rush-hide', go);
    if (txt !== this.shown) {
      this.shown = txt;
      this.num.textContent = txt;
      toggle(this.num, 'rush-cd-go', go);
      this.num.classList.remove('rush-pop');
      void this.num.offsetWidth;
      this.num.classList.add('rush-pop');
    }
  }
}

// ---------------------------------------------------------------------------------------- results

export class ResultsCard {
  readonly root: HTMLDivElement;
  private readonly kicker = h('div', 'rush-res-kicker');
  private readonly head = h('div', 'rush-res-head');
  private readonly rows = h('div', 'rush-res-rows');
  private readonly sups = h('div', 'rush-res-sups');
  private readonly sip = h('div', 'rush-res-sip');
  private key = '';

  constructor() {
    const card = h('div', 'rush-res-card', this.kicker, this.head, this.rows, this.sups, this.sip);
    this.root = h('div', { class: 'rush-layer rush-res', 'data-rtid': 'rush-results' }, card);
  }

  update(sh: RushShell): void {
    const c = sh.lastResults;
    if (!c) return;
    const key = `${c.rid}`;
    if (key === this.key) return;
    this.key = key;
    this.root.style.setProperty('--accent', c.color);
    setText(this.kicker, `ROUND ${c.round} · ${c.icon} ${c.name}`);
    const win = c.rows.filter((r) => r.place === 1);
    const top = win[0];
    this.head.replaceChildren(
      h('div', 'rush-res-winners', ...win.slice(0, 4).map((w) => disc(w, win.length > 1 ? 120 : 160))),
      (() => {
        const t = h('div', { class: 'rush-res-headline', text: c.headline });
        if (top) t.style.color = win.length === 1 ? top.color : '#ffd23a';
        return t;
      })(),
    );
    const two = c.rows.length > 8;
    toggle(this.rows, 'rush-two', two);
    toggle(this.rows, 'rush-many', c.rows.length > 5);
    this.rows.replaceChildren(
      ...c.rows.map((r, i) => {
        const medal = r.place === 1 ? '🥇' : r.place === 2 ? '🥈' : r.place === 3 ? '🥉' : `${r.place}`;
        const plus = h('div', { class: 'rush-res-plus', text: `+${r.pts}` });
        plus.style.animationDelay = `${0.5 + (c.rows.length - 1 - i) * 0.12}s`;
        const name = h('div', { class: 'rush-res-name', text: r.name });
        name.style.color = r.color;
        const row = h(
          'div',
          'rush-res-row',
          h('div', { class: 'rush-res-place', text: medal }),
          disc(r, 54),
          name,
          h('div', { class: 'rush-res-stat', text: r.stat }),
          plus,
        );
        row.style.animationDelay = `${0.15 + i * 0.06}s`;
        if (r.bot) row.classList.add('rush-res-bot');
        return row;
      }),
    );
    this.sups.replaceChildren(
      ...c.sups.map((s) => {
        const r = c.rows.find((x) => x.id === s.id);
        if (!r) return h('div');
        const name = h('b', { text: r.name });
        name.style.color = r.color;
        return h('div', 'rush-res-sup', disc(r, 56), h('div', 'rush-res-sup-text', name, h('span', { text: ` — ${s.text}` })));
      }),
    );
    setText(this.sip, c.sip);
    toggle(this.sip, 'rush-hide', !c.sip);
  }
}

// ---------------------------------------------------------------------------------------- small ones

export class PausedOverlay {
  readonly root = h('div', { class: 'rush-layer rush-paused', 'data-rtid': 'rush-paused' });
  constructor() {
    this.root.innerHTML = '<div class="rush-paused-big">PAUSED</div><div class="rush-paused-sub">press <kbd>Space</kbd> or <kbd>P</kbd> to continue</div><div class="rush-paused-hint">Esc = menu</div>';
  }
}

export class OopsOverlay {
  readonly root: HTMLDivElement;
  private readonly sub = h('div', 'rush-oops-sub');
  constructor() {
    this.root = h('div', { class: 'rush-layer rush-oops', 'data-rtid': 'rush-oops' }, h('div', { class: 'rush-oops-face', text: '🙈' }), h('div', { class: 'rush-oops-big', text: 'Oops — skipping that one!' }), this.sub);
  }
  update(sh: RushShell): void {
    setText(this.sub, sh.oopsMsg ? `${sh.oopsMsg} tripped over its own feet. No points, on we go!` : 'On we go!');
  }
}

export class StingerView {
  readonly root: HTMLDivElement;
  private readonly text = h('div', 'rush-sting-text');
  private readonly sub = h('div', 'rush-sting-sub');
  private at = 0;
  constructor() {
    this.root = h('div', 'rush-layer rush-sting', h('div', 'rush-sting-box', this.text, this.sub));
  }
  update(sh: RushShell): boolean {
    const s = sh.stinger;
    const on = !!s && Date.now() - s.at < s.ms;
    if (s && s.at !== this.at) {
      this.at = s.at;
      setText(this.text, s.text);
      setText(this.sub, s.sub);
      this.root.style.setProperty('--accent', s.color);
      this.root.dataset.kind = s.kind;
      const box = this.root.firstElementChild as HTMLElement;
      box.classList.remove('rush-sting-in');
      void box.offsetWidth;
      box.classList.add('rush-sting-in');
    }
    return on;
  }
}

/** Small QR + room code in the HUD corner during count / play. */
export class CornerQr {
  readonly root: HTMLDivElement;
  private readonly qr: QrView;
  private readonly code = h('div', 'rush-corner-code');
  constructor(apiBase: string) {
    this.qr = new QrView(apiBase, 'rush-corner-qr');
    this.root = h('div', 'rush-layer rush-corner', h('div', 'rush-corner-txt', h('div', { class: 'rush-corner-join', text: 'JOIN' }), this.code), this.qr.root);
  }
  update(room: string, url: string): void {
    setText(this.code, room);
    this.qr.set(url);
  }
}

export function gameName(id: string | null): string {
  const d = id ? minigameById(id) : null;
  return d ? d.meta.name : '';
}
