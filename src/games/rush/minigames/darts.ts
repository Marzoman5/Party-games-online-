/**
 * Darts (MG2) — "Aim… flick to throw!" — stream `aim`, event `flick` (+ tap).
 *
 * One big shared board with VERY generous score rings (bull 50, then 25 / 15 / 10 / 5, the wall 0).
 * Every player has a crosshair (coloured ring + their emoji badge) driven by the aim stream around a small
 * per-player resting offset (so 16 crosshairs never sit on one pixel) with a gentle sway. A flick (or a tap)
 * throws: the dart lands where the crosshair was a moment BEFORE the flick (the flick itself jerks the
 * phone). 3 darts each, everyone at once; darts stick in the player's colour. Highest total wins.
 */
import type { Minigame, MinigameCtx, MinigameDef, MinigameResult, RenderView, RushInputEvent, RushPlayer, StreamSample } from '../types';
import { STAGE_H, STAGE_W } from '../types';
import { clamp, drawEmoji, drawText, drawToken, ease, PAL, rankBy, roundRect, stageBackground } from '../draw';
import { DARTS as T } from '../tuning';

interface Dart {
  /** Board radii, y screen-down. */
  x: number;
  y: number;
  pts: number;
  at: number;
  rot: number;
  thudDone: boolean;
}

interface Thrower {
  p: RushPlayer;
  idx: number;
  present: boolean;
  baseX: number;
  baseY: number;
  tx: number;
  ty: number;
  sx: number;
  sy: number;
  ph1: number;
  ph2: number;
  hist: { t: number; x: number; y: number }[];
  darts: Dart[];
  lastThrow: number;
  total: number;
}

const BX = 960;
const BY = 594;
const BR = 438;
const PANEL_W = 430;
const RING_COLORS: [string, string][] = [
  ['#ff3a3a', '#ff3a3a'], // bull
  ['#2fd157', '#25b549'], // 25
  ['#ff8a1f', '#ec7610'], // 15
  ['#f4e8c8', '#e3d2a6'], // 10
  ['#3463e0', '#274fc0'], // 5
];

/** Points first; ties: the tighter grouping around the bull wins (missing darts count as far away). */
function rankScore(t: { total: number; darts: { x: number; y: number }[] }): number {
  let sum = 0;
  for (let q = 0; q < T.darts; q++) sum += t.darts[q] ? Math.min(2, Math.hypot(t.darts[q].x, t.darts[q].y)) : 2;
  return t.total * 100000 - Math.round(sum * 1000);
}

function ptsAt(x: number, y: number): number {
  const r = Math.hypot(x, y);
  for (const ring of T.rings) if (r <= ring.r) return ring.pts;
  return 0;
}

