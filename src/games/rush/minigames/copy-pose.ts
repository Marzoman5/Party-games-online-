/**
 * Copy the Pose (MG3) — "Match the phone on screen!". The TV shows a big phone in one of the 6 gravity
 * poses (RUSH_POSES); every phone gets a cue (show:'pose', v = pose index). A `pose` event with the target
 * index scores by phone-measured reaction time: per pose the fastest present matcher gets N points, the
 * next N−1, … (N = players in the round). The pose stream backs up players who were already in the pose.
 * 6–8 poses per round (heat: more, faster), never the same pose twice in a row.
 */
import type { Minigame, MinigameCtx, MinigameDef, MinigameResult, RenderView, RushInputEvent, RushPlayer, StreamSample } from '../types';
import { RUSH_POSES } from '../../../net/protocol';
import { PAL, clamp01, drawText, drawToken, ease, gridCells, rankBy, roundRect, stageBackground } from '../draw';
import { COPY_POSE as T } from '../tuning';
import { POSE_LABELS, POSE_WORDS, drawPosePicture } from './copy-pose.art';

const NPOSE = RUSH_POSES.length;
const ORD = ['1st', '2nd', '3rd'];
const ordinal = (n: number): string => ORD[n - 1] ?? `${n}th`;

interface PP {
  p: RushPlayer;
  pts: number;
  matches: number;
  firsts: number;
  totalMs: number;
  /** ms per pose index (for "Upside-down specialist"). */
  flipMs: number;
  flipN: number;
  wrong: number;
  /** Current stable pose from the stream (-1 unknown). */
  cur: number;
  conf: number;
  /** Target cue id this pose. */
  cueId: number;
  /** This pose: matched ms (null = not yet) + host time of the match (for the pop). */
  ms: number | null;
  at: number;
  /** Points gained on the last scored pose (pop). */
  gain: number;
  gainAt: number;
}

