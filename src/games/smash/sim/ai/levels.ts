/** Per-level CPU tuning (levels 1..9). */
export interface LevelParams {
  level: number;
  /** Frames before the CPU notices an opponent's move / position change. */
  react: number;
  /** Frames between neutral decisions (move choice). */
  decideEvery: number;
  /** Minimum frames between two attacks it starts. */
  attackCooldown: number;
  /** 0..1: chance to attack when something is in range at a decision. */
  attackRate: number;
  /** 0..1: chance to pick the situation-appropriate move instead of a random one. */
  accuracy: number;
  /** 0..1: approach vs. hang back. */
  aggression: number;
  /** 0..1: chance to stand around at a decision tick. */
  idle: number;
  /** 0..1: chance to shield / dodge an attack it noticed. */
  defend: number;
  /** 0..1: recovery execution quality (low = may waste jump / up-special too early). */
  recover: number;
  /** 0..1: desire to go for items. */
  items: number;
  /** 0..1: ground-movement speed scale (low levels walk). */
  moveSpeed: number;
  shortHop: boolean;
  combos: boolean;
  edgeguard: boolean;
  /** Frames to mash out of grabs (interval between mash inputs). */
  mashEvery: number;
}

const T = (lvl: number) => (lvl - 1) / 8;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function levelParams(levelIn: number): LevelParams {
  const level = Math.max(1, Math.min(9, Math.round(Number.isFinite(levelIn) ? levelIn : 5)));
  const t = T(level);
  const reactTable = [0, 34, 28, 22, 17, 13, 10, 7, 4, 3];
  const decideTable = [0, 26, 20, 15, 11, 8, 6, 4, 3, 2];
  return {
    level,
    react: reactTable[level],
    decideEvery: decideTable[level],
    attackCooldown: Math.round(lerp(50, 4, t)),
    attackRate: lerp(0.3, 0.97, t),
    accuracy: lerp(0.25, 0.97, t),
    aggression: lerp(0.3, 0.95, t),
    idle: level <= 2 ? 0.35 - (level - 1) * 0.12 : Math.max(0, 0.12 - t * 0.15),
    defend: level <= 1 ? 0 : level === 2 ? 0.05 : lerp(0.1, 0.6, (level - 3) / 6),
    recover: level <= 1 ? 0.55 : level === 2 ? 0.75 : lerp(0.9, 1, (level - 3) / 6),
    items: lerp(0.35, 0.85, t),
    moveSpeed: level <= 2 ? 0.55 + 0.15 * (level - 1) : 1,
    shortHop: level >= 5,
    combos: level >= 6,
    edgeguard: level >= 7,
    mashEvery: Math.round(lerp(10, 2, t)),
  };
}
