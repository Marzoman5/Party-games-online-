/**
 * PARTY RUSH — every gameplay tuning constant, one block per minigame, so the owner can adjust the
 * feel after a real party test without hunting through code. Each minigame imports ONLY its own block.
 * (Phone-side gesture-detector thresholds live in src/phone/motion/tuning.ts.)
 *
 * Ownership: each minigame agent edits only its own block (keep the `export const NAME = {...}` line).
 * Values are per heat where it matters: [heat1, heat2, heat3]. Heat makes games faster, never fussier.
 */

/** Loop timings + scoring (SHELL). */
export const LOOP = {
  /** Intermission auto-advance default (seconds). */
  autoAdvanceSec: 10,
  /** "UP NEXT" card (seconds). */
  upNextSec: 5,
  /** Extra "Hold your phone tight!" beat before energetic games (seconds). */
  safeCardSec: 2,
  /** 3-2-1 (seconds per number). */
  countStepSec: 0.8,
  /** Round results card (seconds) before the scoreboard. */
  resultsSec: 6,
  /** Bonus points for 1st place (on top of N for 1st). */
  firstBonus: 2,
  /** A player with no motion/input for a whole round becomes "away". */
  awayAfterIdleRounds: 1,
  /** Away players drop off the scoreboard after this long (ms). */
  dropAfterAwayMs: 10 * 60_000,
  /** Solo: total participants with bots when only 1 human is present. */
  soloTotal: 3,
  /** Hot-streak column = points over the last N rounds. */
  streakRounds: 5,
  /** Crown check every N rounds. */
  crownEvery: 10,
} as const;

