/**
 * Quick Draw bot brain (MG1). PURE: no DOM, importable from Node (scripts/bots.ts).
 * Holds the phone pointing down, raises 220–600 ms after the DRAW cue (skill), sometimes jumps the gun.
 */
import type { Bot, BotFactory, BotOut } from '../types';

export const quickDrawBot: BotFactory = (rand, skill) => {
  let up = false;
  let lowerAt = -1;
  let handled = -1;
  let delay = -1;
  let lastCue = -1;
  const bot: Bot = {
    step({ msg, dt, time, cueAgeMs }): BotOut {
      if (msg.ph !== 'play') return {};
      const out: BotOut = {};
      const cue = msg.cue;
      if (cue && cue.fx === 'go' && cue.id !== handled) {
        if (cue.id !== lastCue) {
          lastCue = cue.id;
          // 220 ms (sharp) .. 600 ms (sloppy), the odd daydream
          delay = 220 + (1 - skill) * 280 + rand() * 100 + (rand() < 0.08 ? 250 : 0);
        }
        if (!up && cueAgeMs !== null && cueAgeMs >= delay) {
          handled = cue.id;
          up = true;
          out.events = [{ k: 'raise', ms: Math.round(cueAgeMs), c: cue.id }];
        }
      } else if (!cue) {
        // between draws: put the phone back down after a moment
        if (up) {
          if (lowerAt < 0) lowerAt = time + 0.3 + rand() * 0.5;
          if (time >= lowerAt) {
            up = false;
            lowerAt = -1;
          }
        } else if (rand() < dt * (0.008 + (1 - skill) * 0.03)) {
          // itchy trigger finger
          up = true;
          out.events = [{ k: 'raise' }];
        }
      }
      const pitch = up ? -60 + (rand() - 0.5) * 80 : -820 + (rand() - 0.5) * 60;
      out.stream = [Math.round(pitch), 0, 0];
      return out;
    },
  };
  return bot;
};
