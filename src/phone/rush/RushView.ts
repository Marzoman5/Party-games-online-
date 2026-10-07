/**
 * PARTY RUSH layout (portrait, one-handed motion controller).
 *
 * The phone shows ONLY: the player's colour (full background), emoji, name, ONE giant word and big state
 * feedback (flashes, bomb, pose picture, fish). Everything is driven by the host's `RushPhoneMsg`
 * (`state.rush`); see docs/PARTY_RUSH_CONTRACT.md.
 *
 *  - join / away: full-screen TAP TO PLAY → runtime.joinTap() (audio + motion permission + wake lock,
 *    then `mode` + `here`)
 *  - lobby: "Look at the TV", points + rank, round; leader NEXT ▶ (bottom half)
 *  - intro: minigame name + one line + looping gesture demo (or the touch line); "Hold tight" card
 *  - count: 3 / 2 / 1 / GO! (configure at the new rid, calibrate at GO)
 *  - play: giant word, 20 Hz stream, gesture events, activity heartbeat, triple cues, touch fallback
 *  - results: place, +pts, line, sip line
 */
import { SLOT_COLORS, TEAM_COLORS, encodeStream, type PhoneFx, type RushEvent, type RushPhoneMsg } from '../../net/protocol';
import type { ControllerLayout, InputDriver } from '../framework/layout';
import { vibrate } from '../haptics';
import { motion } from '../motion/index';
import { net } from '../net';
import { MAX_NAME, flushName, profile, setName } from '../profile';
import { setSetting, settings } from '../settings';
import { setState, state, type ViewId } from '../store';
import { LEFT_BY_CHOICE } from '../screens/join';
import { button, h, ordinal, setHtml, setText, show, toggleClass } from '../ui';
import { POSE_LABELS, POSE_SWIPES, bombSvg, demoSvg, fishSvg, gripSvg, poseSvg } from './art';
import { fireCue, restartAnim } from './cues';
import { joinTap, onRushRuntime, rush, sendMg, setManualTouch, touchMode } from './runtime';
import { sfx, unlockAudio } from './sound';
import { TouchPad, type TouchEventOut } from './touch';

import './rush.css';

const TICK_MS = 50; // 20 Hz stream + event drain

type Face = 'tap' | 'away' | 'lobby' | 'intro' | 'count' | 'play' | 'results' | 'paused' | 'watch';

/** Relative luminance (0..1) of a #rrggbb colour. */
export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0.3;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** Dark ink on light player colours (yellow, white, sand…), white ink on the rest. */
function inkFor(bg: string): 'dark' | 'light' {
  return luminance(bg) > 0.42 ? 'dark' : 'light';
}

/** Shrink `el`'s font until its text fits its box (wraps at spaces only). */
function fitText(el: HTMLElement, maxPx: number, minPx: number, maxH: number): void {
  let size = maxPx;
  el.style.fontSize = `${size}px`;
  for (let i = 0; i < 14; i++) {
    const tooWide = el.scrollWidth > el.clientWidth + 1;
    const tooTall = el.scrollHeight > maxH + 1;
    if (!tooWide && !tooTall) break;
    const k = tooWide ? Math.max(0.6, (el.clientWidth / el.scrollWidth) * 0.98) : 0.9;
    size = Math.max(minPx, Math.floor(size * k));
    el.style.fontSize = `${size}px`;
    if (size === minPx) break;
  }
}

export class RushView implements ControllerLayout {
  readonly id = 'rush' as const;
  readonly orientation = 'portrait' as const;
  readonly el: HTMLElement;
  readonly input: InputDriver;

