/**
 * CPU fighter brain for Smash Party (levels 1..9).
 *
 * The sim calls `think(sim)` once per 60 Hz frame for every CPU-controlled fighter and feeds the
 * returned SimInput as that fighter's input. Fully deterministic: the only randomness is the
 * seeded AiRng. Never throws (errors fall back to an empty input), never returns NaN.
 *
 * Structure (each frame):
 *   1. bookkeeping (position history for the reaction delay, geometry of the stage)
 *   2. state-driven handlers that override everything: grabbed (mash), grab hold (throw),
 *      ledge hang (get-up mix), respawn platform (leave), knockdown / dizzy
 *   3. off-stage -> recovery (all levels; quality scales a bit with level)
 *   4. defence reactions to noticed attacks / projectiles / lava
 *   5. scripted multi-frame actions (short-hop aerials, turn-then-attack, ...)
 *   6. neutral: target / item goal, movement with edge safety, move choice by range
 */
import type { FighterView, ISmashSim, ItemView, MoveId, SimInput } from '../../types';
import { emptySimInput, HITSTUN_PER_KB, LAUNCH_SPEED_PER_KB } from '../../types';
import { AiRng } from './rng';
import { levelParams, type LevelParams } from './levels';
import { physFor, type AiPhys } from './phys';
import { movesFor, type MoveReach } from './moveinfo';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const HIST = 64; // frames of position history (>= max reaction delay)

const sgn = (v: number): 1 | -1 => (v < 0 ? -1 : 1);
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const fin = (v: number, d = 0) => (Number.isFinite(v) ? v : d);

type Step = Partial<SimInput> & { t: number };

interface Geo {
  /** Main stage (ledged solid platform, or widest) current centre/top/edges. */
  cx: number;
  top: number;
  left: number;
  right: number;
  hasLedges: boolean;
  plats: { x: number; y: number; w: number; solid: boolean }[];
  blast: { left: number; right: number; top: number; bottom: number };
}

const NO_CONTROL: ReadonlySet<string> = new Set([
  'hitstun',
  'thrown',
  'shieldBreak',
  'shieldStun',
  'ledgeClimb',
  'getUp',
  'victory',
  'defeat',
  'ko',
  'out',
]);
const GROUND_ACT: ReadonlySet<string> = new Set(['idle', 'walk', 'run', 'turn', 'crouch', 'land']);
const AIR_ACT: ReadonlySet<string> = new Set(['jump', 'doubleJump', 'fall', 'tumble']);
/** States in which a fighter is open to a punish. */
const VULNERABLE: ReadonlySet<string> = new Set(['land', 'knockdown', 'dizzy', 'shieldBreak', 'getUp', 'helpless']);

const GOOD_ITEMS: ReadonlySet<string> = new Set(['bat', 'bomb', 'capsule']);

export class CpuController {
  /** Count of internal errors swallowed by think() (soak tests assert it stays 0). */
  static errors = 0;
  static logErrors = true;
  readonly fighter: number;
  private lv: LevelParams;
  private rng: AiRng;

  // position history of every fighter (for the reaction delay)
  private histX: Float64Array[] = [];
  private histY: Float64Array[] = [];
  private histN = 0;

  private lastFrame = -1;
  private target = -1;
  private targetUntil = 0;
  private nextDecision = 0;
  private lastAttack = -999;
  private moveX = 0; // current walking intent (-1..1)
  private wantJump = false;
  private dropReq = 0;
  private idleUntil = 0;

  // holds
  private jumpHold = 0;
  private shieldHold = 0;
  private attackHold = 0;
  private holdStickY = 0;
  private lastJumpPress = -999;
  private lastSpecialPress = -999;
  private lastShieldPress = -999;

  private script: Step[] = [];
  private scriptStart = 0;
  private scriptStick: { x: number; y: number } | null = null;

  // per-situation timers
  private ledgeWait = -1;
  private respawnWait = -1;
  private grabWait = -1;
  private pummels = 0;
  private mashPhase = 0;
  private seenAttack = new Map<number, number>(); // opponent -> frame the move started (already evaluated)
  private seenProj = new Set<number>();
  private recoverPlan = { dj: false, upb: false };
  private lastAirborneOff = false;
  private wasteJumpRoll = 0;
  private itemGoal = -1;
  private itemGoalUntil = 0;

  constructor(fighter: number, level: number, seed: number) {
    this.fighter = fighter | 0;
    this.lv = levelParams(level);
    this.rng = new AiRng((fin(seed, 1) | 0) ^ Math.imul(this.fighter + 1, 0x51ed27));
  }

  /** Change level at runtime (sim.setCpu on an existing controller). */
  setLevel(level: number): void {
    this.lv = levelParams(level);
  }

  get level(): number {
    return this.lv.level;
  }

  think(sim: ISmashSim): SimInput {
    let out: SimInput;
    try {
      out = this.decide(sim);
    } catch (e) {
      CpuController.errors++;
      if (CpuController.errors <= 3 && CpuController.logErrors) console.warn('[CpuController] think failed', e);
      out = emptySimInput();
      this.resetTransient();
    }
    out.x = clamp(fin(out.x), -1, 1);
    out.y = clamp(fin(out.y), -1, 1);
    return out;
  }

  // -------------------------------------------------------------------------

  private decide(sim: ISmashSim): SimInput {
    const fs = sim.fighters;
    const me = fs[this.fighter];
    const inp = emptySimInput();
    if (!me || me.out || me.dummy) return inp;
    const frame = fin(sim.frame, this.lastFrame + 1);
    this.lastFrame = frame;
    this.record(fs);
    if (sim.status !== 'fighting') {
      this.resetTransient();
      return inp;
    }
    if (me.action === 'ko') {
      this.resetTransient();
      return inp;
    }
    const geo = this.geometry(sim);
    const ph = physFor(me.characterId, me);

    // ----- states that ignore everything else -----
    if (me.action === 'grabbed' || me.action === 'dizzy') return this.mash(inp, frame);
    if (me.action === 'grabHold') return this.throwOpponent(sim, me, geo, inp);
    this.grabWait = -1;
    if (me.action === 'ledgeHang') return this.ledge(sim, me, geo, inp);
    this.ledgeWait = -1;
    if (me.action === 'respawn' || me.respawning) return this.leaveRespawn(sim, me, geo, inp);
    this.respawnWait = -1;
    if (me.action === 'knockdown') return this.getUp(sim, me, geo, inp, frame);
    // tumble: no control until the hitstun (0.4 * kb frames) is over, then it's a normal air state
    if (me.action === 'tumble' && me.actionFrame <= 1) {
      const hs = Math.floor((HITSTUN_PER_KB * fin(me.launchSpeed)) / LAUNCH_SPEED_PER_KB);
      if (me.actionFrame === 0 || hs > this.stunHs) this.stunHs = hs;
    }
    if (me.action === 'shieldStun') {
      // keep holding the shield through shield stun (then maybe punish out of shield)
      if (this.shieldHold > 0) {
        inp.shield = true;
        this.shieldHold = Math.max(this.shieldHold, 4);
      }
      return inp;
    }
    if (NO_CONTROL.has(me.action) || (me.action === 'tumble' && me.actionFrame < this.stunHs)) {
      this.script.length = 0;
      this.shieldHold = 0;
      this.dodgeStick = null;
      this.attackHold = 0;
      return inp;
    }

    // ----- sustained holds -----
    if (this.jumpHold > 0) {
      inp.jump = true;
      this.jumpHold--;
    }
    if (this.attackHold > 0) {
      if (me.action === 'attack') {
        inp.attack = true;
        inp.y = this.holdStickY;
      }
      this.attackHold--;
    }

    // ----- off stage: recover -----
    const off = this.isOffstage(me, geo);
    if (off) {
      this.script.length = 0;
      this.shieldHold = 0;
      this.lastAirborneOff = true;
      return this.recover(sim, me, ph, geo, inp, frame);
    }
    if (me.grounded) {
      this.recoverPlan.dj = false;
      this.recoverPlan.upb = false;
      this.lastAirborneOff = false;
    }
    if (me.action === 'helpless') {
      // falling over the stage: drift toward the stage centre / stay above ground
      const dx = geo.cx - me.x;
      if (Math.abs(dx) > (geo.right - geo.left) * 0.3) inp.x = sgn(dx) * 0.6;
      return inp;
    }

    // ----- shield in progress -----
    if (this.shieldHold > 0 && (me.grounded || me.action === 'shield')) {
      return this.shielding(sim, me, geo, inp, frame);
    }
    this.shieldHold = 0;
    this.dodgeStick = null;

    // ----- scripted actions -----
    if (this.script.length > 0) {
      if (this.runScript(inp, frame, me)) return inp;
    }

    // ----- defence -----
    if (this.defend(sim, me, geo, inp, frame)) return inp;

    // ----- lava -----
    if (this.lv.level >= 4 && (GROUND_ACT.has(me.action) || AIR_ACT.has(me.action)) && this.avoidLava(sim, me, geo, inp)) return inp;

    // ----- neutral -----
    return this.neutral(sim, me, ph, geo, inp, frame);
  }

