/**
 * THE CONTROLLER (landscape): steering zone on one half, GAS / DRIFT / ITEM /
 * BRAKE on the other, race HUD strip on top. Also hosts the tutorial overlay
 * (controls stay live during the tutorial so "try it" works).
 */
import { ITEM_INFO, itemInfo } from '../../net/items';
import type { PhoneFx } from '../../net/protocol';
import { controls, type ButtonId } from '../controls';
import { haptic } from '../haptics';
import { net } from '../net';
import { settings } from '../settings';
import { state, type ViewId } from '../store';
import { tilt } from '../tilt';
import { button, h, ordSuffix, setHtml, setText, show, toggleClass } from '../ui';
import type { View } from './view';

const ROULETTE_ICONS = Object.keys(ITEM_INFO)
  .filter((k) => k !== 'none' && !k.startsWith('triple'))
  .map((k) => ITEM_INFO[k]);

const DRIFT_COLORS = ['#7d7aa8', '#3fa9ff', '#ff9a1f', '#c04dff'];

interface TutStep {
  target: 'steer' | ButtonId | 'pause';
  title: string;
  text: string;
  sub?: string;
}

export const TUTORIAL_STEPS: TutStep[] = [
  {
    target: 'steer',
    title: 'Steer',
    text: 'Drag left/right on the left half',
    sub: 'Optional: turn on tilt steering in ⚙️ settings',
  },
  { target: 'gas', title: 'Gas', text: 'Auto-accelerate is ON', sub: 'Turn it off in ⚙️ if you’d rather hold GAS yourself' },
  {
    target: 'drift',
    title: 'Drift',
    text: 'Hold DRIFT through corners — sparks go blue→orange→purple — release for a boost!',
  },
  { target: 'item', title: 'Items', text: 'Tap ITEM to use what you picked up', sub: 'Hold BRAKE while tapping to throw it backwards' },
  { target: 'brake', title: 'Brake', text: 'Brake / reverse', sub: 'Hold it to slow down — keep holding to back up' },
  { target: 'pause', title: 'Pause', text: 'Pause any time', sub: 'Tap ⏸ at the top of the screen' },
];

function ctlButton(cls: string, testid: string, inner: string): HTMLElement {
  const el = h('div', { class: `cb ${cls}`, testid, role: 'button' });
  el.innerHTML = inner;
  return el;
}

export class ControllerView implements View {
  readonly el: HTMLElement;
  private zone: HTMLElement;
  private btnZone: HTMLElement;
  private knob: HTMLElement;
  private base: HTMLElement;
  private hint: HTMLElement;
  private arrowL: HTMLElement;
  private arrowR: HTMLElement;
  private steerBar: HTMLElement;
  private tiltInd: HTMLElement;
  private btn: Record<ButtonId, HTMLElement>;
  private itemIcon: HTMLElement;
  private itemCount: HTMLElement;
  private itemLabel: HTMLElement;
  private gasSub: HTMLElement;
  private place: HTMLElement;
  private lap: HTMLElement;
  private meter: HTMLElement;
  private meterSegs: HTMLElement[] = [];
  private pauseBtn: HTMLButtonElement;
  private countdown: HTMLElement;
  private finished: HTMLElement;
  private fxFlash: HTMLElement;
  private fxText: HTMLElement;
  private aiChip: HTMLElement;
  // tutorial
  private tut: HTMLElement;
  private tutDots: HTMLElement;
  private tutTitle: HTMLElement;
  private tutText: HTMLElement;
  private tutSub: HTMLElement;
  private gotIt: HTMLButtonElement;
  private skip: HTMLButtonElement;
  private tutDone: HTMLElement;
  private tutAcked = false;
  private tutStep = -1;

  private view: ViewId = 'race';
  private rouletteTimer = 0;
  private rouletteIdx = 0;
  private lastRoulette = false;
  private lastItem = 'none';
  private lastCountdown = 0;
  private goUntil = 0;
  private rocketTimer = 0;
  private fxTimer = 0;

