/**
 * RACE / LOADING — the engine draws the HUD; the party layer only adds a tiny room-code chip
 * (so latecomers can still join) and, while loading, a line-up strip of the human racers.
 */
import { SLOT_COLORS } from '../../net/protocol';
import { getTrackDef } from '../../track/tracks/index';
import type { PartySession } from '../PartySession';
import type { ScreenView, UiContext } from './HostUI';
import { AvatarView } from './avatar';
import { h, setText, toggle } from './dom';

export class RaceOverlay implements ScreenView {
  readonly root: HTMLDivElement;
  private readonly chip = h('div', 'kp-race-chip');
  private readonly code = h('b', { class: 'kp-chip-code', 'data-tid': 'room-code' });
  private readonly waiting = h('span', 'kp-race-waiting');
  private readonly lineup = h('div', 'kp-lineup');
  private readonly lineupTitle = h('div', 'kp-lineup-title');
  private readonly lineupRow = h('div', 'kp-lineup-row');
  private lineupKey = '';

  constructor(ctx: UiContext) {
    this.chip.append(h('span', {}, 'JOIN '), this.code, this.waiting);
    this.lineup.append(this.lineupTitle, this.lineupRow);
    this.root = h('div', { class: 'kp-race', 'data-tid': 'screen-race' }, this.chip, this.lineup);
  }

  update(s: PartySession): void {
    this.root.dataset.tid = s.screen === 'loading' ? 'screen-loading' : 'screen-race';
    setText(this.code, s.room);
    const late = s.players.filter((p) => p.connected && !(s.race && s.race.kartOf.has(p.playerId)));
    setText(this.waiting, late.length ? ` · ${late.map((p) => p.name).join(', ')} racing next time` : '');

    // Only while the engine is still building the track: its intro flyover has its own title card.
    const loading = s.game.phase === 'loading';
    toggle(this.lineup, 'kp-on', loading && !!s.race);
    if (s.race) {
      const racers = s.racers;
      const key = racers.map((p) => `${p.playerId}:${p.characterId}:${p.name}`).join('|') + s.race.trackId;
      if (key !== this.lineupKey) {
        this.lineupKey = key;
        const gp = s.gpView;
        setText(
          this.lineupTitle,
          `${gp ? `GRAND PRIX · RACE ${gp.race}/${gp.of} · ` : ''}${getTrackDef(s.race.trackId).name.toUpperCase()}`,
        );
        this.lineupRow.replaceChildren(
          ...racers.map((p) => {
            const a = new AvatarView('kp-lineup-avatar');
            a.set(p.characterId, SLOT_COLORS[p.slot], String(p.slot + 1));
            const item = h('div', 'kp-lineup-item', a.root, h('div', 'kp-lineup-name', p.name));
            item.style.setProperty('--slot', SLOT_COLORS[p.slot]);
            return item;
          }),
        );
      }
    }
  }
}