  private resetTransient(): void {
    this.script.length = 0;
    this.jumpHold = 0;
    this.shieldHold = 0;
    this.dodgeStick = null;
    this.attackHold = 0;
    this.ledgeWait = -1;
    this.grabWait = -1;
    this.recoverPlan.dj = false;
    this.recoverPlan.upb = false;
  }

  // -------------------------------------------------------------------------
  // perception
  // -------------------------------------------------------------------------

  private record(fs: readonly FighterView[]): void {
    while (this.histX.length < fs.length) {
      this.histX.push(new Float64Array(HIST));
      this.histY.push(new Float64Array(HIST));
    }
    const k = this.histN % HIST;
    for (let i = 0; i < fs.length; i++) {
      this.histX[i][k] = fin(fs[i].x);
      this.histY[i][k] = fin(fs[i].y);
    }
    this.histN++;
  }

  /** Where I believe fighter j is (its position `react` frames ago, extrapolated a bit at high levels). */
  private seen(fs: readonly FighterView[], j: number): { x: number; y: number } {
    const f = fs[j];
    const d = Math.min(this.lv.react, this.histN - 1, HIST - 1);
    if (d <= 0 || !this.histX[j]) return { x: f.x, y: f.y };
    const k = (this.histN - 1 - d + HIST * 4) % HIST;
    let x = this.histX[j][k];
    let y = this.histY[j][k];
    if (this.lv.level >= 6) {
      // good players anticipate: partially extrapolate the delay
      x = x + (f.x - x) * 0.6;
      y = y + (f.y - y) * 0.6;
    }
    return { x: fin(x, f.x), y: fin(y, f.y) };
  }

  private geometry(sim: ISmashSim): Geo {
    const st = sim.stage;
    const sv = sim.stageView;
    const plats: Geo['plats'] = [];
    let main = -1;
    let bestW = -1;
    let mainLedged = false;
    const defs = st && Array.isArray(st.platforms) ? st.platforms : [];
    for (let i = 0; i < defs.length; i++) {
      const d = defs[i];
      const cur = sv && sv.platforms && sv.platforms[i] ? sv.platforms[i] : d;
      plats.push({ x: fin(cur.x), y: fin(cur.y), w: fin(d.w, 1), solid: !!d.solid });
      const ledged = !!(d.solid && d.ledges);
      const better = ledged && !mainLedged ? true : ledged === mainLedged && d.w > bestW;
      if (better) {
        main = i;
        bestW = d.w;
        mainLedged = ledged;
      }
    }
    const blast = st && st.blast ? st.blast : { left: -20, right: 20, top: 16, bottom: -10 };
    if (main < 0) return { cx: 0, top: 0, left: -7, right: 7, hasLedges: false, plats, blast };
    const m = plats[main];
    return { cx: m.x, top: m.y, left: m.x - m.w / 2, right: m.x + m.w / 2, hasLedges: mainLedged, plats, blast };
  }

  /** Is there a platform under (x) at or below height y? */
  private groundBelow(geo: Geo, x: number, y: number, margin = 0): boolean {
    for (const p of geo.plats) {
      if (Math.abs(x - p.x) <= p.w / 2 - margin && p.y <= y + 0.05) return true;
    }
    return false;
  }

  private isOffstage(me: FighterView, geo: Geo): boolean {
    if (me.grounded) return false;
    if (me.y < geo.top - 0.05) return true; // below the main stage surface: always recovering
    return !this.groundBelow(geo, me.x, me.y, 0.1);
  }

  private isFoe(sim: ISmashSim, me: FighterView, f: FighterView): boolean {
    if (f.index === me.index) return false;
    if (sim.config && sim.config.rules && sim.config.rules.teams && f.team === me.team) return false;
    return true;
  }

  private alive(f: FighterView): boolean {
    return !f.out && f.action !== 'ko' && f.action !== 'out';
  }

  // -------------------------------------------------------------------------
  // forced states
  // -------------------------------------------------------------------------

  private mash(inp: SimInput, frame: number): SimInput {
    // shieldPressed counts as a mash input and (unlike attack/special) does nothing harmful if it
    // is still buffered when we get released
    this.mashPhase++;
    const e = this.lv.mashEvery;
    if (this.mashPhase % e === 0) {
      inp.x = this.mashPhase % (2 * e) === 0 ? 1 : -1;
      inp.shieldPressed = true;
    }
    return inp;
  }

  private throwOpponent(sim: ISmashSim, me: FighterView, geo: Geo, inp: SimInput): SimInput {
    if (this.grabWait < 0) {
      this.grabWait = this.rng.int(4, 8) + Math.round(this.lv.react / 2);
      this.pummels = this.lv.level >= 4 ? this.rng.int(0, 3) : 0;
    }
    if (me.move === 'pummel' && me.movePhase !== 'endlag') return inp;
    if (this.grabWait > 0) {
      this.grabWait--;
      return inp;
    }
    if (this.pummels > 0) {
      this.pummels--;
      inp.attackPressed = true;
      this.grabWait = 8;
      return inp;
    }
    // victim = closest fighter (the one held)
    let victim: FighterView | null = null;
    let bd = 1e9;
    for (const f of sim.fighters) {
      if (f.index === me.index || f.action !== 'grabbed') continue;
      const d = Math.abs(f.x - me.x) + Math.abs(f.y - me.y);
      if (d < bd) {
        bd = d;
        victim = f;
      }
    }
    const pct = victim ? victim.damage : 0;
    const w = victim ? physFor(victim.characterId, victim).weight : 100;
    const toLeft = me.x - geo.left;
    const toRight = geo.right - me.x;
    const nearDir = toLeft < toRight ? -1 : 1;
    const nearDist = Math.min(toLeft, toRight);
    let dir: { x: number; y: number };
    if (this.lv.level <= 2) {
      const r = this.rng.int(0, 3);
      dir = r === 0 ? { x: 1, y: 0 } : r === 1 ? { x: -1, y: 0 } : r === 2 ? { x: 0, y: 1 } : { x: 0, y: -1 };
    } else if (nearDist < 4 || pct > 110 * (w / 100)) {
      dir = pct > 120 * (w / 100) && nearDist > 5 ? { x: 0, y: 1 } : { x: nearDir, y: 0 };
    } else if (this.lv.combos && pct < 60) {
      dir = this.rng.chance(0.6) ? { x: 0, y: -1 } : { x: 0, y: 1 };
    } else {
      dir = { x: nearDir, y: 0 };
    }
    inp.x = dir.x;
    inp.y = dir.y;
    return inp;
  }