/** 1 · Shake Race (MG1). */
export const SHAKE_RACE = {
  /** Seconds to reach the line at full effective speed (eff = 1.0) per heat. Average shaking (≈0.6) ≈ 80 % of the cap. */
  finishSec: [5.8, 4.8, 4.3],
  /** Energy smoothing time constant (s). */
  smoothTau: 0.25,
  /** Above this energy (0..1) extra shaking only counts × aboveKneeGain (no reward for dangerous flailing). */
  knee: 0.7,
  aboveKneeGain: 0.3,
  /** Rubber band: the leader runs × (1 − lead), the last × (1 + last); linear in between. */
  rubberLead: 0.15,
  rubberLast: 0.15,
  /** Rubber band only kicks in once the spread (0..1 of the track) exceeds this. */
  rubberMinSpread: 0.04,
  /** No stream sample for this long (s) → that player's energy fades to 0. */
  staleSec: 0.4,
  /** The round ends this long (s) after the first player crosses the line (others can still finish). */
  graceAfterFirstSec: 1.2,
  /** "Photo finish" superlative when 1st and 2nd are this close (fraction of the track / finish time). */
  photoGap: 0.02,
} as const;
/** 2 · Quick Draw (MG1). */
export const QUICK_DRAW = {
  /** Draws per round (score = sum of the best 2). */
  draws: 3,
  countBest: 2,
  /** Random wait before DRAW per heat [min, max] (s); squeezed if 3 draws would not fit the cap. */
  waitSec: [
    [2, 6],
    [1.75, 5.25],
    [1.5, 4.5],
  ],
  /** "Phones down" beat before draws 2 and 3 (s) per heat. */
  holsterSec: [1.4, 1.2, 1.0],
  /** How long a DRAW stays open (s); not raised by then = a miss (counts outSec). */
  drawWindowSec: 1.5,
  /** Time charged for an early raise (OUT) or a miss (s). */
  outSec: 1.5,
  /** Show the times of a draw this long (s) per heat. */
  revealSec: [1.7, 1.5, 1.3],
  /** Raises in the first moments of the wait are ignored (people still settling). */
  earlyGraceSec: 0.4,
  /** Pitch (tenths of a degree) below which a phone counts as "holstered" (pointing down). */
  downPitch: -150,
  /** Fake-outs: minimum gap between fakes and no fake this close (s) before the real DRAW. */
  fakeGapSec: 1.1,
  fakeQuietBeforeDrawSec: 0.7,
  /** Chance per possible slot that a fake-out happens, per heat. */
  fakeChance: [0.55, 0.65, 0.75],
} as const;
/** 3 · Balance (MG2). */
export const BALANCE = {
  /** Tilt smoothing time constant (s) — heavy, so a sloppy wrist still steers smoothly. */
  tiltTau: 0.16,
  /** Full tilt (±1000) maps to this; samples beyond are clamped. */
  tiltMax: 1.15,
  /** Ball acceleration at full tilt (plate radii / s²). */
  accel: 3.4,
  /** Rolling friction (1/s): high = forgiving, ball stops quickly. */
  damping: 2.4,
  /** Wobble force at GO (plate radii / s²) per heat. */
  wobbleStart: [0.35, 0.45, 0.55],
  /** Wobble growth per heat: wobble = start + growth × t^1.5 (calm start, wild finish). */
  wobbleGrowth: [0.02, 0.026, 0.032],
  /** How fast the wobble direction drifts (rad/s) per heat, grows ×(1 + t/20). */
  wobbleSpin: [0.9, 1.1, 1.3],
  /** Ball is OUT when its centre passes this radius (plate radius = 1). */
  rim: 1.0,
  /** Danger zone (rim glows) / near-miss radius for "Clutch save". */
  danger: 0.8,
  /** A near-miss counts once the ball comes back inside this radius. */
  saveBack: 0.5,
  /** Grace (s) after the last ball standing is decided, so the splat can be seen. */
  endDelay: 1.3,
} as const;
/** 4 · Tilt Maze (MG2). */
export const TILT_MAZE = {
  /** Maze grid per heat [cols, rows]. Cells stay ≥ 150 units (corridors ≥ 130) at every heat. */
  grid: [
    [8, 4],
    [9, 5],
    [10, 5],
  ],
  /** Accepted shortest-path length (cells) per heat [min, max]; candidates outside are re-rolled. */
  pathLen: [
    [11, 15],
    [13, 18],
    [15, 20],
  ],
  /** Extra walls knocked out after carving (0..1 of interior walls) → loops, several routes. */
  braid: [0.07, 0.06, 0.05],
  /** Tilt smoothing time constant (s). */
  tiltTau: 0.12,
  /** Marble acceleration at full tilt (units/s²) per heat. */
  accel: [760, 840, 920],
  /** Rolling friction (1/s). Terminal speed ≈ accel / damping. */
  damping: 2.0,
  /** Wall bounce (0..1). */
  restitution: 0.3,
  /** Bumper kick speed (units/s) added on contact. */
  bumperKick: 330,
  /** Bumpers / mud cells per maze per heat. */
  bumpers: [3, 4, 4],
  mud: [2, 3, 3],
  /** In mud: acceleration × and extra friction (1/s). */
  mudAccel: 0.55,
  mudDamping: 5.5,
  /** Seconds left after the first marble escapes (ends the round early). */
  hurryAfterFirst: [12, 10, 9],
} as const;
/** 5 · Hot Potato (MG1). */
export const HOT_POTATO = {
  /** Hidden fuse per heat [min, max] (s); a bomb's fuses are squeezed to fit the cap. */
  fuseSec: [
    [8, 16],
    [7, 14],
    [6, 12],
  ],
  /** Fuses (bangs) per bomb per round [min, max]. */
  fuses: [2, 3],
  /** Shortest fuse after squeezing (s). */
  minFuseSec: 4,
  /** Bombs in play by player count: ≥ twoBombsAt → 2, ≥ threeBombsAt → 3. */
  twoBombsAt: 6,
  threeBombsAt: 11,
  /** Bomb flight time on the TV (s). */
  flightSec: 0.45,
  /** After a catch the bomb can't be passed on for this long (s) → total pass cooldown ≈ flight + lock ≈ 0.8 s. */
  catchLockSec: 0.35,
  /** A caught bomb always has at least this much fuse left after the lock (s): no unavoidable bangs. */
  minFuseAfterCatch: 0.3,
  /** …but catch grace never pushes a bang more than this past the hidden fuse (no endless ping-pong). */
  overtimeSec: 0.8,
  /** Pause after a bang before that bomb's next fuse is lit (s). */
  bangPauseSec: 1.6,
  /** Second/third bomb start this much later (s) so bangs don't coincide. */
  bombStagger: 1.0,
  /** Holder cue `v` refresh interval (s) (fire:false). */
  cueEverySec: 0.25,
} as const;
/** 6 · Don't Move! (MG1). */
export const DONT_MOVE = {
  /** Mean gap between TV distractions (s) per heat (±35 % jitter). */
  distractEverySec: [2.4, 2.0, 1.6],
  /** First distraction no earlier than this (s after GO). */
  distractFromSec: 1.6,
  /** A phone resting on a table counts as at least this much movement (0..1000) per sample. */
  tableMovement: 800,
  /** Movement below this (0..1000) is sensor noise and counts as 0 (forgiving). */
  noiseFloor: 40,
  /** Wobble display smoothing (s). */
  smoothTau: 0.15,
  /** Ice cracks: crack fraction = 1 − exp(−wobble / crackK), wobble in movement-seconds (a/1000 · s). */
  crackK: 3.0,
} as const;
/** 7 · Tug of War (MG3). */
export const TUG_OF_WAR = {
  /** Drum beat period (s) per heat — faster beat at higher heat (the timing window stays the same). */
  beatSec: [0.62, 0.55, 0.49],
  /** First beat this long after GO (s). */
  firstBeatSec: 0.7,
  /** On-beat window (± ms), judged from the phone-measured ms since the beat cue. */
  windowMs: 220,
  /** Pull strengths: on the beat / off the beat / mashing (more than `mashAfter` pulls in one beat). */
  onBeat: 1.0,
  offBeat: 0.25,
  mash: 0.1,
  mashAfter: 3,
  /** Rope travel (fraction of the way to a win line) per unit of team-average pull strength. */
  pullGain: [0.1, 0.11, 0.12],
  /** The round keeps rendering this long after the rope crosses, then ends (s). */
  endDelaySec: 1.6,
} as const;
/** 8 · Copy the Pose (MG3). */
export const COPY_POSE = {
  /** Poses per round per heat. */
  poses: [6, 7, 8],
  /** Max seconds per pose (ends early when everyone matched). */
  poseSec: [4.4, 3.4, 2.8],
  /** Pause between poses (s). */
  gapSec: [0.8, 0.65, 0.5],
  /** First pose this long after GO (s). */
  firstPoseSec: 0.3,
  /** Don't start a new pose with less than this many seconds left. */
  minPoseSec: 1.6,
  /** Pose-stream backup: confidence needed, delay after the pose starts (s) and the ms penalty it adds. */
  streamConf: 500,
  streamDelaySec: 0.35,
  streamPenaltyMs: 150,
} as const;
/** 9 · Fishing (MG3). */
export const FISHING = {
  /** Wait between cast and bite (s, [min, max]) per heat. */
  waitSec: [
    [2, 6],
    [1.7, 5],
    [1.4, 4.2],
  ],
  /** Hook window after the bite cue (phone-measured ms). */
  biteWindowMs: 1500,
  /** Extra host-side grace (s) on top of the window before a bite counts as missed (relay latency). */
  biteGraceSec: 0.35,
  /** After a missed bite the fish nibbles again after [min, max] s. */
  rebiteSec: [1.2, 2.5],
  /** Yank with no bite: fish scared for this long (s). */
  scareSec: 1.5,
  /** Flicks within this long after a cast are follow-through, ignored (s). */
  castGraceSec: 0.7,
  /** Bobber flight time (s). */
  castFlySec: 0.5,
  /** Reel time at full energy: base + per kg (s), × heat multiplier. */
  reelBaseSec: 1.1,
  reelPerKgSec: 0.3,
  reelHeatMul: [1, 0.88, 0.76],
  /** Shake energy (0..1000) that counts as "full speed" reeling. */
  fullEnergy: 650,
  /** Shake energy below this is just a hand holding a phone: it reels nothing (only the creep). */
  reelDeadEnergy: 250,
  /** Right after the hook the yank itself still rings in the shake energy: ignore it this long (s). */
  reelGraceSec: 0.6,
  /** Reel still creeps at this fraction of full speed with no shaking (never stuck). */
  reelCreep: 0.04,
  /** Fish on display after landing (s). */
  landShowSec: 1.3,
  /** Idle this long → the line casts itself (s). */
  autoCastSec: 5,
  /** A yank faster than this (ms) catches a bigger fish (× quickBonus). */
  quickYankMs: 550,
  quickBonus: 1.25,
  /** Chance a catch is an old boot (0 kg). */
  bootChance: 0.1,
} as const;
/** 10 · Darts (MG2). */
export const DARTS = {
  /** Darts per player. */
  darts: 3,
  /** Score rings, from the bull outwards: outer radius (board radius = 1) and points. Very generous. */
  rings: [
    { r: 0.1, pts: 50 },
    { r: 0.3, pts: 25 },
    { r: 0.55, pts: 15 },
    { r: 0.8, pts: 10 },
    { r: 1.0, pts: 5 },
  ],
  /** Aim smoothing time constant (s). */
  aimTau: 0.09,
  /** Aim stream gain: ±1000 → ±gain board radii (the phone maps ±1000 to the board edge). */
  aimGain: 1.0,
  /** Per-player resting offset (board radii) so 16 crosshairs don't stack at rest. */
  spread: 0.16,
  /** Crosshair sway amplitude (board radii) and speed (Hz) per heat. */
  sway: 0.035,
  swayHz: [0.45, 0.5, 0.55],
  /** The dart lands where the crosshair was this long before the flick (cancels the flick's own jerk). */
  lookBack: 0.15,
  /** Random landing scatter (board radii). */
  scatter: 0.015,
  /** Minimum seconds between two darts of one player, per heat. */
  cooldown: [0.7, 0.6, 0.5],
  /** Dart flight time (s). */
  flight: 0.28,
  /** Round ends this long after the last dart landed. */
  endDelay: 1.2,
} as const;
