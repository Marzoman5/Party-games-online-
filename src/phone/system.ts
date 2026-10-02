/** Fullscreen, orientation lock and screen wake lock — all best-effort. */

type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitFullscreenEnabled?: boolean };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

export function fullscreenSupported(): boolean {
  const d = document as FsDoc;
  return !!(d.fullscreenEnabled || d.webkitFullscreenEnabled);
}

export function isFullscreen(): boolean {
  const d = document as FsDoc;
  return !!(d.fullscreenElement || d.webkitFullscreenElement);
}

let lastFsAttempt = 0;

/** Must run inside a user gesture. `force` skips the rate limit (explicit button). */
export function requestFullscreen(force = false): void {
  if (isFullscreen() || !fullscreenSupported()) return;
  const now = performance.now();
  if (!force && now - lastFsAttempt < 4000) return;
  lastFsAttempt = now;
  const el = document.documentElement as FsEl;
  try {
    const p = el.requestFullscreen
      ? el.requestFullscreen({ navigationUI: 'hide' } as FullscreenOptions)
      : el.webkitRequestFullscreen?.();
    if (p && typeof (p as Promise<void>).then === 'function') {
      (p as Promise<void>).then(() => lockLandscape()).catch(() => {});
    }
  } catch {
    /* ignore */
  }
}

let wantLandscape = false;
export function setWantLandscape(on: boolean): void {
  wantLandscape = on;
  if (on) lockLandscape();
}

export function lockLandscape(): void {
  if (!wantLandscape || !isFullscreen()) return;
  try {
    const so = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    so?.lock?.('landscape').catch(() => {});
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
type WakeLockSentinelLike = { released: boolean; release(): Promise<void>; addEventListener(t: string, f: () => void): void };
let wakeLock: WakeLockSentinelLike | null = null;
let wakeWanted = false;

export async function requestWakeLock(): Promise<void> {
  wakeWanted = true;
  const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } };
  if (!nav.wakeLock || document.visibilityState !== 'visible') return;
  if (wakeLock && !wakeLock.released) return;
  try {
    wakeLock = await nav.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    wakeLock = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeWanted) void requestWakeLock();
});