  private bg: HTMLElement;
  private head: HTMLElement;
  private emojiEl: HTMLElement;
  private nameEl: HTMLElement;
  private badge: HTMLElement;
  private teamEl: HTMLElement;
  private leftEl: HTMLElement;
  private body: HTMLElement;
  private word: HTMLElement;
  private sub: HTMLElement;
  private art: HTMLElement;
  private chip: HTMLElement;
  private result: HTMLElement;
  private confetti: HTMLElement;
  private nextBtn: HTMLButtonElement;
  private pad: TouchPad;
  private flash: HTMLElement;
  private safe: HTMLElement;
  private tap: HTMLElement;
  private tapTitle: HTMLElement;
  private tapEmoji: HTMLElement;
  private tapName: HTMLElement;
  private tapSub: HTMLElement;
  private gear: HTMLButtonElement;
  private menu: HTMLElement;
  private menuEmoji: HTMLElement;
  private nameInput: HTMLInputElement;
  private touchTgl: HTMLButtonElement;
  private vibTgl: HTMLButtonElement;
  private leaveBtn: HTMLButtonElement;
  private leaveArmed = 0;

  private active = false;
  private timer = 0;
  private seq = 0;
  private face: Face | '' = '';
  private wordKey = '';
  private artKey = '';
  private resultKey = '';
  /** Cue bookkeeping: id seen last + when it arrived (phone-measured reaction times). */
  private cueId = -1;
  private cueAt = 0;
  private configuredRid = -1;
  private calibratedRid = -1;
  private lastCd = -1;
  private lastPh = '';
  private goAt = 0;
  private lastActAt = 0;
  private lastHereAt = 0;
  private nextFuseAt = 0;
  private anyTouchAt = 0;