  constructor() {
    // ----- top strip -----
    this.place = h('div', { class: 'hud-place', testid: 'hud-place' });
    this.lap = h('div', { class: 'hud-lap', testid: 'hud-lap' });
    this.meter = h('div', { class: 'drift-meter', testid: 'drift-meter' });
    for (let i = 0; i < 3; i++) {
      const seg = h('i', { style: `--dc:${DRIFT_COLORS[i + 1]}` });
      this.meterSegs.push(seg);
      this.meter.append(seg);
    }
    this.aiChip = h('div', { class: 'ai-chip', text: '🤖 AUTOPILOT' });
    this.pauseBtn = button(h('span', { class: 'pause-glyph' }), 'btn-pause', () => net.send({ t: 'pause' }), 'top-btn pause-btn');
    this.pauseBtn.setAttribute('data-click', '');
    this.pauseBtn.setAttribute('aria-label', 'Pause');
    const top = h(
      'div',
      { class: 'ctl-top' },
      this.place,
      this.lap,
      h('div', { class: 'meter-wrap' }, h('span', { class: 'meter-label', text: 'DRIFT' }), this.meter),
      this.aiChip,
      h('div', { class: 'spacer' }),
      this.pauseBtn,
    );

    // ----- steering zone -----
    this.hint = h('div', { class: 'steer-hint' }, h('b', { text: '◀  STEER  ▶' }), h('small', { text: 'drag anywhere on this side' }));
    this.base = h('div', { class: 'steer-base' });
    this.knob = h('div', { class: 'steer-knob' });
    this.arrowL = h('div', { class: 'steer-arrow l', text: '◀' });
    this.arrowR = h('div', { class: 'steer-arrow r', text: '▶' });
    this.steerBar = h('div', { class: 'steer-bar' }, h('i'));
    this.tiltInd = h('div', { class: 'tilt-ind', testid: 'tilt-indicator' }, h('span', { class: 'wheel', text: '☸' }), h('small', { text: 'TILT' }));
    this.zone = h(
      'div',
      { class: 'steer-zone', testid: 'steer-zone' },
      this.arrowL,
      this.arrowR,
      this.hint,
      this.base,
      this.knob,
      this.steerBar,
      this.tiltInd,
    );

    // ----- buttons -----
    this.btn = {
      drift: ctlButton('drift', 'btn-drift', '<span class="cb-label">DRIFT</span><small>hold · hop</small><span class="spark"></span>'),
      item: ctlButton('item', 'btn-item', ''),
      gas: ctlButton('gas', 'btn-gas', '<span class="cb-label">GAS</span><small class="gas-sub"></small>'),
      brake: ctlButton('brake', 'btn-brake', '<span class="cb-label">BRAKE</span><small>reverse</small>'),
    };
    this.itemIcon = h('span', { class: 'item-icon', testid: 'item-icon' });
    this.itemCount = h('span', { class: 'item-count', testid: 'item-count' });
    this.itemLabel = h('span', { class: 'item-label', testid: 'item-label' });
    this.btn.item.append(h('span', { class: 'item-disc' }, this.itemIcon), this.itemCount, this.itemLabel);
    this.gasSub = this.btn.gas.querySelector('.gas-sub') as HTMLElement;
    this.btnZone = h('div', { class: 'btn-zone' }, this.btn.brake, this.btn.gas, this.btn.item, this.btn.drift);

    for (const id of Object.keys(this.btn) as ButtonId[]) controls.bindButton(this.btn[id], id);
    controls.bindSteerZone(this.zone);
    controls.onButton = (id, down) => toggleClass(this.btn[id], 'down', down);
    controls.onFrame = () => this.frame();

    // ----- overlays -----
    this.countdown = h('div', { class: 'countdown', testid: 'countdown' });
    this.finished = h('div', { class: 'finished-ov', testid: 'finished-overlay' });
    this.fxFlash = h('div', { class: 'fx-flash' });
    this.fxText = h('div', { class: 'fx-text', testid: 'fx-text' });

    // ----- tutorial card -----
    this.tutDots = h('div', { class: 'tut-dots' });
    this.tutTitle = h('div', { class: 'tut-title' });
    this.tutText = h('div', { class: 'tut-text', testid: 'tutorial-caption' });
    this.tutSub = h('div', { class: 'tut-sub' });
    this.gotIt = button('Got it! 👍', 'btn-gotit', () => {
      this.tutAcked = true;
      net.send({ t: 'tut_ok' });
      this.update(this.view);
    }, 'btn btn-gotit');
    this.skip = button('Skip ⏭', 'btn-skip', () => net.send({ t: 'tut_skip' }), 'btn btn-skip');
    this.tutDone = h('div', { class: 'tut-done', testid: 'tutorial-waiting' });
    for (const b of [this.gotIt, this.skip]) b.setAttribute('data-click', '');
    this.tut = h(
      'div',
      { class: 'tut-card', testid: 'tutorial-card', 'data-click': '' },
      h('div', { class: 'tut-head' }, h('span', { class: 'tut-badge', text: 'HOW TO PLAY' }), this.tutDots),
      this.tutTitle,
      this.tutText,
      this.tutSub,
      h('div', { class: 'tut-actions' }, this.gotIt, this.tutDone, this.skip),
    );

    const main = h('div', { class: 'ctl-main' }, this.zone, this.btnZone);
    this.el = h(
      'div',
      { class: 'ctl', testid: 'screen-race' },
      top,
      main,
      this.fxFlash,
      this.fxText,
      this.countdown,
      this.finished,
      this.tut,
    );

    // iOS: stop scroll / zoom / callout / text-selection loupe from any touch on the pad.
    const block = (e: TouchEvent) => {
      const t = e.target as Element | null;
      if (t && t.closest && t.closest('[data-click]')) return;
      if (e.cancelable) e.preventDefault();
    };
    this.el.addEventListener('touchstart', block, { passive: false });
    this.el.addEventListener('touchmove', block, { passive: false });
    this.el.addEventListener('touchend', block, { passive: false });

    window.addEventListener('resize', () => this.layout());
    window.addEventListener('orientationchange', () => setTimeout(() => this.layout(), 250));
  }

