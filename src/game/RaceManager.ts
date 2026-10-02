/**
 * Race director: grid placement, countdown + start boost, ordered checkpoints,
 * laps, finish detection, positions, wrong-way detection, respawns and the
 * post-finish grace period. Runs inside the fixed-step loop.
 */
import * as THREE from 'three';
import type { Difficulty, IKart, ITrack, RaceSettings, RaceStanding, TrackSample } from '../core/types';
import { events } from '../core/events';
import { CHECKPOINT_COUNT, COUNTDOWN_STEP_SECONDS, VOID_Y } from '../core/constants';
import { seededRandom, trackDelta, wrap01 } from '../core/math';

export type RacePhase = 'grid' | 'countdown' | 'racing' | 'complete';

const COUNTDOWN_STEPS = 3;
/**
 * Rocket start (per human). We remember WHEN the throttle went down (rising edge)
 * during the countdown, measured as seconds before GO:
 *   - throttle held since before the countdown began (phone auto-accelerate, or a
 *     player who never let go) -> neutral: no boost, no penalty;
 *   - rose within ROCKET_WINDOW s of GO and still held at GO -> ROCKET start;
 *   - rose within GOOD_WINDOW s of GO -> small boost;
 *   - rose earlier during the countdown and held to GO -> BURNOUT (engine stalls
 *     for BURNOUT_SECONDS, no boost);
 *   - not holding throttle at GO -> nothing.
 * A DRIFT tap while the throttle is held re-arms the timer, so a player who
 * held gas the whole time can still earn a rocket by tapping DRIFT on "1".
 * Phones with auto-accelerate send throttle 0 during "3"/"2" and start the
 * auto-gas ~0.35 s before GO, so they land in the rocket window by design.
 */
const ROCKET_WINDOW = 0.85;
const GOOD_WINDOW = 1.3;
const BURNOUT_SECONDS = 0.7;
const WRONG_WAY_SECONDS = 1.2;
const WRONG_WAY_SPEED = -1;
const VOID_SECONDS = 1.5;
const STUCK_SECONDS = 6;
const STUCK_SPEED = 0.5;
const RESPAWN_FREEZE_SECONDS = 0.6;
const PLACE_DEBOUNCE_SECONDS = 0.3;
const FINISH_GRACE_SECONDS = 12;
/** A checkpoint counts as reached while the kart is within this many sectors past it. */
const CHECKPOINT_WINDOW_SECTORS = 1.9;

interface Tracker {
  kart: IKart;
  nextCheckpoint: number;
  started: boolean;
  lapsCompleted: number;
  wrongWayTimer: number;
  voidTimer: number;
  stuckTimer: number;
  respawnFreeze: number;
  emittedPlace: number;
  candidatePlace: number;
  candidateTimer: number;
  throttleStreak: number;
  aiStartBoost: boolean;
  respawnCount: number;
  human: boolean;
  /** Countdown timer value when the throttle last went down; -Infinity = held since before the countdown; NaN = not held. */
  throttleRiseAt: number;
  throttleHeld: boolean;
  prevDrift: boolean;
  /** Seconds of post-GO stall (burnout). */
  burnout: number;
  /** Did not finish (force-finished at race end): time is reported as -1. */
  dnf: boolean;
}

export type StartResult = 'rocket' | 'good' | 'burnout' | 'none';

function makeSampleScratch(): TrackSample {
  return {
    position: new THREE.Vector3(),
    tangent: new THREE.Vector3(0, 0, -1),
    normal: new THREE.Vector3(0, 1, 0),
    binormal: new THREE.Vector3(1, 0, 0),
    halfWidth: 0,
    wallHalfWidth: 0,
    t: 0,
  };
}

export class RaceManager {
  readonly totalLaps: number;
  readonly difficulty: Difficulty;

