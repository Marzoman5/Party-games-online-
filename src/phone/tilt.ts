/**
 * Tilt steering from DeviceOrientationEvent.
 *
 * We rebuild the world "up" vector in device coordinates from beta/gamma
 * (W3C ZXY Euler order), rotate it into SCREEN coordinates using the current
 * screen orientation angle, and use its sideways component as the steering
 * angle. That works whether the phone is held upright like a wheel or tilted
 * back/flat, and in both landscape directions.
 */
import { settings } from './settings';

type DOEWithPerm = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>;
};

export function tiltSupported(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && typeof DeviceOrientationEvent !== 'undefined';
}

export function screenAngle(): number {
  const so = (screen as Screen & { orientation?: ScreenOrientation }).orientation;
  if (so && typeof so.angle === 'number') return so.angle;
  const wo = (window as unknown as { orientation?: number }).orientation;
  return typeof wo === 'number' ? wo : 0;
}

const D2R = Math.PI / 180;

/** Sideways tilt in degrees (+ = right) for the given orientation reading. Exported for tests. */
export function tiltDegrees(beta: number, gamma: number, angleDeg: number): number {
  const b = beta * D2R;
  const g = gamma * D2R;
  // World up expressed in device coordinates.
  const ux = -Math.sin(g) * Math.cos(b);
  const uy = Math.sin(b);
  // Screen-right axis in device coordinates for the current screen rotation.
  const a = angleDeg * D2R;
  const sx = Math.cos(a);
  const sy = -Math.sin(a);
  const side = ux * sx + uy * sy; // up . screenRight
  // Up leaning to the screen's left means the phone is rotated clockwise -> steer right.
  return Math.asin(Math.max(-1, Math.min(1, -side))) / D2R;
}

class Tilt {
  active = false;
  /** Raw degrees (uncalibrated), NaN until the first event. */
  raw = NaN;
  offset = 0;
  lastEventAt = 0;
  private handler = (e: DeviceOrientationEvent) => {
    if (e.beta === null || e.gamma === null) return;
    this.raw = tiltDegrees(e.beta, e.gamma, screenAngle());
    this.lastEventAt = performance.now();
  };

  /** Must be called from a user gesture (iOS permission prompt). Resolves false when denied/unavailable. */
  async enable(): Promise<boolean> {
    if (!tiltSupported()) return false;
    if (this.active) return true;
    const DOE = DeviceOrientationEvent as DOEWithPerm;
    if (typeof DOE.requestPermission === 'function') {
      try {
        const r = await DOE.requestPermission();
        if (r !== 'granted') return false;
      } catch {
        return false;
      }
    }
    window.addEventListener('deviceorientation', this.handler);
    this.active = true;
    return true;
  }

  disable(): void {
    window.removeEventListener('deviceorientation', this.handler);
    this.active = false;
    this.raw = NaN;
  }

  calibrate(): void {
    if (Number.isFinite(this.raw)) this.offset = this.raw;
  }

  /** -1..1 steering from tilt (0 when no data). */
  steer(): number {
    if (!this.active || !Number.isFinite(this.raw)) return 0;
    let d = this.raw - this.offset;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    const fullLock = 32 / settings.tiltSensitivity;
    const dead = 2;
    const mag = Math.max(0, Math.abs(d) - dead) / (fullLock - dead);
    return Math.sign(d) * Math.min(1, mag);
  }

  get hasData(): boolean {
    return this.active && Number.isFinite(this.raw);
  }
}

export const tilt = new Tilt();
