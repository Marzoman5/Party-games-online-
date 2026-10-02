/** "Get ready!" while the host builds the track: track name + controls cheat-sheet. */
import { state, type ViewId } from '../store';
import { settings } from '../settings';
import { THEME_COLORS, h, setText, trackById } from '../ui';
import type { View } from './view';

export class LoadingView implements View {
  readonly el: HTMLElement;
  private track: HTMLElement;
  private gp: HTMLElement;
  private diagram: HTMLElement;

  constructor() {
    this.track = h('div', { class: 'load-track', testid: 'loading-track' });
    this.gp = h('div', { class: 'load-gp' });
    this.diagram = h('div', { class: 'diagram' });
    this.el = h(
      'div',
      { class: 'screen loading', testid: 'screen-loading' },
      h('div', { class: 'load-head' }, h('div', { class: 'get-ready', text: 'Get ready!' }), this.track, this.gp),
      this.diagram,
      h('div', { class: 'load-tip', text: '📱 Turn your phone sideways and hold it with both thumbs' }),
    );
  }

  update(_view: ViewId): void {
    const ps = state.phone;
    const t = trackById(ps?.setup.trackId);
    setText(this.track, t ? `${t.name} · ${ps?.setup.cc ?? 100}cc · ${ps?.setup.laps ?? 3} laps` : '');
    this.track.style.color = t ? (THEME_COLORS[t.theme]?.[0] ?? '#fff') : '#fff';
    setText(this.gp, ps?.gp ? `Grand Prix — race ${ps.gp.race} of ${ps.gp.of}` : '');
    const left = settings.leftHanded;
    const steer = `<div class="dg-side dg-steer"><b>◀ STEER ▶</b><small>${settings.tilt ? 'tilt the phone or drag' : 'drag left / right'}</small></div>`;
    const btns = `<div class="dg-side dg-btns"><span class="dg-b dg-item">ITEM</span><span class="dg-b dg-drift">DRIFT</span><span class="dg-b dg-gas">${settings.autoAccelerate ? 'GAS<br><small>auto</small>' : 'GAS'}</span><span class="dg-b dg-brake">BRAKE</span></div>`;
    const html = left ? btns + steer : steer + btns;
    if (this.diagram.innerHTML !== html) this.diagram.innerHTML = html;
  }
}
