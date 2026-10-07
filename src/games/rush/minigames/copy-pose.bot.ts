/**
 * Copy the Pose bot brain (MG3). PURE: no DOM, importable from Node (scripts/bots.ts).
 * Watches the phone cue (show:'pose', fx 'go', v = target pose). After 0.6–1.8 s (skill) it sends the
 * target pose — sometimes a wrong pose first, occasionally never gets there. Streams its current pose.
 */
import type { Bot, BotFactory, BotOut } from '../types';

export const copyPoseBot: BotFactory = (rand, skill) => {
  const sk = Math.max(0, Math.min(1, skill));
  let cur = 2; // starts upright-ish
  let planCue = -1;
  let delay = 0;
  let wrongAt = -1;
  let wrongPose = 0;
  let sent = true;
  const bot: Bot = {
    step({ msg, cueAgeMs }) {
      if (msg.ph !== 'play') return {};
      const out: BotOut = { stream: [cur, 900, 0] };
      const cue = msg.cue;
      if (!cue || cue.show !== 'pose' || cue.fx !== 'go' || cueAgeMs === null || typeof cue.v !== 'number') return out;
      const target = Math.round(cue.v);
      if (cue.id !== planCue) {
        planCue = cue.id;
        delay = 600 + (1 - sk) * 900 + rand() * 300;
        sent = rand() < 0.03 + (1 - sk) * 0.08; // fumbles this one
        wrongAt = rand() < 0.08 + (1 - sk) * 0.3 ? delay * (0.35 + rand() * 0.3) : -1;
        wrongPose = (target + 1 + Math.floor(rand() * 5)) % 6;
        if (cur === target) cur = (target + 3) % 6; // pretend they moved away between poses
      }
      if (wrongAt >= 0 && cueAgeMs >= wrongAt) {
        wrongAt = -1;
        cur = wrongPose;
        out.stream = [cur, 900, 0];
        out.events = [{ k: 'pose', v: cur, ms: Math.round(cueAgeMs), c: cue.id }];
      } else if (!sent && cueAgeMs >= delay) {
        sent = true;
        cur = target;
        out.stream = [cur, 900, 0];
        out.events = [{ k: 'pose', v: cur, ms: Math.round(cueAgeMs), c: cue.id }];
      }
      return out;
    },
  };
  return bot;
};
