/**
 * Balance (MG2) — "Keep the ball on the plate!" — stream `tilt`.
 *
 * One plate per player in a grid. The player's token IS the ball: it rolls with the (heavily smoothed)
 * tilt of their phone, while a wobble force that keeps growing (faster at higher heat) pushes it around.
 * Centre of the ball past the rim = OUT (TV splat + red phone cue). Last ball standing wins; the rest are
 * ranked by survival time, ties by distance from the centre.
 */
import type { Minigame, MinigameCtx, MinigameDef, MinigameResult, RenderView, RushPlayer, StreamSample } from '../types';
import { STAGE_H, STAGE_W } from '../types';
import { clamp, drawEmoji, drawText, drawToken, ease, gridCells, PAL, rankBy, stageBackground } from '../draw';
import { BALANCE as T } from '../tuning';

interface Ball {
  p: RushPlayer;
  present: boolean;
  alive: boolean;
  /** Position / velocity in plate radii (y screen-down). */
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Raw tilt target and its smoothed value (plate-accel units, y screen-down). */
  tx: number;
  ty: number;
  sx: number;
  sy: number;
  /** Wobble state. */
  wobAng: number;
  wobPhase: number;
  wobDir: number;
  outAt: number;
  outAng: number;
  outVx: number;
  outVy: number;
  /** Near-miss bookkeeping. */
  inDanger: boolean;
  saves: number;
  /** Plate layout (stage units). */
  cx: number;
  cy: number;
  R: number;
  tokR: number;
  /** Render-only: plate shake, view time of the fall (animations keep running behind the results). */
  shake: number;
  outViewT: number;
}

const OUT_RED = '#ff3b3b';

