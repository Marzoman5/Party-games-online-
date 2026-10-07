/**
 * Don't Move! bot brain (MG1). PURE: no DOM, importable from Node (scripts/bots.ts).
 * Low noise scaled by (1 − skill), the odd twitch, and (rarely, clumsy bots) a phone left on the table
 * until the "PICK IT UP!" cue shows.
 */
import type { Bot, BotFactory, BotOut } from '../types';

export const dontMoveBot: BotFactory = (rand, skill) => {
  const noise = 12 + (1 - skill) * 90;
  let twitchUntil = -1;
  let twitchA = 0;
  let acc = 0;
  const tableAt = skill < 0.35 && rand() < 0.3 ? 3 + rand() * 6 : Infinity;
  let table = false;
  let pickUpAt = -1;
  const bot: Bot = {
    step({ msg, dt, time }): BotOut {
      if (msg.ph !== 'play') return {};
      if (twitchUntil < time && rand() < dt * (0.08 + (1 - skill) * 0.5)) {
        twitchUntil = time + 0.15 + rand() * 0.25;
        twitchA = 200 + rand() * 500 * (1.2 - skill);
      }
      if (!table && time >= tableAt && pickUpAt < 0) table = true;
      if (table && msg.cue?.word === 'PICK IT UP!') {
        if (pickUpAt < 0) pickUpAt = time + 1 + rand();
        if (time >= pickUpAt) table = false;
      }
      let a = noise * (0.5 + rand());
      if (time < twitchUntil) a += twitchA;
      if (table) a = 5;
      a = Math.min(1000, a);
      acc = Math.min(1000, acc + (a * dt) / 15);
      return { stream: [Math.round(a), table ? 1 : 0, Math.round(acc)] };
    },
  };
  return bot;
};
