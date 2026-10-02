/** Race setup: the leader picks mode / track / cc / laps; everyone else watches live. */
import type { EngineCC, RaceMode, RaceSetup } from '../../net/protocol';
import { net } from '../net';
import { state, type ViewId } from '../store';
import { THEME_COLORS, TRACK_DEFS, button, h, setText, show, toggleClass, trackSvg } from '../ui';
import type { View } from './view';

const OPTIMISTIC_MS = 1500;
const CC_INFO: [EngineCC, string][] = [
  [50, 'Chill'],
  [100, 'Fast'],
  [150, 'Wild'],
];

export class SetupView implements View {
  readonly el: HTMLElement;
  private local: Partial<RaceSetup> = {};
  private localAt = 0;
  private modeBtns = new Map<RaceMode, HTMLButtonElement>();
  private ccBtns = new Map<EngineCC, HTMLButtonElement>();
  private trackBtns = new Map<string, HTMLButtonElement>();
  private lapsVal: HTMLElement;
  private lapsMinus: HTMLButtonElement;
  private lapsPlus: HTMLButtonElement;
  private startBtn: HTMLButtonElement;
  private waitMsg: HTMLElement;
  private title: HTMLElement;
  private trackHead: HTMLElement;
  private gpNote: HTMLElement;

  constructor() {
    const modeSeg = h('div', { class: 'seg' });
    for (const [m, label] of [
      ['single', '🏁 Single Race'],
      ['gp', '🏆 Grand Prix'],
    ] as [RaceMode, string][]) {
      const b = button(label, `mode-${m}`, () => this.edit({ mode: m }), 'seg-btn');
      this.modeBtns.set(m, b);
      modeSeg.append(b);
    }
    const ccSeg = h('div', { class: 'seg' });
    for (const [cc, label] of CC_INFO) {
      const b = button('', `cc-${cc}`, () => this.edit({ cc }), 'seg-btn');
      b.innerHTML = `<b>${cc}cc</b><small>${label}</small>`;
      this.ccBtns.set(cc, b);
      ccSeg.append(b);
    }
    this.lapsVal = h('div', { class: 'laps-val', testid: 'laps-value' });
    this.lapsMinus = button('−', 'btn-laps-minus', () => this.edit({ laps: Math.max(1, this.cur().laps - 1) }), 'step-btn');
    this.lapsPlus = button('+', 'btn-laps-plus', () => this.edit({ laps: Math.min(5, this.cur().laps + 1) }), 'step-btn');
    const laps = h('div', { class: 'stepper' }, this.lapsMinus, this.lapsVal, this.lapsPlus);
    this.gpNote = h('div', { class: 'gp-note', text: '4 races · points 15-12-10-8-6-4-2-1' });

    this.startBtn = button('START RACE ▶', 'btn-start-race', () => net.send({ t: 'start' }), 'btn btn-start big-start');
    this.waitMsg = h('div', { class: 'wait-msg', testid: 'setup-wait' });
    this.title = h('h2', { class: 'scr-title', text: 'Race setup' });

    const left = h(
      'section',
      { class: 'setup-opts' },
      this.title,
      h('div', { class: 'opt' }, h('div', { class: 'opt-label', text: 'Mode' }), modeSeg, this.gpNote),
      h('div', { class: 'opt' }, h('div', { class: 'opt-label', text: 'Speed' }), ccSeg),
      h('div', { class: 'opt' }, h('div', { class: 'opt-label', text: 'Laps' }), laps),
      this.startBtn,
      this.waitMsg,
    );

    const tracks = h('div', { class: 'tracks' });
    for (const t of TRACK_DEFS) {
      const [c1, c2] = THEME_COLORS[t.theme] ?? ['#888', '#444'];
      const stars = '★'.repeat(t.difficulty) + '☆'.repeat(Math.max(0, 3 - t.difficulty));
      const b = button(
        h(
          'div',
          { class: 'track-inner' },
          trackSvg(t, '#fff'),
          h('div', { class: 'track-name', text: t.name }),
          h('div', { class: 'track-stars', text: stars, 'aria-label': `difficulty ${t.difficulty} of 3` }),
        ),
        `track-${t.id}`,
        () => this.edit({ trackId: t.id }),
        'track-card',
      );
      b.style.setProperty('--t1', c1);
      b.style.setProperty('--t2', c2);
      this.trackBtns.set(t.id, b);
      tracks.append(b);
    }
    this.trackHead = h('div', { class: 'opt-label', text: 'Track' });
    const right = h('section', { class: 'setup-tracks' }, this.trackHead, tracks);

    this.el = h('div', { class: 'screen setup scrollable', testid: 'screen-setup' }, left, right);
  }

  private cur(): RaceSetup {
    const base: RaceSetup = state.phone?.setup ?? { mode: 'single', trackId: TRACK_DEFS[0].id, cc: 100, laps: 3 };
    if (performance.now() - this.localAt < OPTIMISTIC_MS) return { ...base, ...this.local };
    return base;
  }

  private isLeader(): boolean {
    return !!state.phone?.you?.isLeader;
  }

  private edit(p: Partial<RaceSetup>): void {
    if (!this.isLeader()) return;
    if (performance.now() - this.localAt >= OPTIMISTIC_MS) this.local = {};
    Object.assign(this.local, p);
    this.localAt = performance.now();
    net.send({ t: 'setup', setup: p });
    this.update('setup');
  }

  update(_view: ViewId): void {
    const s = this.cur();
    const leader = this.isLeader();
    toggleClass(this.el, 'readonly', !leader);
    for (const [m, b] of this.modeBtns) {
      toggleClass(b, 'sel', s.mode === m);
      b.disabled = !leader;
    }
    for (const [cc, b] of this.ccBtns) {
      toggleClass(b, 'sel', s.cc === cc);
      b.disabled = !leader;
    }
    for (const [id, b] of this.trackBtns) {
      toggleClass(b, 'sel', s.trackId === id);
      b.disabled = !leader;
    }
    setText(this.lapsVal, String(s.laps));
    this.lapsMinus.disabled = !leader || s.laps <= 1;
    this.lapsPlus.disabled = !leader || s.laps >= 5;
    show(this.gpNote, s.mode === 'gp');
    setText(this.trackHead, s.mode === 'gp' ? 'First track (GP visits all 4)' : 'Track');
    show(this.startBtn, leader);
    const leaderName = state.phone?.players.find((p) => p.isLeader)?.name ?? 'The leader';
    setText(this.waitMsg, leader ? '' : `${leaderName} is picking the track…`);
    show(this.waitMsg, !leader);
    setText(this.title, leader ? 'Pick the race!' : 'Race setup');
  }
}
