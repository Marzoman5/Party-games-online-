/**
 * Physical / archetype facts the CPU needs about a fighter (recovery reach, reach bonus, weight).
 * Derived from the roster's FighterDef, with safe fallbacks. Up-special reach comes from
 * measurements of the sim (see dev/aiSoak.ts --measure), overridable per character.
 */
import type { Archetype, FighterView } from '../../types';
import { FIGHTERS } from '../../roster';
import { upBFor } from './moveinfo';

export interface AiPhys {
  archetype: Archetype;
  weight: number;
  /** Height gained by a double jump. */
  djHeight: number;
  /** Vertical / horizontal distance an up-special covers. */
  upBHeight: number;
  upBDist: number;
  /** Extra horizontal reach of normals (sword > others). */
  reach: number;
  runSpeed: number;
  gravity: number;
  /** Up-special is a teleport of this distance (0 = not). */
  upBTeleport: number;
}

/** Measured up-special reach per character (world units): [height, horizontal]. */
export const UPB_REACH: Record<string, [number, number]> = {};

const cache = new Map<string, AiPhys>();

export function physFor(characterId: string, _v?: FighterView): AiPhys {
  let p = cache.get(characterId);
  if (p) return p;
  const def = FIGHTERS.find((f) => f.id === characterId);
  p = { archetype: 'allrounder', weight: 100, djHeight: 2.2, upBHeight: 3.2, upBDist: 1.8, reach: 0, runSpeed: 0.17, gravity: 0.009, upBTeleport: 0 };
  if (def) {
    p.archetype = def.archetype;
    p.weight = def.weight > 0 ? def.weight : 100;
    const g = def.gravity > 0 ? def.gravity : 0.009;
    const h = (def.doubleJumpVel * def.doubleJumpVel) / (2 * g);
    if (Number.isFinite(h) && h > 0) p.djHeight = h;
    if (def.runSpeed > 0) p.runSpeed = def.runSpeed;
    if (def.gravity > 0) p.gravity = def.gravity;
    const u = upBFor(def.id);
    p.upBHeight = u.height;
    p.upBDist = u.dist;
    p.upBTeleport = u.teleport;
    p.reach = def.archetype === 'sword' ? 0.6 : def.archetype === 'bruiser' ? 0.15 : 0;
  }
  const m = UPB_REACH[characterId];
  if (m) {
    p.upBHeight = m[0];
    p.upBDist = m[1];
  }
  cache.set(characterId, p);
  return p;
}