export const darts: MinigameDef = {
  meta: {
    id: 'darts',
    name: 'Darts',
    instr: 'Tilt your phone to aim. TAP the screen to throw!',
    word: 'TAP = THROW',
    demo: 'aim',
    minPlayers: 1,
    duration: [25, 22, 20],
    stream: 'aim',
    events: ['tap'],
    touch: 'Drag, tap to throw!',
    energetic: false,
    color: '#ff5fb8',
    icon: '🎯',
  },
  create(): Minigame {
    let ctx!: MinigameCtx;
    let h = 0;
    const th: Thrower[] = [];
    const byId = new Map<string, Thrower>();
    let ended = false;
    let shoutGate = 0;
    let bg: HTMLCanvasElement | null = null;

    const cross = (t: Thrower, time: number): [number, number] => {
      const f = T.swayHz[h] * Math.PI * 2;
      const x = t.baseX + t.sx + T.sway * Math.sin(time * f + t.ph1);
      const y = t.baseY + t.sy + T.sway * Math.sin(time * f * 1.31 + t.ph2);
      return [clamp(x, -1.3, 1.3), clamp(y, -1.05, 1.05)];
    };

    const allDone = (): boolean => {
      const act = th.filter((t) => t.present);
      if (!act.length) return true;
      return act.every((t) => t.darts.length >= T.darts);
    };

    const throwDart = (t: Thrower): void => {
      if (!t.present || t.darts.length >= T.darts) return;
      const now = ctx.time;
      if (now - t.lastThrow < T.cooldown[h]) return;
      // where the crosshair was just before the flick
      const want = now - T.lookBack;
      let s = t.hist[0];
      for (const q of t.hist) if (q.t <= want) s = q;
      let [x, y] = s ? [s.x, s.y] : cross(t, now);
      const a = ctx.rand() * Math.PI * 2;
      const d = ctx.rand() * T.scatter;
      x += Math.cos(a) * d;
      y += Math.sin(a) * d;
      const pts = ptsAt(x, y);
      t.darts.push({ x, y, pts, at: now, rot: -0.75 + (ctx.rand() - 0.5) * 0.5, thudDone: false });
      t.total += pts;
      t.lastThrow = now;
      t.hist.length = 0;
      ctx.sfx('whoosh', { pan: (x * BR) / (STAGE_W / 2), vol: 0.5 });
      const last = t.darts.length >= T.darts;
      if (pts === 50) ctx.cue(t.p.id, { fx: 'win', word: last ? `${t.total} PTS` : 'BULL!', bg: PAL.gold });
      else if (pts === 0) ctx.cue(t.p.id, { fx: 'bad', word: last ? `${t.total} PTS` : 'MISS' });
      else ctx.cue(t.p.id, { fx: pts >= 15 ? 'good' : 'tick', word: last ? `${t.total} PTS` : `+${pts}` });
      if (last) ctx.word(t.p.id, `${t.total} PTS`);
    };

    const drawDart = (g: CanvasRenderingContext2D, t: Thrower, x: number, y: number, rot: number, s: number): void => {
      const len = 42 * s;
      const ex = x + Math.cos(rot) * len;
      const ey = y + Math.sin(rot) * len;
      g.save();
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.beginPath();
      g.arc(x, y, 5 * s, 0, Math.PI * 2);
      g.fill();
      g.lineCap = 'round';
      g.strokeStyle = '#20232c';
      g.lineWidth = 9 * s;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(ex, ey);
      g.stroke();
      g.strokeStyle = '#c9d2de';
      g.lineWidth = 5 * s;
      g.stroke();
      // flight
      const fx = Math.cos(rot);
      const fy = Math.sin(rot);
      const px = -fy;
      const py = fx;
      const fl = 24 * s;
      g.beginPath();
      g.moveTo(ex - fx * 4 * s, ey - fy * 4 * s);
      g.lineTo(ex + fx * fl + px * fl * 0.7, ey + fy * fl + py * fl * 0.7);
      g.lineTo(ex + fx * fl * 1.25, ey + fy * fl * 1.25);
      g.lineTo(ex + fx * fl - px * fl * 0.7, ey + fy * fl - py * fl * 0.7);
      g.closePath();
      g.fillStyle = t.p.color;
      g.fill();
      g.lineWidth = 3 * s;
      g.strokeStyle = '#ffffff';
      g.stroke();
      g.restore();
      drawEmoji(g, t.p.emoji, ex + fx * fl * 0.85, ey + fy * fl * 0.85, 24 * s);
    };

    const drawStatic = (g: CanvasRenderingContext2D): void => {
      stageBackground(g, '#2a1238', '#12081c');
      // the wall: soft bricks
      g.save();
      g.fillStyle = 'rgba(255,255,255,0.035)';
      const bw = 120;
      const bh = 54;
      for (let r = 0; r * bh < STAGE_H; r++) {
        for (let c = -1; c * bw < STAGE_W; c++) {
          const x = c * bw + (r % 2 ? bw / 2 : 0);
          g.fillRect(x + 4, r * bh + 4, bw - 8, bh - 8);
        }
      }
      // spotlight
      const sp = g.createRadialGradient(BX, BY, BR * 0.6, BX, BY, BR * 1.7);
      sp.addColorStop(0, 'rgba(255,240,200,0.18)');
      sp.addColorStop(1, 'rgba(255,240,200,0)');
      g.fillStyle = sp;
      g.fillRect(0, 0, STAGE_W, STAGE_H);
      // board
      g.fillStyle = 'rgba(0,0,0,0.5)';
      g.beginPath();
      g.arc(BX + 14, BY + 20, BR * 1.1, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#1a1a22';
      g.beginPath();
      g.arc(BX, BY, BR * 1.1, 0, Math.PI * 2);
      g.fill();
      g.lineWidth = 10;
      g.strokeStyle = '#ffd23a';
      g.stroke();
      // decorative studs on the outer ring
      g.fillStyle = '#ffd23a';
      for (let i = 0; i < 20; i++) {
        const a = (i / 20) * Math.PI * 2;
        g.beginPath();
        g.arc(BX + Math.cos(a) * BR * 1.05, BY + Math.sin(a) * BR * 1.05, 6, 0, Math.PI * 2);
        g.fill();
      }
      const rings = T.rings;
      for (let k = rings.length - 1; k >= 0; k--) {
        const r = rings[k].r * BR;
        const [c1, c2] = RING_COLORS[Math.min(k, RING_COLORS.length - 1)];
        const wedges = k === 0 ? 1 : 16;
        for (let w = 0; w < wedges; w++) {
          const a0 = (w / wedges) * Math.PI * 2 - Math.PI / 2 - Math.PI / wedges;
          const a1 = ((w + 1) / wedges) * Math.PI * 2 - Math.PI / 2 - Math.PI / wedges;
          g.beginPath();
          g.moveTo(BX, BY);
          g.arc(BX, BY, r, a0, a1);
          g.closePath();
          g.fillStyle = w % 2 ? c2 : c1;
          g.fill();
        }
        g.beginPath();
        g.arc(BX, BY, r, 0, Math.PI * 2);
        g.lineWidth = 4;
        g.strokeStyle = 'rgba(255,255,255,0.85)';
        g.stroke();
      }
      g.beginPath();
      g.arc(BX, BY, rings[0].r * BR, 0, Math.PI * 2);
      g.lineWidth = 7;
      g.strokeStyle = '#ffd23a';
      g.stroke();
      // ring values (top and bottom of each ring)
      for (let k = 1; k < rings.length; k++) {
        const rm = ((rings[k].r + rings[k - 1].r) / 2) * BR;
        const sz = Math.min(64, (rings[k].r - rings[k - 1].r) * BR * 0.62);
        const col = k === 3 ? '#5a3a10' : '#ffffff';
        drawText(g, `${rings[k].pts}`, BX, BY - rm, sz, col, { outline: k === 3 ? 0 : sz * 0.1, alpha: 0.9 });
        drawText(g, `${rings[k].pts}`, BX, BY + rm, sz, col, { outline: k === 3 ? 0 : sz * 0.1, alpha: 0.9 });
      }
      drawText(g, `${rings[0].pts}`, BX, BY, Math.min(46, rings[0].r * BR * 0.85), '#ffffff');
      g.restore();
    };

    return {
      start(c) {
        ctx = c;
        h = c.heat - 1;
        const n = c.players.length;
        c.players.forEach((p, i) => {
          // resting offsets: two rings around the bull so crosshairs don't stack
          const a = -Math.PI / 2 + (i / n) * Math.PI * 2 + 0.3;
          const rr = n === 1 ? T.spread * 0.6 : T.spread * (n > 6 && i % 2 ? 1.45 : 1);
          const t: Thrower = {
            p,
            idx: i,
            present: true,
            baseX: Math.cos(a) * rr,
            baseY: Math.sin(a) * rr,
            tx: 0,
            ty: 0,
            sx: 0,
            sy: 0,
            ph1: c.rand() * Math.PI * 2,
            ph2: c.rand() * Math.PI * 2,
            hist: [],
            darts: [],
            lastThrow: -9,
            total: 0,
          };
          th.push(t);
          byId.set(p.id, t);
        });
      },
      onStream(p, s: StreamSample) {
        const t = byId.get(p.id);
        if (!t) return;
        t.tx = clamp((s.a / 1000) * T.aimGain, -1.4, 1.4);
        t.ty = clamp((-s.b / 1000) * T.aimGain, -1.4, 1.4);
      },
      onEvent(p, e: RushInputEvent) {
        if (e.k !== 'flick' && e.k !== 'tap') return;
        const t = byId.get(p.id);
        if (t) throwDart(t);
      },
      onLeave(p) {
        const t = byId.get(p.id);
        if (t) t.present = false;
      },
      update(dt) {
        if (ended) return;
        const now = ctx.time;
        const k = 1 - Math.exp(-dt / T.aimTau);
        let lastLand = 0;
        for (const t of th) {
          t.sx += (t.tx - t.sx) * k;
          t.sy += (t.ty - t.sy) * k;
          const [x, y] = cross(t, now);
          t.hist.push({ t: now, x, y });
          while (t.hist.length > 2 && t.hist[1].t < now - 0.5) t.hist.shift();
          for (const d of t.darts) {
            const land = d.at + T.flight;
            lastLand = Math.max(lastLand, land);
            if (!d.thudDone && now >= land) {
              d.thudDone = true;
              ctx.sfx('thud', { pan: (d.x * BR) / (STAGE_W / 2), vol: 0.7 });
              if (d.pts === 50) {
                ctx.sfx('crowd', { vol: 0.7 });
                if (now > shoutGate) {
                  shoutGate = now + 1.2;
                  ctx.shout('BULLSEYE!', { color: t.p.color, ms: 900, size: 0.75 });
                }
              } else if (d.pts === 0) ctx.sfx('buzz', { vol: 0.35 });
            }
          }
        }
        if (allDone() && now >= lastLand + T.endDelay) {
          ended = true;
          ctx.end();
        }
      },
      render(g: CanvasRenderingContext2D, v: RenderView) {
        if (typeof document !== 'undefined') {
          if (!bg) {
            bg = document.createElement('canvas');
            bg.width = STAGE_W;
            bg.height = STAGE_H;
            drawStatic(bg.getContext('2d')!);
          }
          g.drawImage(bg, 0, 0, STAGE_W, STAGE_H);
        } else drawStatic(g);

        const now = ctx.time;
        const res = v.phase === 'results';
        // stuck darts (and darts in flight)
        for (const t of th) {
          for (const d of t.darts) {
            const k = res ? 1 : clamp((now - d.at) / T.flight, 0, 1);
            const x = BX + d.x * BR;
            const y = BY + d.y * BR;
            if (k < 1) {
              const e = ease.outCubic(k);
              drawDart(g, t, x, y + (1 - e) * 520, d.rot, 2.4 - 1.4 * e);
            } else drawDart(g, t, x, y, d.rot, 1);
          }
        }
        // score pop-ups
        for (const t of th) {
          for (const d of t.darts) {
            const age = now - d.at - T.flight;
            if (res || age < 0 || age > 1.1) continue;
            const x = BX + d.x * BR;
            const y = BY + d.y * BR - 40 - age * 70;
            const txt = d.pts === 0 ? 'MISS' : d.pts === 50 ? 'BULL! 50' : `+${d.pts}`;
            drawText(g, txt, x, y, d.pts === 50 ? 64 : 48, d.pts === 0 ? PAL.bad : d.pts === 50 ? PAL.gold : t.p.color, { alpha: clamp(1.4 - age * 1.3, 0, 1) });
          }
        }
        // crosshairs
        if (!res) {
          const showName = th.length <= 8;
          const cr = th.length > 8 ? 27 : 34;
          for (const t of th) {
            if (!t.present || t.darts.length >= T.darts) continue;
            const [cx, cy] = cross(t, now);
            const x = BX + cx * BR;
            const y = BY + cy * BR;
            const cool = clamp((now - t.lastThrow) / T.cooldown[h], 0, 1);
            g.save();
            g.globalAlpha = 0.45 + 0.55 * cool;
            g.lineCap = 'round';
            for (const [w, col] of [
              [14, 'rgba(10,6,30,0.85)'],
              [7, t.p.color],
            ] as const) {
              g.lineWidth = w;
              g.strokeStyle = col;
              g.beginPath();
              g.arc(x, y, cr, 0, Math.PI * 2);
              g.stroke();
              for (let q = 0; q < 4; q++) {
                const a = (q * Math.PI) / 2;
                g.beginPath();
                g.moveTo(x + Math.cos(a) * cr * 0.65, y + Math.sin(a) * cr * 0.65);
                g.lineTo(x + Math.cos(a) * cr * 1.45, y + Math.sin(a) * cr * 1.45);
                g.stroke();
              }
            }
            g.fillStyle = '#ffffff';
            g.beginPath();
            g.arc(x, y, 5, 0, Math.PI * 2);
            g.fill();
            g.restore();
            drawEmoji(g, t.p.emoji, x + cr * 1.18, y - cr * 1.18, cr * 1.3);
            // darts left
            for (let q = 0; q < T.darts - t.darts.length; q++) {
              g.fillStyle = t.p.color;
              g.strokeStyle = '#ffffff';
              g.lineWidth = 3;
              g.beginPath();
              g.arc(x - 14 + q * 14, y + cr * 1.75, 6, 0, Math.PI * 2);
              g.fill();
              g.stroke();
            }
            if (showName) drawText(g, t.p.name, x, y - cr * 2, 26, t.p.color, { maxWidth: 220 });
          }
        }

        // scoreboards (left + right), live sorted
        const ranked = rankBy(
          th.map((t) => ({ id: t.p.id, t })),
          (x) => rankScore(x.t),
        );
        const n = ranked.length;
        const perSide = Math.ceil(n / 2);
        const top = 140;
        const rowH = Math.min(118, (1050 - top) / perSide);
        ranked.forEach((r, i) => {
          const side = i < perSide ? 0 : 1;
          const row = side ? i - perSide : i;
          const x0 = side ? STAGE_W - 30 - PANEL_W : 30;
          const y0 = top + row * rowH;
          const t = r.t;
          const lead = r.place === 1 && t.total > 0;
          g.save();
          roundRect(g, x0, y0 + 4, PANEL_W, rowH - 8, 18);
          g.fillStyle = lead ? 'rgba(255,210,58,0.25)' : 'rgba(0,0,0,0.4)';
          g.fill();
          if (!t.present) g.globalAlpha = 0.45;
          const cy = y0 + rowH / 2;
          const tr = Math.min(34, rowH * 0.32);
          drawText(g, `${r.place}`, x0 + 26, cy, Math.min(40, rowH * 0.4), lead ? PAL.gold : '#ffffff');
          drawToken(g, t.p, x0 + 58 + tr, cy, tr, { label: false, dim: !t.present, ring: lead && res ? PAL.gold : undefined });
          const nx = x0 + 70 + tr * 2;
          const ns = Math.min(32, rowH * 0.3);
          drawText(g, t.p.name, nx, cy - ns * 0.55, ns, t.p.color, { align: 'left', maxWidth: PANEL_W - (nx - x0) - 110 });
          // dart pips: score of each dart
          for (let q = 0; q < T.darts; q++) {
            const d = t.darts[q];
            const px = nx + q * 42 + 16;
            const py = cy + ns * 0.6;
            const landed = d && (res || now >= d.at + T.flight);
            g.beginPath();
            g.arc(px, py, Math.min(16, rowH * 0.15), 0, Math.PI * 2);
            g.fillStyle = landed ? (d.pts === 0 ? '#5a2030' : t.p.color) : 'rgba(255,255,255,0.12)';
            g.fill();
            g.lineWidth = 2;
            g.strokeStyle = 'rgba(255,255,255,0.6)';
            g.stroke();
            if (landed) drawText(g, d.pts === 0 ? '×' : `${d.pts}`, px, py, Math.min(16, rowH * 0.15), '#ffffff', { outline: 3 });
          }
          drawText(g, `${t.total}`, x0 + PANEL_W - 20, cy, Math.min(60, rowH * 0.5), lead ? PAL.gold : '#ffffff', { align: 'right' });
          if (lead && res) drawEmoji(g, '👑', x0 + 58 + tr, cy - tr * 1.15, tr * 0.9);
          g.restore();
        });

        if (v.phase === 'count') drawText(g, 'Move your phone to aim  ·  flick your wrist to throw', BX, 1050, 34, '#ffffff');
      },
      done() {
        return ended;
      },
      results(): MinigameResult {
        const present = th.filter((t) => t.present);
        const ranked = rankBy(
          present.map((t) => ({ id: t.p.id, t })),
          (x) => rankScore(x.t),
        );
        const ranking = ranked.map((x) => ({ id: x.id, place: x.place, stat: `${x.t.total} pts` }));
        const sup: { id: string; text: string }[] = [];
        const bulls = (t: Thrower) => t.darts.filter((d) => d.pts === 50).length;
        const bull = [...present].filter((t) => bulls(t) > 0).sort((a, b) => bulls(b) - bulls(a) || b.total - a.total)[0];
        if (bull) sup.push({ id: bull.p.id, text: bulls(bull) > 1 ? `Bullseye ×${bulls(bull)}!` : 'Bullseye!' });
        const misses = (t: Thrower) => t.darts.filter((d) => d.pts === 0).length;
        const wall = [...present].filter((t) => misses(t) > 0).sort((a, b) => misses(b) - misses(a) || a.total - b.total)[0];
        if (wall) sup.push({ id: wall.p.id, text: 'Hit the wall' });
        const spread = (t: Thrower): number => {
          const mx = t.darts.reduce((s, d) => s + d.x, 0) / t.darts.length;
          const my = t.darts.reduce((s, d) => s + d.y, 0) / t.darts.length;
          return t.darts.reduce((s, d) => s + Math.hypot(d.x - mx, d.y - my), 0) / t.darts.length;
        };
        const full = present.filter((t) => t.darts.length >= T.darts && misses(t) === 0);
        if (full.length >= 2) {
          const cons = [...full].sort((a, b) => spread(a) - spread(b))[0];
          sup.push({ id: cons.p.id, text: 'Consistent' });
        }
        if (!ranked.length) return { ranking };
        return { ranking, superlatives: sup };
      },
      botHint(id) {
        const t = byId.get(id);
        if (!t || !t.present || t.darts.length >= T.darts) return undefined;
        const [x, y] = cross(t, ctx.time);
        return [Math.round(x * 1000), Math.round(-y * 1000)];
      },
      dispose() {
        bg = null;
      },
    };
  },
};
