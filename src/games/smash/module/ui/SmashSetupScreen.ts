/**
 * SMASH SETUP (host) — big stage-select cards with procedural previews, the rules (mode, stocks /
 * time, teams + friendly fire, CPU fill + level, items + frequency, hazards) and the fighters
 * line-up with portraits (humans + the CPUs the current rules add). The leader edits it on their
 * phone (`gsetup`); the host can click too.
 */
import { SLOT_COLORS, TEAM_COLORS, type SmashSetup } from '../../../../net/protocol';
import type { PartySession } from '../../../../engine/PartySession';
import type { ScreenView, UiContext } from '../../../../party/ui/HostUI';
import { FaceView } from '../../../../party/ui/LobbyScreen';
import { button, h, replay, setText, toggle } from '../../../../party/ui/dom';
import { PICKABLE_STAGES } from '../../stages';
import type { SmashModule } from '../SmashModule';
import { stageColors, stagePreviewMarkup } from './stageArt';

interface Pill {
  el: HTMLElement;
  on(s: SmashSetup): boolean;
}

export class SmashSetupScreen implements ScreenView {
  readonly root: HTMLDivElement;
  private readonly who = h('div', 'kp-setup-who');
  private readonly stageCards = new Map<string, HTMLElement>();
  private readonly pills: Pill[] = [];
  private readonly rows: Record<string, HTMLElement> = {};
  private readonly lineup = h('div', 'sh-lineup');
  private lineupKey = '';
  private shownStage = '';