  private phase: RacePhase = 'grid';
  private time = 0;
  private countdownTimer = 0;
  private countdownEmitted = 0;
  private finishedCount = 0;
  /** Race time when the grace period started (all humans finished / first finisher with no humans). */
  private graceStartAt = -1;
  private allFinishedEmitted = false;
  /** Called at GO for every human kart (HUD feedback). */
  onStartResult: ((kartId: number, result: StartResult) => void) | null = null;

  private readonly trackers: Tracker[] = [];
  private readonly order: Tracker[] = [];
  private readonly checkpointT: number[] = [];
  private readonly sample = makeSampleScratch();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpEuler = new THREE.Euler();
  private readonly humanTrackers: Tracker[] = [];

  constructor(
    private readonly track: ITrack,
    private readonly karts: readonly IKart[],
    settings: RaceSettings,
  ) {
    this.totalLaps = Math.max(1, Math.floor(settings.laps));
    this.difficulty = settings.difficulty;

    const cps = track.checkpoints;
    if (cps.length >= 2) {
      for (const c of cps) this.checkpointT.push(wrap01(c.t));
    } else {
      for (let i = 0; i < CHECKPOINT_COUNT; i++) this.checkpointT.push(i / CHECKPOINT_COUNT);
    }

    const rng = seededRandom(0x5eed + this.totalLaps * 7);
    const aiBoostChance = settings.difficulty === 'hard' ? 0.75 : settings.difficulty === 'normal' ? 0.5 : 0.3;
    for (const kart of karts) {
      const tr: Tracker = {
        kart,
        nextCheckpoint: 0,
        started: false,
        lapsCompleted: -1,
        wrongWayTimer: 0,
        voidTimer: 0,
        stuckTimer: 0,
        respawnFreeze: 0,
        emittedPlace: 0,
        candidatePlace: 0,
        candidateTimer: 0,
        throttleStreak: 0,
        aiStartBoost: !kart.state.isPlayer && rng() < aiBoostChance,
        respawnCount: 0,
        human: kart.state.isPlayer,
        throttleRiseAt: Number.NaN,
        throttleHeld: false,
        prevDrift: false,
        burnout: 0,
        dnf: false,
      };
      this.trackers.push(tr);
      this.order.push(tr);
    }
    for (const tr of this.trackers) if (tr.human) this.humanTrackers.push(tr);

    this.placeOnGrid();
    this.sortOrder();
    for (let i = 0; i < this.order.length; i++) {
      const tr = this.order[i];
      tr.kart.state.place = i + 1;
      tr.emittedPlace = i + 1;
      tr.candidatePlace = i + 1;
    }
  }

  // ------------------------------------------------------------------ public

  get raceTime(): number {
    return this.time;
  }

  get currentPhase(): RacePhase {
    return this.phase;
  }

  get started(): boolean {
    return this.phase === 'racing' || this.phase === 'complete';
  }

  get allFinished(): boolean {
    return this.allFinishedEmitted;
  }

  /** 3, 2, 1 while counting down, 0 otherwise. */
  get countdownValue(): number {
    if (this.phase !== 'countdown') return 0;
    return Math.max(1, COUNTDOWN_STEPS - Math.floor(this.countdownTimer / COUNTDOWN_STEP_SECONDS));
  }

  /** Begin the 3-2-1-GO sequence (karts stay frozen until GO). */
  startCountdown(): void {
    if (this.phase !== 'grid') return;
    this.phase = 'countdown';
    this.countdownTimer = 0;
    this.countdownEmitted = 0;
    for (const tr of this.trackers) {
      tr.kart.setFrozen(true);
      tr.throttleHeld = tr.kart.input.throttle > 0.5;
      tr.throttleRiseAt = tr.throttleHeld ? Number.NEGATIVE_INFINITY : Number.NaN;
      tr.prevDrift = tr.kart.input.drift;
    }
  }

  /** Attract mode: skip the countdown entirely (no events, no start boosts). */
  startImmediately(): void {
    if (this.phase === 'racing' || this.phase === 'complete') return;
    this.phase = 'racing';
    this.time = 0;
    for (const tr of this.trackers) {
      tr.kart.setFrozen(false);
      tr.stuckTimer = 0;
    }
  }

