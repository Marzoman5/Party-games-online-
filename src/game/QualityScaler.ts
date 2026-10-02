/**
 * Adaptive render quality. Four tiers (0 = potato .. 3 = full) control the
 * render resolution (pixel ratio + total pixel budget), shadow map size,
 * particle budget and whether post-processing runs.
 *
 * Adaptation uses a rolling frame-time average:
 *   - drop one tier when the average stays below DROP_FPS for DROP_SECONDS;
 *   - raise one tier when it stays above RAISE_FPS for RAISE_SECONDS;
 *   - after any change, measurements pause for SETTLE_SECONDS (shader compiles,
 *     shadow map reallocation) and a tier we dropped FROM needs a longer streak
 *     before we try it again (and is banned after two failed attempts), so it
 *     never thrashes.
 * `?quality=N` in the URL (or setForced) pins a tier.
 */
import type { QualityTier } from './api';

export interface TierSettings {
  /** Max device pixel ratio. */
  maxDpr: number;
  /** Max total drawing-buffer pixels (all viewports together). */
  maxPixels: number;
  /** Shadow map size; 0 = shadows off. */
  shadowMapSize: number;
  /** Particle quality tier passed to ParticleSystem.setQuality. */
  particles: 0 | 1 | 2 | 3;
  /** Post-processing (bloom etc.) allowed (single view only). */
  postfx: boolean;
}

export const TIERS: Record<QualityTier, TierSettings> = {
  0: { maxDpr: 1, maxPixels: 0.6e6, shadowMapSize: 0, particles: 0, postfx: false },
  1: { maxDpr: 1, maxPixels: 1.2e6, shadowMapSize: 512, particles: 1, postfx: false },
  2: { maxDpr: 1.5, maxPixels: 2.1e6, shadowMapSize: 1024, particles: 2, postfx: true },
  3: { maxDpr: 2, maxPixels: 8.3e6, shadowMapSize: 2048, particles: 3, postfx: true },
};

const DROP_FPS = 50;
const DROP_SECONDS = 2;
const RAISE_FPS = 58;
const RAISE_SECONDS = 8;
const RETRY_RAISE_SECONDS = 20;
const SETTLE_SECONDS = 2.5;
const EMA_SECONDS = 0.5;

function clampTier(n: number): QualityTier {
  return Math.max(0, Math.min(3, Math.round(n))) as QualityTier;
}

export function readForcedTierFromUrl(): QualityTier | null {
  try {
    const q = new URLSearchParams(location.search).get('quality');
    if (q === null || q === '') return null;
    const n = Number(q);
    return Number.isFinite(n) ? clampTier(n) : null;
  } catch {
    return null;
  }
}

export class QualityScaler {
  private tierValue: QualityTier = 2;
  private forced: QualityTier | null;
  private cap: QualityTier = 3;
  private avgFrame = 1 / 60;
  private lowTime = 0;
  private highTime = 0;
  private settle = SETTLE_SECONDS;
  /** Per tier: how many times we had to drop away from it. */
  private readonly failures = [0, 0, 0, 0];
  private fpsValue = 60;

  /** Called whenever the effective tier changes. */
  onChange: ((tier: QualityTier) => void) | null = null;

  constructor() {
    this.forced = readForcedTierFromUrl();
    if (this.forced !== null) this.tierValue = this.forced;
  }

  get tier(): QualityTier {
    return this.forced ?? this.tierValue;
  }

  get settings(): TierSettings {
    return TIERS[this.tier];
  }

  get fps(): number {
    return this.fpsValue;
  }

  get isForced(): boolean {
    return this.forced !== null;
  }

  /** Pin a tier (null = automatic). */
  setForced(tier: QualityTier | null): void {
    const before = this.tier;
    this.forced = tier === null ? null : clampTier(tier);
    this.resetMeasurement();
    if (this.tier !== before) this.onChange?.(this.tier);
  }

  /**
   * Pick a starting tier for a new scene (race / demo) from the number of
   * viewports and the screen's physical pixel count. `cap` limits the max tier
   * (the demo stays light).
   */
  pickInitial(viewports: number, cssW: number, cssH: number, dpr: number, cap: QualityTier = 3): void {
    this.cap = cap;
    const px = cssW * cssH * dpr * dpr;
    let t: QualityTier;
    if (viewports <= 1) t = px <= 2.6e6 ? 3 : 2;
    else if (viewports === 2) t = 2;
    else t = 1;
    // A tier we already had to abandon twice this session is not retried.
    while (t > 0 && this.failures[t] >= 2) t = (t - 1) as QualityTier;
    if (t > cap) t = cap;
    const before = this.tier;
    this.tierValue = t;
    this.resetMeasurement();
    if (this.tier !== before) this.onChange?.(this.tier);
  }

  /** Feed the real (unclamped) frame time. `active` = false pauses adaptation (menus, loading, hidden tab). */
  update(frameSeconds: number, active: boolean): void {
    if (!(frameSeconds > 0) || frameSeconds > 3) {
      // Tab switch / debugger pause: ignore, restart measurement.
      this.settle = Math.max(this.settle, 1);
      return;
    }
    const k = Math.min(1, frameSeconds / EMA_SECONDS);
    this.avgFrame += (frameSeconds - this.avgFrame) * k;
    this.fpsValue = 1 / Math.max(1e-4, this.avgFrame);
    if (!active || this.forced !== null) {
      this.lowTime = 0;
      this.highTime = 0;
      return;
    }
    if (this.settle > 0) {
      this.settle -= frameSeconds;
      return;
    }
    const fps = this.fpsValue;
    if (fps < DROP_FPS) {
      this.lowTime += frameSeconds;
      this.highTime = 0;
    } else if (fps > RAISE_FPS) {
      this.highTime += frameSeconds;
      this.lowTime = 0;
    } else {
      this.lowTime = 0;
      this.highTime = 0;
    }
    if (this.lowTime >= DROP_SECONDS && this.tierValue > 0) {
      this.failures[this.tierValue]++;
      this.change((this.tierValue - 1) as QualityTier);
      return;
    }
    if (this.tierValue < this.cap) {
      const next = (this.tierValue + 1) as QualityTier;
      if (this.failures[next] >= 2) return;
      const need = this.failures[next] > 0 ? RETRY_RAISE_SECONDS : RAISE_SECONDS;
      if (this.highTime >= need) this.change(next);
    }
  }

  private change(t: QualityTier): void {
    this.tierValue = t;
    this.resetMeasurement();
    this.onChange?.(this.tier);
  }

  private resetMeasurement(): void {
    this.lowTime = 0;
    this.highTime = 0;
    this.settle = SETTLE_SECONDS;
  }

  /**
   * Pixel ratio for a canvas of cssW x cssH under the current tier: device
   * ratio capped by the tier's maxDpr and by its total pixel budget.
   */
  pixelRatioFor(cssW: number, cssH: number, deviceRatio: number): number {
    const s = this.settings;
    let pr = Math.min(deviceRatio || 1, s.maxDpr);
    const area = Math.max(1, cssW * cssH);
    const budget = Math.sqrt(s.maxPixels / area);
    if (pr > budget) pr = budget;
    return Math.max(0.35, pr);
  }
}
