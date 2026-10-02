/**
 * Smash Party setup: the leader picks stage / rules / teams / CPUs / items / hazards
 * (`gsetup`) and STARTs; everyone else sees a live summary. In team mode every player
 * picks a side (`team`).
 */
import { TEAM_COLORS, type LobbyPlayer, type SmashSetup } from '../../net/protocol';
import { PICKABLE_STAGES, getStage } from '../../games/smash/stages';
import type { StageDef } from '../../games/smash/types';
import { smashSetup } from '../games';
import { haptic } from '../haptics';
import { net } from '../net';
import { state, type ViewId } from '../store';
import { button, h, setHtml, setText, show, toggleClass } from '../ui';
import type { View } from './view';

const OPTIMISTIC_MS = 1500;

const THEME_BG: Record<string, [string, string, string]> = {
  sky: ['#8fdcff', '#3c7fd8', '#e9f7ff'],
  arena: ['#5b2bd6', '#1a0f45', '#ff4fd8'],
  forge: ['#5a1a10', '#1c0806', '#ff7a2a'],
  training: ['#2c3550', '#141a2b', '#7fe0ff'],
};

/** Procedural stage thumbnail drawn from the stage's platform data. */
export function stagePreview(st: StageDef): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '-13 -8.5 26 13');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
  svg.setAttribute('class', 'stage-prev');
  svg.setAttribute('aria-hidden', 'true');
  const [c1, c2, c3] = THEME_BG[st.theme] ?? THEME_BG.sky;
  const gid = `sg-${st.id}`;
  let body = `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>`;
  body += `<rect x="-13" y="-8.5" width="26" height="13" fill="url(#${gid})"/>`;
  if (st.theme === 'sky') {
    body += `<g fill="#fff" opacity=".55"><ellipse cx="-8" cy="-5.5" rx="3" ry=".9"/><ellipse cx="7" cy="-6.6" rx="3.6" ry="1"/><ellipse cx="9" cy="3" rx="4" ry="1"/></g>`;
  } else if (st.theme === 'arena') {
    body += `<g stroke="${c3}" stroke-width=".18" opacity=".5"><path d="M-13 3.5 L13 3.5"/><path d="M-13 -7 L13 -7"/></g><circle cx="0" cy="-5" r="2.2" fill="${c3}" opacity=".25"/>`;
  } else if (st.theme === 'forge') {
    body += `<rect x="-13" y="2.2" width="26" height="2.5" fill="${c3}"/><rect x="-13" y="2.2" width="26" height=".5" fill="#ffd36a"/>`;
  }
  for (const p of st.platforms) {
    const x = p.x - p.w / 2;
    const y = -p.y;
    if (p.solid) {
      const hh = Math.min(p.h, 3.2);
      body += `<path d="M${x} ${y} h${p.w} l-1.4 ${hh} h${-(p.w - 2.8)} Z" fill="rgba(10,8,30,.85)"/>`;
      body += `<rect x="${x}" y="${y - 0.08}" width="${p.w}" height=".5" rx=".2" fill="${c3}"/>`;
    } else {
      body += `<rect x="${x}" y="${y - 0.1}" width="${p.w}" height=".38" rx=".18" fill="rgba(255,255,255,.92)"/>`;
      if (p.path) {
        const ax = x + p.w / 2;
        const ay = y + 0.9;
        body += `<path d="M${ax} ${ay} l${p.path.dx * 0.6} ${-p.path.dy * 0.6}" stroke="#fff" stroke-width=".18" stroke-dasharray=".4 .3" opacity=".8"/>`;
      }
    }
  }
  svg.innerHTML = body;
  return svg;
}

function tgl(testid: string, onTap: () => void): HTMLButtonElement {
  const b = h('button', { class: 'tgl', testid, type: 'button', role: 'switch' }, h('i'));
  b.addEventListener('click', () => {
    if (b.disabled) return;
    haptic('tick');
    onTap();
  });
  return b;
}

function setTgl(b: HTMLButtonElement, on: boolean, enabled: boolean): void {
  toggleClass(b, 'on', on);
  b.setAttribute('aria-checked', String(on));
  b.disabled = !enabled;
}

