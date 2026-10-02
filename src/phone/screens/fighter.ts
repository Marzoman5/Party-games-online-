/**
 * FIGHTER layout (Smash Party, landscape).
 *
 *  left ~45 %: floating analog stick (appears where the thumb lands, 8-way indicator)
 *  right:      ATTACK (A, biggest) · SPECIAL (B) · JUMP · SHIELD · GRAB — a thumb arc
 *              computed from the zone size (like the kart layout()), mirrored for lefties
 *  top strip:  fighter + colour, damage %, stocks / score + timer, item, CPU chip,
 *              sudden death; in the sandbox: practice banner, dummy %, I'm ready, START
 *  overlays:   3-2-1-GO, KO!, OUT, hit flashes, tutorial card mirror (smash steps)
 */
import { SLOT_COLORS, TEAM_COLORS, type PhoneFightStatus, type PhoneFx } from '../../net/protocol';
import { getFighter } from '../../games/smash/roster';
import { fightControls, dir8, type FightButtonGeom, type FightButtonId } from '../fightControls';
import type { ControllerLayout } from '../framework/layout';
import { TutorialCard, type TutorialStepText } from '../framework/tutorialCard';
import { haptic, hitDuration, vibrate } from '../haptics';
import { net } from '../net';
import { settings } from '../settings';
import { state, type ViewId } from '../store';
import { button, charById, h, hex, setHtml, setText, show, toggleClass } from '../ui';

type TutZone = 'stick' | 'jump' | 'attack' | 'special' | 'shield' | 'goal';

/** Smash Party tutorial — must match docs/PARTY_HUB_CONTRACT.md (index = PhoneState.tutorial.step). */
export const SMASH_TUTORIAL: (TutorialStepText & { zone: TutZone })[] = [
  { zone: 'stick', title: 'Move', text: 'Put your thumb anywhere on the left side and push', sub: 'Push down to crouch · down in the air = fall fast' },
  { zone: 'jump', title: 'Jump', text: 'Tap JUMP (twice for a double jump)', sub: 'Quick tap = little hop' },
  { zone: 'attack', title: 'Attack', text: 'Tap ATTACK. Flick the stick + ATTACK = SMASH attack (hold to charge)', sub: 'The stick picks the move' },
  { zone: 'special', title: 'Special', text: 'Tap SPECIAL with a direction. Fell off? UP + SPECIAL!' },
  { zone: 'shield', title: 'Shield & Grab', text: 'Hold SHIELD; tap GRAB near someone to grab & throw', sub: 'SHIELD + stick = dodge roll' },
  { zone: 'goal', title: 'Knock them off!', text: 'Hit them to raise their %, then smash them off the screen', sub: 'Watch YOUR % up here — high % = you fly far!' },
];

const ITEM_ICON: Record<string, [string, string]> = {
  bat: ['🏏', 'BAT'],
  bomb: ['💣', 'BOMB'],
  food: ['🍗', 'FOOD'],
  capsule: ['💊', 'CAPSULE'],
  orb: ['🔮', 'ORB'],
};

const BTN_HTML: Record<FightButtonId, string> = {
  attack: '<span class="fb-glyph">A</span><span class="fb-label">ATTACK</span>',
  special: '<span class="fb-glyph">B</span><span class="fb-label">SPECIAL</span>',
  jump: '<span class="fb-glyph fb-arrow">▲</span><span class="fb-label">JUMP</span>',
  shield: '<span class="fb-shield-ico"></span><span class="fb-label">SHIELD</span>',
  grab: '<span class="fb-label">GRAB</span>',
};