  /** Debug: jump straight to GO (used by finish hooks during intro/countdown). */
  skipToRacing(): void {
    if (this.phase === 'grid' || this.phase === 'countdown') this.go();
  }

  isFinished(kartId: number): boolean {
    const tr = this.trackers.find((t) => t.kart.state.id === kartId);
    return !!tr && tr.kart.state.finished;
  }

  isDnf(kartId: number): boolean {
    const tr = this.trackers.find((t) => t.kart.state.id === kartId);
    return !!tr && tr.dnf;
  }

  /** Debug: make one kart cross the line now (keeps the order plausible). */
  forceFinish(kartId: number): void {
    this.skipToRacing();
    const tr = this.trackers.find((t) => t.kart.state.id === kartId);
    if (!tr || tr.kart.state.finished) return;
    tr.lapsCompleted = this.totalLaps;
    tr.kart.state.raceProgress = Math.max(tr.kart.state.raceProgress, this.totalLaps + 0.001);
    this.finish(tr);
  }

  /** Debug: finish everyone in the current order and complete the race. */
  forceFinishAll(): void {
    this.skipToRacing();
    this.sortOrder();
    for (const tr of this.order) {
      if (!tr.kart.state.finished) {
        tr.lapsCompleted = this.totalLaps;
        this.finish(tr);
      }
    }
    this.completeRace();
  }

  update(dt: number): void {
    switch (this.phase) {
      case 'grid':
        return;
      case 'countdown':
        this.updateCountdown(dt);
        return;
      case 'racing':
      case 'complete':
        this.updateRacing(dt);
        return;
    }
  }

  getStandings(): RaceStanding[] {
    const out: RaceStanding[] = [];
    for (const tr of this.order) {
      const s = tr.kart.state;
      out.push({
        kartId: s.id,
        name: s.character.name,
        color: s.character.color,
        place: s.place,
        finishTime: s.finished ? s.finishTime : -1,
        isPlayer: s.isPlayer,
      });
    }
    out.sort((a, b) => a.place - b.place);
    return out;
  }

  dispose(): void {
    this.trackers.length = 0;
    this.order.length = 0;
  }

  // ----------------------------------------------------------------- private

  private placeOnGrid(): void {
    const grid = this.track.startGrid;
    if (grid.length === 0) return;
    // Humans start at the back of the grid (human 0 last), AI fill the front.
    const n = this.trackers.length;
    const slotFor = new Map<Tracker, number>();
    let h = 0;
    let a = 0;
    for (const tr of this.trackers) {
      if (tr.human) slotFor.set(tr, n - 1 - h++);
      else slotFor.set(tr, a++);
    }
    for (const tr of this.trackers) {
      const s = tr.kart.state;
      const slotIndex = Math.min(slotFor.get(tr) ?? 0, grid.length - 1) % grid.length;
      const slot = grid[slotIndex];
      tr.kart.resetTo(slot.position, slot.quaternion);
      tr.kart.setFrozen(true);
      s.trackT = wrap01(slot.t);
      s.lap = 1;
      s.checkpointIndex = 0;
      s.finished = false;
      s.finishTime = 0;
      s.wrongWay = false;
      // If a track's grid sits just past the line, treat the kart as already started.
      if (trackDelta(0, s.trackT) >= 0 && trackDelta(0, s.trackT) < 0.25) {
        tr.started = true;
        tr.lapsCompleted = 0;
        tr.nextCheckpoint = 1;
        s.checkpointIndex = 1;
      }
      s.raceProgress = this.computeProgress(tr);
    }
  }

