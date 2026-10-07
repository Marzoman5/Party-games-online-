/**
 * Tilt Maze (MG2) — "Tilt to roll to the exit!" — stream `tilt`.
 *
 * ONE shared maze (seeded, a fresh layout every round, see tilt-maze.gen.ts), every player's token is a
 * marble. Marbles never collide with each other (nobody can block anyone); they only bounce off walls and
 * bumpers and slow down in mud. Wide corridors, no holes, no instant fails. First out of the exit wins;
 * once someone escapes the rest get a short HURRY window; the others are ranked by BFS path distance.
 * The right-hand column is a live standings list (finished first, then closest to the exit).
 */
import type { Minigame, MinigameCtx, MinigameDef, MinigameResult, RenderView, RushPlayer, StreamSample } from '../types';
import { STAGE_H, STAGE_W } from '../types';
import { clamp, drawEmoji, drawText, drawToken, ease, PAL, rankBy, roundRect, stageBackground } from '../draw';
import { TILT_MAZE as T } from '../tuning';
import { E, generateMaze, N, S, W, type Maze } from './tilt-maze.gen';

interface Marble {
  p: RushPlayer;
  present: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  tx: number;
  ty: number;
  sx: number;
  sy: number;
  finished: boolean;
  finishAt: number;
  place: number;
  mudTime: number;
  /** Render-only separation offset (so 16 marbles in one corridor stay readable). */
  ox: number;
  oy: number;
  prog: number;
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const LANE_W = 280;
const MARGIN = 44;
const WALL = 18;
const MAX_SPEED = 720;

export const tiltMaze: MinigameDef = {
  meta: {
    id: 'tilt-maze',
    name: 'Tilt Maze',
    instr: 'Tilt to roll to the exit!',
    word: 'TILT!',
    demo: 'tilt',
    minPlayers: 1,
    duration: [40, 36, 32],
    stream: 'tilt',
    events: [],
    touch: 'Drag to roll!',
    energetic: false,
    color: '#1fd6d0',
    icon: '🌀',
  },
  create(): Minigame {
    let ctx!: MinigameCtx;
    let h = 0;
    let maze!: Maze;
    let cs = 160;
    let ox = 0;
    let oy = 0;
    let mr = 28;
    let br = 28;
    const walls: Rect[] = [];
    const marbles: Marble[] = [];
    const byId = new Map<string, Marble>();
    let mudSet = new Set<number>();
    const bumperFlash: number[] = [];
    let finishedCount = 0;
    let hurryEnd = Infinity;
    let allDoneAt = Infinity;
    let ended = false;
    let sfxGate = 0;
    let bg: HTMLCanvasElement | null = null;
    let renderT = 0;

    const laneX = STAGE_W - MARGIN - LANE_W;
    const cellOf = (x: number, y: number): { c: number; r: number } => ({
      c: clamp(Math.floor((x - ox) / cs), 0, maze.cols - 1),
      r: clamp(Math.floor((y - oy) / cs), 0, maze.rows - 1),
    });
    const centre = (c: number, r: number): [number, number] => [ox + (c + 0.5) * cs, oy + (r + 0.5) * cs];

    /** Continuous BFS distance to the exit (cells), 0 at the exit opening. */
    const progress = (m: Marble): number => {
      if (m.finished) return 0;
      const { c, r } = cellOf(m.x, m.y);
      const d = maze.dist[r][c];
      const nx = maze.next[r][c];
      const [cx, cy] = centre(c, r);
      const dx = nx.c - c;
      const dy = nx.r - r;
      const proj = clamp(((m.x - cx) * dx + (m.y - cy) * dy) / cs, -0.5, 0.5);
      return Math.max(0, d + 0.5 - proj);
    };

    const buildWalls = (): void => {
      const t = WALL / 2;
      const hw = (c: number, r: number) => walls.push({ x0: ox + c * cs - t, y0: oy + r * cs - t, x1: ox + (c + 1) * cs + t, y1: oy + r * cs + t });
      const vw = (c: number, r: number) => walls.push({ x0: ox + c * cs - t, y0: oy + r * cs - t, x1: ox + c * cs + t, y1: oy + (r + 1) * cs + t });
      for (let r = 0; r < maze.rows; r++) {
        for (let c = 0; c < maze.cols; c++) {
          const o = maze.open[r][c];
          if (!(o & N)) hw(c, r);
          if (r === maze.rows - 1 && !(o & S)) hw(c, r + 1);
          if (!(o & W)) vw(c, r);
          if (c === maze.cols - 1 && !(o & E)) vw(c + 1, r);
        }
      }
    };

    const finish = (m: Marble): void => {
      m.finished = true;
      m.finishAt = ctx.time;
      m.place = ++finishedCount;
      m.vx = m.vy = 0;
      ctx.cue(m.p.id, { fx: 'win', word: m.place === 1 ? '1ST!' : `#${m.place}`, bg: m.place === 1 ? PAL.gold : undefined });
      if (m.place === 1) {
        ctx.sfx('fanfare');
        ctx.shout(`${m.p.name} ESCAPED!`, { color: m.p.color, ms: 1200, size: 0.7 });
        const end = ctx.time + T.hurryAfterFirst[h];
        if (end < ctx.duration - 0.5) hurryEnd = end;
      } else ctx.sfx('ding', { pan: 0.8 });
      checkAllDone();
    };

    const checkAllDone = (): void => {
      if (allDoneAt !== Infinity) return;
      const left = marbles.filter((m) => m.present && !m.finished).length;
      const any = marbles.some((m) => m.present);
      if (left === 0 && (any || ctx.time > 0)) allDoneAt = ctx.time + 1.0;
    };

    const collide = (m: Marble): number => {
      let hit = 0;
      for (const w of walls) {
        if (m.x + mr < w.x0 || m.x - mr > w.x1 || m.y + mr < w.y0 || m.y - mr > w.y1) continue;
        const cx = clamp(m.x, w.x0, w.x1);
        const cy = clamp(m.y, w.y0, w.y1);
        let dx = m.x - cx;
        let dy = m.y - cy;
        let d = Math.hypot(dx, dy);
        let push: number;
        if (d < 1e-6) {
          // centre inside the wall (should not happen): push out along the shortest axis
          const l = m.x - w.x0;
          const rr = w.x1 - m.x;
          const tp = m.y - w.y0;
          const bt = w.y1 - m.y;
          const mn = Math.min(l, rr, tp, bt);
          dx = mn === l ? -1 : mn === rr ? 1 : 0;
          dy = mn === tp ? -1 : mn === bt ? 1 : 0;
          d = 1;
          push = mn + mr;
        } else {
          if (d >= mr) continue;
          push = mr - d;
          dx /= d;
          dy /= d;
        }
        m.x += dx * push;
        m.y += dy * push;
        const vn = m.vx * dx + m.vy * dy;
        if (vn < 0) {
          m.vx -= (1 + T.restitution) * vn * dx;
          m.vy -= (1 + T.restitution) * vn * dy;
          hit = Math.max(hit, -vn);
        }
      }
      return hit;
    };

    const bump = (m: Marble): void => {
      maze.bumpers.forEach((b, i) => {
        const bx = ox + b.x * cs;
        const by = oy + b.y * cs;
        const dx = m.x - bx;
        const dy = m.y - by;
        const d = Math.hypot(dx, dy);
        const min = br + mr;
        if (d >= min || d < 1e-6) return;
        const nx = dx / d;
        const ny = dy / d;
        m.x = bx + nx * min;
        m.y = by + ny * min;
        const vn = m.vx * nx + m.vy * ny;
        if (vn < 0) {
          m.vx -= 2 * vn * nx;
          m.vy -= 2 * vn * ny;
        }
        m.vx += nx * T.bumperKick;
        m.vy += ny * T.bumperKick;
        bumperFlash[i] = renderT;
        if (ctx.time > sfxGate) {
          sfxGate = ctx.time + 0.12;
          ctx.sfx('boing', { pan: (bx - STAGE_W / 2) / (STAGE_W / 2), vol: 0.6, pitch: 0.9 + ((i * 0.13) % 0.3) });
        }
      });
    };

    const drawStatic = (g: CanvasRenderingContext2D): void => {
      stageBackground(g, '#0b2b3a', '#06141f');
      const W2 = maze.cols * cs;
      const H2 = maze.rows * cs;
      // floor: rounded panel with a soft grid
      g.save();
      roundRect(g, ox - 22, oy - 22, W2 + 44, H2 + 44, 26);
      g.fillStyle = '#123f52';
      g.fill();
      g.beginPath();
      g.rect(ox, oy, W2, H2);
      g.fillStyle = '#1b5a6e';
      g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.05)';
      g.lineWidth = 2;
      for (let c = 0; c <= maze.cols * 2; c++) {
        g.beginPath();
        g.moveTo(ox + (c * cs) / 2, oy);
        g.lineTo(ox + (c * cs) / 2, oy + H2);
        g.stroke();
      }
      for (let r = 0; r <= maze.rows * 2; r++) {
        g.beginPath();
        g.moveTo(ox, oy + (r * cs) / 2);
        g.lineTo(ox + W2, oy + (r * cs) / 2);
        g.stroke();
      }
      // mud puddles
      maze.mud.forEach((m, i) => {
        const [cx, cy] = centre(m.c, m.r);
        g.fillStyle = '#6b4423';
        g.beginPath();
        for (let k = 0; k <= 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          const rr = cs * (0.44 + 0.05 * Math.sin(a * 3 + i * 1.7) + 0.03 * Math.cos(a * 5 + i));
          const px = cx + Math.cos(a) * rr;
          const py = cy + Math.sin(a) * rr;
          if (k === 0) g.moveTo(px, py);
          else g.lineTo(px, py);
        }
        g.closePath();
        g.fill();
        g.fillStyle = 'rgba(40,22,8,0.5)';
        for (let k = 0; k < 5; k++) {
          g.beginPath();
          g.arc(cx + Math.cos(k * 2.4 + i) * cs * 0.22, cy + Math.sin(k * 2.4 + i) * cs * 0.2, cs * (0.05 + 0.02 * (k % 2)), 0, Math.PI * 2);
          g.fill();
        }
        drawText(g, 'MUD', cx, cy, cs * 0.2, '#e8c49a', { alpha: 0.85 });
      });
      // start pad
      const [sx, sy] = centre(maze.start.c, maze.start.r);
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.beginPath();
      g.arc(sx, sy, cs * 0.4, 0, Math.PI * 2);
      g.fill();
      drawText(g, 'START', sx, sy - cs * 0.36, cs * 0.16, 'rgba(255,255,255,0.75)');
      // exit: checkered strip just outside the opening
      const ex = ox + W2;
      const ey = oy + maze.exit.r * cs;
      const sq = cs / 6;
      for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 2; j++) {
          g.fillStyle = (i + j) % 2 ? '#111' : '#fff';
          g.fillRect(ex + 4 + j * sq, ey + i * sq, sq, sq);
        }
      }
      // walls: shadow, then body, then top highlight
      g.fillStyle = 'rgba(0,0,0,0.35)';
      for (const w of walls) g.fillRect(w.x0 + 6, w.y0 + 8, w.x1 - w.x0, w.y1 - w.y0);
      g.fillStyle = '#e9f4ff';
      for (const w of walls) g.fillRect(w.x0, w.y0, w.x1 - w.x0, w.y1 - w.y0);
      g.fillStyle = '#9fd8ff';
      for (const w of walls) g.fillRect(w.x0, w.y1 - 5, w.x1 - w.x0, 5);
      g.restore();
    };

    return {
      start(c) {
        ctx = c;
        h = c.heat - 1;
        const [cols, rows] = T.grid[h];
        maze = generateMaze(c.rand, { cols, rows, braid: T.braid[h], pathLen: T.pathLen[h], bumpers: T.bumpers[h], mud: T.mud[h] });
        const availW = laneX - 40 - MARGIN - 40;
        const availH = 1046 - 140;
        cs = Math.floor(Math.min(availW / cols, availH / rows));
        ox = MARGIN + 20 + Math.floor((availW - cols * cs) / 2);
        oy = 140 + Math.floor((availH - rows * cs) / 2);
        mr = Math.max(28, Math.round(cs * (c.players.length <= 4 ? 0.21 : c.players.length <= 8 ? 0.19 : 0.17)));
        br = Math.round(cs * 0.16);
        mudSet = new Set(maze.mud.map((m) => m.r * 100 + m.c));
        buildWalls();
        const [sx, sy] = centre(maze.start.c, maze.start.r);
        const n = c.players.length;
        c.players.forEach((p, i) => {
          // spiral inside the start cell
          const a = i * 2.39996;
          const rr = n === 1 ? 0 : cs * 0.26 * Math.sqrt((i + 0.5) / n);
          const m: Marble = {
            p,
            present: true,
            x: sx + Math.cos(a) * rr,
            y: sy + Math.sin(a) * rr,
            vx: 0,
            vy: 0,
            tx: 0,
            ty: 0,
            sx: 0,
            sy: 0,
            finished: false,
            finishAt: 0,
            place: 0,
            mudTime: 0,
            ox: 0,
            oy: 0,
            prog: 0,
          };
          m.prog = maze.dist[maze.start.r][maze.start.c] + 0.5;
          marbles.push(m);
          byId.set(p.id, m);
        });
      },
      onStream(p, s: StreamSample) {
        const m = byId.get(p.id);
        if (!m) return;
        let tx = s.a / 1000;
        let ty = -s.b / 1000; // forward tilt rolls up the screen
        const k = Math.hypot(tx, ty);
        if (k > 1) {
          tx /= k;
          ty /= k;
        }
        m.tx = tx;
        m.ty = ty;
      },
      onLeave(p) {
        const m = byId.get(p.id);
        if (!m) return;
        m.present = false;
        checkAllDone();
      },
      update(dt) {
        if (ended) return;
        const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
        const sdt = dt / steps;
        const kS = 1 - Math.exp(-dt / T.tiltTau);
        let hardest = 0;
        let hardX = 0;
        for (const m of marbles) {
          if (!m.present || m.finished) continue;
          m.sx += (m.tx - m.sx) * kS;
          m.sy += (m.ty - m.sy) * kS;
          const { c, r } = cellOf(m.x, m.y);
          const mud = mudSet.has(r * 100 + c);
          if (mud) m.mudTime += dt;
          const acc = T.accel[h] * (mud ? T.mudAccel : 1);
          const damp = Math.exp(-(T.damping + (mud ? T.mudDamping : 0)) * sdt);
          for (let s = 0; s < steps; s++) {
            m.vx = (m.vx + m.sx * acc * sdt) * damp;
            m.vy = (m.vy + m.sy * acc * sdt) * damp;
            const sp = Math.hypot(m.vx, m.vy);
            if (sp > MAX_SPEED) {
              m.vx *= MAX_SPEED / sp;
              m.vy *= MAX_SPEED / sp;
            }
            m.x += m.vx * sdt;
            m.y += m.vy * sdt;
            const hit = collide(m);
            if (hit > hardest) {
              hardest = hit;
              hardX = m.x;
            }
            bump(m);
            if (m.x > ox + maze.cols * cs + mr * 0.2) {
              finish(m);
              break;
            }
          }
          if (!m.finished) m.prog = progress(m);
        }
        if (hardest > 260 && ctx.time > sfxGate) {
          sfxGate = ctx.time + 0.15;
          ctx.sfx('thud', { pan: (hardX - STAGE_W / 2) / (STAGE_W / 2), vol: Math.min(0.6, hardest / 900) });
        }
        if (ctx.time >= hurryEnd || ctx.time >= allDoneAt) {
          ended = true;
          ctx.end();
        }
      },
      render(g: CanvasRenderingContext2D, v: RenderView) {
        renderT = v.t;
        if (typeof document !== 'undefined') {
          if (!bg) {
            bg = document.createElement('canvas');
            bg.width = STAGE_W;
            bg.height = STAGE_H;
            drawStatic(bg.getContext('2d')!);
          }
          g.drawImage(bg, 0, 0, STAGE_W, STAGE_H);
        } else drawStatic(g);

        // exit arrow (animated)
        const ex = ox + maze.cols * cs;
        const ey = oy + (maze.exit.r + 0.5) * cs;
        const bob = Math.sin(v.t * 6) * 8;
        drawText(g, 'EXIT', ex + 8 + bob * 0.3, ey - cs * 0.5 - 10, Math.max(30, cs * 0.2), PAL.gold);
        drawText(g, '➜', ex + cs * 0.22 + bob, ey, cs * 0.34, PAL.gold);

        // bumpers
        maze.bumpers.forEach((b, i) => {
          const bx = ox + b.x * cs;
          const by = oy + b.y * cs;
          const f = clamp(1 - (v.t - (bumperFlash[i] ?? -9)) / 0.3, 0, 1);
          const rr = br * (1 + 0.18 * f);
          g.fillStyle = 'rgba(0,0,0,0.35)';
          g.beginPath();
          g.arc(bx + 5, by + 7, rr, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = f > 0 ? '#ffffff' : '#ff3ab8';
          g.beginPath();
          g.arc(bx, by, rr, 0, Math.PI * 2);
          g.fill();
          g.lineWidth = 6;
          g.strokeStyle = '#ffd23a';
          g.stroke();
          g.fillStyle = f > 0 ? '#ff3ab8' : '#ffd23a';
          g.beginPath();
          g.arc(bx, by, rr * 0.4, 0, Math.PI * 2);
          g.fill();
        });

        // render-only separation so stacked marbles fan out
        const live = marbles.filter((m) => !m.finished);
        const k = 1 - Math.exp(-Math.max(0.001, v.dt) / 0.12);
        const tgt = live.map(() => [0, 0]);
        const sep = mr * 2.2;
        for (let i = 0; i < live.length; i++) {
          for (let j = i + 1; j < live.length; j++) {
            let dx = live[j].x - live[i].x;
            let dy = live[j].y - live[i].y;
            let d = Math.hypot(dx, dy);
            if (d >= sep) continue;
            if (d < 0.5) {
              const a = (i * 7 + j * 3) * 0.9;
              dx = Math.cos(a);
              dy = Math.sin(a);
              d = 1;
            } else {
              dx /= d;
              dy /= d;
            }
            const push = (sep - Math.min(d, sep)) * 0.5;
            tgt[i][0] -= dx * push;
            tgt[i][1] -= dy * push;
            tgt[j][0] += dx * push;
            tgt[j][1] += dy * push;
          }
        }
        live.forEach((m, i) => {
          let tx = tgt[i][0];
          let ty = tgt[i][1];
          const l = Math.hypot(tx, ty);
          if (l > mr * 1.5) {
            tx *= (mr * 1.5) / l;
            ty *= (mr * 1.5) / l;
          }
          m.ox += (tx - m.ox) * (v.phase === 'play' ? k : 1);
          m.oy += (ty - m.oy) * (v.phase === 'play' ? k : 1);
        });
        const order = [...live].sort((a, b) => a.y + a.oy - (b.y + b.oy));
        const lbl = marbles.length <= 10;
        for (const m of order) {
          const x = m.x + m.ox;
          const y = m.y + m.oy;
          const inMud = mudSet.has(cellOf(m.x, m.y).r * 100 + cellOf(m.x, m.y).c);
          drawToken(g, m.p, x, y, mr, { dim: !m.present, label: lbl, labelPos: 'above', labelScale: 1.2, wobble: inMud ? 0.5 + 0.5 * Math.sin(v.t * 14) : 0 });
        }
        if (!lbl) {
          // many players: name tags on top of everything (smaller, still outlined)
          for (const m of order) drawText(g, m.p.name, m.x + m.ox, m.y + m.oy - mr - 15, 22, m.present ? m.p.color : '#888', { maxWidth: 170 });
        }

        // live standings lane
        const ranked = [...marbles].sort((a, b) => (a.finished || b.finished ? (a.finished ? (b.finished ? a.place - b.place : -1) : 1) : a.prog - b.prog));
        const n = ranked.length;
        const top = 140;
        const rowH = Math.min(78, (1046 - top - 50) / n);
        g.save();
        roundRect(g, laneX, top - 10, LANE_W, rowH * n + 70, 20);
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fill();
        g.restore();
        drawText(g, '🏁 STANDINGS', laneX + LANE_W / 2, top + 18, 28, '#ffffff');
        const tr = Math.min(28, rowH * 0.38);
        ranked.forEach((m, i) => {
          const y = top + 56 + rowH * (i + 0.5);
          if (m.finished) {
            g.fillStyle = i === 0 ? 'rgba(255,210,58,0.28)' : 'rgba(61,220,90,0.18)';
            g.fillRect(laneX + 6, y - rowH / 2 + 2, LANE_W - 12, rowH - 4);
          }
          drawText(g, `${i + 1}`, laneX + 24, y, Math.min(32, rowH * 0.5), m.finished ? PAL.gold : '#ffffff');
          drawToken(g, m.p, laneX + 46 + tr, y, tr, { label: false, dim: !m.present, touchBadge: false });
          drawText(g, m.p.name, laneX + 56 + tr * 2, y, Math.min(28, rowH * 0.42), m.present ? m.p.color : '#888', { align: 'left', maxWidth: LANE_W - 80 - tr * 2 - (m.finished ? 30 : 0) });
          if (m.finished) drawEmoji(g, m.place === 1 ? '👑' : '🏁', laneX + LANE_W - 24, y, Math.min(m.place === 1 ? 38 : 30, rowH * 0.55));
        });

        // finished marbles: a little victory lap just outside the exit
        marbles
          .filter((m) => m.finished)
          .forEach((m) => {
            const age = ctx.time - m.finishAt;
            const a = ease.outCubic(Math.min(1, age / 0.6));
            const x = ex + 30 + a * 10;
            const y = ey + Math.sin(v.t * 4 + m.place) * 4;
            if (age < 1.2) drawToken(g, m.p, x, y, mr * (1 - 0.3 * a), { label: false });
          });

        if (v.phase === 'play' && hurryEnd !== Infinity) {
          const left = Math.max(0, Math.ceil(hurryEnd - ctx.time));
          const pulse = 1 + 0.08 * Math.sin(v.t * 10);
          drawText(g, `HURRY! ${left}`, (ox + ox + maze.cols * cs) / 2, 1048, 46 * pulse, PAL.warn);
        } else if (v.phase === 'count') {
          drawText(g, 'Tilt to roll  ·  mud is slow  ·  pink bumpers bounce', (ox + ox + maze.cols * cs) / 2, 1048, 34, '#ffffff');
        }
      },
      done() {
        return ended;
      },
      results(): MinigameResult {
        const present = marbles.filter((m) => m.present);
        for (const m of present) if (!m.finished) m.prog = progress(m);
        const ranked = rankBy(
          present.map((m) => ({ id: m.p.id, m })),
          (x) => (x.m.finished ? x.m.finishAt : 10000 + Math.round(x.m.prog * 10) / 10),
          true,
        );
        const ranking = ranked.map((x) => ({
          id: x.id,
          place: x.place,
          stat: x.m.finished ? `${x.m.finishAt.toFixed(1)} s` : `${Math.max(1, Math.round(x.m.prog))} m to go`,
        }));
        const sup: { id: string; text: string }[] = [];
        if (ranked[0]) sup.push({ id: ranked[0].id, text: ranked[0].m.finished ? 'Marble master' : 'Closest to the exit' });
        const lost = ranked.filter((x) => !x.m.finished).sort((a, b) => b.m.prog - a.m.prog)[0];
        if (lost && lost.id !== ranked[0]?.id) sup.push({ id: lost.id, text: 'Lost in the maze' });
        const mud = [...present].sort((a, b) => b.mudTime - a.mudTime)[0];
        if (mud && mud.mudTime >= 1.5) sup.push({ id: mud.p.id, text: `Mud wrestler (${mud.mudTime.toFixed(0)} s)` });
        return { ranking, superlatives: sup };
      },
      botHint(id) {
        const m = byId.get(id);
        if (!m || m.finished || !maze) return undefined;
        const { c, r } = cellOf(m.x, m.y);
        const nx = maze.next[r][c];
        const [cx, cy] = centre(c, r);
        const [tx, ty] = centre(nx.c, nx.r);
        // distance from the centre line cur→next: get back on it first (avoids snagging corners)
        const lx = tx - cx;
        const ly = ty - cy;
        const ll = Math.hypot(lx, ly) || 1;
        const perp = Math.abs(((m.x - cx) * ly - (m.y - cy) * lx) / ll);
        let gx = tx;
        let gy = ty;
        if (perp > cs * 0.2) {
          gx = cx + (lx / ll) * cs * 0.2;
          gy = cy + (ly / ll) * cs * 0.2;
        }
        const dx = gx - m.x;
        const dy = gy - m.y;
        const d = Math.hypot(dx, dy) || 1;
        const vmax = T.accel[h] / T.damping;
        return [Math.round((dx / d) * 1000), Math.round((dy / d) * 1000), Math.round((m.vx / vmax) * 1000), Math.round((m.vy / vmax) * 1000)];
      },
      dispose() {
        bg = null;
      },
    };
  },
};