  constructor() {
    this.bg = h('div', { class: 'rz-bg' });
    this.emojiEl = h('span', { class: 'rz-emoji' });
    this.nameEl = h('span', { class: 'rz-name', testid: 'rush-name' });
    this.badge = h('span', { class: 'rz-badge', testid: 'rush-touch-badge', title: 'Touch controls', text: '👆' });
    this.teamEl = h('div', { class: 'rz-team', testid: 'rush-team' });
    this.leftEl = h('div', { class: 'rz-left', testid: 'rush-left' });
    this.head = h('div', { class: 'rz-head' }, h('span', { class: 'rz-emoji-wrap' }, this.emojiEl, this.badge), this.nameEl);

    this.word = h('div', { class: 'rz-word', testid: 'rush-word' });
    this.sub = h('div', { class: 'rz-sub', testid: 'rush-sub' });
    this.art = h('div', { class: 'rz-art' });
    this.chip = h('div', { class: 'rz-chip', testid: 'rush-chip' });
    this.result = h('div', { class: 'rz-result', testid: 'rush-result' });
    this.confetti = h('div', { class: 'rz-confetti' });
    this.body = h('div', { class: 'rz-body' }, this.teamEl, this.result, this.word, this.sub, this.art, this.chip);

    this.nextBtn = button('', 'rush-next', () => {
      unlockAudio();
      sendMg({ k: 'next' });
      restartAnim(this.nextBtn, 'pressed');
    }, 'rz-next');
    this.nextBtn.innerHTML = '<span class="rz-next-word">NEXT ▶</span><small>start the next game</small>';

    this.pad = new TouchPad((e) => this.onTouchEvent(e));

    this.flash = h('div', { class: 'rz-flash', testid: 'rush-flash' });
    this.safe = h(
      'div',
      { class: 'rz-safe', testid: 'rush-safe' },
      h('div', { class: 'rz-safe-art' }),
      h('div', { class: 'rz-safe-title', text: 'Hold your phone tight! 🤝' }),
      h('div', { class: 'rz-safe-sub', text: 'Small wrist moves are enough' }),
    );

    this.tapEmoji = h('div', { class: 'rz-tap-emoji' });
    this.tapName = h('div', { class: 'rz-tap-name' });
    this.tapTitle = h('div', { class: 'rz-tap-title' });
    this.tapSub = h('div', { class: 'rz-tap-sub' });
    this.tap = h('button', { class: 'rz-tap', type: 'button', testid: 'rush-tap-to-play' }, this.tapEmoji, this.tapName, this.tapTitle, this.tapSub);
    this.tap.addEventListener('click', (e) => {
      e.preventDefault();
      this.onJoinTap();
    });

    // Corner menu (never required; outside play it's fine to read/type).
    this.gear = button('⚙', 'rush-menu-btn', () => this.openMenu(true), 'rz-gear');
    this.gear.setAttribute('aria-label', 'Menu');
    this.menuEmoji = h('div', { class: 'rz-menu-me' });
    this.nameInput = h('input', {
      class: 'rz-name-input',
      testid: 'rush-name-input',
      type: 'text',
      maxlength: MAX_NAME,
      autocomplete: 'off',
      autocorrect: 'off',
      autocapitalize: 'words',
      spellcheck: 'false',
      enterkeyhint: 'done',
      'aria-label': 'Your name',
    });
    this.nameInput.addEventListener('input', () => {
      if (this.nameInput.value.length > MAX_NAME) this.nameInput.value = this.nameInput.value.slice(0, MAX_NAME);
      setName(this.nameInput.value);
    });
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.nameInput.blur();
    });
    this.nameInput.addEventListener('blur', () => {
      flushName();
      window.scrollTo(0, 0);
    });
    this.touchTgl = this.toggle('rush-touch-toggle', () => setManualTouch(!rush.manualTouch));
    this.vibTgl = this.toggle('rush-vibration-toggle', () => setSetting('vibration', !settings.vibration));
    this.leaveBtn = button('Leave party', 'rush-leave', () => this.onLeave(), 'rz-menu-leave');
    const vibOk = typeof (navigator as Navigator & { vibrate?: unknown }).vibrate === 'function';
    this.menu = h(
      'div',
      { class: 'rz-menu', testid: 'rush-menu' },
      h(
        'div',
        { class: 'rz-menu-card scrollable' },
        this.menuEmoji,
        h('label', { class: 'rz-menu-field' }, h('span', { text: 'Your name' }), this.nameInput),
        h('div', { class: 'rz-menu-row' }, h('div', null, h('b', { text: 'Touch controls 👆' }), h('small', { text: 'Tap & swipe instead of moving the phone' })), this.touchTgl),
        h('div', { class: 'rz-menu-row' }, h('div', null, h('b', { text: 'Vibration' }), h('small', { text: vibOk ? 'Buzz on cues' : 'Not supported on this phone' })), this.vibTgl),
        this.leaveBtn,
        button('Done', 'rush-menu-close', () => this.openMenu(false), 'rz-menu-done'),
      ),
    );
    this.menu.addEventListener('click', (e) => {
      if (e.target === this.menu) this.openMenu(false);
    });
    show(this.menu, false);

    this.el = h(
      'div',
      { class: 'rush', testid: 'rush-view' },
      this.bg,
      this.head,
      this.leftEl,
      this.body,
      this.nextBtn,
      this.pad.el,
      this.confetti,
      this.flash,
      this.safe,
      this.tap,
      this.gear,
      this.menu,
    );
    // Any touch on the view counts as activity (touch players) and keeps audio alive (iOS suspends it).
    this.el.addEventListener(
      'pointerdown',
      () => {
        this.anyTouchAt = performance.now();
        unlockAudio();
      },
      { capture: true },
    );

    const self = this;
    this.input = {
      get isActive() {
        return self.active;
      },
      setActive(on: boolean) {
        self.setActive(on);
      },
      releaseAll() {
        self.pad.release();
      },
    };

    onRushRuntime(() => this.update('race'));
    // Hidden tab = away (best effort; the socket may already be frozen).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && this.isRush() && rush.tapped && state.rush) sendMg({ k: 'away' });
      if (document.visibilityState === 'hidden') this.pad.release();
    });
    window.addEventListener('resize', () => {
      this.wordKey = '';
    });
  }

  private toggle(testid: string, onTap: () => void): HTMLButtonElement {
    const b = h('button', { class: 'tgl', testid, type: 'button', role: 'switch' }, h('i'));
    b.addEventListener('click', (e) => {
      e.preventDefault();
      onTap();
      this.syncMenu();
    });
    return b;
  }

  private isRush(): boolean {
    return state.phone?.game === 'rush';
  }

  layout(): void {
    this.wordKey = '';
  }

  fx(_m: PhoneFx): void {
    /* Kart/Smash only: Rush feedback arrives as cues inside RushPhoneMsg. */
  }

  // ------------------------------------------------------------------ input loop

  private setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    clearInterval(this.timer);
    if (on) this.timer = window.setInterval(() => this.tick(), TICK_MS);
    else this.pad.release();
  }

  private tick(): void {
    const m = state.rush;
    const now = performance.now();
    const events = motion.drain();
    if (!m || document.visibilityState === 'hidden') return;
    const st = m.me.st;
    const live = rush.tapped && st === 'play';
    const touch = touchMode();

    // Resend a lost join tap (tapped before the socket was joined, or the message was dropped).
    if (rush.tapped && !rush.pending && st === 'new' && now - this.lastHereAt > 3000) {
      this.lastHereAt = now;
      sendMg({ k: 'mode', v: touch ? 0 : 1 });
      sendMg({ k: 'here' });
    }

    // 20 Hz stream while the round asks for one.
    if (live && m.s && (m.ph === 'count' || m.ph === 'play')) {
      const [a, b, c] = touch ? this.pad.sample(m.s) : motion.sample();
      if (net.sendInput(encodeStream(this.seq++ & 0xffffff, m.rid, a, b, c))) rush.sent.stream++;
    }

    // Detected gestures → events (only the kinds this round listens for).
    if (live && !touch && m.ph === 'play') {
      for (const e of events) if (m.ev.includes(e.k)) this.sendEvent(e.k, e.v, e.x, e.y, e.t);
    }

    // Activity heartbeat (≤ 1/s): only while hand-held (moving above table noise) or touched.
    if (rush.tapped && (st === 'play' || st === 'next') && now - this.lastActAt >= 1000) {
      const since = this.lastActAt || now - 1000;
      const moved = (rush.motionOk && motion.enabled && motion.activeSince(since)) || this.anyTouchAt > since || this.pad.lastTouchAt > since;
      if (moved) {
        this.lastActAt = now;
        sendMg({ k: 'act' });
      }
    }

    // Hot Potato: the fuse ticks faster as v → 1.
    const cue = m.cue;
    if (live && m.ph === 'play' && cue?.show === 'bomb') {
      const v = Math.max(0, Math.min(1, cue.v ?? 0));
      if (now >= this.nextFuseAt) {
        sfx('fuse', v);
        if (v > 0.6) vibrate(18);
        this.nextFuseAt = now + (700 - 560 * v);
      }
    }
  }

  private sendEvent(k: RushEvent, v: number, x: number, y: number, t: number): void {
    const m = state.rush;
    if (!m) return;
    const msg: { k: RushEvent; rid: number; v: number; x: number; y: number; ms?: number; c?: number } = {
      k,
      rid: m.rid,
      v: Math.round(v),
      x: Math.round(x),
      y: Math.round(y),
    };
    if (m.cue && this.cueId === m.cue.id && this.cueAt > 0) {
      msg.c = m.cue.id;
      msg.ms = Math.max(0, Math.round(t - this.cueAt));
    }
    sendMg(msg);
  }

  private onTouchEvent(e: TouchEventOut): void {
    const m = state.rush;
    sfx('tap');
    if (!m || !rush.tapped || m.me.st !== 'play' || m.ph !== 'play' || !touchMode()) return;
    if (e.k !== 'tap' && !m.ev.includes(e.k)) return;
    this.sendEvent(e.k, e.v, e.x, e.y, e.t);
  }

  // ------------------------------------------------------------------ taps

  private onJoinTap(): void {
    if (rush.pending) return;
    this.lastHereAt = performance.now();
    joinTap();
    restartAnim(this.tap, 'pressed');
    this.update('race');
  }

  private openMenu(on: boolean): void {
    if (on) {
      this.nameInput.value = profile.name || state.rush?.me.name || state.phone?.you?.name || '';
      this.leaveArmed = 0;
      setText(this.leaveBtn, 'Leave party');
      this.syncMenu();
    } else if (document.activeElement === this.nameInput) {
      this.nameInput.blur();
    }
    show(this.menu, on);
  }

  private syncMenu(): void {
    const me = this.me();
    setHtml(this.menuEmoji, `<span class="rz-swatch" style="background:${me.color}">${me.emoji}</span><b>${me.name.replace(/[<>&]/g, '')}</b>`);
    this.touchTgl.setAttribute('aria-checked', String(rush.manualTouch));
    toggleClass(this.touchTgl, 'on', rush.manualTouch);
    this.vibTgl.setAttribute('aria-checked', String(settings.vibration));
    toggleClass(this.vibTgl, 'on', settings.vibration);
  }

  private onLeave(): void {
    const now = performance.now();
    if (now - this.leaveArmed > 3000) {
      this.leaveArmed = now;
      setText(this.leaveBtn, 'Tap again to leave');
      return;
    }
    net.send({ t: 'leave' });
    show(this.menu, false);
    window.setTimeout(() => {
      net.halt();
      setState({ error: { t: 'error', code: 'kicked', message: LEFT_BY_CHOICE } });
    }, 120);
  }

  // ------------------------------------------------------------------ render

  private me(): { name: string; emoji: string; color: string } {
    const m = state.rush?.me;
    const you = state.phone?.you;
    const slotCol = you && you.slot >= 0 ? SLOT_COLORS[you.slot % SLOT_COLORS.length] : '#7c5cff';
    return {
      name: m?.name || you?.name || profile.name || 'Player',
      emoji: m?.emoji || you?.emoji || '🙂',
      color: m?.color || slotCol,
    };
  }

  private pickFace(m: RushPhoneMsg | null): Face {
    if (!m || !rush.tapped || m.me.st === 'new') return 'tap';
    if (m.me.st === 'away') return 'away';
    if (m.ph === 'paused') return 'paused';
    if (m.ph === 'lobby') return 'lobby';
    if (m.ph === 'results') return 'results';
    if (m.me.st === 'next') return 'watch';
    return m.ph;
  }

  update(_view: ViewId): void {
    const m = state.rush;
    const now = performance.now();
    const me = this.me();
    const touch = touchMode();
    this.el.style.setProperty('--pc', me.color);

    // ---- round bookkeeping (configure at the new rid, calibrate exactly at GO, cue timing)
    if (m) this.bookkeep(m, now);

    const face = this.pickFace(m);
    if (face !== this.face) {
      this.face = face;
      this.wordKey = '';
      this.artKey = '';
      if (face !== 'play') this.pad.release();
      if (face === 'play' || face === 'count') this.openMenu(false);
    }
    this.el.setAttribute('data-face', face);
    this.el.setAttribute('data-touch', touch ? '1' : '0');

    const cue = m?.cue ?? null;
    const cueUp = face === 'play' && !!cue;
    const bg = cueUp && cue?.bg ? cue.bg : me.color;
    this.bg.style.background = bg;
    this.el.setAttribute('data-ink', inkFor(bg));

    setText(this.emojiEl, me.emoji);
    setText(this.nameEl, me.name);
    show(this.badge, touch && rush.tapped);
    const team = m?.me.team;
    show(this.teamEl, team !== undefined && team >= 0 && (face === 'play' || face === 'count' || face === 'intro'));
    if (team !== undefined && team >= 0) {
      setText(this.teamEl, team % 2 === 0 ? 'RED TEAM' : 'BLUE TEAM');
      this.teamEl.style.background = TEAM_COLORS[team % 2];
    }
    setText(this.leftEl, face === 'play' && m && m.left >= 0 ? `${m.left}s` : '');
    show(this.gear, face !== 'play' && face !== 'count');

    // ---- tap-to-play / away overlay
    const overlay = face === 'tap' || face === 'away';
    show(this.tap, overlay);
    if (overlay) {
      this.tap.setAttribute('data-testid', face === 'away' ? 'rush-away' : 'rush-tap-to-play');
      setText(this.tapEmoji, me.emoji);
      setText(this.tapName, me.name);
      const joined = face === 'tap' && rush.tapped;
      toggleClass(this.tap, 'joined', joined);
      if (face === 'away') {
        setText(this.tapTitle, 'TAP TO JUMP BACK IN');
        setText(this.tapSub, "You're away — tap anywhere ⚡");
      } else if (rush.pending) {
        setText(this.tapTitle, 'ONE SEC…');
        setText(this.tapSub, 'Tap “Allow” if your phone asks');
      } else if (joined) {
        setText(this.tapTitle, "YOU'RE IN! ⚡");
        setText(this.tapSub, 'Look at the TV 📺');
      } else {
        setText(this.tapTitle, 'TAP TO PLAY ⚡');
        setText(this.tapSub, 'tap anywhere');
      }
    }

    // ---- safe card
    show(this.safe, !!m?.safe && !overlay && face !== 'play');
    if (m?.safe) setHtml(this.safe.firstElementChild as HTMLElement, gripSvg(me.emoji));

    // ---- leader NEXT
    const nextOn = !!m && face === 'lobby' && m.me.lead && m.canNext;
    show(this.nextBtn, nextOn);
    toggleClass(this.el, 'has-next', nextOn);

    // ---- touch pad during play (touch players only)
    const padOn = face === 'play' && touch && !!m;
    show(this.pad.el, padOn);
    toggleClass(this.el, 'has-pad', padOn);
    if (m && padOn) this.pad.configure(m.s, m.ev);

    this.renderBody(face, m, me, touch);
  }

  private bookkeep(m: RushPhoneMsg, now: number): void {
    const inRound = m.ph === 'intro' || m.ph === 'count' || m.ph === 'play';
    if (inRound && m.rid !== this.configuredRid) {
      this.configuredRid = m.rid;
      motion.configure(m.s, m.ev);
      this.pad.configure(m.s, m.ev);
      this.lastCd = -1;
    }
    // Count ticks.
    if (m.ph === 'count' && m.cd !== this.lastCd) {
      if (m.cd > 0 && rush.tapped && m.me.st !== 'away') {
        sfx('count');
        vibrate(30);
        restartAnim(this.word, 'pop');
      }
      this.lastCd = m.cd;
    }
    // GO: calibrate exactly once per round, at cd 0 or the switch to play.
    const atGo = (m.ph === 'count' && m.cd === 0) || m.ph === 'play';
    if (atGo && inRound && this.calibratedRid !== m.rid) {
      this.calibratedRid = m.rid;
      motion.calibrate();
      this.pad.reset();
      this.goAt = now;
      if (rush.tapped && m.me.st === 'play' && (!m.cue || m.cue.id === this.cueId || m.cue.fx !== 'go')) fireCue(this.flash, 'go');
    }
    // A NEW cue id: triple cue once + restart the reaction timer (at message arrival).
    const cue = m.cue;
    if (cue && cue.id !== this.cueId) {
      this.cueId = cue.id;
      this.cueAt = state.rushAt || now;
      const dupGo = cue.fx === 'go' && now - this.goAt < 400;
      if (rush.tapped && m.me.st !== 'away' && m.me.st !== 'new' && !dupGo) fireCue(this.flash, cue.fx, cue.v ?? 0.5);
      this.nextFuseAt = 0;
      this.artKey = '';
    } else if (!cue && this.cueId !== -1 && m.ph !== 'play') {
      this.cueId = -1;
      this.cueAt = 0;
    }
    this.lastPh = m.ph;
  }

  private setWord(text: string, cls: string, maxVw: number): void {
    const key = `${text}|${cls}|${maxVw}|${window.innerWidth}x${window.innerHeight}`;
    if (key === this.wordKey) return;
    this.wordKey = key;
    this.word.className = `rz-word ${cls}`;
    setText(this.word, text);
    const W = Math.max(200, this.el.clientWidth || window.innerWidth);
    const H = Math.max(300, this.el.clientHeight || window.innerHeight);
    const maxH = H * (cls.includes('w-huge') ? 0.34 : 0.24);
    fitText(this.word, Math.min((W * maxVw) / 100, H * 0.3), 22, maxH);
  }

  private setArt(key: string, html: string, testid: string | null, cls = ''): void {
    if (key === this.artKey) return;
    this.artKey = key;
    setHtml(this.art, html);
    this.art.className = `rz-art ${cls}`;
    if (testid) this.art.setAttribute('data-testid', testid);
    else this.art.removeAttribute('data-testid');
  }

  private renderBody(face: Face, m: RushPhoneMsg | null, me: { emoji: string }, touch: boolean): void {
    let sub = '';
    let chip = '';
    show(this.result, face === 'results');
    toggleClass(this.el, 'celebrate', false);
    switch (face) {
      case 'tap':
      case 'away':
        this.setWord('', '', 20);
        this.setArt('none', '', null);
        break;
      case 'lobby': {
        const st = m!.me.st;
        this.setWord('Look at the TV', 'w-phrase', 15);
        this.setArt('tv', '<div class="rz-tv">📺</div>', null, 'small');
        sub = st === 'next' ? "You're in next round!" : m!.round > 0 ? `Round ${m!.round}` : 'Get ready!';
        chip = m!.me.rank > 0 ? `⭐ ${m!.me.pts} pts · ${ordinal(m!.me.rank)}` : m!.me.pts > 0 ? `⭐ ${m!.me.pts} pts` : '';
        break;
      }
      case 'watch': {
        this.setWord("You're in next round!", 'w-phrase', 13);
        this.setArt('tv', '<div class="rz-tv">📺</div>', null, 'small');
        sub = 'Watch the TV — you jump in next game';
        break;
      }
      case 'intro': {
        this.setWord(m!.name || 'Up next', 'w-phrase w-title', 16);
        if (touch) {
          this.setArt(`touch-${m!.s}-${m!.ev.join()}`, '<div class="rz-finger">👆</div>', 'rush-demo', 'demo touch');
          sub = m!.touch || m!.instr;
        } else {
          this.setArt(`demo-${m!.demo}-${me.emoji}`, demoSvg(m!.demo, me.emoji), 'rush-demo', `demo d-${m!.demo || 'flick'}`);
          this.art.setAttribute('data-demo', m!.demo || 'flick');
          sub = m!.instr;
        }
        break;
      }
      case 'count': {
        const go = m!.cd <= 0;
        this.setWord(go ? 'GO!' : String(m!.cd), go ? 'w-huge w-go' : 'w-huge w-num', 60);
        this.setArt('none', '', null);
        sub = go ? '' : touch ? m!.touch : m!.instr;
        break;
      }
      case 'play': {
        const cue = m!.cue;
        const word = cue?.word ?? m!.word;
        if (cue?.show === 'bomb') {
          const v = Math.max(0, Math.min(1, cue.v ?? 0));
          this.setWord(word || 'PASS IT!', 'w-big w-bomb', 22);
          this.setArt('bomb', bombSvg(), 'rush-bomb', 'bomb');
          this.art.style.setProperty('--bp', `${(0.95 - 0.75 * v).toFixed(2)}s`);
          sub = touch ? 'TAP to pass it!' : 'FLICK to pass it!';
        } else if (cue?.show === 'pose') {
          const p = Math.round(cue.v ?? 0);
          this.setWord(POSE_LABELS[p] ?? word, 'w-big w-pose', 16);
          this.setArt(`pose-${p}-${me.emoji}`, poseSvg(p, me.emoji), 'rush-pose', 'pose');
          sub = touch ? (POSE_SWIPES[p] ?? '').toUpperCase() : '';
        } else if (cue?.show === 'fish') {
          this.setWord(word || 'YANK!', 'w-huge w-fish', 30);
          this.setArt('fish', `${fishSvg()}<div class="rz-reel"><i></i></div>`, 'rush-fish', 'fish');
          // Same cue id, new v (reel progress) / word: re-render only, never re-fire the triple cue.
          const reel = Math.max(0, Math.min(1, cue.v ?? 0));
          this.art.style.setProperty('--reel', reel.toFixed(3));
          toggleClass(this.art, 'reeling', reel > 0);
          sub = touch ? (reel > 0 ? 'MASH to reel!' : 'TAP NOW!') : reel > 0 ? 'SHAKE to reel!' : '';
        } else {
          this.setWord(word || 'GO!', 'w-huge', 28);
          this.setArt('none', '', null);
        }
        if (cue?.show !== 'bomb') this.art.style.removeProperty('--bp');
        break;
      }
      case 'results': {
        this.renderResult(m!);
        this.setArt('none', '', null);
        break;
      }
      case 'paused':
        this.setWord('PAUSED', 'w-huge w-paused', 22);
        this.setArt('pause', '<div class="rz-tv">⏸️</div>', null, 'small');
        sub = 'Hang tight…';
        break;
    }
    setText(this.sub, sub);
    show(this.sub, sub !== '');
    setText(this.chip, chip);
    show(this.chip, chip !== '');
  }

  private renderResult(m: RushPhoneMsg): void {
    const r = m.res;
    const place = r?.place ?? 0;
    const key = JSON.stringify(r) + m.sip + m.rid;
    const first = place === 1;
    toggleClass(this.el, 'celebrate', first);
    if (key === this.resultKey) return;
    this.resultKey = key;
    this.result.textContent = '';
    if (!r || place <= 0) {
      this.setWord('Look at the TV', 'w-phrase', 15);
      this.result.append(h('div', { class: 'rz-res-line', text: 'Round over! 📺' }));
    } else {
      const medal = place === 1 ? '🏆' : place === 2 ? '🥈' : place === 3 ? '🥉' : '💪';
      this.setWord(place === 1 ? '1st!' : ordinal(place), place === 1 ? 'w-huge w-first' : 'w-huge', 34);
      this.result.append(h('div', { class: 'rz-res-medal', text: medal }), h('div', { class: 'rz-res-pts', text: r.pts > 0 ? `+${r.pts} pts` : '' }));
      const line = r.line || (place > 3 ? "Next one's yours!" : '');
      if (line) this.result.append(h('div', { class: 'rz-res-line', text: line }));
    }
    if (m.sip) this.result.append(h('div', { class: 'rz-res-sip', testid: 'rush-sip', text: m.sip }));
    // Confetti for the winner (plain CSS, re-generated per result).
    this.confetti.textContent = '';
    if (first) {
      const cols = ['#ffd23f', '#ff4d6d', '#3ddc5a', '#3d8bff', '#ffffff', '#c86bff'];
      for (let i = 0; i < 28; i++) {
        const s = h('i');
        s.style.left = `${(i * 37) % 100}%`;
        s.style.background = cols[i % cols.length];
        s.style.animationDelay = `${((i * 0.13) % 1.6).toFixed(2)}s`;
        s.style.animationDuration = `${(2.2 + ((i * 7) % 10) / 10).toFixed(2)}s`;
        this.confetti.append(s);
      }
      sfx('win');
    }
  }
}