export class SmashSetupView implements View {
  readonly el: HTMLElement;
  private local: Partial<SmashSetup> = {};
  private localAt = 0;
  private teamLocal: number | null = null;
  private teamAt = 0;
  private title: HTMLElement;
  private stageBtns = new Map<string, HTMLButtonElement>();
  private modeBtns = new Map<string, HTMLButtonElement>();
  private countVal: HTMLElement;
  private countMinus: HTMLButtonElement;
  private countPlus: HTMLButtonElement;
  private countLabel: HTMLElement;
  private teamsTgl: HTMLButtonElement;
  private ffTgl: HTMLButtonElement;
  private ffWrap: HTMLElement;
  private cpuBtns = new Map<number, HTMLButtonElement>();
  private lvlVal: HTMLElement;
  private lvlMinus: HTMLButtonElement;
  private lvlPlus: HTMLButtonElement;
  private lvlWrap: HTMLElement;
  private itemsTgl: HTMLButtonElement;
  private freqBtns = new Map<string, HTMLButtonElement>();
  private freqSeg: HTMLElement;
  private hazTgl: HTMLButtonElement;
  private hazNote: HTMLElement;
  private opts: HTMLElement;
  private summary: HTMLElement;
  private bigStage: HTMLElement;
  private bigStageKey = '';
  private teamBox: HTMLElement;
  private teamBtns: HTMLButtonElement[] = [];
  private teamLists: HTMLElement[] = [];
  private startBtn: HTMLButtonElement;
  private waitMsg: HTMLElement;
  private stagesBox: HTMLElement;

  constructor() {
    this.title = h('h2', { class: 'scr-title', text: 'Pick the fight!' });

    // Stages
    this.stagesBox = h('div', { class: 'ss-stages' });
    for (const st of PICKABLE_STAGES) {
      const b = button(
        h(
          'span',
          { class: 'stage-inner' },
          stagePreview(st),
          h('span', { class: 'stage-text' }, h('b', { text: st.name }), h('small', { text: st.tagline })),
        ),
        `stage-pick-${st.id}`,
        () => this.edit({ stageId: st.id }),
        'stage-card',
      );
      this.stageBtns.set(st.id, b);
      this.stagesBox.append(b);
    }
    this.startBtn = button('START ▶', 'btn-start-match', () => net.send({ t: 'start' }), 'btn btn-start big-start');
    this.waitMsg = h('div', { class: 'wait-msg', testid: 'setup-wait' });

    // Rules row
    const modeSeg = h('div', { class: 'seg' });
    for (const [m, label] of [
      ['stock', 'Stock'],
      ['time', 'Time'],
    ] as const) {
      const b = button(label, `smash-mode-${m}`, () => this.edit({ mode: m }), 'seg-btn');
      this.modeBtns.set(m, b);
      modeSeg.append(b);
    }
    this.countVal = h('div', { class: 'mini-val', testid: 'rule-count' });
    this.countLabel = h('small', { class: 'mini-unit' });
    this.countMinus = button('−', 'btn-rule-minus', () => this.bump(-1), 'step-btn mini');
    this.countPlus = button('+', 'btn-rule-plus', () => this.bump(1), 'step-btn mini');
    const rules = this.row('Rules', modeSeg, h('div', { class: 'stepper mini' }, this.countMinus, h('div', { class: 'mini-box' }, this.countVal, this.countLabel), this.countPlus));

    // Teams row
    this.teamsTgl = tgl('tgl-teams', () => this.edit({ teams: !this.cur().teams }));
    this.ffTgl = tgl('tgl-ff', () => this.edit({ friendlyFire: !this.cur().friendlyFire }));
    this.ffWrap = h('label', { class: 'ss-sub' }, h('span', { text: 'Friendly fire' }), this.ffTgl);
    const teams = this.row('Teams', this.teamsTgl, this.ffWrap);

    // CPU row
    const cpuSeg = h('div', { class: 'seg cpu-seg' });
    for (const n of [0, 2, 3, 4]) {
      const b = button('', `cpu-fill-${n}`, () => this.edit({ fillCpus: n }), 'seg-btn');
      this.cpuBtns.set(n, b);
      cpuSeg.append(b);
    }
    this.lvlVal = h('div', { class: 'mini-val', testid: 'cpu-level' });
    this.lvlMinus = button('−', 'btn-cpulvl-minus', () => this.edit({ cpuLevel: Math.max(1, this.cur().cpuLevel - 1) }), 'step-btn mini');
    this.lvlPlus = button('+', 'btn-cpulvl-plus', () => this.edit({ cpuLevel: Math.min(9, this.cur().cpuLevel + 1) }), 'step-btn mini');
    this.lvlWrap = h('div', { class: 'stepper mini' }, this.lvlMinus, h('div', { class: 'mini-box' }, this.lvlVal, h('small', { class: 'mini-unit', text: 'LEVEL' })), this.lvlPlus);
    const cpus = this.row('CPUs', cpuSeg, this.lvlWrap);

    // Items row
    this.itemsTgl = tgl('tgl-items', () => this.edit({ items: !this.cur().items }));
    this.freqSeg = h('div', { class: 'seg' });
    for (const [f, label] of [
      ['low', 'Few'],
      ['medium', 'Some'],
      ['high', 'Lots'],
    ] as const) {
      const b = button(label, `item-freq-${f}`, () => this.edit({ itemFrequency: f }), 'seg-btn');
      this.freqBtns.set(f, b);
      this.freqSeg.append(b);
    }
    const items = this.row('Items', this.itemsTgl, this.freqSeg);

    // Hazards row
    this.hazTgl = tgl('tgl-hazards', () => this.edit({ hazards: !this.cur().hazards }));
    this.hazNote = h('small', { class: 'ss-note' });
    const haz = this.row('Hazards', this.hazTgl, this.hazNote);

    this.opts = h('div', { class: 'ss-opts' }, rules, teams, cpus, items, haz);

    // Non-leader summary
    this.bigStage = h('div', { class: 'ss-bigstage' });
    this.summary = h('div', { class: 'ss-summary', testid: 'smash-summary' });

    // Team picker (everyone, team mode)
    this.teamBox = h('div', { class: 'ss-teams', testid: 'team-picker' });
    for (const t of [0, 1]) {
      const list = h('span', { class: 'team-list' });
      const b = button(
        h('span', { class: 'team-inner' }, h('b', { text: t === 0 ? 'RED TEAM' : 'BLUE TEAM' }), list),
        `team-pick-${t}`,
        () => this.pickTeam(t),
        'team-btn',
      );
      b.style.setProperty('--tc', TEAM_COLORS[t]);
      this.teamBtns.push(b);
      this.teamLists.push(list);
      this.teamBox.append(b);
    }

    const left = h('section', { class: 'ss-left' }, this.title, this.stagesBox, this.bigStage, this.startBtn);
    const right = h('section', { class: 'ss-right' }, this.opts, this.summary, this.teamBox, this.waitMsg);
    this.el = h(
      'div',
      { class: 'screen setup ssetup scrollable', testid: 'screen-setup' },
      h('div', { class: 'ss-grid', testid: 'smash-setup' }, left, right),
    );
  }

