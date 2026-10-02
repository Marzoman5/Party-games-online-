/** A screen with one implementation per game (setup, ...): shows the active game's view. */
import type { GameId } from '../../net/protocol';
import { activeGame, type ViewId } from '../store';
import { h } from '../ui';
import type { View } from './view';

export class ByGameView implements View {
  readonly el: HTMLElement;
  private cur: View | null = null;
  private entered: ViewId | null = null;

  constructor(private readonly views: Partial<Record<GameId, View>> & { kart: View }) {
    this.el = h('div', { class: 'by-game' });
  }

  private pick(): View {
    return this.views[activeGame()] ?? this.views.kart;
  }

  enter(view: ViewId): void {
    this.entered = view;
    this.swap(view);
  }

  leave(): void {
    this.cur?.leave?.();
    this.cur?.el.remove();
    this.cur = null;
    this.entered = null;
  }

  private swap(view: ViewId): void {
    const v = this.pick();
    if (v === this.cur) return;
    if (this.cur) {
      this.cur.leave?.();
      this.cur.el.remove();
    }
    this.cur = v;
    this.el.append(v.el);
    v.enter?.(view);
  }

  update(view: ViewId): void {
    if (this.entered === null) this.entered = view;
    this.swap(view);
    this.cur?.update(view);
  }
}
