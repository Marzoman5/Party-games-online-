/** Phone controller settings, persisted per device in localStorage. */

export interface PhoneSettings {
  /** Throttle = 1 unless braking (GAS button not needed). */
  autoAccelerate: boolean;
  /** Steer by tilting the phone (needs a secure context + motion permission). */
  tilt: boolean;
  /** 0.5..2 (1 = ~35 degrees of tilt for full lock). */
  tiltSensitivity: number;
  /** 0.5..2 (1 = dragging ~22% of the screen width is full lock). */
  touchSensitivity: number;
  vibration: boolean;
  /** Mirror the controller: buttons on the left, steering on the right. */
  leftHanded: boolean;
  /** Smash Party: flicking the stick up jumps. */
  tapJump: boolean;
  /** Smash Party: floating stick radius as a fraction of the screen height (0.13..0.16). */
  stickSize: number;
}

export const STICK_SIZES: [number, string][] = [
  [0.13, 'S'],
  [0.145, 'M'],
  [0.16, 'L'],
];

export const DEFAULT_SETTINGS: PhoneSettings = {
  autoAccelerate: true,
  tilt: false,
  tiltSensitivity: 1,
  touchSensitivity: 1,
  vibration: true,
  leftHanded: false,
  tapJump: false,
  stickSize: 0.145,
};

const KEY = 'kp.settings';

export function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function lsSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode / blocked storage: settings just don't persist */
  }
}

function load(): PhoneSettings {
  const s: PhoneSettings = { ...DEFAULT_SETTINGS };
  const raw = lsGet(KEY);
  if (!raw) return s;
  try {
    const o = JSON.parse(raw) as Partial<PhoneSettings>;
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof PhoneSettings)[]) {
      const v = o[k];
      if (typeof v === typeof DEFAULT_SETTINGS[k]) (s as unknown as Record<string, unknown>)[k] = v;
    }
  } catch {
    /* corrupt -> defaults */
  }
  s.tiltSensitivity = clampSens(s.tiltSensitivity);
  s.touchSensitivity = clampSens(s.touchSensitivity);
  s.stickSize = clampStick(s.stickSize);
  return s;
}

function clampStick(v: number): number {
  return Number.isFinite(v) ? Math.max(0.12, Math.min(0.17, v)) : 0.145;
}

function clampSens(v: number): number {
  return Number.isFinite(v) ? Math.max(0.5, Math.min(2, v)) : 1;
}

export const settings: PhoneSettings = load();
const listeners = new Set<() => void>();

export function setSetting<K extends keyof PhoneSettings>(key: K, value: PhoneSettings[K]): void {
  if (!(key in DEFAULT_SETTINGS)) return;
  let v = value;
  if (key === 'tiltSensitivity' || key === 'touchSensitivity') v = clampSens(Number(v)) as PhoneSettings[K];
  else if (key === 'stickSize') v = clampStick(Number(v)) as PhoneSettings[K];
  else if (typeof DEFAULT_SETTINGS[key] === 'boolean') v = Boolean(v) as PhoneSettings[K];
  settings[key] = v;
  lsSet(KEY, JSON.stringify(settings));
  listeners.forEach((fn) => fn());
}

export function onSettings(fn: () => void): void {
  listeners.add(fn);
}