  enter(view: ViewId): void {
    this.view = view;
    if (view === 'race') {
      // Hold auto-gas during the countdown until the rocket-start window (see onRace).
      controls.autoGate = !(state.race && state.race.countdown > 0);
    } else {
      controls.autoGate = true;
    }
    this.lastCountdown = state.race?.countdown ?? 0;
    requestAnimationFrame(() => this.layout());
  }

  leave(): void {
    clearTimeout(this.rocketTimer);
    this.stopRoulette();
    controls.releaseAll();
    this.tutStep = -1;
  }

  /** Thumb-friendly button placement, computed from the zone size. */
  layout(): void {
    const W = this.btnZone.clientWidth;
    const H = this.btnZone.clientHeight;
    if (W < 50 || H < 50) return;
    const lefty = settings.leftHanded;
    const pad = 10;
    const gap = 10;
    let scale = 1;
    let pos: Record<ButtonId, { x: number; y: number; d: number }> | null = null;
    for (let iter = 0; iter < 12; iter++) {
      const D = Math.max(96, Math.min(H * 0.52, W * 0.43, 200)) * scale;
      const I = D * 0.84;
      const G = D * 0.64;
      const B = Math.max(64, D * 0.48);
      const drift = { x: W - pad - D / 2, y: H - pad - D / 2, d: D };
      const gas = { x: drift.x - D / 2 - gap - G / 2, y: H - pad - G / 2, d: G };
      const aI = (122 * Math.PI) / 180;
      const LI = D / 2 + I / 2 + gap;
      const item = { x: drift.x + Math.cos(aI) * LI, y: drift.y - Math.sin(aI) * LI, d: I };
      const aB = (200 * Math.PI) / 180;
      const LB = I / 2 + B / 2 + gap;
      const brake = { x: item.x + Math.cos(aB) * LB, y: item.y - Math.sin(aB) * LB, d: B };
      const all = [drift, gas, item, brake];
      const inside = all.every((c) => c.x - c.d / 2 >= pad - 1 && c.y - c.d / 2 >= pad - 1 && c.y + c.d / 2 <= H);
      const apart = (a: typeof drift, b: typeof drift) => Math.hypot(a.x - b.x, a.y - b.y) >= a.d / 2 + b.d / 2 + 4;
      const ok = inside && apart(gas, brake) && apart(gas, item) && apart(brake, drift);
      pos = { drift, gas, item, brake };
      if (ok) break;
      scale *= 0.93;
    }
    if (!pos) return;
    for (const id of Object.keys(pos) as ButtonId[]) {
      const p = pos[id];
      const x = lefty ? W - p.x : p.x;
      const s = this.btn[id].style;
      s.width = s.height = `${Math.round(p.d)}px`;
      s.left = `${Math.round(x - p.d / 2)}px`;
      s.top = `${Math.round(p.y - p.d / 2)}px`;
      s.fontSize = `${Math.round(Math.max(13, p.d * 0.15))}px`;
    }
  }