/** Damage % colour: white -> yellow -> orange -> red -> dark red. */
const DMG_STOPS: [number, [number, number, number]][] = [
  [0, [255, 255, 255]],
  [35, [255, 243, 122]],
  [70, [255, 196, 58]],
  [110, [255, 134, 40]],
  [150, [255, 64, 40]],
  [210, [214, 22, 22]],
  [300, [150, 10, 10]],
];
export function damageColor(p: number): string {
  const v = Math.max(0, p);
  for (let i = 1; i < DMG_STOPS.length; i++) {
    const [p1, c1] = DMG_STOPS[i];
    if (v <= p1) {
      const [p0, c0] = DMG_STOPS[i - 1];
      const k = (v - p0) / (p1 - p0);
      const c = c0.map((a, j) => Math.round(a + (c1[j] - a) * k));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  const c = DMG_STOPS[DMG_STOPS.length - 1][1];
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function fmtClock(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

interface Circle {
  x: number;
  y: number;
  r: number;
}

/** Circle of radius r touching circles a and b (+gap), on the side away from `away`. */
function tangentTo(a: Circle, b: Circle, r: number, gap: number, away: Circle): Circle | null {
  const ra = a.r + r + gap;
  const rb = b.r + r + gap;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6 || d > ra + rb || d < Math.abs(ra - rb)) return null;
  const l = (ra * ra - rb * rb + d * d) / (2 * d);
  const hh = Math.sqrt(Math.max(0, ra * ra - l * l));
  const mx = a.x + (dx * l) / d;
  const my = a.y + (dy * l) / d;
  const p1 = { x: mx + (hh * -dy) / d, y: my + (hh * dx) / d, r };
  const p2 = { x: mx - (hh * -dy) / d, y: my - (hh * dx) / d, r };
  const d1 = Math.hypot(p1.x - away.x, p1.y - away.y);
  const d2 = Math.hypot(p2.x - away.x, p2.y - away.y);
  return d1 > d2 ? p1 : p2;
}

/** Thumb arc for the 5 face buttons inside a W x H zone (right-handed; mirror x for lefties). Exported for tests. */
export function fighterButtonLayout(W: number, H: number): Record<FightButtonId, Circle> | null {
  if (W < 60 || H < 60) return null;
  const pad = 8;
  const gap = Math.max(7, H * 0.022);
  let scale = 1;
  let res: Record<FightButtonId, Circle> | null = null;
  for (let iter = 0; iter < 16; iter++) {
    const D = Math.max(80, Math.min(H * 0.48, W * 0.38, 178)) * scale;
    const rA = D / 2;
    const rB = D * 0.4;
    const rJ = D * 0.39;
    const rS = D * 0.35;
    const rG = D * 0.27;
    const A: Circle = { x: W - pad - rA - Math.max(4, W * 0.02), y: H - pad - rA, r: rA };
    const pol = (c: Circle, dist: number, deg: number, r: number): Circle => ({
      x: c.x + Math.cos((deg * Math.PI) / 180) * dist,
      y: c.y - Math.sin((deg * Math.PI) / 180) * dist,
      r,
    });
    const B = pol(A, rA + rB + gap, 178, rB);
    B.y = Math.min(B.y, H - pad - rB);
    const J = pol(A, rA + rJ + gap, 96, rJ);
    const S = tangentTo(B, J, rS, gap, A) ?? pol(A, rA + rS + gap * 2, 136, rS);
    const G = tangentTo(B, S, rG, gap, A) ?? pol(B, rB + rG + gap, 120, rG);
    const all: Record<FightButtonId, Circle> = { attack: A, special: B, jump: J, shield: S, grab: G };
    res = all;
    const list = Object.values(all);
    const inside = list.every((c) => c.x - c.r >= pad - 1 && c.y - c.r >= pad - 1 && c.x + c.r <= W + 1 && c.y + c.r <= H + 1);
    let apart = true;
    for (let i = 0; i < list.length && apart; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y) < list[i].r + list[j].r + 3) {
          apart = false;
          break;
        }
      }
    }
    if (inside && apart) break;
    scale *= 0.94;
  }
  return res;
}