export const copyPose: MinigameDef = {
  meta: {
    id: 'copy-pose',
    name: 'Copy the Pose',
    instr: 'Turn your phone to match the picture!',
    word: 'COPY!',
    demo: 'pose',
    minPlayers: 1,
    duration: [30, 26, 22],
    stream: 'pose',
    events: ['pose'],
    touch: 'Swipe the pose!',
    energetic: false,
    color: '#c86bff',
    icon: '📱',
  },
  create(): Minigame {
    let ctx!: MinigameCtx;
    const pps: PP[] = [];
    const byId = new Map<string, PP>();
    let seq: number[] = [];
    let maxPoses = 6;
    let poseSec = 4;
    let gapSec = 0.7;
    let now = 0;
    let started = false;
    let phase: 'wait' | 'pose' | 'gap' | 'done' = 'wait';
    let poseNum = 0; // poses started
    let target = -1;
    let poseStartT = 0;
    let nextT = 0;
    let matchedCount = 0;
    let presentAtStart = 0;
    let lastScored = -1;

    const present = (): PP[] => pps.filter((x) => ctx.isPresent(x.p.id));

    const startPose = (): void => {
      target = seq[poseNum];
      poseNum++;
      phase = 'pose';
      poseStartT = now;
      matchedCount = 0;
      presentAtStart = present().length;
      for (const pp of pps) {
        pp.ms = null;
        if (!ctx.isPresent(pp.p.id)) continue;
        pp.cueId = ctx.cue(pp.p.id, { fx: 'go', show: 'pose', v: target, word: POSE_WORDS[target] }, true);
      }
      ctx.sfx('whoosh');
    };

    const match = (pp: PP, ms: number): void => {
      if (pp.ms !== null || phase !== 'pose') return;
      pp.ms = Math.max(0, ms);
      pp.at = now;
      matchedCount++;
      ctx.cue(pp.p.id, { fx: 'good', show: 'pose', v: target, word: 'GOT IT!', bg: '#1f9d3a' }, true);
      ctx.sfx('tick', { pitch: 1 + Math.min(10, matchedCount) * 0.06 });
    };

    const endPose = (): void => {
      const n = Math.max(1, presentAtStart);
      const done = pps.filter((x) => x.ms !== null && ctx.isPresent(x.p.id));
      const ranked = rankBy(
        done.map((x) => ({ id: x.p.id, ms: x.ms as number })),
        (x) => x.ms,
        true,
      );
      for (const r of ranked) {
        const pp = byId.get(r.id)!;
        const pts = Math.max(1, n - (r.place - 1));
        pp.pts += pts;
        pp.matches++;
        pp.totalMs += r.ms;
        if (r.place === 1) pp.firsts++;
        if (target === 1 || target === 3) {
          pp.flipMs += r.ms;
          pp.flipN++;
        }
        pp.gain = pts;
        pp.gainAt = now;
      }
      for (const pp of pps) {
        if (pp.ms === null && ctx.isPresent(pp.p.id)) ctx.cue(pp.p.id, { fx: 'bad', show: 'pose', v: target, word: 'TOO SLOW' }, true);
      }
      lastScored = poseNum;
      if (ranked.length === 0) ctx.sfx('buzz', { vol: 0.5 });
      else ctx.sfx('ding', { vol: 0.6 });
      phase = 'gap';
      nextT = now + gapSec;
    };

    const finish = (): void => {
      phase = 'done';
      for (const pp of pps) if (ctx.isPresent(pp.p.id)) ctx.cue(pp.p.id, null);
    };

    return {
      start(c) {
        ctx = c;
        const h = c.heat - 1;
        maxPoses = T.poses[h];
        poseSec = T.poseSec[h];
        gapSec = T.gapSec[h];
        for (const p of c.players) {
          const pp: PP = { p, pts: 0, matches: 0, firsts: 0, totalMs: 0, flipMs: 0, flipN: 0, wrong: 0, cur: -1, conf: 0, cueId: -1, ms: null, at: 0, gain: 0, gainAt: -10 };
          pps.push(pp);
          byId.set(p.id, pp);
        }
        // pose sequence: never the same twice in a row, never starts with "upright" (how people already hold it)
        let prev = 2;
        seq = [];
        const bag: number[] = [];
        for (let i = 0; i < maxPoses; i++) {
          if (bag.length === 0) for (let k = 0; k < NPOSE; k++) bag.push(k);
          let pick = -1;
          for (let tries = 0; tries < 20; tries++) {
            const j = Math.floor(c.rand() * bag.length);
            if (bag[j] !== prev) {
              pick = bag.splice(j, 1)[0];
              break;
            }
          }
          if (pick < 0) pick = (prev + 1 + Math.floor(c.rand() * (NPOSE - 1))) % NPOSE;
          seq.push(pick);
          prev = pick;
        }
      },
      go() {
        started = true;
        phase = 'wait';
        nextT = T.firstPoseSec;
      },
      onStream(p, s: StreamSample) {
        const pp = byId.get(p.id);
        if (!pp) return;
        pp.cur = s.a >= 0 && s.a < NPOSE ? Math.round(s.a) : -1;
        pp.conf = s.b;
        // backup: already in the pose (no new pose event) — host-measured time + a small penalty
        if (phase === 'pose' && pp.ms === null && pp.cur === target && s.b >= T.streamConf && now - poseStartT >= T.streamDelaySec && ctx.isPresent(p.id)) {
          match(pp, (now - poseStartT) * 1000 + T.streamPenaltyMs);
        }
      },
      onEvent(p, e: RushInputEvent) {
        const pp = byId.get(p.id);
        if (!pp || !ctx.isPresent(p.id)) return;
        if (e.k !== 'pose' && e.k !== 'tap') return;
        const v = e.k === 'tap' ? 0 : Math.round(e.v);
        if (v >= 0 && v < NPOSE) pp.cur = v;
        if (phase !== 'pose' || pp.ms !== null) return;
        if (v !== target) {
          pp.wrong++;
          return;
        }
        const ms = e.cueId === pp.cueId && e.ms !== null ? e.ms : (now - poseStartT) * 1000;
        match(pp, ms);
      },
      onLeave() {
        // nothing to unstick: a pose ends when every PRESENT player matched (checked in update) or on its timer
      },
      update() {
        now = ctx.time;
        if (!started || phase === 'done') return;
        if (phase === 'wait' || phase === 'gap') {
          if (now >= nextT) {
            if (poseNum >= maxPoses || ctx.timeLeft < T.minPoseSec) finish();
            else startPose();
          }
          return;
        }
        // phase 'pose'
        const pres = present();
        const allIn = pres.length > 0 && pres.every((x) => x.ms !== null);
        if (allIn || now - poseStartT >= poseSec || pres.length === 0) endPose();
      },
      render(g: CanvasRenderingContext2D, v: RenderView) {
        stageBackground(g, '#3b1a72', '#140a30');
        const t = v.t;
        // ---- left card: the target pose ----
        const cx0 = 50;
        const cy0 = 135;
        const cw = 860;
        const ch = 905;
        g.fillStyle = '#f6efff';
        roundRect(g, cx0, cy0, cw, ch, 44);
        g.fill();
        g.lineWidth = 8;
        g.strokeStyle = '#c86bff';
        g.stroke();
        const showing = phase === 'pose' || (phase === 'gap' && target >= 0) || (phase === 'done' && target >= 0);
        if (showing && target >= 0) {
          const pop = phase === 'pose' ? ease.outBack(clamp01((now - poseStartT) / 0.35)) : 1;
          g.save();
          if (phase !== 'pose') g.globalAlpha = 0.45;
          drawPosePicture(g, target, cx0 + cw / 2, cy0 + 420, 1.12 * (0.6 + 0.4 * pop), t);
          g.restore();
          drawText(g, POSE_LABELS[target], cx0 + cw / 2, cy0 + ch - 95, POSE_LABELS[target].length > 12 ? 74 : 88, '#2a1458', { outline: 0 });
          // timer bar
          const left = phase === 'pose' ? 1 - clamp01((now - poseStartT) / poseSec) : 0;
          g.fillStyle = 'rgba(42,20,88,0.15)';
          roundRect(g, cx0 + 60, cy0 + ch - 40, cw - 120, 20, 10);
          g.fill();
          g.fillStyle = left < 0.3 ? PAL.bad : '#c86bff';
          if (left > 0) {
            roundRect(g, cx0 + 60, cy0 + ch - 40, (cw - 120) * left, 20, 10);
            g.fill();
          }
          if (phase === 'gap' || phase === 'done') drawText(g, phase === 'done' ? 'DONE!' : 'NEXT…', cx0 + cw / 2, cy0 + 420, 120, '#ffffff', { outline: 12 });
        } else {
          drawText(g, '📱', cx0 + cw / 2, cy0 + 380, 220, '#fff', { outline: 0 });
          drawText(g, 'Copy the phone!', cx0 + cw / 2, cy0 + 640, 72, '#2a1458', { outline: 0 });
          drawText(g, 'Hold it the same way', cx0 + cw / 2, cy0 + 730, 50, '#6a4a98', { outline: 0 });
        }
        // pose counter
        drawText(g, `POSE ${Math.max(1, poseNum)} / ${maxPoses}`, cx0 + 40, cy0 + 48, 40, '#6a4a98', { outline: 0, align: 'left' });
        if (phase === 'pose') drawText(g, `${matchedCount} / ${presentAtStart} got it`, cx0 + cw - 40, cy0 + 48, 40, '#1f9d3a', { outline: 0, align: 'right' });

        // ---- right: players ----
        const n = pps.length;
        const cells = gridCells(n, 950, 130, 930, 920);
        const order = pps; // stable positions (no reshuffles)
        order.forEach((pp, i) => {
          const c = cells[i];
          const r = Math.max(30, Math.min(70, c.h * 0.27, c.w * 0.22));
          const pres = ctx.isPresent(pp.p.id);
          const got = pp.ms !== null && (phase === 'pose' || phase === 'gap');
          // tile
          g.fillStyle = got ? 'rgba(61,220,90,0.28)' : 'rgba(255,255,255,0.07)';
          roundRect(g, c.cx - c.w / 2 + 8, c.cy - c.h / 2 + 8, c.w - 16, c.h - 16, 26);
          g.fill();
          if (got) {
            g.lineWidth = 5;
            g.strokeStyle = PAL.good;
            g.stroke();
          }
          const age = got ? now - pp.at : 9;
          const sc = got ? 1 + 0.35 * (1 - ease.outCubic(clamp01(age / 0.4))) : 1;
          const ty = c.cy - c.h * 0.1;
          drawToken(g, pp.p, c.cx, ty, r * sc, { dim: !pres, ring: got ? PAL.good : undefined, labelScale: 1 });
          // order badge
          if (got) {
            const rank = 1 + pps.filter((o) => o !== pp && o.ms !== null && (o.ms as number) < (pp.ms as number)).length;
            const bx = c.cx + r * 0.95;
            const by = ty - r * 0.85;
            g.fillStyle = rank === 1 ? PAL.gold : '#ffffff';
            g.beginPath();
            g.arc(bx, by, Math.max(22, r * 0.42), 0, Math.PI * 2);
            g.fill();
            drawText(g, rank <= 3 ? ordinal(rank) : '✔', bx, by, Math.max(18, r * 0.36), '#1a1033', { outline: 0 });
          }
          // points
          const py = ty + r + Math.max(22, r * 0.62) * 0.75 + Math.max(22, r * 0.5);
          drawText(g, `${pp.pts} pts`, c.cx, Math.min(py, c.cy + c.h / 2 - 22), Math.max(20, r * 0.42), '#ffffff', { outline: 4, alpha: pres ? 0.9 : 0.4 });
          if (now - pp.gainAt < 1.2 && pp.gain > 0 && lastScored === poseNum) {
            const a = 1 - (now - pp.gainAt) / 1.2;
            drawText(g, `+${pp.gain}`, c.cx - r * 1.25, ty + r * 0.3 - (1 - a) * 40, Math.max(26, r * 0.55), PAL.gold, { alpha: a, outline: 5 });
          }
        });
      },
      done() {
        return phase === 'done';
      },
      results(): MinigameResult {
        const pres = present();
        const ranked = rankBy(
          pres.map((x) => ({ id: x.p.id, pts: x.pts, x })),
          (r) => r.pts,
        );
        const posesPlayed = Math.max(1, Math.min(poseNum, maxPoses));
        const ranking = ranked.map((r) => {
          const avg = r.x.matches ? r.x.totalMs / r.x.matches / 1000 : 0;
          return { id: r.id, place: r.place, stat: r.x.matches ? `${r.x.matches}/${posesPlayed} · ${avg.toFixed(1)} s avg` : `0/${posesPlayed} poses` };
        });
        const superlatives: { id: string; text: string }[] = [];
        const used = new Set<string>();
        const yoga = [...pres].sort((a, b) => b.firsts - a.firsts || b.pts - a.pts)[0];
        if (yoga && yoga.pts > 0) {
          superlatives.push({ id: yoga.p.id, text: yoga.firsts > 1 ? `Yoga master — first on ${yoga.firsts} poses` : 'Yoga master' });
          used.add(yoga.p.id);
        }
        const flip = [...pres].filter((x) => x.flipN > 0 && !used.has(x.p.id)).sort((a, b) => a.flipMs / a.flipN - b.flipMs / b.flipN)[0];
        if (flip) {
          superlatives.push({ id: flip.p.id, text: `Upside-down specialist — ${(flip.flipMs / flip.flipN / 1000).toFixed(1)} s flips` });
          used.add(flip.p.id);
        }
        if (pres.length >= 2) {
          const slow = [...pres].filter((x) => !used.has(x.p.id)).sort((a, b) => a.matches - b.matches || b.totalMs / Math.max(1, b.matches) - a.totalMs / Math.max(1, a.matches))[0];
          if (slow) superlatives.push({ id: slow.p.id, text: 'Still loading…' });
        }
        return { ranking, superlatives };
      },
      botHint(id) {
        const pp = byId.get(id);
        if (!pp) return undefined;
        return [phase === 'pose' ? target : -1];
      },
    };
  },
};
