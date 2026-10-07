/**
 * Shake Race (MG1) — "Shake to run!" — stream `shake`, energetic.
 *
 * Speed = smoothed shake energy with diminishing returns above the knee + a light rubber band. First to
 * the line (or furthest at the cap) wins. Three themes with the same input, picked per round with
 * ctx.rand: RUN (lanes on a track), BALLOON (pump until it pops), SODA (shake a bottle till the cap flies).
 */
import type { Minigame, MinigameCtx, MinigameDef, MinigameResult, RenderView, RushPlayer, StreamSample } from '../types';
import { HUD_H, STAGE_W } from '../types';
import { PAL, clamp, clamp01, drawEmoji as drawEmojiRaw, drawText, drawToken, ease, gridCells, lerp, rankBy, roundRect, stageBackground } from '../draw';
import { SHAKE_RACE as T } from '../tuning';

type Theme = 'run' | 'balloon' | 'soda';

interface Runner {
  p: RushPlayer;
  idx: number;
  /** Latest raw energy 0..1. */
  target: number;
  lastAt: number;
  /** Smoothed energy 0..1. */
  e: number;
  /** Effective speed factor after knee + rubber band (for animation). */
  eff: number;
  /** Progress 0..1. */
  dist: number;
  finishAt: number | null;
  sumE: number;
  nE: number;
  /** Stride / pump phase (animation). */
  phase: number;
  /** Lay-out cell. */
  cx: number;
  cy: number;
  cw: number;
  ch: number;
  /** Render time the finish happened (for pop / cap animation). */
  doneT: number | null;
  /** Finish place (1-based, 0 = not finished). */
  place: number;
}

const THEMES: { id: Theme; banner: string; icon: string; done: string }[] = [
  { id: 'run', banner: 'SHAKE TO RUN!', icon: '🏃', done: 'FINISH!' },
  { id: 'balloon', banner: 'SHAKE TO PUMP THE BALLOON!', icon: '🎈', done: 'POP!' },
  { id: 'soda', banner: 'SHAKE THE SODA!', icon: '🥤', done: 'WHOOSH!' },
];

const TOP = HUD_H + 20;
const BOTTOM = 1060;