export class FighterView implements ControllerLayout {
  readonly id = 'fighter' as const;
  readonly input = fightControls;
  readonly el: HTMLElement;
  private view: ViewId = 'race';
  // top strip
  private top: HTMLElement;
  private idBox: HTMLElement;
  private idName: HTMLElement;
  private idTag: HTMLElement;
  private dmg: HTMLElement;
  private dmgNum: HTMLElement;
  private stocks: HTMLElement;
  private itemEl: HTMLElement;
  private cpuChip: HTMLElement;
  private sdChip: HTMLElement;
  private respChip: HTMLElement;
  private sandboxBox: HTMLElement;
  private dummyEl: HTMLElement;
  private readyBtn: HTMLButtonElement;
  private sbStart: HTMLButtonElement;
  private pauseBtn: HTMLButtonElement;
  // controls
  private stickZone: HTMLElement;
  private btnZone: HTMLElement;
  private base: HTMLElement;
  private knob: HTMLElement;
  private dirs: HTMLElement[] = [];
  private ghost: HTMLElement;
  private btn: Record<FightButtonId, HTMLElement>;
  // overlays
  private countdown: HTMLElement;
  private fxFlash: HTMLElement;
  private fxText: HTMLElement;
  private koOv: HTMLElement;
  private outOv: HTMLElement;
  private tutCard = new TutorialCard();

  private lastDamage = 0;
  private lastCountdown = 0;
  private goUntil = 0;
  private fxTimer = 0;
  private koUntil = 0;
  private lastRespawning = false;
  private stocksKey = '';
  private readyLocal = false;
  private flickTimer = 0;

