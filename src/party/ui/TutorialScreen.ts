/**
 * TUTORIAL — the showpiece, generic for every game (the steps, demos and the phone illustration
 * come from the active game's `TutorialDef`). A sideways phone drawn in SVG; labelled callouts
 * animate in one at a time (with blips), each step has a little demo animation, then "Tap GOT IT!"
 * with a row of player avatars + checkmarks. Pressing a button makes your avatar react ("try it").
 */
import { SLOT_COLORS, type GameId } from '../../net/protocol';
import { TUTORIAL_ACK_WAIT_MS } from '../../engine/config';
import type { CharacterLook, TutorialDef } from '../../engine/GameModule';
import type { PartySession, PlayerRec } from '../../engine/PartySession';
import type { ScreenView, UiContext } from './HostUI';
import { FaceView } from './LobbyScreen';
import { button, h, replay, setText, svgFrom, toggle } from './dom';
import { blip } from './sfx';

class AckChip {
  readonly root: HTMLDivElement;
  readonly face = new FaceView('kp-ack-avatar');
  private readonly name = h('div', 'kp-ack-name');
  private readonly check = h('div', 'kp-ack-check', '✓');
  private readonly fx = h('div', 'kp-tryit');
  private readonly bubble = h('div', 'kp-ack-bubble');
  private done = false;
  playerId = '';

  constructor() {
    this.root = h('div', 'kp-ack', h('div', 'kp-ack-stage', this.face.root, this.fx, this.bubble), this.name, this.check);
  }

  set(p: PlayerRec, look: CharacterLook | null): void {
    this.playerId = p.playerId;
    this.root.style.setProperty('--slot', SLOT_COLORS[p.slot]);
    this.check.dataset.tid = `tutorial-ack-${p.slot}`;
    this.face.set(p.characterId, SLOT_COLORS[p.slot], String(p.slot + 1), look);
    setText(this.name, p.name);
    toggle(this.root, 'kp-done', p.tutorialDone);
    toggle(this.root, 'kp-dc', !p.connected);
    if (p.tutorialDone && !this.done) {
      replay(this.check, 'kp-pop');
      blip('ready');
    }
    this.done = p.tutorialDone;
  }

  tryIt(kind: 'drift' | 'item', label: string): void {
    replay(this.face.root, kind === 'drift' ? 'kp-hop' : 'kp-wiggle');
    this.fx.className = 'kp-tryit';
    replay(this.fx, kind === 'drift' ? 'kp-tryit-sparks' : 'kp-tryit-item');
    setText(this.bubble, label);
    replay(this.bubble, 'kp-bubble-pop');
    blip(kind === 'drift' ? 'spark' : 'item');
  }
}

export class TutorialScreen implements ScreenView {
  readonly root: HTMLDivElement;
  private readonly dotsRow = h('div', 'kp-tut-dots');
  private dots: HTMLElement[] = [];
  private panels: HTMLDivElement[] = [];
  private readonly left = h('div', 'kp-tut-left');
  private readonly kicker = h('div', 'kp-kicker', 'HOW TO PLAY');
  private readonly phoneWrap: HTMLDivElement;
  private phone: SVGSVGElement;
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
  private builtFor: GameId | '' = '';
  private def: TutorialDef | null = null;