export const balance: MinigameDef = {
  meta: {
    id: 'balance',
    name: 'Balance',
    instr: 'Tilt your phone to keep the ball on!',
    word: 'BALANCE!',
    demo: 'tilt',
    minPlayers: 1,
    duration: [35, 30, 28],
    stream: 'tilt',
    events: [],
    touch: 'Drag to tilt!',
    energetic: false,
    color: '#3ddc5a',
    icon: '🍽️',
  },
  create(): Minigame {
    let ctx!: MinigameCtx;
    let h = 0;
    const balls: Ball[] = [];
    const byId = new Map<string, Ball>();
    let startCount = 0;
    let endAt = Infinity;
    let ended = false;
    let firstOut: string | null = null;
    let lastBallShouted = false;
    let wobble = 0;
    let bg: HTMLCanvasElement | null = null;

    const aliveCount = (): number => balls.filter((b) => b.present && b.alive).length;

    const knockOut = (b: Ball): void => {
      b.alive = false;
      b.outAt = ctx.time;
      b.outAng = Math.atan2(b.y, b.x);
      b.outVx = b.vx;
      b.outVy = b.vy;
      if (!firstOut) firstOut = b.p.id;
      ctx.cue(b.p.id, { fx: 'bad', word: 'OUT', bg: OUT_RED });
      ctx.sfx('splash', { pan: (b.cx - STAGE_W / 2) / (STAGE_W / 2), vol: 0.8 });
      ctx.sfx('buzz', { pan: (b.cx - STAGE_W / 2) / (STAGE_W / 2), vol: 0.5 });
    };

    const checkEnd = (): void => {
      if (endAt !== Infinity) return;
      const alive = aliveCount();
      if (alive === 0 || (startCount >= 2 && alive <= 1)) {
        endAt = ctx.time + T.endDelay;
        if (alive === 1 && !lastBallShouted) {
          lastBallShouted = true;
          const w = balls.find((b) => b.present && b.alive)!;
          ctx.shout('LAST BALL!', { color: w.p.color, ms: 1100 });
          ctx.sfx('fanfare');
        }
      }
    };

    const drawBackground = (g: CanvasRenderingContext2D): void => {
      stageBackground(g, '#0f3a2c', '#071a16');
      // tablecloth gingham, very subtle
      g.save();
      g.globalAlpha = 0.07;
      g.fillStyle = '#ffffff';
      const s = 60;
      for (let x = 0; x < STAGE_W; x += s * 2) g.fillRect(x, 0, s, STAGE_H);
      for (let y = 0; y < STAGE_H; y += s * 2) g.fillRect(0, y, STAGE_W, s);
      g.restore();
      // static plate shadows
      for (const b of balls) {
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.beginPath();
        g.ellipse(b.cx + b.R * 0.06, b.cy + b.R * 0.16, b.R * 1.12, b.R * 1.06, 0, 0, Math.PI * 2);
        g.fill();
      }
    };

    const drawPlate = (g: CanvasRenderingContext2D, b: Ball, t: number): void => {
      const R = b.R;
      const dead = !b.alive || !b.present;
      const sh = b.alive && b.present ? b.shake : 0;
      const px = b.cx + Math.sin(t * 23 + b.wobPhase) * sh;
      const py = b.cy + Math.cos(t * 19 + b.wobPhase) * sh;
      g.save();
      if (dead) g.globalAlpha *= 0.45;
      // rim in the player's colour
      g.beginPath();
      g.arc(px, py, R * 1.1, 0, Math.PI * 2);
      g.fillStyle = dead ? '#555' : b.p.color;
      g.fill();
      g.lineWidth = Math.max(3, R * 0.03);
      g.strokeStyle = 'rgba(0,0,0,0.5)';
      g.stroke();
      // plate face: highlight shifts with the tilt so the plate "leans"
      const hx = px - b.sx * R * 0.12;
      const hy = py - b.sy * R * 0.12;
      const gr = g.createRadialGradient(hx - R * 0.25, hy - R * 0.3, R * 0.1, px, py, R);
      gr.addColorStop(0, '#ffffff');
      gr.addColorStop(0.7, '#e9edf2');
      gr.addColorStop(1, '#b9c2cf');
      g.beginPath();
      g.arc(px, py, R, 0, Math.PI * 2);
      g.fillStyle = gr;
      g.fill();
      // inner well + centre mark
      g.lineWidth = Math.max(2, R * 0.025);
      g.strokeStyle = 'rgba(40,60,90,0.18)';
      g.beginPath();
      g.arc(px, py, R * 0.62, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = 'rgba(40,60,90,0.18)';
      g.beginPath();
      g.arc(px, py, R * 0.07, 0, Math.PI * 2);
      g.fill();
      // danger glow when the ball is close to the rim
      if (!dead) {
        const r = Math.hypot(b.x, b.y);
        if (r > T.danger * 0.85) {
          const k = clamp((r - T.danger * 0.85) / (T.rim - T.danger * 0.85), 0, 1);
          const a = Math.atan2(b.y, b.x);
          g.lineWidth = R * 0.13;
          g.strokeStyle = `rgba(255,59,59,${0.35 + 0.6 * k * (0.75 + 0.25 * Math.sin(t * 20))})`;
          g.beginPath();
          g.arc(px, py, R * 1.04, a - 0.9, a + 0.9);
          g.stroke();
        }
      }
      g.restore();
    };

    const drawSplat = (g: CanvasRenderingContext2D, b: Ball, age: number): void => {
      // paint splat just outside the rim where the ball left
      const k = ease.outBack(Math.min(1, 0.3 + age / 0.35));
      const R = b.R;
      const sx = b.cx + Math.cos(b.outAng) * R * 1.18;
      const sy = b.cy + Math.sin(b.outAng) * R * 1.18;
      g.save();
      g.fillStyle = b.p.color;
      g.globalAlpha = 0.85;
      const base = b.tokR * 0.8 * k;
      g.beginPath();
      g.arc(sx, sy, base, 0, Math.PI * 2);
      g.fill();
      for (let i = 0; i < 7; i++) {
        const a = b.outAng + (i - 3) * 0.75 + Math.sin(i * 12.9 + b.wobPhase) * 0.3;
        const d = base * (1.1 + 0.5 * Math.abs(Math.sin(i * 4.1 + b.wobPhase)));
        g.beginPath();
        g.arc(sx + Math.cos(a) * d, sy + Math.sin(a) * d, base * (0.22 + 0.18 * Math.abs(Math.cos(i * 7.3))), 0, Math.PI * 2);
        g.fill();
      }
      g.restore();
    };

    return {
      start(c) {
        ctx = c;
        h = c.heat - 1;
        const n = c.players.length;
        const top = 128;
        const bottom = 1000;
        const cells = gridCells(n, 50, top, STAGE_W - 100, bottom - top);
        c.players.forEach((p, i) => {
          const cell = cells[i];
          const R = Math.min(cell.w * 0.4, (cell.h - 56) * 0.44, 250);
          const b: Ball = {
            p,
            present: true,
            alive: true,
            x: 0,
            y: 0,
            vx: 0,
            vy: 0,
            tx: 0,
            ty: 0,
            sx: 0,
            sy: 0,
            wobAng: c.rand() * Math.PI * 2,
            wobPhase: c.rand() * Math.PI * 2,
            wobDir: c.rand() < 0.5 ? -1 : 1,
            outAt: 0,
            outAng: 0,
            outVx: 0,
            outVy: 0,
            inDanger: false,
            saves: 0,
            cx: cell.cx,
            cy: cell.cy - 24,
            R,
            tokR: Math.max(28, Math.min(70, R * 0.3)),
            shake: 0,
            outViewT: -1,
          };
          balls.push(b);
          byId.set(p.id, b);
        });
        startCount = n;
      },
      onStream(p, s: StreamSample) {
        const b = byId.get(p.id);
        if (!b) return;
        // a = right tilt, b = forward tilt (top edge away → the ball rolls up the screen).
        let tx = s.a / 1000;
        let ty = -s.b / 1000;
        const m = Math.hypot(tx, ty);
        if (m > T.tiltMax) {
          tx *= T.tiltMax / m;
          ty *= T.tiltMax / m;
        }
        b.tx = tx;
        b.ty = ty;
      },
      onLeave(p) {
        const b = byId.get(p.id);
        if (!b) return;
        b.present = false;
        checkEnd();
      },
      update(dt) {
        if (ended) return;
        const t = ctx.time;
        wobble = T.wobbleStart[h] + T.wobbleGrowth[h] * Math.pow(t, 1.5);
        const spin = T.wobbleSpin[h] * (1 + t / 20);
        const kS = 1 - Math.exp(-dt / T.tiltTau);
        const damp = Math.exp(-T.damping * dt);
        for (const b of balls) {
          if (!b.present || !b.alive) continue;
          b.sx += (b.tx - b.sx) * kS;
          b.sy += (b.ty - b.sy) * kS;
          b.wobAng += spin * dt * b.wobDir * (0.55 + 0.45 * Math.sin(t * 0.6 + b.wobPhase));
          const mag = wobble * (0.7 + 0.3 * Math.sin(t * 1.7 + b.wobPhase * 2));
          const ax = b.sx * T.accel + Math.cos(b.wobAng) * mag;
          const ay = b.sy * T.accel + Math.sin(b.wobAng) * mag;
          b.vx = (b.vx + ax * dt) * damp;
          b.vy = (b.vy + ay * dt) * damp;
          b.x += b.vx * dt;
          b.y += b.vy * dt;
          b.shake = Math.min(b.R * 0.05, mag * 2.2);
          const r = Math.hypot(b.x, b.y);
          if (r > T.danger) b.inDanger = true;
          else if (b.inDanger && r < T.saveBack) {
            b.inDanger = false;
            b.saves++;
          }
          if (r > T.rim) knockOut(b);
        }
        checkEnd();
        if (t >= endAt) {
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
            drawBackground(bg.getContext('2d')!);
          }
          g.drawImage(bg, 0, 0, STAGE_W, STAGE_H);
        } else drawBackground(g);

        const t = v.t;
        const alive = aliveCount();
        let champ: Ball | null = null;
        if (v.phase === 'results') {
          for (const b of balls) if (b.present && b.alive && (!champ || Math.hypot(b.x, b.y) < Math.hypot(champ.x, champ.y))) champ = b;
        }
        for (const b of balls) {
          if (!b.alive && b.outViewT < 0) b.outViewT = t - Math.max(0, ctx.time - b.outAt);
          if (!b.alive) drawSplat(g, b, Math.max(0, t - b.outViewT));
        }
        for (const b of balls) drawPlate(g, b, t);
        for (const b of balls) {
          const nameSize = clamp(b.R * 0.26, 26, 46);
          drawText(g, b.p.name, b.cx, b.cy + b.R * 1.1 + nameSize * 0.75, nameSize, b.present ? b.p.color : '#888', { maxWidth: b.R * 2.6 });
          if (b.alive) {
            const bx = b.cx + b.x * b.R;
            const by = b.cy + b.y * b.R;
            drawToken(g, b.p, bx, by, b.tokR, { label: false, dim: !b.present, ring: champ === b ? PAL.gold : undefined });
            if (champ === b) drawEmoji(g, '👑', bx, by - b.tokR * 1.55, b.tokR * 1.3);
          } else {
            const age = Math.max(0, t - b.outViewT);
            if (age < 0.7) {
              // the ball flies off the rim and falls (shrinks + fades)
              const k = age / 0.7;
              const bx = b.cx + (Math.cos(b.outAng) * T.rim + b.outVx * age * 0.6) * b.R;
              const by = b.cy + (Math.sin(b.outAng) * T.rim + b.outVy * age * 0.6) * b.R + k * k * b.R * 0.4;
              g.save();
              g.globalAlpha *= 1 - k;
              drawToken(g, b.p, bx, by, b.tokR * (1 - 0.55 * k), { label: false, rot: k * 6 });
              g.restore();
            }
            // OUT stamp
            const pop = ease.outBack(Math.min(1, 0.3 + age / 0.3));
            g.save();
            g.translate(b.cx, b.cy);
            g.rotate(-0.22);
            g.scale(pop, pop);
            const fs = clamp(b.R * 0.62, 40, 130);
            drawText(g, 'OUT', 0, -fs * 0.12, fs, OUT_RED, { outline: fs * 0.16 });
            drawText(g, `${b.outAt.toFixed(1)} s`, 0, fs * 0.6, fs * 0.36, '#ffffff');
            g.restore();
            drawToken(g, b.p, b.cx, b.cy - b.R * 0.62, Math.max(22, b.tokR * 0.7), { label: false, dim: true });
          }
        }
        // status line
        if (v.phase === 'results' && alive > 1) {
          drawText(g, `${alive} survivors — closest to the centre wins!`, STAGE_W / 2, 1040, 44, PAL.gold);
        } else if (v.phase !== 'count' && startCount > 1) {
          const txt = alive <= 1 ? (alive === 1 ? 'LAST BALL STANDING!' : 'ALL OUT!') : `${alive} balls left`;
          drawText(g, txt, STAGE_W / 2, 1040, 44, alive <= 1 ? PAL.gold : '#ffffff');
        } else if (v.phase === 'count') {
          drawText(g, 'Tilt your phone to roll your ball', STAGE_W / 2, 1040, 40, '#ffffff');
        }
        if (v.phase === 'play' && wobble > T.wobbleStart[h] * 2.5 && alive > 1) {
          const pulse = 0.6 + 0.4 * Math.sin(t * 8);
          drawText(g, 'WOBBLE ↑', STAGE_W - 150, 1040, 36, PAL.warn, { alpha: pulse });
        }
      },
      done() {
        return ended;
      },
      results(): MinigameResult {
        const end = ctx.time;
        const present = balls.filter((b) => b.present);
        const items = present.map((b) => {
          const surv = b.alive ? end : b.outAt;
          const r = b.alive ? Math.min(1, Math.hypot(b.x, b.y)) : 1;
          return { id: b.p.id, b, surv, score: Math.round(surv * 100) * 10 + (b.alive ? 9 * (1 - r) : 0) };
        });
        const ranked = rankBy(items, (x) => x.score);
        const ranking = ranked.map((x) => ({ id: x.id, place: x.place, stat: x.b.alive ? 'STILL ON!' : `OUT ${x.b.outAt.toFixed(1)} s` }));
        const sup: { id: string; text: string }[] = [];
        const win = ranked[0];
        if (win) sup.push({ id: win.id, text: 'Steady as a surgeon' });
        if (firstOut && byId.get(firstOut)?.present && firstOut !== win?.id) sup.push({ id: firstOut, text: 'Butterfingers' });
        const clutch = [...present].filter((b) => b.saves > 0 && b.p.id !== win?.id).sort((a, b) => b.saves - a.saves || (b.alive ? end : b.outAt) - (a.alive ? end : a.outAt))[0];
        if (clutch) sup.push({ id: clutch.p.id, text: clutch.saves > 1 ? `Clutch save ×${clutch.saves}` : 'Clutch save' });
        return { ranking, superlatives: sup };
      },
      botHint(id) {
        const b = byId.get(id);
        if (!b || !b.alive) return undefined;
        return [Math.round(b.x * 1000), Math.round(b.y * 1000)];
      },
      dispose() {
        bg = null;
      },
    };
  },
};