  constructor() {
    // ----- top strip -----
    this.idName = h('span', { class: 'f-name', testid: 'fight-name' });
    this.idTag = h('span', { class: 'f-tag' });
    this.idBox = h('div', { class: 'f-id' }, h('i', { class: 'f-swatch' }), h('div', { class: 'f-idtext' }, this.idName, this.idTag));
    this.dmgNum = h('b', { class: 'f-dmg-num' });
    this.dmg = h('div', { class: 'f-dmg', testid: 'fight-damage' }, this.dmgNum, h('small', { text: '%' }));
    this.stocks = h('div', { class: 'f-stocks', testid: 'fight-stocks' });
    this.itemEl = h('div', { class: 'f-item', testid: 'fight-item' });
    this.cpuChip = h('div', { class: 'f-chip cpu', testid: 'fight-cpu', text: '🤖 CPU is playing for you' });
    this.sdChip = h('div', { class: 'f-chip sd', testid: 'fight-sd', text: 'SUDDEN DEATH' });
    this.respChip = h('div', { class: 'f-chip resp', text: 'Respawning…' });
    this.dummyEl = h('div', { class: 'f-dummy', testid: 'dummy-damage' });
    this.readyBtn = button('I’m ready ✓', 'btn-practice-done', () => {
      this.readyLocal = true;
      net.send({ t: 'practice_done' });
      this.update(this.view);
    }, 'btn f-sb-btn f-ready');
    this.sbStart = button('START ▶', 'btn-sandbox-start', () => net.send({ t: 'start' }), 'btn btn-start f-sb-btn');
    for (const b of [this.readyBtn, this.sbStart]) b.setAttribute('data-click', '');
    this.sandboxBox = h(
      'div',
      { class: 'f-sandbox', testid: 'sandbox-banner' },
      h('div', { class: 'f-sb-text' }, h('b', { text: 'PRACTICE' }), h('small', { text: 'hit the dummy!' })),
      this.dummyEl,
      this.readyBtn,
      this.sbStart,
    );
    this.pauseBtn = button(h('span', { class: 'pause-glyph' }), 'btn-pause', () => net.send({ t: 'pause' }), 'top-btn pause-btn');
    this.pauseBtn.setAttribute('data-click', '');
    this.pauseBtn.setAttribute('aria-label', 'Pause');
    this.top = h(
      'div',
      { class: 'ctl-top f-top' },
      this.idBox,
      this.dmg,
      this.stocks,
      this.itemEl,
      this.sdChip,
      this.respChip,
      this.cpuChip,
      this.sandboxBox,
      h('div', { class: 'spacer' }),
      this.pauseBtn,
    );

    // ----- stick -----
    this.base = h('div', { class: 'stick-base' });
    for (let i = 0; i < 8; i++) {
      const d = h('i', { class: 'stick-dir', style: `--a:${-i * 45}deg` });
      this.dirs.push(d);
      this.base.append(d);
    }
    this.knob = h('div', { class: 'stick-knob' });
    this.ghost = h(
      'div',
      { class: 'stick-ghost' },
      h('div', { class: 'ghost-ring' }, h('div', { class: 'ghost-knob' })),
      h('div', { class: 'ghost-text' }, h('b', { text: 'MOVE' }), h('small', { text: 'thumb anywhere here' })),
    );
    this.stickZone = h('div', { class: 'stick-zone', testid: 'stick-zone' }, this.ghost, this.base, this.knob);

    // ----- buttons -----
    const mk = (id: FightButtonId): HTMLElement => {
      const el = h('div', { class: `cb fb fb-${id}`, testid: `btn-${id}`, role: 'button', 'aria-label': id });
      el.innerHTML = BTN_HTML[id];
      return el;
    };
    this.btn = { attack: mk('attack'), special: mk('special'), jump: mk('jump'), shield: mk('shield'), grab: mk('grab') };
    this.btnZone = h('div', { class: 'f-btn-zone' }, this.btn.grab, this.btn.shield, this.btn.special, this.btn.jump, this.btn.attack);

    fightControls.bindStickZone(this.stickZone);
    fightControls.bindButtonZone(this.btnZone);
    fightControls.geometry = () => this.geometry();
    fightControls.stickRadius = () => Math.max(160, Math.min(window.innerHeight, window.innerWidth)) * settings.stickSize;
    fightControls.onButton = (id, down) => toggleClass(this.btn[id], 'down', down);
    fightControls.onFrame = () => this.frame();
    fightControls.onFlick = () => {
      this.base.classList.remove('flick');
      void this.base.offsetWidth;
      this.base.classList.add('flick');
      clearTimeout(this.flickTimer);
      this.flickTimer = window.setTimeout(() => this.base.classList.remove('flick'), 260);
    };

    // ----- overlays -----
    this.countdown = h('div', { class: 'countdown', testid: 'fight-countdown' });
    this.fxFlash = h('div', { class: 'fx-flash' });
    this.fxText = h('div', { class: 'fx-text', testid: 'fx-text' });
    this.koOv = h('div', { class: 'f-ko', testid: 'fight-ko' }, h('b', { text: 'KO!' }));
    this.outOv = h(
      'div',
      { class: 'f-out', testid: 'fight-out' },
      h('div', { class: 'f-out-box' }, h('b', { text: 'OUT!' }), h('small', { text: 'No lives left — cheer on the others 📣' })),
    );
    this.tutCard.onChange = () => this.update(this.view);

    const main = h('div', { class: 'ctl-main' }, this.stickZone, this.btnZone);
    this.el = h(
      'div',
      { class: 'ctl fctl', testid: 'screen-fighter' },
      this.top,
      main,
      this.fxFlash,
      this.koOv,
      this.outOv,
      this.fxText,
      this.countdown,
      this.tutCard.el,
    );

    // iOS: no scroll / zoom / callout / loupe from touches on the pad.
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
    show(this.koOv, false);
  }

  enter(view: ViewId): void {
    this.view = view;
    this.lastCountdown = state.fight?.countdown ?? 0;
    this.lastDamage = state.fight?.damage ?? 0;
    this.lastRespawning = !!state.fight?.respawning;
    requestAnimationFrame(() => {
      this.layout();
      this.frame();
    });
  }

  leave(): void {
    fightControls.releaseAll();
    this.tutCard.reset();
    this.readyLocal = false;
  }

