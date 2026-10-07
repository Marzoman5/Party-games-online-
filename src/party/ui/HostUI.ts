/**
 * HostUI — owns the `#party` overlay root (z-index 50, above the engine HUDs) and swaps the
 * per-screen overlays. Generic screens (title, lobby/hub, tutorial, race chip, pause) are shared
 * by every game; setup / results / sandbox (and optionally race) views come from the active
 * game module (`GameModule.createViews`). All views are built once and re-used.
 *
 * Test ids: each screen marks its elements with `data-tid`; only the ACTIVE screen gets real
 * `data-testid`s so Playwright locators never match a hidden duplicate.
 */
import type { GameId, ScreenId } from '../../net/protocol';
import type { PartySession } from '../../engine/PartySession';
import type { Display } from '../../engine/display';
import { button, h, setText, toggle } from './dom';
import { TitleScreen } from './TitleScreen';
import { LobbyScreen } from './LobbyScreen';
import { TutorialScreen } from './TutorialScreen';
import { PauseOverlay } from './PauseOverlay';
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

type CommonKey = 'title' | 'lobby' | 'tutorial' | 'race' | 'paused';
type ModuleKey = 'setup' | 'results' | 'sandbox' | 'race';
/** 'title' … or `${game}:${moduleKey}` or 'none'. */
type ViewKey = string;

export class HostUI {
  readonly root: HTMLDivElement;
  private readonly common: Record<CommonKey, ScreenView>;
  private readonly moduleViews = new Map<string, ScreenView>();
  private active: ViewKey = 'none';
  private readonly toolbar: HTMLDivElement;
  private readonly tvBtn: HTMLButtonElement;
  private readonly fsBtn: HTMLButtonElement;
  private readonly banner: HTMLDivElement;
  private readonly bannerText: HTMLSpanElement;
  private readonly replaced: HTMLDivElement;
  private readonly loadingGame: HTMLDivElement;
  private readonly loadingGameText = h('span');
  /** "👀 watching this one" chip (Kart/Smash with more players than seats). */
  private readonly watchChip = h('div', { class: 'kp-watch-chip', 'data-testid': 'watch-chip' });
  private watchShownAt = 0;
  private watchKey = '';
  private renderQueued = 0;
  private bannerSince = 0;

  constructor(private readonly ctx: UiContext) {
    this.root = h('div', { id: 'party', class: 'kp-root' });
    const s = ctx.session;
    this.common = {
      title: new TitleScreen(ctx),
      lobby: new LobbyScreen(ctx),
      tutorial: new TutorialScreen(ctx),
      race: new RaceOverlay(ctx),
      paused: new PauseOverlay(ctx),
    };
    for (const v of Object.values(this.common)) this.add(v);
    for (const id of Object.keys(s.modules) as GameId[]) {
      let views;
      try {
        views = s.modules[id].createViews(ctx);
      } catch (err) {
        console.error(`[party] ${id} views failed`, err);
        continue;
      }
      for (const [k, v] of Object.entries(views) as [ModuleKey, ScreenView | undefined][]) {
        if (!v) continue;
        v.root.dataset.game = id;
        this.moduleViews.set(`${id}:${k}`, v);
        this.add(v);
      }
    }

    // Shared toolbar (title / lobby / setup).
    const howto = button('<span class="kp-ico">❓</span> How to Play', 'kp-tool', () => s.hostHowTo(), 'btn-howto');
    this.tvBtn = button('', 'kp-tool', () => ctx.display.toggleTv(), 'btn-tv');
    this.fsBtn = button('', 'kp-tool', () => ctx.display.toggleFullscreen(), 'btn-fullscreen');
    this.toolbar = h('div', 'kp-toolbar', howto, this.tvBtn, this.fsBtn);
    this.root.appendChild(this.toolbar);

    // Server connection banner.
    this.bannerText = h('span', { text: 'Reconnecting to game server…' });
    this.banner = h('div', { class: 'kp-banner', 'data-testid': 'net-banner' }, h('span', 'kp-spinner'), this.bannerText);
    this.root.appendChild(this.banner);

    // Lazy game engine loading (game switch).
    this.loadingGame = h('div', { class: 'kp-banner kp-banner-game', 'data-testid': 'game-loading' }, h('span', 'kp-spinner'), this.loadingGameText);
    this.root.appendChild(this.loadingGame);
    this.root.appendChild(this.watchChip);

    // "Opened in another tab" blocker.
    this.replaced = h(
      'div',
      'kp-replaced',
      h(
        'div',
        'kp-panel kp-replaced-panel',
        h('div', { class: 'kp-h2', text: 'Party Hub is open in another tab' }),
        h('p', { text: 'Only one screen can host the party. Close the other tab, or take over here.' }),
        button('Use this tab', 'kp-primary', () => ctx.reclaim()),
      ),
    );
    this.root.appendChild(this.replaced);

    ctx.display.onChange = () => this.render();
  }

  private add(v: ScreenView): void {
    v.root.classList.add('kp-screen');
    this.root.appendChild(v.root);
  }

  private view(key: ViewKey): ScreenView | null {
    if (key === 'none') return null;
    return (this.common as Record<string, ScreenView>)[key] ?? this.moduleViews.get(key) ?? null;
  }

  /**
   * Coalesce renders (one per task). A macrotask rather than requestAnimationFrame: on slow GPUs
   * the WebGL frame can take ~1 s, and the overlays (and their testids) must not lag behind state.
   */
  render(): void {
    if (this.renderQueued) return;
    this.renderQueued = window.setTimeout(() => {
      this.renderQueued = 0;
      this.renderNow();
    }, 0);
  }