  private ledge(sim: ISmashSim, me: FighterView, geo: Geo, inp: SimInput): SimInput {
    if (this.ledgeWait < 0) {
      const base = this.lv.level <= 2 ? this.rng.int(20, 70) : this.rng.int(4, 30);
      this.ledgeWait = base + Math.round(this.lv.react * 0.5);
    }
    if (me.actionFrame < 3) return inp;
    if (this.ledgeWait > 0) {
      this.ledgeWait--;
      return inp;
    }
    const toStage = me.ledge !== 0 ? (-me.ledge as number) : sgn(geo.cx - me.x);
    // opponent standing next to the ledge?
    let nearFoe = false;
    for (const f of sim.fighters) {
      if (!this.alive(f) || !this.isFoe(sim, me, f)) continue;
      if (Math.abs(f.x - me.x) < 2.2 && Math.abs(f.y - geo.top) < 1.2) nearFoe = true;
    }
    const w =
      nearFoe && this.lv.level >= 4
        ? [0.25, 0.3, 0.25, 0.2] // climb, jump, attack, roll
        : [0.5, 0.25, 0.05, 0.2];
    const opt = this.rng.weighted(w);
    if (opt === 0) inp.x = toStage;
    else if (opt === 1) {
      inp.jumpPressed = true;
      inp.jump = true;
      this.jumpHold = 6;
      this.lastJumpPress = this.lastFrame;
    } else if (opt === 2) inp.attackPressed = true;
    else inp.shieldPressed = true;
    this.ledgeWait = 20; // if it didn't take, retry later
    return inp;
  }

  private leaveRespawn(sim: ISmashSim, me: FighterView, geo: Geo, inp: SimInput): SimInput {
    if (this.respawnWait < 0) this.respawnWait = this.rng.int(10, this.lv.level <= 3 ? 90 : 40);
    if (this.respawnWait > 0) {
      this.respawnWait--;
      return inp;
    }
    // drop down toward the stage (centre-ish), alternating between neutral and down so the
    // "fresh push down" registers
    const dx = geo.cx - me.x;
    inp.x = Math.abs(dx) > 1 ? sgn(dx) * 0.5 : 0;
    inp.y = this.lastFrame % 6 < 3 ? -1 : 0;
    return inp;
  }

  private getUp(sim: ISmashSim, me: FighterView, geo: Geo, inp: SimInput, frame: number): SimInput {
    if (me.actionFrame < 6 + Math.round(this.lv.react * 0.5)) return inp;
    if (frame % 7 !== 0) return inp;
    // L4+: roll away from a lava eruption about to happen under/near us
    const hz = sim.stageView ? sim.stageView.hazard : null;
    if (this.lv.level >= 4 && hz && (hz.active || hz.warning > 0)) {
      const dx = me.x - fin(hz.x);
      if (Math.abs(dx) < fin(hz.w, 2) / 2 + 3) {
        let dir: number = sgn(dx);
        const ex = me.x + dir * 2.5;
        if (ex < geo.left + 0.5 || ex > geo.right - 0.5) dir = -dir;
        inp.x = dir;
        return inp;
      }
    }
    const r = this.rng.int(0, 3);
    if (r === 0) inp.attackPressed = true;
    else if (r === 1 || r === 2) {
      // roll, but never toward a nearby edge
      let dir: number = this.rng.chance(0.6) ? sgn(geo.cx - me.x) : -sgn(geo.cx - me.x);
      const ex = me.x + dir * 2.5;
      if (ex < geo.left + 0.5 || ex > geo.right - 0.5) dir = -dir;
      inp.x = dir;
    } else inp.y = 1;
    return inp;
  }

  // -------------------------------------------------------------------------
  // recovery
  // -------------------------------------------------------------------------

  private recover(sim: ISmashSim, me: FighterView, ph: AiPhys, geo: Geo, inp: SimInput, frame: number): SimInput {
    const side = me.x < geo.cx ? -1 : 1; // which side of the stage we are on
    const toward = -side;
    const lx = side < 0 ? geo.left : geo.right;
    const ly = geo.top;
    const outDist = side < 0 ? geo.left - me.x : me.x - geo.right; // > 0 outside the stage edge
    const below = ly - me.y; // > 0 below the ledge
    const lvl = this.lv;

    // horizontal: while below the ledge, hug the outside of the stage wall (never drift under the
    // stage: the up-special would bonk on its underside); at/above ledge height, drift onto the stage.
    const wallX = lx + side * (me.width / 2 + 0.3);
    const desiredX = below > 0.4 ? wallX : lx + toward * 1.2;
    const predX = me.x + me.vx * 8;
    const err = desiredX - predX;
    inp.x = Math.abs(err) > 0.12 ? sgn(err) : 0;
    const steerX = inp.x;
    if (me.action === 'helpless' || me.action === 'airDodge') return inp;
    if (me.action === 'attack') {
      if (me.move === 'uspecial') {
        if (ph.upBTeleport > 0) {
          const a = this.teleAim(me, lx, ly, toward);
          inp.x = a.x;
          inp.y = a.y;
        } else {
          inp.x = steerX;
          inp.y = 1;
        }
      }
      return inp;
    }

    const canDJ = me.jumpsLeft > 0 && frame - this.lastJumpPress > 8;
    const djH = ph.djHeight; // height gained by a double jump
    const upH = ph.upBHeight;
    const upX = ph.upBDist;
    const falling = me.vy < 0.005;
    const sloppy = lvl.recover < 1 && this.rng.chance((1 - lvl.recover) * 0.04);

    // Low level waste: occasionally burn the double jump right away / up-special early.
    if (sloppy && canDJ) {
      this.pressJump(inp, true);
      return inp;
    }

    // time to fall to the "must up-B now" height
    const upbNeedBelow = upH * 0.75; // fire up-special by the time we're this far below the ledge
    const horizReachable = outDist <= upX + Math.max(0, upH - below) * 0.5 + 0.4;

    if (canDJ) {
      // double jump when falling and at/below ledge height (or far out / very low)
      const farOut = outDist > upX + 2.5;
      const low = below > djH * 0.25;
      if ((falling && (below > -0.4 || farOut)) || low) {
        this.pressJump(inp, true);
        inp.x = outDist > 0 ? toward : side;
        return inp;
      }
      return inp;
    }

    // no double jump left: up-special
    // never waste the up-special while still rising from the double jump (unless about to die)
    const rising = me.vy > 0.03 && me.y > geo.blast.bottom + 2.5;
    if (!me.grounded && !rising && frame - this.lastSpecialPress > 20) {
      if (ph.upBTeleport > 0) {
        const tx = lx + toward * 0.8;
        const ty = ly + 0.4;
        const d = Math.hypot(tx - me.x, ty - me.y);
        const urgent = below >= ph.upBTeleport * 0.6 || me.y < geo.blast.bottom + 3;
        if ((falling && d <= ph.upBTeleport * 0.92 && below > -1) || urgent) {
          const a = this.teleAim(me, lx, ly, toward);
          inp.specialPressed = true;
          this.lastSpecialPress = frame;
          inp.x = a.x;
          inp.y = Math.max(0.51, a.y); // must read as UP special
          if (Math.abs(inp.x) > inp.y) inp.x = sgn(inp.x) * inp.y;
          return inp;
        }
      } else {
        const urgent = below >= Math.min(upbNeedBelow, Math.max(2.5, upH * 0.5)) || me.y < geo.blast.bottom + Math.min(upH, 6) + 1.5;
        const inWindow = falling && below > -upH * 0.3 && horizReachable;
        if (urgent || (inWindow && (below > Math.min(upH * 0.2, 1.5) || outDist < upX * 0.6))) {
          inp.specialPressed = true;
          this.lastSpecialPress = frame;
          inp.y = 1;
          inp.x = steerX * 0.9;
          return inp;
        }
      }
    }
    // L6+: avoid an edge-guarder right above with an air dodge (rarely)
    if (lvl.level >= 6 && me.y > ly + 0.5 && this.rng.chance(0.01)) {
      for (const f of sim.fighters) {
        if (!this.alive(f) || !this.isFoe(sim, me, f)) continue;
        if (f.action === 'attack' && Math.hypot(f.x - me.x, f.y - me.y) < 1.8 && frame - this.lastShieldPress > 30) {
          inp.shieldPressed = true;
          this.lastShieldPress = frame;
          inp.x = toward;
          inp.y = 0.3;
          return inp;
        }
      }
    }
    return inp;
  }

  /** Stick vector for a teleport recovery: toward a point just onto the stage past the ledge. */
  private teleAim(me: FighterView, lx: number, ly: number, toward: number): { x: number; y: number } {
    const tx = lx + toward * 0.8;
    const ty = ly + 0.4;
    let dx = tx - me.x;
    let dy = ty - me.y;
    const m = Math.hypot(dx, dy);
    if (m < 0.01) return { x: 0, y: 1 };
    dx /= m;
    dy /= m;
    return { x: dx, y: dy };
  }

