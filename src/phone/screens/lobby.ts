/**
 * Lobby / title / connecting / waiting: profile editor (name + racer + READY),
 * player list and the leader's controls.
 */
import { SLOT_COLORS, type GameId, type LobbyPlayer } from '../../net/protocol';
import type { CharacterDef } from '../../core/types';
import type { FighterDef } from '../../games/smash/types';
import { FIGHTERS } from '../../games/smash/roster';
import { gameInfo, gameList } from '../games';
import { net } from '../net';
import {
  MAX_NAME,
  defaultName,
  flushName,
  isTakenByOthers,
  profile,
  setCharacter,
  setName,
  setReady,
  shownCharacter,
  shownReady,
} from '../profile';
import { activeGame, state, type ViewId } from '../store';
import { CHARACTERS, avatarSvg, button, charById, h, hex, setHtml, setText, show, toast, toggleClass } from '../ui';
import { haptic } from '../haptics';
import type { View } from './view';

const STAT_LABELS: [keyof CharacterDef['stats'], string][] = [
  ['speed', 'SPD'],
  ['acceleration', 'ACC'],
  ['handling', 'HDL'],
];

const FSTAT_LABELS: [keyof FighterDef['bars'], string][] = [
  ['power', 'POW'],
  ['speed', 'SPD'],
  ['weight', 'WGT'],
  ['jump', 'JMP'],
  ['range', 'RNG'],
];

export function fighterDef(id: string | null | undefined): FighterDef | null {
  if (!id) return null;
  return FIGHTERS.find((f) => f.id === id) ?? null;
}

function esc(t: string): string {
  return t.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch);
}

/** Smash fighter info (archetype, specials, tip) for the character select. */
export function fighterInfoHtml(c: CharacterDef, f: FighterDef): string {
  const sp = f.specials;
  const mv = (k: string, m: { name: string }) => `<span class="mv"><i>${k}</i>${esc(m.name)}</span>`;
  return `<div class="fi-head"><b>${esc(c.name)}</b><span class="arch-pill">${esc(f.archetypeLabel)}</span><span class="fi-tip">${esc(f.tip)}</span></div><div class="fi-moves">${mv('B', sp.neutral)}${mv('→B', sp.side)}${mv('↑B', sp.up)}${mv('↓B', sp.down)}</div>`;
}

function racerCard(c: CharacterDef): HTMLButtonElement {
  const b = h('button', { class: 'racer', testid: `char-${c.id}`, type: 'button', style: `--rc:${hex(c.color)}` });
  const stats = h('div', { class: 'stats' });
  for (const [k, label] of STAT_LABELS) {
    stats.append(
      h(
        'div',
        { class: 'stat' },
        h('span', { text: label }),
        h('i', null, h('b', { style: `width:${Math.round(8 + c.stats[k] * 92)}%` })),
      ),
    );
  }
  const f = fighterDef(c.id);
  const fstats = h('div', { class: 'stats fstats' });
  if (f) {
    for (const [k, label] of FSTAT_LABELS) {
      fstats.append(
        h('div', { class: 'stat' }, h('span', { text: label }), h('i', null, h('b', { style: `width:${Math.round((Math.max(0, Math.min(5, f.bars[k])) / 5) * 100)}%` }))),
      );
    }
  }
  b.append(
    avatarSvg(c, 46),
    h('div', { class: 'racer-name', text: c.name }),
    h('div', { class: `wclass w-${c.weightClass}`, text: c.weightClass }),
    h('div', { class: 'arch', text: f?.archetypeLabel ?? '' }),
    stats,
    fstats,
    h('div', { class: 'taken-tag', text: 'TAKEN' }),
  );
  b.addEventListener('click', () => {
    if (isTakenByOthers(c.id)) {
      b.classList.remove('shake');
      void b.offsetWidth;
      b.classList.add('shake');
      haptic('press');
      toast(`${c.name} is taken — pick another racer!`);
      return;
    }
    haptic('tick');
    setCharacter(c.id);
    lobbyRefresh();
  });
  return b;
}