  private geometry(): FightButtonGeom[] {
    const out: FightButtonGeom[] = [];
    for (const id of Object.keys(this.btn) as FightButtonId[]) {
      const r = this.btn[id].getBoundingClientRect();
      if (r.width < 2) continue;
      out.push({ id, x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2 });
    }
    return out;
  }

  layout(): void {
    const W = this.btnZone.clientWidth;
    const H = this.btnZone.clientHeight;
    const pos = fighterButtonLayout(W, H);
    if (!pos) return;
    const lefty = settings.leftHanded;
    for (const id of Object.keys(pos) as FightButtonId[]) {
      const p = pos[id];
      const x = lefty ? W - p.x : p.x;
      const s = this.btn[id].style;
      const d = Math.round(p.r * 2);
      s.width = s.height = `${d}px`;
      s.left = `${Math.round(x - p.r)}px`;
      s.top = `${Math.round(p.y - p.r)}px`;
      s.fontSize = `${Math.round(Math.max(11, Math.min(22, d * 0.14)))}px`;
    }
    // Stick visuals sized to the radius.
    const R = fightControls.stickRadius();
    this.el.style.setProperty('--stick-r', `${Math.round(R)}px`);
  }

  update(view: ViewId): void {
    if (view === 'race' || view === 'tutorial' || view === 'sandbox') {
      if (this.view !== view) this.enter(view);
      this.view = view;
    }
    const tut = this.view === 'tutorial';
    const sandbox = this.view === 'sandbox';
    this.el.setAttribute('data-view', this.view);
    toggleClass(this.el, 'tut', tut);
    toggleClass(this.el, 'sandbox', sandbox);
    toggleClass(this.el, 'lefty', settings.leftHanded);
    show(this.tutCard.el, tut);
    if (tut) this.updateTutorial();
    else {
      this.tutCard.reset();
      this.clearHighlights();
    }
    if (!sandbox) this.readyLocal = false;
    this.updateHud();
  }

  private updateTutorial(): void {
    const step = this.tutCard.currentStep(SMASH_TUTORIAL.length);
    const s = SMASH_TUTORIAL[step];
    let text = s.text;
    if (s.zone === 'jump' && settings.tapJump) text += ' — or flick the stick up';
    this.tutCard.render(step, SMASH_TUTORIAL.length, { title: s.title, text, sub: s.sub });
    this.el.setAttribute('data-tut', s.zone);
    toggleClass(this.stickZone, 'hl', s.zone === 'stick');
    toggleClass(this.btn.jump, 'hl', s.zone === 'jump');
    toggleClass(this.btn.attack, 'hl', s.zone === 'attack');
    toggleClass(this.btn.special, 'hl', s.zone === 'special');
    toggleClass(this.btn.shield, 'hl', s.zone === 'shield');
    toggleClass(this.btn.grab, 'hl', s.zone === 'shield');
    toggleClass(this.dmg, 'hl', s.zone === 'goal');
  }

  private clearHighlights(): void {
    this.el.removeAttribute('data-tut');
    toggleClass(this.stickZone, 'hl', false);
    toggleClass(this.dmg, 'hl', false);
    for (const id of Object.keys(this.btn) as FightButtonId[]) toggleClass(this.btn[id], 'hl', false);
  }

