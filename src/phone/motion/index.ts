/**
 * FROZEN API (LEAD) — the phone's single owner of motion sensors for every Party Rush minigame.
 * Implementation: MOTION agent (src/phone/motion/**). Consumers (src/phone/rush/**) use ONLY this API.
 *
 * - `enable()` must be called from a user gesture (the join tap): iOS permission prompts for
 *   DeviceMotionEvent + DeviceOrientationEvent. Resolves false when sensors are unavailable (plain HTTP,
 *   denied, desktop, old phone) → the phone uses the touch fallback.
 * - `configure(stream, events)` at the start of each round (ph 'count'); `calibrate()` at GO captures
 *   the neutral (tilt), re-centres aim and resets accumulators (still, shake count).
 * - `sample()` returns the current stream values (ints -1000..1000, meaning per stream: see the tag-2
 *   packet docs in src/net/protocol.ts). The Rush layout sends it at 20 Hz.
 * - `drain()` returns gesture events detected since the last call (on the phone, immediately).
 * - Everything is relative to the SCREEN (portrait grip), normalised across iOS/Android axis signs.
 * - Never uses compass heading (alpha).
 */
import type { RushEvent, RushStream } from '../../net/protocol';

/** One raw sensor reading in SCREEN coordinates (x right, y up, z out of the screen), SI units. */
export interface RawMotion {
  /** accelerationIncludingGravity (m/s²). At rest face-up ≈ (0, 0, +9.81). */
  gx: number;
  gy: number;
  gz: number;
  /** acceleration without gravity (m/s²) if the device provides it (else NaN). */
  ax: number;
  ay: number;
  az: number;
  /** rotationRate (deg/s) about screen x (alpha-like pitch), y, z. */
  rx: number;
  ry: number;
  rz: number;
}

export interface MotionEvent {
  k: RushEvent;
  /** flick: strength 0..100; pose: pose index; raise: 0. */
  v: number;
  /** flick direction (-100..100, x right, y up). */
  x: number;
  y: number;
  /** performance.now() when detected. */
  t: number;
}

export interface MotionApi {
  /** Secure context + the sensor events exist. */
  readonly supported: boolean;
  /** Permission granted / listeners attached. */
  readonly enabled: boolean;
  /** Real readings have arrived recently (< 1 s). */
  readonly hasData: boolean;
  /** Ask for permission + start listening. Call from a user gesture. */
  enable(): Promise<boolean>;
  /** Choose what to detect for this round (resets detectors). */
  configure(stream: RushStream | null, events: readonly RushEvent[]): void;
  /** Neutral := current orientation (tilt), re-centre aim, reset accumulators. Called at GO and on double tap (aim). */
  calibrate(): void;
  /** Current stream sample [a, b, c] for the configured stream ([0,0,0] if none). */
  sample(): [number, number, number];
  /** Gesture events since the last drain. */
  drain(): MotionEvent[];
  /** True if the phone was hand-held (moving above table noise) at any time since `t` (performance.now()). */
  activeSince(t: number): boolean;
  /** Test/bot injector: feed one raw reading as if it came from the sensors (marks the API enabled + hasData). */
  inject(r: Partial<RawMotion>): void;
  /** Test injector: emit a gesture event directly. */
  injectGesture(k: RushEvent, v?: number, x?: number, y?: number): void;
}

import { createMotion } from './sensors';

export const motion: MotionApi = createMotion();
