/**
 * Tutorial card mirror (shared by every controller layout). Shows the host's current
 * tutorial step (`PhoneState.tutorial.step`) with the layout's own step texts, "Got it!"
 * (`tut_ok`) and the leader's Skip (`tut_skip`). The layout highlights the matching control.
 */
import { haptic } from '../haptics';
import { net } from '../net';
import { state } from '../store';
import { button, h, setHtml, setText, show } from '../ui';

export interface TutorialStepText {
  title: string;
  text: string;
  sub?: string;
}

export class TutorialCard {
  readonly el: HTMLElement;
  private dots: HTMLElement;
  private title: HTMLElement;
  private text: HTMLElement;
  private sub: HTMLElement;
  private gotIt: HTMLButtonElement;
  private skip: HTMLButtonElement;
  private done: HTMLElement;
  private acked = false;
  private step = -1;
  /** Called after "Got it!" so the layout can re-render. */
  onChange: () => void = () => {};

  constructor() {
    this.dots = h('div', { class: 'tut-dots' });
    this.title = h('div', { class: 'tut-title' });
    this.text = h('div', { class: 'tut-text', testid: 'tutorial-caption' });
    this.sub = h('div', { class: 'tut-sub' });
    this.gotIt = button(
      'Got it! 👍',
      'btn-gotit',
      () => {
        this.acked = true;
        net.send({ t: 'tut_ok' });
        this.onChange();
      },
      'btn btn-gotit',
    );
    this.skip = button('Skip ⏭', 'btn-skip', () => net.send({ t: 'tut_skip' }), 'btn btn-skip');
    this.done = h('div', { class: 'tut-done', testid: 'tutorial-waiting' });
    for (const b of [this.gotIt, this.skip]) b.setAttribute('data-click', '');
    this.el = h(
      'div',
      { class: 'tut-card', testid: 'tutorial-card', 'data-click': '' },
      h('div', { class: 'tut-head' }, h('span', { class: 'tut-badge', text: 'HOW TO PLAY' }), this.dots),
      this.title,
      this.text,
      this.sub,
      h('div', { class: 'tut-actions' }, this.gotIt, this.done, this.skip),
    );
  }

  /** Current step index clamped to the layout's step list. */
  currentStep(count: number): number {
    const t = state.phone?.tutorial;
    return Math.max(0, Math.min(count - 1, t?.step ?? 0));
  }

  /** Forget the local "Got it!" (tutorial left). */
  reset(): void {
    this.acked = false;
    this.step = -1;
  }

  render(step: number, count: number, s: TutorialStepText): void {
    const total = state.phone?.tutorial?.total ?? count;
    if (step !== this.step) {
      this.step = step;
      this.el.classList.remove('pop');
      void this.el.offsetWidth;
      this.el.classList.add('pop');
      haptic('tick');
    }
    const dots = Array.from({ length: total }, (_, i) => `<i class="${i === step ? 'on' : i < step ? 'done' : ''}"></i>`).join('');
    setHtml(this.dots, dots);
    setText(this.title, `${step + 1}. ${s.title}`);
    setText(this.text, s.text);
    setText(this.sub, s.sub ?? '');
    show(this.sub, !!s.sub);
    this.el.setAttribute('data-step', String(step));

    const ps = state.phone;
    const you = ps?.you;
    const done = this.acked || !!you?.tutorialDone;
    show(this.gotIt, !done);
    show(this.done, done);
    if (done) {
      const players = (ps?.players ?? []).filter((p) => p.connected);
      const n = players.filter((p) => p.tutorialDone || (p.playerId === state.playerId && this.acked)).length;
      setText(this.done, `✓ Waiting for others… (${n}/${players.length || 1})`);
    }
    show(this.skip, !!you?.isLeader);
  }
}
