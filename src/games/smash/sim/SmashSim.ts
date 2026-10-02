/**
 * Smash Party — deterministic 60 Hz platform-fighter simulation (pure TS: no three.js, no DOM,
 * no Math.random / Date). Implements ISmashSim from the frozen contract (../types.ts).
 *
 * Frame order (step):
 *   stage (moving platforms) → CPU think (snapshot) → fighters (state machine + physics +
 *   collision + ledges) → grabbed positions → projectiles → items → hit resolution
 *   (hitboxes / grabs / orb) → hazard → blast zones → rules (timer, sudden death, game set).
 *
 * Knockback integration (see types.ts): on hit the victim's own velocity is zeroed and a separate
 * launch velocity is set. Each non-hitlag frame: launch speed decays by LAUNCH_DECAY, then the
 * fighter moves by (launch + own). During hitstun own vx stays 0 (no DI, no drift, no friction on
 * the launch), so the horizontal hitstun displacement equals launchDisplacement() exactly.
 */
import type {
  ActionState,
  DebugShape,
  FighterDef,
  FighterView,
  HitKind,
  ISmashSim,
  ItemKind,
  ItemView,
  MoveId,
  MovePhase,
  ProjectileView,
  SimConfig,
  SimEvent,
  SimFighterConfig,
  SimInput,
  SimResultRow,
  SimStatus,
  StageDef,
  StageView,
} from '../types';
import { INPUT_BUFFER_FRAMES, SIM_HZ, TUMBLE_KB, emptySimInput } from '../types';
import { LAUNCH_DECAY, hitstunFor, knockbackFormula, launchSpeedFor } from './knockback';
import { getFighter } from '../roster';
import { getStage } from '../stages';
import { Rng } from './rng';
import { getMoveSet, type HitboxDef, type MoveDef, type MoveSet, type ProjSpec } from './moves';
import { CpuController } from './ai/CpuController';

const BUF = INPUT_BUFFER_FRAMES;
const MAX_SHIELD = 50;
const SHIELD_DRAIN = 0.14;
const SHIELD_REGEN = 0.08;
const RESPAWN_DELAY = 60;
const RESPAWN_INVINC = 120;
const RESPAWN_PLAT_MAX = 300;
const LEDGE_INVINC = 30;
const LEDGE_MAX_GRABS = 6;
const CREDIT_WINDOW = 300;
const ITEM_LIFE = 900;
const ITEM_R = 0.38;
const ORB_BIT = 1 << 20;
const MAX_ITEMS = 3;
const SD_SECONDS = 60;

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v;
}
function approach(v: number, target: number, step: number): number {
  if (v < target) return Math.min(target, v + step);
  if (v > target) return Math.max(target, v - step);
  return v;
}
function sgn(v: number): 1 | -1 {
  return v < 0 ? -1 : 1;
}
/** Squared distance from point to vertical segment (cx, y0..y1). */
function distToSeg(px: number, py: number, cx: number, y0: number, y1: number): number {
  const yy = py < y0 ? y0 : py > y1 ? y1 : py;
  const dx = px - cx;
  const dy = py - yy;
  return Math.sqrt(dx * dx + dy * dy);
}
function fin(v: number, fb = 0): number {
  return Number.isFinite(v) ? v : fb;
}

interface Ledge {
  x: number;
  y: number;
  side: -1 | 1;
  plat: number;
  owner: number;
}

// ---------------------------------------------------------------------------
// Fighter (internal object that IS the FighterView)
// ---------------------------------------------------------------------------

class Fighter implements FighterView {
  index: number;
  characterId: string;
  name: string;
  color: string;
  slot: number;
  team: number;
  cpu: boolean;
  dummy: boolean;
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  facing: 1 | -1 = 1;
  grounded = false;
  action: ActionState = 'idle';
  actionFrame = 0;
  move: MoveId | null = null;
  moveFrame = 0;
  moveTotal = 0;
  movePhase: MovePhase | null = null;
  charge = 0;
  damage = 0;
  stocks: number;
  kos = 0;
  falls = 0;
  sds = 0;
  damageDealt = 0;
  damageTaken = 0;
  score = 0;
  shield = 1;
  shielding = false;
  invincible = false;
  hitlag = 0;
  launchSpeed = 0;
  heldItem: ItemKind | null = null;
  ledge: -1 | 0 | 1 = 0;
  jumpsLeft = 1;
  powered = false;
  out = false;
  respawning = false;
  width: number;
  height: number;

  // ---- internal ----
  def: FighterDef;
  set: MoveSet;
  cpuCtl: CpuController | null = null;
  bAtk = 0;
  bSpc = 0;
  bJmp = 0;
  bShd = 0;
  bGrb = 0;
  downAge = 99;
  plat = -1;
  lvx = 0;
  lvy = 0;
  hitstun = 0;
  md: MoveDef | null = null;
  chargeF = 0;
  chargeMul = 1;
  hitMask = new Int32Array(24);
  moveAir = false;
  landLag = 0;
  fastFall = false;
  airDodgeUsed = false;
  sideUsed = false;
  shieldHp = MAX_SHIELD;
  shieldStun = 0;
  shieldDrop = 0;
  grabbing = -1;
  grabbedBy = -1;
  grabTimer = 0;
  ledgeIdx = -1;
  ledgeGrabs = 0;
  ledgeInv = 0;
  ledgeCd = 0;
  climbX0 = 0;
  climbY0 = 0;
  respawnTimer = 0;
  respawnInv = 0;
  platTimer = 0;
  lastAttacker = -1;
  lastHitFrame = -99999;
  dropTimer = 0;
  itemId = -1;
  counterScale = 1;
  elimFrame = -1;
  retired = false;
  sdPart = false;
  dodgeDir = 0;
  adx = 0;
  ady = 0;
  teleIdx = 0;
  prevX = 0;
  prevY = 0;
  dummyHome = 0;

  constructor(i: number, fc: SimFighterConfig, stocks: number) {
    this.index = i;
    this.def = getFighter(fc.characterId);
    this.set = getMoveSet(this.def.id);
    this.characterId = this.def.id;
    this.name = fc.name;
    this.color = fc.color;
    this.slot = fc.slot;
    this.team = fc.team;
    this.cpu = fc.cpuLevel != null && !fc.dummy;
    this.dummy = !!fc.dummy;
    this.stocks = stocks;
    this.width = this.def.width;
    this.height = this.def.height;
  }
}

interface Proj extends ProjectileView {
  spec: ProjSpec;
  team: number;
  dmg: number;
  grounded: boolean;
  bounces: number;
  mask: number;
  homingTarget: number;
}

interface Item extends ItemView {
  grounded: boolean;
  plat: number;
  thrower: number;
  flyT: number;
  fuse: number;
  age: number;
  baseX: number;
  baseY: number;
  /** Bat swings left before it breaks. */
  uses: number;
}

interface Pending {
  a: number;
  v: number;
  h: HitboxDef | null;
  shield: boolean;
  grab: boolean;
}

// ---------------------------------------------------------------------------
// The simulation
// ---------------------------------------------------------------------------

export class SmashSim implements ISmashSim {
  readonly config: SimConfig;
  readonly stage: StageDef;
  frame = 0;
  status: SimStatus = 'ready';
  suddenDeath = false;
  timeLeft = -1;
  fighters: Fighter[] = [];
  items: Item[] = [];
  projectiles: Proj[] = [];
  stageView: StageView;
  winner = { fighter: -1, team: -1 };

  private rng: Rng;
  private ev: SimEvent[] = [];
  private sandbox: boolean;
  private ledges: Ledge[] = [];
  private main = 0;
  private mainL = -9;
  private mainR = 9;
  private mainTop = 0;
  private dpx: number[] = [];
  private dpy: number[] = [];
  private timerFrames = 0;
  private sdFrames = 0;
  private nextItemAt = 0;
  private nextId = 1;
  private pending: Pending[] = [];
  private nPending = 0;
  private hz: { state: 'calm' | 'warn' | 'active'; t: number; x: number; w: number; mask: number } | null = null;
  private emptyIn = emptySimInput();
  private cpuIn: (SimInput | null)[] = [];
  private gameSetFrame = -1;
  private fightFrames = 0;

  constructor(cfg: SimConfig) {
    this.config = cfg;
    this.stage = getStage(cfg.stageId);
    this.sandbox = !!cfg.sandbox;
    this.rng = new Rng(cfg.seed ^ 0x5eed1234);
    const st = this.stage;
    // main stage = first solid platform
    let mi = 0;
    for (let i = 0; i < st.platforms.length; i++) if (st.platforms[i].solid) { mi = i; break; }
    this.main = mi;
    const mp = st.platforms[mi];
    this.mainL = mp.x - mp.w / 2;
    this.mainR = mp.x + mp.w / 2;
    this.mainTop = mp.y;
    st.platforms.forEach((p, i) => {
      this.dpx.push(0);
      this.dpy.push(0);
      if (p.ledges) {
        this.ledges.push({ x: p.x - p.w / 2, y: p.y, side: -1, plat: i, owner: -1 });
        this.ledges.push({ x: p.x + p.w / 2, y: p.y, side: 1, plat: i, owner: -1 });
      }
    });
    this.stageView = { platforms: st.platforms.map((p) => ({ x: p.x, y: p.y })), hazard: null };
    if (st.hazard === 'lava' && cfg.rules.hazards && !this.sandbox) {
      this.hz = { state: 'calm', t: 600, x: 0, w: 2.4, mask: 0 };
      this.stageView.hazard = { warning: 0, active: false, x: 0, w: 2.4 };
    }
    const stocks = this.sandbox || cfg.rules.mode === 'time' ? 99 : Math.max(1, cfg.rules.stocks | 0);
    let spawnK = 0;
    cfg.fighters.forEach((fc, i) => {
      const f = new Fighter(i, fc, stocks);
      if (f.dummy) {
        f.x = 0;
        f.y = this.mainTop;
        f.dummyHome = 0;
      } else {
        const sp = st.spawns[spawnK++ % st.spawns.length];
        f.x = sp.x;
        f.y = sp.y;
      }
      f.facing = f.x > 0 ? -1 : 1;
      f.prevX = f.x;
      f.prevY = f.y;
      this.snapGround(f);
      if (fc.cpuLevel != null && !f.dummy) f.cpuCtl = new CpuController(i, fc.cpuLevel, (cfg.seed * 31 + i * 7919) >>> 0);
      this.fighters.push(f);
      this.cpuIn.push(null);
    });
    for (let i = 0; i < 64; i++) this.pending.push({ a: 0, v: 0, h: null, shield: false, grab: false });
    if (!this.sandbox && cfg.rules.mode === 'time') {
      this.timerFrames = Math.max(10, cfg.rules.timeSec | 0) * SIM_HZ;
      this.timeLeft = this.timerFrames / SIM_HZ;
    }
    this.scheduleItem(true);
  }

  // =========================================================================
  // Public API
  // =========================================================================

  go(): void {
    if (this.status === 'ready') this.status = 'fighting';
  }

  step(inputs: readonly SimInput[]): SimEvent[] {
    this.ev = [];
    this.frame++;
    this.updateStage();
    const fighting = this.status === 'fighting';
    const fs = this.fighters;
    // CPU brains see the same snapshot
    for (let i = 0; i < fs.length; i++) {
      const f = fs[i];
      this.cpuIn[i] = null;
      if (fighting && f.cpuCtl && !f.out && !f.dummy) {
        try {
          this.cpuIn[i] = f.cpuCtl.think(this);
        } catch {
          this.cpuIn[i] = null;
        }
      }
    }
    for (let i = 0; i < fs.length; i++) {
      const f = fs[i];
      let inp: SimInput = this.emptyIn;
      if (fighting && !f.dummy) {
        if (f.cpuCtl) inp = this.cpuIn[i] ?? this.emptyIn;
        else inp = inputs[i] ?? this.emptyIn;
      }
      this.updateFighter(f, inp);
    }
    this.positionGrabbed();
    this.updateProjectiles();
    this.updateItems();
    this.resolveHits();
    this.updateHazard();
    this.checkBlast();
    this.updateRules();
    for (let i = 0; i < fs.length; i++) this.sanitize(fs[i]);
    return this.ev;
  }

  setCpu(fighter: number, level: number | null): void {
    const f = this.fighters[fighter];
    if (!f || f.dummy) return;
    if (level == null) {
      f.cpuCtl = null;
      f.cpu = false;
    } else {
      f.cpuCtl = new CpuController(fighter, clamp(level | 0, 1, 9), (this.config.seed * 17 + fighter * 104729 + this.frame) >>> 0);
      f.cpu = true;
    }
  }

  retire(fighter: number): void {
    const f = this.fighters[fighter];
    if (!f || f.retired) return;
    this.releaseAll(f);
    this.dropItem(f, true);
    f.retired = true;
    f.out = true;
    f.respawning = false;
    f.action = 'out';
    f.md = null;
    f.move = null;
    f.elimFrame = this.frame;
    this.ev.push({ type: 'out', fighter });
  }