  update(view: ViewId): void {
    if (view === 'race' || view === 'tutorial') {
      if (this.view !== view) this.enter(view);
      this.view = view;
    }
    this.el.setAttribute('data-testid', `screen-${this.view}`);
    const tut = this.view === 'tutorial';
    toggleClass(this.el, 'tut', tut);
    toggleClass(this.el, 'lefty', settings.leftHanded);
    toggleClass(this.el, 'auto', settings.autoAccelerate);
    setText(this.gasSub, settings.autoAccelerate ? 'auto ✓' : 'hold');
    show(this.tiltInd, settings.tilt);
    show(this.tut, tut);
    if (tut) this.updateTutorial();
    else this.tutAcked = false;
    this.updateRace();
  }

  private updateTutorial(): void {
    const ps = state.phone;
    const t = ps?.tutorial;
    const step = Math.max(0, Math.min(TUTORIAL_STEPS.length - 1, t?.step ?? 0));
    const total = t?.total ?? TUTORIAL_STEPS.length;
    const s = TUTORIAL_STEPS[step];
    if (step !== this.tutStep) {
      this.tutStep = step;
      // restart the pulse animation
      this.tut.classList.remove('pop');
      void this.tut.offsetWidth;
      this.tut.classList.add('pop');
      haptic('tick');
    }
    const dots = Array.from({ length: total }, (_, i) => `<i class="${i === step ? 'on' : i < step ? 'done' : ''}"></i>`).join('');
    setHtml(this.tutDots, dots);
    setText(this.tutTitle, `${step + 1}. ${s.title}`);
    let text = s.text;
    let sub = s.sub ?? '';
    if (s.target === 'gas' && !settings.autoAccelerate) {
      text = 'Hold GAS to drive';
      sub = 'Auto-accelerate is OFF (change it in ⚙️)';
    }
    setText(this.tutText, text);
    setText(this.tutSub, sub);
    show(this.tutSub, sub !== '');
    this.tut.setAttribute('data-step', String(step));

    const hl = (el: HTMLElement, on: boolean) => toggleClass(el, 'hl', on);
    hl(this.zone, s.target === 'steer');
    for (const id of Object.keys(this.btn) as ButtonId[]) hl(this.btn[id], s.target === id);
    hl(this.pauseBtn, s.target === 'pause');

    const you = ps?.you;
    const done = this.tutAcked || !!you?.tutorialDone;
    show(this.gotIt, !done);
    show(this.tutDone, done);
    if (done) {
      const players = (ps?.players ?? []).filter((p) => p.connected);
      const n = players.filter((p) => p.tutorialDone || (p.playerId === state.playerId && this.tutAcked)).length;
      setText(this.tutDone, `✓ Waiting for others… (${n}/${players.length || 1})`);
    }
    show(this.skip, !!you?.isLeader);
  }

  private clearTutorialHighlights(): void {
    toggleClass(this.zone, 'hl', false);
    toggleClass(this.pauseBtn, 'hl', false);
    for (const id of Object.keys(this.btn) as ButtonId[]) toggleClass(this.btn[id], 'hl', false);
  }

