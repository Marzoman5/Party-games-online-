/**
 * FROZEN CONTRACT — Smash Party shared types (sim <-> view <-> model <-> AI <-> host).
 *
 * Pure types + constants, NO imports of three.js or DOM, so the phone, Node tests and the
 * deterministic simulation can all import it. Owned by the LEAD. Additive changes only
 * (new optional fields); note them at the bottom of docs/PARTY_HUB_CONTRACT.md.
 *
 * World conventions
 * - 2D gameplay plane: +x right, +y UP. Units ≈ "metres" (1 unit = 10 classic smash units).
 *   A medium fighter is ~1.8 units tall. The main stage is ~14–18 units wide.
 * - Fighter position (x, y) = FEET centre. The renderer places the 3D model at (x, y, 0).
 * - The simulation runs at a FIXED 60 Hz (`SIM_HZ`). All durations below are in frames.
 * - Fighter indices: humans first (index i = cfg.humans[i]), then CPUs, then (sandbox only) the dummy.
 */

export const SIM_HZ = 60;
export const SIM_DT = 1 / SIM_HZ;
/** Input buffer: a press that can't act this frame is retried for this many frames. */
export const INPUT_BUFFER_FRAMES = 5;
/** 1 world unit = 10 classic smash units. */
export const WORLD_PER_SMASH_UNIT = 0.1;

// ---------------------------------------------------------------------------
// Knockback (Smash-style). The sim MUST use exactly these in src/games/smash/sim/knockback.ts
// (re-export them) — the deterministic combat unit test checks them.
//
//   kb = ((((p/10 + p*d/20) * (200/(w+100)) * 1.4) + 18) * (kbg/100)) + bkb
//     p   = target damage % AFTER the hit is applied
//     d   = damage of the hit
//     w   = target weight (~100 = medium; light ~70, heavy ~125)
//     kbg = knockback growth, bkb = base knockback (per hitbox)
//   launch speed (world units / frame) = kb * LAUNCH_SPEED_PER_KB
//   hitstun frames = floor(kb * HITSTUN_PER_KB)
//   The launch velocity (separate from the fighter's own velocity) decays by LAUNCH_DECAY
//   world units/frame every frame (vector magnitude, never below 0). During hitstun the
//   fighter's horizontal motion is ONLY the launch velocity's x component (no DI / no drift),
//   vertical = launch vy + the fighter's own gravity-driven vy.
//   kb > TUMBLE_KB => tumble (launched, smoke trail, knockdown on landing).
// ---------------------------------------------------------------------------
export const LAUNCH_SPEED_PER_KB = 0.03 * WORLD_PER_SMASH_UNIT; // 0.003
export const LAUNCH_DECAY = 0.051 * WORLD_PER_SMASH_UNIT; // 0.0051
export const HITSTUN_PER_KB = 0.4;
export const TUMBLE_KB = 80;

export function knockbackFormula(p: number, d: number, w: number, kbg: number, bkb: number): number {
  return ((p / 10 + (p * d) / 20) * (200 / (w + 100)) * 1.4 + 18) * (kbg / 100) + bkb;
}
export function launchSpeedFor(kb: number): number {
  return kb * LAUNCH_SPEED_PER_KB;
}
export function hitstunFor(kb: number): number {
  return Math.floor(kb * HITSTUN_PER_KB);
}
/**
 * Horizontal / vertical displacement contributed by the launch velocity alone over `frames`
 * frames (default: the hitstun), with per-frame decay. Position integrates AFTER decay:
 *   frame k: v_k = max(0, v0 - k*LAUNCH_DECAY) ; pos += v_k * dir   (k = 1..frames)
 * (Matches the sim's integration order: decay, then move.)
 */
