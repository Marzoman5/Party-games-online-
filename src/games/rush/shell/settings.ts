/**
 * SHELL — Party Rush host settings (Esc menu), persisted in localStorage (`kartparty.rush.settings`).
 * Everything read back from storage is validated; unknown / broken values fall back to defaults.
 */
import { LOOP } from '../tuning';
import { MINIGAMES } from '../minigames/index';

export interface RushSettings {
  /** Auto-advance from the scoreboard (only with ≥ 1 present human). */
  auto: boolean;
  /** Auto-advance delay (seconds). */
  autoSec: number;
  /** Enabled minigame ids (never empty). */
  enabled: string[];
  /** Highest heat the loop climbs to (1..3). */
  maxHeat: 1 | 2 | 3;
  /** Master volume 0..1. */
  volume: number;
  /** Sip mode (drinking-game lines on the results card). Default OFF. */
  sip: boolean;
}

export const SETTINGS_KEY = 'kartparty.rush.settings';
export const AUTO_SEC_CHOICES = [5, 8, 10, 15, 20, 30] as const;

export function defaultSettings(): RushSettings {
  return { auto: true, autoSec: LOOP.autoAdvanceSec, enabled: MINIGAMES.map((m) => m.meta.id), maxHeat: 3, volume: 0.7, sip: false };
}

/** Validate a (partial, untrusted) settings object on top of `base`. */
export function sanitiseSettings(raw: unknown, base: RushSettings = defaultSettings()): RushSettings {
  const out: RushSettings = { ...base, enabled: [...base.enabled] };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.auto === 'boolean') out.auto = r.auto;
  if (typeof r.autoSec === 'number' && Number.isFinite(r.autoSec)) out.autoSec = Math.max(3, Math.min(60, Math.round(r.autoSec)));
  if (Array.isArray(r.enabled)) {
    const ids = new Set(MINIGAMES.map((m) => m.meta.id));
    const en = Array.from(new Set(r.enabled.filter((x): x is string => typeof x === 'string' && ids.has(x))));
    if (en.length) out.enabled = en;
  }
  if (typeof r.maxHeat === 'number' && [1, 2, 3].includes(Math.round(r.maxHeat))) out.maxHeat = Math.round(r.maxHeat) as 1 | 2 | 3;
  if (typeof r.volume === 'number' && Number.isFinite(r.volume)) out.volume = Math.max(0, Math.min(1, r.volume));
  if (typeof r.sip === 'boolean') out.sip = r.sip;
  return out;
}

export function loadSettings(): RushSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (raw) return sanitiseSettings(JSON.parse(raw));
  } catch {
    /* blocked storage / corrupt JSON */
  }
  return defaultSettings();
}

export function saveSettings(s: RushSettings): void {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
