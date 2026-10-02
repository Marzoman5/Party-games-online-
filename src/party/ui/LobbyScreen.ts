/**
 * LOBBY = the PARTY HUB — the game picker (big game cards, the leader picks on their phone or the
 * host clicks) above the joined players as big cards (slot colour, character avatar — or the
 * active game's portrait — name, character line, READY badge, crown on the leader, disconnected
 * state); empty seats keep a QR visible so more people can join at any time.
 */
import { GAME_IDS, MAX_PLAYERS, SLOT_COLORS, TEAM_COLORS, type GameId } from '../../net/protocol';
import type { CharacterLook } from '../../engine/GameModule';
import type { PartySession, PlayerRec } from '../../engine/PartySession';
import type { ScreenView, UiContext } from './HostUI';
import { AvatarView } from './avatar';
import { button, h, replay, setText, toggle } from './dom';
import { gameCardArt, gameLogoMarkup } from './gameArt';
import { QrView, baseJoinUrl } from './qr';
import { blip } from './sfx';

/** Avatar that shows the active game's portrait when one exists (else the kart avatar). */
export class FaceView {
  readonly root: HTMLDivElement;
  readonly avatar: AvatarView;
  private readonly img: HTMLImageElement;
  private src = '';

  constructor(cls: string) {
    this.avatar = new AvatarView(cls);
    this.img = h('img', { class: 'kp-portrait', alt: '', draggable: 'false' });
    this.root = h('div', 'kp-face', this.avatar.root, this.img);
  }

  set(characterId: string, slotColor: string | null, label: string, look: CharacterLook | null): void {
    this.avatar.set(characterId, slotColor, label);
    const src = look?.portrait ?? '';
    if (src !== this.src) {
      this.src = src;
      if (src) this.img.src = src;
      else this.img.removeAttribute('src');
    }
    toggle(this.root, 'kp-has-portrait', !!src);
  }
}

class GameCard {
  readonly root: HTMLButtonElement;
  constructor(
    readonly id: GameId,
    s: PartySession,
  ) {
    const info = s.modules[id].info;
    this.root = h('button', { class: 'kp-gcard', type: 'button', 'data-tid': `game-card-${id}` });
    this.root.style.setProperty('--gc', info.color);
    this.root.innerHTML = `<div class="kp-gcard-art">${gameCardArt(id)}</div>${gameLogoMarkup(info)}<div class="kp-gcard-tag"></div><div class="kp-gcard-pick">✓ SELECTED</div>`;
    this.root.querySelector('.kp-gcard-tag')!.textContent = info.tagline;
    this.root.addEventListener('click', (e) => {
      e.stopPropagation();
      s.hostPickGame(id);
    });
  }
}

class Card {
  readonly root: HTMLDivElement;
  readonly face = new FaceView('kp-card-avatar');
  private readonly team = h('div', 'kp-card-team');
  private readonly name = h('div', 'kp-card-name');
  private readonly racer = h('div', 'kp-card-racer');
  private readonly badge = h('div', 'kp-card-badge');
  private readonly crown = h('div', { class: 'kp-crown', title: 'Leader', text: '👑' });
  private readonly pnum = h('div', 'kp-card-pnum');
  private readonly empty: HTMLDivElement;
  private readonly emptyText = h('div', 'kp-empty-text');
  private readonly fx = h('div', 'kp-tryit');
  readonly qrHolder = h('div', 'kp-empty-qr');
  private readonly remove: HTMLButtonElement;
  playerId = '';
  private wasReady = false;

  constructor(
    readonly slot: number,
    onRemove: (id: string) => void,
  ) {
    this.remove = button('✕ Remove', 'kp-mini kp-card-remove', () => onRemove(this.playerId));
    this.empty = h('div', 'kp-card-empty', this.qrHolder, this.emptyText);
    this.root = h(
      'div',
      { class: 'kp-card', 'data-tid': `player-card-${slot}` },
      h('div', 'kp-card-band'),
      this.pnum,
      this.crown,
      h('div', 'kp-card-stage', this.face.root, this.fx),
      this.team,
      this.name,
      this.racer,
      this.badge,
      this.remove,
      this.empty,
    );
    this.root.style.setProperty('--slot', SLOT_COLORS[slot]);
    setText(this.pnum, `P${slot + 1}`);
  }

  set(p: PlayerRec | null, firstEmpty: boolean, look: CharacterLook | null = null, teams = false): void {
    toggle(this.root, 'kp-card-open', !p);
    if (!p) {
      if (this.playerId) this.playerId = '';
      setText(this.emptyText, firstEmpty ? 'Scan to join' : '+ open seat');
      toggle(this.root, 'kp-card-first-empty', firstEmpty);
      toggle(this.root, 'kp-ready', false);
      return;
    }
    const isNew = this.playerId !== p.playerId;
    this.playerId = p.playerId;
    if (isNew) {
      replay(this.root, 'kp-card-in');
      this.wasReady = p.ready;
    }
    this.face.set(p.characterId, SLOT_COLORS[p.slot], String(p.slot + 1), look);
    setText(this.name, p.name);
    setText(this.racer, look?.sub ?? '');
    toggle(this.team, 'kp-on', teams);
    if (teams) {
      setText(this.team, p.team === 1 ? 'BLUE TEAM' : 'RED TEAM');
      this.team.style.setProperty('--team', TEAM_COLORS[p.team === 1 ? 1 : 0]);
    }
    toggle(this.crown, 'kp-on', p.isLeader);
    toggle(this.root, 'kp-ready', p.ready && p.connected);
    toggle(this.root, 'kp-dc', !p.connected);
    toggle(this.root, 'kp-late', p.late);
    setText(this.badge, !p.connected ? 'DISCONNECTED' : p.ready ? 'READY ✓' : 'picking…');
    if (p.ready && !this.wasReady && p.connected) {
      replay(this.badge, 'kp-pop');
      blip('ready');
    }
    this.wasReady = p.ready;
  }

