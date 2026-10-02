/** Vibration feedback. Silently a no-op where unsupported (iOS Safari). */
import { settings } from './settings';

export type HapticKind =
  | 'tick'
  | 'press'
  | 'hit'
  | 'miniturbo'
  | 'lap'
  | 'finalLap'
  | 'item'
  | 'go'
  | 'finish'
  | 'boost'
  | 'countdown'
  // PARTY HUB / Smash Party
  | 'ko'
  | 'koOther'
  | 'shieldBreak'
  | 'land'
  | 'game';

const PATTERNS: Record<HapticKind, number | number[]> = {
  tick: 8,
  press: 12,
  hit: [220, 60, 120],
  miniturbo: [28, 45, 28],
  lap: 45,
  finalLap: [40, 60, 40, 60, 90],
  item: 18,
  go: 140,
  finish: [60, 60, 60, 60, 220],
  boost: 30,
  countdown: 35,
  ko: [200, 70, 120, 70, 320],
  koOther: [30, 70, 30],
  shieldBreak: [90, 40, 90, 40, 220],
  land: 9,
  game: [60, 60, 60, 60, 300],
};

/** Smash hit: vibration length scales with the hit strength (0..1) -> ~15..140 ms. */
export function hitDuration(strength: number): number {
  const s = Math.max(0, Math.min(1, Number.isFinite(strength) ? strength : 0.5));
  return Math.round(15 + s * 125);
}

export function vibrate(p: number | number[]): void {
  if (!settings.vibration) return;
  try {
    const nav = navigator as Navigator & { vibrate?: (p: number | number[]) => boolean };
    if (typeof nav.vibrate === 'function') nav.vibrate(p);
  } catch {
    /* ignore */
  }
}

export function haptic(kind: HapticKind): void {
  const p = PATTERNS[kind];
  if (p !== undefined) vibrate(p);
}
