/**
 * Tilt Maze (MG2) — seeded maze generator. PURE (no DOM).
 *
 * Carves a perfect maze (recursive backtracker) and then braids it (knocks out extra walls) so there are
 * loops, open rooms and several routes. Always solvable by construction (spanning tree ⊂ final graph).
 * Candidates are re-rolled until the shortest start→exit path is inside the heat's length band, so every
 * layout is finishable by a decent player within the cap. Bumpers sit on open 2×2 crossings and inside
 * dead ends (they kick you back out); mud sits on the shortest path (everyone has to wade through it or
 * pick a detour). No holes, nothing that kills.
 */

export const N = 1;
export const E = 2;
export const S = 4;
export const W = 8;
const DIRS = [
  { bit: N, dc: 0, dr: -1, opp: S },
  { bit: E, dc: 1, dr: 0, opp: W },
  { bit: S, dc: 0, dr: 1, opp: N },
  { bit: W, dc: -1, dr: 0, opp: E },
] as const;

export interface Maze {
  cols: number;
  rows: number;
  /** open[r][c] = bitmask of open sides (N/E/S/W). The exit cell also has E open (to the outside). */
  open: number[][];
  start: { c: number; r: number };
  exit: { c: number; r: number };
  /** BFS steps from each cell to the exit cell. */
  dist: number[][];
  /** For each cell: the neighbour one step closer to the exit (exit cell → outside, c = cols). */
  next: { c: number; r: number }[][];
  /** Bumper centres in cell units (x = column coordinate, y = row coordinate). */
  bumpers: { x: number; y: number }[];
  /** Mud cells. */
  mud: { c: number; r: number }[];
  pathLen: number;
}

export interface MazeOpts {
  cols: number;
  rows: number;
  braid: number;
  pathLen: readonly [number, number] | readonly number[];
  bumpers: number;
  mud: number;
}

function carve(rand: () => number, cols: number, rows: number, braid: number, startR: number): number[][] {
  const open = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  const seen = Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));
  const stack: [number, number][] = [[0, startR]];
  seen[startR][0] = true;
  while (stack.length) {
    const [c, r] = stack[stack.length - 1];
    const opts = DIRS.filter((d) => {
      const nc = c + d.dc;
      const nr = r + d.dr;
      return nc >= 0 && nr >= 0 && nc < cols && nr < rows && !seen[nr][nc];
    });
    if (!opts.length) {
      stack.pop();
      continue;
    }
    const d = opts[Math.floor(rand() * opts.length)];
    const nc = c + d.dc;
    const nr = r + d.dr;
    open[r][c] |= d.bit;
    open[nr][nc] |= d.opp;
    seen[nr][nc] = true;
    stack.push([nc, nr]);
  }
  // braid: most dead ends get a second exit, then a few random walls go
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const deg = DIRS.filter((d) => open[r][c] & d.bit).length;
      if (deg === 1 && rand() < 0.3) {
        const opts = DIRS.filter((d) => {
          const nc = c + d.dc;
          const nr = r + d.dr;
          return !(open[r][c] & d.bit) && nc >= 0 && nr >= 0 && nc < cols && nr < rows;
        });
        if (opts.length) {
          const d = opts[Math.floor(rand() * opts.length)];
          open[r][c] |= d.bit;
          open[r + d.dr][c + d.dc] |= d.opp;
        }
      }
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      for (const d of [DIRS[1], DIRS[2]]) {
        const nc = c + d.dc;
        const nr = r + d.dr;
        if (nc >= cols || nr >= rows || open[r][c] & d.bit) continue;
        if (rand() < braid) {
          open[r][c] |= d.bit;
          open[nr][nc] |= d.opp;
        }
      }
    }
  }
  return open;
}

function bfs(open: number[][], cols: number, rows: number, exit: { c: number; r: number }): number[][] {
  const dist = Array.from({ length: rows }, () => new Array<number>(cols).fill(-1));
  dist[exit.r][exit.c] = 0;
  const q: [number, number][] = [[exit.c, exit.r]];
  for (let i = 0; i < q.length; i++) {
    const [c, r] = q[i];
    for (const d of DIRS) {
      if (!(open[r][c] & d.bit)) continue;
      const nc = c + d.dc;
      const nr = r + d.dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows || dist[nr][nc] >= 0) continue;
      dist[nr][nc] = dist[r][c] + 1;
      q.push([nc, nr]);
    }
  }
  return dist;
}