  private row(label: string, ...ctl: HTMLElement[]): HTMLElement {
    return h('div', { class: 'ss-row' }, h('div', { class: 'ss-label', text: label }), h('div', { class: 'ss-ctl' }, ...ctl));
  }

  private cur(): SmashSetup {
    const base = smashSetup();
    if (performance.now() - this.localAt < OPTIMISTIC_MS) return { ...base, ...this.local };
    return base;
  }

  private isLeader(): boolean {
    return !!state.phone?.you?.isLeader;
  }

  private edit(p: Partial<SmashSetup>): void {
    if (!this.isLeader()) return;
    if (performance.now() - this.localAt >= OPTIMISTIC_MS) this.local = {};
    Object.assign(this.local, p);
    this.localAt = performance.now();
    net.send({ t: 'gsetup', setup: p as Record<string, unknown> });
    this.update('setup');
  }

  private bump(d: number): void {
    const s = this.cur();
    if (s.mode === 'stock') this.edit({ stocks: Math.max(1, Math.min(5, s.stocks + d)) });
    else this.edit({ timeSec: Math.max(60, Math.min(300, Math.round(s.timeSec / 60 + d) * 60)) });
  }

  private pickTeam(t: number): void {
    this.teamLocal = t;
    this.teamAt = performance.now();
    net.send({ t: 'team', team: t });
    this.update('setup');
  }

  private myTeam(): number {
    if (this.teamLocal !== null && performance.now() - this.teamAt < OPTIMISTIC_MS) return this.teamLocal;
    return state.phone?.you?.team ?? 0;
  }