export function launchDisplacement(kb: number, angleDeg: number, frames = hitstunFor(kb)): { dx: number; dy: number } {
  const v0 = launchSpeedFor(kb);
  const a = (angleDeg * Math.PI) / 180;
  let dist = 0;
  for (let k = 1; k <= frames; k++) dist += Math.max(0, v0 - k * LAUNCH_DECAY);
  return { dx: Math.cos(a) * dist, dy: Math.sin(a) * dist };
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Per-frame input for one fighter (from a phone via SmashGame, or from a CpuController).
 * Held booleans + one-frame press EDGES. The sim buffers presses for INPUT_BUFFER_FRAMES.
 *
 * Semantics the sim implements (and AI / bots rely on):
 * - stick |x| > 0.25 walk (speed ∝ |x|), |x| > 0.75 run/dash. y < -0.6 on ground = crouch;
 *   on a pass-through platform, y < -0.7 (a fresh push down) = drop through.
 *   In the air, pushing y < -0.6 while falling = fast fall.
 * - jumpPressed: ground -> jump (3-frame squat; released before squat ends = short hop);
 *   air -> double jump (1 per airtime). Tap-jump is done on the PHONE (it presses jump).
 * - attackPressed (ground): flick=true and |stick|>0.6 -> SMASH attack in the stick direction
 *   (f/u/d smash; hold `attack` to charge up to 60 frames, ×1.4 damage at full charge).
 *   Else stick neutral -> jab (press again during the jab -> jab2 -> jab3); running -> dash attack;
 *   |x| > 0.4 -> forward tilt (turns to face); y > 0.5 -> up tilt; y < -0.5 -> down tilt.
 *   Standing on/next to an item while not holding one -> picks it up instead.
 *   Holding an item: bat -> swing (fsmash-like), others -> throw in stick direction.
 * - attackPressed (air): neutral -> nair; toward facing -> fair; away -> bair; up -> uair; down -> dair.
 * - specialPressed: neutral / side (turns) / up (recovery, then 'helpless' until landing or
 *   ledge grab) / down special. With final-smash power -> final smash instead.
 * - shield held (ground) -> shield. While shielding: stick |x| > 0.6 -> roll that way;
 *   y < -0.6 -> spot dodge; jumpPressed -> jump out of shield; attackPressed or grabPressed -> grab.
 * - shieldPressed (air) -> air dodge in the stick direction (once per airtime, then 'helpless'-free fall).
 * - grabPressed (ground) -> grab; holding an item -> throw it.
 *   While holding someone: attackPressed -> pummel; stick direction -> f/b/u/d throw (auto fthrow after 90 f).
 * - Ledge hang: jumpPressed -> ledge jump; up or toward stage -> climb; attackPressed -> ledge attack;
 *   shieldPressed -> ledge roll; down or away -> let go. Auto let-go after 300 f.
 */
export interface SimInput {
  x: number; // -1..1
  y: number; // -1..1, up positive
  attack: boolean;
  special: boolean;
  jump: boolean;
  shield: boolean;
  grab: boolean;
  /** Stick flicked recently (smash-attack modifier). */
  flick: boolean;
  attackPressed: boolean;
  specialPressed: boolean;
  jumpPressed: boolean;
  shieldPressed: boolean;
  grabPressed: boolean;
}

export function emptySimInput(): SimInput {
  return {
    x: 0,
    y: 0,
    attack: false,
    special: false,
    jump: false,
    shield: false,
    grab: false,
    flick: false,
    attackPressed: false,
    specialPressed: false,
    jumpPressed: false,
    shieldPressed: false,
    grabPressed: false,
  };
}

// ---------------------------------------------------------------------------
// Fighter state (read-only views for renderer / AI / HUD / tests)
// ---------------------------------------------------------------------------

export type ActionState =
  | 'idle'
  | 'walk'
  | 'run'
  | 'turn'
  | 'crouch'
  | 'jumpSquat'
  | 'jump'
  | 'doubleJump'
  | 'fall'
  | 'land' // landing lag (normal or aerial landing lag)
  | 'attack' // any move: see FighterView.move
  | 'shield'
  | 'shieldStun'
  | 'shieldBreak' // popped upward
  | 'dizzy' // after shield break, stunned on the ground
  | 'roll'
  | 'spotDodge'
  | 'airDodge'
  | 'ledgeHang'
  | 'ledgeClimb'
  | 'grabHold' // holding an opponent
  | 'grabbed' // being held
  | 'thrown'
  | 'hitstun' // light hitstun (flinch)
  | 'tumble' // launched (kb > TUMBLE_KB), tumbling through the air
  | 'helpless' // after up special / air dodge: falling, can't act until landing/ledge
  | 'knockdown' // lying on the ground after a tumble landing
  | 'getUp'
  | 'respawn' // standing on the respawn platform
  | 'ko' // off-screen / waiting to respawn (not rendered)
  | 'out' // no stocks left (not rendered)
  | 'victory'
  | 'defeat';

export type MoveId =
  | 'jab1'
  | 'jab2'
  | 'jab3'
  | 'dashAttack'
  | 'ftilt'
  | 'utilt'
  | 'dtilt'
  | 'fsmash'
  | 'usmash'
  | 'dsmash'
  | 'nair'
  | 'fair'
  | 'bair'
  | 'uair'
  | 'dair'
  | 'nspecial'
  | 'sspecial'
  | 'uspecial'
  | 'dspecial'
  | 'grab'
  | 'pummel'
  | 'fthrow'
  | 'bthrow'
  | 'uthrow'
  | 'dthrow'
  | 'getupAttack'
  | 'ledgeAttack'
  | 'itemSwing' // bat swing
  | 'itemThrow'
  | 'finalSmash';

export type MovePhase = 'startup' | 'active' | 'endlag' | 'charge';

export type Archetype = 'allrounder' | 'bruiser' | 'speedster' | 'sword' | 'zoner' | 'trickster';

export interface FighterView {
  index: number;
  characterId: string;
  name: string;
  /** CSS colour (player slot colour for humans, character colour for CPUs). */
  color: string;
  /** Lobby slot for humans, -1 for CPUs / dummy. */
  slot: number;
  team: number;
  /** Currently CPU-controlled (CPU fighter, or a human's fighter handed to the AI). */
  cpu: boolean;
  /** The sandbox training dummy. */
  dummy: boolean;

  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: 1 | -1;
  grounded: boolean;

  action: ActionState;
  /** Frames since the current action started. */
  actionFrame: number;
  move: MoveId | null;
  /** Frames since the move started (1-based while in the move). */
  moveFrame: number;
  /** Total frames of the move (startup + active + endlag; charge frames excluded). */
  moveTotal: number;
  movePhase: MovePhase | null;
  /** Smash charge 0..1. */
  charge: number;

  damage: number;
  /** Stocks left (stock mode) — time mode: Infinity-ish, use score. */
  stocks: number;
  kos: number;
  falls: number;
  sds: number;
  damageDealt: number;
  damageTaken: number;
  score: number;

  /** Shield health 0..1 (bubble size); shielding = shield is up right now. */
  shield: number;
  shielding: boolean;
  /** Intangible / invincible right now (respawn, ledge, dodges, final smash). */
  invincible: boolean;
  /** Remaining hitlag (freeze) frames — renderer shakes the model while > 0. */
  hitlag: number;
  /** In tumble with launch speed (world/frame) — renderer draws smoke trail while > ~0.08. */
  launchSpeed: number;
  heldItem: ItemKind | null;
  /** Hanging side when on a ledge: -1 left ledge, 1 right ledge, 0 none. */
  ledge: -1 | 0 | 1;
  jumpsLeft: number;
  /** Has final-smash power (orb broken), glowing. */
  powered: boolean;
  out: boolean;
  /** KO'd and waiting / on the respawn platform. */
  respawning: boolean;
  /** Collision box size (camera framing, magnifier). */
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Items & projectiles
// ---------------------------------------------------------------------------

export type ItemKind = 'bat' | 'bomb' | 'food' | 'capsule' | 'orb';

export interface ItemView {
  id: number;
  kind: ItemKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Radians, for spinning throws. */
  rot: number;
  /** Fighter index holding it, or -1. */
  holder: number;
  /** Bomb: lit fuse (thrown / armed). */
  armed: boolean;
  /** Frames left before despawn (blinks when < 120). */
  life: number;
  /** Orb: hits left before it breaks. */
  hp?: number;
}

export interface ProjectileView {
  id: number;
  owner: number;
  /** Free-form visual kind chosen by the fighter's special (e.g. 'bolt', 'orb', 'wave', 'gum', 'rock', 'spark'). */
  kind: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  /** CSS colour. */
  color: string;
  life: number;
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

export interface PlatformDef {
  id: string;
  /** Centre x and TOP surface y. */
  x: number;
  y: number;
  w: number;
  /** Visual thickness below the top surface (solid stages are deep). */
  h: number;
  /** Solid = can't be passed through from below or dropped through (main stage). */
  solid: boolean;
  /** Grabbable ledges at both ends (solid main stage only). */
  ledges: boolean;
  /** Moving platform: oscillates between (x,y) and (x+dx, y+dy) with this period (frames). */
  path?: { dx: number; dy: number; period: number };
}

export interface StageDef {
  id: string;
  name: string;
  tagline: string;
  platforms: PlatformDef[];
  /** Blast zones: crossing these = KO. */
  blast: { left: number; right: number; top: number; bottom: number };
  /** The camera never shows beyond these. */
  camera: { left: number; right: number; top: number; bottom: number };
  /** Start positions (feet). */
  spawns: { x: number; y: number }[];
  /** Respawn platform position (feet). */
  respawn: { x: number; y: number };
  /** Optional hazard (toggleable via setup.hazards). */
  hazard?: 'lava' | null;
  /** Training stage for the sandbox. */
  training?: boolean;
  /** Visual theme key for the renderer (background, palette, music). */
  theme: 'sky' | 'arena' | 'forge' | 'training';
}

/** Moving platforms / hazard state each frame. */
export interface StageView {
  /** Current top-surface centre of each platform (same order as StageDef.platforms). */
  platforms: { x: number; y: number }[];
  /** Lava hazard: 0 = calm, warning 0..1 before an eruption, `active` while it hurts. */
  hazard: { warning: number; active: boolean; x: number; w: number } | null;
}

// ---------------------------------------------------------------------------
// Events (drained by the host each step: sound, hit sparks, shake, phone haptics)
// ---------------------------------------------------------------------------

export type HitKind = 'normal' | 'sword' | 'electric' | 'fire' | 'water' | 'bat' | 'explosion' | 'projectile' | 'throw';

export type SimEvent =
  | {
      type: 'hit';
      attacker: number; // -1 = stage hazard / item without owner
      victim: number;
      damage: number;
      kb: number;
      angle: number; // degrees, world space (already mirrored by facing)
      x: number;
      y: number;
      /** 0..1 perceived strength (for sound / shake / haptics). */
      strength: number;
      kind: HitKind;
      shielded: boolean;
      move: MoveId | null;
    }
  | { type: 'ko'; victim: number; by: number; x: number; y: number; side: 'left' | 'right' | 'top' | 'bottom' }
  | { type: 'out'; fighter: number }
  | { type: 'respawn'; fighter: number }
  | { type: 'shieldBreak'; fighter: number }
  | { type: 'ledgeGrab'; fighter: number }
  | { type: 'jump'; fighter: number; double: boolean }
  | { type: 'land'; fighter: number; hard: boolean }
  | { type: 'swing'; fighter: number; move: MoveId; strength: number } // whoosh when a move's hitbox comes out
  | { type: 'special'; fighter: number; move: MoveId }
  | { type: 'dodge'; fighter: number }
  | { type: 'grab'; fighter: number; victim: number }
  | { type: 'throw'; fighter: number; victim: number; move: MoveId }
  | { type: 'itemSpawn'; item: number; kind: ItemKind; x: number; y: number }
  | { type: 'itemPickup'; fighter: number; kind: ItemKind }
  | { type: 'itemThrow'; fighter: number; kind: ItemKind }
  | { type: 'heal'; fighter: number; amount: number }
  | { type: 'explosion'; x: number; y: number; r: number }
  | { type: 'capsuleOpen'; x: number; y: number; kind: ItemKind }
  | { type: 'powerUp'; fighter: number } // broke the orb
  | { type: 'finalSmash'; fighter: number }
  | { type: 'hazardWarning'; x: number }
  | { type: 'hazardErupt'; x: number }
  | { type: 'timeWarning'; secondsLeft: number }
  | { type: 'suddenDeath' }
  | { type: 'gameSet'; winner: number; winnerTeam: number };

// ---------------------------------------------------------------------------
// Debug overlay (hitboxes / hurtboxes), world space
// ---------------------------------------------------------------------------

export interface DebugShape {
  fighter: number;
  kind: 'hit' | 'hurt' | 'grab' | 'shield' | 'ledge';
  /** Circle centre (or capsule start). */
  x: number;
  y: number;
  r: number;
  /** Capsule end (hurtboxes). */
  x2?: number;
  y2?: number;
  /** Intangible / invincible hurtbox (drawn differently). */
  intangible?: boolean;
}

// ---------------------------------------------------------------------------
// Simulation config + API (implemented by src/games/smash/sim/SmashSim.ts)
// ---------------------------------------------------------------------------

export interface SimFighterConfig {
  characterId: string;
  name: string;
  color: string;
  slot: number; // -1 for CPUs
  team: number;
  /** null = human (input from setInput), 1..9 = CPU level. */
  cpuLevel: number | null;
  /** Sandbox training dummy (never acts, never loses stocks, % resets with button). */
  dummy?: boolean;
}

export interface SimRules {
  mode: 'stock' | 'time';
  stocks: number;
  timeSec: number;
  teams: boolean;
  friendlyFire: boolean;
  items: boolean;
  itemFrequency: 'low' | 'medium' | 'high';
  hazards: boolean;
}

export interface SimConfig {
  stageId: string;
  fighters: SimFighterConfig[];
  rules: SimRules;
  seed: number;
  /** Sandbox: infinite stocks, no timer, no game end, respawn instantly. */
  sandbox?: boolean;
}

export interface SimResultRow {
  fighter: number;
  place: number;
  kos: number;
  falls: number;
  sds: number;
  damageDealt: number;
  damageTaken: number;
  stocksLeft: number;
  score: number;
  team: number;
}

export type SimStatus = 'ready' | 'fighting' | 'gameSet';

export interface ISmashSim {
  readonly config: SimConfig;
  readonly stage: StageDef;
  /** Frames simulated since construction. */
  readonly frame: number;
  /** 'ready' until go(); 'gameSet' once the match is decided (sim keeps animating, no damage). */
  readonly status: SimStatus;
  readonly suddenDeath: boolean;
  /** Seconds left (time mode / sudden death), -1 if untimed. */
  readonly timeLeft: number;
  readonly fighters: readonly FighterView[];
  readonly items: readonly ItemView[];
  readonly projectiles: readonly ProjectileView[];
  readonly stageView: StageView;

  /** Start the fight (after the countdown). */
  go(): void;
  /**
   * Advance one 60 Hz frame. inputs[i] for fighter i (CPU fighters ignore theirs: the sim runs
   * their CpuController internally). Returns the events of this frame.
   */
  step(inputs: readonly SimInput[]): SimEvent[];
  /** null = human-controlled, 1..9 = CPU-controlled (disconnect handover / autopilot). */
  setCpu(fighter: number, level: number | null): void;
  /** Remove a fighter from play (sandbox "I'm ready"): it disappears, no stock change. */
  retire(fighter: number): void;
  /** Final standings (valid any time; ordered by place). */
  results(): SimResultRow[];
  /** Winner fighter index (-1 = none yet) and team (-1 in FFA). */
  readonly winner: { fighter: number; team: number };
  debugShapes(): DebugShape[];

  // ----- test / debug helpers (also used by window.__smash) -----
  setDamage(fighter: number, pct: number): void;
  /** Force a blast-zone KO of this fighter now. */
  forceKO(fighter: number): void;
  spawnItem(kind: ItemKind, x?: number, y?: number): number;
  giveItem(fighter: number, kind: ItemKind): void;
  /** Decide the match now (stock: most stocks/least damage wins; time: highest score). */
  forceGameSet(): void;
}

// ---------------------------------------------------------------------------
// Roster & stage catalogue (implemented by src/games/smash/roster.ts and stages.ts — pure data,
// three.js-free, imported by the phone too). Fighters reuse the Kart Party roster ids, names and
// colours (src/kart/roster.ts → getCharacter(id).name / .color / .accent / .tagline).
// ---------------------------------------------------------------------------

export interface MoveInfo {
  name: string;
  desc: string;
}

export interface FighterDef {
  /** Kart roster id ('zippy', 'pixel', 'fennec', 'max', 'juno', 'kai', 'bram', 'rosa'). */
  id: string;
  archetype: Archetype;
  /** e.g. 'ALL-ROUNDER', 'HEAVY BRUISER', 'SPEEDY COMBO', 'SWORD / REACH', 'PROJECTILE ZONER', 'TRICKSTER'. */
  archetypeLabel: string;
  /** 1..5 bars for character-select UI. */
  bars: { power: number; speed: number; weight: number; jump: number; range: number };
  /** Knockback-formula weight (~70 light .. ~125 heavy, 100 = medium). */
  weight: number;
  walkSpeed: number; // world units / frame
  runSpeed: number;
  airSpeed: number; // max horizontal air speed
  airAccel: number;
  gravity: number; // world units / frame^2
  fallSpeed: number; // terminal fall speed
  fastFallSpeed: number;
  jumpVel: number; // full hop initial vy
  shortHopVel: number;
  doubleJumpVel: number;
  /** Hurtbox size. */
  height: number;
  width: number;
  specials: { neutral: MoveInfo; side: MoveInfo; up: MoveInfo; down: MoveInfo };
  finalSmash: MoveInfo;
  /** One-line play-style hint for the phone ("Mash A, then finish with a smash!"). */
  tip: string;
  /** False = rougher placeholder kit (documented in the README). */
  polished: boolean;
}

/** Stage ids: 'skyline' (main + 3 floating platforms), 'arena' (flat), 'forge' (moving platforms + lava, toggleable), 'training'. */
export type StageId = 'skyline' | 'arena' | 'forge' | 'training';
