/** Results: standings (+ GP points) and the leader's what-next buttons. */
import type { ResultRow } from '../../net/protocol';
import { net } from '../net';
import { state, type ViewId } from '../store';
import { avatarSvg, button, charById, fmtTime, h, ordSuffix, setText, show } from '../ui';
import type { View } from './view';

const MEDALS = ['🥇', '🥈', '🥉'];

export class ResultsView implements View {
  readonly el: HTMLElement;
  private title: HTMLElement;
  private list: HTMLElement;
  private listKey = '';
  private next: HTMLButtonElement;
  private replay: HTMLButtonElement;
  private track: HTMLButtonElement;
  private lobby: HTMLButtonElement;
  private wait: HTMLElement;
  private leaderBox: HTMLElement;

  constructor() {
    this.title = h('h2', { class: 'scr-title', testid: 'results-title' });
    this.list = h('div', { class: 'rlist', testid: 'results-list' });
    this.next = button('Next Race ▶', 'btn-next', () => net.send({ t: 'post', action: 'next' }), 'btn btn-start');
    this.replay = button('↻ Replay', 'btn-replay', () => net.send({ t: 'post', action: 'replay' }), 'btn btn-alt');
    this.track = button('🗺 Change Track', 'btn-track', () => net.send({ t: 'post', action: 'track' }), 'btn btn-alt');
    this.lobby = button('⌂ Back to Lobby', 'btn-lobby', () => net.send({ t: 'post', action: 'lobby' }), 'btn btn-alt');
    this.wait = h('div', { class: 'wait-msg', testid: 'results-wait' });
    this.leaderBox = h('div', { class: 'post-btns' }, this.next, this.replay, this.track, this.lobby);
    this.el = h(
      'div',
      { class: 'screen results scrollable', testid: 'screen-results' },
      h('section', { class: 'res-main' }, this.title, this.list),
      h('section', { class: 'res-side' }, this.leaderBox, this.wait),
    );
  }

  update(_view: ViewId): void {
    const ps = state.phone;
    const res = ps?.results;
    const gp = ps?.gp ?? null;
    const final = !!res?.gpFinal;
    const isGp = !!gp || (res?.rows.some((r) => r.total !== undefined) ?? false);
    setText(
      this.title,
      final ? '🏆 Grand Prix final standings' : gp ? `Grand Prix — race ${gp.race} of ${gp.of}` : '🏁 Race results',
    );
    const rows = res?.rows ?? [];
    const key = JSON.stringify(rows) + state.playerId;
    if (key !== this.listKey) {
      this.listKey = key;
      this.renderRows(rows, isGp, final);
    }
    const leader = !!ps?.you?.isLeader;
    show(this.leaderBox, leader);
    setText(this.next, final ? '🏆 New Grand Prix' : 'Next Race ▶');
    show(this.wait, !leader);
    const leaderName = ps?.players.find((p) => p.isLeader)?.name ?? 'the leader';
    setText(this.wait, `Waiting for ${leaderName}…`);
  }

  private renderRows(rows: ResultRow[], isGp: boolean, final: boolean): void {
    this.list.textContent = '';
    const you = state.phone?.you;
    const sorted = [...rows];
    if (final) sorted.sort((a, b) => (b.total ?? 0) - (a.total ?? 0) || a.place - b.place);
    else sorted.sort((a, b) => a.place - b.place);
    sorted.forEach((r, i) => {
      const me = !!you && r.slot === you.slot && r.slot >= 0;
      const rank = final ? i + 1 : r.place;
      const row = h(
        'div',
        { class: `rrow${me ? ' me' : ''}${r.slot >= 0 ? ' human' : ''}`, style: `--rc:${r.color}`, testid: `result-${rank}` },
        h('span', { class: 'rplace', html: rank <= 3 ? MEDALS[rank - 1] : `${rank}<sup>${ordSuffix(rank)}</sup>` }),
        avatarSvg(charById(r.characterId), 28),
        h('span', { class: 'rname' }, r.name, me ? h('em', { text: ' (you)' }) : null),
        final ? null : h('span', { class: 'rtime', text: fmtTime(r.time) }),
        isGp && !final ? h('span', { class: 'rpts', text: r.points !== undefined ? `+${r.points}` : '' }) : null,
        isGp ? h('span', { class: 'rtotal', text: r.total !== undefined ? `${r.total} pts` : '' }) : null,
      );
      this.list.append(row);
    });
    if (!rows.length) this.list.append(h('div', { class: 'pempty', text: 'Crunching the results…' }));
  }
}
