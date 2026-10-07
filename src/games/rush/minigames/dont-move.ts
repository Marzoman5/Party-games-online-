/**
 * Don't Move! (MG1) — "Freeze! Don't move a muscle!" — stream `still`.
 *
 * Every player is frozen in an ice block; moving cracks the ice and wobbles the token, a seismograph
 * line shows the live movement. The TV throws silly distractions (honks, a sneeze, dancing emoji, a
 * chicken, a fly, a fake "you can move now", a ghost) to make people laugh. Least movement wins.
 * A phone resting on a table (`b = 1`) gets the cue "PICK IT UP!" and counts as moving a lot.
 */
import type { Minigame, MinigameCtx, MinigameDef, MinigameResult, RenderView, RushPlayer, StreamSample } from '../types';
import { HUD_H, STAGE_H, STAGE_W } from '../types';
import { PAL, clamp, clamp01, drawEmoji as drawEmojiRaw, drawText, drawToken, ease, gridCells, lerp, rankBy, roundRect, stageBackground } from '../draw';
import { DONT_MOVE as T } from '../tuning';

const BUF = 48;
const CRACKS = 9;

interface Statue {
  p: RushPlayer;
  idx: number;
  cx: number;
  cy: number;
  cw: number;
  ch: number;
  /** Smoothed movement 0..1 (display). */
  sm: number;
  raw: number;
  sum: number;
  n: number;
  maxA: number;
  table: boolean;
  tableCue: boolean;
  buf: Float32Array;
  bufPos: number;
  /** Crack polylines: CRACKS × 4 points × (x, y) in unit coordinates of the ice block. */
  cracks: Float32Array;
}

type DKind = 'honk' | 'sneeze' | 'dance' | 'chicken' | 'fly' | 'fake' | 'boo' | 'tickle';
interface Distraction {
  at: number;
  kind: DKind;
  len: number;
  started: boolean;
  stage2: boolean;
  /** Target statue (fly) / side (honk). */
  target: number;
  side: number;
}

const KINDS: DKind[] = ['honk', 'sneeze', 'dance', 'chicken', 'fly', 'fake', 'boo', 'tickle'];
const LEN: Record<DKind, number> = { honk: 1.3, sneeze: 1.9, dance: 2.6, chicken: 2.2, fly: 2.6, fake: 2.2, boo: 1.2, tickle: 2.0 };

