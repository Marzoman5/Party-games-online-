/**
 * App shell (the controller framework): picks the view for the current host screen, mounts
 * the active game's controller layout (kart / fighter) for in-game screens, corner status,
 * banners, rotate overlay, gestures, wake lock + fullscreen. See framework/layout.ts.
 */
import { SLOT_COLORS, type ServerToPhone } from '../net/protocol';
import { layoutForGame, type ControllerLayout, type LayoutId } from './framework/layout';
import { haptic } from './haptics';
import { net } from './net';
import { profileOnJoined, profileOnState } from './profile';
import { onSettings, settings } from './settings';
import { activeGame, currentView, setState, state, subscribe, type ViewId } from './store';
import { tilt } from './tilt';
import { requestFullscreen, requestWakeLock, setWantOrientation } from './system';
import { RushView } from './rush/RushView';
import { button, h, setText, show, toggleClass } from './ui';
import { ByGameView } from './screens/byGame';
import { ControllerView } from './screens/controller';
import { FighterView } from './screens/fighter';
import { ErrorView, JoinView } from './screens/join';
import { LoadingView } from './screens/loading';
import { LobbyView } from './screens/lobby';
import { PausedView } from './screens/paused';
import { ResultsView } from './screens/results';
import { SettingsPanel } from './screens/settingsPanel';
import { SetupView } from './screens/setup';
import { SmashSetupView } from './screens/smashSetup';
import type { View } from './screens/view';

/** Screens that show a controller layout (inputs live). */
export const CONTROLLER_VIEWS: ViewId[] = ['race', 'tutorial', 'sandbox'];
const CLEAR_RACE_ON: string[] = ['loading', 'lobby', 'setup', 'tutorial', 'title', 'waiting', 'sandbox'];

/** Layout registry: a third game adds its factory here + a LAYOUT_FOR_GAME entry. */
const LAYOUT_FACTORIES: Record<LayoutId, () => ControllerLayout> = {
  kart: () => new ControllerView(),
  fighter: () => new FighterView(),
  rush: () => new RushView(),
};

export class App {
  readonly root: HTMLElement;
  private stage: HTMLElement;
  private views: Record<string, View>;
  private layouts = new Map<LayoutId, ControllerLayout>();
  /** Layout of the active game (mounted while on a controller screen). */
  layoutId: LayoutId = 'kart';
  private current: View | null = null;
  private currentId: ViewId | null = null;
  private dot: HTMLElement;
  private ping: HTMLElement;
  private hostBanner: HTMLElement;
  private connBanner: HTMLElement;
  private rotate: HTMLElement;
  private settingsPanel: SettingsPanel;
  private roomTag: HTMLElement;
  private reconnectingSince = 0;
  private connEl: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    const lobby = new LobbyView();
    this.views = {
      join: new JoinView(),
      error: new ErrorView(),
      connecting: lobby,
      title: lobby,
      lobby,
      waiting: lobby,
      setup: new ByGameView({ kart: new SetupView(), smash: new SmashSetupView() }),
      loading: new LoadingView(),
      paused: new PausedView(),
      results: new ResultsView(),
    };
    this.stage = h('div', { class: 'stage' });

    // Corner status: connection dot + ping + settings (single instance for every screen).
    this.dot = h('span', { class: 'dot', testid: 'conn-dot' });
    this.ping = h('span', { class: 'ping', testid: 'conn-ping' });
    this.roomTag = h('span', { class: 'room-tag', testid: 'room-code' });
    this.settingsPanel = new SettingsPanel();
    const gear = button('⚙️', 'btn-settings', () => this.settingsPanel.open(), 'top-btn gear-btn');
    gear.setAttribute('data-click', '');
    gear.setAttribute('aria-label', 'Settings');
    this.connEl = h('span', { class: 'conn' }, this.dot, this.ping);
    const corner = h('div', { class: 'corner' }, this.roomTag, this.connEl, gear);

