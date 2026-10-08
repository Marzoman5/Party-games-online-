/**
 * SHELL — the intermission scoreboard (DOM, laid out in 1920×1080 stage units via `--su`): animated
 * standings (all-time + last-5 streak; rows glide to their new place with a CSS transform transition),
 * big QR + room code + join URL, HTTPS notice / certificate walkthrough, who just joined / who should tap
 * their phone / who is away, round + heat, the teased next game, the auto-advance ring and the key legend.
 * With nobody present it idles with a huge "Scan to join!" QR.
 */
import { minigameById } from '../../minigames/index';
import { LOOP } from '../../tuning';
import { h, setText, toggle } from '../../../../party/ui/dom';
import { QrView, baseJoinUrl } from '../../../../party/ui/qr';
import type { RushShell } from '../loop';
import type { Entry } from '../state';
import { certHelp, httpsNotice } from './cert';
import { disc } from './tokens';

export interface ScoreboardEnv {
  room: string;
  joinUrl: string;
  https: boolean;
}

interface RowEl {
  el: HTMLDivElement;
  rank: HTMLDivElement;
  name: HTMLDivElement;
  disc: HTMLDivElement;
  streak: HTMLDivElement;
  pts: HTMLDivElement;
  plus: HTMLDivElement;
  tag: HTMLDivElement;
  key: string;
  gone: number;
}

export class Scoreboard {
  readonly root: HTMLDivElement;
  private readonly title = h('div', 'rush-sb-title');
  private readonly roundChip = h('div', 'rush-chip');
  private readonly heatChip = h('div', 'rush-chip rush-chip-heat');
  private readonly board = h('div', 'rush-sb-board');
  private readonly emptyHint = h('div', 'rush-sb-empty-hint');
  private readonly side = h('div', 'rush-sb-side');
  private readonly qr: QrView;
  private readonly scanLine = h('div', 'rush-sb-scan');
  private readonly code = h('div', { class: 'rush-sb-code', 'data-rtid': 'rush-room-code' });
  private readonly url = h('div', 'rush-sb-url');
  private readonly https = httpsNotice();
  private readonly cert = certHelp();
  private readonly news = h('div', 'rush-sb-news');
  private readonly nextBox = h('div', 'rush-sb-next');
  private readonly nextLabel = h('div', 'rush-sb-next-label');
  private readonly ring = h('div', 'rush-ring');
  private readonly ringNum = h('div', 'rush-ring-num');
  private readonly ringArc: SVGCircleElement;
  private readonly legend = h('div', 'rush-sb-legend');
  private readonly rows = new Map<string, RowEl>();
  private key = '';

