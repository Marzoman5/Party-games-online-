/**
 * Tug of War (MG3) — "PULL on the beat!". Two random balanced teams (re-rolled every round) pull a rope
 * over a mud pit. A drum beat fires a per-player cue (fx 'tick') every beat; a flick within ±windowMs of a
 * beat (judged from the phone-measured ms since the beat cue) is a strong pull, off-beat pulls are weak,
 * mashing is weaker still. Team force = mean member pull (odd counts normalised per player). The rope's
 * centre ribbon crossing a team's win line ends it; else whoever is ahead at the cap. Winners all place 1.
 */
import type { Minigame, MinigameCtx, MinigameDef, MinigameResult, RenderView, RushInputEvent, RushPlayer } from '../types';
import { STAGE_W } from '../types';
import { TEAM_COLORS } from '../../../net/protocol';
import { PAL, clamp, clamp01, drawText, drawToken, ease, lerp, roundRect } from '../draw';
import { TUG_OF_WAR as T } from '../tuning';

const CX = STAGE_W / 2;
/** Rope height on the stage. */
const ROPE_Y = 660;
/** How far the rope can travel (= distance from the centre to each team's win line). */
const SHIFT = 170;
/** Gap between the rope centre and each team's front puller. */
const FRONT = 195;
/** Max spread of one team along the rope. */
const SPREAD = 520;
const TEAM_NAMES = ['RED', 'BLUE'] as const;
const TEAM_DARK = ['#8a1f1f', '#1d4a9a'] as const;

interface TP {
  p: RushPlayer;
  team: 0 | 1;
  /** Position in the team line (0 = front, next to the mud). */
  slot: number;
  pulls: number;
  onBeat: number;
  /** Beat slot of the last pull + pulls counted in it. */
  beatSlot: number;
  slotCount: number;
  slotOn: boolean;
  lastPullT: number;
  lastStrength: number;
}

