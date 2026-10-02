/**
 * Smash Party setup rules for the hub: sanitising the leader's `gsetup` patches and turning the
 * seated players + `SmashSetup` into a `SmashMatchConfig` (CPU fill, CPU characters, teams).
 * Pure functions (no DOM), unit-testable.
 */
import { DEFAULT_SMASH_SETUP, type SmashSetup } from '../../../net/protocol';
import { CHARACTERS, getCharacter } from '../../../kart/roster';
import type { MatchSeat } from '../../../engine/GameModule';
import type { SmashCpu, SmashHuman, SmashMatchConfig } from '../api';
import { FIGHTERS } from '../roster';
import { PICKABLE_STAGES } from '../stages';

export const MAX_FIGHTERS = 4;

/** Stage ids the leader may pick (training is sandbox-only). */
export function pickableStageIds(): string[] {
  return PICKABLE_STAGES.map((s) => s.id);
}

const clampInt = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : null;

/** Apply a partial (untrusted) patch to `cur`; invalid fields are ignored. */
export function sanitiseSmashSetup(cur: SmashSetup, patch: unknown): SmashSetup {
  const next: SmashSetup = { ...cur };
  if (!patch || typeof patch !== 'object') return next;
  const p = patch as Record<string, unknown>;
  if (typeof p.stageId === 'string' && pickableStageIds().includes(p.stageId)) next.stageId = p.stageId;
  if (p.mode === 'stock' || p.mode === 'time') next.mode = p.mode;
  const stocks = clampInt(p.stocks, 1, 5);
  if (stocks !== null) next.stocks = stocks;
  const time = clampInt(p.timeSec, 60, 300);
  if (time !== null) next.timeSec = Math.round(time / 30) * 30;
  if (typeof p.teams === 'boolean') next.teams = p.teams;
  if (typeof p.friendlyFire === 'boolean') next.friendlyFire = p.friendlyFire;
  const fill = clampInt(p.fillCpus, 0, MAX_FIGHTERS);
  if (fill !== null) next.fillCpus = fill;
  const lvl = clampInt(p.cpuLevel, 1, 9);
  if (lvl !== null) next.cpuLevel = lvl;
  if (typeof p.items === 'boolean') next.items = p.items;
  if (p.itemFrequency === 'low' || p.itemFrequency === 'medium' || p.itemFrequency === 'high') next.itemFrequency = p.itemFrequency;
  if (typeof p.hazards === 'boolean') next.hazards = p.hazards;
  return next;
}

export function defaultSmashSetup(): SmashSetup {
  const s = { ...DEFAULT_SMASH_SETUP };
  if (!pickableStageIds().includes(s.stageId)) s.stageId = pickableStageIds()[0] ?? s.stageId;
  return s;
}

export function hexColor(n: number): string {
  return '#' + ((n >>> 0) & 0xffffff).toString(16).padStart(6, '0');
}

/** Roster ids usable as fighters (smash roster, falling back to the shared kart roster). */
function rosterIds(): string[] {
  const ids = FIGHTERS.map((f) => f.id);
  return ids.length ? ids : CHARACTERS.map((c) => c.id);
}

export interface PlannedMatch {
  config: SmashMatchConfig;
  /** Human-readable notes (auto-added CPU, team fix…) for a toast. */
  notes: string[];
}

/**
 * Build the match config.
 * - CPU fill: humans + CPUs up to `fillCpus` total fighters (max 4). A lone human always gets
 *   one CPU opponent (a 1-fighter match would end instantly).
 * - CPU characters: roster characters nobody is playing, in roster order rotated by `seed`.
 * - Teams: humans keep their chosen team; each CPU joins the smaller team; if everyone still
 *   ends up on one team, the last human switches sides.
 */
export function planMatch(setup: SmashSetup, seats: MatchSeat[], seed: number): PlannedMatch {
  const notes: string[] = [];
  const humans: SmashHuman[] = seats.slice(0, MAX_FIGHTERS).map((s, i) => ({
    playerId: s.playerId,
    name: s.name,
    characterId: s.characterId,
    color: s.color,
    slot: s.slot,
    team: setup.teams ? (s.team === 1 ? 1 : 0) : i,
  }));
  let total = Math.max(humans.length, Math.min(MAX_FIGHTERS, setup.fillCpus));
  if (total < 2) {
    total = 2;
    notes.push('Added a CPU opponent — you can’t smash alone!');
  }
  const used = new Set(humans.map((h) => h.characterId));
  const ids = rosterIds();
  const rot = ids.length ? Math.abs(Math.floor(seed)) % ids.length : 0;
  const free = [...ids.slice(rot), ...ids.slice(0, rot)].filter((id) => !used.has(id));
  const cpus: SmashCpu[] = [];
  for (let i = humans.length; i < total; i++) {
    const characterId = free.shift() ?? ids[i % ids.length];
    const c = getCharacter(characterId);
    cpus.push({ characterId, name: c.name, color: hexColor(c.color), level: setup.cpuLevel, team: i });
  }
  if (setup.teams) {
    const count = [0, 0];
    for (const h of humans) count[h.team]++;
    for (const c of cpus) {
      c.team = count[0] <= count[1] ? 0 : 1;
      count[c.team]++;
    }
    if ((count[0] === 0 || count[1] === 0) && humans.length > 1) {
      const last = humans[humans.length - 1];
      count[last.team]--;
      last.team = last.team === 1 ? 0 : 1;
      count[last.team]++;
      notes.push(`${last.name} switched to the ${last.team === 1 ? 'BLUE' : 'RED'} team so both teams have players`);
    }
  }
  return { config: { setup: { ...setup }, humans, cpus, intro: true, seed }, notes };
}
