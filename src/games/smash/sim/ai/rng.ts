/** Tiny deterministic PRNG (mulberry32). Never use Math.random in the AI. */
export class AiRng {
  private s: number;
  constructor(seed: number) {
    this.s = (Math.floor(Number.isFinite(seed) ? seed : 1) ^ 0x9e3779b9) >>> 0;
    if (this.s === 0) this.s = 0x1234567;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** true with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** Integer in [a, b]. */
  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }
  range(a: number, b: number): number {
    return a + this.next() * (b - a);
  }
  /** Pick an index from non-negative weights (returns -1 if all zero). */
  weighted(w: readonly number[]): number {
    let sum = 0;
    for (const v of w) sum += v > 0 ? v : 0;
    if (sum <= 0) return -1;
    let r = this.next() * sum;
    for (let i = 0; i < w.length; i++) {
      const v = w[i] > 0 ? w[i] : 0;
      if (r < v) return i;
      r -= v;
    }
    return w.length - 1;
  }
}
