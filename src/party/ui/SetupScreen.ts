/**
 * SETUP — mirrors the leader's live choices big: mode, track card (name, theme colours,
 * difficulty stars, minimap from controlPoints), cc and laps. GP mode shows the 4-race cup.
 */
import { TRACKS, getTrackDef } from '../../track/tracks/index';
import { SLOT_COLORS } from '../../net/protocol';
import type { PartySession } from '../PartySession';
import type { ScreenView, UiContext } from './HostUI';
import { AvatarView } from './avatar';
import { button, h, replay, setText, toggle } from './dom';
import { minimapMarkup, stars, themeColors, themeEmoji } from './trackArt';

export class SetupScreen implements ScreenView {
  readonly root: HTMLDivElement;
  private readonly who = h('div', 'kp-setup-who');
  private readonly trackCard: HTMLDivElement;
  private readonly trackMap = h('div', 'kp-track-map');
  private readonly trackName = h('div', 'kp-track-name');
  private readonly trackStars = h('div', 'kp-track-stars');
  private readonly trackDesc = h('div', 'kp-track-desc');
  private readonly trackEmoji = h('div', 'kp-track-emoji');
  private readonly cup = h('div', 'kp-cup');
  private readonly modeSingle = h('div', 'kp-pill', 'SINGLE RACE');
  private readonly modeGp = h('div', 'kp-pill', 'GRAND PRIX');
  private readonly cc: HTMLDivElement[] = [];
  private readonly laps: HTMLDivElement[] = [];
  private readonly lapsRow = h('div', 'kp-opt');
  private readonly racers = h('div', 'kp-setup-racers');
  private readonly avatars = new Map<string, AvatarView>();
  private shownTrack = '';
  private shownMode = '';

  constructor(private readonly ctx: UiContext) {
    const s = ctx.session;
    this.trackCard = h(
      'div',
      'kp-track-card',
      h('div', 'kp-track-art', this.trackMap, this.trackEmoji),
      h('div', 'kp-track-info', this.trackName, this.trackStars, this.trackDesc),
    );
    // GP cup: 4 mini tracks in order.
    TRACKS.forEach((t, i) => {
      const [a, b] = themeColors(t);
      const mini = h('div', 'kp-cup-track', h('div', 'kp-cup-n', `RACE ${i + 1}`), h('div', 'kp-cup-name', t.name));
      mini.style.setProperty('--ta', a);
      mini.style.setProperty('--tb', b);
      const m = h('div', 'kp-cup-map');
      m.innerHTML = minimapMarkup(t, { size: 120 });
      mini.insertBefore(m, mini.children[1]);
      this.cup.appendChild(mini);
    });

    const ccRow = h('div', 'kp-opt');
    for (const v of [50, 100, 150]) {
      const p = h('div', 'kp-pill', `${v}cc`);
      p.dataset.v = String(v);
      this.cc.push(p);
      ccRow.appendChild(p);
    }
    for (let v = 1; v <= 5; v++) {
      const p = h('div', 'kp-pill kp-pill-sq', String(v));
      this.laps.push(p);
      this.lapsRow.appendChild(p);
    }

    const opts = h(
      'div',
      'kp-setup-opts',
      h('div', 'kp-opt-label', 'MODE'),
      h('div', 'kp-opt', this.modeSingle, this.modeGp),
      h('div', 'kp-opt-label', 'SPEED'),
      ccRow,
      h('div', 'kp-opt-label', 'LAPS'),
      this.lapsRow,
      h('div', 'kp-opt-label', 'RACERS'),
      this.racers,
    );

    const actions = h(
      'div',
      'kp-host-actions',
      button('▶ Start race', 'kp-primary', () => s.hostStart(), 'btn-start-race'),
      button('Back to lobby', '', () => s.hostBackToLobby(), 'btn-back-lobby'),
    );

    this.root = h(
      'div',
      { class: 'kp-setup', 'data-tid': 'screen-setup' },
      h('div', 'kp-scrim'),
      h(
        'div',
        'kp-setup-inner',
        h('div', 'kp-header', h('div', 'kp-h1', 'RACE SETUP'), this.who),
        h('div', 'kp-setup-main', h('div', 'kp-setup-track', this.trackCard, this.cup), opts),
        actions,
      ),
    );
  }

  update(s: PartySession): void {
    const leader = s.leader;
    setText(this.who, leader ? `${leader.name} is choosing on their phone` : 'The leader is choosing on their phone');
    if (leader) this.who.style.setProperty('--slot', SLOT_COLORS[leader.slot]);

    const gp = s.setup.mode === 'gp';
    toggle(this.modeSingle, 'kp-on', !gp);
    toggle(this.modeGp, 'kp-on', gp);
    toggle(this.trackCard, 'kp-hidden', gp);
    toggle(this.cup, 'kp-on', gp);
    if (s.setup.mode !== this.shownMode) {
      this.shownMode = s.setup.mode;
      replay(gp ? this.cup : this.trackCard, 'kp-pop-in');
    }

    const def = getTrackDef(s.setup.trackId);
    if (def.id !== this.shownTrack) {
      this.shownTrack = def.id;
      const [a, b] = themeColors(def);
      this.trackCard.style.setProperty('--ta', a);
      this.trackCard.style.setProperty('--tb', b);
      this.trackMap.innerHTML = minimapMarkup(def, { animated: true });
      setText(this.trackName, def.name);
      setText(this.trackStars, stars(def.difficulty));
      setText(this.trackDesc, def.description);
      setText(this.trackEmoji, themeEmoji(def));
      replay(this.trackCard, 'kp-pop-in');
    }
    this.cc.forEach((p) => toggle(p, 'kp-on', Number(p.dataset.v) === s.setup.cc));
    this.laps.forEach((p, i) => toggle(p, 'kp-on', i + 1 === s.setup.laps));

    // Racers (ready players) mini avatars.
    const racing = s.players.filter((p) => p.connected && p.ready);
    const keep = new Set<string>();
    for (const p of racing) {
      keep.add(p.playerId);
      let a = this.avatars.get(p.playerId);
      if (!a) {
        a = new AvatarView('kp-mini-avatar');
        this.avatars.set(p.playerId, a);
      }
      a.set(p.characterId, SLOT_COLORS[p.slot], String(p.slot + 1));
      a.root.title = p.name;
      a.root.style.setProperty('--slot', SLOT_COLORS[p.slot]);
      a.root.dataset.name = p.name;
      this.racers.appendChild(a.root);
    }
    for (const [id, a] of this.avatars) {
      if (!keep.has(id)) {
        a.root.remove();
        this.avatars.delete(id);
      }
    }
  }
}
