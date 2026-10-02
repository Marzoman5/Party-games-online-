/**
 * Read-only digest of the sim's move data for the CPU: hitbox reach per move and up-special
 * recovery reach (estimated by integrating the move's velocity keys + gravity).
 */
import { getMoveSet, type MoveDef } from '../moves';
import { FIGHTERS } from '../../roster';

export interface MoveReach {
  key: string;
  first: number; // first active frame
  total: number;
  /** Union of hitboxes relative to the feet, x facing-relative: [x0, x1] × [y0, y1]. */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Individual hit circles (x facing-relative, y from feet). */
  circles: { x: number; y: number; r: number }[];
  dmg: number;
  proj: boolean;
}

export interface UpBInfo {
  height: number;
  dist: number;
  teleport: number; // 0 = not a teleport
}

const reachCache = new Map<string, Map<string, MoveReach>>();
const upbCache = new Map<string, UpBInfo>();

function digest(key: string, md: MoveDef): MoveReach {
  const circles: { x: number; y: number; r: number }[] = [];
  for (const h of md.hits) circles.push({ x: h.x, y: h.y, r: h.r });
  if (md.grab) circles.push({ x: md.grab.x, y: md.grab.y, r: md.grab.r });
  let x0 = 1e9;
  let x1 = -1e9;
  let y0 = 1e9;
  let y1 = -1e9;
  for (const c of circles) {
    x0 = Math.min(x0, c.x - c.r);
    x1 = Math.max(x1, c.x + c.r);
    y0 = Math.min(y0, c.y - c.r);
    y1 = Math.max(y1, c.y + c.r);
  }
  if (circles.length === 0) {
    x0 = x1 = y0 = y1 = 0;
  }
  return {
    key,
    first: Number.isFinite(md.firstActive) && md.firstActive > 0 ? md.firstActive : 5,
    total: md.total > 0 ? md.total : 30,
    x0,
    x1,
    y0,
    y1,
    circles,
    dmg: md.maxDmg || 0,
    proj: !!(md.proj && md.proj.length),
  };
}

export function movesFor(characterId: string): Map<string, MoveReach> {
  let m = reachCache.get(characterId);
  if (m) return m;
  m = new Map();
  try {
    const set = getMoveSet(characterId);
    for (const k of Object.keys(set)) m.set(k, digest(k, set[k]));
  } catch {
    // keep empty: callers fall back to estimates
  }
  reachCache.set(characterId, m);
  return m;
}

/** Estimated up-special reach (vertical gain, horizontal travel) from a standstill in the air. */
export function upBFor(characterId: string): UpBInfo {
  let u = upbCache.get(characterId);
  if (u) return u;
  u = { height: 3.2, dist: 1.8, teleport: 0 };
  try {
    const def = FIGHTERS.find((f) => f.id === characterId);
    const md = getMoveSet(characterId).uspecial;
    if (def && md) {
      const tp = md.teleport ? md.teleport.find((t) => !t.foe && t.dist > 0) : undefined;
      let vy = 0;
      let y = 0;
      let x = 0;
      let maxY = 0;
      let xAtMax = 0;
      const vmax = md.steer ? md.steer * 1.4 : def.airSpeed * 0.5;
      for (let f = 1; f <= md.total; f++) {
        if (md.vel) for (const v of md.vel) if (f >= v.f && f <= (v.until ?? v.f) && v.vy != null) vy = v.vy;
        const gm = md.grav != null && (md.gravUntil == null || f <= md.gravUntil) ? md.grav : 1;
        vy -= def.gravity * gm;
        if (vy < -def.fallSpeed) vy = -def.fallSpeed;
        y += vy;
        x += vmax;
        if (tp && f === tp.f) {
          y += tp.dist;
          vy = 0;
        }
        if (y > maxY) {
          maxY = y;
          xAtMax = x;
        }
      }
      if (tp) u = { height: tp.dist, dist: tp.dist, teleport: tp.dist };
      else if (maxY > 0.5 && Number.isFinite(maxY)) u = { height: maxY, dist: Math.max(1, xAtMax), teleport: 0 };
    }
  } catch {
    // fallback above
  }
  upbCache.set(characterId, u);
  return u;
}