  private updateRace(): void {
    const r = state.race;
    const tut = this.view === 'tutorial';
    if (!tut) this.clearTutorialHighlights();
    const showHud = !tut && !!r;
    toggleClass(this.el, 'nohud', !showHud);
    if (r && !tut) {
      setHtml(this.place, `${r.place}<sup>${ordSuffix(r.place)}</sup><small>/8</small>`);
      const lap = Math.max(1, Math.min(r.laps, r.lap));
      setHtml(this.lap, `<small>LAP</small> ${lap}<small>/${r.laps}</small>`);
      toggleClass(this.lap, 'final', lap === r.laps && r.laps > 1 && !r.finished);
      show(this.aiChip, r.ai && !r.finished);
    } else {
      setHtml(this.place, tut ? '<small>PRACTICE</small>' : '–');
      setHtml(this.lap, '');
      show(this.aiChip, false);
    }

    // Item
    const item = r?.item ?? 'none';
    const roulette = !!r?.roulette;
    if (roulette && !this.rouletteTimer) this.startRoulette();
    if (!roulette && this.rouletteTimer) this.stopRoulette();
    if (!roulette) {
      const info = itemInfo(item);
      setText(this.itemIcon, info.emoji);
      setText(this.itemLabel, item === 'none' ? 'ITEM' : info.label);
      this.btn.item.style.setProperty('--ic', item === 'none' ? '#3a3560' : info.color);
      const cnt = r?.itemCount ?? 0;
      setText(this.itemCount, cnt > 1 ? `×${cnt}` : '');
      show(this.itemCount, cnt > 1);
      if (this.lastRoulette && item !== 'none') {
        this.btn.item.classList.remove('got');
        void this.btn.item.offsetWidth;
        this.btn.item.classList.add('got');
        haptic('item');
      }
    }
    toggleClass(this.btn.item, 'empty', item === 'none' && !roulette);
    toggleClass(this.btn.item, 'rolling', roulette);
    this.lastRoulette = roulette;
    this.lastItem = item;

    // Drift stage
    const stage = r?.driftStage ?? 0;
    this.meterSegs.forEach((seg, i) => toggleClass(seg, 'on', stage > i));
    this.meter.setAttribute('data-stage', String(stage));
    this.btn.drift.style.setProperty('--dc', DRIFT_COLORS[stage]);
    toggleClass(this.btn.drift, 'charged', stage > 0);

    // Countdown / GO
    const cd = tut ? 0 : r?.countdown ?? 0;
    if (cd !== this.lastCountdown) {
      if (cd > 0) haptic('countdown');
      if (cd === 0 && this.lastCountdown > 0) this.go();
      if (cd === 1 && this.view === 'race') {
        clearTimeout(this.rocketTimer);
        // GO lands <=1 s after "1": start auto-gas ~0.35 s before it -> free rocket start.
        this.rocketTimer = window.setTimeout(() => (controls.autoGate = true), 650);
      }
      if (cd > 1) {
        clearTimeout(this.rocketTimer);
        controls.autoGate = false;
      }
      if (cd === 0) controls.autoGate = true;
      this.lastCountdown = cd;
    }
    const now = performance.now();
    if (cd > 0) {
      setHtml(this.countdown, `<span class="cd-num" data-n="${cd}">${cd}</span>`);
      show(this.countdown, true);
    } else if (now < this.goUntil) {
      setHtml(this.countdown, '<span class="cd-num go">GO!</span>');
      show(this.countdown, true);
    } else {
      show(this.countdown, false);
    }

    // Finished
    const fin = !tut && !!r?.finished;
    show(this.finished, fin);
    if (fin && r) {
      setHtml(
        this.finished,
        `<div class="fin-box"><div class="fin-title">FINISHED!</div><div class="fin-place">${r.place}<sup>${ordSuffix(r.place)}</sup></div><div class="fin-sub">🤖 Autopilot is driving — sit back and enjoy</div></div>`,
      );
    }
    toggleClass(this.el, 'finished', fin);
  }

  private go(): void {
    this.goUntil = performance.now() + 900;
    setTimeout(() => this.updateRace(), 950);
  }