export const dontMove: MinigameDef = {
  meta: {
    id: 'dont-move',
    name: "Don't Move!",
    instr: "Freeze! Don't move a muscle!",
    word: 'FREEZE!',
    demo: 'still',
    minPlayers: 1,
    duration: [15, 15, 15],
    stream: 'still',
    events: [],
    touch: 'Hold your thumb still!',
    energetic: false,
    color: '#5fd0ff',
    icon: '🧊',
  },
  create(): Minigame {
    let ctx!: MinigameCtx;
    const st: Statue[] = [];
    const byId = new Map<string, Statue>();
    const ds: Distraction[] = [];
    let tokenR = 50;
    let stillest: Statue | null = null;
    let stillAcc = 0;

    const present = (s: Statue): boolean => ctx.isPresent(s.p.id);
    const mean = (s: Statue): number => (s.n ? s.sum / s.n : 0);
    /** Wobble in movement-seconds (a/1000 · s) so far. */
    const wobble = (s: Statue): number => (mean(s) / 1000) * ctx.time;

    function startDistraction(d: Distraction): void {
      d.started = true;
      switch (d.kind) {
        case 'honk':
          ctx.sfx('honk', { pan: d.side, vol: 1 });
          break;
        case 'sneeze':
          ctx.sfx('crowd', { vol: 0.5 });
          break;
        case 'dance':
        case 'tickle':
          ctx.sfx('boing');
          break;
        case 'chicken':
          ctx.sfx('honk', { pitch: 1.6, pan: -1 });
          break;
        case 'fly':
          ctx.sfx('buzz', { vol: 0.4 });
          break;
        case 'fake':
          ctx.sfx('ding');
          break;
        case 'boo':
          ctx.sfx('boom', { vol: 0.5 });
          break;
      }
    }

    // ---------------------------------------------------------------- art
    function drawStatue(g: CanvasRenderingContext2D, s: Statue, t: number): void {
      const on = present(s);
      const size = Math.min(s.cw, s.ch);
      const iw = Math.min(s.cw * 0.82, s.ch * 1.15, size * 1.3);
      const ih = Math.min(s.ch * 0.66, iw * 0.95);
      const ix = s.cx - iw / 2;
      const iy = s.cy - s.ch / 2 + 10;
      const m = s.sm;
      const jx = on ? Math.sin(t * 37 + s.idx) * m * iw * 0.07 : 0;
      const jy = on ? Math.cos(t * 29 + s.idx * 2) * m * iw * 0.03 : 0;
      // ice block
      g.save();
      g.translate(jx * 0.4, 0);
      roundRect(g, ix, iy, iw, ih, 22);
      g.fillStyle = s.table ? 'rgba(255,194,26,0.35)' : 'rgba(170,225,255,0.28)';
      g.fill();
      g.lineWidth = 4;
      g.strokeStyle = 'rgba(220,245,255,0.8)';
      g.stroke();
      // frost shine
      g.fillStyle = 'rgba(255,255,255,0.25)';
      g.beginPath();
      g.moveTo(ix + iw * 0.08, iy + ih * 0.1);
      g.lineTo(ix + iw * 0.3, iy + ih * 0.1);
      g.lineTo(ix + iw * 0.12, iy + ih * 0.45);
      g.closePath();
      g.fill();
      g.restore();
      // token inside the ice
      const ty = iy + ih * 0.42;
      g.fillStyle = '#000'; // emoji/touch badge alpha follows fillStyle
      drawToken(g, s.p, s.cx + jx, ty + jy, tokenR, {
        dim: !on,
        wobble: clamp01(m * 1.6),
        rot: on ? Math.sin(t * 23 + s.idx) * m * 0.4 : 0,
        ring: s === stillest ? PAL.gold : undefined,
      });
      // cracks
      const frac = 1 - Math.exp(-wobble(s) / T.crackK);
      const nc = Math.min(CRACKS, Math.floor(frac * (CRACKS + 1)));
      if (nc > 0) {
        g.strokeStyle = 'rgba(255,255,255,0.9)';
        g.lineWidth = 3;
        g.lineJoin = 'round';
        g.beginPath();
        for (let k = 0; k < nc; k++) {
          const o = k * 8;
          g.moveTo(ix + s.cracks[o] * iw, iy + s.cracks[o + 1] * ih);
          for (let q = 1; q < 4; q++) g.lineTo(ix + s.cracks[o + q * 2] * iw, iy + s.cracks[o + q * 2 + 1] * ih);
        }
        g.stroke();
      }
      if (s === stillest) emoji(g, '👑', s.cx, iy + 6, Math.max(34, tokenR * 0.75));
      // seismograph
      const gy = iy + ih + 14;
      const gh = Math.max(26, Math.min(56, s.ch - ih - 30));
      g.fillStyle = 'rgba(0,0,0,0.35)';
      roundRect(g, ix, gy, iw, gh, 10);
      g.fill();
      g.strokeStyle = on ? s.p.color : '#777';
      g.lineWidth = 4;
      g.beginPath();
      for (let k = 0; k < BUF; k++) {
        const v = s.buf[(s.bufPos + k) % BUF];
        const x = ix + 8 + ((iw - 16) * k) / (BUF - 1);
        const amp = Math.min(1, v / 600) * (gh / 2 - 4) * (k % 2 ? 1 : -1);
        if (k === 0) g.moveTo(x, gy + gh / 2 + amp);
        else g.lineTo(x, gy + gh / 2 + amp);
      }
      g.stroke();
      if (s.table && on) {
        const blink = Math.floor(t * 4) % 2 === 0;
        drawText(g, '📵 PICK IT UP!', s.cx, iy + ih * 0.12, clamp(iw * 0.11, 22, 44), blink ? PAL.warn : '#fff', { maxWidth: iw - 10 });
      }
    }

    function drawDistraction(g: CanvasRenderingContext2D, d: Distraction, t: number, dt: number): void {
      const k = dt / d.len;
      const fade = clamp01(Math.min(dt / 0.15, (d.len - dt) / 0.25));
      switch (d.kind) {
        case 'honk': {
          const x = d.side < 0 ? 260 : STAGE_W - 260;
          emoji(g, '📯', x, 560, 220 + Math.sin(dt * 30) * 20, fade);
          drawText(g, 'HONK!', x, 760, 120 + Math.sin(dt * 25) * 12, PAL.warn, { alpha: fade });
          break;
        }
        case 'sneeze': {
          if (dt < 1.0) {
            const s = lerp(70, 150, dt);
            drawText(g, 'AAAH…', STAGE_W / 2, 560, s, '#fff', { alpha: fade });
          } else {
            const p = ease.outBack(clamp01((dt - 1.0) / 0.2));
            drawText(g, 'CHOO!!', STAGE_W / 2, 540, 240 * p, PAL.accent, { alpha: fade });
            emoji(g, '🤧', STAGE_W / 2, 760, 180 * p, fade);
          }
          break;
        }
        case 'dance': {
          for (let i = 0; i < 5; i++) {
            const x = lerp(-150, STAGE_W + 150, k) - i * 170;
            const y = STAGE_H - 120 - Math.abs(Math.sin(dt * 9 + i)) * 70;
            g.save();
            g.translate(x, y);
            g.rotate(Math.sin(dt * 12 + i) * 0.35);
            emoji(g, i % 2 ? '🕺' : '💃', 0, 0, 130, fade);
            g.restore();
          }
          drawText(g, 'DANCE BREAK? NO!', STAGE_W / 2, 560, 90, PAL.accent, { alpha: fade });
          break;
        }
        case 'chicken': {
          const x = lerp(-120, STAGE_W + 120, k);
          const y = STAGE_H - 120 - Math.abs(Math.sin(dt * 14)) * 40;
          emoji(g, '🐔', x, y, 150, 1);
          drawText(g, 'BAWK!', x, y - 120, 70, '#fff', { alpha: Math.floor(dt * 5) % 2 ? 1 : 0.3 });
          break;
        }
        case 'fly': {
          const s = st[d.target % Math.max(1, st.length)];
          if (!s) break;
          const r = tokenR * 1.3;
          const x = s.cx + Math.sin(dt * 7) * r + Math.sin(dt * 23) * 12;
          const y = s.cy - s.ch * 0.15 + Math.cos(dt * 9) * r * 0.7;
          emoji(g, '🪰', x, y, Math.max(46, tokenR * 0.8), fade);
          drawText(g, 'bzzzz', x + 50, y - 40, 34, '#fff', { alpha: fade * 0.8 });
          break;
        }
        case 'fake': {
          if (dt < 1.2) drawText(g, 'OK, YOU CAN MOVE NOW!', STAGE_W / 2, 560, 110, PAL.good, { alpha: fade, maxWidth: STAGE_W - 120 });
          else drawText(g, '…JUST KIDDING 😈', STAGE_W / 2, 560, 120, PAL.bad, { alpha: fade });
          break;
        }
        case 'boo': {
          const p = ease.outBack(clamp01(dt / 0.15));
          emoji(g, '👻', STAGE_W / 2, 580, 360 * p, fade);
          drawText(g, 'BOO!', STAGE_W / 2, 820, 160 * p, '#fff', { alpha: fade });
          break;
        }
        case 'tickle': {
          for (const s of st) {
            g.save();
            g.translate(s.cx + Math.min(s.cw, s.ch) * 0.3, s.cy - s.ch * 0.1);
            g.rotate(Math.sin(dt * 18 + s.idx) * 0.6);
            emoji(g, '🪶', 0, 0, Math.max(40, tokenR * 0.9), fade);
            g.restore();
          }
          drawText(g, 'TICKLE TICKLE!', STAGE_W / 2, 560, 110, PAL.warn, { alpha: fade });
          break;
        }
      }
    }

    return {
      start(c) {
        ctx = c;
        const n = c.players.length;
        const cells = gridCells(n, 60, HUD_H + 20, STAGE_W - 120, STAGE_H - HUD_H - 40);
        const cell0 = cells[0];
        tokenR = clamp(Math.min(cell0.w, cell0.h) * 0.17, 28, 76);
        c.players.forEach((p, idx) => {
          const cell = cells[idx];
          const cracks = new Float32Array(CRACKS * 8);
          for (let k = 0; k < CRACKS; k++) {
            // start on an edge-ish point, zig-zag inward
            const a = c.rand() * Math.PI * 2;
            let x = 0.5 + Math.cos(a) * 0.5;
            let y = 0.5 + Math.sin(a) * 0.5;
            for (let q = 0; q < 4; q++) {
              cracks[k * 8 + q * 2] = clamp01(x);
              cracks[k * 8 + q * 2 + 1] = clamp01(y);
              x += (0.5 - x) * 0.3 + (c.rand() - 0.5) * 0.18;
              y += (0.5 - y) * 0.3 + (c.rand() - 0.5) * 0.18;
            }
          }
          const s: Statue = { p, idx, cx: cell.cx, cy: cell.cy, cw: cell.w, ch: cell.h, sm: 0, raw: 0, sum: 0, n: 0, maxA: 0, table: false, tableCue: false, buf: new Float32Array(BUF), bufPos: 0, cracks };
          st.push(s);
          byId.set(p.id, s);
        });
        // distraction schedule (no immediate repeats)
        const every = T.distractEverySec[c.heat - 1];
        let at = T.distractFromSec + c.rand() * 0.6;
        let prev: DKind | null = null;
        while (at < c.duration - 1.6) {
          let kind = KINDS[Math.floor(c.rand() * KINDS.length) % KINDS.length];
          if (kind === prev) kind = KINDS[(KINDS.indexOf(kind) + 1) % KINDS.length];
          prev = kind;
          const len = LEN[kind];
          ds.push({ at, kind, len, started: false, stage2: false, target: Math.floor(c.rand() * 64), side: c.rand() < 0.5 ? -1 : 1 });
          at += Math.max(len + 0.3, every * (0.65 + c.rand() * 0.7));
        }
      },
      onStream(p, smp: StreamSample) {
        const s = byId.get(p.id);
        if (!s || !present(s)) return;
        const table = smp.b === 1;
        let a = clamp(smp.a, 0, 1000);
        if (table) a = Math.max(a, T.tableMovement);
        if (a < T.noiseFloor) a = 0;
        s.raw = a;
        s.sum += a;
        s.n++;
        s.maxA = Math.max(s.maxA, a);
        s.buf[s.bufPos] = a;
        s.bufPos = (s.bufPos + 1) % BUF;
        if (table !== s.table) {
          s.table = table;
          if (table && !s.tableCue) {
            s.tableCue = true;
            ctx.cue(s.p.id, { fx: 'buzz', word: 'PICK IT UP!', bg: PAL.warn });
          } else if (!table && s.tableCue) {
            s.tableCue = false;
            ctx.cue(s.p.id, null);
          }
        }
      },
      onLeave(p) {
        const s = byId.get(p.id);
        if (s && s.tableCue) {
          s.tableCue = false;
          ctx.cue(s.p.id, null);
        }
      },
      update(dt) {
        const k = 1 - Math.exp(-dt / T.smoothTau);
        for (const s of st) {
          s.sm += (s.raw / 1000 - s.sm) * k;
          // a silent stream (dropped phone) decays the display, not the score
          s.raw *= 0.97;
        }
        for (const d of ds) {
          if (!d.started && ctx.time >= d.at) startDistraction(d);
          if (d.started && !d.stage2 && d.kind === 'sneeze' && ctx.time - d.at >= 1.0) {
            d.stage2 = true;
            ctx.sfx('pop', { vol: 1 });
          }
        }
        stillAcc += dt;
        if (stillAcc > 0.5 && ctx.time > 2) {
          stillAcc = 0;
          let best: Statue | null = null;
          for (const s of st) if (present(s) && s.n > 10 && (!best || mean(s) < mean(best))) best = s;
          stillest = best;
        }
      },
      render(g, v: RenderView) {
        const t = v.t;
        stageBackground(g, '#0f3b5c', '#081526');
        // snowflakes (cheap, deterministic)
        g.fillStyle = 'rgba(255,255,255,0.35)';
        for (let i = 0; i < 40; i++) {
          const x = (i * 211 + t * (10 + (i % 5) * 6)) % STAGE_W;
          const y = (i * 97 + t * (30 + (i % 7) * 8)) % STAGE_H;
          g.fillRect(x, y, 5, 5);
        }
        for (const s of st) drawStatue(g, s, t);
        const now = ctx.time;
        for (const d of ds) {
          const dt = now - d.at;
          if (v.phase === 'play' && d.started && dt >= 0 && dt < d.len) drawDistraction(g, d, t, dt);
        }
        if (v.phase === 'count') {
          g.fillStyle = 'rgba(8,21,38,0.55)';
          g.fillRect(0, 470, STAGE_W, 200);
          drawText(g, "🧊 FREEZE! DON'T MOVE! 🧊", STAGE_W / 2, 570, 100, '#bfeaff');
        }
      },
      done() {
        return false;
      },
      results(): MinigameResult {
        const live = st.filter(present).map((s) => ({ id: s.p.id, s, m: s.n ? Math.round(mean(s) * 10) / 10 : 1e9 }));
        const ranked = rankBy(live, (x) => x.m, true);
        const ranking = ranked.map((x) => ({
          id: x.id,
          place: x.place,
          stat: x.s.n ? `${Math.max(0, Math.round(100 - mean(x.s) / 5))}% still` : 'no signal',
        }));
        const sup: { id: string; text: string }[] = [];
        if (ranked.length >= 2) {
          sup.push({ id: ranked[ranked.length - 1].id, text: 'Jelly legs 🍮' });
          let spike: { id: string; v: number } | null = null;
          for (const x of live) if (x.s.maxA > 150 && (!spike || x.s.maxA > spike.v)) spike = { id: x.id, v: x.s.maxA };
          if (spike && !sup.some((s) => s.id === spike!.id)) sup.push({ id: spike.id, text: 'Sneezed 🤧 biggest twitch' });
          if (!sup.some((s) => s.id === ranked[0].id)) sup.push({ id: ranked[0].id, text: 'Human statue 🗿' });
        } else if (ranked.length === 1) sup.push({ id: ranked[0].id, text: 'Human statue 🗿' });
        return { ranking, superlatives: sup };
      },
    };
  },
};

/** Colour emoji glyphs pick up the fillStyle's alpha in Chrome: always draw them with an opaque fill. */
function emoji(g: CanvasRenderingContext2D, e: string, x: number, y: number, size: number, alpha = 1): void {
  g.fillStyle = '#000';
  drawEmojiRaw(g, e, x, y, size, alpha);
}
