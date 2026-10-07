/**
 * LEAD — placeholder minigame + bot used until a minigame's real implementation lands (and as a
 * reference of the bare minimum). Ranks players by how many gestures/stream activity they produced.
 */
import type { Bot, BotFactory, Minigame, MinigameCtx, MinigameDef, MinigameMeta, MinigameResult, RenderView, RushInputEvent, RushPlayer, StreamSample } from '../types';
import { drawText, drawToken, gridCells, rankBy, stageBackground } from '../draw';

export function stubMinigame(meta: MinigameMeta): MinigameDef {
  return {
    meta,
    create(): Minigame {
      let ctx!: MinigameCtx;
      const score = new Map<string, number>();
      return {
        start(c) {
          ctx = c;
          for (const p of c.players) score.set(p.id, 0);
        },
        onStream(p: RushPlayer, s: StreamSample) {
          score.set(p.id, (score.get(p.id) ?? 0) + Math.abs(s.a) / 1000);
        },
        onEvent(p: RushPlayer, _e: RushInputEvent) {
          score.set(p.id, (score.get(p.id) ?? 0) + 1);
        },
        update() {},
        render(g: CanvasRenderingContext2D, v: RenderView) {
          stageBackground(g, '#2a1b5c', '#120d2a');
          drawText(g, `${meta.name} (placeholder)`, 960, 200, 70);
          const cells = gridCells(ctx.players.length, 100, 280, 1720, 760);
          ctx.players.forEach((p, i) => {
            const c = cells[i];
            drawToken(g, p, c.cx, c.cy - 20 + Math.sin(v.t * 3 + i) * 6, Math.min(70, c.h * 0.3), { dim: !ctx.isPresent(p.id) });
            drawText(g, (score.get(p.id) ?? 0).toFixed(1), c.cx, c.cy + Math.min(70, c.h * 0.3) + 70, 34);
          });
        },
        done() {
          return false;
        },
        results(): MinigameResult {
          const items = ctx.players.filter((p) => ctx.isPresent(p.id)).map((p) => ({ id: p.id, s: score.get(p.id) ?? 0 }));
          return { ranking: rankBy(items, (x) => x.s).map((x) => ({ id: x.id, place: x.place, stat: x.s.toFixed(1) })) };
        },
      };
    },
  };
}

/** Placeholder bot: random stream + an occasional flick/tap/raise. */
export const stubBot: BotFactory = (rand) => {
  let next = 0.5;
  const bot: Bot = {
    step({ msg, time }) {
      if (msg.ph !== 'play') return {};
      const out: ReturnType<Bot['step']> = {};
      if (msg.s) out.stream = [Math.round((rand() * 2 - 1) * 600), Math.round((rand() * 2 - 1) * 600), 0];
      if (time > next) {
        next = time + 0.6 + rand() * 1.5;
        const k = msg.ev.includes('flick') ? 'flick' : msg.ev.includes('raise') ? 'raise' : msg.ev.includes('pose') ? 'pose' : 'tap';
        out.events = [{ k, v: k === 'pose' ? Math.floor(rand() * 6) : 50 }];
      }
      return out;
    },
  };
  return bot;
};
