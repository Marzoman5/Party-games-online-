/**
 * SHELL — round scoring, superlative selection and sip-mode lines (pure, no DOM).
 *
 * Placement points among the N who took part (bots included in N): 1st = N … last = 1, ties share the
 * higher value (competition ranking), +LOOP.firstBonus for every 1st. Away / absent players are filtered
 * out BEFORE ranking, so they score 0 and never show up as losers.
 */
import { SLOT_COLORS } from '../../../net/protocol';
import { LOOP } from '../tuning';
import type { RankEntry } from '../types';

export interface ScoredRow {
  id: string;
  /** Competition rank among the scored rows (1-based, ties share). */
  place: number;
  pts: number;
  stat: string;
}

/**
 * Turn a minigame ranking into points. `keep(id)` decides who is scored (present + active participants).
 * The minigame's place values are only used for ORDER/TIES; places are recomputed among the kept rows.
 */
export function scoreRanking(ranking: readonly RankEntry[], keep: (id: string) => boolean): ScoredRow[] {
  const seen = new Set<string>();
  const rows = ranking
    .filter((r) => r && typeof r.id === 'string' && keep(r.id) && !seen.has(r.id) && (seen.add(r.id), true))
    .map((r) => ({ id: r.id, rawPlace: Number.isFinite(r.place) ? Number(r.place) : 9999, stat: typeof r.stat === 'string' ? r.stat.slice(0, 40) : '' }));
  rows.sort((a, b) => a.rawPlace - b.rawPlace);
  const n = rows.length;
  const out: ScoredRow[] = [];
  rows.forEach((r, i) => {
    const prev = out[i - 1];
    const place = prev && rows[i - 1].rawPlace === r.rawPlace ? prev.place : i + 1;
    const pts = n - place + 1 + (place === 1 ? LOOP.firstBonus : 0);
    out.push({ id: r.id, place, pts, stat: r.stat });
  });
  return out;
}

/** Competition rank of totals (higher better). Returns id → rank (1-based). Zero totals are unranked (0). */
export function boardRanks(items: readonly { id: string; pts: number }[]): Map<string, number> {
  const sorted = [...items].sort((a, b) => b.pts - a.pts);
  const out = new Map<string, number>();
  let prevPts = Number.NaN;
  let prevRank = 0;
  sorted.forEach((it, i) => {
    const rank = it.pts === prevPts ? prevRank : i + 1;
    prevPts = it.pts;
    prevRank = rank;
    out.set(it.id, it.pts > 0 ? rank : 0);
  });
  return out;
}

const FALLBACK_LAST = [
  'Saving energy for the next one 😴',
  'Still warming up 🔥',
  'Fashionably slow 🐌',
  'That was a practice round, right? 😅',
  'Moral victory 🏅',
  'Playing the long game 🧠',
  'Too cool to try 😎',
];

const FALLBACK_MID = ['Solid. Very solid. 👍', 'Quietly dangerous 🕵️', 'Middle of the pack, top of our hearts 💖'];

/**
 * Pick one or two superlatives for the results card: prefer one for last place, then one for someone
 * else (not the winner if possible). Falls back to a generic funny line for last place.
 */
export function pickSuperlatives(
  rows: readonly ScoredRow[],
  given: readonly { id: string; text: string }[] | undefined,
  rand: () => number,
): { id: string; text: string }[] {
  if (rows.length < 2) return [];
  const ids = new Set(rows.map((r) => r.id));
  const valid = (given ?? []).filter((s) => s && ids.has(s.id) && typeof s.text === 'string' && s.text.trim()).map((s) => ({ id: s.id, text: s.text.trim().slice(0, 48) }));
  const last = rows[rows.length - 1];
  const winner = rows[0];
  const out: { id: string; text: string }[] = [];
  const forLast = valid.find((s) => s.id === last.id && last.place !== 1);
  if (forLast) out.push(forLast);
  const other = valid.find((s) => !out.some((o) => o.id === s.id) && s.id !== winner.id) ?? valid.find((s) => !out.some((o) => o.id === s.id));
  if (other) out.push(other);
  if (!out.length && last.place !== 1) out.push({ id: last.id, text: FALLBACK_LAST[Math.floor(rand() * FALLBACK_LAST.length)] });
  if (out.length === 1 && rows.length >= 4 && !valid.length) {
    const mid = rows[Math.floor(rows.length / 2)];
    if (mid.id !== out[0].id && mid.place !== 1) out.push({ id: mid.id, text: FALLBACK_MID[Math.floor(rand() * FALLBACK_MID.length)] });
  }
  return out.slice(0, 2);
}

export const COLOR_NAMES = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'teal', 'pink', 'lime', 'indigo', 'white', 'tan', 'sky blue', 'sand', 'salmon', 'periwinkle'];

export function colorName(color: string): string {
  const i = (SLOT_COLORS as readonly string[]).indexOf(color);
  return i >= 0 ? COLOR_NAMES[i] : 'that colour';
}

export interface SipState {
  /** Results cards with a sip line so far. */
  count: number;
  /** Player id targeted by the previous line ('' = nobody). */
  lastTarget: string;
}

/**
 * One light sip-mode line for a results card. Water round every 4th card; never the same person
 * targeted twice in a row; bots are never targeted.
 */
export function sipLine(
  rows: readonly { id: string; place: number; bot: boolean; name: string; color: string }[],
  st: SipState,
  rand: () => number,
): { text: string; target: string } {
  st.count++;
  if (st.count % 4 === 0 || !rows.some((r) => !r.bot)) {
    st.lastTarget = '';
    return { text: 'Water round — everybody hydrate 💧', target: '' };
  }
  const humans = rows.filter((r) => !r.bot);
  const opts: { text: string; target: string }[] = [];
  const last = rows[rows.length - 1];
  if (last && !last.bot && last.place !== 1 && last.id !== st.lastTarget) opts.push({ text: `Last place takes a sip — or a dare! (${last.name})`, target: last.id });
  const win = rows[0];
  if (win && !win.bot && win.id !== st.lastTarget) opts.push({ text: `Winner ${win.name} picks someone to sip — or dare!`, target: win.id });
  const pool = humans.filter((r) => r.id !== st.lastTarget);
  if (pool.length) {
    const p = pool[Math.floor(rand() * pool.length)];
    opts.push({ text: `Everyone in ${colorName(p.color)} sips — or dares!`, target: p.id });
  }
  if (!opts.length) {
    st.lastTarget = '';
    return { text: 'Water round — everybody hydrate 💧', target: '' };
  }
  const pick = opts[Math.floor(rand() * opts.length)];
  st.lastTarget = pick.target;
  return pick;
}