  private startRoulette(): void {
    this.btn.item.style.setProperty('--ic', '#ffffff');
    setText(this.itemLabel, '???');
    show(this.itemCount, false);
    this.rouletteTimer = window.setInterval(() => {
      this.rouletteIdx = (this.rouletteIdx + 1) % ROULETTE_ICONS.length;
      const info = ROULETTE_ICONS[this.rouletteIdx];
      this.itemIcon.textContent = info.emoji;
      this.btn.item.style.setProperty('--ic', info.color);
    }, 85);
  }

  private stopRoulette(): void {
    clearInterval(this.rouletteTimer);
    this.rouletteTimer = 0;
  }

  /** One-shot host feedback. */
  fx(m: PhoneFx): void {
    const map: Record<PhoneFx['kind'], [string, string]> = {
      hit: ['#ff2a2a', 'OUCH!'],
      miniturbo: ['#4dd2ff', 'BOOST!'],
      boost: ['#4dd2ff', ''],
      lap: ['#ffffff', ''],
      finalLap: ['#ffcf1f', 'FINAL LAP!'],
      item: ['#ffe14a', ''],
      go: ['#3ddc5a', ''],
      finish: ['#ffcf1f', ''],
    };
    haptic(m.kind === 'finish' ? 'finish' : m.kind);
    if (m.kind === 'go') {
      if (this.lastCountdown > 0 || performance.now() > this.goUntil) this.go();
      this.lastCountdown = 0;
      controls.autoGate = true;
    }
    if (m.kind === 'item') return; // the item button animation covers it
    const [color, text0] = map[m.kind] ?? ['#fff', ''];
    let text = text0;
    if (m.kind === 'lap' && state.race) text = `LAP ${Math.min(state.race.lap, state.race.laps)}`;
    this.fxFlash.style.setProperty('--fx', color);
    this.fxFlash.classList.remove('on', 'hit');
    void this.fxFlash.offsetWidth;
    this.fxFlash.classList.add('on');
    if (m.kind === 'hit') this.fxFlash.classList.add('hit');
    if (text) {
      this.fxText.textContent = text;
      this.fxText.style.setProperty('--fx', color);
      this.fxText.classList.remove('on');
      void this.fxText.offsetWidth;
      this.fxText.classList.add('on');
      clearTimeout(this.fxTimer);
      this.fxTimer = window.setTimeout(() => this.fxText.classList.remove('on'), 1200);
    }
  }

  /** Per-packet visual update (knob, arrows, drift button glow). */
  private frame(): void {
    const s = controls.steer;
    const zr = this.zone.getBoundingClientRect();
    const v = controls.steerOut;
    if (s.active) {
      const full = controls.fullLockPx();
      const ox = s.originX - zr.left;
      const kx = Math.max(ox - full, Math.min(ox + full, s.x - zr.left));
      const oy = s.originY - zr.top;
      const ky = Math.max(50, Math.min(zr.height - 50, s.y - zr.top));
      this.base.style.transform = `translate3d(${ox - full}px,${oy}px,0)`;
      this.base.style.width = `${full * 2}px`;
      this.knob.style.transform = `translate3d(${kx}px,${ky}px,0)`;
      toggleClass(this.zone, 'touching', true);
    } else {
      toggleClass(this.zone, 'touching', false);
      this.knob.style.transform = `translate3d(${zr.width / 2 + v * zr.width * 0.3}px,${zr.height / 2}px,0)`;
    }
    toggleClass(this.arrowL, 'on', v < -0.12);
    toggleClass(this.arrowR, 'on', v > 0.12);
    const bar = this.steerBar.firstElementChild as HTMLElement;
    bar.style.transform = `scaleX(${v.toFixed(3)})`;
    if (settings.tilt) {
      const wheel = this.tiltInd.firstElementChild as HTMLElement;
      wheel.style.transform = `rotate(${(tilt.steer() * 90).toFixed(1)}deg)`;
      toggleClass(this.tiltInd, 'nodata', !tilt.hasData);
    }
  }
}
