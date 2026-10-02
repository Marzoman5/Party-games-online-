/**
 * SMASH RESULTS (host) — winner banner (name + colour; team in team mode) over the engine's 3D
 * victory pose, and a stats table: place, fighter, KOs, falls, damage dealt (+ score in time mode).
 * Leader picks: Rematch / Change Settings / Switch Game / Lobby (phone or host mouse).
 */
import { TEAM_COLORS, type ResultRow } from '../../../../net/protocol';
import { ordinal } from '../../../../engine/config';
import type { PartySession, ResultsState } from '../../../../engine/PartySession';
import type { ScreenView, UiContext } from '../../../../party/ui/HostUI';
import { FaceView } from '../../../../party/ui/LobbyScreen';
import { button, esc, h, replay, setText, toggle } from '../../../../party/ui/dom';
import { getCharacter } from '../../../../kart/roster';
import type { SmashModule } from '../SmashModule';

export class SmashResultsOverlay implements ScreenView {
  readonly root: HTMLDivElement;
  private readonly banner = h('div', { class: 'sh-winner', 'data-tid': 'winner-banner' });
  private readonly bannerKicker = h('div', 'sh-winner-kicker', 'WINNER');
  private readonly bannerName = h('div', 'sh-winner-name');
  private readonly bannerSub = h('div', 'sh-winner-sub');
  private readonly table = h('div', 'sh-table');
  private readonly who = h('div', 'kp-results-who');
  private readonly switchBtn: HTMLButtonElement;
  private shown: ResultsState | null = null;
  private portraitsKey = '';

  constructor(
    ctx: UiContext,
    private readonly mod: SmashModule,
  ) {
    const s = ctx.session;
    this.banner.append(this.bannerKicker, this.bannerName, this.bannerSub);
    this.switchBtn = button('Switch game', 'kp-switch', () => s.hostPost('switch'), 'btn-switch');
    this.root = h(
      'div',
      { class: 'kp-results sh-results', 'data-tid': 'screen-results' },
      h('div', 'sh-results-scrim'),
      h(
        'div',
        { class: 'sh-results-inner', 'data-tid': 'smash-results' },
        this.banner,
        h('div', { class: 'sh-results-card', 'data-tid': 'results' }, this.table),
        h(
          'div',
          'kp-results-foot',
          this.who,
          h(
            'div',
            'kp-host-actions',
            button('↻ Rematch', 'kp-primary', () => s.hostPost('replay'), 'btn-replay'),
            button('Change settings', '', () => s.hostPost('track'), 'btn-track'),
            this.switchBtn,
            button('Lobby', '', () => s.hostPost('lobby'), 'btn-lobby'),
          ),
        ),
      ),
    );
  }

  update(s: PartySession): void {
    const r = s.results;
    const leader = s.leader;
    setText(this.who, leader ? `${leader.name} picks what’s next on their phone` : 'The leader picks what’s next');
    const other = s.otherGame();
    toggle(this.switchBtn, 'kp-hidden', !other);
    if (other) this.switchBtn.innerHTML = `${s.modules[other].info.emoji} Play ${esc(s.modules[other].info.title)}`;
    if (!r || r.game !== 'smash') return;
    const pk = r.rows.map((x) => (this.mod.portrait(x.characterId) ? 1 : 0)).join('');
    if (r === this.shown && pk === this.portraitsKey) return;
    const fresh = r !== this.shown;
    this.shown = r;
    this.portraitsKey = pk;

    const info = r.info;
    const team = info?.winnerTeam;
    const top = r.rows[0];
    const color = typeof team === 'number' && team >= 0 ? TEAM_COLORS[team === 1 ? 1 : 0] : (top?.color ?? '#ffd23f');
    this.banner.style.setProperty('--win', color);
    setText(this.bannerKicker, info?.mode === 'time' ? 'TIME! · WINNER' : 'GAME! · WINNER');
    setText(this.bannerName, info?.winner || top?.name || '—');
    setText(this.bannerSub, typeof team === 'number' && team >= 0 ? 'TEAM VICTORY' : top ? getCharacter(top.characterId).name : '');
    if (fresh) replay(this.banner, 'kp-pop-in');
    this.renderTable(r.rows, info?.mode === 'time');
  }

  private renderTable(rows: ResultRow[], time: boolean): void {
    const head = h(
      'div',
      'sh-row sh-row-head',
      h('span', 'sh-c-place', ''),
      h('span', 'sh-c-name', 'FIGHTER'),
      h('span', 'sh-c-num', 'KOs'),
      h('span', 'sh-c-num', 'FALLS'),
      h('span', 'sh-c-num', 'DAMAGE'),
      time ? h('span', 'sh-c-num', 'SCORE') : h('span', 'sh-c-num', 'STOCKS'),
    );
    const list = rows.map((r, i) => {
      const face = new FaceView('sh-row-avatar');
      face.set(r.characterId, r.slot >= 0 ? r.color : null, r.slot >= 0 ? String(r.slot + 1) : 'C', this.mod.look(r.characterId));
      const row = h(
        'div',
        { class: `sh-row ${r.slot >= 0 ? 'sh-row-human' : 'sh-row-cpu'} ${r.place === 1 ? 'sh-row-win' : ''}`, 'data-tid': `result-row-${i}` },
        h('span', 'sh-c-place', ordinal(r.place)),
        h(
          'span',
          'sh-c-name',
          face.root,
          h('span', 'sh-c-who', h('b', {}, r.name), h('small', {}, `${getCharacter(r.characterId).name}${r.cpu ? ' · CPU' : ''}`)),
        ),
        h('span', 'sh-c-num', String(r.kos ?? 0)),
        h('span', 'sh-c-num', String(r.falls ?? 0)),
        h('span', 'sh-c-num', `${Math.round(r.damageDealt ?? 0)}%`),
        h('span', 'sh-c-num', time ? String(r.score ?? 0) : String(Math.max(0, r.stocksLeft ?? 0))),
      );
      const col = typeof r.team === 'number' && this.mod.lastConfig?.setup.teams ? TEAM_COLORS[r.team === 1 ? 1 : 0] : r.color;
      row.style.setProperty('--slot', col);
      return row;
    });
    this.table.replaceChildren(head, ...list);
  }
}