  constructor(apiBase: string, onMenu: () => void) {
    this.qr = new QrView(apiBase, 'rush-sb-qr');
    this.qr.root.setAttribute('data-rtid', 'rush-qr');
    this.title.innerHTML = '<span class="rush-logo-bolt">⚡</span> PARTY RUSH';
    const head = h('div', 'rush-sb-head', this.title, this.roundChip, this.heatChip);
    this.side.append(this.scanLine, this.qr.root, this.code, this.url, this.https, this.cert);
    this.ring.innerHTML = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" class="rush-ring-bg"/><circle cx="50" cy="50" r="44" class="rush-ring-fg" pathLength="100"/></svg>';
    this.ringArc = this.ring.querySelector('.rush-ring-fg') as SVGCircleElement;
    this.ring.appendChild(this.ringNum);
    this.nextBox.append(this.ring, this.nextLabel);
    const menuBtn = h('button', { class: 'rush-menu-btn', type: 'button', text: '⚙ Menu' });
    menuBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      onMenu();
    });
    this.legend.innerHTML =
      '<span><kbd>Space</kbd> next</span><span><kbd>P</kbd> pause</span><span><kbd>S</kbd> skip</span><span><kbd>R</kbd> replay</span><span><kbd>Esc</kbd> menu</span>';
    this.legend.prepend(menuBtn);
    this.board.appendChild(this.emptyHint);
    this.root = h('div', { class: 'rush-layer rush-sb', 'data-rtid': 'rush-scoreboard' }, head, this.board, this.side, this.news, this.nextBox, this.legend);
  }

  /** Rebuild when the shell state changed (version) or the session env changed. */
  update(sh: RushShell, env: ScoreboardEnv): void {
    const present = sh.presentHumans();
    const board = sh.board();
    const empty = present.length === 0;
    const k = `${sh.version}|${env.room}|${env.joinUrl}|${env.https}`;
    if (k === this.key) return;
    this.key = k;
    toggle(this.root, 'rush-sb-empty', empty);
    toggle(this.root, 'rush-sb-noboard', board.length === 0);
    setText(this.roundChip, `Round ${sh.roundsPlayed + 1}`);
    setText(this.heatChip, `🔥 Heat ${sh.heat}`);
    toggle(this.heatChip, 'rush-hide', sh.heat <= 1);
    this.qr.set(env.joinUrl);
    setText(this.scanLine, empty ? 'Scan to join! 📱' : 'Join any time!');
    setText(this.code, env.room || '····');
    setText(this.url, env.joinUrl ? baseJoinUrl(env.joinUrl) : '');
    toggle(this.https, 'rush-hide', env.https || !env.joinUrl);
    toggle(this.cert, 'rush-hide', !env.https);
    this.emptyHint.innerHTML = board.length ? '' : '<div class="rush-big-emoji">📱</div><div>Scan the code with your phone<br>to jump in — no app needed!</div>';
    this.renderRows(sh, board);
    this.renderNews(sh, present);
    // Teaser.
    const up = sh.upcoming ? minigameById(sh.upcoming) : null;
    this.nextLabel.innerHTML = up
      ? `<span class="rush-dim">UP NEXT</span> <span class="rush-next-game" style="color:${up.meta.color}">${up.meta.icon} ${escapeHtml(up.meta.name)}</span>`
      : '<span class="rush-dim">Pick some minigames in the menu (Esc)</span>';
  }

  /** Per-frame: the auto-advance ring. */
  frame(sh: RushShell): void {
    const present = sh.presentHumans().length;
    const auto = sh.settings.auto && present > 0;
    toggle(this.ring, 'rush-ring-off', !auto);
    if (auto) {
      const left = Math.max(0, sh.settings.autoSec - sh.phaseT);
      const frac = left / Math.max(1, sh.settings.autoSec);
      this.ringArc.style.strokeDashoffset = String(100 - frac * 100);
      setText(this.ringNum, String(Math.ceil(left)));
    } else {
      this.ringArc.style.strokeDashoffset = '0';
      setText(this.ringNum, present > 0 ? 'GO' : '');
    }
  }

  private renderRows(sh: RushShell, board: Entry[]): void {
    const ranks = sh.ranks();
    const lead = sh.leaderId();
    const two = board.length > 8;
    const shown = board.slice(0, 16);
    toggle(this.board, 'rush-two', two);
    const rowH = two ? 92 : board.length > 6 ? 92 : 104;
    const colW = two ? 575 : 1170;
    const seen = new Set<string>();
    shown.forEach((e, i) => {
      seen.add(e.id);
      let r = this.rows.get(e.id);
      if (!r) {
        r = this.makeRow(e);
        this.rows.set(e.id, r);
        this.board.appendChild(r.el);
        r.el.classList.add('rush-row-new');
      }
      r.gone = 0;
      const col = two && i >= 8 ? 1 : 0;
      const y = (two ? i % 8 : i) * rowH;
      r.el.style.setProperty('--x', String(col * (colW + 20)));
      r.el.style.setProperty('--y', String(y));
      r.el.style.setProperty('--w', String(colW));
      r.el.style.setProperty('--h', String(rowH - 12));
      if (r.el.classList.contains('rush-row-new')) {
        const el = r.el;
        requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('rush-row-new')));
      }
      const rank = ranks.get(e.id) ?? 0;
      const away = e.st === 'away' || !!e.removedAt;
      const key = `${two}|${e.name}|${e.emoji}|${e.color}|${rank}|${e.pts}|${sh.streak(e)}|${e.st}|${e.removedAt ? 1 : 0}|${e.touch}|${lead === e.id}|${e.lastRound === sh.roundsPlayed ? e.lastPts : 0}`;
      if (key === r.key) return;
      r.key = key;
      setText(r.rank, rank ? (rank === 1 ? '👑' : `${rank}`) : '–');
      r.disc.replaceChildren(disc(e, 60));
      setText(r.name, e.name);
      r.name.style.color = e.color;
      const st = sh.streak(e);
      setText(r.streak, st > 0 && sh.roundsPlayed > 1 ? (two ? `🔥 +${st}` : `🔥 +${st} last ${Math.min(LOOP.streakRounds, sh.roundsPlayed)}`) : '');
      setText(r.pts, String(e.pts));
      const fresh = e.lastRound === sh.roundsPlayed && e.lastPts > 0 && sh.roundsPlayed > 0;
      setText(r.plus, fresh ? `+${e.lastPts}` : '');
      toggle(r.plus, 'rush-on', fresh);
      setText(r.tag, e.removedAt ? (two ? '👋' : 'left') : away ? (two ? '💤' : '💤 away') : e.st === 'next' ? (two ? '⏭' : 'next round') : lead === e.id ? (two ? '⭐' : '⭐ leader') : '');
      toggle(r.el, 'rush-row-away', away);
      toggle(r.el, 'rush-row-top', rank === 1);
      r.el.dataset.playerId = e.id;
    });
    for (const [id, r] of this.rows) {
      if (seen.has(id)) continue;
      if (!r.gone) {
        r.gone = 1;
        r.el.classList.add('rush-row-gone');
        window.setTimeout(() => {
          if (r.gone) {
            r.el.remove();
            this.rows.delete(id);
          }
        }, 600);
      }
    }
  }

  private makeRow(e: Entry): RowEl {
    const rank = h('div', 'rush-row-rank');
    const d = h('div', 'rush-row-disc');
    const name = h('div', 'rush-row-name');
    const tag = h('div', 'rush-row-tag');
    const streak = h('div', 'rush-row-streak');
    const pts = h('div', 'rush-row-pts');
    const plus = h('div', 'rush-row-plus');
    const mid = h('div', 'rush-row-mid', h('div', 'rush-row-line', name, tag), streak);
    const el = h('div', { class: 'rush-row', 'data-rtid': 'rush-row', 'data-player-id': e.id }, rank, d, mid, plus, pts);
    return { el, rank, name, disc: d, streak, pts, plus, tag, key: '', gone: 0 };
  }

  private renderNews(sh: RushShell, present: Entry[]): void {
    const wall = Date.now();
    const all = [...sh.entries.values()];
    const lines: string[] = [];
    const joined = all.filter((e) => e.joinedAt && wall - e.joinedAt < 30_000 && !e.removedAt).sort((a, b) => b.joinedAt - a.joinedAt);
    if (joined.length) lines.push(`<div class="rush-news rush-news-join">👋 ${joined.slice(0, 4).map(nameSpan).join(', ')} joined!</div>`);
    const fresh = all.filter((e) => e.st === 'new' && e.connected && !e.removedAt);
    if (fresh.length) lines.push(`<div class="rush-news rush-news-tap">📱 Tap your phone to play: ${fresh.slice(0, 5).map(nameSpan).join(', ')}${fresh.length > 5 ? ` +${fresh.length - 5}` : ''}</div>`);
    if (present.length === 1) lines.push(`<div class="rush-news">🤖 Playing solo? Bots will join you!</div>`);
    this.news.innerHTML = lines.join('');
  }
}

function nameSpan(e: Entry): string {
  return `<b style="color:${e.color}">${e.emoji} ${escapeHtml(e.name)}</b>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