  results(): SimResultRow[] {
    const fs = this.fighters.filter((f) => !f.dummy);
    const key = new Map<number, number>();
    const stockLike = this.config.rules.mode === 'stock';
    for (const f of fs) {
      let k: number;
      if (stockLike) {
        k = f.out ? f.elimFrame : 1e7 + f.stocks * 1e4 - f.damage;
        if (f.sdPart) k += 5e7;
      } else {
        k = f.score * 1e6 + (f.sdPart ? 5e5 + (f.out ? f.elimFrame / 1e3 : 4e5) : 0);
      }
      if (f.retired) k = -1e9;
      key.set(f.index, k);
    }
    if (this.config.rules.teams) {
      const tk = new Map<number, number>();
      for (const f of fs) tk.set(f.team, Math.max(tk.get(f.team) ?? -1e12, key.get(f.index)!));
      for (const f of fs) key.set(f.index, tk.get(f.team)!);
    }
    if (this.winner.fighter >= 0) {
      for (const f of fs) {
        const win = this.config.rules.teams ? f.team === this.winner.team : f.index === this.winner.fighter;
        if (win) key.set(f.index, 1e12);
      }
    }
    const sorted = fs.slice().sort((a, b) => key.get(b.index)! - key.get(a.index)! || a.index - b.index);
    const rows: SimResultRow[] = [];
    let place = 1;
    for (let i = 0; i < sorted.length; i++) {
      const f = sorted[i];
      if (i > 0 && key.get(f.index) !== key.get(sorted[i - 1].index)) place = i + 1;
      rows.push({
        fighter: f.index,
        place,
        kos: f.kos,
        falls: f.falls,
        sds: f.sds,
        damageDealt: Math.round(f.damageDealt),
        damageTaken: Math.round(f.damageTaken),
        stocksLeft: this.config.rules.mode === 'stock' ? Math.max(0, f.out ? 0 : f.stocks) : -1,
        score: f.score,
        team: f.team,
      });
    }
    return rows;
  }

  debugShapes(): DebugShape[] {
    const out: DebugShape[] = [];
    for (const f of this.fighters) {
      if (f.out || f.action === 'ko') continue;
      const r = f.width / 2;
      const h = this.hurtHeight(f);
      out.push({ fighter: f.index, kind: 'hurt', x: f.x, y: f.y + r, x2: f.x, y2: f.y + Math.max(r, h - r), r, intangible: f.invincible });
      if (f.shielding) {
        const s = this.shieldCircle(f);
        out.push({ fighter: f.index, kind: 'shield', x: s.x, y: s.y, r: s.r });
      }
      const md = f.md;
      if (md && f.action === 'attack') {
        const mf = f.moveFrame;
        for (const hb of md.hits) {
          if (mf < hb.f0 || mf > hb.f1) continue;
          out.push({ fighter: f.index, kind: 'hit', x: f.x + f.facing * hb.x, y: f.y + hb.y, r: hb.r });
        }
        if (md.grab && mf >= md.grab.f0 && mf <= md.grab.f1) {
          out.push({ fighter: f.index, kind: 'grab', x: f.x + f.facing * md.grab.x, y: f.y + md.grab.y, r: md.grab.r });
        }
      }
    }
    for (const p of this.projectiles) out.push({ fighter: p.owner, kind: 'hit', x: p.x, y: p.y, r: p.r });
    for (const l of this.ledges) out.push({ fighter: l.owner, kind: 'ledge', x: l.x, y: l.y, r: 0.4 });
    return out;
  }

  setDamage(fighter: number, pct: number): void {
    const f = this.fighters[fighter];
    if (f) f.damage = clamp(fin(pct), 0, 999);
  }

  forceKO(fighter: number): void {
    const f = this.fighters[fighter];
    if (!f || f.out || f.action === 'ko') return;
    const b = this.stage.blast;
    const side: 'left' | 'right' | 'top' | 'bottom' = f.x < 0 ? 'left' : 'right';
    f.x = side === 'left' ? b.left - 0.5 : b.right + 0.5;
    this.koFighter(f, side);
    this.afterKOs();
  }

  spawnItem(kind: ItemKind, x?: number, y?: number): number {
    let px = x;
    let py = y;
    if (px == null || py == null) {
      const p = this.randomSpawnPoint();
      px = px ?? p.x;
      py = py ?? p.y;
    }
    const it = this.makeItem(kind, px, py);
    this.ev.push({ type: 'itemSpawn', item: it.id, kind, x: it.x, y: it.y });
    return it.id;
  }

  giveItem(fighter: number, kind: ItemKind): void {
    const f = this.fighters[fighter];
    if (!f || f.out || kind === 'orb') return;
    this.dropItem(f, true);
    const it = this.makeItem(kind, f.x, f.y + f.height * 0.5);
    it.holder = f.index;
    f.itemId = it.id;
    f.heldItem = kind;
  }

  forceGameSet(): void {
    if (this.status === 'gameSet') return;
    const fs = this.fighters.filter((f) => !f.dummy && !f.retired);
    if (fs.length === 0) {
      this.doGameSet(-1, -1);
      return;
    }
    const time = this.config.rules.mode === 'time';
    const scoreOf = (f: Fighter) => (time ? f.score * 1e4 : (f.out ? -1e4 + f.elimFrame / 1e6 : f.stocks * 1e4)) - f.damage;
    let best = fs[0];
    if (this.config.rules.teams) {
      const ts = new Map<number, number>();
      for (const f of fs) ts.set(f.team, (ts.get(f.team) ?? 0) + (time ? f.score * 1e4 : f.out ? 0 : f.stocks * 1e4) - f.damage);
      let bt = fs[0].team;
      let bv = -Infinity;
      for (const [t, v] of ts) if (v > bv) { bv = v; bt = t; }
      for (const f of fs) if (f.team === bt && scoreOf(f) > (best.team === bt ? scoreOf(best) : -Infinity)) best = f;
      if (best.team !== bt) best = fs.find((f) => f.team === bt)!;
      this.doGameSet(best.index, bt);
    } else {
      for (const f of fs) if (scoreOf(f) > scoreOf(best)) best = f;
      this.doGameSet(best.index, -1);
    }
  }

  // =========================================================================
  // Stage
  // =========================================================================

