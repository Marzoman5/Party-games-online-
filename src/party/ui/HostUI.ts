/**
 * HostUI — owns the `#party` overlay root (z-index 50, above the engine HUD) and swaps the
 * per-screen overlays. All screens are built once and re-used (no DOM churn across races).
 *
 * Test ids: each screen marks its elements with `data-tid`; only the ACTIVE screen gets real
 * `data-testid`s so Playwright locators never match a hidden duplicate.
 */
import type { ScreenId } from '../../net/protocol';
import type { PartySession } from '../PartySession';
import type { Display } from '../display';
import { button, h, setText, toggle } from './dom';
import { TitleScreen } from './TitleScreen';
import { LobbyScreen } from './LobbyScreen';
import { TutorialScreen } from './TutorialScreen';
import { SetupScreen } from './SetupScreen';
import { PauseOverlay } from './PauseOverlay';
import { ResultsOverlay } from './ResultsOverlay';
import { RaceOverlay } from './RaceOverlay';

export interface UiContext {
  session: PartySession;
  display: Display;
  apiBase: string;
  /** Re-take the room after another tab took over. */
  reclaim(): void;
}

export interface ScreenView {
  readonly root: HTMLElement;
  update(s: PartySession): void;
  show?(): void;
  hide?(): void;
  dispose?(): void;
}

type ViewKey = 'title' | 'lobby' | 'tutorial' | 'setup' | 'race' | 'paused' | 'results' | 'none';

export class HostUI {
  readonly root: HTMLDivElement;
  private readonly views: Record<Exclude<ViewKey, 'none'>, ScreenView>;
  private active: ViewKey = 'none';
  private readonly toolbar: HTMLDivElement;
  private readonly tvBtn: HTMLButtonElement;
  private readonly fsBtn: HTMLButtonElement;
  private readonly banner: HTMLDivElement;
  private readonly bannerText: HTMLSpanElement;
  private readonly replaced: HTMLDivElement;
  private renderQueued = 0;
  private bannerSince = 0;

  constructor(private readonly ctx: UiContext) {
    this.root = h('div', { id: 'party', class: 'kp-root' });
    const s = ctx.session;
    this.views = {
      title: new TitleScreen(ctx),
      lobby: new LobbyScreen(ctx),
      tutorial: new TutorialScreen(ctx),
      setup: new SetupScreen(ctx),
      race: new RaceOverlay(ctx),
      paused: new PauseOverlay(ctx),
      results: new ResultsOverlay(ctx),
    };
    for (const v of Object.values(this.views)) {
      v.root.classList.add('kp-screen');
      this.root.appendChild(v.root);
    }

    // Shared toolbar (title / lobby / setup / results).
    const howto = button('<span class="kp-ico">❓</span> How to Play', 'kp-tool', () => s.hostHowTo(), 'btn-howto');
    this.tvBtn = button('', 'kp-tool', () => ctx.display.toggleTv(), 'btn-tv');
    this.fsBtn = button('', 'kp-tool', () => ctx.display.toggleFullscreen(), 'btn-fullscreen');
    this.toolbar = h('div', 'kp-toolbar', howto, this.tvBtn, this.fsBtn);
    this.root.appendChild(this.toolbar);

    // Server connection banner.
    this.bannerText = h('span', { text: 'Reconnecting to game server…' });
    this.banner = h('div', { class: 'kp-banner', 'data-testid': 'net-banner' }, h('span', 'kp-spinner'), this.bannerText);
    this.root.appendChild(this.banner);

    // "Opened in another tab" blocker.
    this.replaced = h(
      'div',
      'kp-replaced',
      h(
        'div',
        'kp-panel kp-replaced-panel',
        h('div', { class: 'kp-h2', text: 'Kart Party is open in another tab' }),
        h('p', { text: 'Only one screen can host the party. Close the other tab, or take over here.' }),
        button('Use this tab', 'kp-primary', () => ctx.reclaim()),
      ),
    );
    this.root.appendChild(this.replaced);

    ctx.display.onChange = () => this.render();
  }

