/**
 * Quick Draw (MG1) — "Phone down… raise on DRAW!" — stream `pitch`, event `raise` (touch: tap).
 *
 * Best of 3 draws. Each draw: PHONES DOWN beat → random wait with TV-only fake-outs (fake words, a
 * tumbleweed, a crow, a bell) → DRAW (per-player phone cue fx 'go') → phone-measured reaction time.
 * Raising before DRAW = OUT for that draw. Score = average of the best 2 (OUT / miss = 1.5 s).
 */
import type { Minigame, MinigameCtx, MinigameDef, MinigameResult, RenderView, RushInputEvent, RushPlayer, StreamSample } from '../types';
import { STAGE_H, STAGE_W } from '../types';
import { PAL, clamp, clamp01, drawEmoji as drawEmojiRaw, drawText, drawToken, ease, lerp, rankBy, roundRect } from '../draw';
import { QUICK_DRAW as T } from '../tuning';

type Phase = 'pre' | 'holster' | 'wait' | 'draw' | 'reveal' | 'over';
type Kind = 'ok' | 'out' | 'miss';

interface Shot {
  kind: Kind;
  /** Seconds (OUT / miss = T.outSec). */
  t: number;
}

interface Cowboy {
  p: RushPlayer;
  idx: number;
  x: number;
  y: number;
  /** Latest pitch (tenths of a degree), null = no sample yet. */
  pitch: number | null;
  shots: (Shot | null)[];
  /** DRAW cue id issued to this player for the current draw (0 = none). */
  drawCue: number;
  /** Result for the current draw (null = still pending). */
  cur: Shot | null;
  early: number;
  /** Word override currently set on the phone. */
  word: string;
  /** Render time of the last result pop (animation). */
  popT: number;
}

type FakeKind = 'word' | 'tumbleweed' | 'crow' | 'bell';
interface Fake {
  at: number;
  kind: FakeKind;
  text: string;
  /** Render-time start (set when it fires). */
  t0: number;
  fired: boolean;
}

const FAKE_WORDS = ['DRAWER!', 'DRAMA!', 'DRAPES!', 'DRIZZLE!', 'DR... NOPE', 'BRAWL!', 'DRAWING?', 'DRACULA!', 'RAW!'];
const GREEN = '#22c55e';
const GROUND_Y = 690;

let desertLayer: HTMLCanvasElement | null | undefined;