  update(_view: ViewId): void {
    const s = this.cur();
    const leader = this.isLeader();
    const ps = state.phone;
    const players: LobbyPlayer[] = (ps?.players ?? []).filter((p) => p.connected);
    toggleClass(this.el, 'readonly', !leader);
    setText(this.title, leader ? 'Pick the fight!' : 'Next fight');

    for (const [id, b] of this.stageBtns) toggleClass(b, 'sel', s.stageId === id);
    show(this.stagesBox, leader);
    show(this.opts, leader);
    show(this.summary, !leader);
    show(this.bigStage, !leader);
    show(this.startBtn, leader);

    for (const [m, b] of this.modeBtns) toggleClass(b, 'sel', s.mode === m);
    if (s.mode === 'stock') {
      setText(this.countVal, String(s.stocks));
      setText(this.countLabel, s.stocks === 1 ? 'LIFE' : 'LIVES');
      this.countMinus.disabled = s.stocks <= 1;
      this.countPlus.disabled = s.stocks >= 5;
    } else {
      const min = Math.round(s.timeSec / 60);
      setText(this.countVal, String(min));
      setText(this.countLabel, 'MIN');
      this.countMinus.disabled = min <= 1;
      this.countPlus.disabled = min >= 5;
    }
    setTgl(this.teamsTgl, s.teams, true);
    setTgl(this.ffTgl, s.friendlyFire, s.teams);
    toggleClass(this.ffWrap, 'off', !s.teams);
    const humans = Math.max(1, players.length);
    for (const [n, b] of this.cpuBtns) {
      toggleClass(b, 'sel', s.fillCpus === n);
      const add = n === 0 ? 0 : Math.max(0, n - humans);
      setHtml(b, n === 0 ? '<b>Off</b><small>no CPUs</small>' : `<b>${n}</b><small>${add ? `+${add} CPU` : 'full'}</small>`);
    }
    setText(this.lvlVal, String(s.cpuLevel));
    this.lvlMinus.disabled = s.cpuLevel <= 1 || s.fillCpus === 0;
    this.lvlPlus.disabled = s.cpuLevel >= 9 || s.fillCpus === 0;
    toggleClass(this.lvlWrap, 'off', s.fillCpus === 0);
    setTgl(this.itemsTgl, s.items, true);
    for (const [f, b] of this.freqBtns) {
      toggleClass(b, 'sel', s.itemFrequency === f);
      b.disabled = !s.items;
    }
    toggleClass(this.freqSeg, 'off', !s.items);
    setTgl(this.hazTgl, s.hazards, true);
    const st = getStage(s.stageId);
    setText(this.hazNote, st.hazard || st.platforms.some((p) => p.path) ? (s.hazards ? 'Lava + moving platforms ON' : 'Calm stage') : 'Only on Magma Forge');

    // Summary (non-leaders)
    if (!leader) {
      const key = st.id;
      if (key !== this.bigStageKey) {
        this.bigStageKey = key;
        this.bigStage.textContent = '';
        this.bigStage.append(stagePreview(st), h('div', { class: 'stage-text' }, h('b', { text: st.name }), h('small', { text: st.tagline })));
      }
      const chips: string[] = [];
      chips.push(s.mode === 'stock' ? `❤️ ${s.stocks} ${s.stocks === 1 ? 'life' : 'lives'}` : `⏱ ${Math.round(s.timeSec / 60)} min`);
      chips.push(s.teams ? `👥 Teams${s.friendlyFire ? ' · friendly fire' : ''}` : '⚔️ Free-for-all');
      chips.push(s.fillCpus ? `🤖 CPUs to ${s.fillCpus} · Lv ${s.cpuLevel}` : '🤖 No CPUs');
      chips.push(s.items ? `🎁 Items: ${s.itemFrequency === 'low' ? 'few' : s.itemFrequency === 'high' ? 'lots' : 'some'}` : '🎁 No items');
      if (st.hazard || st.platforms.some((p) => p.path)) chips.push(s.hazards ? '🌋 Hazards on' : '🌋 Hazards off');
      setHtml(this.summary, chips.map((c) => `<span class="sum-chip">${c}</span>`).join(''));
    }

    // Teams
    show(this.teamBox, s.teams);
    if (s.teams) {
      const mine = this.myTeam();
      this.teamBtns.forEach((b, t) => toggleClass(b, 'sel', mine === t));
      const youId = ps?.you?.playerId;
      this.teamLists.forEach((el, t) => {
        const names = players
          .filter((p) => (p.playerId === youId ? mine : p.team ?? 0) === t)
          .map((p) => (p.playerId === youId ? 'You' : p.name));
        setText(el, names.length ? names.join(' · ') : 'empty');
      });
    }

    const leaderName = ps?.players.find((p) => p.isLeader)?.name ?? 'The leader';
    setText(this.waitMsg, leader ? '' : `${leaderName} is setting up the fight…`);
    show(this.waitMsg, !leader);
  }
}