export const shakeRace: MinigameDef = {
  meta: {
    id: 'shake-race',
    name: 'Shake Race',
    instr: 'Shake to run!',
    word: 'SHAKE!',
    demo: 'shake',
    minPlayers: 1,
    duration: [12, 10, 9],
    stream: 'shake',
    events: [],
    touch: 'Mash the button!',
    energetic: true,
    color: '#ff7a2f',
    icon: '🏃',
  },
  create(): Minigame {
    let ctx!: MinigameCtx;
    let theme: (typeof THEMES)[number] = THEMES[0];
    const runners: Runner[] = [];
    const byId = new Map<string, Runner>();
    let finishSec = 6;
    let firstAt: number | null = null;
    let finishers = 0;
    let over = false;
    let playing = false;
    let lastViewT = 0;
    // run-track layout
    let laneH = 100;
    let tokenR = 40;
    const startX = 170;
    const finishX = 1720;

    const present = (r: Runner): boolean => ctx.isPresent(r.p.id);

    function layout(): void {
      const n = runners.length;
      if (theme.id === 'run') {
        laneH = Math.min(200, (BOTTOM - TOP) / n);
        tokenR = clamp(laneH * 0.34, 28, 66);
        const top = TOP + (BOTTOM - TOP - laneH * n) / 2;
        runners.forEach((r, i) => {
          r.cx = startX;
          r.cy = top + laneH * (i + 0.5);
          r.cw = finishX - startX;
          r.ch = laneH;
        });
      } else {
        const cells = gridCells(n, 50, TOP, STAGE_W - 100, BOTTOM - TOP);
        runners.forEach((r, i) => {
          const c = cells[i];
          r.cx = c.cx;
          r.cy = c.cy;
          r.cw = c.w;
          r.ch = c.h;
        });
        tokenR = clamp(Math.min(cells[0]?.h ?? 200, cells[0]?.w ?? 200) * 0.13, 28, 60);
      }
    }

    function leader(): Runner | null {
      let best: Runner | null = null;
      for (const r of runners) {
        if (!present(r)) continue;
        if (!best) best = r;
        else if (r.finishAt !== null && (best.finishAt === null || r.finishAt < best.finishAt)) best = r;
        else if (best.finishAt === null && r.dist > best.dist) best = r;
      }
      return best && best.dist > 0.02 ? best : null;
    }

    // ---------------------------------------------------------------- rendering
    function drawRun(g: CanvasRenderingContext2D, t: number): void {
      stageBackground(g, '#2b1a5e', '#0f0b26');
      const n = runners.length;
      const top = runners[0] ? runners[0].cy - laneH / 2 : TOP;
      // track
      for (let i = 0; i < n; i++) {
        g.fillStyle = i % 2 ? '#a83c2b' : '#bb4632';
        g.fillRect(60, top + i * laneH, STAGE_W - 120, laneH);
      }
      g.fillStyle = 'rgba(255,255,255,0.75)';
      for (let i = 0; i <= n; i++) g.fillRect(60, top + i * laneH - 1.5, STAGE_W - 120, 3);
      // distance marks
      g.fillStyle = 'rgba(255,255,255,0.18)';
      for (let k = 1; k < 4; k++) g.fillRect(lerp(startX, finishX, k / 4) - 2, top, 4, laneH * n);
      // start line
      g.fillStyle = '#ffffff';
      g.fillRect(startX - tokenR - 8, top, 6, laneH * n);
      // checkered finish line
      const sq = Math.max(10, Math.min(22, laneH / 3));
      for (let y = 0; y < laneH * n; y += sq) {
        for (let c = 0; c < 2; c++) {
          g.fillStyle = (Math.floor(y / sq) + c) % 2 ? '#111' : '#fff';
          g.fillRect(finishX + c * sq, top + y, sq, Math.min(sq, laneH * n - y));
        }
      }
      drawEmoji(g, '🏁', finishX + sq, top - 26, 44);
      const lead = leader();
      for (const r of runners) {
        const on = present(r);
        const x = lerp(startX, finishX, r.dist);
        const stride = Math.sin(r.phase);
        const bob = r.finishAt === null ? -Math.abs(stride) * laneH * 0.1 * Math.min(1, r.eff * 2) : 0;
        // dust puffs
        if (on && r.eff > 0.25 && r.finishAt === null) {
          g.fillStyle = 'rgba(255,230,200,0.35)';
          for (let k = 0; k < 3; k++) {
            const ph = (t * 3 + k / 3 + r.idx * 0.13) % 1;
            g.beginPath();
            g.arc(x - tokenR - 6 - ph * tokenR * 1.6, r.cy + tokenR * 0.5 - ph * 8, tokenR * (0.18 + ph * 0.25), 0, Math.PI * 2);
            g.fill();
          }
        }
        if (r.finishAt !== null) {
          const place = r.place;
          drawText(g, placeText(place), finishX - tokenR - 24, r.cy, Math.min(64, laneH * 0.62), placeColor(place), { align: 'right' });
        }
        drawToken(g, r.p, x, r.cy + bob, tokenR, {
          labelPos: 'right',
          labelScale: n > 10 ? 1.1 : 1,
          dim: !on,
          rot: r.finishAt === null ? stride * 0.12 * Math.min(1, r.eff * 2) : 0,
          ring: r === lead ? PAL.gold : undefined,
        });
        if (r === lead && r.finishAt === null) drawEmoji(g, '👑', x - tokenR * 0.9, r.cy - tokenR * 0.9, tokenR * 0.8);
      }
    }

    function drawBalloon(g: CanvasRenderingContext2D, t: number, r: Runner, on: boolean, isLead: boolean): void {
      const tokenY = r.cy + r.ch / 2 - tokenR - Math.max(22, tokenR * 0.62) - 14;
      const knotY = tokenY - tokenR - 18;
      const top = r.cy - r.ch / 2 + 8;
      const rMax = Math.min(r.cw * 0.4, (knotY - top) / 2.15);
      const k = ease.outCubic(r.dist);
      const R = lerp(rMax * 0.18, rMax, k);
      const wob = Math.sin(r.phase * 2) * 0.05 * r.eff;
      const bx = r.cx;
      const by = knotY - R * 1.08;
      if (r.finishAt !== null) {
        // popped: shreds + confetti burst
        const dt = Math.max(0, t - (r.doneT ?? t));
        const a = clamp01(1 - dt / 1.6);
        for (let i = 0; i < 12; i++) {
          const ang = (i / 12) * Math.PI * 2 + r.idx;
          const d = rMax * (0.4 + ease.outCubic(Math.min(1, dt * 1.6)) * 0.9);
          g.fillStyle = i % 3 === 0 ? PAL.gold : i % 3 === 1 ? '#fff' : r.p.color;
          g.globalAlpha = Math.max(0.25, a);
          g.fillRect(bx + Math.cos(ang) * d - 6, by + Math.sin(ang) * d + dt * 40 - 6, 12, 12);
        }
        g.globalAlpha = 1;
        drawText(g, 'POP!', bx, by, Math.min(110, rMax * 0.9), PAL.gold);
        const place = r.place;
        drawText(g, placeText(place), bx, by + Math.min(110, rMax * 0.9) * 0.85, Math.min(60, rMax * 0.5), placeColor(place));
      } else {
        // string
        g.strokeStyle = 'rgba(255,255,255,0.7)';
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(bx, knotY);
        g.quadraticCurveTo(bx + Math.sin(t * 3 + r.idx) * 10, (knotY + tokenY) / 2, bx, tokenY - tokenR);
        g.stroke();
        // balloon body
        g.save();
        g.translate(bx, by);
        g.scale(1 + wob, 1 - wob);
        g.beginPath();
        g.ellipse(0, 0, R * 0.9, R * 1.05, 0, 0, Math.PI * 2);
        g.fillStyle = on ? r.p.color : '#666';
        g.fill();
        g.lineWidth = 4;
        g.strokeStyle = 'rgba(0,0,0,0.35)';
        g.stroke();
        // shine
        g.fillStyle = 'rgba(255,255,255,0.45)';
        g.beginPath();
        g.ellipse(-R * 0.35, -R * 0.45, R * 0.16, R * 0.28, -0.5, 0, Math.PI * 2);
        g.fill();
        // knot
        g.fillStyle = on ? r.p.color : '#666';
        g.beginPath();
        g.moveTo(-8, R * 1.05 + 10);
        g.lineTo(8, R * 1.05 + 10);
        g.lineTo(0, R * 1.0);
        g.closePath();
        g.fill();
        g.restore();
        // stretch warning near the end
        if (r.dist > 0.8) drawEmoji(g, '💦', bx + R * 0.85, by - R * 0.8, 30 + 10 * Math.sin(t * 20));
        drawText(g, `${Math.floor(r.dist * 100)}%`, bx, by, Math.max(26, Math.min(56, R * 0.5)), '#fff');
      }
      if (isLead && r.finishAt === null) drawEmoji(g, '👑', bx, by - R * 1.05 - 26, 48);
      drawToken(g, r.p, r.cx + Math.sin(r.phase) * 4 * r.eff, tokenY, tokenR, { dim: !on, ring: isLead ? PAL.gold : undefined });
    }

    function drawSoda(g: CanvasRenderingContext2D, t: number, r: Runner, on: boolean, isLead: boolean): void {
      const tokenY = r.cy + r.ch / 2 - tokenR - Math.max(22, tokenR * 0.62) - 14;
      const bottomY = tokenY - tokenR - 16;
      const top = r.cy - r.ch / 2 + 12;
      const H = Math.min(bottomY - top - 50, r.cw * 1.1, 520);
      const W = Math.min(H * 0.48, r.cw * 0.3);
      const shake = r.finishAt === null ? Math.sin(t * 40 + r.idx) * 7 * r.eff : 0;
      const tilt = r.finishAt === null ? Math.sin(r.phase) * 0.12 * r.eff : 0;
      const bx = r.cx;
      g.save();
      g.translate(bx + shake, bottomY);
      g.rotate(tilt);
      // glass body
      const bodyH = H * 0.68;
      const neckH = H * 0.22;
      g.beginPath();
      roundRect(g, -W / 2, -bodyH, W, bodyH, W * 0.22);
      g.fillStyle = 'rgba(200,240,255,0.18)';
      g.fill();
      // liquid
      const lvl = 0.55 + r.dist * 0.45;
      g.save();
      g.clip();
      g.fillStyle = on ? r.p.color : '#666';
      g.globalAlpha = 0.85;
      g.fillRect(-W / 2, -bodyH * lvl, W, bodyH * lvl);
      // foam band grows with pressure
      g.globalAlpha = 1;
      g.fillStyle = 'rgba(255,255,255,0.85)';
      const foam = bodyH * (0.05 + r.dist * 0.3);
      g.fillRect(-W / 2, -bodyH * lvl - 2, W, foam);
      // bubbles
      g.fillStyle = 'rgba(255,255,255,0.7)';
      const nb = 3 + Math.floor(r.dist * 9);
      for (let i = 0; i < nb; i++) {
        const ph = (t * (0.6 + r.e) + i * 0.37 + r.idx * 0.11) % 1;
        g.beginPath();
        g.arc(-W * 0.35 + ((i * 0.618) % 1) * W * 0.7, -ph * bodyH * lvl, 3 + (i % 3) * 2, 0, Math.PI * 2);
        g.fill();
      }
      g.restore();
      g.lineWidth = 5;
      g.strokeStyle = 'rgba(255,255,255,0.85)';
      roundRect(g, -W / 2, -bodyH, W, bodyH, W * 0.22);
      g.stroke();
      // neck
      g.beginPath();
      g.moveTo(-W * 0.32, -bodyH + 2);
      g.lineTo(-W * 0.16, -bodyH - neckH);
      g.lineTo(W * 0.16, -bodyH - neckH);
      g.lineTo(W * 0.32, -bodyH + 2);
      g.fillStyle = 'rgba(200,240,255,0.18)';
      g.fill();
      g.stroke();
      // label
      g.fillStyle = '#fff';
      g.fillRect(-W / 2 + 3, -bodyH * 0.55, W - 6, bodyH * 0.2);
      drawText(g, 'FIZZ', 0, -bodyH * 0.45, Math.min(40, W * 0.3), on ? r.p.color : '#666', { outline: 0 });
      // cap
      const capY = -bodyH - neckH;
      if (r.finishAt === null) {
        const jig = r.dist > 0.75 ? Math.sin(t * 50) * 3 * r.dist : 0;
        g.fillStyle = PAL.bad;
        g.fillRect(-W * 0.2, capY - 14 + jig, W * 0.4, 16);
      }
      g.restore();
      if (r.finishAt !== null) {
        const dt = Math.max(0, t - (r.doneT ?? t));
        // geyser
        const gy = bottomY - bodyH - neckH;
        const hgt = Math.min(1, dt * 3) * (gy - top + 10);
        g.fillStyle = 'rgba(255,255,255,0.85)';
        g.beginPath();
        g.moveTo(bx - W * 0.16, gy);
        g.quadraticCurveTo(bx - W * 0.5, gy - hgt * 0.6, bx - W * 0.25, gy - hgt);
        g.lineTo(bx + W * 0.25, gy - hgt);
        g.quadraticCurveTo(bx + W * 0.5, gy - hgt * 0.6, bx + W * 0.16, gy);
        g.closePath();
        g.fill();
        for (let i = 0; i < 6; i++) {
          g.beginPath();
          g.arc(bx + Math.sin(i * 2.3 + t * 4) * W * 0.4, gy - hgt + Math.cos(i * 1.7 + t * 5) * 12, 14 + (i % 3) * 5, 0, Math.PI * 2);
          g.fill();
        }
        // cap flying away
        const cy = gy - hgt - 30 - dt * 120;
        if (cy > top - 60) {
          g.save();
          g.translate(bx + dt * 60, Math.max(top, cy));
          g.rotate(dt * 9);
          g.fillStyle = PAL.bad;
          g.fillRect(-W * 0.2, -8, W * 0.4, 16);
          g.restore();
        }
        const place = r.place;
        drawText(g, placeText(place), bx + W * 0.5 + 10, bottomY - bodyH * 0.5, Math.min(64, r.cw * 0.18), placeColor(place), { align: 'left' });
      } else {
        drawText(g, `${Math.floor(r.dist * 100)}%`, bx + W * 0.5 + 12, bottomY - bodyH * 0.5, Math.max(26, Math.min(48, r.cw * 0.13)), '#fff', { align: 'left' });
      }
      if (isLead && r.finishAt === null) drawEmoji(g, '👑', bx, bottomY - H - 30, 46);
      drawToken(g, r.p, r.cx, tokenY, tokenR, { dim: !on, ring: isLead ? PAL.gold : undefined });
    }

    function drawGridTheme(g: CanvasRenderingContext2D, t: number): void {
      if (theme.id === 'balloon') stageBackground(g, '#3a7bd5', '#1b2f6b');
      else stageBackground(g, '#1d6b5a', '#0c2a2a');
      const lead = leader();
      for (const r of runners) {
        const on = present(r);
        g.fillStyle = 'rgba(255,255,255,0.07)';
        roundRect(g, r.cx - r.cw / 2 + 8, r.cy - r.ch / 2 + 6, r.cw - 16, r.ch - 12, 24);
        g.fill();
        if (theme.id === 'balloon') drawBalloon(g, t, r, on, r === lead);
        else drawSoda(g, t, r, on, r === lead);
      }
    }

    return {
      start(c) {
        ctx = c;
        theme = THEMES[Math.floor(c.rand() * THEMES.length) % THEMES.length];
        finishSec = T.finishSec[c.heat - 1];
        c.players.forEach((p, idx) => {
          const r: Runner = { p, idx, target: 0, lastAt: 0, e: 0, eff: 0, dist: 0, finishAt: null, sumE: 0, nE: 0, phase: 0, cx: 0, cy: 0, cw: 0, ch: 0, doneT: null, place: 0 };
          runners.push(r);
          byId.set(p.id, r);
        });
        layout();
      },
      go() {
        playing = true;
      },
      onStream(p, s: StreamSample) {
        const r = byId.get(p.id);
        if (!r) return;
        r.target = clamp01(s.a / 1000);
        r.lastAt = ctx.time;
        r.sumE += r.target;
        r.nE++;
      },
      onLeave() {
        // Nothing is shared: the leaver's runner just stops (dimmed) and is left out of the ranking.
        if (runners.every((r) => !present(r) || r.finishAt !== null)) over = true;
      },
      update(dt) {
        if (over) return;
        playing = true;
        const now = ctx.time;
        let lo = Infinity;
        let hi = -Infinity;
        for (const r of runners) {
          if (!present(r)) continue;
          lo = Math.min(lo, r.dist);
          hi = Math.max(hi, r.dist);
        }
        const spread = hi - lo;
        const k = 1 - Math.exp(-dt / T.smoothTau);
        for (const r of runners) {
          if (!present(r) || r.finishAt !== null) {
            r.eff *= 0.9;
            continue;
          }
          const target = now - r.lastAt > T.staleSec ? 0 : r.target;
          r.e += (target - r.e) * k;
          let eff = r.e <= T.knee ? r.e : T.knee + (r.e - T.knee) * T.aboveKneeGain;
          if (spread > T.rubberMinSpread) {
            const f = (r.dist - lo) / spread; // 0 = last, 1 = leader
            eff *= 1 + T.rubberLast - f * (T.rubberLast + T.rubberLead);
          }
          r.eff = eff;
          r.phase += dt * (4 + eff * 18);
          const before = r.dist;
          r.dist += (eff * dt) / finishSec;
          if (r.dist >= 1) {
            const frac = (1 - before) / Math.max(1e-6, r.dist - before);
            r.dist = 1;
            r.finishAt = now - dt + dt * frac;
            r.doneT = lastViewT;
            r.place = ++finishers;
            const first = firstAt === null;
            if (first) {
              firstAt = now;
              ctx.shout(theme.done, { color: PAL.gold, ms: 1000 });
            }
            const pan = (r.cx / STAGE_W) * 2 - 1;
            if (theme.id === 'run') ctx.sfx(first ? 'fanfare' : 'ding', { pan });
            else ctx.sfx('pop', { pan, pitch: first ? 1 : 1.2 });
            if (theme.id === 'soda') ctx.sfx('splash', { pan, vol: 0.6 });
          }
        }
        if (firstAt !== null && now - firstAt >= T.graceAfterFirstSec) over = true;
        if (runners.every((r) => !present(r) || r.finishAt !== null)) over = true;
      },
      render(g, v: RenderView) {
        lastViewT = v.t;
        for (const r of runners) if (r.finishAt !== null && r.doneT === null) r.doneT = v.t;
        if (theme.id === 'run') drawRun(g, v.t);
        else drawGridTheme(g, v.t);
        if (v.phase === 'count' || (playing && ctx.time < 1.3 && v.phase === 'play')) {
          const a = v.phase === 'count' ? 1 : clamp01((1.3 - ctx.time) / 0.4);
          g.save();
          g.globalAlpha = a;
          g.fillStyle = 'rgba(10,6,30,0.55)';
          g.fillRect(0, 470, STAGE_W, 200);
          g.restore();
          drawText(g, `${theme.icon} ${theme.banner} ${theme.icon}`, STAGE_W / 2, 570, 96, PAL.gold, { alpha: a, maxWidth: STAGE_W - 120 });
        }
      },
      done() {
        return over;
      },
      results(): MinigameResult {
        const live = runners.filter(present);
        // Score: finishers by time (bigger is better → 2 − time/1000), others by distance.
        const score = (r: Runner): number => (r.finishAt !== null ? 2 + (1000 - r.finishAt) / 1000 : Math.round(r.dist * 10000) / 10000);
        const ranked = rankBy(live.map((r) => ({ id: r.p.id, r })), (x) => score(x.r)).map((x) => Object.assign(x.r, { rank: x.place }));
        const ranking = ranked.map((r) => ({
          id: r.p.id,
          place: r.rank,
          stat: r.finishAt !== null ? `${theme.icon} ${r.finishAt.toFixed(1)} s` : `${Math.floor(r.dist * 100)}%`,
        }));
        const sup: { id: string; text: string }[] = [];
        if (ranked.length >= 2) {
          const last = ranked[ranked.length - 1];
          sup.push({ id: last.p.id, text: 'Slow and steady 🐢' });
          const a = ranked[0];
          const b = ranked[1];
          const close =
            a.finishAt !== null && b.finishAt !== null
              ? (b.finishAt - a.finishAt) / Math.max(1, a.finishAt) < T.photoGap
              : a.finishAt === null && b.finishAt === null
                ? a.dist - b.dist < T.photoGap
                : a.finishAt !== null && b.finishAt === null && 1 - b.dist < T.photoGap;
          if (close && b !== last) sup.push({ id: b.p.id, text: 'Photo finish 📸' });
        }
        let shaker: Runner | null = null;
        for (const r of live) if (r.nE > 0 && (!shaker || r.sumE / r.nE > shaker.sumE / Math.max(1, shaker.nE))) shaker = r;
        if (shaker && !sup.some((s) => s.id === shaker!.p.id)) sup.push({ id: shaker.p.id, text: 'Shook like a leaf 🍃' });
        return { ranking, superlatives: sup };
      },
    };
  },
};

/** Colour emoji glyphs pick up the fillStyle's alpha in Chrome: always draw them with an opaque fill. */
function drawEmoji(g: CanvasRenderingContext2D, e: string, x: number, y: number, size: number, alpha = 1): void {
  g.fillStyle = '#000';
  drawEmojiRaw(g, e, x, y, size, alpha);
}

function placeText(n: number): string {
  return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
}

function placeColor(n: number): string {
  return n === 1 ? PAL.gold : n === 2 ? PAL.silver : n === 3 ? PAL.bronze : '#fff';
}