let lobbyRefresh: () => void = () => {};

export class LobbyView implements View {
  readonly el: HTMLElement;
  private nameInput: HTMLInputElement;
  private cards = new Map<string, HTMLButtonElement>();
  private info: HTMLElement;
  private banner: HTMLElement;
  private plist: HTMLElement;
  private plistKey = '';
  private readyBtn: HTMLButtonElement;
  private startBtn: HTMLButtonElement;
  private reason: HTMLElement;
  private chips: HTMLElement;
  private tipsBtn: HTMLButtonElement;
  private transferMenu: HTMLElement;
  private transferKey = '';
  private side: HTMLElement;
  private sideTitle: HTMLElement;
  private gamePick: HTMLElement;
  private gameKey = '';
  private gameLocal: GameId | null = null;
  private gameLocalAt = 0;

  constructor() {
    lobbyRefresh = () => this.update(this.lastView);
    this.nameInput = h('input', {
      class: 'name-input',
      testid: 'name-input',
      type: 'text',
      maxlength: MAX_NAME,
      autocomplete: 'off',
      autocorrect: 'off',
      autocapitalize: 'words',
      spellcheck: 'false',
      enterkeyhint: 'done',
      'aria-label': 'Your name',
    });
    this.nameInput.value = profile.name;
    this.nameInput.addEventListener('input', () => {
      if (this.nameInput.value.length > MAX_NAME) this.nameInput.value = this.nameInput.value.slice(0, MAX_NAME);
      setName(this.nameInput.value);
    });
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.nameInput.blur();
    });
    this.nameInput.addEventListener('blur', () => {
      flushName();
      window.scrollTo(0, 0); // iOS leaves the page shifted after the keyboard closes
    });

    const grid = h('div', { class: 'racers' });
    for (const c of CHARACTERS) {
      const card = racerCard(c);
      this.cards.set(c.id, card);
      grid.append(card);
    }
    this.info = h('div', { class: 'racer-info', testid: 'racer-info' });

    this.banner = h('div', { class: 'lobby-banner', testid: 'lobby-banner' });

    const profileCol = h(
      'section',
      { class: 'profile scrollable' },
      this.banner,
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Your name' }), this.nameInput),
      grid,
      this.info,
    );

    this.plist = h('div', { class: 'plist', testid: 'player-list' });

    // Leader chips
    this.tipsBtn = button('', 'btn-tips', () => {
      const on = !(state.phone?.tipsEnabled ?? true);
      net.send({ t: 'tips', enabled: on });
    }, 'chip');
    this.transferMenu = h('div', { class: 'menu-pop', testid: 'transfer-menu' });
    show(this.transferMenu, false);
    const transferBtn = button('👑 ▾', 'btn-transfer', () => {
      show(this.transferMenu, this.transferMenu.style.display === 'none');
    }, 'chip');
    transferBtn.setAttribute('aria-label', 'Pass party leader to someone else');
    this.chips = h(
      'div',
      { class: 'chips' },
      button('❓ How to Play', 'btn-howto', () => net.send({ t: 'howto' }), 'chip'),
      this.tipsBtn,
      h('div', { class: 'chip-wrap' }, transferBtn, this.transferMenu),
    );

    this.sideTitle = h('div', { class: 'side-title', text: 'Racers' });
    this.side = h('section', { class: 'side' }, this.chips, this.sideTitle, this.plist);
    this.gamePick = h('div', { class: 'game-pick', testid: 'game-picker' });

    this.readyBtn = button('', 'btn-ready', () => {
      setReady(!shownReady());
      this.update(this.lastView);
    }, 'btn btn-ready');
    this.startBtn = button('START ▶', 'btn-start', () => net.send({ t: 'start' }), 'btn btn-start');
    this.reason = h('div', { class: 'reason', testid: 'start-reason' });
    const actions = h('section', { class: 'actions' }, h('div', { class: 'action-row' }, this.readyBtn, this.startBtn), this.reason);

    this.el = h('div', { class: 'screen lobby scrollable', testid: 'screen-lobby' }, this.gamePick, profileCol, this.side, actions);
  }

  private lastView: ViewId = 'lobby';

  update(view: ViewId): void {
    this.lastView = view;
    this.el.setAttribute('data-testid', `screen-${view}`);
    const ps = state.phone;
    const you = ps?.you ?? null;
    const waiting = view === 'waiting';
    const game = activeGame();
    const smash = game === 'smash';
    toggleClass(this.el, 'g-smash', smash);
    this.el.setAttribute('data-game', game);
    this.renderGamePick(!!you?.isLeader && !waiting);
    setText(this.sideTitle, smash ? 'Fighters' : 'Racers');

    // Banner
    let bannerText = '';
    if (view === 'connecting') bannerText = state.conn === 'reconnecting' ? 'Reconnecting…' : 'Joining the party…';
    else if (waiting) bannerText = smash ? "🥊 A match is in progress — you'll join the next one!" : "🏁 A race is in progress — you'll join the next one!";
    else if (view === 'title') bannerText = '🎉 You’re in! Getting the lobby ready…';
    setText(this.banner, bannerText);
    show(this.banner, bannerText !== '');

    // Name
    if (document.activeElement !== this.nameInput) {
      const v = profile.name || you?.name || '';
      if (this.nameInput.value !== v) this.nameInput.value = v;
    }
    this.nameInput.placeholder = defaultName();

    // Racers
    const sel = shownCharacter();
    for (const [id, card] of this.cards) {
      toggleClass(card, 'sel', id === sel);
      toggleClass(card, 'taken', isTakenByOthers(id));
      card.setAttribute('aria-pressed', String(id === sel));
    }
    const c = charById(sel);
    const fd = smash && c ? fighterDef(c.id) : null;
    if (fd && c) setHtml(this.info, fighterInfoHtml(c, fd));
    else setHtml(this.info, esc(c ? `${c.name} · ${c.tagline}` : smash ? 'Pick your fighter!' : 'Pick your racer!'));
    toggleClass(this.info, 'rich', !!fd);

    // Players
    const players = ps?.players ?? [];
    const key = JSON.stringify(players) + (state.playerId ?? '');
    if (key !== this.plistKey) {
      this.plistKey = key;
      this.renderPlayers(players);
    }

    // Actions
    const ready = shownReady();
    setHtml(
      this.readyBtn,
      ready
        ? '<span class="big">✓ READY!</span><small>tap to cancel</small>'
        : '<span class="big">I’M READY</span><small>tap when you’re set</small>',
    );
    toggleClass(this.readyBtn, 'on', ready);
    this.readyBtn.disabled = !you;
    show(this.readyBtn, !waiting);

    const leader = !!you?.isLeader && !waiting;
    show(this.startBtn, leader);
    show(this.chips, leader);
    if (!leader) show(this.transferMenu, false);
    const leaderName = players.find((p) => p.isLeader)?.name ?? 'the leader';
    if (leader) {
      const connected = players.filter((p) => p.connected);
      const notReady = connected.filter((p) => !(p.playerId === you!.playerId ? ready : p.ready));
      const can = connected.length > 0 && notReady.length === 0;
      this.startBtn.disabled = !can;
      let r = 'Everyone is ready — hit START!';
      if (!can) {
        if (notReady.some((p) => p.playerId === you!.playerId)) r = 'Tap READY, then you can start';
        else r = `Waiting for ${notReady.map((p) => p.name).join(', ')} to ready up`;
      }
      setText(this.reason, r);
      setText(this.tipsBtn, ps?.tipsEnabled ? '💡 Tips ON' : '💡 Tips OFF');
      toggleClass(this.tipsBtn, 'on', !!ps?.tipsEnabled);
      this.renderTransfer(players);
    } else if (waiting) {
      setText(this.reason, 'Pick your name and racer while you wait');
    } else if (you) {
      setText(this.reason, ready ? `Waiting for ${leaderName} to start…` : 'Tap READY when you’re set!');
    } else {
      setText(this.reason, '');
    }
  }

  /** Leader: big Kart / Smash picker; others: the active game as a badge. */
  private renderGamePick(leader: boolean): void {
    const games = gameList();
    const now = performance.now();
    let active = activeGame();
    if (this.gameLocal && now - this.gameLocalAt < 1500) active = this.gameLocal;
    else this.gameLocal = null;
    const key = JSON.stringify(games.map((g) => [g.id, g.title, g.emoji, g.color])) + leader + active;
    show(this.gamePick, games.length > 1);
    if (key === this.gameKey) return;
    this.gameKey = key;
    this.gamePick.textContent = '';
    toggleClass(this.gamePick, 'leader', leader);
    for (const g of games) {
      if (!leader && g.id !== active) continue;
      const [first, ...rest] = g.title.split(' ');
      const inner = h(
        'span',
        { class: 'gp-inner' },
        h('span', { class: 'gp-emoji', text: g.emoji }),
        h('span', { class: 'gp-title' }, h('b', { text: first }), rest.length ? h('span', { class: 'gp-x', text: ` ${rest.join(' ')}` }) : null),
      );
      const b = button(inner, `game-pick-${g.id}`, () => {
        if (!leader || g.id === active) return;
        this.gameLocal = g.id;
        this.gameLocalAt = performance.now();
        net.send({ t: 'game', game: g.id });
        this.update(this.lastView);
      }, `gp-card${g.id === active ? ' sel' : ''}`);
      b.style.setProperty('--gc', g.color || gameInfo(g.id).color);
      b.disabled = !leader;
      b.setAttribute('aria-pressed', String(g.id === active));
      this.gamePick.append(b);
    }
    if (!leader) this.gamePick.append(h('span', { class: 'gp-note', text: 'leader picks' }));
  }

  private renderPlayers(players: LobbyPlayer[]): void {
    this.plist.textContent = '';
    if (!players.length) {
      this.plist.append(h('div', { class: 'pempty', text: 'Waiting for racers…' }));
      return;
    }
    for (const p of [...players].sort((a, b) => a.slot - b.slot)) {
      const me = p.playerId === state.playerId;
      const col = SLOT_COLORS[p.slot] ?? '#888';
      const row = h(
        'div',
        {
          class: `prow${me ? ' me' : ''}${p.connected ? '' : ' off'}`,
          style: `--pc:${col}`,
          testid: `player-${p.playerId}`,
        },
        h('span', { class: 'pslot', text: String(p.slot + 1) }),
        avatarSvg(charById(p.characterId), 30),
        h(
          'span',
          { class: 'pname' },
          p.isLeader ? h('span', { class: 'crown', text: '👑', title: 'Party leader' }) : null,
          p.name,
          me ? h('em', { text: ' (you)' }) : null,
        ),
        h('span', {
          class: `pready${p.ready ? ' yes' : ''}`,
          text: !p.connected ? '📵' : p.ready ? '✓' : '…',
        }),
      );
      this.plist.append(row);
    }
  }

  private renderTransfer(players: LobbyPlayer[]): void {
    const others = players.filter((p) => p.playerId !== state.playerId && p.connected);
    const key = others.map((p) => p.playerId + p.name).join('|');
    if (key === this.transferKey) return;
    this.transferKey = key;
    this.transferMenu.textContent = '';
    this.transferMenu.append(h('div', { class: 'menu-title', text: 'Make party leader:' }));
    if (!others.length) this.transferMenu.append(h('div', { class: 'menu-empty', text: 'Nobody else here yet' }));
    for (const p of others) {
      this.transferMenu.append(
        button(`👑 ${p.name}`, `leader-${p.playerId}`, () => {
          net.send({ t: 'leader', to: p.playerId });
          show(this.transferMenu, false);
        }, 'menu-item'),
      );
    }
  }
}