export function generateMaze(rand: () => number, o: MazeOpts): Maze {
  const { cols, rows } = o;
  const [lo, hi] = [o.pathLen[0], o.pathLen[1]];
  let best: { open: number[][]; start: { c: number; r: number }; exit: { c: number; r: number }; dist: number[][]; err: number } | null = null;
  for (let attempt = 0; attempt < 80; attempt++) {
    const startR = Math.floor(rand() * rows);
    let exitR = Math.floor(rand() * rows);
    if (rows > 2 && Math.abs(exitR - startR) < 1) exitR = (startR + 1 + Math.floor(rand() * (rows - 1))) % rows;
    const open = carve(rand, cols, rows, o.braid, startR);
    const exit = { c: cols - 1, r: exitR };
    const dist = bfs(open, cols, rows, exit);
    const len = dist[startR][0];
    const err = len < lo ? lo - len : len > hi ? len - hi : 0;
    if (!best || err < best.err) best = { open, start: { c: 0, r: startR }, exit, dist, err };
    if (err === 0) break;
  }
  const { open, start, exit, dist } = best!;
  open[exit.r][exit.c] |= E;

  const next = Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => {
      if (c === exit.c && r === exit.r) return { c: cols, r };
      for (const d of DIRS) {
        if (!(open[r][c] & d.bit)) continue;
        const nc = c + d.dc;
        const nr = r + d.dr;
        if (nc >= 0 && nr >= 0 && nc < cols && nr < rows && dist[nr][nc] === dist[r][c] - 1) return { c: nc, r: nr };
      }
      return { c, r };
    }),
  );

  // shortest path cells (start → exit)
  const path: { c: number; r: number }[] = [{ ...start }];
  for (let cur = start; !(cur.c === exit.c && cur.r === exit.r) && path.length < 400; ) {
    cur = next[cur.r][cur.c];
    path.push(cur);
  }

  // mud: evenly spaced along the shortest path, never on the first two or the last cell
  const mud: { c: number; r: number }[] = [];
  const usable = path.slice(2, -1);
  if (usable.length && o.mud > 0) {
    const k = Math.min(o.mud, usable.length);
    for (let i = 0; i < k; i++) mud.push(usable[Math.floor(((i + 0.5) / k) * usable.length)]);
  }
  const isMud = (c: number, r: number) => mud.some((m) => m.c === c && m.r === r);

  // bumpers: open 2×2 crossings first (interior vertices with no wall touching), then dead ends
  const cand: { x: number; y: number }[] = [];
  for (let r = 1; r < rows; r++) {
    for (let c = 1; c < cols; c++) {
      // vertex (c, r) is shared by cells (c-1,r-1) (c,r-1) (c-1,r) (c,r)
      const openAll = open[r - 1][c - 1] & E && open[r - 1][c - 1] & S && open[r][c] & N && open[r][c] & W;
      if (openAll) cand.push({ x: c, y: r });
    }
  }
  shuffle(cand, rand);
  const dead: { x: number; y: number }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if ((c === start.c && r === start.r) || (c === exit.c && r === exit.r) || isMud(c, r)) continue;
      const ds = DIRS.filter((d) => open[r][c] & d.bit);
      if (ds.length !== 1) continue;
      const d = ds[0];
      // sit towards the back wall, away from the opening
      dead.push({ x: c + 0.5 - d.dc * 0.12, y: r + 0.5 - d.dr * 0.12 });
    }
  }
  shuffle(dead, rand);
  const bumpers: { x: number; y: number }[] = [];
  for (const b of [...cand, ...dead]) {
    if (bumpers.length >= o.bumpers) break;
    if (bumpers.some((q) => Math.hypot(q.x - b.x, q.y - b.y) < 1.5)) continue;
    if (Math.hypot(b.x - (start.c + 0.5), b.y - (start.r + 0.5)) < 1.2) continue;
    bumpers.push(b);
  }

  return { cols, rows, open, start, exit, dist, next, bumpers, mud, pathLen: path.length - 1 };
}

function shuffle<T>(a: T[], rand: () => number): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}