  private pressJump(inp: SimInput, full: boolean): void {
    inp.jumpPressed = true;
    inp.jump = true;
    this.lastJumpPress = this.lastFrame;
    this.jumpHold = full ? 6 : 0;
  }

  // -------------------------------------------------------------------------
  // shield & defence
  // -------------------------------------------------------------------------

  private shielding(sim: ISmashSim, me: FighterView, geo: Geo, inp: SimInput, frame: number): SimInput {
    this.shieldHold--;
    inp.shield = true;
    if (this.dodgeStick) {
      // roll / spot dodge: the stick must be held once the shield is up
      inp.x = this.dodgeStick.x;
      inp.y = this.dodgeStick.y;
      if (me.action === 'roll' || me.action === 'spotDodge' || this.shieldHold <= 0) {
        this.dodgeStick = null;
        this.shieldHold = 0;
      }
      return inp;
    }
    if (me.shield < 0.3) {
      this.shieldHold = 0;
      inp.shield = false;
      return inp;
    }
    // out-of-shield punish (L4+): a foe in endlag in front of us -> grab
    if (this.lv.level >= 4 && me.action === 'shield') {
      for (const f of sim.fighters) {
        if (!this.alive(f) || !this.isFoe(sim, me, f)) continue;
        const dx = f.x - me.x;
        if (Math.abs(dx) < me.width / 2 + 1.1 && Math.abs(f.y - me.y) < 1 && f.movePhase === 'endlag') {
          if (this.rng.chance(this.lv.accuracy * 0.6)) {
            inp.grabPressed = true;
            this.shieldHold = 0;
            this.lastAttack = frame;
            return inp;
          }
        }
      }
    }
    return inp;
  }

  private defend(sim: ISmashSim, me: FighterView, geo: Geo, inp: SimInput, frame: number): boolean {
    const lv = this.lv;
    if (lv.defend <= 0) return false;
    const actionable = GROUND_ACT.has(me.action) || AIR_ACT.has(me.action);
    if (!actionable) return false;
    for (const f of sim.fighters) {
      if (!this.alive(f) || !this.isFoe(sim, me, f) || f.action !== 'attack' || !f.move) continue;
      if (f.movePhase !== 'startup' && f.movePhase !== 'charge') continue;
      const dx = me.x - f.x;
      const dy = me.y - f.y;
      const reach = 2.2 + (f.move === 'fsmash' || f.move === 'dashAttack' || f.move === 'sspecial' ? 1.2 : 0);
      if (Math.abs(dx) > reach || Math.abs(dy) > 2.2) continue;
      const startFrame = frame - f.moveFrame;
      if (this.seenAttack.get(f.index) === startFrame) continue;
      if (f.moveFrame < lv.react && f.movePhase !== 'charge') continue; // not noticed yet
      this.seenAttack.set(f.index, startFrame);
      const facingMe = sgn(dx) === f.facing || f.move === 'dsmash' || f.move === 'nair' || f.move === 'usmash' || f.move === 'utilt';
      if (!facingMe) continue;
      if (!this.rng.chance(lv.defend)) continue;
      return this.dodge(me, geo, inp, frame, sgn(dx));
    }
    // projectiles
    for (const p of sim.projectiles) {
      if (p.owner === me.index) continue;
      const owner = sim.fighters[p.owner];
      if (owner && !this.isFoe(sim, me, owner)) continue;
      const dx = me.x - p.x;
      const dy = me.y + me.height * 0.5 - p.y;
      if (Math.abs(dx) > 3.2 || Math.abs(dy) > 1.6) continue;
      if (Math.sign(p.vx) !== Math.sign(dx) && Math.abs(p.vx) > 0.01) continue;
      if (this.seenProj.has(p.id)) continue;
      this.seenProj.add(p.id);
      if (this.seenProj.size > 64) this.seenProj.clear();
      if (!this.rng.chance(lv.defend)) continue;
      if (me.grounded && this.rng.chance(0.5)) {
        this.shieldHold = 14 + this.rng.int(0, 8);
        inp.shield = true;
        inp.shieldPressed = true;
        return true;
      }
      if (me.grounded && frame - this.lastJumpPress > 10) {
        this.pressJump(inp, true);
        return true;
      }
    }
    return false;
  }

  private dodge(me: FighterView, geo: Geo, inp: SimInput, frame: number, awayDir: 1 | -1): boolean {
    const lv = this.lv;
    if (!me.grounded) {
      if (lv.level >= 6 && frame - this.lastShieldPress > 40 && this.rng.chance(0.5)) {
        inp.shieldPressed = true;
        this.lastShieldPress = frame;
        inp.x = 0;
        inp.y = 0;
        return true;
      }
      return false;
    }
    const nearEdge = Math.min(me.x - geo.left, geo.right - me.x) < 2.5;
    const r = this.rng.next();
    inp.shield = true;
    inp.shieldPressed = true;
    this.lastShieldPress = frame;
    if (r < 0.55 || lv.level < 4) {
      this.shieldHold = 12 + this.rng.int(0, 10);
    } else if (r < 0.75) {
      this.shieldHold = 6;
      this.dodgeStick = { x: 0, y: -1 }; // spot dodge
    } else {
      // roll away from the attacker, unless that's toward the edge -> roll through
      let dir: number = awayDir;
      const edgeX = dir < 0 ? geo.left : geo.right;
      if (nearEdge && Math.abs(edgeX - me.x) < 3) dir = -dir;
      this.shieldHold = 6;
      this.dodgeStick = { x: dir, y: 0 };
    }
    return true;
  }

  private avoidLava(sim: ISmashSim, me: FighterView, geo: Geo, inp: SimInput): boolean {
    const hz = sim.stageView ? sim.stageView.hazard : null;
    this.lavaZone = null;
    if (!hz || (!hz.active && !(hz.warning > 0))) return false;
    // the eruption is a column from 3 below to 7 above the main stage surface
    const half = fin(hz.w, 2) / 2 + me.width / 2 + 0.45;
    this.lavaZone = { x: fin(hz.x), half };
    const dx = me.x - fin(hz.x);
    if (Math.abs(dx) > half) return false;
    if (me.y > geo.top + 7.2 || me.y < geo.top - 3) return false;
    const ph = physFor(me.characterId, me);
    // run out the nearer side that stays on stage
    let dir: number = sgn(dx);
    let exitX = hz.x + dir * (half + 0.2);
    if (exitX < geo.left + 0.6 || exitX > geo.right - 0.6) {
      dir = -dir;
      exitX = hz.x + dir * (half + 0.2);
    }
    const framesLeft = hz.active ? 0 : (1 - clamp(hz.warning, 0, 1)) * 120;
    const need = Math.abs(exitX - me.x) / Math.max(0.08, ph.runSpeed) + 6;
    if (me.grounded && need > framesLeft && framesLeft < 25 && !hz.active) {
      // can't make it: shield the burst
      inp.shield = true;
      if (this.shieldHold < 4) this.shieldHold = Math.ceil(framesLeft) + 8;
      return true;
    }
    if (!me.grounded) {
      inp.x = dir;
      return true;
    }
    inp.x = dir;
    return true;
  }
  private lavaZone: { x: number; half: number } | null = null;
  private stunHs = 0;
  private nextZone = 0;
  private dodgeStick: { x: number; y: number } | null = null;
  /** Until this frame, airborne attack checks run every frame (after a short hop / juggle jump). */
  private airEager = 0;
  private edgeguardOut = false;

  // -------------------------------------------------------------------------
  // scripts (multi-frame sequences)
  // -------------------------------------------------------------------------

  private startScript(steps: Step[], frame: number, stick: { x: number; y: number } | null = null): void {
    this.script = steps;
    this.scriptStart = frame;
    this.scriptStick = stick;
  }