  constructor(private readonly ctx: UiContext) {
    const header = h('div', 'kp-tut-header', this.kicker);
    header.append(this.dotsRow, button('Skip ⏭ <kbd>Esc</kbd>', 'kp-mini kp-skip', () => ctx.session.hostSkipTutorial(), 'btn-skip-tutorial'));

    this.ackPanel = h(
      'div',
      { class: 'kp-tut-panel kp-tut-ackpanel', 'data-tid': 'tutorial-gotit' },
      h('div', 'kp-tut-title kp-gotit', 'Tap GOT IT! on your phone'),
      h('div', 'kp-tut-sub', 'We’ll start as soon as everyone’s ready'),
      h('div', 'kp-ack-bar', this.ackBar),
    );
    this.left.appendChild(this.ackPanel);

    this.phone = svgFrom('<svg class="kp-phone" xmlns="http://www.w3.org/2000/svg"></svg>');
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
        h('div', 'kp-tut-main', this.left, h('div', 'kp-tut-right', this.phoneWrap)),
        h('div', 'kp-tut-bottom', this.acks, this.ackHint),
      ),
    );
    this.build(ctx.session);
  }

  /** (Re)build the steps + phone art for the game whose tutorial is running. */
  private build(s: PartySession): void {
    const game = s.tutorial?.game ?? s.gameId;
    if (game === this.builtFor) return;
    this.builtFor = game;
    const mod = s.modules[game];
    const def = mod.tutorial;
    this.def = def;
    this.root.dataset.game = game;
    setText(this.kicker, `HOW TO PLAY · ${mod.info.title.toUpperCase()}`);
    this.dots = def.steps.map(() => h('span', 'kp-dot'));
    this.dotsRow.replaceChildren(...this.dots);
    for (const p of this.panels) p.remove();
    this.panels = def.steps.map((st, i) =>
      h(
        'div',
        { class: 'kp-tut-panel', 'data-tid': `tutorial-step-${i}` },
        h('div', 'kp-tut-num', String(i + 1)),
        h('div', 'kp-tut-title', st.title),
        h('div', 'kp-tut-sub', st.sub),
        h('div', 'kp-tut-demo'),
      ),
    );
    for (const p of this.panels) this.left.insertBefore(p, this.ackPanel);
    const phone = svgFrom(def.phoneMarkup(SLOT_COLORS[0]));
    this.phone.replaceWith(phone);
    this.phone = phone;
    this.demoRacer = '';
    this.shownStep = -1;
    this.shownPhase = '';
    setText(this.ackHint, def.tryItHint);
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
    this.build(s);
    const def = this.def!;
    const racer = s.players[0]?.characterId ?? 'max';
    if (racer !== this.demoRacer) {
      this.demoRacer = racer;
      this.panels.forEach((p, i) => {
        p.querySelector('.kp-tut-demo')!.innerHTML = def.steps[i].demo(racer);
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
      let look: CharacterLook | null = null;
      try {
        look = s.modules[t.game].look(p.characterId);
      } catch {
        look = null;
      }
      chip.set(p, look);
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
    const def = this.def!;
    const ack = phase === 'ack';
    this.dots.forEach((d, i) => {
      toggle(d, 'kp-on', i <= step);
      toggle(d, 'kp-cur', i === step && !ack);
    });
    this.panels.forEach((p, i) => toggle(p, 'kp-on', i === step && !ack));
    toggle(this.ackPanel, 'kp-on', ack);
    if (!ack && this.panels[step]) replay(this.panels[step], 'kp-panel-in');

    // Phone zone highlight + callout.
    const zone = def.steps[step]?.zone ?? '';
    this.phone.querySelectorAll<SVGGElement>('.kp-zone').forEach((g) => {
      const on = !ack && g.dataset.zone === zone;
      g.classList.toggle('kp-hl', on);
      g.classList.toggle('kp-dim', !ack && !on);
    });
    for (const st of def.steps) this.phone.classList.toggle(`kp-step-${st.zone}`, !ack && st.zone === zone);
    toggle(this.phoneWrap, 'kp-ack-phase', ack);

    const [pw, ph] = def.phoneSize;
    if (ack) {
      setText(this.calloutText, 'GOT IT!');
      this.placeCallout([pw / 2, ph / 2]);
      this.callout.classList.add('kp-callout-gotit');
      this.ackBar.style.animation = 'none';
      void this.ackBar.offsetWidth;
      this.ackBar.style.animation = `kp-shrink ${TUTORIAL_ACK_WAIT_MS}ms linear forwards`;
      if (phaseChanged) blip('done');
    } else {
      this.callout.classList.remove('kp-callout-gotit');
      setText(this.calloutText, def.steps[step]?.label ?? '');
      this.placeCallout(def.zoneAnchor[zone] ?? [pw / 2, ph / 2]);
      blip('step');
    }
    replay(this.callout, 'kp-callout-in');
    this.progress.style.animation = 'none';
    void this.progress.offsetWidth;
    const ms = step === 0 && def.firstStepMs ? def.firstStepMs : def.stepMs;
    this.progress.style.animation = ack ? 'none' : `kp-grow ${ms}ms linear forwards`;
    this.progress.style.width = ack ? '100%' : '';
  }

  private placeCallout([x, y]: [number, number]): void {
    const [pw, ph] = this.def!.phoneSize;
    this.callout.style.left = `${(x / pw) * 100}%`;
    this.callout.style.top = `${(y / ph) * 100}%`;
  }

  tryIt(playerId: string, kind: 'drift' | 'item', label: string): void {
    this.chips.get(playerId)?.tryIt(kind, label);
  }
}
