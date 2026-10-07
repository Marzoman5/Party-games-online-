/**
 * Party Rush as a party-engine GameModule (drop-in / drop-out). The host SHELL lives in ./shell:
 *   loop.ts      phase machine, roster + away, scoring, picker + heat, minigame ctx, solo bots, phone msgs
 *   audio.ts     procedural TV sfx + music bed
 *   view/*       canvas stage + HUD, scoreboard, UP NEXT + gesture demo, 3-2-1, results, menu, cert help
 * This file wires it to the PartySession: drop-in members, host keys, the rAF driver + watchdog
 * interval, snapshot/restore and `window.__rush`. No three.js — the import graph stays light.
 */
import type { DecodedStream, GameInfo, HostToPhone, MgFromPhone } from '../../net/protocol';
import type { AnyInput, CharacterLook, GameModule, ModuleViews, PlayerEvent, TryIt, TutorialDef } from '../../engine/GameModule';
import type { PartySession } from '../../engine/PartySession';
import type { UiContext } from '../../party/ui/HostUI';
import { RushAudio } from './shell/audio';
import { RushShell, type ShellHost } from './shell/loop';
import { StageView } from './shell/view/StageView';
import './rush.css';

export const RUSH_INFO: GameInfo = {
  id: 'rush',
  title: 'Party Rush',
  tagline: '10 motion minigames — jump in any time!',
  emoji: '⚡',
  color: '#ff3ab8',
  minPlayers: 1,
  maxPlayers: 16,
};

/** Never shown (drop-in games skip the tutorial) — a minimal valid definition. */
const RUSH_TUTORIAL: TutorialDef = {
  steps: [
    {
      zone: 'screen',
      label: 'MOVE!',
      title: 'Watch the TV',
      sub: 'Do what the big word on your phone says.',
      demo: () => '<div class="rush-tut-demo">📱⚡</div>',
    },
  ],
  stepMs: 4000,
  phoneMarkup: (c: string) =>
    `<svg viewBox="0 0 100 180" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="4" width="92" height="172" rx="14" fill="#17122c" stroke="#fff" stroke-width="4"/><rect class="kp-zone" data-zone="screen" x="12" y="16" width="76" height="148" rx="6" fill="${c}"/></svg>`,
  phoneSize: [100, 180],
  zoneAnchor: { screen: [50, 90] },
  tryItHint: 'Wave your phone!',
};

const WATCHDOG_MS = 250;

export interface RushHooks {
  getState(): Record<string, unknown>;
  next(): boolean;
  skip(): void;
  pause(on?: boolean): boolean;
  replay(): boolean;
  forceGame(id: string): boolean;
  setSetting(k: string, v: unknown): boolean;
  fps(): number;
}

declare global {
  interface Window {
    __rush?: RushHooks;
  }
}

export class RushModule implements GameModule {
  readonly id = 'rush' as const;
  readonly info = RUSH_INFO;
  readonly layout = 'rush' as const;
  readonly tutorial = RUSH_TUTORIAL;
  readonly hasSandbox = false;
  readonly loaded = true;
  readonly dropIn = true;

  readonly shell: RushShell;
  readonly audio = new RushAudio();
  private s: PartySession | null = null;
  private view: StageView | null = null;
  private active = false;
  private raf = 0;
  private watchdog = 0;
  private fpsVal = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private fpsLast = 0;

  constructor(readonly container: HTMLElement) {
    const host: ShellHost = {
      players: () => this.s?.players ?? [],
      send: (id, msg) => this.s?.send(id, msg as HostToPhone),
      changed: () => this.s?.changed(),
      kick: (id) => this.s?.hostKickPlayer(id),
    };
    this.shell = new RushShell(host, this.audio);
    this.installHooks();
  }

  bind(s: PartySession): void {
    this.s = s;
  }

  load(): Promise<void> {
    return Promise.resolve();
  }

  // ------------------------------------------------------------------ lifecycle

  activate(): void {
    this.active = true;
    this.audio.arm();
    this.syncDriver();
  }

  deactivate(): void {
    this.active = false;
    if (this.shell.running) this.shell.stop();
    this.syncDriver();
  }

  showAttract(): void {
    /* the hub shows its own art; nothing runs behind it */
  }

  setTvMode(_on: boolean): void {
    /* StageView reads display.tvMode every frame */
  }

  get phase(): string {
    return this.shell.running ? `rush:${this.shell.phase}` : 'idle';
  }
  isLive(): boolean {
    return this.shell.running && (this.shell.phase === 'count' || this.shell.phase === 'play');
  }
  isStopped(): boolean {
    return !this.shell.running;
  }
  canPause(): boolean {
    return false;
  }

  // ------------------------------------------------------------------ drop-in

  startEndless(): void {
    this.active = true;
    this.audio.arm();
    this.shell.start();
    this.shell.resend();
    this.syncDriver();
  }

  quit(): void {
    this.shell.stop();
    this.syncDriver();
  }

  onPlayer(playerId: string, ev: PlayerEvent): void {
    this.shell.onPlayer(playerId, ev);
  }

  onMg(playerId: string, m: MgFromPhone): void {
    this.shell.onMg(playerId, m);
  }

  inputFrom(playerId: string, input: AnyInput): void {
    if (input.tag !== 2) return;
    this.shell.inputFrom(playerId, input.input as DecodedStream);
  }

  // ------------------------------------------------------------------ driver (rAF + watchdog)

