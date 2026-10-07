/**
 * MOTION tuning — every detector threshold / time constant in one place, so the owner can tune after a
 * real party test without touching the detector code (src/phone/motion/processor.ts).
 *
 * Units: accelerations in m/s², rotation rates in deg/s, times in SECONDS unless the name says MS,
 * angles in degrees. "tc" = exponential-filter time constant (the filter reaches 63 % of a step in tc).
 *
 * Coordinates: SCREEN frame (x right, y up/top edge, z out of the screen). "up" = the gravity-reaction
 * vector (what an accelerometer at rest reads): face-up on a table ≈ (0, 0, +9.81).
 */
export const MT = {
  // ------------------------------------------------------------------ gravity / filters
  /** Gravity estimate: correction toward the OS-provided gravity (accelIncludingGravity − acceleration). */
  GRAV_TC_WITH_ACC: 0.04,
  /** Correction tc when only accelerationIncludingGravity exists and a gyro predicts rotation. */
  GRAV_TC_GYRO: 0.45,
  /** Correction tc when only accelerationIncludingGravity exists and there is no gyro (plain low-pass). */
  GRAV_TC_PLAIN: 0.2,
  /** Incl-only: |accIncl| this far from 9.81 makes the correction up to 5x slower (shaking corrupts it). */
  GRAV_DISTRUST_MS2: 5,
  /** High-pass on linear acceleration (removes sensor bias / leftover gravity). */
  LIN_HP_TC: 0.6,
  /** Gyro high-pass for the stillness measure (removes bias). */
  GYRO_HP_TC: 1.0,
  /** Gyro bias learning: only while |gyro| < this (deg/s) and the accel is quiet. */
  GYRO_BIAS_GATE: 1.5,
  GYRO_BIAS_TC: 4,
  GYRO_BIAS_MAX: 3,
  /** A gyro counts as present after a reading with |rate| above this (deg/s); all-zero gyros don't. */
  GYRO_PRESENT: 0.01,
  /** Clamp the processing dt (s): gaps longer than this are treated as this (filters stay sane). */
  DT_MIN: 0.002,
  DT_MAX: 0.1,

  // ------------------------------------------------------------------ gyro self-check (units / sign)
  /** Compare gravity-direction change with the gyro over windows of this length (s). */
  GYROCHK_WINDOW: 0.1,
  /** Only windows where gravity turned at least this much (rad) count as evidence. */
  GYROCHK_MIN_TURN: 0.03,
  /** Windows where |accIncl| deviated more than this from 9.81 are ignored (linear accel corrupts). */
  GYROCHK_MAX_DEV: 2.5,
  /** Decide after this much total observed rotation (rad ≈ 86°). */
  GYROCHK_EVIDENCE: 1.5,

  // ------------------------------------------------------------------ shake
  /** Intensity = |lin| + |gyro| * SHAKE_GYRO_W − SHAKE_FLOOR (m/s²-equivalent). */
  SHAKE_GYRO_W: 1 / 60,
  SHAKE_FLOOR: 0.4,
  /** Pre-smoothing of the rectified intensity (removes the 2x-shake-frequency ripple). */
  SHAKE_PRE_TC: 0.08,
  /** Envelope attack / release. */
  SHAKE_ATTACK_TC: 0.15,
  SHAKE_RELEASE_TC: 0.4,
  /** Envelope value that maps to 100 % before compression (a brisk shake ≈ 15–20). */
  SHAKE_FULL: 14,
  /** Linear up to this fraction, then exponential diminishing returns toward 1 (safety: flailing ≈ brisk). */
  SHAKE_KNEE: 0.7,
  /** Half-cycle counter: a new lobe needs accel this strong pointing against the previous lobe. */
  SHAKE_COUNT_HI: 3.2,
  /** Minimum time between counted half-cycles (s) — 12 half-cycles/s max. */
  SHAKE_COUNT_MIN_GAP: 0.07,
  /** Lobe tracking forgets after this long below SHAKE_COUNT_LO (s). */
  SHAKE_COUNT_LO: 1.5,
  SHAKE_COUNT_FORGET: 0.5,

  // ------------------------------------------------------------------ flick
  /** Flick score s = |lin| / FLICK_LIN_REF + |gyro| / FLICK_GYRO_REF (with gyro). */
  FLICK_LIN_REF: 5,
  FLICK_GYRO_REF: 220,
  /** Fires when s crosses this. Small wrist flick (6 m/s², 200 deg/s) peaks ≈ 1.6–2; walking ≈ 0.5–0.8. */
  FLICK_THR: 1.0,
  /** Without a gyro: s = |lin| / FLICK_LIN_REF_NOGYRO. */
  FLICK_LIN_REF_NOGYRO: 4.5,
  /** Adaptive gate: also needs s > FLICK_BASE_K * the 1 s background level (continuous motion raises it). */
  FLICK_BASE_K: 2.4,
  FLICK_BASE_TC: 1.0,
  /** Emit at the peak (s falling below this fraction of the peak) or this long after onset (s). */
  FLICK_PEAK_FALL: 0.8,
  FLICK_MAX_WAIT: 0.08,
  /** Refractory from onset (s); the score must also drop below FLICK_REARM * threshold. */
  FLICK_REFRACTORY: 0.25,
  FLICK_REARM: 0.7,
  /** Strength: threshold → FLICK_V_MIN, FLICK_HARD_S → 100. */
  FLICK_V_MIN: 15,
  FLICK_HARD_S: 6,

  // ------------------------------------------------------------------ still / table / activity
  /** Window (EMA of squares) for movement RMS. */
  STILL_TC: 0.25,
  /** Sensor noise floors subtracted before scoring (raised automatically to the measured table noise). */
  STILL_ACC_FLOOR: 0.03,
  STILL_GYRO_FLOOR: 0.25,
  STILL_FLOOR_MAX_ACC: 0.08,
  STILL_FLOOR_MAX_GYRO: 0.6,
  /** mv = accRms'/STILL_ACC_REF + gyroRms'/STILL_GYRO_REF; a = 1000 * (1 − e^(−mv)). Tremor ≈ 20–80. */
  STILL_ACC_REF: 3,
  STILL_GYRO_REF: 50,
  /** Without a gyro the accel term carries everything. */
  STILL_ACC_REF_NOGYRO: 1.5,
  /** c = ∫a dt / STILL_ACCUM_SECONDS (i.e. the mean `a` over a 15 s game), capped at 1000. */
  STILL_ACCUM_SECONDS: 15,
  /** "Resting on a table": gyro RMS and accel RMS below these ("too perfect") for TABLE_HOLD seconds. */
  TABLE_GYRO: 0.35,
  TABLE_ACC: 0.06,
  TABLE_ACC_NOGYRO: 0.03,
  TABLE_HOLD: 1.2,
  /** Hand-held (activity): gyro RMS above HAND_GYRO (or accel RMS above HAND_ACC without a gyro, or
   *  above HAND_ACC_BIG always) for HAND_HOLD seconds. Physiological tremor is ~1–5 deg/s. */
  HAND_GYRO: 0.5,
  HAND_ACC: 0.045,
  HAND_ACC_BIG: 0.25,
  HAND_HOLD: 0.2,

  // ------------------------------------------------------------------ pose
  /** Enter a pose within this angle of its axis; leave when farther than POSE_EXIT_DEG (hysteresis). */
  POSE_ENTER_DEG: 35,
  POSE_EXIT_DEG: 45,
  /** A candidate must be held this long to become the stable pose (and fire the event). */
  POSE_HOLD: 0.3,

  // ------------------------------------------------------------------ tilt
  /** ±1000 = ±TILT_FULL_DEG from the neutral captured at calibrate(). */
  TILT_FULL_DEG: 30,
  TILT_DEADZONE_DEG: 1.5,
  TILT_SMOOTH_TC: 0.08,

  // ------------------------------------------------------------------ pitch / raise
  /** Holstered: pitch below RAISE_LOW_DEG for RAISE_HOLSTER seconds arms the detector. */
  RAISE_LOW_DEG: -45,
  RAISE_HOLSTER: 0.2,
  /** Raised: pitch above RAISE_HIGH_DEG within RAISE_WINDOW seconds of leaving the holster. */
  RAISE_HIGH_DEG: -20,
  RAISE_WINDOW: 0.6,

  // ------------------------------------------------------------------ aim
  /** ±1000 = ±AIM_FULL_DEG of wrist rotation from the re-centre point. */
  AIM_FULL_DEG: 25,
  /** The integrator clamps a bit past full scale so coming back responds immediately. */
  AIM_CLAMP_DEG: 28,
  /** Slow drift correction: aim decays toward the centre with this tc (s). */
  AIM_DECAY_TC: 30,
} as const;

export type MotionTuning = typeof MT;