  /** Coalesce renders to one per animation frame. */
  render(): void {
    if (this.renderQueued) return;
    this.renderQueued = requestAnimationFrame(() => {
      this.renderQueued = 0;
      this.renderNow();
    });
  }

  renderNow(): void {
    const s = this.ctx.session;
    const key = this.viewFor(s.screen, s);
    if (key !== this.active) {
      const prev = this.active !== 'none' ? this.views[this.active] : null;
      if (prev) {
        prev.root.classList.remove('kp-on');
        this.setTestIds(prev.root, false);
        prev.hide?.();
      }
      this.active = key;
      const next = key !== 'none' ? this.views[key] : null;
      if (next) {
        next.update(s);
        next.root.classList.add('kp-on');
        this.setTestIds(next.root, true);
        next.show?.();
      }
    }
    if (this.active !== 'none') {
      this.views[this.active].update(s);
      this.setTestIds(this.views[this.active].root, true);
    }

    const d = this.ctx.display;
    const toolbarOn = !s.soloActive && (key === 'title' || key === 'lobby' || key === 'setup');
    toggle(this.toolbar, 'kp-on', toolbarOn);
    toggle(this.toolbar, 'kp-toolbar-low', key === 'setup');
    this.tvBtn.innerHTML = `<span class="kp-ico">📺</span> TV mode: <b>${d.tvMode ? 'ON' : 'OFF'}</b>`;
    this.fsBtn.innerHTML = `<span class="kp-ico">⛶</span> ${d.isFullscreen ? 'Exit fullscreen' : 'Fullscreen'} <kbd>F</kbd>`;

    // Banner: only after a successful first connection, and only if the outage lasts a moment.
    const down = s.hostedOnce && (s.netStatus === 'down' || s.netStatus === 'connecting');
    if (down && !this.bannerSince) this.bannerSince = performance.now();
    if (!down) this.bannerSince = 0;
    toggle(this.banner, 'kp-on', down);
    setText(this.bannerText, 'Reconnecting to game server…');
    toggle(this.replaced, 'kp-on', s.netStatus === 'replaced');

    // Cursor: hidden while the engine is loading / flying in / counting down / racing.
    const ph = s.game.phase;
    const racingish = ph === 'loading' || ph === 'intro' || ph === 'countdown' || ph === 'racing' || ph === 'finished';
    d.setCursorHidden(racingish && (s.screen === 'race' || s.screen === 'loading' || s.soloActive));
  }

  private viewFor(screen: ScreenId, s: PartySession): ViewKey {
    if (s.soloActive) return 'none';
    switch (screen) {
      case 'title':
        return 'title';
      case 'lobby':
      case 'waiting':
        return 'lobby';
      case 'tutorial':
        return 'tutorial';
      case 'setup':
        return 'setup';
      case 'loading':
      case 'race':
        return 'race';
      case 'paused':
        return 'paused';
      case 'results':
        return 'results';
    }
    return 'none';
  }

  private setTestIds(root: HTMLElement, on: boolean): void {
    if (root.dataset.tid) {
      if (on) root.setAttribute('data-testid', root.dataset.tid);
      else root.removeAttribute('data-testid');
    }
    root.querySelectorAll<HTMLElement>('[data-tid]').forEach((n) => {
      const id = n.dataset.tid!;
      if (on) {
        if (n.getAttribute('data-testid') !== id) n.setAttribute('data-testid', id);
      } else n.removeAttribute('data-testid');
    });
  }

  /** Visual feedback for the "try it" moment (lobby + tutorial). */
  tryIt(playerId: string, kind: 'drift' | 'item'): void {
    const v = this.active === 'tutorial' ? this.views.tutorial : this.active === 'lobby' ? this.views.lobby : null;
    (v as unknown as { tryIt?: (id: string, k: 'drift' | 'item') => void } | null)?.tryIt?.(playerId, kind);
  }

  tutorialStep(): void {
    (this.views.tutorial as TutorialScreen).onStep();
  }

  dispose(): void {
    cancelAnimationFrame(this.renderQueued);
    for (const v of Object.values(this.views)) v.dispose?.();
    this.ctx.display.onChange = null;
    this.root.remove();
  }
}
