/**
 * Fishing (MG3) — "Flick to cast. Buzz? YANK!". Per-player loop on a shared pond: flick = cast → random
 * wait → bite (cue fx 'buzz', show 'fish', word 'YANK!') → flick within a generous window (phone-measured
 * ms since the bite cue) = hooked → shake to reel (shake stream energy fills the reel) → the fish lands
 * (weight, or the odd boot) → cast again. Yanking with no bite scares the fish for a moment.
 * Highest total weight wins. Players stand in a ring around the pond (16 fit).
 */
import type { Minigame, MinigameCtx, MinigameDef, MinigameResult, RenderView, RushInputEvent, RushPlayer, StreamSample } from '../types';
import { PAL, clamp, clamp01, drawEmoji, drawText, drawToken, ease, lerp, rankBy, roundRect } from '../draw';
import { FISHING as T } from '../tuning';

const CX = 960;
const CY = 595;
/** Shore ring (player spots). */
const SRX = 820;
const SRY = 370;
/** Water. */
const PRX = 650;
const PRY = 262;

/** Bot/phone state codes (cue.hint[0]). */
const ST_CODE = { idle: 0, cast: 1, wait: 1, bite: 2, reel: 3, land: 4 } as const;
type St = keyof typeof ST_CODE;

interface FishKind {
  name: string;
  color: string;
  belly: string;
  min: number;
  max: number;
  w: number;
  /** Drawn length (stage units). */
  len: number;
}
const FISH: FishKind[] = [
  { name: 'Minnow', color: '#9fd8e8', belly: '#e8f8ff', min: 0.1, max: 0.4, w: 30, len: 50 },
  { name: 'Perch', color: '#e8c23a', belly: '#fff2b0', min: 0.5, max: 1.2, w: 28, len: 64 },
  { name: 'Trout', color: '#ff8a7a', belly: '#ffe0d8', min: 1.2, max: 2.5, w: 20, len: 80 },
  { name: 'Bass', color: '#6fbf5a', belly: '#d8f5c8', min: 2.5, max: 4.5, w: 12, len: 96 },
  { name: 'Giant Catfish', color: '#9b7bd8', belly: '#e6dcff', min: 4.5, max: 8, w: 5, len: 120 },
];

interface Catch {
  kind: number; // -1 = boot
  kg: number;
}

interface FP {
  p: RushPlayer;
  ang: number;
  tx: number;
  ty: number;
  bx: number;
  by: number;
  st: St;
  stT: number;
  castT: number;
  biteAt: number;
  biteT: number;
  biteCue: number;
  scaredUntil: number;
  energy: number;
  reel: number;
  fish: Catch | null;
  quick: boolean;
  total: number;
  fishN: number;
  boots: number;
  biggest: number;
  early: number;
  misses: number;
  last: Catch | null;
  /** Transient word on the phone until this time, then the state word comes back. */
  msgUntil: number;
}