  private updateHud(): void {
    const ps = state.phone;
    const you = ps?.you ?? null;
    const f: PhoneFightStatus | null = state.fight;
    const tut = this.view === 'tutorial';
    const sandbox = this.view === 'sandbox';
    const match = this.view === 'race';
    const teams = !!(ps?.gameSetup as { teams?: boolean } | undefined)?.teams;

    // Identity: fighter name + slot / team colour.
    const charId = f?.characterId || you?.characterId || '';
    const c = charById(charId);
    const slot = you?.slot ?? 0;
    const team = f?.team ?? you?.team ?? 0;
    const col = teams && match ? TEAM_COLORS[team % 2] : SLOT_COLORS[slot % SLOT_COLORS.length];
    this.el.style.setProperty('--me', col);
    this.el.style.setProperty('--fc', c ? hex(c.color) : col);
    setText(this.idName, c?.name ?? 'Fighter');
    let tag = `P${slot + 1}`;
    if (teams && match) tag += team === 0 ? ' · RED TEAM' : ' · BLUE TEAM';
    else if (c) {
      try {
        tag += ` · ${getFighter(c.id).archetypeLabel}`;
      } catch {
        /* roster mismatch: keep the slot tag */
      }
    }
    setText(this.idTag, tag);

    // Damage %
    const dmg = Math.max(0, Math.round(f?.damage ?? 0));
    setText(this.dmgNum, String(dmg));
    this.dmg.style.setProperty('--dc', damageColor(dmg));
    if (dmg > this.lastDamage) {
      const amp = Math.min(9, 2 + (dmg - this.lastDamage) * 0.35);
      this.dmg.style.setProperty('--amp', `${amp.toFixed(1)}px`);
      this.dmg.classList.remove('bump');
      void this.dmg.offsetWidth;
      this.dmg.classList.add('bump');
    }
    this.lastDamage = dmg;
    show(this.dmg, !sandbox);

    // Stocks / time mode
    const timeMode = !!f && f.stocks < 0;
    let sk = '';
    if (!f || sandbox || tut) sk = '';
    else if (timeMode) {
      const sc = f.score;
      sk = `<span class="f-score ${sc > 0 ? 'pos' : sc < 0 ? 'neg' : ''}">${sc > 0 ? '+' : ''}${sc}</span>${f.timeLeft >= 0 ? `<span class="f-clock">⏱ ${fmtClock(f.timeLeft)}</span>` : ''}`;
    } else if (f.stocks > 5) {
      sk = `<i class="stk"></i><span class="stk-n">×${f.stocks}</span>`;
    } else {
      sk = Array.from({ length: Math.max(0, f.stocks) }, () => '<i class="stk"></i>').join('');
      if (f.stocks <= 0) sk = '';
    }
    if (f && !timeMode && f.timeLeft >= 0 && !sandbox && !tut) sk += `<span class="f-clock">⏱ ${fmtClock(f.timeLeft)}</span>`;
    if (sk !== this.stocksKey) {
      this.stocksKey = sk;
      setHtml(this.stocks, sk);
    }
    show(this.stocks, sk !== '');

    // Item
    const item = f?.item && f.item !== 'none' ? ITEM_ICON[f.item] ?? ['🎁', f.item.toUpperCase()] : null;
    setHtml(this.itemEl, item ? `<span>${item[0]}</span><small>${item[1]}</small>` : '');
    show(this.itemEl, !!item && !tut);

    // Chips
    show(this.cpuChip, !!f?.cpu && match);
    show(this.sdChip, !!f?.suddenDeath && match);
    const resp = !!f?.respawning && match && !f.out;
    show(this.respChip, resp && performance.now() > this.koUntil);
    if (resp && !this.lastRespawning && performance.now() > this.koUntil + 1500) this.showKo();
    this.lastRespawning = resp;

    // Sandbox
    show(this.sandboxBox, sandbox);
    if (sandbox) {
      setHtml(this.dummyEl, `<small>DUMMY</small><b style="color:${damageColor(f?.dummyDamage ?? 0)}">${Math.round(f?.dummyDamage ?? 0)}%</b>`);
      const done = this.readyLocal || !!(you && ps?.sandbox?.done?.includes(you.playerId));
      const players = (ps?.players ?? []).filter((p) => p.connected);
      const n = players.filter((p) => ps?.sandbox?.done?.includes(p.playerId) || (p.playerId === you?.playerId && done)).length;
      setText(this.readyBtn, done ? `✓ Ready ${n}/${players.length || 1}` : 'I’m ready ✓');
      this.readyBtn.disabled = done;
      toggleClass(this.readyBtn, 'done', done);
      show(this.sbStart, !!you?.isLeader);
    }

    // Countdown / GO
    const cd = match ? f?.countdown ?? 0 : 0;
    if (cd !== this.lastCountdown) {
      if (cd > 0) haptic('countdown');
      if (cd === 0 && this.lastCountdown > 0) this.go();
      this.lastCountdown = cd;
    }
    const now = performance.now();
    if (cd > 0) {
      setHtml(this.countdown, `<span class="cd-num" data-n="${cd}">${cd}</span>`);
      show(this.countdown, true);
    } else if (now < this.goUntil) {
      setHtml(this.countdown, '<span class="cd-num go">GO!</span>');
      show(this.countdown, true);
    } else show(this.countdown, false);

    // OUT
    const out = !!f?.out && match;
    show(this.outOv, out);
    toggleClass(this.el, 'out', out);
    show(this.koOv, now < this.koUntil);
  }