  /** Returns true if the script produced this frame's input. */
  private runScript(inp: SimInput, frame: number, me: FighterView): boolean {
    const el = frame - this.scriptStart;
    if (this.scriptStick) {
      inp.x = this.scriptStick.x;
      inp.y = this.scriptStick.y;
    }
    while (this.script.length > 0 && this.script[0].t <= el) {
      const s = this.script.shift()!;
      for (const k of Object.keys(s) as (keyof Step)[]) {
        if (k === 't') continue;
        (inp as unknown as Record<string, unknown>)[k] = s[k];
      }
      if (s.jumpPressed) this.lastJumpPress = frame;
      if (s.attackPressed || s.specialPressed || s.grabPressed) this.lastAttack = frame;
      if (s.specialPressed) this.lastSpecialPress = frame;
    }
    if (this.script.length === 0) this.scriptStick = null;
    if (el > 60) {
      this.script.length = 0;
      this.scriptStick = null;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // neutral game
  // -------------------------------------------------------------------------

  private pickTarget(sim: ISmashSim, me: FighterView, frame: number): number {
    const fs = sim.fighters;
    const cur = this.target >= 0 && this.target < fs.length ? fs[this.target] : null;
    if (cur && frame < this.targetUntil && this.alive(cur) && this.isFoe(sim, me, cur) && !cur.respawning) return this.target;
    let best = -1;
    let bestScore = 1e9;
    // sandbox: practise on the training dummy, never on the humans
    const sandboxDummy = !!(sim.config && sim.config.sandbox) && fs.some((f) => f.dummy && this.alive(f));
    for (const f of fs) {
      if (!this.alive(f) || !this.isFoe(sim, me, f)) continue;
      if (sandboxDummy && !f.dummy) continue;
      let s = Math.abs(f.x - me.x) + Math.abs(f.y - me.y) * 0.7;
      if (f.respawning) s += 12;
      if (this.lv.level >= 5) s -= Math.min(f.damage, 150) * 0.03; // prefer finishing
      if (f.index === this.target) s -= 2; // stickiness
      if (s < bestScore) {
        bestScore = s;
        best = f.index;
      }
    }
    this.target = best;
    this.targetUntil = frame + this.rng.int(40, 120);
    return best;
  }

  private neutral(sim: ISmashSim, me: FighterView, ph: AiPhys, geo: Geo, inp: SimInput, frame: number): SimInput {
    const lv = this.lv;
    const grounded = me.grounded;
    const gAct = grounded && GROUND_ACT.has(me.action);
    const aAct = !grounded && AIR_ACT.has(me.action);
    const decision = frame >= this.nextDecision;
    if (decision) this.nextDecision = frame + Math.max(1, lv.decideEvery + this.rng.int(-1, 2));

    const ti = this.pickTarget(sim, me, frame);
    const tgt = ti >= 0 ? sim.fighters[ti] : null;

    // idle (low levels sometimes just stand around)
    if (decision && lv.idle > 0 && this.rng.chance(lv.idle * 0.5)) this.idleUntil = frame + this.rng.int(10, 40);
    if (frame < this.idleUntil) {
      this.moveX = 0;
      return inp;
    }

    // ----- final smash -----
    if (me.powered && tgt && (gAct || aAct)) {
      const dx = tgt.x - me.x;
      if (Math.abs(dx) < 5 && Math.abs(tgt.y - me.y) < 2.5 && frame - this.lastSpecialPress > 20) {
        inp.specialPressed = true;
        inp.x = sgn(dx);
        this.lastSpecialPress = frame;
        return inp;
      }
    }

    // ----- items -----
    if (me.heldItem && tgt && (gAct || aAct)) {
      const r = this.useItem(sim, me, tgt, inp, frame);
      if (r) return inp;
    }
    let goalX: number | null = null;
    let goalY: number | null = null;
    let goalIsItem: ItemView | null = null;
    if (!me.heldItem && sim.items.length > 0) {
      const it = this.chooseItem(sim, me, tgt, frame);
      if (it) {
        goalX = it.x;
        goalY = it.y;
        goalIsItem = it;
      }
    }

    // ----- target -----
    let tp = tgt ? this.seen(sim.fighters, tgt.index) : null;
    let edgeguardMode = false;
    if (tgt && tp && goalX === null) {
      const tOff = !tgt.grounded && (tgt.y < geo.top - 0.1 || tgt.x < geo.left - 0.2 || tgt.x > geo.right + 0.2);
      if (tOff) {
        if (lv.edgeguard) {
          edgeguardMode = true;
          const side = tgt.x < geo.cx ? -1 : 1;
          const edgeX = side < 0 ? geo.left : geo.right;
          goalX = edgeX - side * 0.7;
          goalY = geo.top;
          if (this.edgeguard(sim, me, tgt, ph, geo, inp, frame, side)) return inp;
        } else {
          // wait near the middle-ish of our side
          const side = tgt.x < geo.cx ? -1 : 1;
          goalX = (side < 0 ? geo.left : geo.right) - side * 2.5;
          goalY = geo.top;
        }
      } else {
        goalX = tp.x;
        goalY = tp.y;
      }
    }

    // ----- attack opportunities -----
    if (tgt && tp && !goalIsItem && !edgeguardMode && frame - this.lastAttack >= lv.attackCooldown && (gAct || aAct)) {
      const allow = decision || (lv.combos && (tgt.action === 'hitstun' || tgt.action === 'tumble')) || (aAct && frame < this.airEager);
      if (allow && !(tgt.invincible && lv.level >= 4)) {
        if (this.tryAttack(sim, me, tgt, tp, ph, geo, inp, frame)) return inp;
      }
    }
    // orb: hit it when near
    if (goalIsItem && goalIsItem.kind === 'orb' && (gAct || aAct)) {
      const dx = goalIsItem.x - me.x;
      const dy = goalIsItem.y - (me.y + me.height * 0.5);
      if (Math.abs(dx) < me.width / 2 + 1.0 && Math.abs(dy) < 1.4 && frame - this.lastAttack > 10) {
        this.lastAttack = frame;
        inp.attackPressed = true;
        inp.x = sgn(dx) * (grounded ? 0.6 : 1);
        if (dy > 0.8) {
          inp.x = 0;
          inp.y = 0.7;
        }
        return inp;
      }
    }

    // pick up the item we walked to
    if (goalIsItem && goalIsItem.kind !== 'orb' && goalIsItem.kind !== 'food' && gAct && frame - this.lastAttack > 8) {
      const ddx = goalIsItem.x - me.x;
      const ddy = goalIsItem.y - me.y;
      if (Math.abs(ddx) < 0.9 && ddy > -0.5 && ddy < 1.1) {
        this.lastAttack = frame;
        inp.attackPressed = true;
        return inp;
      }
    }

    // ----- movement -----
    if (goalX === null) {
      goalX = geo.cx;
      goalY = geo.top;
    }
    let dx = goalX - me.x;
    const dy = (goalY ?? me.y) - me.y;
    // spacing: zoners keep distance, others close in
    let want = 0.6;
    if (!goalIsItem && tgt && !edgeguardMode) {
      if (ph.archetype === 'zoner') want = lv.level >= 3 ? 4.5 : 2.5;
      else want = me.width / 2 + tgt.width / 2 + (lv.aggression > 0.6 ? 0.3 : 0.8);
      if (decision && !this.rng.chance(lv.aggression)) want += this.rng.range(1, 3);
    }
    if (goalIsItem) want = 0.15;
    let mx = 0;
    if (Math.abs(dx) > want + 0.2) mx = sgn(dx);
    else if (ph.archetype === 'zoner' && tgt && Math.abs(dx) < want - 1.5 && !goalIsItem) mx = -sgn(dx); // back off
    if (decision) this.moveX = mx;
    else if (mx === 0) this.moveX = 0;
    mx = this.moveX;

    if (grounded) {
      const far = Math.abs(dx) > 3;
      let speed = far ? 1 : 0.6;
      speed *= lv.moveSpeed;
      if (speed > 0.75 && !far) speed = 0.7;
      inp.x = mx * speed;
      // edge safety: never walk/run off the stage
      if (inp.x !== 0) {
        const look = 0.4 + Math.abs(me.vx) * 10 + me.width / 2;
        const ax = me.x + sgn(inp.x) * look;
        if (!this.groundBelow(geo, ax, me.y, 0) || (me.y <= geo.top + 0.05 && (ax < geo.left + 0.2 || ax > geo.right - 0.2) && !this.groundBelow(geo, ax, me.y + 0.1, 0.05))) {
          inp.x = 0;
          this.moveX = 0;
        }
      }
      // lava: L4+ do not walk into a warned area
      if (this.lavaZone && lv.level >= 4 && sim.stageView.hazard && (sim.stageView.hazard.warning > 0 || sim.stageView.hazard.active)) {
        const nx = me.x + inp.x * 1.2;
        if (Math.abs(nx - this.lavaZone.x) < this.lavaZone.half && me.y < geo.top + 7.2) inp.x = 0;
      }
      // vertical goals: jump to platforms above, drop through platforms
      if (gAct && dy > 1.3 && Math.abs(dx) < 3.5 && frame - this.lastJumpPress > 20 && (decision || goalIsItem)) {
        this.pressJump(inp, true);
      } else if (gAct && dy < -1.0 && Math.abs(dx) < 4 && me.y > geo.top + 0.3 && (decision || this.dropReq > 0)) {
        // on a pass-through platform: fresh push down
        this.dropReq++;
        inp.x = 0;
        inp.y = this.dropReq % 2 === 0 ? -1 : 0;
        if (this.dropReq > 6) this.dropReq = 0;
      }
      // approach with a short-hop aerial (L5+)
      if (gAct && tgt && lv.shortHop && !goalIsItem && !edgeguardMode && decision && Math.abs(dx) > 1.6 && Math.abs(dx) < 3.4 && Math.abs(dy) < 1.0 && frame - this.lastAttack > lv.attackCooldown && this.rng.chance(0.35)) {
        const dir = sgn(dx);
        const nearEdge = Math.min(me.x - geo.left, geo.right - me.x) < 2.5 && sgn((dir < 0 ? geo.left : geo.right) - me.x) === dir;
        if (!nearEdge) {
          // short hop toward the target; the air logic throws out the aerial when in range
          inp.jumpPressed = true;
          inp.jump = false;
          this.jumpHold = 0;
          inp.x = dir;
          this.lastJumpPress = frame;
          this.airEager = frame + 40;
          return inp;
        }
      }
      // low levels: random hops
      if (gAct && decision && lv.level <= 4 && this.rng.chance(0.04) && frame - this.lastJumpPress > 30) this.pressJump(inp, this.rng.chance(0.5));
    } else {
      // air drift; stay over the stage
      let ax: number = mx;
      const nextX = me.x + me.vx * 12 + ax * 0.5;
      if (!edgeguardMode && (nextX < geo.left + 0.3 || nextX > geo.right - 0.3) && !this.groundBelow(geo, nextX, me.y, 0)) ax = sgn(geo.cx - me.x);
      if (this.lavaZone && lv.level >= 4 && me.y < geo.top + 7.5 && Math.abs(nextX - this.lavaZone.x) < this.lavaZone.half && Math.abs(me.x - this.lavaZone.x) >= this.lavaZone.half) {
        ax = sgn(me.x - this.lavaZone.x);
      }
      inp.x = ax;
      // fast fall when falling over the stage and not about to attack (L4+)
      if (lv.level >= 4 && me.vy < 0 && aAct && Math.abs(dy) > 1.5 && dy < 0 && this.groundBelow(geo, me.x, me.y, 0.4)) {
        inp.y = -1;
      }
      // double jump up to a target above
      if (aAct && dy > 2.0 && me.jumpsLeft > 0 && me.vy < 0 && frame - this.lastJumpPress > 15 && this.groundBelow(geo, me.x, me.y, 0.3)) {
        this.pressJump(inp, true);
      }
    }
    return inp;
  }

  // -------------------------------------------------------------------------
  // attacks
  // -------------------------------------------------------------------------

  private killPct(t: FighterView, geo: Geo): number {
    const w = physFor(t.characterId, t).weight;
    const edge = Math.min(Math.abs(t.x - geo.blast.left), Math.abs(geo.blast.right - t.x));
    const width = (geo.blast.right - geo.blast.left) / 2;
    const edgeFactor = clamp(edge / Math.max(1, width), 0.4, 1);
    return 115 * (w / 100) * (0.55 + 0.45 * edgeFactor);
  }

  /** Does move `key` (started now, facing `facing`) reach a body at (tx, ty) of size tw×th, given my position (mx, my)? */
  private reaches(mv: Map<string, MoveReach>, key: string, facing: number, mx: number, my: number, tx: number, ty: number, tw: number, th: number, slack: number): boolean {
    const r = mv.get(key);
    if (!r) return false;
    for (const c of r.circles) {
      const cx = mx + facing * c.x;
      const cy = my + c.y;
      const ny = clamp(cy, ty + tw * 0.3, ty + th - tw * 0.3);
      const dx = tx - cx;
      const dy = ny - cy;
      const rr = c.r + tw * 0.5 + slack;
      if (dx * dx + dy * dy <= rr * rr) return true;
    }
    return false;
  }

  private friendlyFire(sim: ISmashSim): boolean {
    const r = sim.config && sim.config.rules;
    return !!(r && r.teams && r.friendlyFire);
  }

  /** With friendly fire on: would this move also hit a teammate? */
  private hitsMate(sim: ISmashSim, me: FighterView, mv: Map<string, MoveReach>, key: string, facing: number, mx: number, my: number): boolean {
    if (!this.friendlyFire(sim)) return false;
    for (const f of sim.fighters) {
      if (f.index === me.index || f.team !== me.team || !this.alive(f) || f.respawning) continue;
      if (this.reaches(mv, key, facing, mx, my, f.x, f.y, f.width, f.height, 0.25)) return true;
    }
    return false;
  }

  /** With friendly fire on: is a teammate between me and x (roughly at my height)? */
  private mateInLine(sim: ISmashSim, me: FighterView, x: number): boolean {
    if (!this.friendlyFire(sim)) return false;
    const lo = Math.min(me.x, x);
    const hi = Math.max(me.x, x);
    for (const f of sim.fighters) {
      if (f.index === me.index || f.team !== me.team || !this.alive(f) || f.respawning) continue;
      if (f.x > lo && f.x < hi && Math.abs(f.y - me.y) < 1.8) return true;
    }
    return false;
  }

  /** Perceived velocity of fighter j (from position history), world/frame. */
  private seenVel(j: number): { vx: number; vy: number } {
    if (!this.histX[j] || this.histN < 3) return { vx: 0, vy: 0 };
    const d = Math.min(this.lv.react, this.histN - 2, HIST - 2);
    const k1 = (this.histN - 1 - d + HIST * 4) % HIST;
    const k0 = (k1 - 1 + HIST) % HIST;
    return { vx: fin(this.histX[j][k1] - this.histX[j][k0]), vy: fin(this.histY[j][k1] - this.histY[j][k0]) };
  }

  private tryAttack(
    sim: ISmashSim,
    me: FighterView,
    tgt: FighterView,
    tp: { x: number; y: number },
    ph: AiPhys,
    geo: Geo,
    inp: SimInput,
    frame: number,
  ): boolean {
    const lv = this.lv;
    const mv = movesFor(me.characterId);
    const dx = tp.x - me.x;
    const dyFeet = tp.y - me.y;
    const adx = Math.abs(dx);
    const dir = sgn(dx);
    const canKill = tgt.damage >= this.killPct(tgt, geo);
    const vuln = VULNERABLE.has(tgt.action) || tgt.movePhase === 'endlag';
    const shielding = tgt.shielding || tgt.action === 'shield';
    const stunned = tgt.action === 'hitstun' || tgt.action === 'tumble';
    if (!this.rng.chance(lv.attackRate)) return false;
    const accurate = this.rng.chance(lv.accuracy);
    // where the target will be when the move comes out (better CPUs predict better)
    const tv = this.seenVel(tgt.index);
    const pk = lv.level >= 6 ? 1 : lv.level >= 3 ? 0.5 : 0;
    const tw = tgt.width;
    const th = tgt.height;
    const slack = lv.level >= 7 ? -0.05 : 0.1; // good CPUs don't throw out moves at max range

    // ----- grounded -----
    if (me.grounded) {
      // projectile / special zoning at range
      if (adx > 3 && adx < 11 && Math.abs(dyFeet) < 1.5) {
        const zp = ph.archetype === 'zoner' ? 0.55 : ph.archetype === 'trickster' ? 0.2 : ph.archetype === 'sword' ? 0.1 : 0.1;
        if (frame >= this.nextZone && this.rng.chance(zp) && !this.mateInLine(sim, me, tp.x)) {
          this.nextZone = frame + this.rng.int(24, 60) + (9 - lv.level) * 4;
          this.doSpecial(inp, frame, me, dir, ph.archetype === 'trickster' && adx < 6 && this.rng.chance(0.5) ? 'side' : 'neutral');
          return true;
        }
      }
      // armoured / dashing side special at mid range (bruiser, speedster, sword)
      if (adx > 1.8 && adx < 4.2 && Math.abs(dyFeet) < 1 && (ph.archetype === 'bruiser' || ph.archetype === 'speedster' || ph.archetype === 'sword')) {
        const p = ph.archetype === 'bruiser' ? 0.2 : 0.1;
        if (frame >= this.nextZone && this.rng.chance(p) && this.safeForward(me, geo, dir, 4)) {
          this.nextZone = frame + this.rng.int(40, 90);
          this.doSpecial(inp, frame, me, dir, 'side');
          return true;
        }
      }
      // trickster: down special counter/reflect when something is coming, decoys at range
      if (ph.archetype === 'trickster' && frame >= this.nextZone && adx < 2.5 && tgt.movePhase === 'startup' && lv.level >= 4 && this.rng.chance(0.25)) {
        this.nextZone = frame + this.rng.int(30, 60);
        this.doSpecial(inp, frame, me, dir, 'down');
        return true;
      }
      // dash attack when running into range
      if (me.action === 'run' && me.facing === dir && Math.abs(dyFeet) < 0.8) {
        const r = mv.get('dashAttack');
        const ahead = r ? me.facing * (me.vx * r.first * 0.6) : 0;
        if (this.reaches(mv, 'dashAttack', me.facing, me.x + ahead, me.y, tp.x + tv.vx * (r ? r.first : 8) * pk, tp.y, tw, th, slack) && this.safeForward(me, geo, dir, 2.5)) {
          this.press(inp, 'attack', frame);
          inp.x = dir;
          return true;
        }
      }
      // candidate ground moves
      const opts: { key: string; w: number }[] = [];
      const add = (key: string, w: number, turns: boolean) => {
        if (w <= 0) return;
        const r = mv.get(key);
        if (!r) return;
        const fac = turns ? dir : me.facing;
        const tx = tp.x + tv.vx * r.first * pk;
        const ty = tp.y + tv.vy * r.first * pk;
        if (this.reaches(mv, key, fac, me.x, me.y, tx, ty, tw, th, slack) && !this.hitsMate(sim, me, mv, key, fac, me.x, me.y)) opts.push({ key, w });
      };
      const killW = canKill ? 4 : vuln ? 2.2 : stunned ? 1 : 0.35;
      add('grab', shielding ? 7 : vuln ? 0.6 : 1.1, false);
      add('jab1', shielding ? 0.15 : 2.4, false);
      add('ftilt', shielding ? 0.2 : 2, true);
      add('dtilt', shielding ? 0.2 : 1.1, false);
      add('utilt', shielding ? 0.2 : dyFeet > 0.6 ? 2.5 : 0.5, false);
      add('fsmash', shielding ? 0.1 : killW, true);
      add('usmash', shielding ? 0.1 : dyFeet > 0.5 ? killW + 0.6 : killW * 0.4, false);
      add('dsmash', shielding ? 0.1 : killW * 0.6, false);
      if (ph.archetype === 'bruiser' || ph.archetype === 'allrounder') add('dspecial', 0.5, false);
      if (opts.length === 0) {
        // target above & close: jump + up air (juggle), L4+
        if (lv.level >= 4 && dyFeet > 1.6 && dyFeet < 5 && adx < 1.8 && frame - this.lastJumpPress > 12) {
          this.pressJump(inp, true);
          inp.x = dir * 0.5;
          this.airEager = frame + 45;
          return true;
        }
        if (!accurate && adx < 2.5 && Math.abs(dyFeet) < 1.5 && this.rng.chance(0.25)) {
          // flail (low-level CPUs whiff)
          this.press(inp, 'attack', frame);
          inp.x = this.rng.chance(0.5) ? dir * 0.6 : 0;
          return true;
        }
        return false;
      }
      let pick: string;
      if (accurate) pick = opts[Math.max(0, this.rng.weighted(opts.map((o) => o.w)))].key;
      else pick = opts[this.rng.int(0, opts.length - 1)].key;
      switch (pick) {
        case 'grab':
          this.press(inp, 'grab', frame);
          break;
        case 'jab1':
          this.press(inp, 'attack', frame);
          if (lv.level >= 3 && this.rng.chance(0.6)) {
            this.startScript([{ t: 0 }, { t: 7, attackPressed: true }, { t: 14, attackPressed: true }], frame);
            this.script.shift();
          }
          break;
        case 'ftilt':
          this.press(inp, 'attack', frame);
          inp.x = dir * 0.6;
          break;
        case 'dtilt':
          this.press(inp, 'attack', frame);
          inp.y = -0.7;
          break;
        case 'utilt':
          this.press(inp, 'attack', frame);
          inp.y = 0.7;
          break;
        case 'fsmash':
          this.doSmash(inp, frame, 'forward', dir, vuln);
          break;
        case 'usmash':
          this.doSmash(inp, frame, 'up', dir, vuln);
          break;
        case 'dsmash':
          this.doSmash(inp, frame, 'down', dir, vuln);
          break;
        case 'dspecial':
          this.doSpecial(inp, frame, me, dir, 'down');
          break;
      }
      return true;
    }

    // ----- airborne -----
    // don't start aerials while drifting off stage (recovery has priority)
    if (!this.groundBelow(geo, me.x, me.y, 0.2) && !this.edgeguardOut) return false;
    const ph2 = physFor(me.characterId, me);
    const aopts: { key: string; w: number; x: number; y: number }[] = [];
    const tryAir = (key: string, w: number, sx: number, sy: number) => {
      const r = mv.get(key);
      if (!r) return;
      const n = r.first;
      const mxp = me.x + me.vx * n;
      const myp = me.y + me.vy * n - 0.5 * ph2.gravity * n * n;
      const tx = tp.x + tv.vx * n * pk;
      const ty = tp.y + tv.vy * n * pk;
      if (this.reaches(mv, key, me.facing, mxp, myp, tx, ty, tw, th, slack) && !this.hitsMate(sim, me, mv, key, me.facing, mxp, myp)) aopts.push({ key, w, x: sx, y: sy });
    };
    tryAir('nair', 1.5, 0, 0);
    tryAir('fair', 2, me.facing, 0);
    tryAir('bair', 2.2, -me.facing, 0);
    tryAir('uair', 2, 0, 1);
    tryAir('dair', canKill ? 2 : 0.8, 0, -1);
    if (aopts.length === 0) {
      // zoners shoot in the air too
      if (ph.archetype === 'zoner' && frame >= this.nextZone && adx > 3 && adx < 9 && Math.abs(dyFeet) < 1.2 && this.rng.chance(0.12) && this.groundBelow(geo, me.x, me.y, 0.5)) {
        this.nextZone = frame + this.rng.int(24, 60);
        this.doSpecial(inp, frame, me, dir, 'neutral');
        return true;
      }
      if (!accurate && adx < 2 && Math.abs(dyFeet) < 2 && this.rng.chance(0.15)) {
        this.press(inp, 'attack', frame);
        inp.x = this.rng.chance(0.5) ? dir : 0;
        return true;
      }
      return false;
    }
    const o = accurate ? aopts[Math.max(0, this.rng.weighted(aopts.map((q) => q.w)))] : aopts[this.rng.int(0, aopts.length - 1)];
    this.press(inp, 'attack', frame);
    inp.x = o.x;
    inp.y = o.y;
    return true;
  }

  private safeForward(me: FighterView, geo: Geo, dir: number, dist: number): boolean {
    const x = me.x + dir * dist;
    return x > geo.left + 0.5 && x < geo.right - 0.5;
  }

  private press(inp: SimInput, b: 'attack' | 'grab', frame: number): void {
    if (b === 'attack') inp.attackPressed = true;
    else inp.grabPressed = true;
    this.lastAttack = frame;
  }

  private doSmash(inp: SimInput, frame: number, kind: 'forward' | 'up' | 'down', dir: number, vuln: boolean): void {
    inp.attackPressed = true;
    inp.attack = true;
    inp.flick = true;
    if (kind === 'forward') {
      inp.x = dir;
      inp.y = 0;
    } else {
      inp.x = 0;
      inp.y = kind === 'up' ? 1 : -1;
    }
    this.holdStickY = 0;
    // charge sometimes
    const charge = this.lv.level <= 2 ? this.rng.int(0, 40) : vuln && this.rng.chance(0.5) ? this.rng.int(5, 25) : this.rng.chance(0.2) ? this.rng.int(4, 14) : 0;
    this.attackHold = charge > 0 ? charge + 6 : 0;
    this.lastAttack = frame + Math.min(charge, 30);
  }

  private doSpecial(inp: SimInput, frame: number, me: FighterView, dir: number, kind: 'neutral' | 'side' | 'up' | 'down'): void {
    if (frame - this.lastSpecialPress < 12) return;
    this.lastSpecialPress = frame;
    this.lastAttack = frame;
    if (kind === 'neutral') {
      if (me.facing !== dir && me.grounded) {
        // turn first, then fire
        this.startScript([{ t: 0, x: dir * 0.5 }, { t: 3, specialPressed: true, x: 0 }], frame);
        inp.x = dir * 0.5;
        this.script.shift();
        return;
      }
      inp.specialPressed = true;
      inp.special = true;
    } else if (kind === 'side') {
      inp.specialPressed = true;
      inp.special = true;
      inp.x = dir;
    } else if (kind === 'down') {
      inp.specialPressed = true;
      inp.special = true;
      inp.y = -1;
    } else {
      inp.specialPressed = true;
      inp.y = 1;
    }
  }

  // -------------------------------------------------------------------------
  // edge-guarding (L7+)
  // -------------------------------------------------------------------------

  private edgeguard(sim: ISmashSim, me: FighterView, tgt: FighterView, ph: AiPhys, geo: Geo, inp: SimInput, frame: number, side: number): boolean {
    if (!me.grounded || !GROUND_ACT.has(me.action)) return false;
    const edgeX = side < 0 ? geo.left : geo.right;
    const distEdge = Math.abs(edgeX - me.x);
    if (distEdge > 1.6) return false; // movement code walks us there
    if (frame - this.lastAttack < this.lv.attackCooldown + 8) return false;
    if (tgt.invincible) return false;
    const tdx = (tgt.x - edgeX) * side; // > 0 out past the edge
    const tdy = tgt.y - geo.top;
    // target about to grab the ledge / land: hit it at the edge
    if (tdx < 1.6 && tdy > -1.8 && tdy < 1.6) {
      if (me.facing !== side) {
        inp.x = side * 0.5; // turn (walk toward the edge one frame is safe: we're > 0.4 away)
        if (distEdge < 0.9) inp.x = 0;
        // dsmash hits both sides
        this.doSmash(inp, frame, 'down', side, true);
        return true;
      }
      if (tdy < -0.4) {
        this.press(inp, 'attack', frame);
        inp.y = -0.7; // dtilt low
      } else this.doSmash(inp, frame, 'forward', side, true);
      return true;
    }
    // L8+: jump out for an aerial when the target is close and we're healthy
    if (this.lv.level >= 8 && me.damage < 90 && tdx > 1 && tdx < 3.2 && tdy > -1.5 && tdy < 1.2 && me.jumpsLeft > 0 && this.rng.chance(0.25)) {
      const facingOut = me.facing === side;
      this.startScript(
        [
          { t: 0, jumpPressed: true, jump: false },
          { t: 5, attackPressed: true, x: facingOut ? side : side, y: 0 },
        ],
        frame,
        { x: side, y: 0 },
      );
      this.runScript(inp, frame, me);
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // items
  // -------------------------------------------------------------------------

  private chooseItem(sim: ISmashSim, me: FighterView, tgt: FighterView | null, frame: number): ItemView | null {
    const lv = this.lv;
    if (frame < this.itemGoalUntil) {
      for (const it of sim.items) if (it.id === this.itemGoal && it.holder < 0) return it;
    }
    this.itemGoal = -1;
    let best: ItemView | null = null;
    let bestS = 1e9;
    for (const it of sim.items) {
      if (it.holder >= 0) continue;
      if (it.kind === 'bomb' && it.armed) continue;
      let want = 0;
      if (it.kind === 'food') want = me.damage > 25 ? 1 + me.damage / 60 : 0;
      else if (it.kind === 'orb') want = 1.5;
      else if (GOOD_ITEMS.has(it.kind)) want = 1;
      if (want <= 0) continue;
      const dx = it.x - me.x;
      const dy = it.y - me.y;
      const d = Math.abs(dx) + Math.abs(dy) * 1.5;
      if (d > 9) continue;
      if (it.x < geo0(sim).left - 0.3 || it.x > geo0(sim).right + 0.3) {
        if (!this.groundBelowRaw(sim, it.x, it.y + 0.2)) continue; // offstage: ignore
      }
      if (it.kind !== 'orb' && it.y < me.y - 3) continue;
      // a foe right next to us beats running for an item (except food at high %)
      const s = d / want;
      if (s < bestS) {
        bestS = s;
        best = it;
      }
    }
    if (best && tgt && best.kind !== 'food' && Math.abs(tgt.x - me.x) < 1.5 && this.rng.chance(0.6)) return null;
    if (best && !this.rng.chance(lv.items)) {
      this.itemGoalUntil = frame + 30;
      this.itemGoal = -2;
      return null;
    }
    if (best) {
      this.itemGoal = best.id;
      this.itemGoalUntil = frame + 90;
    }
    return best;
  }

  private groundBelowRaw(sim: ISmashSim, x: number, y: number): boolean {
    const g = geo0(sim);
    for (const p of g.plats) if (Math.abs(x - p.x) <= p.w / 2 && p.y <= y + 0.05) return true;
    return false;
  }

  private useItem(sim: ISmashSim, me: FighterView, tgt: FighterView, inp: SimInput, frame: number): boolean {
    if (frame - this.lastAttack < Math.max(10, this.lv.attackCooldown)) return false;
    const dx = tgt.x - me.x;
    const dy = tgt.y - me.y;
    const dir = sgn(dx);
    const kind = me.heldItem;
    if (kind === 'bat') {
      if (Math.abs(dx) < me.width / 2 + tgt.width / 2 + 1.4 && Math.abs(dy) < 1.2 && !tgt.invincible) {
        if (me.facing !== dir && me.grounded) {
          inp.x = dir * 0.5; // turn
          return true;
        }
        this.press(inp, 'attack', frame);
        return true;
      }
      return false;
    }
    if (kind === 'food') {
      this.press(inp, 'attack', frame);
      return true;
    }
    // throwables: bomb / capsule / orb
    if (Math.abs(dx) < 7 && Math.abs(dy) < 2 && !tgt.invincible && this.rng.chance(0.3 + this.lv.accuracy * 0.4)) {
      this.press(inp, 'attack', frame);
      inp.x = dir;
      inp.y = dy > 1.2 ? 0.7 : 0;
      return true;
    }
    return false;
  }
}

// cached per-stage geometry for helpers that don't have one (item filtering)
function geo0(sim: ISmashSim): { left: number; right: number; plats: { x: number; y: number; w: number }[] } {
  const defs = sim.stage && sim.stage.platforms ? sim.stage.platforms : [];
  const sv = sim.stageView;
  let left = -7;
  let right = 7;
  let bw = -1;
  const plats: { x: number; y: number; w: number }[] = [];
  for (let i = 0; i < defs.length; i++) {
    const d = defs[i];
    const cur = sv && sv.platforms && sv.platforms[i] ? sv.platforms[i] : d;
    plats.push({ x: cur.x, y: cur.y, w: d.w });
    if (d.solid && d.w > bw) {
      bw = d.w;
      left = cur.x - d.w / 2;
      right = cur.x + d.w / 2;
    }
  }
  return { left, right, plats };
}

export type { MoveId };
