/**
 * Hot Potato (MG1) — "Flick to pass the bomb!" — event `flick` (touch: tap), min 3 players.
 *
 * The bomb lives on the phones: the holder's cue is `show:'bomb'` with `v` = fuse progress (refreshed
 * with fire:false). A flick throws it (TV arc) to a random other present player — never straight back to
 * whoever threw it to you, never to someone already holding one. Hidden fuses; 6+ players → 2 bombs,
 * 11+ → 3; each bomb goes off 2–3 times per round. Fewest bangs wins, ties by less total holding time.
 * A holder who leaves → the bomb jumps to someone present at once.
 */
import type { Minigame, MinigameCtx, MinigameDef, MinigameResult, RenderView, RushPlayer } from '../types';
import { STAGE_W } from '../types';
import { PAL, clamp, clamp01, drawEmoji as drawEmojiRaw, drawText, drawToken, ease, lerp, rankBy, stageBackground } from '../draw';
import { HOT_POTATO as T } from '../tuning';

interface Seat {
  p: RushPlayer;
  idx: number;
  x: number;
  y: number;
  bangs: number;
  holdTime: number;
  longest: number;
  everHeld: boolean;
  /** Clear the BOOM cue at this time (−1 = none). */
  clearCueAt: number;
  /** Render time of the last bang (animation). */
  bangT: number;
}

type BombState = 'wait' | 'live' | 'flying' | 'done';
interface Bomb {
  idx: number;
  state: BombState;
  fuses: number[];
  fuseIdx: number;
  fuseLeft: number;
  fuseTotal: number;
  /** Latest possible bang (catch grace can't push the fuse past this). */
  deadline: number;
  waitUntil: number;
  holder: Seat | null;
  holdStart: number;
  catchAt: number;
  /** Who threw it to the current holder / target (no straight throw-backs). */
  from: Seat | null;
  to: Seat | null;
  flyT0: number;
  fx: number;
  fy: number;
  /** Render-time + place of the last explosion. */
  boomRT: number;
  bx: number;
  by: number;
}

const CX = 960;
const CY = 605;

