/** Results: standings (kart: times + GP points; smash: KOs / falls / damage) and the leader's what-next buttons. */
import type { ResultRow } from '../../net/protocol';
import { TEAM_COLORS } from '../../net/protocol';
import { gameInfo, otherGame } from '../games';
import { net } from '../net';
import { activeGame, state, type ViewId } from '../store';
import { avatarSvg, button, charById, fmtTime, h, ordSuffix, setText, show, toggleClass } from '../ui';
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
  private sw: HTMLButtonElement;
  private lobby: HTMLButtonElement;
  private wait: HTMLElement;
  private leaderBox: HTMLElement;

  constructor() {
    this.title = h('h2', { class: 'scr-title', testid: 'results-title' });
    this.list = h('div', { class: 'rlist', testid: 'results-list' });
    this.next = button('Next Race ▶', 'btn-next', () => net.send({ t: 'post', action: 'next' }), 'btn btn-start');
    this.replay = button('↻ Replay', 'btn-replay', () => net.send({ t: 'post', action: 'replay' }), 'btn btn-alt');
    this.track = button('🗺 Change Track', 'btn-track', () => net.send({ t: 'post', action: 'track' }), 'btn btn-alt');
    this.sw = button('⇄ Switch Game', 'btn-post-switch', () => net.send({ t: 'post', action: 'switch', game: otherGame() }), 'btn btn-alt btn-switch');
    this.lobby = button('⌂ Back to Lobby', 'btn-lobby', () => net.send({ t: 'post', action: 'lobby' }), 'btn btn-alt');
    this.wait = h('div', { class: 'wait-msg', testid: 'results-wait' });
    this.leaderBox = h('div', { class: 'post-btns' }, this.next, this.replay, this.track, this.sw, this.lobby);
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
    const smash = activeGame() === 'smash';
    toggleClass(this.el, 'g-smash', smash);
    const rows = res?.rows ?? [];
    const leader = !!ps?.you?.isLeader;
    const hub = !!ps?.games?.length || !!ps?.game;

    if (smash) {
      const info = ps?.resultsInfo;
      let winner = info?.winner ?? '';
      const wp = ps?.players.find((p) => p.playerId === winner);
      if (wp) winner = wp.playerId === state.playerId ? 'You' : wp.name;
      if (!winner) winner = [...rows].sort((a, b) => a.place - b.place)[0]?.name ?? '';
      const team = info?.winnerTeam;
      const title =
        team !== undefined && team >= 0 ? `🏆 ${team === 0 ? 'RED' : 'BLUE'} TEAM wins!` : winner ? `🏆 ${winner} ${winner === 'You' ? 'win' : 'wins'}!` : '🥊 Match results';
      setText(this.title, title);
      const key = JSON.stringify(rows) + state.playerId + JSON.stringify(info ?? null);
      if (key !== this.listKey) {
        this.listKey = key;
        this.renderSmash(rows, team ?? -1, info?.mode === 'time' || rows.some((r) => r.score !== undefined && r.stocksLeft === undefined));
      }
      // Smash: Rematch / Change Settings / Switch Game / Lobby.
      this.replay.setAttribute('data-testid', 'btn-post-replay');
      this.track.setAttribute('data-testid', 'btn-post-track');
      this.lobby.setAttribute('data-testid', 'btn-post-lobby');
      setText(this.replay, '↻ Rematch');
      setText(this.track, '⚙️ Change Settings');
      setText(this.lobby, '⌂ Lobby');
      toggleClass(this.replay, 'btn-start', true);
      toggleClass(this.replay, 'btn-alt', false);
      show(this.next, false);
    } else {
      const gp = ps?.gp ?? null;
      const final = !!res?.gpFinal;
      const isGp = !!gp || rows.some((r) => r.total !== undefined);
      setText(this.title, final ? '🏆 Grand Prix final standings' : gp ? `Grand Prix — race ${gp.race} of ${gp.of}` : '🏁 Race results');
      const key = JSON.stringify(rows) + state.playerId;
      if (key !== this.listKey) {
        this.listKey = key;
        this.renderKart(rows, isGp, final);
      }
      // Kart keeps its original testids.
      this.replay.setAttribute('data-testid', 'btn-replay');
      this.track.setAttribute('data-testid', 'btn-track');
      this.lobby.setAttribute('data-testid', 'btn-lobby');
      setText(this.replay, '↻ Replay');
      setText(this.track, '🗺 Change Track');
      setText(this.lobby, '⌂ Back to Lobby');
      toggleClass(this.replay, 'btn-start', false);
      toggleClass(this.replay, 'btn-alt', true);
      show(this.next, true);
      setText(this.next, final ? '🏆 New Grand Prix' : 'Next Race ▶');
    }
    const other = gameInfo(otherGame());
    setText(this.sw, `⇄ Play ${other.title}`);
    show(this.sw, hub);
    show(this.leaderBox, leader);
    show(this.wait, !leader);
    const leaderName = ps?.players.find((p) => p.isLeader)?.name ?? 'the leader';
    setText(this.wait, `Waiting for ${leaderName}…`);
  }

  private isMe(r: ResultRow): boolean {
    const you = state.phone?.you;
    return !!you && r.slot === you.slot && r.slot >= 0 && !r.cpu;
  }

  private renderKart(rows: ResultRow[], isGp: boolean, final: boolean): void {
    this.list.textContent = '';
    const sorted = [...rows];
    if (final) sorted.sort((a, b) => (b.total ?? 0) - (a.total ?? 0) || a.place - b.place);
    else sorted.sort((a, b) => a.place - b.place);
    sorted.forEach((r, i) => {
      const me = this.isMe(r);
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

  private renderSmash(rows: ResultRow[], winnerTeam: number, timeMode: boolean): void {
    this.list.textContent = '';
    const sorted = [...rows].sort((a, b) => a.place - b.place);
    this.list.append(
      h(
        'div',
        { class: 'rhead' },
        h('span', { class: 'rplace' }),
        h('span', { class: 'rname' }),
        timeMode ? h('span', { class: 'rstat', text: 'SCORE' }) : null,
        h('span', { class: 'rstat', text: 'KOs' }),
        h('span', { class: 'rstat', text: 'FALLS' }),
        h('span', { class: 'rstat wide', text: 'DAMAGE' }),
      ),
    );
    sorted.forEach((r) => {
      const me = this.isMe(r);
      const win = winnerTeam >= 0 ? r.team === winnerTeam : r.place === 1;
      const col = winnerTeam >= 0 && r.team !== undefined ? TEAM_COLORS[r.team % 2] : r.color;
      const rank = r.place;
      const row = h(
        'div',
        { class: `rrow srow${me ? ' me' : ''}${r.cpu ? '' : ' human'}${win ? ' win' : ''}`, style: `--rc:${col}`, testid: `result-${rank}` },
        h('span', { class: 'rplace', html: rank <= 3 ? MEDALS[rank - 1] : `${rank}<sup>${ordSuffix(rank)}</sup>` }),
        avatarSvg(charById(r.characterId), 28),
        h('span', { class: 'rname' }, r.name, r.cpu && !/cpu/i.test(r.name) ? h('em', { text: ' CPU' }) : null, me ? h('em', { text: ' (you)' }) : null),
        timeMode ? h('span', { class: `rstat score${(r.score ?? 0) > 0 ? ' pos' : ''}`, text: `${(r.score ?? 0) > 0 ? '+' : ''}${r.score ?? 0}` }) : null,
        h('span', { class: 'rstat kos', text: String(r.kos ?? 0) }),
        h('span', { class: 'rstat', text: String(r.falls ?? 0) }),
        h('span', { class: 'rstat wide', text: `${Math.round(r.damageDealt ?? 0)}%` }),
      );
      this.list.append(row);
    });
    if (!rows.length) this.list.append(h('div', { class: 'pempty', text: 'Counting the KOs…' }));
  }
}