  constructor(
    private readonly ctx: UiContext,
    private readonly mod: SmashModule,
  ) {
    const s = ctx.session;
    const set = (patch: Partial<SmashSetup>): void => {
      mod.applySetup(patch);
      s.changed();
    };

    const stages = h('div', 'sh-stages');
    for (const st of PICKABLE_STAGES) {
      const [a, b] = stageColors(st);
      const card = h(
        'button',
        { class: 'sh-stage', type: 'button', 'data-tid': `stage-card-${st.id}` },
        h('div', 'sh-stage-art'),
        h('div', 'sh-stage-name', st.name),
        h('div', 'sh-stage-tag', st.tagline),
        h('div', 'sh-stage-check', '✓'),
      );
      card.querySelector('.sh-stage-art')!.innerHTML = stagePreviewMarkup(st);
      card.style.setProperty('--ta', a);
      card.style.setProperty('--tb', b);
      card.addEventListener('click', (e) => {
        e.stopPropagation();
        set({ stageId: st.id });
      });
      this.stageCards.set(st.id, card);
      stages.appendChild(card);
    }

    const pill = (label: string, on: (s: SmashSetup) => boolean, patch: Partial<SmashSetup>, cls = ''): HTMLElement => {
      const el = h('button', { class: `kp-pill ${cls}`.trim(), type: 'button' }, label);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        set(patch);
      });
      this.pills.push({ el, on });
      return el;
    };
    const row = (key: string, label: string, ...pills: HTMLElement[]): HTMLElement => {
      const r = h('div', 'sh-rule', h('div', 'kp-opt-label', label), h('div', 'kp-opt', ...pills));
      this.rows[key] = r;
      return r;
    };

    const rules = h(
      'div',
      'sh-rules',
      row('mode', 'MODE', pill('STOCK', (x) => x.mode === 'stock', { mode: 'stock' }), pill('TIME', (x) => x.mode === 'time', { mode: 'time' })),
      row('stocks', 'STOCKS', ...[1, 2, 3, 4, 5].map((n) => pill(String(n), (x) => x.stocks === n, { stocks: n }, 'kp-pill-sq'))),
      row('time', 'TIME', ...[60, 120, 180, 240, 300].map((t) => pill(`${t / 60}:00`, (x) => x.timeSec === t, { timeSec: t }))),
      row(
        'teams',
        'TEAMS',
        pill('FFA', (x) => !x.teams, { teams: false }),
        pill('2 TEAMS', (x) => x.teams, { teams: true }),
        pill('TEAM HITS', (x) => x.friendlyFire, {}, 'sh-ff'),
      ),
      row('cpus', 'CPU FILL', ...[0, 2, 3, 4].map((n) => pill(n === 0 ? 'OFF' : `TO ${n}`, (x) => x.fillCpus === n || (n === 0 && x.fillCpus === 1), { fillCpus: n }))),
      row('level', 'CPU LV', ...[1, 3, 5, 7, 9].map((n) => pill(`${n}`, (x) => x.cpuLevel === n, { cpuLevel: n }, 'kp-pill-sq'))),
      row(
        'items',
        'ITEMS',
        pill('OFF', (x) => !x.items, { items: false }),
        pill('LOW', (x) => x.items && x.itemFrequency === 'low', { items: true, itemFrequency: 'low' }),
        pill('MEDIUM', (x) => x.items && x.itemFrequency === 'medium', { items: true, itemFrequency: 'medium' }),
        pill('HIGH', (x) => x.items && x.itemFrequency === 'high', { items: true, itemFrequency: 'high' }),
      ),
      row('hazards', 'HAZARDS', pill('ON', (x) => x.hazards, { hazards: true }), pill('OFF', (x) => !x.hazards, { hazards: false })),
    );
    // Friendly fire toggles relative to the current value.
    const ff = this.pills.find((p) => p.el.classList.contains('sh-ff'))!;
    ff.el.replaceWith((ff.el = ff.el.cloneNode(true) as HTMLElement));
    ff.el.addEventListener('click', (e) => {
      e.stopPropagation();
      set({ friendlyFire: !mod.setup.friendlyFire });
    });

    const actions = h(
      'div',
      'kp-host-actions',
      button('▶ Start match', 'kp-primary', () => s.hostStart(), 'btn-start-race'),
      button('Back to lobby', '', () => s.hostBackToLobby(), 'btn-back-lobby'),
    );

    this.root = h(
      'div',
      { class: 'kp-setup sh-setup', 'data-tid': 'screen-setup' },
      h('div', 'kp-scrim'),
      h(
        'div',
        { class: 'kp-setup-inner', 'data-tid': 'smash-setup' },
        h('div', 'kp-header', h('div', 'kp-h1', 'SMASH SETUP'), this.who),
        h('div', 'sh-setup-main', h('div', 'sh-setup-left', h('div', 'kp-opt-label', 'STAGE'), stages, h('div', 'kp-opt-label', 'FIGHTERS'), this.lineup), rules),
        actions,
      ),
    );
  }

  update(s: PartySession): void {
    const st = this.mod.setup;
    const leader = s.leader;
    setText(this.who, leader ? `${leader.name} is choosing on their phone` : 'The leader is choosing on their phone');
    if (leader) this.who.style.setProperty('--slot', SLOT_COLORS[leader.slot]);
    for (const [id, card] of this.stageCards) toggle(card, 'kp-selected', id === st.stageId);
    if (st.stageId !== this.shownStage) {
      this.shownStage = st.stageId;
      const c = this.stageCards.get(st.stageId);
      if (c) replay(c, 'kp-pop-in');
    }
    for (const p of this.pills) toggle(p.el, 'kp-on', p.on(st));
    toggle(this.rows.stocks, 'kp-hidden', st.mode !== 'stock');
    toggle(this.rows.time, 'kp-hidden', st.mode !== 'time');
    toggle(this.rows.level, 'sh-dim', st.fillCpus < 2);
    const ff = this.pills.find((p) => p.el.classList.contains('sh-ff'));
    if (ff) toggle(ff.el, 'kp-hidden', !st.teams);

    // Fighters line-up (what START would produce right now).
    const seats = s.matchSeats();
    const cfg = this.mod.preview(seats);
    const looks = [...cfg.humans.map((x) => ({ ...x, cpu: false, level: 0 })), ...cfg.cpus.map((x) => ({ ...x, cpu: true, slot: -1, playerId: '' }))];
    const key =
      looks.map((f) => `${f.characterId}:${f.name}:${f.team}:${f.cpu}:${f.level}`).join('|') +
      `|${st.teams}|` +
      looks.map((f) => (this.mod.portrait(f.characterId) ? 1 : 0)).join('');
    if (key !== this.lineupKey) {
      this.lineupKey = key;
      this.lineup.replaceChildren(
        ...looks.map((f) => {
          const face = new FaceView('sh-lineup-avatar');
          face.set(f.characterId, f.cpu ? null : f.color, f.cpu ? 'C' : String(f.slot + 1), this.mod.look(f.characterId));
          const col = st.teams ? TEAM_COLORS[f.team === 1 ? 1 : 0] : f.color;
          const el = h(
            'div',
            `sh-lineup-item ${f.cpu ? 'sh-cpu' : ''}`,
            face.root,
            h('div', 'sh-lineup-name', f.name),
            h('div', 'sh-lineup-sub', f.cpu ? `CPU · LV ${f.level}` : st.teams ? (f.team === 1 ? 'BLUE TEAM' : 'RED TEAM') : `P${f.slot + 1}`),
          );
          el.style.setProperty('--slot', col);
          return el;
        }),
      );
      if (!looks.length) this.lineup.replaceChildren(h('div', 'sh-lineup-empty', 'Ready up on your phones to fight!'));
    }
  }
}
