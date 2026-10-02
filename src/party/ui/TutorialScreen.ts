/**
 * TUTORIAL — the showpiece. A sideways phone drawn in SVG; labelled callouts animate in one
 * at a time (with blips), each step has a little demo animation, then "Tap GOT IT!" with a
 * row of player avatars + checkmarks. Pressing DRIFT / ITEM makes your avatar react ("try it").
 */
import { SLOT_COLORS } from '../../net/protocol';
import { TUTORIAL_ACK_WAIT_MS, TUTORIAL_STEPS, TUTORIAL_STEP_MS } from '../config';
import type { PartySession, PlayerRec } from '../PartySession';
import type { ScreenView, UiContext } from './HostUI';
import { AvatarView, avatarMarkup } from './avatar';
import { button, h, replay, setText, svgFrom, toggle } from './dom';
import { PHONE_H, PHONE_W, ZONE_ANCHOR, phoneMarkup, tiltPhoneMarkup, type Zone } from './phoneArt';
import { blip } from './sfx';

interface StepDef {
  zone: Zone;
  label: string;
  title: string;
  sub: string;
  demo: (racer: string) => string;
}

const kart = (racer: string, cls = ''): string =>
  `<div class="kp-demo-kart ${cls}">${avatarMarkup(racer, null)}</div>`;

const STEPS: StepDef[] = [
  {
    zone: 'steer',
    label: 'DRAG ◀ ▶',
    title: 'Drag left / right to steer',
    sub: 'Use the whole left half of your phone',
    demo: () =>
      `<div class="kp-demo-tilt">${tiltPhoneMarkup()}<div class="kp-demo-note">Optional: turn on <b>tilt steering</b> in ⚙️ settings</div></div>`,
  },
  {
    zone: 'gas',
    label: 'GAS',
    title: 'Gas — auto\u2011accelerate is ON',
    sub: 'Your kart drives forward by itself. You just steer!',
    demo: (r) => `<div class="kp-demo-gas"><div class="kp-speedlines"><i></i><i></i><i></i><i></i></div>${kart(r)}</div>`,
  },
  {
    zone: 'drift',
    label: 'HOLD',
    title: 'Hold DRIFT through corners…',
    sub: 'Sparks go blue → orange → purple… let go for a BOOST!',
    demo: (r) =>
      `<div class="kp-demo-drift">${kart(r, 'kp-drifting')}<div class="kp-sparks"><i></i><i></i><i></i><i></i><i></i></div>
       <div class="kp-spark-legend"><span class="s1">BLUE</span><span class="s2">ORANGE</span><span class="s3">PURPLE</span></div>
       <div class="kp-boost-word">BOOST!</div></div>`,
  },
  {
    zone: 'item',
    label: 'TAP',
    title: 'Tap ITEM to use it',
    sub: 'Drive through ? boxes to grab BOUNCERS, BANANAS, TURBOS…',
    demo: (r) =>
      `<div class="kp-demo-item">${kart(r)}<div class="kp-orb"></div><div class="kp-banana">🍌</div>
       <div class="kp-item-tags"><span class="t1">BOUNCER</span><span class="t2">BANANA</span></div></div>`,
  },
  {
    zone: 'brake',
    label: 'BRAKE',
    title: 'Brake / reverse',
    sub: 'Hold it to back out of a wall',
    demo: (r) => `<div class="kp-demo-brake">${kart(r, 'kp-reversing')}<div class="kp-rev">◀ R</div></div>`,
  },
  {
    zone: 'pause',
    label: '⏸',
    title: 'Pause any time',
    sub: 'The leader can resume, restart or quit',
    demo: () => `<div class="kp-demo-pause"><div class="kp-pause-icon"><i></i><i></i></div></div>`,
  },
];

class AckChip {
  readonly root: HTMLDivElement;
  readonly avatar = new AvatarView('kp-ack-avatar');
  private readonly name = h('div', 'kp-ack-name');
  private readonly check = h('div', 'kp-ack-check', '✓');
  private readonly fx = h('div', 'kp-tryit');
  private readonly bubble = h('div', 'kp-ack-bubble');
  private done = false;
  playerId = '';

  constructor() {
    this.root = h('div', 'kp-ack', h('div', 'kp-ack-stage', this.avatar.root, this.fx, this.bubble), this.name, this.check);
  }