  private updateCountdown(dt: number): void {
    // Rocket start bookkeeping for every human (see ROCKET_WINDOW).
    for (const tr of this.humanTrackers) {
      const inp = tr.kart.input;
      const thr = inp.throttle > 0.5;
      if (thr && !tr.throttleHeld) tr.throttleRiseAt = this.countdownTimer;
      else if (!thr) tr.throttleRiseAt = Number.NaN;
      if (thr && inp.drift && !tr.prevDrift) tr.throttleRiseAt = this.countdownTimer;
      tr.throttleHeld = thr;
      tr.prevDrift = inp.drift;
    }

    this.countdownTimer += dt;
    const total = COUNTDOWN_STEPS * COUNTDOWN_STEP_SECONDS;
    while (this.countdownEmitted < COUNTDOWN_STEPS && this.countdownTimer >= this.countdownEmitted * COUNTDOWN_STEP_SECONDS) {
      events.emit('race:countdown', { count: COUNTDOWN_STEPS - this.countdownEmitted });
      this.countdownEmitted++;
    }
    if (this.countdownTimer >= total) {
      this.go();
    }
  }

  private go(): void {
    this.phase = 'racing';
    this.time = 0;
    for (const tr of this.trackers) {
      tr.kart.setFrozen(false);
      tr.stuckTimer = 0;
    }
    events.emit('race:start', { trackId: this.track.def.id });

    // Start boost / burnout per human (see ROCKET_WINDOW).
    const total = COUNTDOWN_STEPS * COUNTDOWN_STEP_SECONDS;
    for (const tr of this.humanTrackers) {
      let result: StartResult = 'none';
      const held = tr.kart.input.throttle > 0.5;
      const rise = tr.throttleRiseAt;
      if (held && Number.isFinite(rise)) {
        const before = total - rise;
        if (before <= ROCKET_WINDOW) result = 'rocket';
        else if (before <= GOOD_WINDOW) result = 'good';
        else result = 'burnout';
      }
      if (result === 'rocket') tr.kart.applyBoost(0.45, 1.1, 'start');
      else if (result === 'good') tr.kart.applyBoost(0.22, 0.6, 'start');
      else if (result === 'burnout') {
        // Prefer the kart's own wheelspin stall (visual wobble); fall back to a short freeze.
        const k = tr.kart as IKart & { applyBurnout?: () => void };
        if (typeof k.applyBurnout === 'function') k.applyBurnout();
        else {
          tr.burnout = BURNOUT_SECONDS;
          tr.kart.setFrozen(true);
        }
      }
      this.onStartResult?.(tr.kart.state.id, result);
    }
    for (const tr of this.trackers) {
      if (tr.aiStartBoost) tr.kart.applyBoost(0.3, 0.8, 'start');
    }
  }

  private completeRace(): void {
    if (this.allFinishedEmitted) return;
    this.forceFinishRemaining();
    this.phase = 'complete';
    this.allFinishedEmitted = true;
    events.emit('race:allFinished', {});
  }

  private updateRacing(dt: number): void {
    this.time += dt;

    for (const tr of this.trackers) {
      this.updateTracker(tr, dt);
    }

    this.sortOrder();
    this.updatePlaces(dt);

    if (this.phase === 'racing' && !this.allFinishedEmitted) {
      if (this.graceStartAt < 0) {
        const humansDone =
          this.humanTrackers.length > 0
            ? this.humanTrackers.every((t) => t.kart.state.finished)
            : this.finishedCount > 0;
        if (humansDone) this.graceStartAt = this.time;
      }
      if (this.graceStartAt >= 0) {
        const allDone = this.finishedCount >= this.trackers.length;
        if (allDone || this.time - this.graceStartAt >= FINISH_GRACE_SECONDS) this.completeRace();
      }
    }
  }