export const tugOfWar: MinigameDef = {
  meta: {
    id: 'tug-of-war',
    name: 'Tug of War',
    instr: 'PULL on the beat!',
    word: 'PULL!',
    demo: 'yank',
    minPlayers: 2,
    duration: [30, 26, 22],
    stream: null,
    events: ['flick'],
    touch: 'Tap on the beat!',
    energetic: true,
    color: '#b5652f',
    icon: '🪢',
  },
  create(): Minigame {
    let ctx!: MinigameCtx;
    const tps: TP[] = [];
    const byId = new Map<string, TP>();
    const teams: [TP[], TP[]] = [[], []];
    let period = 0.6;
    let gain = 0.1;
    let now = 0;
    let started = false;
    let nextBeatT = 0;
    let beatIdx = -1;
    let lastBeatT = -10;
    let firstBeatT = 0;
    /** cue id → beat index (all players' cues of one beat share the index). */
    const cueBeat = new Map<number, number>();
    /** Rope position: −1 = red wins, +1 = blue wins. */
    let pos = 0;
    let disp = 0;
    let winner: 0 | 1 | -1 | null = null;
    let finishT = 0;
    let lastPullFx = 0;
    let bg: HTMLCanvasElement | null = null;

    const presentCount = (t: 0 | 1): number => teams[t].filter((x) => ctx.isPresent(x.p.id)).length;

    const teamCue = (tp: TP, fx: 'tick' | 'none', word: string) =>
      ctx.cue(tp.p.id, { fx, word, bg: TEAM_COLORS[tp.team], hint: [Math.round(period * 1000), tp.team] }, true);

    const finish = (w: 0 | 1 | -1): void => {
      if (winner !== null) return;
      winner = w;
      finishT = now;
      if (w === -1) {
        ctx.shout("IT'S A DRAW!", { color: PAL.gold });
        return;
      }
      ctx.shout(`${TEAM_NAMES[w]} TEAM WINS!`, { color: TEAM_COLORS[w], ms: 1400 });
      ctx.sfx('splash', { pan: w === 0 ? 0.3 : -0.3 });
      ctx.sfx('crowd');
      for (const tp of tps) {
        if (!ctx.isPresent(tp.p.id)) continue;
        if (tp.team === w) ctx.cue(tp.p.id, { fx: 'win', word: 'YOU WIN!', bg: TEAM_COLORS[w] }, true);
        else ctx.cue(tp.p.id, { fx: 'bad', word: 'SPLASH!', bg: '#6b4a2a' }, true);
      }
    };

    /** Which beat slot a pull belongs to + whether it was on the beat. */
    const judge = (e: RushInputEvent): { slot: number; on: boolean } => {
      const k = e.cueId !== null ? cueBeat.get(e.cueId) : undefined;
      let rel: number;
      let base: number;
      if (k !== undefined && e.ms !== null) {
        rel = e.ms / 1000;
        base = k;
      } else {
        // No beat cue on the phone yet / unknown cue: fall back to host time vs the beat schedule.
        rel = e.at - firstBeatT;
        base = 0;
      }
      const n = Math.round(rel / period);
      const d = Math.abs(rel - n * period) * 1000;
      return { slot: base + n, on: d <= T.windowMs };
    };

    const pull = (tp: TP, e: RushInputEvent): void => {
      const j = judge(e);
      if (j.slot !== tp.beatSlot) {
        tp.beatSlot = j.slot;
        tp.slotCount = 0;
        tp.slotOn = false;
      }
      tp.slotCount++;
      let s: number;
      if (tp.slotCount > T.mashAfter) s = T.mash;
      else if (j.on && !tp.slotOn) {
        s = T.onBeat;
        tp.slotOn = true;
        tp.onBeat++;
      } else s = T.offBeat;
      tp.pulls++;
      tp.lastPullT = now;
      tp.lastStrength = s;
      const n = Math.max(1, presentCount(tp.team));
      pos += (tp.team === 1 ? 1 : -1) * (s / n) * gain;
      pos = clamp(pos, -1, 1);
      if (s >= T.onBeat && now - lastPullFx > 0.05) {
        lastPullFx = now;
        ctx.sfx('whoosh', { vol: 0.35, pan: tp.team === 0 ? -0.5 : 0.5 });
      }
      if (pos <= -1) finish(0);
      else if (pos >= 1) finish(1);
    };

    const tokenR = (m: number): number => (m <= 2 ? 56 : m <= 4 ? 50 : m <= 6 ? 46 : 43);

    const tokenPos = (tp: TP, shift: number): { x: number; y: number; r: number; above: boolean } => {
      const m = teams[tp.team].length;
      const sp = m > 1 ? Math.min(150, SPREAD / (m - 1)) : 0;
      const dir = tp.team === 0 ? -1 : 1;
      const x = CX + shift + dir * (FRONT + tp.slot * sp);
      const stagger = m >= 4;
      const above = tp.slot % 2 === 1;
      const y = stagger ? ROPE_Y + (above ? -58 : 58) : ROPE_Y;
      return { x, y, r: tokenR(m), above: stagger ? above : false };
    };

    const drawBgStatic = (g: CanvasRenderingContext2D): void => {
      // sky
      const sky = g.createLinearGradient(0, 0, 0, 560);
      sky.addColorStop(0, '#2b4fa8');
      sky.addColorStop(1, '#8fc6f0');
      g.fillStyle = sky;
      g.fillRect(0, 0, 1920, 560);
      // hills
      g.fillStyle = '#5aa64a';
      g.beginPath();
      g.moveTo(0, 520);
      for (let x = 0; x <= 1920; x += 60) g.lineTo(x, 500 - Math.sin(x / 260) * 40 - Math.sin(x / 97) * 12);
      g.lineTo(1920, 1080);
      g.lineTo(0, 1080);
      g.closePath();
      g.fill();
      // field
      const field = g.createLinearGradient(0, 540, 0, 1080);
      field.addColorStop(0, '#4c9a3c');
      field.addColorStop(1, '#2f6e27');
      g.fillStyle = field;
      g.fillRect(0, 545, 1920, 535);
      // grass stripes
      g.fillStyle = 'rgba(255,255,255,0.05)';
      for (let i = 0; i < 8; i++) g.fillRect(i * 240, 545, 120, 535);
      // mud pit
      g.fillStyle = '#4a2f16';
      g.beginPath();
      g.ellipse(CX, ROPE_Y + 40, SHIFT + 30, 95, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#6b4523';
      g.beginPath();
      g.ellipse(CX, ROPE_Y + 34, SHIFT + 10, 78, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(255,255,255,0.08)';
      g.beginPath();
      g.ellipse(CX - 40, ROPE_Y + 10, 90, 22, -0.1, 0, Math.PI * 2);
      g.fill();
      drawText(g, 'MUD', CX, ROPE_Y + 96, 34, '#c79a63', { outline: 4 });
      // win lines (posts + team flags)
      for (const t of [0, 1] as const) {
        const x = CX + (t === 0 ? -SHIFT : SHIFT);
        g.strokeStyle = '#ffffff';
        g.lineWidth = 6;
        g.setLineDash([16, 12]);
        g.beginPath();
        g.moveTo(x, ROPE_Y - 120);
        g.lineTo(x, ROPE_Y + 120);
        g.stroke();
        g.setLineDash([]);
        g.fillStyle = '#ddd';
        g.fillRect(x - 5, ROPE_Y - 190, 10, 80);
        g.fillStyle = TEAM_COLORS[t];
        g.beginPath();
        g.moveTo(x + 5, ROPE_Y - 190);
        g.lineTo(x + 5 + (t === 0 ? -70 : 70), ROPE_Y - 170);
        g.lineTo(x + 5, ROPE_Y - 150);
        g.closePath();
        g.fill();
        g.lineWidth = 3;
        g.strokeStyle = '#fff';
        g.stroke();
      }
    };

    const background = (g: CanvasRenderingContext2D): void => {
      if (typeof document === 'undefined') {
        drawBgStatic(g);
        return;
      }
      if (!bg) {
        bg = document.createElement('canvas');
        bg.width = 1920;
        bg.height = 1080;
        const bgc = bg.getContext('2d');
        if (bgc) drawBgStatic(bgc);
      }
      g.drawImage(bg, 0, 0, 1920, 1080);
    };

    const drawDrum = (g: CanvasRenderingContext2D, x: number, y: number, hit: number): void => {
      const s = 1 + 0.18 * (1 - ease.outCubic(hit));
      g.save();
      g.translate(x, y);
      g.scale(s, s);
      // glow
      if (hit < 1) {
        g.fillStyle = `rgba(255,210,58,${0.55 * (1 - hit)})`;
        g.beginPath();
        g.arc(0, 0, 120 + 60 * hit, 0, Math.PI * 2);
        g.fill();
      }
      // body
      g.fillStyle = '#c0392b';
      roundRect(g, -90, -20, 180, 80, 14);
      g.fill();
      g.strokeStyle = '#ffd23a';
      g.lineWidth = 6;
      g.beginPath();
      for (let i = 0; i <= 6; i++) {
        const xx = -90 + i * 30;
        g.moveTo(xx, -16);
        g.lineTo(xx + (i % 2 ? -15 : 15), 56);
      }
      g.stroke();
      // skin
      g.fillStyle = hit < 0.3 ? '#fffbe0' : '#f1e6c8';
      g.beginPath();
      g.ellipse(0, -20, 90, 26, 0, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#7a2a1e';
      g.lineWidth = 5;
      g.stroke();
      g.restore();
    };

    return {
      start(c) {
        ctx = c;
        period = T.beatSec[c.heat - 1];
        gain = T.pullGain[c.heat - 1];
        // random balanced teams (re-rolled every round)
        const order = [...c.players];
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(c.rand() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
        const first: 0 | 1 = c.rand() < 0.5 ? 0 : 1;
        order.forEach((p, i) => {
          const team = (i % 2 === 0 ? first : 1 - first) as 0 | 1;
          const tp: TP = { p, team, slot: teams[team].length, pulls: 0, onBeat: 0, beatSlot: -999, slotCount: 0, slotOn: false, lastPullT: -10, lastStrength: 0 };
          teams[team].push(tp);
          tps.push(tp);
          byId.set(p.id, tp);
        });
        for (const tp of tps) teamCue(tp, 'none', `TEAM ${TEAM_NAMES[tp.team]}`);
      },
      go() {
        started = true;
        firstBeatT = T.firstBeatSec;
        nextBeatT = firstBeatT;
      },
      onEvent(p, e) {
        if (winner !== null || !started) return;
        if (e.k !== 'flick' && e.k !== 'tap') return;
        const tp = byId.get(p.id);
        if (!tp || !ctx.isPresent(p.id)) return;
        pull(tp, e);
      },
      onLeave(p) {
        // Team force is normalised by present members, so the rope rebalances by itself.
        const tp = byId.get(p.id);
        if (!tp || winner !== null) return;
        const other = (1 - tp.team) as 0 | 1;
        if (presentCount(tp.team) === 0) finish(presentCount(other) > 0 ? other : -1);
      },
      update(dt) {
        now = ctx.time;
        disp = lerp(disp, pos, clamp01(dt * 9));
        if (winner !== null) return;
        if (started && now >= nextBeatT) {
          beatIdx++;
          lastBeatT = nextBeatT;
          nextBeatT += period;
          ctx.sfx('drum', { vol: 0.9 });
          for (const tp of tps) {
            if (!ctx.isPresent(tp.p.id)) continue;
            const id = teamCue(tp, 'tick', 'PULL!');
            cueBeat.set(id, beatIdx);
          }
          if (cueBeat.size > 2000) {
            // keep the map small on very long rounds
            for (const [k, v] of cueBeat) if (v < beatIdx - 8) cueBeat.delete(k);
          }
        }
      },
      render(g: CanvasRenderingContext2D, v: RenderView) {
        background(g);
        const shift = disp * SHIFT;
        const t = v.t;
        const over = winner !== null || v.phase === 'results';
        const wTeam: 0 | 1 | -1 = winner !== null ? winner : pos < 0 ? 0 : pos > 0 ? 1 : -1;
        const sinceEnd = winner !== null ? now - finishT : v.phase === 'results' ? 2 : 0;

        // team bands (top banners)
        for (const tm of [0, 1] as const) {
          const x0 = tm === 0 ? 40 : CX + 140;
          const w = CX - 180;
          g.fillStyle = TEAM_COLORS[tm];
          g.globalAlpha = 0.92;
          roundRect(g, x0, 130, w, 130, 28);
          g.fill();
          g.globalAlpha = 1;
          g.lineWidth = 6;
          g.strokeStyle = over && wTeam === tm ? PAL.gold : '#fff';
          g.stroke();
          const n = presentCount(tm);
          const label = over && wTeam === tm ? `${TEAM_NAMES[tm]} WINS!` : `${TEAM_NAMES[tm]} TEAM`;
          drawText(g, label, x0 + w / 2, 182, 70, '#fff', { outline: 8 });
          const big = Math.max(presentCount(0), presentCount(1));
          const boost = n > 0 && n < big ? `  ·  ×${(big / n).toFixed(1)} power` : '';
          drawText(g, `${n} player${n === 1 ? '' : 's'}${boost}`, x0 + w / 2, 236, 30, '#fff', { outline: 5 });
        }

        // tug meter between the banners
        {
          const mx0 = 360;
          const mx1 = 1560;
          const my = 330;
          g.fillStyle = 'rgba(0,0,0,0.35)';
          roundRect(g, mx0 - 10, my - 26, mx1 - mx0 + 20, 52, 26);
          g.fill();
          g.fillStyle = TEAM_DARK[0];
          roundRect(g, mx0, my - 16, (mx1 - mx0) / 2, 32, 16);
          g.fill();
          g.fillStyle = TEAM_DARK[1];
          roundRect(g, CX, my - 16, (mx1 - mx0) / 2, 32, 16);
          g.fill();
          const kx = CX + disp * ((mx1 - mx0) / 2);
          g.fillStyle = disp < 0 ? TEAM_COLORS[0] : TEAM_COLORS[1];
          if (Math.abs(disp) > 0.002) {
            roundRect(g, Math.min(CX, kx), my - 16, Math.abs(kx - CX), 32, 10);
            g.fill();
          }
          g.fillStyle = '#fff';
          g.fillRect(CX - 3, my - 22, 6, 44);
          g.beginPath();
          g.arc(kx, my, 24, 0, Math.PI * 2);
          g.fillStyle = '#ffd23a';
          g.fill();
          g.lineWidth = 5;
          g.strokeStyle = '#fff';
          g.stroke();
          drawText(g, '◀ RED', mx0 - 20, my, 34, TEAM_COLORS[0], { align: 'right', outline: 5 });
          drawText(g, 'BLUE ▶', mx1 + 20, my, 34, TEAM_COLORS[1], { align: 'left', outline: 5 });
        }

        // drum (beat pulse)
        const hit = started && winner === null ? clamp01((now - lastBeatT) / (period * 0.8)) : 1;
        drawDrum(g, CX, 440, hit);

        // rope
        const ends: [number, number] = [CX - FRONT - SPREAD - 80, CX + FRONT + SPREAD + 80];
        const m0 = teams[0].length;
        const m1 = teams[1].length;
        const sp0 = m0 > 1 ? Math.min(150, SPREAD / (m0 - 1)) : 0;
        const sp1 = m1 > 1 ? Math.min(150, SPREAD / (m1 - 1)) : 0;
        ends[0] = CX + shift - FRONT - (m0 - 1) * sp0 - 70;
        ends[1] = CX + shift + FRONT + (m1 - 1) * sp1 + 70;
        // team ground strips (who is on which team, at a glance)
        for (const tm of [0, 1] as const) {
          const xa = tm === 0 ? ends[0] - 20 : CX + shift + FRONT - 70;
          const xb = tm === 0 ? CX + shift - FRONT + 70 : ends[1] + 20;
          g.fillStyle = TEAM_COLORS[tm];
          g.globalAlpha = 0.38;
          roundRect(g, xa, ROPE_Y - 130, xb - xa, 260, 60);
          g.fill();
          g.globalAlpha = 1;
          g.lineWidth = 5;
          g.strokeStyle = TEAM_COLORS[tm];
          g.stroke();
        }
        g.lineCap = 'round';
        g.strokeStyle = '#6e4a22';
        g.lineWidth = 22;
        g.beginPath();
        g.moveTo(ends[0], ROPE_Y);
        g.lineTo(ends[1], ROPE_Y);
        g.stroke();
        g.strokeStyle = '#d9ad6a';
        g.lineWidth = 14;
        g.stroke();
        g.strokeStyle = '#a77a3d';
        g.lineWidth = 14;
        g.setLineDash([10, 14]);
        g.lineDashOffset = -shift;
        g.stroke();
        g.setLineDash([]);
        g.lineCap = 'butt';
        // centre ribbon
        {
          const rx = CX + shift;
          g.fillStyle = '#ffd23a';
          g.beginPath();
          g.moveTo(rx - 18, ROPE_Y - 4);
          g.lineTo(rx + 18, ROPE_Y - 4);
          g.lineTo(rx, ROPE_Y + 70 + Math.sin(t * 6) * 4);
          g.closePath();
          g.fill();
          g.lineWidth = 4;
          g.strokeStyle = '#fff';
          g.stroke();
        }

        // players
        for (const tp of tps) {
          const present = ctx.isPresent(tp.p.id);
          const tpos = tokenPos(tp, shift);
          let { x, y } = tpos;
          const dir = tp.team === 0 ? -1 : 1;
          const age = now - tp.lastPullT;
          const lean = present && age < 0.3 ? 1 - age / 0.3 : 0;
          x += dir * lean * 16;
          let rot = dir * lean * 0.35;
          let wobble = 0;
          if (over && wTeam !== -1) {
            if (tp.team === wTeam) y -= Math.abs(Math.sin(t * 7 + tp.slot)) * 26 * clamp01(sinceEnd * 2);
            else {
              wobble = 0.6 + 0.4 * Math.sin(t * 9 + tp.slot);
              rot = Math.sin(t * 5 + tp.slot) * 0.25;
            }
          }
          // arm to the rope
          g.strokeStyle = tp.p.color;
          g.lineWidth = 8;
          g.beginPath();
          g.moveTo(x, y);
          g.lineTo(x - dir * 22, ROPE_Y);
          g.stroke();
          g.fillStyle = TEAM_COLORS[tp.team];
          g.beginPath();
          g.arc(x, y, tpos.r + 11, 0, Math.PI * 2);
          g.fill();
          const ring = present && age < 0.45 && tp.lastStrength >= T.onBeat ? PAL.gold : undefined;
          drawToken(g, tp.p, x, y, tpos.r, { dim: !present, rot, wobble, ring, labelPos: tpos.above ? 'above' : 'below', labelScale: 0.95 });
          // mud on losers
          if (over && wTeam !== -1 && tp.team !== wTeam) {
            g.fillStyle = 'rgba(90,55,20,0.55)';
            g.beginPath();
            g.arc(x, y + tpos.r * 0.35, tpos.r * 0.75, 0, Math.PI);
            g.fill();
          }
          // pull pop
          if (present && age < 0.5) {
            const a = 1 - age / 0.5;
            const px = x + dir * (tpos.r + 22 + age * 30);
            const py = y - tpos.r * 0.5 - age * 40;
            if (tp.lastStrength >= T.onBeat) drawText(g, '★', px, py, 44, PAL.gold, { alpha: a, outline: 5 });
            else drawText(g, '+', px, py, 32, '#fff', { alpha: a * 0.7, outline: 4 });
          }
        }

        // beat lane: notes converge to the centre on each beat
        {
          const ly = 950;
          const half = 520;
          g.fillStyle = 'rgba(0,0,0,0.4)';
          roundRect(g, CX - half - 40, ly - 50, 2 * half + 80, 100, 50);
          g.fill();
          const glow = started && winner === null ? 1 - hit : 0;
          g.fillStyle = glow > 0 ? `rgba(255,210,58,${0.35 + 0.65 * glow})` : 'rgba(255,255,255,0.15)';
          g.beginPath();
          g.arc(CX, ly, 48 + glow * 14, 0, Math.PI * 2);
          g.fill();
          g.lineWidth = 6;
          g.strokeStyle = '#fff';
          g.stroke();
          if (started && winner === null) {
            for (let k = 0; k < 4; k++) {
              const tb = nextBeatT + k * period;
              const f = (tb - now) / (period * 3.2);
              if (f < 0 || f > 1) continue;
              for (const side of [-1, 1]) {
                g.fillStyle = side < 0 ? TEAM_COLORS[0] : TEAM_COLORS[1];
                g.beginPath();
                g.arc(CX + side * f * half, ly, 22, 0, Math.PI * 2);
                g.fill();
                g.lineWidth = 4;
                g.strokeStyle = '#fff';
                g.stroke();
              }
            }
          }
          drawText(g, winner !== null || v.phase === 'results' ? '🏁' : 'PULL!', CX, ly, glow > 0.4 ? 40 : 34, glow > 0.4 ? '#2a1400' : '#fff', { outline: glow > 0.4 ? 0 : 5 });
          if (!started || v.phase === 'count') drawText(g, 'Flick when the drum hits!', CX, ly - 82, 40, '#fff', { outline: 6 });
        }
      },
      done() {
        return winner !== null && now - finishT >= T.endDelaySec;
      },
      results(): MinigameResult {
        const w: 0 | 1 | -1 = winner !== null ? winner : pos < 0 ? 0 : pos > 0 ? 1 : -1;
        const present = tps.filter((tp) => ctx.isPresent(tp.p.id));
        const stat = (tp: TP): string => `${tp.pulls} pulls · ${tp.onBeat} on beat`;
        const sorted = [...present].sort((a, b) => {
          const pa = w === -1 || a.team === w ? 1 : 2;
          const pb = w === -1 || b.team === w ? 1 : 2;
          return pa - pb || b.onBeat - a.onBeat || b.pulls - a.pulls;
        });
        const ranking = sorted.map((tp) => ({ id: tp.p.id, place: w === -1 || tp.team === w ? 1 : 2, stat: stat(tp) }));
        const superlatives: { id: string; text: string }[] = [];
        const used = new Set<string>();
        const losers = present.filter((tp) => w !== -1 && tp.team !== w);
        // Dead weight: fewest pulls (prefer the losing side)
        const dwPool = losers.length ? losers : present;
        const dw = [...dwPool].sort((a, b) => a.pulls - b.pulls)[0];
        // Metronome: best timing (≥ 4 pulls)
        const met = [...present].filter((tp) => tp.pulls >= 4).sort((a, b) => b.onBeat / b.pulls - a.onBeat / a.pulls || b.onBeat - a.onBeat)[0];
        if (met && met.onBeat > 0) {
          superlatives.push({ id: met.p.id, text: `Metronome — ${Math.round((100 * met.onBeat) / met.pulls)}% on the beat` });
          used.add(met.p.id);
        }
        const rb = [...present].filter((tp) => !used.has(tp.p.id)).sort((a, b) => b.pulls - a.pulls)[0];
        if (rb && rb.pulls > 0) {
          superlatives.push({ id: rb.p.id, text: `Rope burn — ${rb.pulls} pulls` });
          used.add(rb.p.id);
        }
        if (dw && !used.has(dw.p.id) && present.length > 2) superlatives.push({ id: dw.p.id, text: dw.pulls === 0 ? 'Dead weight — zero pulls' : `Dead weight — only ${dw.pulls} pulls` });
        const headline = w === -1 ? "IT'S A DRAW!" : `${TEAM_NAMES[w]} TEAM WINS!`;
        return { ranking, superlatives, headline };
      },
      teamOf(id) {
        for (const t of [0, 1] as const) if (teams[t].some((x) => x.p.id === id)) return t;
        return undefined;
      },

      botHint(id) {
        const tp = byId.get(id);
        if (!tp) return undefined;
        return [Math.round(period * 1000), tp.team];
      },
      dispose() {
        bg = null;
      },
    };
  },
};