export const quickDraw: MinigameDef = {
  meta: {
    id: 'quick-draw',
    name: 'Quick Draw',
    instr: 'Phone down… raise on DRAW!',
    word: 'WAIT…',
    demo: 'raise',
    minPlayers: 1,
    duration: [25, 22, 20],
    stream: 'pitch',
    events: ['raise'],
    touch: 'Tap on DRAW!',
    energetic: false,
    color: '#e8d27a',
    icon: '🤠',
  },
  create(): Minigame {
    let ctx!: MinigameCtx;
    const boys: Cowboy[] = [];
    const byId = new Map<string, Cowboy>();
    let phase: Phase = 'pre';
    let phaseAt = 0;
    let phaseEnd = 0;
    let drawIdx = 0;
    let waits: number[] = [];
    let fakes: Fake[] = [];
    let holsterSec = 1.2;
    let revealSec = 1.5;
    let drawAt = 0;
    let fastest: Cowboy | null = null;
    let lastViewT = 0;
    let drawFlashT = -10;
    let tokenR = 60;
    let rows = 1;
    /** Final standings (computed once the round is over), for the end-of-round TV state. */
    let final: Map<Cowboy, { place: number; avg: number; allOut: boolean }> | null = null;

    const present = (c: Cowboy): boolean => ctx.isPresent(c.p.id);
    const holstered = (c: Cowboy): boolean => c.p.touch || c.pitch === null || c.pitch <= T.downPitch;

    function setWord(c: Cowboy, w: string): void {
      if (c.word === w) return;
      c.word = w;
      ctx.word(c.p.id, w);
    }

    function enter(ph: Phase, len: number): void {
      phase = ph;
      phaseAt = ctx.time;
      phaseEnd = ctx.time + len;
    }

    function startHolster(): void {
      for (const c of boys) {
        c.cur = null;
        c.drawCue = 0;
        ctx.cue(c.p.id, null);
      }
      fastest = null;
      enter('holster', holsterSec);
    }

    function startWait(): void {
      const w = waits[drawIdx] ?? 2;
      enter('wait', w);
      // schedule fake-outs inside this wait
      fakes = [];
      const chance = T.fakeChance[ctx.heat - 1];
      for (let at = 0.7; at < w - T.fakeQuietBeforeDrawSec; at += T.fakeGapSec + ctx.rand() * 0.6) {
        if (ctx.rand() < chance) {
          const r = ctx.rand();
          const kind: FakeKind = r < 0.5 ? 'word' : r < 0.7 ? 'tumbleweed' : r < 0.87 ? 'crow' : 'bell';
          fakes.push({ at: phaseAt + at, kind, text: FAKE_WORDS[Math.floor(ctx.rand() * FAKE_WORDS.length) % FAKE_WORDS.length], t0: 0, fired: false });
        }
      }
    }

    function startDraw(): void {
      drawAt = ctx.time;
      drawFlashT = lastViewT;
      for (const c of boys) {
        if (!present(c) || c.cur) continue;
        c.drawCue = ctx.cue(c.p.id, { fx: 'go', word: 'DRAW!', bg: GREEN });
        setWord(c, '');
      }
      ctx.sfx('go');
      enter('draw', T.drawWindowSec);
    }

    function resolveDraw(): void {
      fastest = null;
      for (const c of boys) {
        if (!c.cur && c.drawCue && present(c)) {
          c.cur = { kind: 'miss', t: T.outSec };
          c.popT = lastViewT;
          ctx.cue(c.p.id, { fx: 'bad', word: 'TOO SLOW', bg: '#555b6e' });
        }
        if (c.cur) c.shots[drawIdx] = c.cur;
        if (c.cur?.kind === 'ok' && (!fastest || c.cur.t < (fastest.cur as Shot).t)) fastest = c;
      }
      if (fastest) ctx.sfx('ding');
      enter('reveal', revealSec);
    }

    function eligible(c: Cowboy): boolean {
      return present(c) && c.drawCue !== 0;
    }

    function onRaise(c: Cowboy, e: RushInputEvent): void {
      if (!present(c)) return;
      if (phase === 'wait') {
        if (c.cur || ctx.time - phaseAt < T.earlyGraceSec) return;
        out(c);
        return;
      }
      if (phase !== 'draw' || c.cur || !c.drawCue) return;
      if (e.cueId !== c.drawCue) {
        // raised before the DRAW cue reached the phone
        out(c);
        return;
      }
      const ms = e.ms ?? (ctx.time - drawAt) * 1000;
      const t = clamp(ms / 1000, 0.05, T.outSec);
      c.cur = { kind: 'ok', t };
      c.popT = lastViewT;
      ctx.cue(c.p.id, { fx: 'good', word: `${t.toFixed(2)} s`, bg: GREEN });
      ctx.sfx('thud', { pan: (c.x / STAGE_W) * 2 - 1, vol: 0.5 });
    }

    function out(c: Cowboy): void {
      c.cur = { kind: 'out', t: T.outSec };
      c.early++;
      c.popT = lastViewT;
      ctx.cue(c.p.id, { fx: 'bad', word: 'OUT', bg: PAL.bad });
      ctx.sfx('buzz', { pan: (c.x / STAGE_W) * 2 - 1, vol: 0.7 });
    }

    function score(c: Cowboy): { avg: number; n: number; allOut: boolean } {
      const ts: number[] = [];
      let ok = 0;
      const done = Math.min(drawIdx, T.draws);
      for (let i = 0; i < done; i++) {
        const s = c.shots[i];
        ts.push(s ? s.t : T.outSec);
        if (s?.kind === 'ok') ok++;
      }
      ts.sort((a, b) => a - b);
      const k = Math.min(T.countBest, ts.length);
      if (k === 0) return { avg: T.outSec, n: 0, allOut: true };
      let sum = 0;
      for (let i = 0; i < k; i++) sum += ts[i];
      return { avg: Math.round((sum / k) * 1000) / 1000, n: k, allOut: ok === 0 };
    }

    // ---------------------------------------------------------------- art
    function drawDesert(g: CanvasRenderingContext2D): void {
      const sky = g.createLinearGradient(0, 0, 0, GROUND_Y);
      sky.addColorStop(0, '#2a1450');
      sky.addColorStop(0.55, '#c2416b');
      sky.addColorStop(1, '#ff9a3c');
      g.fillStyle = sky;
      g.fillRect(0, 0, STAGE_W, GROUND_Y);
      // sun
      g.fillStyle = '#ffd36b';
      g.beginPath();
      g.arc(1480, GROUND_Y - 40, 170, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(255,211,107,0.25)';
      g.beginPath();
      g.arc(1480, GROUND_Y - 40, 230, 0, Math.PI * 2);
      g.fill();
      // mesas
      g.fillStyle = '#7a2c4a';
      g.beginPath();
      g.moveTo(0, GROUND_Y);
      g.lineTo(0, 560);
      g.lineTo(120, 540);
      g.lineTo(160, 470);
      g.lineTo(420, 470);
      g.lineTo(470, 560);
      g.lineTo(760, 600);
      g.lineTo(1100, 610);
      g.lineTo(1180, 520);
      g.lineTo(1390, 520);
      g.lineTo(1440, 600);
      g.lineTo(1920, 580);
      g.lineTo(1920, GROUND_Y);
      g.closePath();
      g.fill();
      // ground
      const gr = g.createLinearGradient(0, GROUND_Y, 0, STAGE_H);
      gr.addColorStop(0, '#d9893f');
      gr.addColorStop(1, '#8a4a22');
      g.fillStyle = gr;
      g.fillRect(0, GROUND_Y, STAGE_W, STAGE_H - GROUND_Y);
      g.fillStyle = 'rgba(90,40,10,0.25)';
      for (let i = 0; i < 40; i++) {
        const x = (i * 337) % STAGE_W;
        const y = GROUND_Y + 20 + ((i * 173) % (STAGE_H - GROUND_Y - 30));
        g.fillRect(x, y, 30 + (i % 4) * 14, 5);
      }
      // cacti
      const cactus = (x: number, y: number, s: number): void => {
        g.fillStyle = '#2f6b3a';
        roundRect(g, x - 16 * s, y - 150 * s, 32 * s, 150 * s, 16 * s);
        g.fill();
        roundRect(g, x - 60 * s, y - 110 * s, 22 * s, 60 * s, 11 * s);
        g.fill();
        g.fillRect(x - 60 * s, y - 62 * s, 50 * s, 18 * s);
        roundRect(g, x + 38 * s, y - 130 * s, 22 * s, 70 * s, 11 * s);
        g.fill();
        g.fillRect(x + 10 * s, y - 76 * s, 50 * s, 18 * s);
      };
      cactus(90, GROUND_Y + 30, 1.1);
      cactus(1840, GROUND_Y + 40, 1.3);
      cactus(700, GROUND_Y - 2, 0.55);
    }

    function background(g: CanvasRenderingContext2D): void {
      if (desertLayer === undefined) {
        desertLayer = null;
        if (typeof document !== 'undefined') {
          const cv = document.createElement('canvas');
          cv.width = STAGE_W;
          cv.height = STAGE_H;
          const cg = cv.getContext('2d');
          if (cg) {
            drawDesert(cg);
            desertLayer = cv;
          }
        }
      }
      if (desertLayer) g.drawImage(desertLayer, 0, 0);
      else drawDesert(g);
    }

    function hat(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
      g.fillStyle = '#5a3418';
      g.beginPath();
      g.ellipse(x, y, r * 1.05, r * 0.2, 0, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.moveTo(x - r * 0.55, y);
      g.quadraticCurveTo(x - r * 0.6, y - r * 0.75, x - r * 0.2, y - r * 0.62);
      g.quadraticCurveTo(x, y - r * 0.5, x + r * 0.2, y - r * 0.62);
      g.quadraticCurveTo(x + r * 0.6, y - r * 0.75, x + r * 0.55, y);
      g.closePath();
      g.fill();
      g.fillStyle = color;
      g.fillRect(x - r * 0.55, y - r * 0.18, r * 1.1, r * 0.13);
    }

    function chip(g: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, bg: string, fg = '#fff', alpha = 1): void {
      g.save();
      g.globalAlpha *= alpha;
      g.font = `900 ${Math.round(size)}px system-ui, sans-serif`;
      const w = Math.max(size * 2.2, text.length * size * 0.62) + size * 0.6;
      g.fillStyle = bg;
      roundRect(g, x - w / 2, y - size * 0.72, w, size * 1.44, size * 0.5);
      g.fill();
      g.restore();
      drawText(g, text, x, y, size, fg, { outline: 0, alpha });
    }

    function drawFakes(g: CanvasRenderingContext2D, t: number): void {
      for (const f of fakes) {
        if (!f.fired) continue;
        const dt = t - f.t0;
        if (f.kind === 'tumbleweed' && dt < 2.6) {
          const x = lerp(-120, STAGE_W + 120, dt / 2.6);
          const y = GROUND_Y + 40 - Math.abs(Math.sin(dt * 7)) * 50;
          g.save();
          g.translate(x, y);
          g.rotate(dt * 9);
          g.strokeStyle = '#9b6a2f';
          g.lineWidth = 6;
          for (let i = 0; i < 5; i++) {
            g.beginPath();
            g.ellipse(0, 0, 55 - i * 6, 40 + i * 4, i * 0.7, 0, Math.PI * 2);
            g.stroke();
          }
          g.restore();
        } else if (f.kind === 'crow' && dt < 2.4) {
          const x = lerp(STAGE_W + 100, -100, dt / 2.4);
          const y = 250 + Math.sin(dt * 3) * 30;
          const flap = Math.sin(dt * 18) * 30;
          g.strokeStyle = '#111';
          g.lineWidth = 12;
          g.lineCap = 'round';
          g.beginPath();
          g.moveTo(x - 60, y - flap);
          g.quadraticCurveTo(x - 25, y - 10, x, y + 5);
          g.quadraticCurveTo(x + 25, y - 10, x + 60, y - flap);
          g.stroke();
          g.fillStyle = '#111';
          g.beginPath();
          g.ellipse(x - 4, y + 8, 22, 14, 0, 0, Math.PI * 2);
          g.fill();
          if (dt < 1.2) drawText(g, 'CAW!', x, y - 70, 64, '#fff');
        } else if (f.kind === 'bell' && dt < 1.4) {
          emoji(g, '🔔', 960, 330, 150 + Math.sin(dt * 20) * 6, 1, Math.sin(dt * 14) * 0.5 * (1 - dt / 1.4));
          drawText(g, 'DING!', 960, 460, 80, PAL.gold, { alpha: clamp01(1.4 - dt) });
        }
      }
    }

    function banner(g: CanvasRenderingContext2D, t: number): void {
      const y = rows === 1 ? 300 : 245;
      if (phase === 'pre' || phase === 'holster') {
        drawText(g, 'PHONES DOWN 👇', 960, y, 110, '#fff');
        if (phase === 'holster' && drawIdx > 0) drawText(g, `DRAW ${drawIdx + 1} OF ${T.draws}`, 960, y + 100, 56, PAL.gold);
        return;
      }
      if (phase === 'wait') {
        // latest word fake wins the banner, else "wait for it…"
        let fw: Fake | null = null;
        for (const f of fakes) if (f.fired && f.kind === 'word' && t - f.t0 < 0.9) fw = f;
        if (fw) {
          const k = ease.outBack(clamp01((t - fw.t0) / 0.18));
          drawText(g, fw.text, 960, y, 200 * k, '#ffb020');
        } else {
          const dots = '.'.repeat(1 + (Math.floor(t * 2.5) % 3));
          drawText(g, `WAIT FOR IT${dots}`, 960, y, 96, '#fff', { alpha: 0.85 });
        }
        return;
      }
      if (phase === 'draw') {
        const k = ease.outBack(clamp01((t - drawFlashT) / 0.15));
        drawText(g, 'DRAW!', 960, y, 240 * k, GREEN, { outline: 22 });
        return;
      }
      if (final) {
        let win: Cowboy | null = null;
        for (const [c, f] of final) if (f.place === 1 && !f.allOut) win = c;
        if (win) drawText(g, `🏆 ${win.p.name}  ${(final.get(win) as { avg: number }).avg.toFixed(3)} s`, 960, y, 84, PAL.gold, { maxWidth: 1760 });
        else drawText(g, 'NOBODY! 🌵', 960, y, 96, '#fff');
        return;
      }
      if (phase === 'reveal' || phase === 'over') {
        if (fastest) {
          drawText(g, `FASTEST: ${fastest.p.name}  ${(fastest.cur as Shot).t.toFixed(3)} s`, 960, y, 76, PAL.gold, { maxWidth: 1760 });
        } else {
          drawText(g, 'NOBODY! 🌵', 960, y, 96, '#fff');
        }
      }
    }

    return {
      start(c) {
        ctx = c;
        const h = c.heat - 1;
        holsterSec = T.holsterSec[h];
        revealSec = T.revealSec[h];
        const [wMin, wMax] = T.waitSec[h];
        waits = [];
        let sum = 0;
        for (let i = 0; i < T.draws; i++) {
          const w = lerp(wMin, wMax, c.rand());
          waits.push(w);
          sum += w;
        }
        const budget = c.duration - 0.6 - T.draws * (holsterSec + T.drawWindowSec + revealSec);
        if (sum > budget) {
          const k = Math.max(0.3, budget / sum);
          waits = waits.map((w) => Math.max(1.2, w * k));
        }
        // layout: one row up to 8, else two rows
        const n = c.players.length;
        rows = n > 8 ? 2 : 1;
        const perRow = Math.ceil(n / rows);
        const span = 1760;
        const gap = span / perRow;
        tokenR = clamp(gap * 0.27, 30, 80);
        c.players.forEach((p, idx) => {
          const row = rows === 1 ? 0 : idx < perRow ? 0 : 1;
          const inRow = rows === 1 ? n : row === 0 ? perRow : n - perRow;
          const col = row === 0 ? idx : idx - perRow;
          const x = 80 + (STAGE_W - 160 - gap * inRow) / 2 + gap * (col + 0.5);
          const y = rows === 1 ? 640 : row === 0 ? 500 : 800;
          const cb: Cowboy = { p, idx, x, y, pitch: null, shots: [], drawCue: 0, cur: null, early: 0, word: '', popT: -10 };
          boys.push(cb);
          byId.set(p.id, cb);
        });
      },
      go() {
        drawIdx = 0;
        startHolster();
      },
      onStream(p, s: StreamSample) {
        const c = byId.get(p.id);
        if (c) c.pitch = s.a;
      },
      onEvent(p, e) {
        const c = byId.get(p.id);
        if (c && (e.k === 'raise' || e.k === 'tap')) onRaise(c, e);
      },
      onLeave(p) {
        const c = byId.get(p.id);
        if (c) ctx.cue(c.p.id, null);
      },
      update() {
        if (phase === 'pre' || phase === 'over') return;
        const now = ctx.time;
        // phone word: nag motion players whose phone isn't pointing down before DRAW
        if (phase === 'holster' || phase === 'wait') {
          for (const c of boys) if (present(c) && !c.cur) setWord(c, holstered(c) ? '' : 'POINT DOWN');
        }
        if (phase === 'wait') {
          for (const f of fakes) {
            if (!f.fired && now >= f.at) {
              f.fired = true;
              f.t0 = lastViewT;
              ctx.sfx(f.kind === 'tumbleweed' ? 'whoosh' : f.kind === 'crow' ? 'honk' : f.kind === 'bell' ? 'ding' : 'boing', { vol: 0.8 });
            }
          }
        }
        if (phase === 'draw') {
          let pending = 0;
          for (const c of boys) if (eligible(c) && !c.cur) pending++;
          if (pending === 0 && now - drawAt > 0.25) phaseEnd = Math.min(phaseEnd, now);
        }
        if (now < phaseEnd) return;
        if (phase === 'holster') startWait();
        else if (phase === 'wait') startDraw();
        else if (phase === 'draw') resolveDraw();
        else if (phase === 'reveal') {
          drawIdx++;
          if (drawIdx >= T.draws) {
            phase = 'over';
            for (const c of boys) setWord(c, '');
          } else startHolster();
        }
        if (!boys.some(present)) phase = 'over';
      },
      render(g, v: RenderView) {
        const t = v.t;
        lastViewT = t;
        if (!final && (phase === 'over' || v.phase === 'results')) {
          final = new Map();
          const ranked = rankBy(boys.filter(present).map((c) => ({ id: c.p.id, c, s: score(c) })), (x) => x.s.avg, true);
          for (const x of ranked) final.set(x.c, { place: x.place, avg: x.s.avg, allOut: x.s.allOut });
        }
        background(g);
        drawFakes(g, t);
        // DRAW flash
        const fl = t - drawFlashT;
        if (fl < 0.35) {
          g.fillStyle = `rgba(255,255,255,${0.55 * (1 - fl / 0.35)})`;
          g.fillRect(0, 0, STAGE_W, STAGE_H);
        }
        banner(g, t);
        const lblSize = Math.max(22, tokenR * 0.62);
        for (const c of boys) {
          const on = present(c);
          const isFast = final ? final.get(c)?.place === 1 : c === fastest && phase === 'reveal';
          const sway = phase === 'wait' ? Math.sin(t * 2 + c.idx) * 3 : 0;
          const jump = c.cur?.kind === 'ok' ? Math.max(0, 1 - (t - c.popT) * 4) * 20 : 0;
          g.fillStyle = '#000'; // emoji/touch badge alpha follows fillStyle
          drawToken(g, c.p, c.x + sway, c.y - jump, tokenR, { dim: !on, touchBadge: false, ring: isFast ? PAL.gold : c.cur?.kind === 'out' ? PAL.bad : undefined });
          hat(g, c.x + sway, c.y - jump - tokenR * 0.8, tokenR, c.p.color);
          if (c.p.touch) emoji(g, '👆', c.x + sway - tokenR * 0.95, c.y - jump - tokenR * 0.35, tokenR * 0.55, on ? 1 : 0.4);
          // status chip
          const sy = c.y + tokenR + lblSize * 1.6 + 16;
          const cs = clamp(tokenR * 0.5, 22, 38);
          const fin = final?.get(c);
          if (!on) {
            chip(g, 'AWAY', c.x, sy, cs, 'rgba(0,0,0,0.45)', '#bbb');
          } else if (fin) {
            const bg = fin.place === 1 ? '#b8860b' : fin.place === 2 ? '#6b7280' : fin.place === 3 ? '#9a5a2c' : 'rgba(0,0,0,0.55)';
            chip(g, fin.allOut ? 'OUT' : `#${fin.place} · ${fin.avg.toFixed(3)}`, c.x, sy, cs * 0.9, bg);
          } else if (c.cur) {
            const pop = ease.outBack(clamp01((t - c.popT) / 0.2));
            if (c.cur.kind === 'ok') chip(g, `${c.cur.t.toFixed(3)}`, c.x, sy, cs * (0.6 + 0.4 * pop), isFast ? '#b8860b' : '#15803d');
            else if (c.cur.kind === 'out') chip(g, 'TOO EARLY!', c.x, sy, cs * 0.85 * (0.6 + 0.4 * pop), PAL.bad);
            else chip(g, 'MISS', c.x, sy, cs, '#555b6e');
          } else if (phase === 'draw') {
            chip(g, '…', c.x, sy, cs, 'rgba(0,0,0,0.45)');
          } else if (phase === 'holster' || phase === 'wait' || phase === 'pre') {
            if (holstered(c)) chip(g, 'READY', c.x, sy, cs * 0.85, 'rgba(21,128,61,0.85)');
            else chip(g, '👇 DOWN!', c.x, sy, cs * 0.85, '#d97706', '#fff', Math.floor(t * 4) % 2 ? 1 : 0.6);
          }
          // draw history pips
          const py = sy + cs * 1.25 + 8;
          const ps = Math.max(18, cs * 0.6);
          for (let i = 0; i < T.draws; i++) {
            const s = c.shots[i];
            const px = c.x + (i - (T.draws - 1) / 2) * ps * 2.6;
            const txt = s ? (s.kind === 'ok' ? s.t.toFixed(2) : s.kind === 'out' ? '✗' : '–') : '·';
            drawText(g, txt, px, py, ps, s ? (s.kind === 'ok' ? '#fff' : '#ffb3b3') : 'rgba(255,255,255,0.5)', { outline: 4 });
          }
          if (isFast) emoji(g, '🏆', c.x + tokenR * 1.05, c.y - tokenR * 0.9, tokenR * 0.8);
        }
      },
      done() {
        return phase === 'over';
      },
      results(): MinigameResult {
        const live = boys.filter(present).map((c) => ({ id: c.p.id, c, s: score(c) }));
        const ranked = rankBy(live, (x) => x.s.avg, true);
        const ranking = ranked.map((x) => ({ id: x.id, place: x.place, stat: x.s.allOut ? 'OUT' : `${x.s.avg.toFixed(3)} s` }));
        const sup: { id: string; text: string }[] = [];
        if (ranked.length >= 2) sup.push({ id: ranked[ranked.length - 1].id, text: 'Slowest draw in the West 🐌' });
        let itchy: Cowboy | null = null;
        for (const x of live) if (x.c.early > 0 && (!itchy || x.c.early > itchy.early)) itchy = x.c;
        if (itchy && !sup.some((s) => s.id === itchy!.p.id)) sup.push({ id: itchy.p.id, text: 'Itchy trigger finger 🔫' });
        let best: { id: string; t: number } | null = null;
        for (const x of live) for (const s of x.c.shots) if (s?.kind === 'ok' && (!best || s.t < best.t)) best = { id: x.id, t: s.t };
        if (best && !sup.some((s) => s.id === best!.id)) sup.push({ id: best.id, text: `Fastest hand in the West 🤠 ${best.t.toFixed(3)} s` });
        return { ranking, superlatives: sup };
      },
    };
  },
};

/** Colour emoji glyphs pick up the fillStyle's alpha in Chrome: always draw them with an opaque fill. */
function emoji(g: CanvasRenderingContext2D, e: string, x: number, y: number, size: number, alpha = 1, rot = 0): void {
  g.save();
  g.fillStyle = '#000';
  if (rot) {
    g.translate(x, y);
    g.rotate(rot);
    drawEmojiRaw(g, e, 0, 0, size, alpha);
  } else drawEmojiRaw(g, e, x, y, size, alpha);
  g.restore();
}