  private updateTracker(tr: Tracker, dt: number): void {
    const kart = tr.kart;
    const s = kart.state;

    // Burnout stall after a too-early throttle.
    if (tr.burnout > 0) {
      tr.burnout -= dt;
      if (tr.burnout <= 0) {
        tr.burnout = 0;
        kart.setFrozen(false);
      }
      return;
    }

    // Respawn freeze.
    if (tr.respawnFreeze > 0) {
      tr.respawnFreeze -= dt;
      if (tr.respawnFreeze <= 0) {
        tr.respawnFreeze = 0;
        kart.setFrozen(false);
      }
      return;
    }

    const t = wrap01(s.trackT);

    // --- checkpoints (in order, tolerate skipping one) ------------------------
    if (!s.finished) {
      const n = this.checkpointT.length;
      for (let iter = 0; iter < 2; iter++) {
        const cpT = this.checkpointT[tr.nextCheckpoint];
        const d = trackDelta(cpT, t);
        if (d < 0 || d >= CHECKPOINT_WINDOW_SECTORS / n) break;
        this.passCheckpoint(tr);
        if (s.finished) break;
      }
    }

    // --- progress (monotonic) ----------------------------------------------
    const progress = this.computeProgress(tr);
    if (progress > s.raceProgress) s.raceProgress = progress;

    // --- wrong way ----------------------------------------------------------
    if (!s.finished) {
      const smp = this.track.sample(t, this.sample);
      const along = s.velocity.x * smp.tangent.x + s.velocity.y * smp.tangent.y + s.velocity.z * smp.tangent.z;
      if (along < WRONG_WAY_SPEED) {
        tr.wrongWayTimer += dt;
        if (tr.wrongWayTimer >= WRONG_WAY_SECONDS && !s.wrongWay) {
          s.wrongWay = true;
          events.emit('race:wrongWay', { kartId: s.id, wrongWay: true });
        }
      } else if (along > 0.5) {
        tr.wrongWayTimer = 0;
        if (s.wrongWay) {
          s.wrongWay = false;
          events.emit('race:wrongWay', { kartId: s.id, wrongWay: false });
        }
      }
    } else if (s.wrongWay) {
      s.wrongWay = false;
      events.emit('race:wrongWay', { kartId: s.id, wrongWay: false });
    }

    // --- respawn: void / fall / stuck ---------------------------------------
    let respawn = false;
    if (s.position.y < VOID_Y) {
      respawn = true;
    } else if (s.surface === 'void') {
      tr.voidTimer += dt;
      if (tr.voidTimer >= VOID_SECONDS) respawn = true;
    } else {
      tr.voidTimer = 0;
    }

    if (!respawn && !s.finished && !s.isFrozen) {
      const wantsToMove = s.isPlayer ? kart.input.throttle > 0.3 || kart.input.brake > 0.3 : true;
      if (Math.abs(s.speed) < STUCK_SPEED && wantsToMove && !s.isSpinning && !s.isSquished) {
        tr.stuckTimer += dt;
        if (tr.stuckTimer >= STUCK_SECONDS) respawn = true;
      } else {
        tr.stuckTimer = 0;
      }
    }

    if (respawn) this.respawn(tr);
  }

  private passCheckpoint(tr: Tracker): void {
    const s = tr.kart.state;
    const n = this.checkpointT.length;
    const idx = tr.nextCheckpoint;
    tr.nextCheckpoint = (idx + 1) % n;
    s.checkpointIndex = tr.nextCheckpoint;

    if (idx !== 0) return;

    // Crossed the finish line in valid order.
    if (!tr.started) {
      tr.started = true;
      tr.lapsCompleted = 0;
      return;
    }
    tr.lapsCompleted++;
    const newLap = tr.lapsCompleted + 1;
    if (tr.lapsCompleted >= this.totalLaps) {
      this.finish(tr);
      return;
    }
    s.lap = newLap;
    events.emit('race:lap', {
      kartId: s.id,
      lap: newLap,
      totalLaps: this.totalLaps,
      isPlayer: s.isPlayer,
      isFinalLap: newLap === this.totalLaps,
    });
  }

  private finish(tr: Tracker): void {
    const s = tr.kart.state;
    if (s.finished) return;
    s.finished = true;
    s.finishTime = this.time;
    s.lap = this.totalLaps + 1;
    this.finishedCount++;
    s.place = this.finishedCount;
    tr.emittedPlace = s.place;
    tr.candidatePlace = s.place;
    s.wrongWay = false;
    if (tr.burnout > 0) {
      tr.burnout = 0;
      tr.kart.setFrozen(false);
    }
    if (!tr.dnf) events.emit('race:finish', { kartId: s.id, place: s.place, time: s.finishTime, isPlayer: s.isPlayer });
  }