    this.hostBanner = h('div', { class: 'banner host-banner', testid: 'host-banner' }, h('span', { class: 'spin' }), 'Waiting for the game screen…');
    this.connBanner = h('div', { class: 'banner conn-banner', testid: 'conn-banner' }, h('span', { class: 'spin' }), 'Reconnecting…');
    this.rotate = h(
      'div',
      { class: 'rotate', testid: 'rotate-overlay' },
      h('div', { class: 'rotate-phone' }, h('i')),
      h('div', { class: 'rotate-text', text: 'Rotate your phone ↻' }),
      h('small', { text: 'The controller works sideways — hold it with both thumbs' }),
    );
    show(this.hostBanner, false);
    show(this.connBanner, false);
    show(this.rotate, false);

    root.append(h('div', { class: 'bg' }), this.stage, corner, this.hostBanner, this.connBanner, this.rotate, this.settingsPanel.el);
    // The kart layout exists from the start (default game, pre-hub hosts).
    this.getLayout('kart');

    net.onMessage = (m) => this.onMessage(m);
    subscribe(() => this.render());
    onSettings(() => {
      for (const l of this.layouts.values()) l.layout();
      this.render();
    });
    window.addEventListener('resize', () => this.render());
    setInterval(() => this.render(), 250);
    this.installGestures();
    this.render();
  }

  private onMessage(m: ServerToPhone): void {
    if (Array.isArray(m)) return;
    switch (m.t) {
      case 'joined':
        profileOnJoined();
        break;
      case 'state': {
        const prev = state.phone?.screen;
        const prevGame = state.phone?.game;
        const patch: Partial<typeof state> = { phone: m };
        if (prev !== m.screen && CLEAR_RACE_ON.includes(m.screen)) {
          patch.race = null;
          patch.fight = null;
        }
        if (prevGame !== m.game) {
          patch.race = null;
          patch.fight = null;
          if (prevGame === 'rush' || m.game === 'rush') patch.rush = null;
        }
        profileOnState(m);
        setState(patch);
        break;
      }
      case 'race':
        setState({ race: m, raceAt: performance.now() });
        break;
      case 'fight':
        setState({ fight: m, fightAt: performance.now() });
        break;
      case 'fx':
        this.getLayout(layoutForGame(activeGame())).fx(m);
        break;
      case 'mg':
        // PARTY RUSH: the whole per-phone view (phase, cue, me…). Layout reads it from the store.
        setState({ rush: m, rushAt: performance.now() });
        break;
      default:
        break;
    }
  }

  getLayout(id: LayoutId): ControllerLayout {
    let l = this.layouts.get(id);
    if (!l) {
      l = LAYOUT_FACTORIES[id]();
      this.layouts.set(id, l);
    }
    return l;
  }

  /** Release every held input of every layout (blur, background, rotate, game swap). */
  releaseAll(): void {
    for (const l of this.layouts.values()) l.input.releaseAll();
  }

  render(): void {
    const v = currentView();
    const isCtl = CONTROLLER_VIEWS.includes(v);
    const lid = layoutForGame(state.phone?.game);
    if (lid !== this.layoutId) {
      // Game switched while connected: drop every held finger, swap instantly.
      this.releaseAll();
      this.layoutId = lid;
    }
    const view: View = isCtl ? this.getLayout(lid) : this.views[v];
    if (view !== this.current) {
      if (this.current) {
        this.current.leave?.();
        this.current.el.remove();
      }
      this.current = view;
      this.stage.append(view.el);
      view.enter?.(v);
      this.currentId = null;
    }
    const grip = isCtl ? ((view as ControllerLayout).orientation ?? 'landscape') : null;
    if (this.currentId !== v || this.grip !== grip) {
      this.currentId = v;
      this.grip = grip;
      // Landscape layouts lock landscape; a portrait layout (Party Rush) locks portrait; menus keep the lock.
      setWantOrientation(grip);
      if (!isCtl) this.releaseAll();
    }
    view.update(v);

    for (const l of this.layouts.values()) l.input.setActive(isCtl && state.joined && l === view);
    const portrait = window.innerHeight > window.innerWidth * 1.05;
    const rotateOn = grip === 'landscape' && portrait;
    if (rotateOn && this.rotate.style.display === 'none') this.releaseAll();
    show(this.rotate, rotateOn);
    toggleClass(this.root, 'in-race', isCtl);
    this.root.setAttribute('data-game', activeGame());
    if (state.phone?.games?.length || state.phone?.game) this.root.setAttribute('data-hub', '');
    else this.root.removeAttribute('data-hub');
    toggleClass(this.root, 'portrait', portrait);
    this.root.setAttribute('data-view', v);

    // Slot tint
    const slot = state.phone?.you?.slot;
    const col = slot !== undefined && slot >= 0 ? SLOT_COLORS[slot % SLOT_COLORS.length] : '#7c5cff';
    if (this.root.style.getPropertyValue('--slot') !== col) {
      this.root.style.setProperty('--slot', col);
      const meta = document.querySelector('meta[name="theme-color"]');
      meta?.setAttribute('content', '#14102a');
    }

    this.renderCorner(v);
  }

  private renderCorner(v: ViewId): void {
    const now = performance.now();
    const c = state.conn;
    if (c === 'reconnecting' || c === 'connecting') {
      if (!this.reconnectingSince) this.reconnectingSince = now;
    } else this.reconnectingSince = 0;
    let q: 'good' | 'warn' | 'bad' = 'good';
    if (!state.joined) q = c === 'closed' || (this.reconnectingSince && now - this.reconnectingSince > 6000) ? 'bad' : 'warn';
    else if (state.rtt !== null && state.rtt > 180) q = 'warn';
    show(this.connEl, !!state.room);
    this.dot.setAttribute('data-q', q);
    this.dot.className = `dot ${q}`;
    setText(this.ping, state.joined && state.rtt !== null ? `${Math.round(state.rtt)}ms` : state.joined ? '…' : c === 'closed' ? 'offline' : '…');
    setText(this.roomTag, state.room && v !== 'join' && !CONTROLLER_VIEWS.includes(v) ? state.room : '');
    show(this.hostBanner, state.joined && !state.hostConnected && v !== 'join' && v !== 'error');
    show(this.connBanner, !state.joined && !!state.phone && c !== 'closed');
  }

  /** iOS/Android gesture hardening + first-tap fullscreen / wake lock / tilt permission. */
  private installGestures(): void {
    const d = document;
    // Tells iOS to apply :active styles.
    d.addEventListener('touchstart', () => {}, { passive: true });
    // No pinch zoom (iOS ignores user-scalable=no).
    for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) d.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
    d.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
    // No rubber-band / pull-to-refresh outside scrollable panes.
    d.addEventListener(
      'touchmove',
      (e) => {
        const t = e.target as Element | null;
        if (e.touches.length > 1) {
          if (e.cancelable) e.preventDefault();
          return;
        }
        if (t && t.closest && (t.closest('.scrollable') || t.closest('input[type=range]'))) return;
        if (e.cancelable) e.preventDefault();
      },
      { passive: false },
    );
    d.addEventListener('contextmenu', (e) => {
      const t = e.target as Element | null;
      if (!(t instanceof HTMLInputElement)) e.preventDefault();
    });

    const onGesture = () => {
      void requestWakeLock();
      if (CONTROLLER_VIEWS.includes(currentView()) || currentView() === 'loading') requestFullscreen();
      else if (!this.firstTapDone) requestFullscreen();
      this.firstTapDone = true;
      // Party Rush asks for motion permission itself (its join tap): never race two iOS prompts.
      if (settings.tilt && !tilt.active && activeGame() !== 'rush') {
        void tilt.enable().then((ok) => {
          if (ok) setTimeout(() => tilt.hasData && tilt.offset === 0 && tilt.calibrate(), 400);
        });
      }
    };
    // touchend/click count as user activation on iOS (pointerdown doesn't for permissions).
    d.addEventListener('touchend', onGesture, { capture: true, passive: true });
    d.addEventListener('click', onGesture, { capture: true });
    d.addEventListener('visibilitychange', () => {
      if (d.visibilityState !== 'visible') this.releaseAll();
    });
    window.addEventListener('blur', () => this.releaseAll());
    window.addEventListener('pagehide', () => this.releaseAll());
    void haptic;
  }

  private firstTapDone = false;
  private grip: 'landscape' | 'portrait' | null = null;
}
