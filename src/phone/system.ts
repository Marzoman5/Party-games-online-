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

/** Orientation the mounted screen wants locked while fullscreen (null = leave as is). */
let wantOrientation: 'landscape' | 'portrait' | null = null;
let lockedTo: 'landscape' | 'portrait' | null = null;

export function setWantLandscape(on: boolean): void {
  setWantOrientation(on ? 'landscape' : null);
}

/**
 * Landscape layouts (kart / fighter) lock landscape; PARTY RUSH (portrait, the phone gets turned around in
 * Copy the Pose / Tilt) locks portrait so auto-rotate never spins the screen mid-gesture. null keeps whatever
 * lock is in place (previous behaviour for menus).
 */
export function setWantOrientation(o: 'landscape' | 'portrait' | null): void {
  wantOrientation = o;
  if (o) lockLandscape();
}

/** Applies the wanted orientation lock (name kept for older callers). */
export function lockLandscape(): void {
  if (!wantOrientation || !isFullscreen()) return;
  if (lockedTo === wantOrientation) return;
  const target = wantOrientation;
  try {
    const so = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    const p = so?.lock?.(target === 'portrait' ? 'portrait-primary' : 'landscape');
    if (p && typeof p.then === 'function') p.then(() => (lockedTo = target)).catch(() => {});
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
document.addEventListener('fullscreenchange', () => {
  if (!isFullscreen()) lockedTo = null;
});