  set(p: PlayerRec): void {
    this.playerId = p.playerId;
    this.root.style.setProperty('--slot', SLOT_COLORS[p.slot]);
    this.check.dataset.tid = `tutorial-ack-${p.slot}`;
    this.avatar.set(p.characterId, SLOT_COLORS[p.slot], String(p.slot + 1));
    setText(this.name, p.name);
    toggle(this.root, 'kp-done', p.tutorialDone);
    toggle(this.root, 'kp-dc', !p.connected);
    if (p.tutorialDone && !this.done) {
      replay(this.check, 'kp-pop');
      blip('ready');
    }
    this.done = p.tutorialDone;
  }

  tryIt(kind: 'drift' | 'item'): void {
    replay(this.avatar.root, kind === 'drift' ? 'kp-hop' : 'kp-wiggle');
    this.fx.className = 'kp-tryit';
    replay(this.fx, kind === 'drift' ? 'kp-tryit-sparks' : 'kp-tryit-item');
    setText(this.bubble, kind === 'drift' ? 'DRIFT!' : 'ITEM!');
    replay(this.bubble, 'kp-bubble-pop');
    blip(kind === 'drift' ? 'spark' : 'item');
  }
}

export class TutorialScreen implements ScreenView {
  readonly root: HTMLDivElement;
  private readonly dots: HTMLElement[] = [];
  private readonly panels: HTMLDivElement[] = [];
  private readonly phoneWrap: HTMLDivElement;
  private readonly phone: SVGSVGElement;
  private readonly callout: HTMLDivElement;
  private readonly calloutText = h('span');
  private readonly progress = h('div', 'kp-tut-progress-fill');
  private readonly ackPanel: HTMLDivElement;
  private readonly ackBar = h('div', 'kp-ack-bar-fill');
  private readonly acks = h('div', 'kp-acks');
  private readonly ackHint = h('div', 'kp-acks-hint');
  private readonly chips = new Map<string, AckChip>();
  private shownStep = -1;
  private shownPhase: 'steps' | 'ack' | '' = '';
  private demoRacer = '';

  constructor(private readonly ctx: UiContext) {
    const header = h('div', 'kp-tut-header', h('div', 'kp-kicker', 'HOW TO PLAY'));
    const dots = h('div', 'kp-tut-dots');
    for (let i = 0; i < TUTORIAL_STEPS; i++) {
      const d = h('span', 'kp-dot');
      this.dots.push(d);
      dots.appendChild(d);
    }
    header.append(dots, button('Skip ⏭ <kbd>Esc</kbd>', 'kp-mini kp-skip', () => ctx.session.hostSkipTutorial(), 'btn-skip-tutorial'));

    const left = h('div', 'kp-tut-left');
    for (let i = 0; i < STEPS.length; i++) {
      const st = STEPS[i];
      const panel = h(
        'div',
        { class: 'kp-tut-panel', 'data-tid': `tutorial-step-${i}` },
        h('div', 'kp-tut-num', String(i + 1)),
        h('div', 'kp-tut-title', st.title),
        h('div', 'kp-tut-sub', st.sub),
        h('div', 'kp-tut-demo'),
      );
      this.panels.push(panel);
      left.appendChild(panel);
    }
    this.ackPanel = h(
      'div',
      { class: 'kp-tut-panel kp-tut-ackpanel', 'data-tid': 'tutorial-gotit' },
      h('div', 'kp-tut-title kp-gotit', 'Tap GOT IT! on your phone'),
      h('div', 'kp-tut-sub', 'We’ll start as soon as everyone’s ready'),
      h('div', 'kp-ack-bar', this.ackBar),
    );
    left.appendChild(this.ackPanel);

    this.phone = svgFrom(phoneMarkup(SLOT_COLORS[0]));
    this.callout = h('div', 'kp-callout', this.calloutText);
    this.phoneWrap = h('div', 'kp-phone-wrap', this.phone, this.callout);

    this.root = h(
      'div',
      { class: 'kp-tutorial', 'data-tid': 'screen-tutorial' },
      h('div', 'kp-scrim kp-scrim-strong'),
      h(
        'div',
        'kp-tut-inner',
        header,
        h('div', 'kp-tut-progress', this.progress),
        h('div', 'kp-tut-main', left, h('div', 'kp-tut-right', this.phoneWrap)),
        h('div', 'kp-tut-bottom', this.acks, this.ackHint),
      ),
    );
    setText(this.ackHint, 'Try it now: press DRIFT or ITEM on your phone!');
  }

  show(): void {
    this.shownStep = -1;
    this.shownPhase = '';
  }

  onStep(): void {
    this.shownStep = -1; // force the step animation on next update
  }

