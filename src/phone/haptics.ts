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
  | 'countdown';

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
};

export function haptic(kind: HapticKind): void {
  if (!settings.vibration) return;
  try {
    const nav = navigator as Navigator & { vibrate?: (p: number | number[]) => boolean };
    if (typeof nav.vibrate === 'function') nav.vibrate(PATTERNS[kind]);
  } catch {
    /* ignore */
  }
}