  private syncDriver(): void {
    const want = this.active && this.shell.running;
    if (want && !this.watchdog) {
      this.watchdog = window.setInterval(() => this.onWatchdog(), WATCHDOG_MS);
      this.raf = requestAnimationFrame(this.onFrame);
    } else if (!want && this.watchdog) {
      window.clearInterval(this.watchdog);
      this.watchdog = 0;
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.syncAudio();
  }

  private readonly onFrame = (now: number): void => {
    this.raf = 0;
    if (!this.active || !this.shell.running) return;
    this.raf = requestAnimationFrame(this.onFrame);
    try {
      this.shell.tick(performance.now());
      this.view?.frame(now);
    } catch (err) {
      console.error('[rush] frame failed', err);
    }
    this.syncAudio();
    // FPS (1 s window).
    if (this.fpsLast) {
      this.fpsAcc += now - this.fpsLast;
      this.fpsFrames++;
      if (this.fpsAcc >= 1000) {
        this.fpsVal = Math.round((this.fpsFrames * 1000) / this.fpsAcc);
        this.fpsAcc = 0;
        this.fpsFrames = 0;
      }
    }
    this.fpsLast = now;
  };

  /** Keeps the loop (timers, phone sync, minigame update) moving when animation frames stall. */
  private onWatchdog(): void {
    if (!this.active || !this.shell.running) return;
    const now = performance.now();
    if (now - this.shell.lastTickReal > 200) {
      try {
        this.shell.tick(now);
      } catch (err) {
        console.error('[rush] watchdog tick failed', err);
      }
      this.fpsVal = 0;
      this.fpsLast = 0;
      this.syncAudio();
    }
    // A cancelled / lost rAF chain is restarted here.
    if (!this.raf) this.raf = requestAnimationFrame(this.onFrame);
  }

  private syncAudio(): void {
    const sh = this.shell;
    const on = this.active && sh.running;
    this.audio.setMuted(!on || sh.paused);
    this.audio.setVolume(sh.settings.volume);
    this.audio.setHeat(sh.heat);
    this.audio.setMood(!on ? 'off' : sh.phase === 'count' || sh.phase === 'play' ? 'play' : sh.phase === 'intro' ? 'intro' : sh.phase === 'results' ? 'results' : 'lobby');
  }

  // ------------------------------------------------------------------ host UI + keys

  createViews(ctx: unknown): ModuleViews {
    const ui = ctx as UiContext;
    this.view = new StageView(ui, this.shell, {
      click: () => {
        this.audio.unlock();
        if (!this.shell.menuOpen) this.shell.next();
      },
      openMenu: () => this.openMenu(true),
      close: () => this.openMenu(false),
      backToHub: () => {
        this.openMenu(false);
        this.s?.hostQuit();
      },
      removePlayer: (id) => this.shell.removePlayer(id),
    });
    return { race: this.view };
  }

  private openMenu(open: boolean): void {
    this.shell.setMenu(open);
    if (open) this.view?.menu.opened();
  }

  onHostKey(e: KeyboardEvent): boolean {
    const s = this.s;
    if (!s || s.gameId !== 'rush' || s.screen !== 'race' || !this.shell.running) return false;
    this.audio.unlock();
    const sh = this.shell;
    const k = e.key;
    if (sh.menuOpen) {
      if (k === 'Escape') {
        e.preventDefault();
        this.openMenu(false);
        return true;
      }
      const t = e.target as HTMLElement | null;
      if (t && t.closest?.('.rush-menu')) return false; // let buttons / selects / sliders work
      return k === ' ' || k === 'Enter' || /^[psrPSR]$/.test(k);
    }
    if (e.repeat) return k === ' ' || k === 'Enter';
    switch (k) {
      case ' ':
      case 'Enter':
        e.preventDefault();
        sh.next();
        return true;
      case 'p':
      case 'P':
        e.preventDefault();
        sh.setPaused(!sh.paused);
        return true;
      case 's':
      case 'S':
        e.preventDefault();
        sh.skip();
        return true;
      case 'r':
      case 'R':
        e.preventDefault();
        sh.replay();
        return true;
      case 'Escape':
        e.preventDefault();
        this.openMenu(true);
        return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ persistence

  snapshot(): unknown {
    return this.shell.snapshot();
  }

  restore(snap: unknown): void {
    try {
      this.shell.restore(snap);
    } catch (err) {
      console.warn('[rush] restore failed', err);
    }
  }

  getSetup(): Record<string, unknown> {
    return {};
  }
  applySetup(_patch: unknown): void {}

  debugExtras(): Record<string, unknown> {
    return { rush: { phase: this.shell.phase, round: this.shell.roundsPlayed, heat: this.shell.heat } };
  }

  // ------------------------------------------------------------------ non-drop-in members (unused)

  startFromSetup(): boolean {
    return false;
  }
  post(): boolean {
    return false;
  }
  restart(): void {}
  pause(): void {
    this.shell.setPaused(true);
  }
  resume(): void {
    this.shell.setPaused(false);
  }
  setSeatAI(): void {}
  input(): void {}
  status(): HostToPhone | null {
    return null;
  }
  tryIt(): TryIt | null {
    return null;
  }
  look(): CharacterLook {
    return { portrait: null, sub: '' };
  }
  matchLabel(): string {
    return 'Party Rush';
  }

  // ------------------------------------------------------------------ test hooks

  private installHooks(): void {
    const sh = this.shell;
    window.__rush = {
      getState: () => sh.getState(this.fpsVal),
      next: () => sh.next(),
      skip: () => sh.skip(),
      pause: (on?: boolean) => {
        sh.setPaused(on === undefined ? !sh.paused : !!on);
        return sh.paused;
      },
      replay: () => sh.replay(),
      forceGame: (id: string) => sh.forceGame(id),
      setSetting: (k: string, v: unknown) => sh.setSetting(k, v),
      fps: () => this.fpsVal,
    };
  }

  dispose(): void {
    this.quit();
    this.audio.dispose();
    if (window.__rush) delete window.__rush;
  }
}