export function drawFish(g: CanvasRenderingContext2D, kind: number, x: number, y: number, len: number, rot = 0, flap = 0): void {
  if (kind < 0) {
    drawEmoji(g, '👢', x, y, len * 0.9);
    return;
  }
  const k = FISH[kind];
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  const L = len;
  const H = len * 0.42;
  // tail
  g.fillStyle = k.color;
  g.strokeStyle = '#1a1033';
  g.lineWidth = Math.max(3, L * 0.05);
  g.beginPath();
  g.moveTo(-L * 0.38, 0);
  g.lineTo(-L * 0.62, -H * 0.6 + flap * H * 0.3);
  g.lineTo(-L * 0.62, H * 0.6 + flap * H * 0.3);
  g.closePath();
  g.fill();
  g.stroke();
  // body
  g.beginPath();
  g.ellipse(0, 0, L * 0.45, H / 2, 0, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.fillStyle = k.belly;
  g.beginPath();
  g.ellipse(L * 0.02, H * 0.15, L * 0.33, H * 0.22, 0, 0, Math.PI * 2);
  g.fill();
  // eye
  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(L * 0.25, -H * 0.1, H * 0.16, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#1a1033';
  g.beginPath();
  g.arc(L * 0.28, -H * 0.1, H * 0.08, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

export const fishing: MinigameDef = {
  meta: {
    id: 'fishing',
    name: 'Fishing',
    instr: 'Flick to cast. See YANK? Flick! Then shake.',
    word: 'CAST!',
    demo: 'cast',
    minPlayers: 1,
    duration: [40, 36, 32],
    stream: 'shake',
    events: ['flick'],
    touch: 'Tap to cast & hook!',
    energetic: false,
    color: '#3d8bff',
    icon: '🎣',
  },
  create(): Minigame {
    let ctx!: MinigameCtx;
    const fps: FP[] = [];
    const byId = new Map<string, FP>();
    let now = 0;
    let started = false;
    let heatIdx = 0;
    let bg: HTMLCanvasElement | null = null;
    /** Decorative fish shadows. */
    const shadows: { a: number; r: number; sp: number; len: number }[] = [];

    const rnd = (a: number, b: number): number => a + (b - a) * ctx.rand();

    const stateCue = (fp: FP, fire: boolean, fx: 'none' | 'go' | 'tick' | 'good' | 'bad' | 'buzz' | 'win' = 'none', word?: string): number => {
      const code = ST_CODE[fp.st];
      const w = word ?? (fp.st === 'idle' ? 'CAST!' : fp.st === 'reel' ? 'SHAKE!' : fp.st === 'bite' ? 'YANK!' : fp.st === 'land' ? 'NICE!' : 'WAIT…');
      const show = fp.st === 'bite' || fp.st === 'reel' || fp.st === 'land' ? 'fish' : undefined;
      return ctx.cue(fp.p.id, { fx, word: w, show, v: fp.st === 'reel' ? clamp01(fp.reel) : undefined, hint: [code] }, fire);
    };

    const scheduleBite = (fp: FP, from: number): void => {
      const [a, b] = T.waitSec[heatIdx];
      fp.biteAt = from + rnd(a, b);
    };

    const cast = (fp: FP): void => {
      fp.st = 'cast';
      fp.stT = now;
      fp.castT = now;
      scheduleBite(fp, now + T.castFlySec);
      ctx.sfx('whoosh', { vol: 0.5, pan: (fp.tx - CX) / CX });
      stateCue(fp, false);
    };

    const rollCatch = (quick: boolean): Catch => {
      if (ctx.rand() < T.bootChance) return { kind: -1, kg: 0 };
      let tot = 0;
      for (const f of FISH) tot += f.w;
      let r = ctx.rand() * tot;
      let kind = 0;
      for (let i = 0; i < FISH.length; i++) {
        r -= FISH[i].w;
        if (r <= 0) {
          kind = i;
          break;
        }
      }
      const f = FISH[kind];
      let kg = rnd(f.min, f.max);
      if (quick) kg *= T.quickBonus;
      return { kind, kg: Math.round(kg * 10) / 10 };
    };

    const hook = (fp: FP, ms: number): void => {
      fp.quick = ms <= T.quickYankMs;
      fp.fish = rollCatch(fp.quick);
      fp.st = 'reel';
      fp.stT = now;
      fp.reel = 0;
      fp.msgUntil = 0;
      stateCue(fp, true, 'good', 'SHAKE!');
      ctx.sfx('reel', { pan: (fp.tx - CX) / CX });
    };

    const land = (fp: FP): void => {
      const c = fp.fish!;
      fp.last = c;
      if (c.kind < 0) fp.boots++;
      else {
        fp.fishN++;
        fp.total += c.kg;
        fp.biggest = Math.max(fp.biggest, c.kg);
      }
      fp.fish = null;
      fp.st = 'land';
      fp.stT = now;
      stateCue(fp, true, c.kind < 0 ? 'bad' : 'win', c.kind < 0 ? 'A BOOT!' : `${c.kg.toFixed(1)} KG!`);
      ctx.sfx(c.kind < 0 ? 'boing' : 'ding', { pan: (fp.tx - CX) / CX });
      if (c.kind === FISH.length - 1) ctx.shout(`${fp.p.name}: GIANT CATCH!`, { color: fp.p.color, size: 0.55 });
    };

    const yank = (fp: FP, e: RushInputEvent): void => {
      switch (fp.st) {
        case 'idle':
          cast(fp);
          return;
        case 'cast':
        case 'wait': {
          if (now - fp.castT < T.castGraceSec) return; // follow-through of the cast itself
          // yank with no bite: the fish get scared
          fp.early++;
          fp.scaredUntil = now + T.scareSec;
          fp.biteAt = Math.max(fp.biteAt, now + T.scareSec + rnd(0.3, 1.2));
          fp.msgUntil = now + 1;
          stateCue(fp, true, 'bad', 'TOO SOON!');
          ctx.sfx('splash', { vol: 0.4, pan: (fp.tx - CX) / CX });
          return;
        }
        case 'bite': {
          // a gesture the phone made before it saw the bite cue doesn't count either way
          if (e.cueId !== null && e.cueId !== fp.biteCue) return;
          const ms = e.ms !== null && e.cueId === fp.biteCue ? e.ms : (now - fp.biteT) * 1000;
          if (ms <= T.biteWindowMs) hook(fp, ms);
          return;
        }
        default:
          return; // reeling / landing: ignore flicks (shaking makes plenty)
      }
    };

    const drawBgStatic = (g: CanvasRenderingContext2D): void => {
      const sky = g.createLinearGradient(0, 0, 0, 1080);
      sky.addColorStop(0, '#2f7a3a');
      sky.addColorStop(1, '#1d5a2a');
      g.fillStyle = sky;
      g.fillRect(0, 0, 1920, 1080);
      // grass tufts
      g.fillStyle = 'rgba(255,255,255,0.05)';
      for (let i = 0; i < 90; i++) {
        const x = (i * 197) % 1920;
        const y = 120 + ((i * 331) % 960);
        g.beginPath();
        g.ellipse(x, y, 30, 10, 0, 0, Math.PI * 2);
        g.fill();
      }
      // sand ring
      g.fillStyle = '#d8b878';
      g.beginPath();
      g.ellipse(CX, CY, PRX + 70, PRY + 60, 0, 0, Math.PI * 2);
      g.fill();
      // water
      const wg = g.createRadialGradient(CX, CY, 40, CX, CY, PRX);
      wg.addColorStop(0, '#0d3f86');
      wg.addColorStop(0.7, '#1a66b8');
      wg.addColorStop(1, '#3fa4e0');
      g.fillStyle = wg;
      g.beginPath();
      g.ellipse(CX, CY, PRX, PRY, 0, 0, Math.PI * 2);
      g.fill();
      g.lineWidth = 8;
      g.strokeStyle = '#9fe0ff';
      g.stroke();
      // lily pads + reeds
      const pads = [
        [0.78, 0.6],
        [2.4, 0.75],
        [3.9, 0.7],
        [5.3, 0.8],
      ];
      for (const [a, f] of pads) {
        const x = CX + Math.cos(a) * PRX * f;
        const y = CY + Math.sin(a) * PRY * f;
        g.fillStyle = '#3a9a48';
        g.beginPath();
        g.arc(x, y, 26, 0.3, Math.PI * 2 - 0.1);
        g.lineTo(x, y);
        g.closePath();
        g.fill();
      }
      g.strokeStyle = '#2d6b2f';
      g.lineWidth = 5;
      for (let i = 0; i < 26; i++) {
        const a = (i / 26) * Math.PI * 2 + 0.11;
        if (i % 3 === 0) continue;
        const x = CX + Math.cos(a) * (PRX + 30);
        const y = CY + Math.sin(a) * (PRY + 28);
        for (let k = -1; k <= 1; k++) {
          g.beginPath();
          g.moveTo(x + k * 8, y + 10);
          g.quadraticCurveTo(x + k * 12, y - 20, x + k * 16, y - 36 - (k === 0 ? 10 : 0));
          g.stroke();
        }
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
        const c = bg.getContext('2d');
        if (c) drawBgStatic(c);
      }
      g.drawImage(bg, 0, 0, 1920, 1080);
    };

    const tokenR = (): number => {
      const n = fps.length;
      return n <= 4 ? 52 : n <= 8 ? 46 : n <= 12 ? 42 : 38;
    };

    return {
      start(c) {
        ctx = c;
        heatIdx = c.heat - 1;
        const n = c.players.length;
        c.players.forEach((p, i) => {
          // evenly around the ring, first spot at the bottom; small groups spread over the near side
          const span = n <= 3 ? Math.PI * 1.25 : Math.PI * 2;
          const ang = n <= 3 ? Math.PI / 2 - span / 2 + (span * (i + 0.5)) / n : Math.PI / 2 + (i * span) / n;
          const tx = CX + Math.cos(ang) * SRX;
          const ty = CY + Math.sin(ang) * SRY;
          const bf = 0.6 + 0.08 * Math.sin(i * 2.3);
          const fp: FP = {
            p,
            ang,
            tx,
            ty,
            bx: CX + Math.cos(ang) * PRX * bf,
            by: CY + Math.sin(ang) * PRY * bf,
            st: 'idle',
            stT: 0,
            castT: -10,
            biteAt: 0,
            biteT: 0,
            biteCue: -1,
            scaredUntil: 0,
            energy: 0,
            reel: 0,
            fish: null,
            quick: false,
            total: 0,
            fishN: 0,
            boots: 0,
            biggest: 0,
            early: 0,
            misses: 0,
            last: null,
            msgUntil: 0,
          };
          fps.push(fp);
          byId.set(p.id, fp);
          stateCue(fp, false);
        });
        for (let i = 0; i < 7; i++) shadows.push({ a: c.rand() * Math.PI * 2, r: 0.2 + c.rand() * 0.5, sp: (0.1 + c.rand() * 0.2) * (c.rand() < 0.5 ? -1 : 1), len: 50 + c.rand() * 50 });
      },
      go() {
        started = true;
        for (const fp of fps) {
          fp.stT = 0;
          if (ctx.isPresent(fp.p.id)) stateCue(fp, true, 'go', 'CAST!');
        }
      },
      onStream(p, s: StreamSample) {
        const fp = byId.get(p.id);
        if (!fp) return;
        fp.energy = lerp(fp.energy, clamp(s.a, 0, 1000), 0.6);
      },
      onEvent(p, e) {
        if (!started) return;
        if (e.k !== 'flick' && e.k !== 'tap') return;
        const fp = byId.get(p.id);
        if (!fp || !ctx.isPresent(p.id)) return;
        yank(fp, e);
      },
      onLeave(p) {
        // drop their line: nothing else depends on it
        const fp = byId.get(p.id);
        if (!fp) return;
        fp.st = 'idle';
        fp.fish = null;
        fp.reel = 0;
      },
      update(dt) {
        now = ctx.time;
        if (!started) return;
        for (const fp of fps) {
          if (!ctx.isPresent(fp.p.id)) continue;
          switch (fp.st) {
            case 'idle':
              if (now - fp.stT >= T.autoCastSec) cast(fp);
              break;
            case 'cast':
              if (now - fp.stT >= T.castFlySec) {
                fp.st = 'wait';
                fp.stT = now;
                ctx.sfx('splash', { vol: 0.25, pan: (fp.tx - CX) / CX });
              }
              break;
            case 'wait':
              if (now >= fp.biteAt) {
                fp.st = 'bite';
                fp.biteT = now;
                fp.msgUntil = 0;
                fp.biteCue = ctx.cue(fp.p.id, { fx: 'buzz', show: 'fish', word: 'YANK!', hint: [ST_CODE.bite] }, true);
                ctx.sfx('splash', { vol: 0.7, pan: (fp.tx - CX) / CX });
              } else if (fp.msgUntil && now >= fp.msgUntil) {
                fp.msgUntil = 0;
                stateCue(fp, false);
              }
              break;
            case 'bite':
              if (now - fp.biteT > T.biteWindowMs / 1000 + T.biteGraceSec) {
                fp.misses++;
                fp.st = 'wait';
                fp.biteAt = now + rnd(T.rebiteSec[0], T.rebiteSec[1]);
                fp.msgUntil = now + 0.9;
                stateCue(fp, true, 'bad', 'MISSED!');
              }
              break;
            case 'reel': {
              const kg = fp.fish ? fp.fish.kg : 0.5;
              const secs = (T.reelBaseSec + T.reelPerKgSec * kg) * T.reelHeatMul[heatIdx];
              const shaking = now - fp.stT < T.reelGraceSec ? 0 : clamp((fp.energy - T.reelDeadEnergy) / (T.fullEnergy - T.reelDeadEnergy), 0, 1.25);
              const rate = Math.max(T.reelCreep, shaking);
              const before = fp.reel;
              fp.reel = Math.min(1, fp.reel + (rate * dt) / secs);
              if (Math.floor(before * 5) !== Math.floor(fp.reel * 5)) {
                ctx.sfx('reel', { vol: 0.35, pan: (fp.tx - CX) / CX });
                stateCue(fp, false);
              }
              if (fp.reel >= 1) land(fp);
              break;
            }
            case 'land':
              if (now - fp.stT >= T.landShowSec) {
                fp.st = 'idle';
                fp.stT = now;
                stateCue(fp, true, 'tick', 'CAST!');
              }
              break;
          }
        }
        for (const s of shadows) s.a += s.sp * dt;
      },
      render(g: CanvasRenderingContext2D, v: RenderView) {
        background(g);
        const t = v.t;
        // fish shadows
        g.fillStyle = 'rgba(5,20,50,0.35)';
        for (const s of shadows) {
          const x = CX + Math.cos(s.a) * PRX * s.r;
          const y = CY + Math.sin(s.a) * PRY * s.r;
          const dir = s.sp > 0 ? 1 : -1;
          g.save();
          g.translate(x, y);
          g.rotate(s.a + (dir * Math.PI) / 2);
          g.beginPath();
          g.ellipse(0, 0, s.len * 0.5, s.len * 0.18, 0, 0, Math.PI * 2);
          g.fill();
          g.beginPath();
          g.moveTo(-s.len * 0.45, 0);
          g.lineTo(-s.len * 0.7, -s.len * 0.15);
          g.lineTo(-s.len * 0.7, s.len * 0.15);
          g.fill();
          g.restore();
        }

        const r = tokenR();
        // leaderboard raft in the middle
        {
          const top = rankBy(
            fps.filter((x) => ctx.isPresent(x.p.id)).map((x) => ({ id: x.p.id, kg: x.total, x })),
            (x) => x.kg,
          ).slice(0, 3);
          g.fillStyle = 'rgba(10,20,50,0.55)';
          roundRect(g, CX - 200, CY - 105, 400, 210, 30);
          g.fill();
          drawText(g, '🏆 HEAVIEST', CX, CY - 72, 34, PAL.gold, { outline: 4 });
          top.forEach((e, i) => {
            const y = CY - 22 + i * 50;
            drawEmoji(g, e.x.p.emoji, CX - 150, y, 40);
            drawText(g, e.x.p.name, CX - 118, y, 32, e.x.p.color, { align: 'left', maxWidth: 170, outline: 4 });
            drawText(g, `${e.kg.toFixed(1)} kg`, CX + 180, y, 32, '#fff', { align: 'right', outline: 4 });
          });
        }

        for (const fp of fps) {
          const pres = ctx.isPresent(fp.p.id);
          const dx = Math.cos(fp.ang);
          const dy = Math.sin(fp.ang);
          // pier plank under the player, pointing at the water
          g.save();
          g.translate(fp.tx, fp.ty);
          g.rotate(fp.ang + Math.PI);
          g.fillStyle = '#8a5a2b';
          roundRect(g, -10, -r * 0.8, r * 2.4, r * 1.6, 10);
          g.fill();
          g.strokeStyle = '#5e3a18';
          g.lineWidth = 4;
          for (let k = 1; k < 4; k++) {
            g.beginPath();
            g.moveTo(-10 + (k * r * 2.4) / 4, -r * 0.8);
            g.lineTo(-10 + (k * r * 2.4) / 4, r * 0.8);
            g.stroke();
          }
          g.restore();

          // rod tip
          const tipX = fp.tx - dx * (r + 70);
          const tipY = fp.ty - dy * (r * 0.6 + 40) - 40;
          const st = pres ? fp.st : 'idle';
          g.strokeStyle = '#3a2410';
          g.lineWidth = 9;
          g.lineCap = 'round';
          g.beginPath();
          g.moveTo(fp.tx - dx * r * 0.5, fp.ty - dy * r * 0.3);
          const bend = st === 'reel' ? 18 + Math.sin(t * 20) * 6 : 0;
          g.quadraticCurveTo(lerp(fp.tx, tipX, 0.5), lerp(fp.ty, tipY, 0.5) - 10 + bend, tipX, tipY + bend);
          g.stroke();
          g.lineCap = 'butt';

          // bobber / line
          let bx = fp.bx;
          let by = fp.by;
          let showBobber = st === 'wait' || st === 'bite' || st === 'cast' || st === 'reel';
          if (st === 'cast') {
            const f = clamp01((now - fp.stT) / T.castFlySec);
            bx = lerp(tipX, fp.bx, f);
            by = lerp(tipY, fp.by, f) - Math.sin(f * Math.PI) * 120;
          } else if (st === 'wait') {
            by += Math.sin(t * 3 + fp.ang * 5) * 3;
            if (fp.biteAt - now < 0.8) bx += Math.sin(t * 40) * 3; // nibble
          } else if (st === 'bite') {
            by += 10 + Math.sin(t * 30) * 6;
          } else if (st === 'reel') {
            const f = ease.inOutSine(fp.reel);
            bx = lerp(fp.bx, fp.tx - dx * (r + 60), f);
            by = lerp(fp.by, fp.ty - dy * (r + 30), f);
          }
          if (showBobber) {
            g.strokeStyle = 'rgba(255,255,255,0.85)';
            g.lineWidth = 3;
            g.beginPath();
            g.moveTo(tipX, tipY + bend);
            if (st === 'reel') g.lineTo(bx, by);
            else g.quadraticCurveTo(lerp(tipX, bx, 0.5), Math.max(tipY, by) + 30, bx, by);
            g.stroke();
          }
          if (st === 'reel' && fp.fish) {
            // splashing catch on the line
            g.fillStyle = 'rgba(255,255,255,0.6)';
            for (let k = 0; k < 3; k++) {
              const a = t * 9 + k * 2.1;
              g.beginPath();
              g.arc(bx + Math.cos(a) * 34, by + Math.sin(a) * 14, 6, 0, Math.PI * 2);
              g.fill();
            }
            const len = fp.fish.kind < 0 ? 60 : Math.min(110, FISH[fp.fish.kind].len);
            drawFish(g, fp.fish.kind, bx, by, len, Math.atan2(-dy, -dx) * 0 + Math.sin(t * 14) * 0.4, Math.sin(t * 20));
          } else if (showBobber) {
            if (st === 'bite') {
              const ring = (t * 2) % 1;
              g.strokeStyle = `rgba(255,255,255,${1 - ring})`;
              g.lineWidth = 6;
              g.beginPath();
              g.ellipse(bx, by, 20 + ring * 70, 8 + ring * 26, 0, 0, Math.PI * 2);
              g.stroke();
            }
            g.fillStyle = '#fff';
            g.beginPath();
            g.arc(bx, by, 20, 0, Math.PI * 2);
            g.fill();
            g.fillStyle = fp.p.color;
            g.beginPath();
            g.arc(bx, by, 20, Math.PI, Math.PI * 2);
            g.fill();
            g.strokeStyle = '#1a1033';
            g.lineWidth = 3;
            g.beginPath();
            g.arc(bx, by, 20, 0, Math.PI * 2);
            g.stroke();
            if (st === 'bite') drawText(g, 'YANK!', bx, by - 52, 46, PAL.warn, { outline: 7 });
            if (st === 'wait' && now < fp.scaredUntil) drawText(g, '💨', bx + 30, by - 30, 40, '#fff', { outline: 0 });
          }

          // token
          const landed = st === 'land' && fp.last;
          const jump = landed ? Math.sin(clamp01((now - fp.stT) / 0.5) * Math.PI) * 26 : 0;
          const vert = Math.abs(dy) > 0.45; // top / bottom of the ring: name to the right (the rod points at the water)
          drawToken(g, fp.p, fp.tx, fp.ty - jump, r, { dim: !pres, labelPos: vert ? 'right' : 'below', ring: st === 'bite' && pres ? PAL.warn : undefined });
          const nameS = Math.max(22, r * 0.62);

          // reel bar
          if (st === 'reel') {
            const w = r * 3;
            const yb = vert ? fp.ty + r + 26 : fp.ty - r - 30;
            g.fillStyle = 'rgba(0,0,0,0.65)';
            roundRect(g, fp.tx - w / 2, yb - 17, w, 34, 17);
            g.fill();
            g.fillStyle = PAL.good;
            roundRect(g, fp.tx - w / 2 + 4, yb - 13, (w - 8) * clamp01(fp.reel), 26, 13);
            g.fill();
            drawText(g, 'SHAKE!', fp.tx, yb, 28, '#fff', { outline: 5 });
          }
          // kg total
          if (vert) drawText(g, `${fp.total.toFixed(1)} kg`, fp.tx + r + 12, fp.ty + nameS * 1.1, 28, '#fff', { align: 'left', outline: 5, alpha: pres ? 1 : 0.4 });
          else drawText(g, `${fp.total.toFixed(1)} kg`, fp.tx, fp.ty + r + nameS * 0.75 + 36, 28, '#fff', { outline: 5, alpha: pres ? 1 : 0.4 });
          // landed catch pop
          if (landed && fp.last) {
            const a = clamp01((now - fp.stT) / 0.3);
            const px = fp.tx - dx * (r + 120);
            const py = fp.ty - dy * (r + 95) - 10 - 20 * ease.outBack(a);
            const c = fp.last;
            drawFish(g, c.kind, px, py, (c.kind < 0 ? 70 : FISH[c.kind].len) * (0.6 + 0.4 * ease.outBack(a)), 0, Math.sin(t * 16));
            drawText(g, c.kind < 0 ? 'BOOT! 0 kg' : `${c.kg.toFixed(1)} kg!`, px, py - 52, 36, c.kind < 0 ? '#c8b89a' : PAL.gold, { outline: 6 });
          }
          if (st === 'idle' && pres && started && v.phase === 'play') {
            const bx2 = fp.tx - dx * (r + 90);
            const by2 = fp.ty - dy * (r + 50);
            drawText(g, 'CAST!', bx2, by2 + Math.sin(t * 6) * 4, 30, '#fff', { outline: 5, alpha: 0.85 });
          }
        }
        if (v.phase === 'count') drawText(g, 'Flick to cast — buzz? YANK!', CX, CY + 160, 46, '#fff', { outline: 7 });
      },
      done() {
        return false;
      },
      results(): MinigameResult {
        const pres = fps.filter((x) => ctx.isPresent(x.p.id));
        const ranked = rankBy(
          pres.map((x) => ({ id: x.p.id, kg: Math.round(x.total * 10) / 10, x })),
          (r) => r.kg,
        );
        const ranking = ranked.map((r) => ({
          id: r.id,
          place: r.place,
          stat: `${r.x.fishN} fish · ${r.x.total.toFixed(1)} kg${r.x.boots ? ` · ${r.x.boots} 👢` : ''}`,
        }));
        const superlatives: { id: string; text: string }[] = [];
        const used = new Set<string>();
        const big = [...pres].sort((a, b) => b.biggest - a.biggest)[0];
        if (big && big.biggest > 0) {
          superlatives.push({ id: big.p.id, text: `Master angler — a ${big.biggest.toFixed(1)} kg whopper` });
          used.add(big.p.id);
        }
        const boot = [...pres].filter((x) => !used.has(x.p.id) && x.boots > 0).sort((a, b) => b.boots - a.boots)[0];
        if (boot) {
          superlatives.push({ id: boot.p.id, text: boot.boots > 1 ? `Boot collector — ${boot.boots} boots` : 'Boot collector' });
          used.add(boot.p.id);
        }
        const scare = [...pres].filter((x) => !used.has(x.p.id) && x.early >= 2).sort((a, b) => b.early - a.early)[0];
        if (scare) superlatives.push({ id: scare.p.id, text: `Scared the fish — ${scare.early} early yanks` });
        return { ranking, superlatives };
      },
      botHint(id) {
        const fp = byId.get(id);
        return fp ? [ST_CODE[fp.st]] : undefined;
      },
      dispose() {
        bg = null;
      },
    };
  },
};
