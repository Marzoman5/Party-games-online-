/**
 * RESULTS — podium + full standings with slot colours and times; GP points & totals; after
 * the 4th GP race, the final GP podium with CSS confetti. "Leader picks what's next".
 */
import { SLOT_COLORS, type ResultRow } from '../../../net/protocol';
import { TRACKS, getTrackDef } from '../../../track/tracks/index';
import { formatTime, ordinal } from '../../../engine/config';
import type { PartySession, ResultsState } from '../../../engine/PartySession';
import type { KartModule } from '../KartModule';
import type { ScreenView, UiContext } from '../../../party/ui/HostUI';
import { avatarSvg } from '../../../party/ui/avatar';
import { button, esc, h, setText, toggle } from '../../../party/ui/dom';
import { getCharacter } from '../../../kart/roster';

const PODIUM_ORDER = [1, 0, 2]; // 2nd, 1st, 3rd

export class KartResultsOverlay implements ScreenView {
  readonly root: HTMLDivElement;
  private readonly kicker = h('div', 'kp-kicker');
  private readonly title = h('div', 'kp-h1');
  private readonly podium = h('div', 'kp-podium');
  private readonly table = h('div', 'kp-table');
  private readonly who = h('div', 'kp-results-who');
  private readonly confetti = h('div', 'kp-confetti');
  private readonly nextBtn: HTMLButtonElement;
  private readonly switchBtn: HTMLButtonElement;
  private shown: ResultsState | null = null;