  private updateStage(): void {
    const ps = this.stage.platforms;
    const moving = this.config.rules.hazards || this.sandbox;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      const sv = this.stageView.platforms[i];
      let nx = p.x;
      let ny = p.y;
      if (p.path && moving && !this.stage.training) {
        const t = (this.frame % p.path.period) / p.path.period;
        const k = 0.5 - 0.5 * Math.cos(t * Math.PI * 2);
        nx = p.x + p.path.dx * k;
        ny = p.y + p.path.dy * k;
      }
      this.dpx[i] = nx - sv.x;
      this.dpy[i] = ny - sv.y;
      sv.x = nx;
      sv.y = ny;
    }
  }

  private spanTmp = { l: 0, r: 0, top: 0 };
  /** Current span of platform i. Returns a SHARED scratch object (no allocation): read it before the next call. */
  private platSpan(i: number): { l: number; r: number; top: number } {
    const p = this.stage.platforms[i];
    const sv = this.stageView.platforms[i];
    const t = this.spanTmp;
    t.l = sv.x - p.w / 2;
    t.r = sv.x + p.w / 2;
    t.top = sv.y;
    return t;
  }

  private velHasVx(md: MoveDef, mf: number): boolean {
    const vs = md.vel;
    if (!vs) return false;
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i];
      if (mf >= v.f && mf <= (v.until ?? v.f) && v.vx != null) return true;
    }
    return false;
  }

  private snapGround(f: Fighter): void {
    // place on the highest platform under the fighter
    let best = -1;
    let by = -1e9;
    for (let i = 0; i < this.stage.platforms.length; i++) {
      const s = this.platSpan(i);
      if (f.x >= s.l && f.x <= s.r && s.top <= f.y + 0.05 && s.top > by) {
        by = s.top;
        best = i;
      }
    }
    if (best >= 0) {
      f.y = by;
      f.plat = best;
      f.grounded = true;
    } else {
      f.grounded = false;
      f.plat = -1;
    }
  }

  // =========================================================================
  // Fighter update
  // =========================================================================

  private updateFighter(f: Fighter, inp: SimInput): void {
    if (inp.attackPressed) f.bAtk = BUF;
    if (inp.specialPressed) f.bSpc = BUF;
    if (inp.jumpPressed) f.bJmp = BUF;
    if (inp.shieldPressed) f.bShd = BUF;
    if (inp.grabPressed) f.bGrb = BUF;
    if (f.retired) return;
    if (f.action === 'out') return;
    if (f.action === 'ko') {
      this.updKO(f);
      return;
    }
    if (f.hitlag > 0) {
      f.hitlag--;
      return;
    }
    f.actionFrame++;
    if (inp.y < -0.35) f.downAge++;
    else f.downAge = 0;
    if (f.respawnInv > 0 && f.action !== 'respawn') f.respawnInv--;
    if (f.ledgeInv > 0) f.ledgeInv--;
    if (f.ledgeCd > 0) f.ledgeCd--;
    if (f.dropTimer > 0) f.dropTimer--;
    if (f.action !== 'shield' || f.shieldDrop > 0) f.shieldHp = Math.min(MAX_SHIELD, f.shieldHp + SHIELD_REGEN);
    f.shielding = false;

    let physics = true;
    switch (f.action) {
      case 'respawn':
        physics = this.updRespawnPlat(f, inp);
        break;
      case 'grabbed':
        // mashing shortens the hold (the grabber auto-throws sooner)
        if (f.grabbedBy >= 0 && (inp.attackPressed || inp.specialPressed || inp.jumpPressed || inp.shieldPressed || inp.grabPressed)) {
          this.fighters[f.grabbedBy].grabTimer += 4;
        }
        // mash presses must not replay as a move after release
        f.bAtk = f.bSpc = f.bJmp = f.bShd = f.bGrb = 0;
        physics = false;
        break;
      case 'thrown':
        physics = false;
        break;
      case 'ledgeHang':
        this.updLedge(f, inp);
        physics = f.action !== 'ledgeHang' && f.action !== 'ledgeClimb';
        break;
      case 'ledgeClimb':
        this.updClimb(f);
        physics = false;
        break;
      case 'victory':
      case 'defeat':
        f.vx = approach(f.vx, 0, 0.02);
        break;
      default:
        this.updState(f, inp);
    }
    if (physics) this.physics(f, inp);
    // hitstun countdown (after the frame's motion)
    if (f.hitstun > 0) {
      f.hitstun--;
      if (f.hitstun === 0) {
        if (f.action === 'hitstun') this.setAction(f, f.grounded ? 'idle' : 'fall');
      }
    }
    f.launchSpeed = Math.sqrt(f.lvx * f.lvx + f.lvy * f.lvy);
    if (f.bAtk > 0) f.bAtk--;
    if (f.bSpc > 0) f.bSpc--;
    if (f.bJmp > 0) f.bJmp--;
    if (f.bShd > 0) f.bShd--;
    if (f.bGrb > 0) f.bGrb--;
    f.invincible = this.computeIntan(f);
    f.shield = f.shieldHp / MAX_SHIELD;
  }

  private setAction(f: Fighter, a: ActionState): void {
    if (f.action === 'attack' && a !== 'attack') {
      f.md = null;
      f.move = null;
      f.moveFrame = 0;
      f.moveTotal = 0;
      f.movePhase = null;
      f.charge = 0;
    }
    f.action = a;
    f.actionFrame = 0;
  }

  private computeIntan(f: Fighter): boolean {
    if (f.action === 'respawn' || f.respawnInv > 0 || f.ledgeInv > 0) return true;
    const af = f.actionFrame;
    switch (f.action) {
      case 'roll':
        return af >= 3 && af <= 16;
      case 'spotDodge':
        return af >= 2 && af <= 17;
      case 'airDodge':
        return af >= 2 && af <= 22;
      case 'getUp':
        return af <= 20;
      case 'ledgeClimb':
        return true;
      case 'attack': {
        const md = f.md;
        if (!md) return false;
        if (md.final) return true;
        if (md.intan && f.moveFrame >= md.intan[0] && f.moveFrame <= md.intan[1]) return true;
        return false;
      }
      default:
        return false;
    }
  }

  private hurtHeight(f: Fighter): number {
    if (f.action === 'crouch') return f.height * 0.62;
    if (f.action === 'knockdown') return f.height * 0.4;
    return f.height;
  }

  // ----- the state machine -------------------------------------------------

  private updState(f: Fighter, inp: SimInput): void {
    const d = f.def;
    switch (f.action) {
      case 'idle':
      case 'walk':
      case 'run':
      case 'turn':
      case 'crouch':
        if (!f.grounded) {
          this.setAction(f, 'fall');
          this.airActions(f, inp);
          return;
        }
        if (this.groundActions(f, inp)) return;
        this.groundMove(f, inp);
        return;
      case 'land':
        f.vx = approach(f.vx, 0, 0.02);
        if (f.actionFrame >= f.landLag) {
          this.setAction(f, 'idle');
          if (!this.groundActions(f, inp)) this.groundMove(f, inp);
        }
        return;
      case 'jumpSquat':
        f.vx = approach(f.vx, 0, 0.01);
        if (f.actionFrame >= 3) {
          const full = inp.jump;
          f.vy = full ? d.jumpVel : d.shortHopVel;
          if (Math.abs(inp.x) > 0.3) f.vx = inp.x * d.airSpeed * 0.95;
          else f.vx = clamp(f.vx, -d.airSpeed, d.airSpeed);
          this.leaveGround(f);
          this.setAction(f, 'jump');
          this.ev.push({ type: 'jump', fighter: f.index, double: false });
        }
        return;
      case 'jump':
      case 'doubleJump':
      case 'fall':
      case 'tumble':
        if (f.action === 'tumble' && f.hitstun > 0) return;
        if (f.grounded) {
          this.setAction(f, 'idle');
          return;
        }
        if ((f.action === 'jump' || f.action === 'doubleJump') && f.vy <= 0) f.action = 'fall';
        this.airActions(f, inp);
        return;
      case 'hitstun':
        return;
      case 'helpless':
        this.airDrift(f, inp, 0.6);
        return;
      case 'attack':
        this.updMove(f, inp);
        return;
      case 'shield':
        this.updShield(f, inp);
        return;
      case 'shieldStun':
        f.vx = approach(f.vx, 0, 0.012);
        f.shielding = true;
        if (f.actionFrame >= f.shieldStun) {
          if (inp.shield) {
            f.action = 'shield';
            f.actionFrame = 10;
          } else this.setAction(f, 'idle');
        }
        return;
      case 'shieldBreak':
        if (f.grounded && f.actionFrame > 5) this.setAction(f, 'dizzy');
        return;
      case 'dizzy':
        f.vx = approach(f.vx, 0, 0.02);
        if (f.actionFrame >= 170) {
          f.shieldHp = MAX_SHIELD * 0.4;
          this.setAction(f, 'idle');
        }
        return;
      case 'roll': {
        const af = f.actionFrame;
        f.vx = af >= 3 && af <= 20 ? f.dodgeDir * 0.115 : approach(f.vx, 0, 0.03);
        if (af >= 28) {
          f.facing = (-f.dodgeDir || f.facing) as 1 | -1;
          this.setAction(f, 'idle');
        }
        return;
      }
      case 'spotDodge':
        f.vx = approach(f.vx, 0, 0.03);
        if (f.actionFrame >= 24) this.setAction(f, 'idle');
        return;
      case 'airDodge': {
        const af = f.actionFrame;
        if (f.adx !== 0 || f.ady !== 0) {
          if (af <= 16) {
            const k = Math.max(0, 1 - af / 18);
            f.vx = f.adx * k;
            f.vy = f.ady * k;
          } else this.airDrift(f, inp, 0.5);
        } else this.airDrift(f, inp, 0.7);
        if (af >= 32) this.setAction(f, f.grounded ? 'idle' : 'fall');
        return;
      }
      case 'knockdown':
        f.vx = approach(f.vx, 0, 0.03);
        if (f.hitstun > 0) return;
        if (f.actionFrame >= 14) {
          if (f.bAtk) {
            f.bAtk = 0;
            this.startMove(f, 'getupAttack');
            return;
          }
          if (Math.abs(inp.x) > 0.6) {
            this.startRoll(f, sgn(inp.x));
            return;
          }
          if (f.bJmp || f.bShd || inp.y > 0.5 || f.bSpc || f.bGrb) {
            f.bJmp = f.bShd = f.bSpc = f.bGrb = 0;
            this.setAction(f, 'getUp');
            return;
          }
        }
        if (f.actionFrame >= 60) this.setAction(f, 'getUp');
        return;
      case 'getUp':
        f.vx = 0;
        if (f.actionFrame >= 28) this.setAction(f, 'idle');
        return;
      case 'grabHold':
        this.updGrabHold(f, inp);
        return;
      default:
        return;
    }
  }

  private groundActions(f: Fighter, inp: SimInput): boolean {
    if (f.bJmp) {
      f.bJmp = 0;
      this.setAction(f, 'jumpSquat');
      return true;
    }
    if (f.bSpc) {
      f.bSpc = 0;
      this.startSpecial(f, inp);
      return true;
    }
    if (f.bGrb) {
      f.bGrb = 0;
      if (f.itemId >= 0) this.throwItem(f, inp);
      else this.startMove(f, f.action === 'run' ? 'dashGrab' : 'grab');
      return true;
    }
    if (inp.shield) {
      this.setAction(f, 'shield');
      f.shieldDrop = 0;
      f.shielding = true;
      // shield + stick at once = dodge right away
      return true;
    }
    if (f.bAtk) {
      f.bAtk = 0;
      this.groundAttack(f, inp);
      return true;
    }
    return false;
  }

  private groundAttack(f: Fighter, inp: SimInput): void {
    const ax = Math.abs(inp.x);
    const ay = Math.abs(inp.y);
    if (f.itemId >= 0) {
      const it = this.itemById(f.itemId);
      if (it && it.kind === 'bat') {
        if (ax > 0.4) f.facing = sgn(inp.x);
        it.uses--;
        this.startMove(f, 'itemSwing');
      } else this.throwItem(f, inp);
      return;
    }
    if (this.tryPickup(f)) return;
    const mag = Math.sqrt(inp.x * inp.x + inp.y * inp.y);
    if (inp.flick && mag > 0.6) {
      if (ay > ax) this.startMove(f, inp.y > 0 ? 'usmash' : 'dsmash');
      else {
        f.facing = sgn(inp.x);
        this.startMove(f, 'fsmash');
      }
      return;
    }
    if (f.action === 'run' && ax > 0.5) {
      this.startMove(f, 'dashAttack');
      return;
    }
    if (ay > ax && inp.y > 0.5) return this.startMove(f, 'utilt');
    if (ay > ax && inp.y < -0.5) return this.startMove(f, 'dtilt');
    if (ax > 0.4) {
      f.facing = sgn(inp.x);
      return this.startMove(f, 'ftilt');
    }
    this.startMove(f, 'jab1');
  }

  private startSpecial(f: Fighter, inp: SimInput): void {
    if (f.powered) {
      f.powered = false;
      if (Math.abs(inp.x) > 0.4) f.facing = sgn(inp.x);
      this.startMove(f, 'finalSmash');
      this.ev.push({ type: 'finalSmash', fighter: f.index });
      return;
    }
    const ax = Math.abs(inp.x);
    const ay = Math.abs(inp.y);
    let key = 'nspecial';
    if (ay >= ax && inp.y > 0.5) key = 'uspecial';
    else if (ay >= ax && inp.y < -0.5) key = 'dspecial';
    else if (ax > 0.4) {
      f.facing = sgn(inp.x);
      key = 'sspecial';
    }
    const wasSide = f.sideUsed;
    this.startMove(f, key);
    if (key === 'sspecial' && !f.grounded) {
      f.counterScale = wasSide ? 0 : 1; // reused as "lift allowed" flag for side specials
      f.sideUsed = true;
    }
    this.ev.push({ type: 'special', fighter: f.index, move: f.move ?? 'nspecial' });
  }

  private groundMove(f: Fighter, inp: SimInput): void {
    const d = f.def;
    const ax = Math.abs(inp.x);
    // drop through a pass-through platform with a fresh down push
    if (f.plat >= 0 && !this.stage.platforms[f.plat].solid && inp.y < -0.7 && f.downAge <= 6) {
      this.leaveGround(f);
      f.y -= 0.06;
      f.dropTimer = 14;
      this.setAction(f, 'fall');
      return;
    }
    if (inp.y < -0.6 && ax < 0.5) {
      if (f.action !== 'crouch') this.setAction(f, 'crouch');
      f.vx = approach(f.vx, 0, 0.02);
      return;
    }
    if (f.action === 'turn') {
      f.vx = approach(f.vx, 0, 0.025);
      if (f.actionFrame < 7) return;
      this.setAction(f, ax > 0.75 ? 'run' : 'idle');
    }
    let target = 0;
    let acc = 0.018;
    if (ax > 0.75) {
      const s = sgn(inp.x);
      if (f.action === 'run' && s !== f.facing) {
        f.facing = s;
        this.setAction(f, 'turn');
        return;
      }
      if (f.action !== 'run') {
        this.setAction(f, 'run');
        f.facing = s;
        f.vx = s * Math.max(Math.abs(f.vx), d.runSpeed * 0.8);
      }
      target = s * d.runSpeed;
      acc = 0.02;
    } else if (ax > 0.25) {
      if (f.action !== 'walk') this.setAction(f, 'walk');
      f.facing = sgn(inp.x);
      target = inp.x * d.walkSpeed * Math.min(1, ax / 0.75);
      acc = 0.02;
    } else {
      if (f.action !== 'idle') this.setAction(f, 'idle');
      target = 0;
      acc = 0.016;
    }
    f.vx = approach(f.vx, target, acc);
  }

  private airActions(f: Fighter, inp: SimInput): void {
    const d = f.def;
    if (f.bJmp && f.jumpsLeft > 0) {
      f.bJmp = 0;
      f.jumpsLeft--;
      f.vy = d.doubleJumpVel;
      f.vx = Math.abs(inp.x) > 0.3 ? inp.x * d.airSpeed : f.vx * 0.5;
      f.fastFall = false;
      this.setAction(f, 'doubleJump');
      this.ev.push({ type: 'jump', fighter: f.index, double: true });
      return;
    }
    if (f.bSpc) {
      f.bSpc = 0;
      this.startSpecial(f, inp);
      return;
    }
    if (f.bAtk) {
      f.bAtk = 0;
      if (f.itemId >= 0) {
        const it = this.itemById(f.itemId);
        if (it && it.kind === 'bat') {
          it.uses--;
          this.startMove(f, 'itemSwing');
        }
        else this.throwItem(f, inp);
        return;
      }
      const ax = Math.abs(inp.x);
      const ay = Math.abs(inp.y);
      let key = 'nair';
      if (ay > ax && inp.y > 0.5) key = 'uair';
      else if (ay > ax && inp.y < -0.5) key = 'dair';
      else if (ax > 0.4) key = inp.x * f.facing > 0 ? 'fair' : 'bair';
      this.startMove(f, key);
      return;
    }
    if (f.bGrb && f.itemId >= 0) {
      f.bGrb = 0;
      this.throwItem(f, inp);
      return;
    }
    if (f.bShd && !f.airDodgeUsed) {
      f.bShd = 0;
      f.airDodgeUsed = true;
      const mag = Math.sqrt(inp.x * inp.x + inp.y * inp.y);
      if (mag > 0.35) {
        f.adx = (inp.x / mag) * 0.32;
        f.ady = (inp.y / mag) * 0.32;
      } else {
        f.adx = 0;
        f.ady = 0;
      }
      f.fastFall = false;
      this.setAction(f, 'airDodge');
      this.ev.push({ type: 'dodge', fighter: f.index });
      return;
    }
    this.airDrift(f, inp, 1);
    this.tryFastFall(f, inp);
  }

  private airDrift(f: Fighter, inp: SimInput, mul: number): void {
    if (f.hitstun > 0) return;
    const d = f.def;
    if (Math.abs(inp.x) > 0.2) {
      const target = inp.x * d.airSpeed;
      if (Math.abs(f.vx) <= d.airSpeed || sgn(f.vx) !== sgn(inp.x)) f.vx = approach(f.vx, target, d.airAccel * mul);
      else f.vx = approach(f.vx, target, 0.004);
    } else f.vx = approach(f.vx, 0, 0.004 * mul);
  }

  private tryFastFall(f: Fighter, inp: SimInput): void {
    if (!f.fastFall && f.vy <= 0.02 && inp.y < -0.6 && f.downAge <= 8) {
      f.fastFall = true;
      f.vy = -f.def.fastFallSpeed;
    }
  }

  // ----- moves ------------------------------------------------------------

  private startMove(f: Fighter, key: string): void {
    const md = f.set[key];
    if (!md) return;
    if (f.action !== 'attack') f.actionFrame = 0;
    f.action = 'attack';
    f.actionFrame = 0;
    f.md = md;
    f.move = md.id;
    f.moveFrame = 0;
    f.moveTotal = md.total;
    f.movePhase = 'startup';
    f.chargeF = 0;
    f.charge = 0;
    f.chargeMul = 1;
    f.counterScale = 1;
    f.hitMask.fill(0);
    f.moveAir = !f.grounded;
    f.shielding = false;
    if (md.final) f.teleIdx = 0;
    if (md.aerial || !f.grounded) {
      // keep momentum
    }
  }

  private endMove(f: Fighter): void {
    const md = f.md;
    if (md && md.id === 'itemSwing' && f.itemId >= 0) {
      const it = this.itemById(f.itemId);
      if (it && it.uses <= 0) this.removeItem(it); // worn-out bat breaks
    }
    f.md = null;
    f.move = null;
    f.moveFrame = 0;
    f.moveTotal = 0;
    f.movePhase = null;
    f.charge = 0;
    if (f.grabbing >= 0) {
      f.action = 'grabHold';
      f.actionFrame = 10;
      return;
    }
    if (f.grounded) this.setAction(f, 'idle');
    else this.setAction(f, md && md.helpless ? 'helpless' : 'fall');
  }

  private updMove(f: Fighter, inp: SimInput): void {
    const md = f.md;
    if (!md) {
      this.setAction(f, f.grounded ? 'idle' : 'fall');
      return;
    }
    // charge hold (smash attacks / chargeable specials)
    let charging = false;
    if (md.chargeAt && f.moveFrame === md.chargeAt) {
      const held = md.chargeBtn === 'special' ? inp.special : inp.attack;
      const mx = md.chargeMax ?? 60;
      if (held && f.chargeF < mx) {
        f.chargeF++;
        f.charge = f.chargeF / mx;
        charging = true;
      }
    }
    if (!charging) f.moveFrame++;
    if (md.chargeAt) f.chargeMul = 1 + (md.chargeBonus ?? 0.4) * f.charge;
    const mf = f.moveFrame;
    f.movePhase = charging ? 'charge' : mf < md.firstActive ? 'startup' : mf <= md.lastActive ? 'active' : 'endlag';
    if (charging) {
      if (f.grounded) f.vx = approach(f.vx, 0, 0.02);
      return;
    }
    // velocity keys
    if (md.vel) {
      for (const v of md.vel) {
        if (mf >= v.f && mf <= (v.until ?? v.f)) {
          if (v.vx != null) f.vx = v.vx * f.facing;
          if (v.vy != null) {
            const liftBlocked = md.id === 'sspecial' && f.moveAir && f.counterScale === 0 && v.vy > 0;
            if (!liftBlocked) f.vy = v.vy;
            if (f.grounded && v.vy > 0) this.leaveGround(f);
          }
        }
      }
    } else if (f.grounded) f.vx = approach(f.vx, 0, 0.012);
    if (md.vel && f.grounded && !this.velHasVx(md, mf)) f.vx = approach(f.vx, 0, 0.012);
    if (!f.grounded) {
      if (md.steer) f.vx = approach(f.vx, inp.x * md.steer * 1.4, md.steer * 0.12);
      else if (!md.final) {
        const hasVx = md.vel ? this.velHasVx(md, mf) : false;
        if (!hasVx) this.airDrift(f, inp, md.drift ?? (md.aerial ? 1 : 0.5));
      }
      if (md.aerial) this.tryFastFall(f, inp);
    }
    // projectiles
    if (md.proj) {
      for (const p of md.proj) {
        const fire = mf === p.f || (p.every != null && p.until != null && mf > p.f && mf <= p.until && (mf - p.f) % p.every === 0);
        if (fire) this.spawnProj(f, p);
      }
    }
    if (md.teleport) for (const t of md.teleport) if (mf === t.f) this.teleport(f, inp, t.dist, !!t.foe);
    if (mf === md.firstActive && (md.hits.length > 0 || md.proj)) {
      this.ev.push({ type: 'swing', fighter: f.index, move: md.id, strength: clamp(md.maxDmg / 20, 0.1, 1) });
    }
    // pummel / throw
    if (md.pummel && f.grabbing >= 0) f.grabTimer++;
    if (md.pummel && mf === md.pummel.f && f.grabbing >= 0) {
      const v = this.fighters[f.grabbing];
      if (this.status !== 'gameSet') {
        v.damage = Math.min(999, v.damage + md.pummel.dmg);
        v.damageTaken += md.pummel.dmg;
        f.damageDealt += md.pummel.dmg;
        v.hitlag = 3;
        f.hitlag = 3;
        this.ev.push({ type: 'hit', attacker: f.index, victim: v.index, damage: md.pummel.dmg, kb: 0, angle: 0, x: v.x, y: v.y + v.height * 0.6, strength: 0.08, kind: 'normal', shielded: false, move: 'pummel' });
      }
    }
    if (md.throwHit && mf === md.throwHit.f && f.grabbing >= 0) {
      const v = this.fighters[f.grabbing];
      f.grabbing = -1;
      v.grabbedBy = -1;
      const back = md.id === 'bthrow';
      if (back) {
        v.x = f.x - f.facing * (f.width * 0.5 + v.width * 0.5 + 0.1);
      }
      v.action = 'hitstun';
      const th = md.throwHit;
      this.applyHit(f.index, v, th.dmg, th.ang, th.bkb, th.kbg, 'throw', f.facing, md.id, false);
      this.ev.push({ type: 'throw', fighter: f.index, victim: v.index, move: md.id });
    }
    // chain (jab combo, multi-part specials)
    if (md.next && mf >= md.next.from) {
      const pressed = md.next.btn === 'attack' ? f.bAtk : f.bSpc;
      if (pressed) {
        if (md.next.btn === 'attack') f.bAtk = 0;
        else f.bSpc = 0;
        const keep = f.counterScale;
        this.startMove(f, md.next.key);
        f.counterScale = keep;
        return;
      }
    }
    if (mf >= md.total) this.endMove(f);
  }

  private teleport(f: Fighter, inp: SimInput, dist: number, foe: boolean): void {
    if (foe) {
      const foes = this.fighters.filter((o) => o !== f && this.isActive(o) && this.canHurt(f.index, o.index));
      if (foes.length === 0) return;
      const o = foes[f.teleIdx++ % foes.length];
      f.x = clamp(o.x - o.facing * 1.0, this.mainL + 0.5, this.mainR - 0.5);
      f.y = Math.max(o.y, this.mainTop);
      f.facing = sgn(o.x - f.x);
      this.ev.push({ type: 'dodge', fighter: f.index });
    } else {
      let dx = inp.x;
      let dy = inp.y;
      const mag = Math.sqrt(dx * dx + dy * dy);
      if (mag < 0.3) {
        dx = 0;
        dy = 1;
      } else {
        dx /= mag;
        dy /= mag;
      }
      f.x += dx * dist;
      f.y += dy * dist;
      if (Math.abs(dx) > 0.2) f.facing = sgn(dx);
    }
    f.prevX = f.x;
    f.prevY = f.y;
    // ended inside the solid stage -> pop on top
    const s = this.platSpan(this.main);
    const mp = this.stage.platforms[this.main];
    if (f.x > s.l && f.x < s.r && f.y < s.top && f.y > s.top - mp.h - f.height) {
      f.y = s.top;
      f.prevY = s.top;
    }
    f.grounded = false;
    f.plat = -1;
    f.vx = 0;
    f.vy = 0;
  }

  private startRoll(f: Fighter, dir: number): void {
    f.dodgeDir = dir < 0 ? -1 : 1;
    this.setAction(f, 'roll');
    this.ev.push({ type: 'dodge', fighter: f.index });
  }

  private updShield(f: Fighter, inp: SimInput): void {
    f.vx = approach(f.vx, 0, 0.02);
    if (f.shieldDrop > 0) {
      f.shieldDrop--;
      if (f.shieldDrop === 0) this.setAction(f, 'idle');
      return;
    }
    f.shielding = true;
    f.shieldHp -= SHIELD_DRAIN;
    if (f.shieldHp <= 0) {
      this.breakShield(f);
      return;
    }
    if (f.bJmp) {
      f.bJmp = 0;
      f.shielding = false;
      this.setAction(f, 'jumpSquat');
      return;
    }
    if (f.bAtk || f.bGrb) {
      f.bAtk = 0;
      f.bGrb = 0;
      f.shielding = false;
      if (f.itemId >= 0) this.throwItem(f, inp);
      else this.startMove(f, 'grab');
      return;
    }
    if (Math.abs(inp.x) > 0.6) {
      f.shielding = false;
      this.startRoll(f, sgn(inp.x));
      return;
    }
    if (inp.y < -0.6) {
      f.shielding = false;
      this.setAction(f, 'spotDodge');
      this.ev.push({ type: 'dodge', fighter: f.index });
      return;
    }
    if (!inp.shield) {
      f.shieldDrop = 7;
      f.shielding = false;
    }
  }

  private breakShield(f: Fighter): void {
    f.shieldHp = 0;
    f.shielding = false;
    this.setAction(f, 'shieldBreak');
    f.vy = 0.3;
    f.vx = 0;
    this.leaveGround(f);
    this.ev.push({ type: 'shieldBreak', fighter: f.index });
  }

  private updGrabHold(f: Fighter, inp: SimInput): void {
    f.vx = approach(f.vx, 0, 0.03);
    if (f.grabbing < 0) {
      this.setAction(f, f.grounded ? 'idle' : 'fall');
      return;
    }
    f.grabTimer++;
    if (f.bAtk) {
      f.bAtk = 0;
      this.startMove(f, 'pummel');
      return;
    }
    const ax = Math.abs(inp.x);
    const ay = Math.abs(inp.y);
    let key: string | null = null;
    if (f.grabTimer >= 4 && (ax > 0.5 || ay > 0.5)) {
      if (ay > ax) key = inp.y > 0 ? 'uthrow' : 'dthrow';
      else key = inp.x * f.facing > 0 ? 'fthrow' : 'bthrow';
    }
    if (!key && f.grabTimer > 90) key = 'fthrow';
    if (key) {
      const v = this.fighters[f.grabbing];
      v.action = 'thrown';
      v.actionFrame = 0;
      this.startMove(f, key);
    }
  }

  // ----- ledges -------------------------------------------------------------

  private tryLedge(f: Fighter): void {
    if (f.ledgeCd > 0 || f.ledgeGrabs >= LEDGE_MAX_GRABS || f.hitstun > 0) return;
    const a = f.action;
    let ok = false;
    const vyTot = f.vy + f.lvy;
    if (a === 'fall' || a === 'jump' || a === 'doubleJump' || a === 'helpless' || a === 'tumble') ok = vyTot <= 0.02;
    else if (a === 'attack' && f.md && f.md.ledgeFrom != null && f.moveFrame >= f.md.ledgeFrom) ok = true;
    if (!ok) return;
    for (let i = 0; i < this.ledges.length; i++) {
      const L = this.ledges[i];
      if (L.owner >= 0 && L.owner !== f.index) {
        const o = this.fighters[L.owner];
        if (o.ledgeIdx === i && (o.action === 'ledgeHang' || o.action === 'ledgeClimb')) continue;
        L.owner = -1;
      }
      const dx = (f.x - L.x) * L.side;
      if (dx < -0.5 || dx > 1.4) continue;
      const dy = L.y - f.y;
      if (dy < -0.35 || dy > f.height + 0.7) continue;
      this.grabLedge(f, i);
      return;
    }
  }

  private grabLedge(f: Fighter, i: number): void {
    const L = this.ledges[i];
    if (f.action === 'attack') {
      f.md = null;
      f.move = null;
      f.movePhase = null;
      f.moveFrame = 0;
    }
    L.owner = f.index;
    f.ledgeIdx = i;
    f.ledge = L.side;
    this.setAction(f, 'ledgeHang');
    f.x = L.x + L.side * (f.width * 0.5 + 0.05);
    f.y = L.y - f.height * 0.92;
    f.vx = f.vy = f.lvx = f.lvy = 0;
    f.grounded = false;
    f.plat = -1;
    f.jumpsLeft = 1;
    f.airDodgeUsed = false;
    f.sideUsed = false;
    f.fastFall = false;
    f.facing = (-L.side) as 1 | -1;
    f.ledgeInv = f.ledgeGrabs < 2 ? LEDGE_INVINC : 0;
    f.ledgeGrabs++;
    this.ev.push({ type: 'ledgeGrab', fighter: f.index });
  }

  private releaseLedge(f: Fighter): void {
    if (f.ledgeIdx >= 0) {
      const L = this.ledges[f.ledgeIdx];
      if (L.owner === f.index) L.owner = -1;
    }
    f.ledgeIdx = -1;
    f.ledge = 0;
  }

  private updLedge(f: Fighter, inp: SimInput): void {
    if (f.ledgeIdx < 0) {
      this.setAction(f, 'fall');
      return;
    }
    const L = this.ledges[f.ledgeIdx];
    f.vx = f.vy = 0;
    if (f.actionFrame < 6) return;
    const toward = -L.side;
    const onStageX = L.x + toward * (f.width * 0.5 + 0.25);
    if (f.bJmp) {
      f.bJmp = 0;
      this.releaseLedge(f);
      f.y = L.y - f.height * 0.3;
      f.vy = f.def.jumpVel * 1.05;
      f.vx = toward * 0.09;
      this.setAction(f, 'jump');
      f.ledgeCd = 20;
      this.ev.push({ type: 'jump', fighter: f.index, double: false });
      return;
    }
    if (f.bAtk) {
      f.bAtk = 0;
      this.releaseLedge(f);
      f.x = onStageX;
      f.y = L.y;
      f.grounded = true;
      f.plat = L.plat;
      this.startMove(f, 'ledgeAttack');
      return;
    }
    if (f.bShd) {
      f.bShd = 0;
      this.releaseLedge(f);
      f.x = onStageX;
      f.y = L.y;
      f.grounded = true;
      f.plat = L.plat;
      this.startRoll(f, toward);
      f.actionFrame = 0;
      f.respawnInv = Math.max(f.respawnInv, 6);
      return;
    }
    if (inp.y > 0.5 || inp.x * toward > 0.5) {
      f.climbX0 = f.x;
      f.climbY0 = f.y;
      this.setAction(f, 'ledgeClimb');
      return;
    }
    if (inp.y < -0.5 || inp.x * L.side > 0.5 || f.actionFrame > 300) {
      this.releaseLedge(f);
      f.x += L.side * 0.15;
      f.ledgeCd = 30;
      this.setAction(f, 'fall');
    }
  }

  private updClimb(f: Fighter): void {
    if (f.ledgeIdx < 0) {
      this.setAction(f, 'fall');
      return;
    }
    const L = this.ledges[f.ledgeIdx];
    const toward = -L.side;
    const tx = L.x + toward * (f.width * 0.5 + 0.3);
    const k = Math.min(1, f.actionFrame / 22);
    f.x = f.climbX0 + (tx - f.climbX0) * k;
    f.y = f.climbY0 + (L.y - f.climbY0) * Math.min(1, k * 1.6);
    f.vx = f.vy = 0;
    if (f.actionFrame >= 26) {
      this.releaseLedge(f);
      f.x = tx;
      f.y = L.y;
      f.grounded = true;
      f.plat = L.plat;
      f.prevX = f.x;
      f.prevY = f.y;
      this.setAction(f, 'idle');
    }
  }

  // ----- respawn / KO -------------------------------------------------------

  private updKO(f: Fighter): void {
    if (f.respawnTimer > 0) f.respawnTimer--;
    if (f.respawnTimer > 0) return;
    this.respawn(f);
  }

  private respawn(f: Fighter): void {
    const offs = [0, -3, 3, -1.5, 1.5, -4.5, 4.5, 0];
    f.vx = f.vy = f.lvx = f.lvy = 0;
    f.hitstun = 0;
    f.hitlag = 0;
    f.fastFall = false;
    f.jumpsLeft = 1;
    f.airDodgeUsed = false;
    f.sideUsed = false;
    f.ledgeGrabs = 0;
    f.shieldHp = MAX_SHIELD;
    f.md = null;
    f.move = null;
    f.moveFrame = 0;
    f.movePhase = null;
    f.damage = this.suddenDeath && !this.sandbox ? 300 : 0;
    if (f.dummy) {
      f.x = f.dummyHome;
      f.y = this.mainTop;
      f.prevX = f.x;
      f.prevY = f.y;
      f.grounded = true;
      f.plat = this.main;
      f.respawning = false;
      f.respawnInv = 0;
      this.setAction(f, 'idle');
    } else {
      f.x = this.stage.respawn.x + offs[f.index % offs.length];
      f.y = this.stage.respawn.y;
      f.prevX = f.x;
      f.prevY = f.y;
      f.grounded = false;
      f.plat = -1;
      f.respawning = true;
      f.respawnInv = RESPAWN_INVINC;
      f.platTimer = RESPAWN_PLAT_MAX;
      this.setAction(f, 'respawn');
      f.facing = f.x > 0 ? -1 : 1;
    }
    this.ev.push({ type: 'respawn', fighter: f.index });
  }

  private updRespawnPlat(f: Fighter, inp: SimInput): boolean {
    f.vx = f.vy = 0;
    f.platTimer--;
    const any = Math.abs(inp.x) > 0.3 || Math.abs(inp.y) > 0.3 || f.bAtk || f.bSpc || f.bJmp || f.bShd || f.bGrb;
    if (any || f.platTimer <= 0 || this.status === 'gameSet') {
      f.respawning = false;
      f.respawnInv = RESPAWN_INVINC;
      f.bAtk = f.bSpc = f.bShd = f.bGrb = 0;
      this.setAction(f, 'fall');
      return true;
    }
    return false;
  }

  private koFighter(f: Fighter, side: 'left' | 'right' | 'top' | 'bottom'): void {
    const b = this.stage.blast;
    const credit =
      f.lastAttacker >= 0 && f.lastAttacker !== f.index && (this.frame - f.lastHitFrame <= CREDIT_WINDOW || f.action === 'tumble' || f.action === 'hitstun' || f.action === 'thrown') && this.canHurt(f.lastAttacker, f.index)
        ? f.lastAttacker
        : -1;
    this.ev.push({ type: 'ko', victim: f.index, by: credit, x: clamp(f.x, b.left, b.right), y: clamp(f.y, b.bottom, b.top), side });
    this.releaseAll(f);
    this.dropItem(f, true);
    f.powered = false;
    f.md = null;
    f.move = null;
    f.moveFrame = 0;
    f.movePhase = null;
    f.charge = 0;
    f.hitstun = 0;
    f.hitlag = 0;
    f.vx = f.vy = f.lvx = f.lvy = 0;
    f.shielding = false;
    f.x = clamp(f.x, b.left, b.right);
    f.y = clamp(f.y, b.bottom, b.top);
    f.grounded = false;
    f.plat = -1;
    if (!this.sandbox && this.status === 'fighting') {
      // Falls count every stock lost (SDs included); an SD gives nobody a point (+1/-1 time scoring).
      f.falls++;
      if (credit >= 0) this.fighters[credit].kos++;
      else f.sds++;
      for (const o of this.fighters) o.score = o.kos - o.falls;
      if (this.config.rules.mode === 'stock' || this.suddenDeath) f.stocks = Math.max(0, f.stocks - 1);
    }
    f.lastAttacker = -1;
    this.setAction(f, 'ko');
    f.respawning = true;
    f.respawnTimer = this.sandbox ? (f.dummy ? 1 : 20) : RESPAWN_DELAY;
    if (!this.sandbox && this.status === 'fighting' && (this.config.rules.mode === 'stock' || this.suddenDeath) && f.stocks <= 0) {
      f.out = true;
      f.respawning = false;
      f.elimFrame = this.frame;
      this.setAction(f, 'out');
      this.ev.push({ type: 'out', fighter: f.index });
    }
  }

  private checkBlast(): void {
    const b = this.stage.blast;
    let any = false;
    for (const f of this.fighters) {
      if (!this.isActive(f) || f.action === 'respawn') continue;
      let side: 'left' | 'right' | 'top' | 'bottom' | null = null;
      if (f.x < b.left) side = 'left';
      else if (f.x > b.right) side = 'right';
      else if (f.y < b.bottom) side = 'bottom';
      else if (f.y > b.top) {
        if (f.hitstun > 0 || f.action === 'tumble' || f.launchSpeed > 0.05) side = 'top';
        else {
          f.y = b.top;
          if (f.vy > 0) f.vy = 0;
        }
      }
      if (side) {
        if (f.grabbedBy >= 0) continue;
        if (this.status === 'gameSet') {
          // match already decided: no KO, quietly put them back for the victory/defeat pose
          const keep = f.damage;
          this.releaseAll(f);
          this.respawn(f);
          f.damage = keep;
          this.ev.pop(); // drop the respawn event
          continue;
        }
        this.koFighter(f, side);
        any = true;
      }
    }
    if (any) this.afterKOs();
  }

  private afterKOs(): void {
    if (this.sandbox || this.status !== 'fighting') return;
    if (this.config.rules.mode !== 'stock' && !this.suddenDeath) return;
    const alive = this.fighters.filter((f) => !f.dummy && !f.retired && !f.out && (!this.suddenDeath || f.sdPart));
    const teams = this.config.rules.teams;
    const groups = new Set<number>();
    for (const f of alive) groups.add(teams ? f.team : f.index);
    if (groups.size === 1) {
      const g = groups.values().next().value as number;
      let best: Fighter | null = null;
      for (const f of alive) if (!best || f.stocks > best.stocks || (f.stocks === best.stocks && f.damage < best.damage)) best = f;
      this.doGameSet(best!.index, teams ? g : -1);
    } else if (groups.size === 0) {
      // simultaneous last KOs -> sudden death between those eliminated this frame
      const tied = this.fighters.filter((f) => !f.dummy && !f.retired && f.elimFrame === this.frame);
      const tg = new Set<number>();
      for (const f of tied) tg.add(teams ? f.team : f.index);
      if (tied.length >= 2 && tg.size >= 2) this.startSuddenDeath(tied);
      else if (tied.length >= 1) this.doGameSet(tied[0].index, teams ? tied[0].team : -1);
      else this.forceGameSet();
    }
  }

  private startSuddenDeath(part: Fighter[]): void {
    this.suddenDeath = true;
    this.sdFrames = SD_SECONDS * SIM_HZ;
    this.timeLeft = SD_SECONDS;
    const ids = new Set(part.map((f) => f.index));
    let k = 0;
    for (const f of this.fighters) {
      if (f.dummy || f.retired) continue;
      if (ids.has(f.index)) {
        this.releaseAll(f);
        this.dropItem(f, true);
        f.sdPart = true;
        f.out = false;
        f.stocks = 1;
        f.damage = 300;
        f.respawning = false;
        f.respawnInv = 60;
        f.hitstun = 0;
        f.hitlag = 0;
        f.vx = f.vy = f.lvx = f.lvy = 0;
        f.md = null;
        f.move = null;
        f.movePhase = null;
        const sp = this.stage.spawns[k++ % this.stage.spawns.length];
        f.x = sp.x;
        f.y = sp.y + 0.02;
        f.prevX = f.x;
        f.prevY = f.y;
        f.facing = f.x > 0 ? -1 : 1;
        f.elimFrame = -1;
        this.snapGround(f);
        this.setAction(f, f.grounded ? 'idle' : 'fall');
      } else if (!f.out) {
        this.releaseAll(f);
        this.dropItem(f, true);
        f.out = true;
        f.respawning = false;
        f.elimFrame = this.frame - 1;
        this.setAction(f, 'out');
        this.ev.push({ type: 'out', fighter: f.index });
      }
    }
    this.projectiles.length = 0;
    this.ev.push({ type: 'suddenDeath' });
  }

  private doGameSet(fighter: number, team: number): void {
    if (this.status === 'gameSet') return;
    this.status = 'gameSet';
    this.gameSetFrame = this.frame;
    this.winner = { fighter, team };
    this.ev.push({ type: 'gameSet', winner: fighter, winnerTeam: team });
  }

  private updateRules(): void {
    if (this.status === 'gameSet') {
      // winners celebrate, others slump (once grounded and calm)
      for (const f of this.fighters) {
        if (f.out || f.dummy || f.action === 'ko' || f.action === 'victory' || f.action === 'defeat') continue;
        if (f.grabbedBy >= 0 || f.grabbing >= 0) this.releaseAll(f);
        if (f.grounded && f.hitstun === 0 && f.hitlag === 0 && f.action !== 'attack') {
          const win = this.config.rules.teams ? f.team === this.winner.team : f.index === this.winner.fighter;
          this.setAction(f, win ? 'victory' : 'defeat');
          f.facing = 1;
        }
      }
      return;
    }
    if (this.status !== 'fighting' || this.sandbox) return;
    this.fightFrames++;
    if (this.suddenDeath) {
      this.sdFrames--;
      this.timeLeft = Math.max(0, this.sdFrames / SIM_HZ);
      if (this.sdFrames <= 0 && this.sdFrames % 40 === 0) {
        const x = this.rng.range(this.mainL + 1, this.mainR - 1);
        const id = this.spawnItem('bomb', x, this.mainTop + 12);
        const it = this.itemById(id);
        if (it) {
          it.armed = true;
          it.fuse = 200;
          it.thrower = -1;
          it.flyT = 400;
          it.vy = -0.1;
        }
      }
      if (this.sdFrames < -SD_SECONDS * SIM_HZ) this.forceGameSet();
    } else if (this.config.rules.mode === 'time') {
      this.timerFrames--;
      this.timeLeft = Math.max(0, this.timerFrames / SIM_HZ);
      if (this.timerFrames % SIM_HZ === 0) {
        const s = this.timerFrames / SIM_HZ;
        if (s === 60 || s === 30 || (s <= 10 && s >= 1)) this.ev.push({ type: 'timeWarning', secondsLeft: s });
      }
      if (this.timerFrames <= 0) this.timeUp();
    }
    // items
    if (this.config.rules.items && this.frame >= this.nextItemAt) {
      if (this.items.length < MAX_ITEMS) this.spawnRandomItem();
      this.scheduleItem(false);
    }
  }

  private timeUp(): void {
    const teams = this.config.rules.teams;
    const fs = this.fighters.filter((f) => !f.dummy && !f.retired);
    const gs = new Map<number, number>();
    for (const f of fs) {
      const g = teams ? f.team : f.index;
      gs.set(g, (gs.get(g) ?? 0) + f.score);
    }
    let top = -Infinity;
    for (const v of gs.values()) top = Math.max(top, v);
    const tiedGroups: number[] = [];
    for (const [g, v] of gs) if (v === top) tiedGroups.push(g);
    if (tiedGroups.length === 1) {
      const g = tiedGroups[0];
      const members = fs.filter((f) => (teams ? f.team : f.index) === g);
      let best = members[0];
      for (const m of members) if (m.score > best.score || (m.score === best.score && m.damage < best.damage)) best = m;
      this.doGameSet(best.index, teams ? g : -1);
    } else {
      const tied = fs.filter((f) => tiedGroups.includes(teams ? f.team : f.index));
      this.startSuddenDeath(tied);
    }
  }

  // ----- physics --------------------------------------------------------------

  private leaveGround(f: Fighter): void {
    f.grounded = false;
    f.plat = -1;
  }

  private physics(f: Fighter, inp: SimInput): void {
    const d = f.def;
    // 1) launch decay
    if (f.lvx !== 0 || f.lvy !== 0) {
      const sp = Math.sqrt(f.lvx * f.lvx + f.lvy * f.lvy);
      const ns = sp - LAUNCH_DECAY;
      if (ns <= 0) {
        f.lvx = 0;
        f.lvy = 0;
      } else {
        const k = ns / sp;
        f.lvx *= k;
        f.lvy *= k;
      }
    }
    if (f.hitstun > 0) f.vx = 0;
    // 2) gravity
    if (!f.grounded) {
      let gm = 1;
      const md = f.action === 'attack' ? f.md : null;
      if (md && md.grav != null && (md.gravUntil == null || f.moveFrame <= md.gravUntil)) gm = md.grav;
      if (f.action === 'airDodge' && (f.adx !== 0 || f.ady !== 0) && f.actionFrame <= 16) gm = 0;
      if (f.action === 'ledgeHang') gm = 0;
      f.vy -= d.gravity * gm;
      const maxFall = f.fastFall ? d.fastFallSpeed : d.fallSpeed;
      if (f.vy < -maxFall) f.vy = f.fastFall ? -maxFall : Math.min(-maxFall, f.vy + d.gravity * 2);
    } else f.vy = 0;
    f.prevX = f.x;
    f.prevY = f.y;
    const mx = f.vx + f.lvx;
    const my = f.vy + f.lvy;
    if (f.grounded) {
      const p = f.plat;
      f.x += this.dpx[p] ?? 0;
      f.x += mx;
      const s = this.platSpan(p);
      f.y = s.top;
      if (my > 0.0001 && (f.lvy > 0 || f.vy > 0)) {
        this.leaveGround(f);
        f.y += my;
      } else if (f.x < s.l || f.x > s.r) {
        if (this.canWalkOff(f)) {
          this.leaveGround(f);
          if (f.action === 'idle' || f.action === 'walk' || f.action === 'run' || f.action === 'turn' || f.action === 'crouch' || f.action === 'land') {
            this.setAction(f, 'fall');
          }
        } else {
          f.x = clamp(f.x, s.l + 0.01, s.r - 0.01);
          f.vx = 0;
        }
      }
    } else {
      f.x += mx;
      f.y += my;
      this.airCollide(f, inp);
    }
    // final smash: stay over the stage
    if (f.action === 'attack' && f.md && f.md.final) {
      f.x = clamp(f.x, this.mainL + 0.4, this.mainR - 0.4);
      if (!f.grounded && f.y < this.mainTop) f.y = this.mainTop;
    }
    if (!f.grounded && f.action !== 'ledgeHang') this.tryLedge(f);
  }

  private canWalkOff(f: Fighter): boolean {
    if (f.hitstun > 0 || f.lvx !== 0) return true;
    switch (f.action) {
      case 'idle':
      case 'walk':
      case 'run':
      case 'turn':
      case 'crouch':
      case 'land':
      case 'hitstun':
      case 'tumble':
      case 'knockdown':
      case 'shieldBreak':
        return true;
      case 'attack':
        return !!(f.md && (f.md.vel || f.md.final === true) && f.md.id !== 'dashAttack' && f.md.id !== 'grab');
      default:
        return false;
    }
  }

  private airCollide(f: Fighter, inp: SimInput): void {
    const ps = this.stage.platforms;
    let landP = -1;
    let landY = -1e9;
    const falling = f.y - f.prevY;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      const s = this.platSpan(i);
      if (f.x < s.l || f.x > s.r) continue;
      if (!p.solid) {
        if (f.dropTimer > 0) continue;
        if (inp.y < -0.7 && f.hitstun === 0 && f.action !== 'helpless' && f.action !== 'shieldBreak') continue;
      }
      const prevTop = s.top - this.dpy[i];
      if (falling - this.dpy[i] <= 0.0001 && f.prevY >= prevTop - 0.02 && f.y <= s.top && s.top > landY) {
        landP = i;
        landY = s.top;
      }
    }
    if (landP >= 0) {
      f.y = landY;
      this.land(f, landP);
      return;
    }
    // solid walls / ceiling
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (!p.solid) continue;
      const s = this.platSpan(i);
      const bot = s.top - p.h;
      if (f.x > s.l && f.x < s.r && f.y < s.top - 0.001 && f.y + f.height > bot) {
        if (f.prevX <= s.l + 0.001) {
          f.x = s.l - 0.001;
          if (f.vx > 0) f.vx = 0;
          if (f.lvx > 0) f.lvx = -f.lvx * 0.3;
        } else if (f.prevX >= s.r - 0.001) {
          f.x = s.r + 0.001;
          if (f.vx < 0) f.vx = 0;
          if (f.lvx < 0) f.lvx = -f.lvx * 0.3;
        } else if (f.prevY + f.height <= bot + 0.1) {
          f.y = bot - f.height;
          if (f.vy > 0) f.vy = 0;
          if (f.lvy > 0) f.lvy = 0;
        } else {
          // overlapping from inside (teleport etc.) -> pop on top
          f.y = s.top;
          this.land(f, i);
          return;
        }
      }
    }
  }

  private land(f: Fighter, plat: number): void {
    const hard = f.vy + f.lvy < -f.def.fallSpeed * 1.05;
    const prevAction = f.action;
    f.grounded = true;
    f.plat = plat;
    const wasTumble = f.action === 'tumble';
    f.vy = 0;
    // keep a downward launch vy while grounded (ignored on the ground) so the launch vector
    // keeps decaying along its original direction -> exact horizontal displacement
    if (f.lvy < 0 && f.hitstun === 0) f.lvy = 0;
    f.fastFall = false;
    f.jumpsLeft = 1;
    f.airDodgeUsed = false;
    f.sideUsed = false;
    f.ledgeGrabs = 0;
    const md = f.md;
    if (f.action === 'attack' && md) {
      if (md.aerial || md.id === 'itemSwing' || md.id === 'itemThrow') {
        const lag = md.aerial ? md.landLag ?? 6 : 4;
        f.md = null;
        f.move = null;
        f.movePhase = null;
        f.moveFrame = 0;
        f.landLag = lag;
        this.setAction(f, 'land');
      } else if (f.moveAir && md.landCancel !== false && !md.final && md.id !== 'ledgeAttack' && md.id !== 'getupAttack') {
        f.landLag = md.landLag ?? 8;
        f.md = null;
        f.move = null;
        f.movePhase = null;
        f.moveFrame = 0;
        this.setAction(f, 'land');
      }
    } else if (f.action === 'helpless') {
      f.landLag = 18;
      this.setAction(f, 'land');
    } else if (f.action === 'airDodge') {
      f.landLag = 10;
      f.vx *= 0.7;
      this.setAction(f, 'land');
    } else if (wasTumble) {
      this.setAction(f, 'knockdown');
      f.vx = 0;
    } else if (f.action === 'hitstun') {
      // keep sliding in hitstun
    } else if (f.action === 'shieldBreak') {
      this.setAction(f, 'dizzy');
    } else if (f.action === 'fall' || f.action === 'jump' || f.action === 'doubleJump') {
      f.landLag = hard ? 6 : 3;
      this.setAction(f, 'land');
    }
    if (prevAction !== 'hitstun' && prevAction !== 'tumble') this.ev.push({ type: 'land', fighter: f.index, hard });
    else if (wasTumble) this.ev.push({ type: 'land', fighter: f.index, hard: true });
  }

  // ----- grabs ----------------------------------------------------------------

  private positionGrabbed(): void {
    for (const a of this.fighters) {
      if (a.grabbing < 0) continue;
      const v = this.fighters[a.grabbing];
      if (!v || v.grabbedBy !== a.index || !this.isActive(a)) {
        a.grabbing = -1;
        if (v && v.grabbedBy === a.index) this.freeVictim(v);
        continue;
      }
      v.x = a.x + a.facing * (a.width * 0.5 + v.width * 0.5 + 0.05);
      v.y = a.y;
      v.prevX = v.x;
      v.prevY = v.y;
      v.facing = (-a.facing) as 1 | -1;
      v.grounded = a.grounded;
      v.plat = a.plat;
      v.vx = v.vy = v.lvx = v.lvy = 0;
    }
  }

  private freeVictim(v: Fighter): void {
    v.grabbedBy = -1;
    if (v.action === 'grabbed' || v.action === 'thrown') {
      this.setAction(v, v.grounded ? 'idle' : 'fall');
      v.vx = -v.facing * 0.08;
    }
  }

  private releaseAll(f: Fighter): void {
    if (f.grabbing >= 0) {
      const v = this.fighters[f.grabbing];
      f.grabbing = -1;
      if (v && v.grabbedBy === f.index) this.freeVictim(v);
    }
    if (f.grabbedBy >= 0) {
      const a = this.fighters[f.grabbedBy];
      f.grabbedBy = -1;
      if (a && a.grabbing === f.index) {
        a.grabbing = -1;
        if (a.action === 'grabHold') this.setAction(a, a.grounded ? 'idle' : 'fall');
      }
    }
    this.releaseLedge(f);
  }

  private doGrab(a: Fighter, v: Fighter, command: string | undefined): void {
    this.releaseAll(v);
    if (v.action === 'attack') {
      v.md = null;
      v.move = null;
      v.movePhase = null;
    }
    v.shielding = false;
    a.grabbing = v.index;
    a.grabTimer = 0;
    v.grabbedBy = a.index;
    this.setAction(v, 'grabbed');
    v.hitstun = 0;
    v.vx = v.vy = v.lvx = v.lvy = 0;
    v.fastFall = false;
    this.ev.push({ type: 'grab', fighter: a.index, victim: v.index });
    if (command) {
      v.action = 'thrown';
      this.startMove(a, command);
    } else {
      this.setAction(a, 'grabHold');
      a.md = null;
      a.move = null;
    }
    this.positionGrabbed();
  }

  // ----- hits -----------------------------------------------------------------

  private isActive(f: Fighter): boolean {
    return !f.out && !f.retired && f.action !== 'ko' && f.action !== 'out';
  }

  private canHurt(a: number, v: number): boolean {
    if (a < 0) return true;
    if (a === v) return false;
    const r = this.config.rules;
    if (r.teams && !r.friendlyFire && !this.sandbox && this.fighters[a].team === this.fighters[v].team) return false;
    return true;
  }

  private hittable(v: Fighter): boolean {
    return this.isActive(v) && !v.invincible && v.action !== 'respawn';
  }

  private shieldTmp = { x: 0, y: 0, r: 0 };
  /** Shared scratch object (no allocation). */
  private shieldCircle(f: Fighter): { x: number; y: number; r: number } {
    const t = this.shieldTmp;
    t.x = f.x;
    t.y = f.y + f.height * 0.52;
    t.r = f.height * 0.55 * (0.4 + 0.6 * (Math.max(0, f.shieldHp) / MAX_SHIELD));
    return t;
  }

  private overlapsFighter(v: Fighter, x: number, y: number, r: number): boolean {
    const rr = v.width / 2;
    const h = this.hurtHeight(v);
    const d = distToSeg(x, y, v.x, v.y + rr, v.y + Math.max(rr, h - rr));
    return d <= r + rr;
  }

  private overlapsShield(v: Fighter, x: number, y: number, r: number): boolean {
    if (!v.shielding) return false;
    const s = this.shieldCircle(v);
    const dx = x - s.x;
    const dy = y - s.y;
    return Math.sqrt(dx * dx + dy * dy) <= r + s.r;
  }

  private addPending(a: number, v: number, h: HitboxDef | null, shield: boolean, grab: boolean): void {
    if (this.nPending >= this.pending.length) this.pending.push({ a: 0, v: 0, h: null, shield: false, grab: false });
    const p = this.pending[this.nPending++];
    p.a = a;
    p.v = v;
    p.h = h;
    p.shield = shield;
    p.grab = grab;
  }

  private resolveHits(): void {
    const fs = this.fighters;
    this.nPending = 0;
    const live = this.status !== 'gameSet';
    for (const a of fs) {
      const md = a.md;
      if (!md || a.action !== 'attack' || a.hitlag > 0 || !this.isActive(a)) continue;
      const mf = a.moveFrame;
      if (a.movePhase === 'charge') continue;
      if (live) {
        for (const v of fs) {
          if (v === a || !this.isActive(v) || v.action === 'respawn' || !this.canHurt(a.index, v.index)) continue;
          if (v.grabbedBy === a.index) continue;
          const bit = 1 << v.index;
          for (let hi = 0; hi < md.hits.length; hi++) {
            const h = md.hits[hi];
            if (mf < h.f0 || mf > h.f1) continue;
            if (a.hitMask[h.g] & bit) continue;
            const hx = a.x + a.facing * h.x;
            const hy = a.y + h.y;
            if (this.overlapsShield(v, hx, hy, h.r)) {
              this.addPending(a.index, v.index, h, true, false);
              break;
            }
            if (v.invincible) continue;
            if (this.overlapsFighter(v, hx, hy, h.r)) {
              this.addPending(a.index, v.index, h, false, false);
              break;
            }
          }
        }
        // grab boxes
        if (md.grab && mf >= md.grab.f0 && mf <= md.grab.f1 && a.grabbing < 0) {
          const gx = a.x + a.facing * md.grab.x;
          const gy = a.y + md.grab.y;
          let best = -1;
          let bd = 1e9;
          for (const v of fs) {
            if (v === a || !this.hittable(v) || !this.canHurt(a.index, v.index) || v.grabbedBy >= 0 || v.grabbing >= 0) continue;
            if (v.action === 'ledgeHang' || v.action === 'ledgeClimb') continue;
            if (!this.overlapsFighter(v, gx, gy, md.grab.r)) continue;
            const dd = Math.abs(v.x - a.x);
            if (dd < bd) {
              bd = dd;
              best = v.index;
            }
          }
          if (best >= 0) this.addPending(a.index, best, null, false, true);
        }
      }
      // the orb
      for (const it of this.items) {
        if (it.kind !== 'orb' || it.holder >= 0) continue;
        for (const h of md.hits) {
          if (mf < h.f0 || mf > h.f1) continue;
          if (a.hitMask[h.g] & ORB_BIT) continue;
          const dx = a.x + a.facing * h.x - it.x;
          const dy = a.y + h.y - it.y;
          if (Math.sqrt(dx * dx + dy * dy) <= h.r + 0.6) {
            a.hitMask[h.g] |= ORB_BIT;
            this.hitOrb(it, a);
            break;
          }
        }
      }
    }
    // apply (collect-then-apply = trades are possible)
    for (let i = 0; i < this.nPending; i++) {
      const p = this.pending[i];
      const a = fs[p.a];
      const v = fs[p.v];
      if (p.grab) {
        if (a.action === 'attack' && a.md && a.md.grab && a.grabbing < 0 && a.grabbedBy < 0 && a.hitstun === 0 && this.hittable(v) && v.grabbedBy < 0 && v.grabbing < 0) {
          this.doGrab(a, v, a.md.grab.command);
        }
        continue;
      }
      const h = p.h!;
      a.hitMask[h.g] |= 1 << v.index;
      if (!this.isActive(v)) continue;
      const md = a.md;
      let dmg = h.dmg * (md && md.chargeAt ? a.chargeMul : 1);
      if (md && md.key === 'counterStrike') dmg *= a.counterScale;
      dmg = Math.round(dmg * 10) / 10;
      // counter
      if (!p.shield && v.md && v.md.counter && v.action === 'attack' && v.moveFrame >= v.md.counter[0] && v.moveFrame <= v.md.counter[1] && v.md.counterMove) {
        this.triggerCounter(v, a, dmg);
        continue;
      }
      if (p.shield && v.shielding) {
        this.shieldHit(v, a.index, dmg, a.x, true, md ? md.id : null, h.kind);
        continue;
      }
      if (v.invincible) continue;
      this.applyHit(a.index, v, dmg, h.ang, h.bkb, h.kbg, h.kind, a.facing, md ? md.id : null, true);
      if (md && md.turnVictim) v.facing = (-v.facing) as 1 | -1;
      if (md && md.bounceOnHit != null && a.action === 'attack') {
        a.vy = md.bounceOnHit;
        a.vx = -a.facing * 0.05;
        this.endMove(a);
      }
    }
    // projectiles vs fighters/shields/reflectors/orb
    this.projectileHits();
  }

  private triggerCounter(v: Fighter, a: Fighter, dmg: number): void {
    const key = v.md!.counterMove!;
    v.facing = sgn(a.x - v.x);
    this.startMove(v, key);
    v.counterScale = clamp((dmg * 1.25) / 10, 1, 2.6);
    a.hitlag = Math.max(a.hitlag, 14);
    v.hitlag = 6;
    this.ev.push({ type: 'special', fighter: v.index, move: 'dspecial' });
  }

  private shieldHit(v: Fighter, att: number, dmg: number, srcX: number, freezeAttacker: boolean, move: MoveId | null, kind: HitKind): void {
    v.shieldHp -= dmg * 1.15;
    const dir = sgn(v.x - srcX);
    const lag = Math.min(12, Math.floor(dmg * 0.3 + 3));
    v.hitlag = lag;
    if (freezeAttacker && att >= 0) this.fighters[att].hitlag = Math.max(this.fighters[att].hitlag, lag);
    if (v.shieldHp <= 0) {
      this.breakShield(v);
    } else {
      v.shieldStun = Math.floor(dmg * 0.6 + 2);
      this.setAction(v, 'shieldStun');
      v.shielding = true;
      v.vx = dir * Math.min(0.17, 0.03 + dmg * 0.006);
    }
    v.shield = Math.max(0, v.shieldHp) / MAX_SHIELD;
    this.ev.push({ type: 'hit', attacker: att, victim: v.index, damage: dmg, kb: 0, angle: 0, x: v.x, y: v.y + v.height * 0.5, strength: clamp(dmg / 30, 0.05, 0.6), kind, shielded: true, move });
  }

  /** The one place knockback is applied. dirSign mirrors the angle (attacker facing / source side). */
  private applyHit(att: number, v: Fighter, dmg: number, ang: number, bkb: number, kbg: number, kind: HitKind, dirSign: number, move: MoveId | null, freezeAttacker: boolean): void {
    if (this.status === 'gameSet' || !this.isActive(v)) return;
    v.damage = Math.min(999, v.damage + dmg);
    v.damageTaken += dmg;
    if (att >= 0 && att !== v.index) this.fighters[att].damageDealt += dmg;
    const kb = knockbackFormula(v.damage, dmg, v.def.weight, kbg, bkb);
    let a = ang;
    if (a === 361) a = v.grounded ? (kb < 60 ? 0 : Math.min(40, ((kb - 60) / 28) * 40)) : 40;
    const rad = (a * Math.PI) / 180;
    const dir = dirSign < 0 ? -1 : 1;
    const worldAngle = dir > 0 ? a : 180 - a;
    let lag = Math.floor(dmg * 0.45 + 3);
    if (kind === 'electric') lag = Math.floor(lag * 1.5);
    lag = Math.min(20, lag);
    if (att >= 0 && att !== v.index) {
      v.lastAttacker = att;
      v.lastHitFrame = this.frame;
    }
    const strength = clamp(kb / 180, 0, 1);
    // super armour
    const armored = v.action === 'attack' && v.md && v.md.armor && v.moveFrame >= v.md.armor[0] && v.moveFrame <= v.md.armor[1] && kb < 125;
    if (armored) {
      v.hitlag = Math.max(v.hitlag, Math.floor(lag * 0.6));
      if (freezeAttacker && att >= 0) this.fighters[att].hitlag = Math.max(this.fighters[att].hitlag, lag);
      this.ev.push({ type: 'hit', attacker: att, victim: v.index, damage: dmg, kb, angle: worldAngle, x: v.x, y: v.y + v.height * 0.6, strength: strength * 0.5, kind, shielded: false, move });
      return;
    }
    // interrupt whatever the victim was doing
    if (v.grabbedBy >= 0 && v.grabbedBy !== att) this.releaseAll(v);
    else if (v.grabbedBy >= 0) {
      const g = this.fighters[v.grabbedBy];
      if (g.grabbing === v.index) g.grabbing = -1;
      v.grabbedBy = -1;
    }
    if (v.grabbing >= 0) this.releaseAll(v);
    this.releaseLedge(v);
    if (kb > 60 && v.itemId >= 0) this.dropItem(v, false);
    const speed = launchSpeedFor(kb);
    v.lvx = Math.cos(rad) * speed * dir;
    v.lvy = Math.sin(rad) * speed;
    if (Math.abs(v.lvx) < 1e-12) v.lvx = 0;
    if (v.grounded && v.lvy < 0 && kb > TUMBLE_KB) v.lvy = -v.lvy; // meteor on the ground: bounce up
    v.vx = 0;
    v.vy = 0;
    v.fastFall = false;
    v.shielding = false;
    v.hitstun = Math.max(1, hitstunFor(kb));
    v.md = null;
    v.move = null;
    v.movePhase = null;
    v.moveFrame = 0;
    v.charge = 0;
    v.action = kb > TUMBLE_KB ? 'tumble' : 'hitstun';
    v.actionFrame = 0;
    v.jumpsLeft = 1;
    v.airDodgeUsed = false;
    v.sideUsed = false;
    v.hitlag = lag;
    v.launchSpeed = speed;
    if (freezeAttacker && att >= 0 && att !== v.index) this.fighters[att].hitlag = Math.max(this.fighters[att].hitlag, lag);
    this.ev.push({ type: 'hit', attacker: att, victim: v.index, damage: dmg, kb, angle: worldAngle, x: v.x, y: v.y + v.height * 0.6, strength, kind, shielded: false, move });
  }

  private explode(x: number, y: number, r: number, dmg: number, ang: number, bkb: number, kbg: number, owner: number, selfHurt: boolean): void {
    this.ev.push({ type: 'explosion', x, y, r });
    if (this.status === 'gameSet') return;
    for (const v of this.fighters) {
      if (!this.hittable(v)) continue;
      if (owner >= 0) {
        if (owner === v.index) {
          if (!selfHurt) continue;
        } else if (!this.canHurt(owner, v.index)) continue;
      }
      if (this.overlapsShield(v, x, y, r)) {
        this.shieldHit(v, owner, dmg, x, false, null, 'explosion');
        continue;
      }
      if (!this.overlapsFighter(v, x, y, r)) continue;
      this.applyHit(owner === v.index ? -1 : owner, v, dmg, ang, bkb, kbg, 'explosion', v.x >= x ? 1 : -1, null, false);
      if (owner === v.index) {
        v.lastAttacker = -1;
      }
    }
  }

  // ----- projectiles -------------------------------------------------------

  private spawnProj(f: Fighter, s: ProjSpec): void {
    if (s.maxActive) {
      let n = 0;
      for (const p of this.projectiles) if (p.owner === f.index && p.kind === s.kind) n++;
      if (n >= s.maxActive) return;
    }
    let x = f.x + f.facing * s.x;
    let y = f.y + s.y;
    if (s.rain) {
      x = this.rng.range(this.mainL + 0.8, this.mainR - 0.8);
      y = this.mainTop + 12;
    }
    const scale = s.chargeScale ? f.chargeMul : 1;
    const p: Proj = {
      id: this.nextId++,
      owner: f.index,
      kind: s.kind,
      x,
      y,
      vx: s.vx * f.facing,
      vy: s.vy,
      r: s.r * (s.chargeScale ? 1 + f.charge * 0.8 : 1),
      color: s.color,
      life: s.life,
      spec: s,
      team: f.team,
      dmg: Math.round(s.dmg * scale * 10) / 10,
      grounded: false,
      bounces: s.bounce ?? 0,
      mask: 0,
      homingTarget: -1,
    };
    this.projectiles.push(p);
  }

  private updateProjectiles(): void {
    const b = this.stage.blast;
    const ps = this.stage.platforms;
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      const s = p.spec;
      p.life--;
      if (s.homing && !p.grounded) {
        let best: Fighter | null = null;
        let bd = 1e9;
        for (const f of this.fighters) {
          if (!this.isActive(f) || !this.canHurt(p.owner, f.index) || f.action === 'respawn') continue;
          const dx = f.x - p.x;
          const dy = f.y + f.height * 0.5 - p.y;
          const dd = dx * dx + dy * dy;
          if (dd < bd) {
            bd = dd;
            best = f;
          }
        }
        if (best) {
          const dx = best.x - p.x;
          const dy = best.y + best.height * 0.5 - p.y;
          const m = Math.sqrt(dx * dx + dy * dy) || 1;
          p.vx += (dx / m) * s.homing;
          p.vy += (dy / m) * s.homing;
          const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
          const max = Math.max(0.12, Math.abs(s.vx));
          if (sp > max) {
            p.vx *= max / sp;
            p.vy *= max / sp;
          }
        }
      }
      if (!p.grounded) {
        if (s.grav) p.vy -= s.grav;
        const py0 = p.y;
        p.x += p.vx;
        p.y += p.vy;
        // ground contact (from above)
        if (s.grav || s.stick || s.bounce) {
          for (let k = 0; k < ps.length; k++) {
            const sp = this.platSpan(k);
            if (p.x < sp.l || p.x > sp.r) continue;
            if (p.vy <= 0 && py0 - p.r >= sp.top - 0.05 && p.y - p.r <= sp.top) {
              p.y = sp.top + p.r;
              if (p.bounces > 0) {
                p.bounces--;
                p.vy = Math.max(0.12, Math.abs(p.vy) * 0.75);
              } else if (s.stick) {
                p.grounded = true;
                p.vx = 0;
                p.vy = 0;
              } else p.life = 0;
              break;
            }
          }
        }
        // solid stage sides
        const m = ps[this.main];
        const ms = this.platSpan(this.main);
        if (p.x > ms.l && p.x < ms.r && p.y < ms.top - 0.05 && p.y > ms.top - m.h) p.life = 0;
      }
      if (p.x < b.left - 2 || p.x > b.right + 2 || p.y < b.bottom - 2 || p.y > b.top + 4) p.life = 0;
      if (p.life <= 0) {
        if (s.explodeR && p.y > b.bottom) this.explode(p.x, p.y, s.explodeR, p.dmg, s.ang, s.bkb, s.kbg, p.owner, false);
        this.projectiles.splice(i, 1);
      }
    }
  }

  private projectileHits(): void {
    const live = this.status !== 'gameSet';
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      const s = p.spec;
      let dead = false;
      // reflectors
      for (const f of this.fighters) {
        const md = f.md;
        if (!md || !md.reflect || f.action !== 'attack' || f.index === p.owner) continue;
        if (!this.canHurt(f.index, p.owner) && p.owner >= 0) continue;
        if (f.moveFrame < md.reflect[0] || f.moveFrame > md.reflect[1]) continue;
        const dx = p.x - f.x;
        const dy = p.y - (f.y + f.height * 0.5);
        if (Math.sqrt(dx * dx + dy * dy) <= md.reflect[2] + p.r) {
          p.owner = f.index;
          p.team = f.team;
          p.vx = -p.vx * 1.15 || f.facing * 0.2;
          p.vy = -p.vy * 0.5;
          p.dmg = Math.round(p.dmg * 1.25 * 10) / 10;
          p.life = Math.max(p.life, 60);
          p.mask = 0;
          p.grounded = false;
          this.ev.push({ type: 'special', fighter: f.index, move: md.id });
        }
      }
      // orb
      for (const it of this.items) {
        if (it.kind !== 'orb') continue;
        const dx = p.x - it.x;
        const dy = p.y - it.y;
        if (!(p.mask & ORB_BIT) && Math.sqrt(dx * dx + dy * dy) <= p.r + 0.6 && p.owner >= 0) {
          p.mask |= ORB_BIT;
          this.hitOrb(it, this.fighters[p.owner]);
          if (!s.pierce) dead = true;
        }
      }
      if (!live || dead) {
        if (dead) this.killProj(i);
        continue;
      }
      for (const v of this.fighters) {
        if (v.index === p.owner || !this.isActive(v) || v.action === 'respawn') continue;
        if (!this.canHurt(p.owner, v.index)) continue;
        const bit = 1 << v.index;
        if (p.mask & bit) continue;
        const shield = this.overlapsShield(v, p.x, p.y, p.r);
        if (!shield && (v.invincible || !this.overlapsFighter(v, p.x, p.y, p.r))) continue;
        p.mask |= bit;
        if (s.decoy || s.explodeR) {
          dead = true;
          break; // explodes below
        }
        const dir = p.vx !== 0 ? (p.vx > 0 ? 1 : -1) : v.x >= p.x ? 1 : -1;
        if (v.md && v.md.counter && v.action === 'attack' && v.moveFrame >= v.md.counter[0] && v.moveFrame <= v.md.counter[1]) {
          if (p.owner >= 0) this.triggerCounter(v, this.fighters[p.owner], p.dmg);
          dead = true;
          break;
        }
        if (shield) this.shieldHit(v, p.owner, p.dmg, p.x - p.vx, false, null, s.hitKind ?? 'projectile');
        else this.applyHit(p.owner, v, p.dmg, s.ang, s.bkb, s.kbg, s.hitKind ?? 'projectile', dir, null, false);
        if (!s.pierce) {
          dead = true;
          break;
        }
      }
      if (dead) this.killProj(i);
    }
  }

  private killProj(i: number): void {
    const p = this.projectiles[i];
    if (!p) return;
    const s = p.spec;
    this.projectiles.splice(i, 1);
    if (s.explodeR) this.explode(p.x, p.y, s.explodeR, p.dmg, s.ang, s.bkb, s.kbg, p.owner, false);
  }

  // ----- items --------------------------------------------------------------------

  private scheduleItem(first: boolean): void {
    const base = this.config.rules.itemFrequency === 'high' ? 300 : this.config.rules.itemFrequency === 'low' ? 900 : 540;
    this.nextItemAt = this.frame + Math.round(base * (first ? 0.5 : this.rng.range(0.75, 1.25)));
  }

  private randomSpawnPoint(): { x: number; y: number } {
    const ps = this.stage.platforms;
    let tot = 0;
    for (const p of ps) tot += p.w;
    let r = this.rng.next() * tot;
    let pi = 0;
    for (let i = 0; i < ps.length; i++) {
      r -= ps[i].w;
      if (r <= 0) {
        pi = i;
        break;
      }
    }
    const s = this.platSpan(pi);
    return { x: this.rng.range(s.l + 0.8, s.r - 0.8), y: s.top + 5 };
  }

  private spawnRandomItem(): void {
    const roll = this.rng.next();
    let kind: ItemKind;
    if (roll < 0.05) kind = 'orb';
    else if (roll < 0.3) kind = 'bat';
    else if (roll < 0.55) kind = 'bomb';
    else if (roll < 0.75) kind = 'food';
    else kind = 'capsule';
    if (kind === 'orb' && (this.items.some((i) => i.kind === 'orb') || this.fighters.some((f) => f.powered))) kind = 'capsule';
    if (kind === 'orb') {
      const x = this.rng.range(this.mainL + 3, this.mainR - 3);
      this.spawnItem('orb', x, this.mainTop + 6);
    } else this.spawnItem(kind);
  }

  private makeItem(kind: ItemKind, x: number, y: number): Item {
    const it: Item = {
      id: this.nextId++,
      kind,
      x: fin(x),
      y: fin(y, 5),
      vx: 0,
      vy: 0,
      rot: 0,
      holder: -1,
      armed: false,
      life: kind === 'orb' ? 1200 : ITEM_LIFE,
      hp: kind === 'orb' ? 3 : undefined,
      grounded: false,
      plat: -1,
      thrower: -1,
      flyT: 0,
      fuse: 0,
      age: 0,
      baseX: fin(x),
      baseY: fin(y, 5),
      uses: 4,
    };
    this.items.push(it);
    return it;
  }

  private itemById(id: number): Item | null {
    for (const it of this.items) if (it.id === id) return it;
    return null;
  }

  private removeItem(it: Item): void {
    const i = this.items.indexOf(it);
    if (i >= 0) this.items.splice(i, 1);
    if (it.holder >= 0) {
      const f = this.fighters[it.holder];
      if (f && f.itemId === it.id) {
        f.itemId = -1;
        f.heldItem = null;
      }
    }
  }

  private dropItem(f: Fighter, destroy: boolean): void {
    if (f.itemId < 0) return;
    const it = this.itemById(f.itemId);
    f.itemId = -1;
    f.heldItem = null;
    if (!it) return;
    it.holder = -1;
    if (destroy) {
      this.removeItem(it);
      return;
    }
    it.vy = 0.15;
    it.vx = -f.facing * 0.05;
    it.grounded = false;
    it.life = ITEM_LIFE;
  }

  private tryPickup(f: Fighter): boolean {
    if (f.itemId >= 0) return false;
    for (const it of this.items) {
      if (it.holder >= 0 || it.kind === 'orb' || it.kind === 'food' || it.flyT > 0) continue;
      if (Math.abs(it.x - f.x) < 1.15 && it.y - f.y > -0.6 && it.y - f.y < 1.2) {
        it.holder = f.index;
        it.grounded = false;
        f.itemId = it.id;
        f.heldItem = it.kind;
        this.ev.push({ type: 'itemPickup', fighter: f.index, kind: it.kind });
        this.startMove(f, 'itemThrow');
        f.md = null;
        f.move = null;
        this.setAction(f, 'land');
        f.landLag = 6;
        return true;
      }
    }
    return false;
  }

  private throwItem(f: Fighter, inp: SimInput): void {
    const it = this.itemById(f.itemId);
    if (!it) {
      f.itemId = -1;
      f.heldItem = null;
      return;
    }
    const ax = Math.abs(inp.x);
    const ay = Math.abs(inp.y);
    let vx: number;
    let vy: number;
    if (ay > ax && inp.y > 0.5) {
      vx = f.facing * 0.02;
      vy = 0.48;
    } else if (ay > ax && inp.y < -0.5) {
      vx = 0;
      vy = f.grounded ? 0.02 : -0.45;
    } else {
      if (ax > 0.3) f.facing = sgn(inp.x);
      vx = f.facing * 0.42;
      vy = 0.1;
    }
    it.holder = -1;
    it.vx = vx;
    it.vy = vy;
    it.x = f.x + f.facing * 0.5;
    it.y = f.y + f.height * 0.6;
    it.thrower = f.index;
    it.flyT = Math.abs(vx) + Math.abs(vy) > 0.1 ? 70 : 0;
    it.grounded = false;
    it.life = ITEM_LIFE;
    if (it.kind === 'bomb') {
      it.armed = true;
      it.fuse = 240;
    }
    f.itemId = -1;
    f.heldItem = null;
    this.ev.push({ type: 'itemThrow', fighter: f.index, kind: it.kind });
    this.startMove(f, 'itemThrow');
  }

  private hitOrb(it: Item, f: Fighter): void {
    if (this.status === 'gameSet') return;
    it.hp = (it.hp ?? 3) - 1;
    if (it.hp <= 0) {
      this.removeItem(it);
      if (this.isActive(f)) {
        f.powered = true;
        this.ev.push({ type: 'powerUp', fighter: f.index });
      }
    }
  }

  private openCapsule(it: Item): void {
    const x = it.x;
    const y = it.y;
    this.removeItem(it);
    if (this.rng.next() < 0.12) {
      this.ev.push({ type: 'capsuleOpen', x, y, kind: 'bomb' });
      this.explode(x, y, 1.8, 12, 60, 50, 70, -1, true);
      return;
    }
    const r = this.rng.next();
    const kind: ItemKind = r < 0.4 ? 'bat' : r < 0.7 ? 'bomb' : 'food';
    this.ev.push({ type: 'capsuleOpen', x, y, kind });
    const n = this.makeItem(kind, x, y + 0.2);
    n.vy = 0.15;
    this.ev.push({ type: 'itemSpawn', item: n.id, kind, x: n.x, y: n.y });
  }

  private updateItems(): void {
    const ps = this.stage.platforms;
    const b = this.stage.blast;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (this.items[i] !== it) continue;
      it.age++;
      if (it.holder >= 0) {
        const f = this.fighters[it.holder];
        if (!f || f.itemId !== it.id || !this.isActive(f)) {
          it.holder = -1;
          if (f && f.itemId === it.id) {
            f.itemId = -1;
            f.heldItem = null;
          }
        } else {
          it.x = f.x + f.facing * 0.45;
          it.y = f.y + f.height * 0.55;
          it.vx = f.vx;
          it.vy = f.vy;
          it.rot = 0;
          if (it.kind === 'bomb' && it.armed) {
            it.fuse--;
            if (it.fuse <= 0) {
              this.removeItem(it);
              this.explode(it.x, it.y, 2.2, 18, 60, 55, 80, -1, true);
            }
          }
          continue;
        }
      }
      it.life--;
      if (it.kind === 'orb') {
        it.x = it.baseX + Math.sin(it.age * 0.013) * 5;
        it.y = it.baseY + Math.sin(it.age * 0.031) * 1.2;
        it.x = clamp(it.x, this.mainL + 1, this.mainR - 1);
        it.rot += 0.03;
        if (it.life <= 0) this.removeItem(it);
        continue;
      }
      // physics
      if (it.grounded && it.plat >= 0) {
        const s = this.platSpan(it.plat);
        it.x += this.dpx[it.plat] + it.vx;
        it.y = s.top + ITEM_R;
        it.vx *= 0.8;
        if (Math.abs(it.vx) < 0.002) it.vx = 0;
        if (it.x < s.l || it.x > s.r) {
          it.grounded = false;
          it.plat = -1;
        }
      } else {
        it.vy = Math.max(-0.4, it.vy - 0.012);
        const y0 = it.y;
        it.x += it.vx;
        it.y += it.vy;
        it.rot += it.vx * 2;
        for (let k = 0; k < ps.length; k++) {
          const s = this.platSpan(k);
          if (it.x < s.l || it.x > s.r) continue;
          if (it.vy <= 0 && y0 - ITEM_R >= s.top - this.dpy[k] - 0.05 && it.y - ITEM_R <= s.top) {
            const impact = -it.vy;
            it.y = s.top + ITEM_R;
            if (it.kind === 'bomb' && it.armed && it.flyT > 0 && impact > 0.2) {
              this.removeItem(it);
              this.explode(it.x, it.y, 2.2, 18, 60, 55, 80, it.thrower, true);
              break;
            }
            if (it.kind === 'capsule' && it.flyT > 0 && impact + Math.abs(it.vx) > 0.25) {
              this.openCapsule(it);
              break;
            }
            if (impact > 0.12) it.vy = impact * 0.35;
            else {
              it.vy = 0;
              it.grounded = true;
              it.plat = k;
              it.flyT = 0;
            }
            break;
          }
        }
        if (this.items[i] !== it) continue;
        // solid sides
        const mp = ps[this.main];
        const ms = this.platSpan(this.main);
        if (it.x > ms.l && it.x < ms.r && it.y < ms.top - 0.05 && it.y > ms.top - mp.h) {
          it.x = it.vx > 0 ? ms.l - 0.05 : ms.r + 0.05;
          it.vx = -it.vx * 0.4;
        }
      }
      if (it.flyT > 0) it.flyT--;
      // bombs
      if (it.kind === 'bomb' && it.armed) {
        it.fuse--;
        if (it.fuse <= 0) {
          this.removeItem(it);
          this.explode(it.x, it.y, 2.2, 18, 60, 55, 80, it.thrower, true);
          continue;
        }
      }
      // contact with fighters
      const sp = Math.abs(it.vx) + Math.abs(it.vy);
      let gone = false;
      for (const v of this.fighters) {
        if (!this.isActive(v) || v.action === 'respawn') continue;
        if (it.kind === 'food') {
          if (this.overlapsFighter(v, it.x, it.y, ITEM_R)) {
            const amt = Math.min(15, v.damage);
            v.damage = Math.max(0, v.damage - 15);
            this.ev.push({ type: 'heal', fighter: v.index, amount: amt });
            this.removeItem(it);
            gone = true;
            break;
          }
          continue;
        }
        if (it.flyT <= 0 || sp < 0.1 || v.index === it.thrower) continue;
        if (it.thrower >= 0 && !this.canHurt(it.thrower, v.index)) continue;
        if (v.invincible && !this.overlapsShield(v, it.x, it.y, ITEM_R)) continue;
        if (!this.overlapsFighter(v, it.x, it.y, ITEM_R) && !this.overlapsShield(v, it.x, it.y, ITEM_R)) continue;
        if (it.kind === 'bomb') {
          this.removeItem(it);
          this.explode(it.x, it.y, 2.2, 18, 60, 55, 80, it.thrower, true);
          gone = true;
          break;
        }
        const dir = it.vx >= 0 ? 1 : -1;
        if (this.status !== 'gameSet') {
          if (v.shielding && this.overlapsShield(v, it.x, it.y, ITEM_R)) this.shieldHit(v, it.thrower, it.kind === 'bat' ? 9 : 5, it.x - it.vx, false, 'itemThrow', 'projectile');
          else if (it.kind === 'bat') this.applyHit(it.thrower, v, 9, 45, 40, 65, 'bat', dir, 'itemThrow', false);
          else this.applyHit(it.thrower, v, 5, 45, 30, 50, 'projectile', dir, 'itemThrow', false);
        }
        if (it.kind === 'capsule') {
          this.openCapsule(it);
          gone = true;
          break;
        }
        it.vx = -it.vx * 0.3;
        it.vy = 0.12;
        it.flyT = 0;
      }
      if (gone) continue;
      if (it.life <= 0 || it.y < b.bottom || it.x < b.left || it.x > b.right) {
        this.removeItem(it);
      }
    }
  }

  // ----- hazard -------------------------------------------------------------------

  private updateHazard(): void {
    const hz = this.hz;
    if (!hz || this.status !== 'fighting') return;
    const sv = this.stageView.hazard!;
    hz.t--;
    if (hz.state === 'calm') {
      sv.warning = 0;
      sv.active = false;
      if (hz.t <= 0) {
        hz.state = 'warn';
        hz.t = 120;
        hz.x = this.rng.range(this.mainL + 1.5, this.mainR - 1.5);
        sv.x = hz.x;
        sv.w = hz.w;
        this.ev.push({ type: 'hazardWarning', x: hz.x });
      }
    } else if (hz.state === 'warn') {
      sv.warning = clamp(1 - hz.t / 120, 0, 1);
      if (hz.t <= 0) {
        hz.state = 'active';
        hz.t = 50;
        hz.mask = 0;
        sv.active = true;
        sv.warning = 1;
        this.ev.push({ type: 'hazardErupt', x: hz.x });
      }
    } else {
      for (const v of this.fighters) {
        if (!this.hittable(v) || hz.mask & (1 << v.index)) continue;
        if (Math.abs(v.x - hz.x) > hz.w / 2 + v.width / 2) continue;
        if (v.y > this.mainTop + 7 || v.y < this.mainTop - 3) continue;
        hz.mask |= 1 << v.index;
        if (v.shielding) this.shieldHit(v, -1, 12, hz.x, false, null, 'fire');
        else this.applyHit(-1, v, 12, 90, 70, 55, 'fire', v.x >= hz.x ? 1 : -1, null, false);
      }
      if (hz.t <= 0) {
        hz.state = 'calm';
        hz.t = this.rng.int(600, 840);
        sv.active = false;
        sv.warning = 0;
      }
    }
  }

  // ----- safety -------------------------------------------------------------------

  private sanitize(f: Fighter): void {
    if (!Number.isFinite(f.x) || !Number.isFinite(f.y)) {
      f.x = this.stage.respawn.x;
      f.y = this.stage.respawn.y;
    }
    f.vx = fin(f.vx);
    f.vy = fin(f.vy);
    f.lvx = fin(f.lvx);
    f.lvy = fin(f.lvy);
    f.damage = fin(f.damage);
    f.launchSpeed = fin(f.launchSpeed);
    f.charge = fin(f.charge);
    f.shield = fin(f.shield, 1);
    // a stuck move can never last forever
    if (f.action === 'attack' && f.md && f.actionFrame > f.md.total + (f.md.chargeMax ?? 60) + 30) this.endMove(f);
    if (f.action === 'grabbed' && f.grabbedBy < 0) this.setAction(f, f.grounded ? 'idle' : 'fall');
    if (f.action === 'thrown' && f.grabbedBy < 0 && f.hitstun === 0) this.setAction(f, f.grounded ? 'idle' : 'fall');
    if (f.dummy && this.isActive(f) && f.grounded && f.action === 'idle' && f.hitstun === 0) {
      // walk back towards home slowly when knocked away
      if (Math.abs(f.x - f.dummyHome) > 0.3 && f.actionFrame > 90) f.x = approach(f.x, f.dummyHome, 0.04);
    }
  }
}