  private go(): void {
    this.goUntil = performance.now() + 900;
    setTimeout(() => this.updateHud(), 950);
  }

  private showKo(): void {
    this.koUntil = performance.now() + 1300;
    show(this.koOv, true);
    this.koOv.classList.remove('on');
    void this.koOv.offsetWidth;
    this.koOv.classList.add('on');
    setTimeout(() => this.updateHud(), 1350);
  }

  private flash(color: string, text: string, hit = false, opacity = 1): void {
    this.fxFlash.style.setProperty('--fx', color);
    this.fxFlash.style.opacity = '';
    this.fxFlash.classList.remove('on', 'hit');
    void this.fxFlash.offsetWidth;
    this.fxFlash.style.setProperty('--fxo', String(opacity));
    this.fxFlash.classList.add('on');
    if (hit) this.fxFlash.classList.add('hit');
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

  fx(m: PhoneFx): void {
    const st = typeof m.strength === 'number' ? m.strength : 0.5;
    switch (m.kind) {
      case 'hit':
        vibrate(hitDuration(st));
        this.flash('#ff2a2a', '', true, 0.35 + 0.65 * Math.max(0, Math.min(1, st)));
        break;
      case 'land':
        vibrate(Math.round(8 + 10 * Math.max(0, Math.min(1, st))));
        break;
      case 'ko':
        haptic('ko');
        this.flash('#ff2a2a', '', true);
        this.showKo();
        break;
      case 'koOther':
        haptic('koOther');
        this.flash('#ffcf1f', 'KO! 💥');
        break;
      case 'shieldBreak':
        haptic('shieldBreak');
        this.flash('#ff6a2a', 'SHIELD BREAK!', true);
        break;
      case 'game':
        haptic('game');
        this.flash('#ffcf1f', 'GAME!');
        break;
      case 'go':
        haptic('go');
        if (this.lastCountdown > 0 || performance.now() > this.goUntil) this.go();
        this.lastCountdown = 0;
        this.updateHud();
        break;
      case 'item':
        haptic('item');
        break;
      default:
        haptic(m.kind);
        break;
    }
  }

  /** Stick visuals (called on every stick move + releases). */
  private frame(): void {
    const s = fightControls.stick;
    const zr = this.stickZone.getBoundingClientRect();
    const R = s.active ? s.radius : fightControls.stickRadius();
    const o = s.out();
    if (s.active) {
      const bx = s.ox - zr.left;
      const by = s.oy - zr.top;
      this.base.style.transform = `translate3d(${(bx - R).toFixed(1)}px,${(by - R).toFixed(1)}px,0)`;
      const kx = bx + s.rx * R;
      const ky = by - s.ry * R;
      this.knob.style.transform = `translate3d(${kx.toFixed(1)}px,${ky.toFixed(1)}px,0)`;
      toggleClass(this.stickZone, 'touching', true);
      const d = o.m > 0 ? dir8(o.x, o.y) : -1;
      this.dirs.forEach((el, i) => toggleClass(el, 'on', i === d));
      toggleClass(this.base, 'full', o.m > 0.85);
    } else {
      toggleClass(this.stickZone, 'touching', false);
      this.dirs.forEach((el) => toggleClass(el, 'on', false));
    }
  }
}
