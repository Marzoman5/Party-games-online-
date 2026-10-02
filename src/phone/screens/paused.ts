/** Pause overlay: leader controls the race; everyone else votes to resume. */
import { net } from '../net';
import { state, type ViewId } from '../store';
import { button, h, setText, show } from '../ui';
import type { View } from './view';

export class PausedView implements View {
  readonly el: HTMLElement;
  private by: HTMLElement;
  private resume: HTMLButtonElement;
  private restart: HTMLButtonElement;
  private quit: HTMLButtonElement;
  private votes: HTMLElement;
  private voted = false;

  constructor() {
    this.by = h('div', { class: 'pause-by', testid: 'paused-by' });
    this.votes = h('div', { class: 'pause-votes', testid: 'pause-votes' });
    this.resume = button('▶ Resume', 'btn-resume', () => {
      this.voted = true;
      net.send({ t: 'resume' });
      this.update('paused');
    }, 'btn btn-start');
    this.restart = button('↻ Restart race', 'btn-restart', () => net.send({ t: 'restart' }), 'btn btn-alt');
    this.quit = button('⌂ Quit to lobby', 'btn-quit', () => net.send({ t: 'quit' }), 'btn btn-alt btn-danger');
    this.el = h(
      'div',
      { class: 'screen paused', testid: 'screen-paused' },
      h(
        'div',
        { class: 'pause-card' },
        h('div', { class: 'pause-icon' }, h('span', { class: 'pause-glyph' })),
        h('div', { class: 'pause-title', text: 'PAUSED' }),
        this.by,
        h('div', { class: 'pause-btns' }, this.resume, this.restart, this.quit),
        this.votes,
      ),
    );
  }

  enter(): void {
    this.voted = false;
  }

  update(_view: ViewId): void {
    const ps = state.phone;
    const p = ps?.pause;
    const leader = !!ps?.you?.isLeader;
    let byName = p?.by ?? '';
    const found = ps?.players.find((x) => x.playerId === byName);
    if (found) byName = found.playerId === state.playerId ? 'you' : found.name;
    setText(this.by, byName ? `Paused by ${byName}` : '');
    show(this.restart, leader);
    show(this.quit, leader);
    const votes = p?.votes ?? 0;
    const needed = p?.needed ?? 1;
    if (leader) {
      setText(this.resume, '▶ Resume');
      this.resume.disabled = false;
      setText(this.votes, votes > 0 ? `${votes}/${needed} voted to resume` : '');
    } else {
      setText(this.resume, this.voted ? `✓ Voted (${votes}/${needed})` : `▶ Vote to resume (${votes}/${needed})`);
      this.resume.disabled = this.voted;
      setText(this.votes, 'The leader can also resume');
    }
  }
}
