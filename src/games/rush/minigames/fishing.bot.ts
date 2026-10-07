/**
 * Fishing bot brain (MG3). PURE: no DOM, importable from Node (scripts/bots.ts).
 * Reads the phone cue (hint[0] = 0 idle, 1 waiting, 2 bite, 3 reeling, 4 landed; word/show as fallback):
 * casts when idle, yanks 300–900 ms after the bite cue (skill), shakes to reel, and a sloppy bot
 * sometimes yanks too early.
 */
import type { Bot, BotFactory, BotOut } from '../types';

export const fishingBot: BotFactory = (rand, skill) => {
  const sk = Math.max(0, Math.min(1, skill));
  let castAt = -1;
  let lastFlick = -10;
  let biteCue = -1;
  let yankMs = 0;
  let yanked = false;
  let burst = 0;
  const bot: Bot = {
    step({ msg, dt, time, cueAgeMs }) {
      if (msg.ph !== 'play') return {};
      const cue = msg.cue;
      let st = cue?.hint?.[0];
      if (st === undefined) st = cue?.word === 'YANK!' ? 2 : cue?.word === 'SHAKE!' ? 3 : msg.word === 'CAST!' || cue?.word === 'CAST!' ? 0 : 1;
      const out: BotOut = {};
      // stream: shake energy while reeling, a little hand noise otherwise
      if (st === 3) {
        burst = Math.max(0, burst - dt);
        if (burst === 0 && rand() < dt * 0.8) burst = 0.4 + rand() * 0.6;
        const e = 250 + sk * 550 + (burst > 0 ? 200 : 0) + (rand() - 0.5) * 200;
        out.stream = [Math.round(Math.max(0, Math.min(1000, e))), 0, 0];
      } else out.stream = [Math.round(rand() * 60), 0, 0];
      const flick = (ms?: number, c?: number): void => {
        lastFlick = time;
        out.events = [{ k: 'flick', v: 40 + Math.round(rand() * 50), ...(ms !== undefined ? { ms: Math.round(ms), c } : {}) }];
      };
      if (st === 0) {
        if (castAt < 0) castAt = time + 0.4 + (1 - sk) * 0.9 + rand() * 0.5;
        if (time >= castAt && time - lastFlick > 1) {
          castAt = -1;
          flick(cueAgeMs ?? undefined, cue?.id);
        }
      } else castAt = -1;
      if (st === 2 && cue && cueAgeMs !== null) {
        if (cue.id !== biteCue) {
          biteCue = cue.id;
          yanked = false;
          yankMs = 300 + (1 - sk) * 450 + rand() * 150;
          if (rand() < 0.03 + (1 - sk) * 0.1) yankMs = 2200; // dozed off: misses this bite
        }
        if (!yanked && cueAgeMs >= yankMs) {
          yanked = true;
          flick(cueAgeMs, cue.id);
        }
      }
      if (st === 1 && time - lastFlick > 1.5 && rand() < dt * (0.01 + (1 - sk) * 0.06)) flick(cueAgeMs ?? undefined, cue?.id);
      return out;
    },
  };
  return bot;
};