  constructor(
    ctx: UiContext,
    private readonly kart: KartModule,
  ) {
    const s = ctx.session;
    this.nextBtn = button('Next ▶', 'kp-primary', () => s.hostPost('next'), 'btn-next');
    this.switchBtn = button('Switch game', 'kp-switch', () => s.hostPost('switch'), 'btn-switch');
    for (let i = 0; i < 36; i++) {
      const c = h('i');
      c.style.setProperty('--x', `${Math.random() * 100}%`);
      c.style.setProperty('--d', `${(Math.random() * 2.5).toFixed(2)}s`);
      c.style.setProperty('--t', `${(2.8 + Math.random() * 2.2).toFixed(2)}s`);
      c.style.setProperty('--c', ['#ff4d4d', '#3d8bff', '#3ddc5a', '#ffc21a', '#ff3ab8', '#ffffff'][i % 6]);
      c.style.setProperty('--r', `${Math.round(Math.random() * 360)}deg`);
      this.confetti.appendChild(c);
    }
    this.root = h(
      'div',
      { class: 'kp-results', 'data-tid': 'screen-results' },
      h('div', 'kp-scrim kp-scrim-strong'),
      this.confetti,
      h(
        'div',
        { class: 'kp-results-inner', 'data-tid': 'results' },
        h('div', 'kp-results-head', this.kicker, this.title),
        h('div', 'kp-results-main', this.podium, this.table),
        h(
          'div',
          'kp-results-foot',
          this.who,
          h(
            'div',
            'kp-host-actions',
            this.nextBtn,
            button('↻ Replay', '', () => s.hostPost('replay'), 'btn-replay'),
            button('Change track', '', () => s.hostPost('track'), 'btn-track'),
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
    if (!r || r.game !== 'kart') return;
    const gp = this.kart.gp;
    const trackId = typeof r.meta.trackId === 'string' ? r.meta.trackId : this.kart.trackId;
    const final = r.gpFinal && !!gp;
    if (gp) this.nextBtn.innerHTML = final ? 'New Grand Prix ▶' : `Next race ▶ <small>${esc(TRACKS[gp.race % TRACKS.length].name)}</small>`;
    else {
      const i = TRACKS.findIndex((t) => t.id === trackId);
      this.nextBtn.innerHTML = `Next track ▶ <small>${esc(TRACKS[(i + 1) % TRACKS.length].name)}</small>`;
    }
    toggle(this.root, 'kp-final', final);
    const other = s.otherGame();
    toggle(this.switchBtn, 'kp-hidden', !other);
    if (other) this.switchBtn.innerHTML = `${s.modules[other].info.emoji} Play ${esc(s.modules[other].info.title)}`;
    if (r === this.shown) return;
    this.shown = r;

    const track = getTrackDef(trackId);
    if (final && gp) {
      setText(this.kicker, 'GRAND PRIX · FINAL STANDINGS');
      const st = gp.standings();
      setText(this.title, st[0] ? `🏆 ${st[0].name} WINS THE CUP!` : 'GRAND PRIX COMPLETE');
      this.renderPodium(st.slice(0, 3).map((e) => ({ name: e.name, characterId: e.characterId, color: e.color, slot: e.slot, place: e.place, sub: `${e.total} pts` })));
      this.renderGpTable(st, gp.of);
    } else {
      setText(this.kicker, gp ? `GRAND PRIX · RACE ${gp.race}/${gp.of}` : 'RACE RESULTS');
      setText(this.title, track.name.toUpperCase());
      this.renderPodium(r.rows.slice(0, 3).map((row) => ({ ...row, sub: formatTime(row.time) })));
      this.renderTable(r.rows, !!gp);
    }
  }

  private renderPodium(rows: { name: string; characterId: string; color: string; slot: number; place: number; sub: string }[]): void {
    const steps = PODIUM_ORDER.map((i) => rows[i]).map((row, k) => {
      if (!row) return h('div', 'kp-podium-col kp-podium-empty');
      const pos = PODIUM_ORDER[k] + 1;
      const av = h('div', 'kp-podium-avatar');
      av.appendChild(avatarSvg(row.characterId, row.slot >= 0 ? SLOT_COLORS[row.slot] : null, { label: row.slot >= 0 ? String(row.slot + 1) : '' }));
      const col = h(
        'div',
        `kp-podium-col kp-p${pos}`,
        av,
        h('div', 'kp-podium-name', row.name),
        h('div', 'kp-podium-sub', row.sub),
        h('div', 'kp-podium-step', h('span', {}, String(pos))),
      );
      col.style.setProperty('--slot', row.slot >= 0 ? SLOT_COLORS[row.slot] : row.color);
      toggle(col, 'kp-human', row.slot >= 0);
      return col;
    });
    this.podium.replaceChildren(...steps);
  }

  private renderTable(rows: ResultRow[], gp: boolean): void {
    const head = h(
      'div',
      'kp-row kp-row-head',
      h('span', 'kp-c-place', ''),
      h('span', 'kp-c-name', 'RACER'),
      h('span', 'kp-c-time', 'TIME'),
      gp ? h('span', 'kp-c-pts', '+PTS') : null,
      gp ? h('span', 'kp-c-total', 'TOTAL') : null,
    );
    const list = rows.map((r) => {
      const row = h(
        'div',
        `kp-row ${r.slot >= 0 ? 'kp-row-human' : ''}`,
        h('span', 'kp-c-place', ordinal(r.place)),
        h(
          'span',
          'kp-c-name',
          h('b', {}, r.name),
          h('small', {}, r.slot >= 0 ? ` ${getCharacter(r.characterId).name}` : ' CPU'),
        ),
        h('span', 'kp-c-time', formatTime(r.time)),
        gp ? h('span', 'kp-c-pts', `+${r.points ?? 0}`) : null,
        gp ? h('span', 'kp-c-total', String(r.total ?? 0)) : null,
      );
      row.style.setProperty('--slot', r.slot >= 0 ? SLOT_COLORS[r.slot] : r.color);
      return row;
    });
    this.table.className = `kp-table ${gp ? 'kp-table-gp' : ''}`;
    this.table.replaceChildren(head, ...list);
  }

  private renderGpTable(st: ReturnType<NonNullable<KartModule['gp']>['standings']>, of: number): void {
    const head = h(
      'div',
      'kp-row kp-row-head',
      h('span', 'kp-c-place', ''),
      h('span', 'kp-c-name', 'RACER'),
      ...Array.from({ length: of }, (_, i) => h('span', 'kp-c-race', `R${i + 1}`)),
      h('span', 'kp-c-total', 'TOTAL'),
    );
    const list = st.map((e) => {
      const row = h(
        'div',
        `kp-row ${e.slot >= 0 ? 'kp-row-human' : ''}`,
        h('span', 'kp-c-place', ordinal(e.place)),
        h('span', 'kp-c-name', h('b', {}, e.name), h('small', {}, e.slot >= 0 ? '' : ' CPU')),
        ...e.perRace.map((p) => h('span', 'kp-c-race', p < 0 ? '–' : String(p))),
        h('span', 'kp-c-total', String(e.total)),
      );
      row.style.setProperty('--slot', e.slot >= 0 ? SLOT_COLORS[e.slot] : e.color);
      return row;
    });
    this.table.className = 'kp-table kp-table-final';
    this.table.replaceChildren(head, ...list);
  }
}
