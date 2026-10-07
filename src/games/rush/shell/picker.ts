/**
 * SHELL — the minigame picker: a shuffle bag of the enabled minigames (every game once before any
 * repeats, never the same game twice in a row), skipping games whose `meta.minPlayers` isn't met.
 * Every full bag pass raises the heat by one (capped by the max-heat setting).
 */
import { minigameById } from '../minigames/index';

export interface PickerSnap {
  bag: string[];
  passes: number;
  last: string;
  filled: boolean;
}

export class Picker {
  bag: string[] = [];
  /** Completed bag passes (heat = 1 + passes, capped). */
  passes = 0;
  /** Last minigame actually started. */
  last = '';
  private filled = false;

  constructor(private readonly rand: () => number = Math.random) {}

  /** The minigame `take()` would return now (no side effects). */
  peek(enabled: readonly string[], players: number): string | null {
    const saved = this.snap();
    const r = this.take(enabled, players);
    this.load(saved);
    return r ? r.id : null;
  }

  /** Take the next minigame from the bag. `newPass` = the bag was refilled after a full pass (heat up). */
  take(enabled: readonly string[], players: number): { id: string; newPass: boolean } | null {
    const ok = (id: string): boolean => {
      const d = minigameById(id);
      return !!d && d.meta.minPlayers <= Math.max(1, players);
    };
    const eligibleAll = enabled.filter(ok);
    if (!eligibleAll.length) return null;
    const onlyOne = eligibleAll.length === 1;
    this.bag = this.bag.filter((id) => enabled.includes(id));
    let newPass = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const idx = this.bag.findIndex((id) => ok(id) && (onlyOne || id !== this.last));
      if (idx >= 0) {
        const [id] = this.bag.splice(idx, 1);
        return { id, newPass };
      }
      // Bag exhausted (or only ineligible / just-played games left): refill = one full pass done.
      if (this.filled) {
        this.passes++;
        newPass = true;
      }
      this.filled = true;
      this.bag = shuffle([...enabled], this.rand);
      if (this.bag.length > 1 && this.bag[0] === this.last) {
        const j = 1 + Math.floor(this.rand() * (this.bag.length - 1));
        [this.bag[0], this.bag[j]] = [this.bag[j], this.bag[0]];
      }
    }
    return { id: eligibleAll[0], newPass };
  }

  snap(): PickerSnap {
    return { bag: [...this.bag], passes: this.passes, last: this.last, filled: this.filled };
  }

  load(s: PickerSnap): void {
    this.bag = [...s.bag];
    this.passes = s.passes;
    this.last = s.last;
    this.filled = s.filled;
  }

  /** Validate an untrusted snapshot. */
  restore(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const r = raw as Record<string, unknown>;
    if (Array.isArray(r.bag)) this.bag = r.bag.filter((x): x is string => typeof x === 'string' && !!minigameById(x)).slice(0, 64);
    if (typeof r.passes === 'number' && Number.isFinite(r.passes)) this.passes = Math.max(0, Math.min(1000, Math.floor(r.passes)));
    if (typeof r.last === 'string' && minigameById(r.last)) this.last = r.last;
    if (typeof r.filled === 'boolean') this.filled = r.filled;
  }

  reset(): void {
    this.bag = [];
    this.passes = 0;
    this.last = '';
    this.filled = false;
  }
}

export function shuffle<T>(a: T[], rand: () => number): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
