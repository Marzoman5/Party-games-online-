/**
 * Display concerns owned by PARTY: TV mode (`html.tv`, --ui-scale, --safe), fullscreen,
 * and cursor hiding during races.
 */
import type { IGameHost } from '../game/api';
import { CURSOR_SHOW_MS, STORAGE, params, storageGet, storageSet } from './config';

export class Display {
  tvMode = false;
  private cursorHidden = false;
  private cursorWanted = false;
  private cursorTimer = 0;
  private readonly listeners: (() => void)[] = [];
  onChange: (() => void) | null = null;

  constructor(private readonly game: IGameHost) {
    const q = params().get('tv');
    let on: boolean;
    if (q === '1') on = true;
    else if (q === '0') on = false;
    else {
      const saved = storageGet('local', STORAGE.tv);
      on = saved === '1' ? true : saved === '0' ? false : window.innerWidth >= 1920;
    }
    this.setTvMode(on, false);

    const move = (): void => this.onMouseMove();
    window.addEventListener('mousemove', move, { passive: true });
    this.listeners.push(() => window.removeEventListener('mousemove', move));
    const fs = (): void => this.onChange?.();
    document.addEventListener('fullscreenchange', fs);
    document.addEventListener('webkitfullscreenchange', fs);
    this.listeners.push(() => {
      document.removeEventListener('fullscreenchange', fs);
      document.removeEventListener('webkitfullscreenchange', fs);
    });
  }

  setTvMode(on: boolean, persist = true): void {
    this.tvMode = on;
    const root = document.documentElement;
    root.classList.toggle('tv', on);
    root.style.setProperty('--ui-scale', on ? '1.6' : '1');
    root.style.setProperty('--safe', on ? '5vh' : '0px');
    if (persist) storageSet('local', STORAGE.tv, on ? '1' : '0');
    try {
      this.game.setTvMode(on);
    } catch (err) {
      console.warn('[party] setTvMode failed', err);
    }
    this.onChange?.();
  }

  toggleTv(): void {
    this.setTvMode(!this.tvMode);
  }

  get isFullscreen(): boolean {
    const d = document as Document & { webkitFullscreenElement?: Element | null };
    return !!(document.fullscreenElement ?? d.webkitFullscreenElement);
  }

  toggleFullscreen(): void {
    const d = document as Document & { webkitExitFullscreen?: () => void };
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    try {
      if (this.isFullscreen) {
        if (document.exitFullscreen) void document.exitFullscreen().catch(() => undefined);
        else d.webkitExitFullscreen?.();
      } else if (el.requestFullscreen) {
        void el.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined);
      } else el.webkitRequestFullscreen?.();
    } catch {
      /* not allowed (no gesture / iframe): ignore */
    }
  }

  /** Hide the cursor while racing (it re-appears for 2 s when the mouse moves). */
  setCursorHidden(want: boolean): void {
    this.cursorWanted = want;
    if (!want) {
      window.clearTimeout(this.cursorTimer);
      this.cursorTimer = 0;
    }
    if (!want || !this.cursorTimer) this.applyCursor(want);
  }

  private onMouseMove(): void {
    if (!this.cursorWanted) return;
    this.applyCursor(false);
    window.clearTimeout(this.cursorTimer);
    this.cursorTimer = window.setTimeout(() => {
      this.cursorTimer = 0;
      if (this.cursorWanted) this.applyCursor(true);
    }, CURSOR_SHOW_MS);
  }

  private applyCursor(hide: boolean): void {
    if (this.cursorHidden === hide) return;
    this.cursorHidden = hide;
    document.body.classList.toggle('hide-cursor', hide);
  }

  dispose(): void {
    window.clearTimeout(this.cursorTimer);
    for (const off of this.listeners) off();
    this.listeners.length = 0;
  }
}
