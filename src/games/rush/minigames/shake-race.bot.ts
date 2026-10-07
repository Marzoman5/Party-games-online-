/**
 * Shake Race bot brain (MG1). PURE: no DOM, importable from Node (scripts/bots.ts).
 * Shakes at an energy around skill × 800 with noise, short bursts and the odd tired dip.
 */
import type { Bot, BotFactory, BotOut } from '../types';

export const shakeRaceBot: BotFactory = (rand, skill) => {
  const base = 250 + skill * 600;
  let e = 0;
  let shakes = 0;
  let burstUntil = 0;
  let dipUntil = 0;
  let nextBurst = 1 + rand() * 2;
  let startedAt = -1;
  const bot: Bot = {
    step({ msg, dt, time }): BotOut {
      if (msg.ph !== 'play' || msg.s !== 'shake') return {};
      if (startedAt < 0) startedAt = time;
      // reaction to GO: humans need a moment to start shaking
      const warm = Math.min(1, (time - startedAt) / (0.35 + (1 - skill) * 0.5));
      if (time > nextBurst) {
        if (rand() < 0.65) burstUntil = time + 0.4 + rand() * 0.6;
        else dipUntil = time + 0.3 + rand() * 0.5;
        nextBurst = time + 1.2 + rand() * 2;
      }
      let target = base * warm * (0.85 + rand() * 0.3);
      if (time < burstUntil) target += 220;
      if (time < dipUntil) target *= 0.55;
      e += (target - e) * Math.min(1, dt * 6) + (rand() - 0.5) * 80;
      e = Math.max(0, Math.min(1000, e));
      shakes = Math.min(1000, shakes + (e / 1000) * dt * 7);
      return { stream: [Math.round(e), Math.floor(shakes), 0] };
    },
  };
  return bot;
};