export const hotPotato: MinigameDef = {
  meta: {
    id: 'hot-potato',
    name: 'Hot Potato',
    instr: 'Got the bomb? Flick your wrist to pass it!',
    word: 'SAFE',
    demo: 'flick',
    minPlayers: 3,
    duration: [30, 27, 24],
    stream: null,
    events: ['flick'],
    touch: 'Tap to pass!',
    energetic: false,
    color: '#ff4d4d',
    icon: '💣',
  },
  create(): Minigame {
    let ctx!: MinigameCtx;
    const seats: Seat[] = [];
    const byId = new Map<string, Seat>();
    const bombs: Bomb[] = [];
    let tokenR = 60;
    let over = false;
    let endAt = -1;
    let cueAcc = 0;
    let lastViewT = 0;

    const present = (s: Seat): boolean => ctx.isPresent(s.p.id);
    const holding = (s: Seat): Bomb | null => {
      for (const b of bombs) if (b.state === 'live' && b.holder === s) return b;
      return null;
    };
    const incoming = (s: Seat): boolean => bombs.some((b) => b.state === 'flying' && b.to === s);

    function pickTarget(exclude: Seat | null, avoid: Seat | null): Seat | null {
      const tiers: Seat[][] = [[], [], []];
      for (const s of seats) {
        if (s === exclude || !present(s)) continue;
        const busy = !!holding(s) || incoming(s);
        if (!busy && s !== avoid) tiers[0].push(s);
        else if (!busy) tiers[1].push(s);
        else tiers[2].push(s);
      }
      for (const tier of tiers) if (tier.length) return tier[Math.floor(ctx.rand() * tier.length) % tier.length];
      return null;
    }

    function progress(b: Bomb): number {
      return clamp01(1 - b.fuseLeft / Math.max(0.1, b.fuseTotal));
    }

    function holderCue(s: Seat, fire: boolean): void {
      let v = 0;
      for (const b of bombs) if (b.state === 'live' && b.holder === s) v = Math.max(v, progress(b));
      ctx.cue(s.p.id, { fx: 'buzz', show: 'bomb', v: Math.round(v * 20) / 20, word: 'FLICK!', bg: PAL.bad }, fire);
    }

    function give(b: Bomb, s: Seat): void {
      b.state = 'live';
      b.holder = s;
      b.to = null;
      b.holdStart = ctx.time;
      b.catchAt = ctx.time;
      b.fuseLeft = Math.max(b.fuseLeft, Math.min(T.catchLockSec + T.minFuseAfterCatch, b.deadline - ctx.time));
      s.everHeld = true;
      s.clearCueAt = -1;
      holderCue(s, true);
    }

    function release(b: Bomb): void {
      const s = b.holder;
      if (!s) return;
      const held = ctx.time - b.holdStart;
      s.holdTime += held;
      s.longest = Math.max(s.longest, held);
      b.holder = null;
      if (!holding(s)) {
        if (s.clearCueAt < 0) ctx.cue(s.p.id, null);
      } else holderCue(s, false);
    }

    function light(b: Bomb): void {
      const s = pickTarget(null, null);
      if (!s) {
        b.state = 'done';
        return;
      }
      b.fuseTotal = b.fuses[b.fuseIdx];
      b.fuseLeft = b.fuseTotal;
      b.deadline = ctx.time + b.fuseTotal + T.overtimeSec;
      b.from = null;
      ctx.sfx('tick');
      give(b, s);
    }

    function bang(b: Bomb): void {
      const s = b.holder;
      if (!s) return;
      release(b);
      s.bangs++;
      s.bangT = lastViewT;
      s.clearCueAt = ctx.time + 1.3;
      ctx.cue(s.p.id, { fx: 'boom', word: 'BOOM!', bg: '#2a2a2a' });
      ctx.sfx('boom', { pan: (s.x / STAGE_W) * 2 - 1 });
      ctx.shout('💥 BOOM!', { color: PAL.warn, ms: 900 });
      b.boomRT = lastViewT;
      b.bx = s.x;
      b.by = s.y;
      b.fuseIdx++;
      if (b.fuseIdx >= b.fuses.length) b.state = 'done';
      else {
        b.state = 'wait';
        b.waitUntil = ctx.time + T.bangPauseSec;
      }
      b.from = null;
    }

    function throwBomb(b: Bomb, from: Seat): void {
      const target = pickTarget(from, b.from);
      if (!target) return;
      release(b);
      b.state = 'flying';
      b.from = from;
      b.to = target;
      b.flyT0 = ctx.time;
      b.fx = from.x;
      b.fy = from.y;
      ctx.sfx('whoosh', { pan: (from.x / STAGE_W) * 2 - 1 });
    }

    // ---------------------------------------------------------------- art
    function drawBomb(g: CanvasRenderingContext2D, x: number, y: number, r: number, prog: number, t: number, rot = 0): void {
      const pulse = 1 + 0.08 * Math.sin(t * (6 + prog * 26));
      const R = r * pulse;
      g.save();
      g.translate(x, y);
      g.rotate(rot);
      // body: black → angry red as the fuse burns
      const red = Math.round(lerp(25, 200, prog * prog));
      g.fillStyle = `rgb(${red},${Math.round(25 - prog * 10)},${Math.round(30 - prog * 15)})`;
      g.beginPath();
      g.arc(0, 0, R, 0, Math.PI * 2);
      g.fill();
      g.lineWidth = Math.max(3, R * 0.08);
      g.strokeStyle = '#fff';
      g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.4)';
      g.beginPath();
      g.ellipse(-R * 0.35, -R * 0.35, R * 0.22, R * 0.14, -0.7, 0, Math.PI * 2);
      g.fill();
      // cap + fuse
      g.fillStyle = '#555';
      g.fillRect(R * 0.3, -R * 1.02, R * 0.42, R * 0.32);
      g.strokeStyle = '#d9b77a';
      g.lineWidth = Math.max(3, R * 0.1);
      g.beginPath();
      g.moveTo(R * 0.5, -R * 0.98);
      g.quadraticCurveTo(R * 0.7, -R * 1.5, R * 1.05, -R * 1.35);
      g.stroke();
      // spark
      const sp = R * (0.28 + 0.12 * Math.sin(t * 40));
      g.fillStyle = PAL.warn;
      g.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 + t * 8;
        const rr = i % 2 ? sp * 0.45 : sp;
        g.lineTo(R * 1.05 + Math.cos(a) * rr, -R * 1.35 + Math.sin(a) * rr);
      }
      g.closePath();
      g.fill();
      g.restore();
    }

    function drawBoom(g: CanvasRenderingContext2D, x: number, y: number, dt: number): void {
      if (dt < 0 || dt > 0.9) return;
      const k = ease.outCubic(dt / 0.9);
      const a = 1 - dt / 0.9;
      g.save();
      g.globalAlpha = a;
      g.fillStyle = '#ffdd55';
      g.beginPath();
      g.arc(x, y, 60 + k * 220, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#ff6a1f';
      g.beginPath();
      g.arc(x, y, 40 + k * 150, 0, Math.PI * 2);
      g.fill();
      g.restore();
      emoji(g, '💥', x, y, 120 + k * 120, a);
    }

    return {
      start(c) {
        ctx = c;
        const n = c.players.length;
        tokenR = n <= 6 ? 72 : Math.round(lerp(64, 46, (n - 7) / 9));
        const rx = n <= 6 ? 620 : 770;
        const ry = n <= 6 ? 330 : 355;
        c.players.forEach((p, idx) => {
          const a = -Math.PI / 2 + (idx / n) * Math.PI * 2;
          const s: Seat = { p, idx, x: CX + Math.cos(a) * rx, y: CY + Math.sin(a) * ry, bangs: 0, holdTime: 0, longest: 0, everHeld: false, clearCueAt: -1, bangT: -10 };
          seats.push(s);
          byId.set(p.id, s);
        });
        const nb = n >= T.threeBombsAt ? 3 : n >= T.twoBombsAt ? 2 : 1;
        const [fMin, fMax] = T.fuseSec[c.heat - 1];
        for (let i = 0; i < nb; i++) {
          let count = T.fuses[0] + Math.floor(c.rand() * (T.fuses[1] - T.fuses[0] + 1));
          const start = 0.6 + i * T.bombStagger;
          let fuses: number[] = [];
          for (;;) {
            fuses = [];
            let sum = 0;
            for (let k = 0; k < count; k++) {
              const f = lerp(fMin, fMax, c.rand());
              fuses.push(f);
              sum += f;
            }
            const avail = c.duration - 1.6 - start - (count - 1) * T.bangPauseSec - count * T.overtimeSec;
            if (sum > avail) {
              const k = avail / sum;
              fuses = fuses.map((f) => f * k);
            }
            if (fuses.every((f) => f >= T.minFuseSec) || count <= 1) break;
            count--;
          }
          bombs.push({ idx: i, state: 'wait', fuses, fuseIdx: 0, fuseLeft: 0, fuseTotal: 1, deadline: 0, waitUntil: start, holder: null, holdStart: 0, catchAt: 0, from: null, to: null, flyT0: 0, fx: 0, fy: 0, boomRT: -10, bx: 0, by: 0 });
        }
      },
      onEvent(p, e) {
        if (e.k !== 'flick' && e.k !== 'tap') return;
        const s = byId.get(p.id);
        if (!s || !present(s)) return;
        // pass the bomb with the least fuse left first
        let best: Bomb | null = null;
        for (const b of bombs) {
          if (b.state !== 'live' || b.holder !== s || ctx.time - b.catchAt < T.catchLockSec) continue;
          if (!best || b.fuseLeft < best.fuseLeft) best = b;
        }
        if (best) throwBomb(best, s);
      },
      onLeave(p) {
        const s = byId.get(p.id);
        if (!s) return;
        s.clearCueAt = -1;
        ctx.cue(s.p.id, null);
        for (const b of bombs) {
          if (b.state === 'live' && b.holder === s) {
            release(b);
            const t = pickTarget(s, null);
            if (t) give(b, t);
            else b.state = 'done';
          } else if (b.state === 'flying' && b.to === s) {
            const t = pickTarget(s, b.from);
            if (t) b.to = t;
            else b.state = 'done';
          }
          if (b.from === s) b.from = null;
        }
        if (seats.filter(present).length < 2) over = true;
      },
      update(dt) {
        if (over) return;
        const now = ctx.time;
        for (const s of seats) {
          if (s.clearCueAt >= 0 && now >= s.clearCueAt) {
            s.clearCueAt = -1;
            if (!holding(s)) ctx.cue(s.p.id, null);
          }
        }
        for (const b of bombs) {
          if (b.state === 'wait') {
            if (now >= b.waitUntil) light(b);
            continue;
          }
          if (b.state === 'done') continue;
          b.fuseLeft -= dt;
          if (b.state === 'flying') {
            if (b.fuseLeft < 0.05) b.fuseLeft = 0.05; // never explodes mid-air
            if (now - b.flyT0 >= T.flightSec) {
              const to = b.to && present(b.to) ? b.to : pickTarget(b.from, null);
              if (to) give(b, to);
              else b.state = 'done';
            }
          } else if (b.state === 'live') {
            if (b.holder && !present(b.holder)) {
              const h = b.holder;
              release(b);
              const t = pickTarget(h, null);
              if (t) give(b, t);
              else b.state = 'done';
            } else if (b.fuseLeft <= 0) bang(b);
          }
        }
        cueAcc += dt;
        if (cueAcc >= T.cueEverySec) {
          cueAcc = 0;
          for (const s of seats) if (present(s) && holding(s)) holderCue(s, false);
        }
        if (endAt < 0 && bombs.every((b) => b.state === 'done')) endAt = now + 1.0;
        if (endAt >= 0 && now >= endAt) over = true;
      },
      render(g, v: RenderView) {
        const t = v.t;
        lastViewT = t;
        stageBackground(g, '#3b0f1f', '#120612');
        // table
        g.fillStyle = 'rgba(255,120,60,0.10)';
        g.beginPath();
        g.ellipse(CX, CY, 560, 250, 0, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = 'rgba(255,160,90,0.25)';
        g.lineWidth = 6;
        g.stroke();
        const live = bombs.filter((b) => b.state !== 'done').length;
        drawText(g, 'FLICK TO PASS!', CX, CY - 40, 84, '#fff', { alpha: 0.9 });
        drawText(g, live > 0 ? `💣 × ${live}` : 'ALL CLEAR', CX, CY + 60, 64, PAL.warn);
        for (const s of seats) {
          const on = present(s);
          const hb = on ? holding(s) : null;
          const prog = hb ? progress(hb) : 0;
          const shake = hb ? Math.sin(t * 50 + s.idx) * (2 + prog * 6) : 0;
          const scorch = t - s.bangT < 1.2;
          g.fillStyle = '#000'; // emoji/touch badge alpha follows fillStyle
          drawToken(g, s.p, s.x + shake, s.y, tokenR, {
            dim: !on,
            ring: hb ? PAL.bad : undefined,
            wobble: hb ? 0.3 + 0.3 * Math.sin(t * 20) : scorch ? 0.6 : 0,
          });
          // bang tally
          if (s.bangs > 0) {
            const sz = clamp(tokenR * 0.5, 24, 36);
            const lbl = Math.max(22, tokenR * 0.62);
            const ty = s.y + tokenR + lbl * 1.5 + sz * 0.6;
            if (s.bangs <= 3) {
              for (let i = 0; i < s.bangs; i++) emoji(g, '💥', s.x + (i - (s.bangs - 1) / 2) * sz * 1.1, ty, sz);
            } else drawText(g, `💥×${s.bangs}`, s.x, ty, sz, '#fff');
          }
          if (scorch) emoji(g, '😵', s.x + tokenR * 0.8, s.y - tokenR * 0.8, tokenR * 0.6);
        }
        // bombs (held + flying) above tokens
        for (const b of bombs) {
          if (b.state === 'live' && b.holder) {
            drawBomb(g, b.holder.x + tokenR * 0.85, b.holder.y - tokenR * 0.85, tokenR * 0.62, progress(b), t);
          } else if (b.state === 'flying' && b.to) {
            const k = clamp01((ctx.time - b.flyT0) / T.flightSec);
            const tx = b.to.x + tokenR * 0.85;
            const ty = b.to.y - tokenR * 0.85;
            const x = lerp(b.fx + tokenR * 0.85, tx, k);
            const y = lerp(b.fy - tokenR * 0.85, ty, k) - Math.sin(k * Math.PI) * 220;
            g.strokeStyle = 'rgba(255,200,90,0.35)';
            g.lineWidth = 10;
            g.beginPath();
            const k0 = Math.max(0, k - 0.25);
            g.moveTo(lerp(b.fx + tokenR * 0.85, tx, k0), lerp(b.fy - tokenR * 0.85, ty, k0) - Math.sin(k0 * Math.PI) * 220);
            g.lineTo(x, y);
            g.stroke();
            drawBomb(g, x, y, tokenR * 0.62, progress(b), t, k * 8);
          }
          drawBoom(g, b.bx, b.by, t - b.boomRT);
        }
      },
      done() {
        return over;
      },
      results(): MinigameResult {
        // close open holds so hold time is complete
        for (const b of bombs) if (b.state === 'live' && b.holder) release(b);
        const live = seats.filter(present).map((s) => ({ id: s.p.id, s }));
        const ranked = rankBy(live, (x) => x.s.bangs * 1000 + Math.round(x.s.holdTime * 10) / 10, true);
        const ranking = ranked.map((x) => ({ id: x.id, place: x.place, stat: `💥${x.s.bangs} · ${x.s.holdTime.toFixed(1)} s held` }));
        const sup: { id: string; text: string }[] = [];
        let hot: Seat | null = null;
        for (const x of live) if (x.s.bangs > 0 && (!hot || x.s.bangs > hot.bangs || (x.s.bangs === hot.bangs && x.s.holdTime > hot.holdTime))) hot = x.s;
        if (hot) sup.push({ id: hot.p.id, text: 'Hot hands 🔥' });
        const teflon = live.filter((x) => !x.s.everHeld);
        if (teflon.length) sup.push({ id: teflon[0].id, text: 'Teflon 🍳 never touched it' });
        let hoarder: Seat | null = null;
        for (const x of live) if (x.s.longest >= 2 && (!hoarder || x.s.longest > hoarder.longest)) hoarder = x.s;
        if (hoarder && !sup.some((s) => s.id === hoarder!.p.id)) sup.push({ id: hoarder.p.id, text: `Hot potato hoarder 🥔 ${hoarder.longest.toFixed(1)} s` });
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