  private forceFinishRemaining(): void {
    // Order by progress (finished first) and mark the rest as DNF, no events.
    this.sortOrder();
    for (const tr of this.order) {
      if (!tr.kart.state.finished) {
        tr.dnf = true;
        this.finish(tr);
      }
    }
  }

  private computeProgress(tr: Tracker): number {
    const s = tr.kart.state;
    const n = this.checkpointT.length;
    const prev = (tr.nextCheckpoint - 1 + n) % n;
    const anchor = this.checkpointT[prev];
    // Unwrap t relative to the last validated checkpoint so a kart that reverses
    // back over the line reads as slightly negative instead of jumping to ~1.
    const frac = anchor + trackDelta(anchor, wrap01(s.trackT));
    // lapsCompleted is -1 until the first line crossing, so grid karts sit just below 0.
    return tr.lapsCompleted + frac;
  }

  private sortOrder(): void {
    // Insertion sort: 8 items, stable, allocation-free.
    const arr = this.order;
    for (let i = 1; i < arr.length; i++) {
      const item = arr[i];
      let j = i - 1;
      while (j >= 0 && this.compare(arr[j], item) > 0) {
        arr[j + 1] = arr[j];
        j--;
      }
      arr[j + 1] = item;
    }
  }

  private compare(a: Tracker, b: Tracker): number {
    const sa = a.kart.state;
    const sb = b.kart.state;
    if (sa.finished && sb.finished) return sa.place - sb.place;
    if (sa.finished) return -1;
    if (sb.finished) return 1;
    if (sb.raceProgress !== sa.raceProgress) return sb.raceProgress - sa.raceProgress;
    return sa.id - sb.id;
  }

  private updatePlaces(dt: number): void {
    for (let i = 0; i < this.order.length; i++) {
      const tr = this.order[i];
      const s = tr.kart.state;
      const place = i + 1;
      if (!s.finished) s.place = place;
      const target = s.place;
      if (target !== tr.candidatePlace) {
        tr.candidatePlace = target;
        tr.candidateTimer = 0;
      } else if (target !== tr.emittedPlace) {
        tr.candidateTimer += dt;
        if (tr.candidateTimer >= PLACE_DEBOUNCE_SECONDS || s.finished) {
          const from = tr.emittedPlace;
          tr.emittedPlace = target;
          events.emit('race:positionChange', { kartId: s.id, from, to: target, isPlayer: s.isPlayer });
        }
      }
    }
  }

  private respawn(tr: Tracker): void {
    const kart = tr.kart;
    const s = kart.state;
    const n = this.checkpointT.length;
    const idx = (tr.nextCheckpoint - 1 + n) % n;
    const cp = this.track.checkpoints[idx];
    let heading: number;
    if (cp) {
      this.tmpPos.copy(cp.position);
      heading = Math.atan2(-cp.forward.x, -cp.forward.z);
    } else {
      const smp = this.track.sample(this.checkpointT[idx], this.sample);
      this.tmpPos.copy(smp.position);
      heading = Math.atan2(-smp.tangent.x, -smp.tangent.z);
    }
    this.tmpPos.y += 0.35;
    this.tmpEuler.set(0, heading, 0);
    this.tmpQuat.setFromEuler(this.tmpEuler);
    kart.resetTo(this.tmpPos, this.tmpQuat);
    s.trackT = this.checkpointT[idx];
    s.wrongWay = false;
    tr.wrongWayTimer = 0;
    tr.voidTimer = 0;
    tr.stuckTimer = 0;
    tr.respawnCount++;
    kart.setFrozen(true);
    tr.respawnFreeze = RESPAWN_FREEZE_SECONDS;
    events.emit('kart:respawn', { kartId: s.id, position: this.tmpPos.clone() });
  }
}