  update(s: PartySession): void {
    const t = s.tutorial;
    if (!t) return;
    const racer = s.players[0]?.characterId ?? 'max';
    if (racer !== this.demoRacer) {
      this.demoRacer = racer;
      this.panels.forEach((p, i) => {
        p.querySelector('.kp-tut-demo')!.innerHTML = STEPS[i].demo(racer);
      });
    }
    if (t.step !== this.shownStep || t.phase !== this.shownPhase) {
      const changedPhase = t.phase !== this.shownPhase;
      this.shownStep = t.step;
      this.shownPhase = t.phase;
      this.showStep(t.step, t.phase, changedPhase);
    }

    // Avatars row.
    const seen = new Set<string>();
    for (const p of s.players) {
      if (!p.connected && !p.tutorialDone) continue;
      seen.add(p.playerId);
      let chip = this.chips.get(p.playerId);
      if (!chip) {
        chip = new AckChip();
        this.chips.set(p.playerId, chip);
        replay(chip.root, 'kp-card-in');
      }
      chip.set(p);
      if (chip.root.parentElement !== this.acks) this.acks.appendChild(chip.root);
    }
    for (const [id, chip] of this.chips) {
      if (!seen.has(id)) {
        chip.root.remove();
        this.chips.delete(id);
      }
    }
    // keep slot order
    const ordered = s.players.filter((p) => seen.has(p.playerId)).map((p) => this.chips.get(p.playerId)!.root);
    ordered.forEach((el, i) => {
      if (this.acks.children[i] !== el) this.acks.insertBefore(el, this.acks.children[i] ?? null);
    });
    toggle(this.ackHint, 'kp-on', seen.size > 0);
  }

  private showStep(step: number, phase: 'steps' | 'ack', phaseChanged: boolean): void {
    const ack = phase === 'ack';
    this.dots.forEach((d, i) => {
      toggle(d, 'kp-on', i <= step);
      toggle(d, 'kp-cur', i === step && !ack);
    });
    this.panels.forEach((p, i) => toggle(p, 'kp-on', i === step && !ack));
    toggle(this.ackPanel, 'kp-on', ack);
    if (!ack) replay(this.panels[step], 'kp-panel-in');

    // Phone zone highlight + callout.
    const zone = STEPS[step].zone;
    this.phone.querySelectorAll<SVGGElement>('.kp-zone').forEach((g) => {
      const on = !ack && g.dataset.zone === zone;
      g.classList.toggle('kp-hl', on);
      g.classList.toggle('kp-dim', !ack && !on);
    });
    this.phone.classList.toggle('kp-step-steer', !ack && zone === 'steer');
    this.phone.classList.toggle('kp-step-drift', !ack && zone === 'drift');
    this.phone.classList.toggle('kp-step-item', !ack && zone === 'item');
    this.phone.classList.toggle('kp-step-gas', !ack && zone === 'gas');
    this.phone.classList.toggle('kp-step-brake', !ack && zone === 'brake');
    this.phone.classList.toggle('kp-step-pause', !ack && zone === 'pause');
    toggle(this.phoneWrap, 'kp-ack-phase', ack);

    if (ack) {
      setText(this.calloutText, 'GOT IT!');
      this.placeCallout([PHONE_W / 2, PHONE_H / 2]);
      this.callout.classList.add('kp-callout-gotit');
      this.ackBar.style.animation = 'none';
      void this.ackBar.offsetWidth;
      this.ackBar.style.animation = `kp-shrink ${TUTORIAL_ACK_WAIT_MS}ms linear forwards`;
      if (phaseChanged) blip('done');
    } else {
      this.callout.classList.remove('kp-callout-gotit');
      setText(this.calloutText, STEPS[step].label);
      this.placeCallout(ZONE_ANCHOR[zone]);
      blip('step');
    }
    replay(this.callout, 'kp-callout-in');
    this.progress.style.animation = 'none';
    void this.progress.offsetWidth;
    this.progress.style.animation = ack ? 'none' : `kp-grow ${TUTORIAL_STEP_MS}ms linear forwards`;
    this.progress.style.width = ack ? '100%' : '';
  }

  private placeCallout([x, y]: [number, number]): void {
    this.callout.style.left = `${(x / PHONE_W) * 100}%`;
    this.callout.style.top = `${(y / PHONE_H) * 100}%`;
  }

  tryIt(playerId: string, kind: 'drift' | 'item'): void {
    this.chips.get(playerId)?.tryIt(kind);
  }
}