  tryIt(kind: 'drift' | 'item'): void {
    replay(this.face.root, kind === 'drift' ? 'kp-hop' : 'kp-wiggle');
    this.fx.className = 'kp-tryit';
    replay(this.fx, kind === 'drift' ? 'kp-tryit-sparks' : 'kp-tryit-item');
    blip(kind === 'drift' ? 'spark' : 'item');
  }
}

export class LobbyScreen implements ScreenView {
  readonly root: HTMLDivElement;
  private readonly cards: Card[] = [];
  private readonly qr: QrView;
  private readonly code = h('b', { class: 'kp-chip-code', 'data-tid': 'room-code' });
  private readonly url = h('span', { class: 'kp-chip-url', 'data-tid': 'join-url' });
  private readonly status = h('div', 'kp-status');
  private readonly sub = h('div', 'kp-status-sub');
  private readonly games: GameCard[] = [];
  private readonly pickHint = h('div', 'kp-gpick-hint');
  private knownIds = new Set<string>();

  constructor(private readonly ctx: UiContext) {
    this.qr = new QrView(ctx.apiBase, 'kp-qr-small');
    this.qr.root.querySelector('img')!.dataset.tid = 'qr';
    const grid = h('div', 'kp-cards');
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const c = new Card(i, (id) => ctx.session.hostRemovePlayer(id));
      this.cards.push(c);
      grid.appendChild(c.root);
    }
    const header = h(
      'div',
      'kp-header',
      h('div', 'kp-h1', 'LOBBY'),
      h('div', 'kp-join-chip', h('span', {}, 'Join at '), this.url, h('span', {}, ' · code '), this.code),
    );
    const picker = h('div', 'kp-gpick');
    for (const id of GAME_IDS) {
      if (!ctx.session.modules[id]) continue;
      const c = new GameCard(id, ctx.session);
      this.games.push(c);
      picker.appendChild(c.root);
    }
    this.root = h(
      'div',
      { class: 'kp-lobby', 'data-tid': 'screen-lobby' },
      h('div', 'kp-scrim'),
      h(
        'div',
        'kp-lobby-inner',
        header,
        h('div', 'kp-gpick-wrap', picker, this.pickHint),
        grid,
        h('div', 'kp-status-wrap', this.status, this.sub),
      ),
    );
  }

  update(s: PartySession): void {
    const mod = s.game;
    for (const g of this.games) {
      toggle(g.root, 'kp-selected', g.id === s.gameId);
      toggle(g.root, 'kp-loading', g.id === s.switching);
    }
    const lead = s.leader;
    setText(
      this.pickHint,
      s.switching
        ? `Loading ${s.modules[s.switching].info.title}…`
        : lead
          ? `👑 ${lead.name} picks the game on their phone`
          : '👑 The leader picks the game on their phone',
    );
    const setup = mod.getSetup() as { teams?: unknown };
    const teams = mod.id !== 'kart' && setup.teams === true;
    const bySlot: (PlayerRec | null)[] = [null, null, null, null];
    for (const p of s.players) if (p.slot >= 0 && p.slot < MAX_PLAYERS) bySlot[p.slot] = p;
    const firstEmpty = bySlot.findIndex((p) => !p);
    const ids = new Set<string>();
    this.cards.forEach((c, i) => {
      const p = bySlot[i];
      if (p) ids.add(p.playerId);
      let look: CharacterLook | null = null;
      if (p) {
        try {
          look = mod.look(p.characterId);
        } catch {
          look = null;
        }
      }
      c.set(p, i === firstEmpty, look, teams);
      if (i === firstEmpty && this.qr.root.parentElement !== c.qrHolder) c.qrHolder.appendChild(this.qr.root);
    });
    if (firstEmpty < 0) this.qr.root.remove();
    for (const id of ids) if (!this.knownIds.has(id)) blip('join');
    this.knownIds = ids;

    this.qr.set(s.joinUrl);
    setText(this.code, s.room || '····');
    setText(this.url, s.joinUrl ? baseJoinUrl(s.joinUrl) : '…');
    this.url.dataset.url = s.joinUrl;

    const connected = s.connectedPlayers;
    const leader = s.leader;
    const notReady = connected.filter((p) => !p.ready);
    let status: string;
    let sub = '';
    if (connected.length === 0) {
      status = 'Waiting for players to join…';
      sub = 'Scan the QR code with your phone camera';
    } else if (notReady.length > 0) {
      status = 'Waiting for everyone to ready up';
      sub =
        notReady.length <= 2
          ? `${notReady.map((p) => p.name).join(' & ')} — pick a character and tap READY`
          : 'Pick a name and character on your phone, then tap READY';
    } else {
      status = leader ? `${leader.name} (leader) can start ${mod.info.title} on their phone` : 'Everyone is ready!';
      sub = connected.length < MAX_PLAYERS ? 'More friends? Scan the code — there’s room for 4' : 'Full house — let’s go!';
    }
    setText(this.status, status);
    setText(this.sub, sub);
    toggle(this.status, 'kp-go', connected.length > 0 && notReady.length === 0);
  }

  tryIt(playerId: string, kind: 'drift' | 'item', _label = ''): void {
    this.cards.find((c) => c.playerId === playerId)?.tryIt(kind);
  }
}
