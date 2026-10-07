/**
 * Hot Potato bot brain (MG1). PURE: no DOM, importable from Node (scripts/bots.ts).
 * Flicks 0.3–1.5 s after the bomb lands on it (skill = faster), retries if the flick was too early.
 */
import type { Bot, BotFactory, BotOut } from '../types';

export const hotPotatoBot: BotFactory = (rand, skill) => {
  let cueId = -1;
  let delayMs = 0;
  let nextTry = 0;
  const bot: Bot = {
    step({ msg, cueAgeMs }): BotOut {
      if (msg.ph !== 'play') return {};
      const cue = msg.cue;
      if (!cue || cue.show !== 'bomb' || cueAgeMs === null) return {};
      if (cue.id !== cueId) {
        cueId = cue.id;
        // 0.3 s (sharp) .. 1.5 s (dozy, or showing off)
        delayMs = 300 + (1 - skill) * 700 + rand() * 500;
        nextTry = delayMs;
      }
      if (cueAgeMs < nextTry) return {};
      nextTry = cueAgeMs + 350 + rand() * 250;
      const a = rand() * Math.PI * 2;
      return { events: [{ k: 'flick', v: Math.round(30 + rand() * 60), x: Math.round(Math.cos(a) * 100), y: Math.round(Math.sin(a) * 100) }] };
    },
  };
  return bot;
};
