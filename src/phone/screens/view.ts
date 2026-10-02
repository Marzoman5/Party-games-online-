import type { ViewId } from '../store';

/** A mounted screen. `update` is called on every store change and ~4x/s. */
export interface View {
  readonly el: HTMLElement;
  update(view: ViewId): void;
  /** Screen is being shown (after being hidden). */
  enter?(view: ViewId): void;
  /** Screen is being hidden. */
  leave?(): void;
}