  renderNow(): void {
    const s = this.ctx.session;
    const key = this.viewFor(s.screen, s);
    if (key !== this.active) {
      const prev = this.view(this.active);
      if (prev) {
        prev.root.classList.remove('kp-on');
        this.setTestIds(prev.root, false);
        prev.hide?.();
      }
      this.active = key;
      const next = this.view(key);
      if (next) {
        next.update(s);
        next.root.classList.add('kp-on');
        this.setTestIds(next.root, true);
        next.show?.();
      }
    }
    const cur = this.view(this.active);
    if (cur) {
      cur.update(s);
      this.setTestIds(cur.root, true);
    }
    document.documentElement.dataset.game = s.gameId;

    const d = this.ctx.display;
    const base = key.includes(':') ? key.split(':')[1] : key;
    const toolbarOn = !s.soloActive && (base === 'title' || base === 'lobby' || base === 'setup');
    toggle(this.toolbar, 'kp-on', toolbarOn);
    toggle(this.toolbar, 'kp-toolbar-low', base === 'setup');
    this.tvBtn.innerHTML = `<span class="kp-ico">📺</span> TV mode: <b>${d.tvMode ? 'ON' : 'OFF'}</b>`;
    this.fsBtn.innerHTML = `<span class="kp-ico">⛶</span> ${d.isFullscreen ? 'Exit fullscreen' : 'Fullscreen'} <kbd>F</kbd>`;

    // Banner: only after a successful first connection, and only if the outage lasts a moment.
    const down = s.hostedOnce && (s.netStatus === 'down' || s.netStatus === 'connecting');
    if (down && !this.bannerSince) this.bannerSince = performance.now();
    if (!down) this.bannerSince = 0;
    toggle(this.banner, 'kp-on', down);
    setText(this.bannerText, 'Reconnecting to game server…');
    toggle(this.replaced, 'kp-on', s.netStatus === 'replaced');
    toggle(this.loadingGame, 'kp-on', !!s.switching);
    this.renderWatchChip(s);
    if (s.switching) setText(this.loadingGameText, `Loading ${s.modules[s.switching].info.title}…`);

    // Cursor: hidden while the engine is loading / flying in / counting down / playing.
    let racingish = false;
    try {
      racingish = s.game.isLive() || s.game.phase === 'loading';
    } catch {
      racingish = false;
    }
    d.setCursorHidden(racingish && (s.screen === 'race' || s.screen === 'loading' || s.soloActive));
  }

  /**
   * Kart/Smash seat at most `maxPlayers`: say clearly who watches this one. Always on setup/results;
   * during loading/race only for the first seconds (it must not cover the race HUD).
   */
  private renderWatchChip(s: PartySession): void {
    const mod = s.game;
    let names: string[] = [];
    if (!mod.dropIn && !s.soloActive) {
      if (s.screen === 'setup') {
        const ready = s.connectedPlayers.filter((p) => p.ready && !p.late).sort((a, b) => a.joinSeq - b.joinSeq);
        names = ready.slice(mod.info.maxPlayers).map((p) => p.name);
      } else if (s.screen === 'loading' || s.screen === 'race' || s.screen === 'results' || s.screen === 'paused') {
        names = s.watchers.map((p) => p.name);
      }
    }
    const key = names.join('|');
    if (key !== this.watchKey) {
      this.watchKey = key;
      this.watchShownAt = performance.now();
      if (names.length) {
        const list = names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
        setText(this.watchChip, `👀 ${mod.info.maxPlayers} play ${mod.info.title} at once · watching this one: ${list}`);
        window.setTimeout(() => this.render(), 8200);
      }
    }
    const inRace = s.screen === 'loading' || s.screen === 'race';
    const on = names.length > 0 && (!inRace || performance.now() - this.watchShownAt < 8000);
    toggle(this.watchChip, 'kp-on', on);
  }

  private viewFor(screen: ScreenId, s: PartySession): ViewKey {
    if (s.soloActive) return 'none';
    const g = s.gameId;
    const mod = (k: ModuleKey, fallback: ViewKey): ViewKey => (this.moduleViews.has(`${g}:${k}`) ? `${g}:${k}` : fallback);
    switch (screen) {
      case 'title':
        return 'title';
      case 'lobby':
      case 'waiting':
        return 'lobby';
      case 'tutorial':
        return 'tutorial';
      case 'setup':
        return mod('setup', 'lobby');
      case 'sandbox':
        return mod('sandbox', 'race');
      case 'loading':
      case 'race':
        return mod('race', 'race');
      case 'paused':
        return 'paused';
      case 'results':
        return s.results && s.results.game !== g ? 'lobby' : mod('results', 'lobby');
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
  tryIt(playerId: string, kind: 'drift' | 'item', label: string): void {
    const v = this.active === 'tutorial' ? this.common.tutorial : this.active === 'lobby' ? this.common.lobby : null;
    (v as unknown as { tryIt?: (id: string, k: 'drift' | 'item', l: string) => void } | null)?.tryIt?.(playerId, kind, label);
  }

  tutorialStep(): void {
    (this.common.tutorial as TutorialScreen).onStep();
  }

  dispose(): void {
    window.clearTimeout(this.renderQueued);
    for (const v of Object.values(this.common)) v.dispose?.();
    for (const v of this.moduleViews.values()) v.dispose?.();
    this.ctx.display.onChange = null;
    this.root.remove();
  }
}
