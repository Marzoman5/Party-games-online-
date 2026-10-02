/**
 * PAUSED — who paused, resume vote pips (x/y), and host mouse fallbacks.
 */
import { SLOT_COLORS } from '../../net/protocol';
import type { PartySession } from '../PartySession';
import type { ScreenView, UiContext } from './HostUI';
import { button, h, setText } from './dom';

export class PauseOverlay implements ScreenView {
  readonly root: HTMLDivElement;
  private readonly by = h('div', 'kp-pause-by');
  private readonly votes = h('div', 'kp-votes');
  private readonly voteText = h('div', 'kp-vote-text');
  private readonly hint = h('div', 'kp-pause-hint');

  constructor(ctx: UiContext) {
    const s = ctx.session;
    this.root = h(
      'div',
      { class: 'kp-pause', 'data-tid': 'screen-paused' },
      h('div', 'kp-scrim kp-scrim-strong'),
      h(
        'div',
        { class: 'kp-panel kp-pause-panel', 'data-tid': 'pause-overlay' },
        h('div', 'kp-pause-title', 'PAUSED'),
        this.by,
        this.votes,
        this.voteText,
        this.hint,
        h(
          'div',
          'kp-host-actions',
          button('▶ Resume <kbd>Esc</kbd>', 'kp-primary', () => s.hostResume(), 'btn-resume'),
          button('↻ Restart', '', () => s.hostRestart(), 'btn-restart'),
          button('Quit to lobby', 'kp-danger', () => s.hostQuit(), 'btn-quit'),
        ),
      ),
    );
  }

  update(s: PartySession): void {
    const p = s.pause;
    if (!p) return;
    setText(this.by, `Paused by ${p.by}`);
    const needed = s.resumeNeeded;
    const n = p.voters.size;
    if (this.votes.childElementCount !== needed) {
      this.votes.replaceChildren(...Array.from({ length: needed }, () => h('span', 'kp-vote')));
    }
    Array.from(this.votes.children).forEach((c, i) => c.classList.toggle('kp-on', i < n));
    setText(this.voteText, `Resume votes ${n}/${needed}`);
    const leader = s.leader;
    setText(
      this.hint,
      leader
        ? `${leader.name} (leader): resume / restart / quit on your phone · others: tap RESUME to vote`
        : 'Leader: resume / restart / quit on your phone',
    );
    if (leader) this.hint.style.setProperty('--slot', SLOT_COLORS[leader.slot]);
  }
}
