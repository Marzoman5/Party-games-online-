/**
 * Grand Prix bookkeeping: 4 races (the TRACKS in order), points 15/12/10/8/6/4/2/1.
 * Racers are keyed by identity so totals survive across races: humans by playerId,
 * AI racers by name (the engine fills AI seats with the remaining roster).
 */
import type { ResultRow } from '../net/protocol';
import { GP_POINTS } from './config';

export interface GpEntry {
  key: string;
  name: string;
  characterId: string;
  color: string;
  slot: number;
}

export class GrandPrix {
  /** 1-based index of the current/last race. */
  race = 1;
  readonly of: number;
  /** Points per race index (0-based) per racer key. Replaying a race overwrites its entry. */
  private readonly perRace: Map<string, number>[] = [];
  private readonly entries = new Map<string, GpEntry>();

  constructor(of: number) {
    this.of = of;
  }

  get isFinalRace(): boolean {
    return this.race >= this.of;
  }

  static pointsFor(place: number): number {
    return GP_POINTS[place - 1] ?? 0;
  }

  /** Record the result of race `this.race`; returns rows annotated with points + totals. */
  record(rows: ResultRow[], keys: string[]): ResultRow[] {
    const pts = new Map<string, number>();
    rows.forEach((r, i) => {
      const key = keys[i];
      pts.set(key, GrandPrix.pointsFor(r.place));
      this.entries.set(key, { key, name: r.name, characterId: r.characterId, color: r.color, slot: r.slot });
    });
    this.perRace[this.race - 1] = pts;
    return rows.map((r, i) => ({ ...r, points: pts.get(keys[i]) ?? 0, total: this.total(keys[i]) }));
  }

  total(key: string): number {
    let t = 0;
    for (const m of this.perRace) if (m) t += m.get(key) ?? 0;
    return t;
  }

  /** Overall standings, best first (ties broken by the latest race result). */
  standings(): (GpEntry & { total: number; place: number; perRace: number[] })[] {
    const last = this.perRace[this.race - 1];
    const list = Array.from(this.entries.values()).map((e) => ({
      ...e,
      total: this.total(e.key),
      place: 0,
      perRace: Array.from({ length: this.of }, (_, i) => this.perRace[i]?.get(e.key) ?? -1),
    }));
    list.sort((a, b) => b.total - a.total || (last?.get(b.key) ?? 0) - (last?.get(a.key) ?? 0));
    let place = 0;
    list.forEach((e, i) => {
      if (i === 0 || e.total !== list[i - 1].total) place = i + 1;
      e.place = place;
    });
    return list;
  }
}
