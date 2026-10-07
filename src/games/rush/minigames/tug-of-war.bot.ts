/**
 * Tug of War bot brain (MG3). PURE: no DOM, importable from Node (scripts/bots.ts).
 * Sees only the phone view: every beat is a new cue (fx 'tick', hint = [beat period ms, team]). The bot
 * flicks once per beat near the cue; skill = timing accuracy (a low-skill bot is late, sloppy, skips
 * beats and sometimes throws in an extra off-beat pull).
 */
import type { Bot, BotFactory, BotOut } from '../types';

export const tugOfWarBot: BotFactory = (rand, skill) => {
  const sk = Math.max(0, Math.min(1, skill));
  let planCue = -1;
  let planMs = 0;
  let fired = true;
  let extraMs = -1;
  const gauss = (): number => (rand() + rand() + rand() - 1.5) * 1.15;
  const bot: Bot = {
    step({ msg, cueAgeMs }) {
      if (msg.ph !== 'play' || !msg.cue || cueAgeMs === null) return {};
      const cue = msg.cue;
      if (cue.fx !== 'tick') return {};
      const period = cue.hint?.[0] ?? 600;
      if (cue.id !== planCue) {
        planCue = cue.id;
        fired = rand() < 0.04 + (1 - sk) * 0.22; // skip this beat
        const late = 40 + (1 - sk) * 140;
        const sd = 30 + (1 - sk) * 170;
        planMs = Math.max(0, Math.min(period * 0.95, late + gauss() * sd));
        extraMs = rand() < (1 - sk) * 0.25 ? period * (0.35 + rand() * 0.4) : -1;
      }
      const out: BotOut = {};
      if (!fired && cueAgeMs >= planMs) {
        fired = true;
        out.events = [{ k: 'flick', v: 40 + Math.round(rand() * 50), ms: Math.round(cueAgeMs), c: cue.id }];
      } else if (extraMs >= 0 && cueAgeMs >= extraMs) {
        extraMs = -1;
        out.events = [{ k: 'flick', v: 30, ms: Math.round(cueAgeMs), c: cue.id }];
      }
      return out;
    },
  };
  return bot;
};
