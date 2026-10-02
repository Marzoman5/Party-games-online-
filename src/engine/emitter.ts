/** Minimal typed emitter for party-internal signals (session -> UI). */
export class Emitter<E extends Record<string, unknown>> {
  private readonly map = new Map<keyof E, Set<(p: never) => void>>();

  on<K extends keyof E>(name: K, fn: (payload: E[K]) => void): () => void {
    let set = this.map.get(name);
    if (!set) {
      set = new Set();
      this.map.set(name, set);
    }
    set.add(fn as (p: never) => void);
    return () => set!.delete(fn as (p: never) => void);
  }

  emit<K extends keyof E>(name: K, payload: E[K]): void {
    const set = this.map.get(name);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        (fn as (p: E[K]) => void)(payload);
      } catch (err) {
        console.error(`[party] listener for ${String(name)} threw`, err);
      }
    }
  }

  clear(): void {
    this.map.clear();
  }
}
