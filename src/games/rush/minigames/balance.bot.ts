/**
 * Balance bot brain (MG2). PURE: no DOM, importable from Node (scripts/bots.ts).
 * With a host hint [ballX, ballY] (plate coords ×1000, y screen-down) it runs a delayed, noisy PD
 * controller toward the centre (skill = gain, reaction lag, noise). Without a hint it wobbles gently.
 */
import type { BotFactory } from '../types';

export const balanceBot: BotFactory = (rand, skill) => {
  const lag = 0.06 + (1 - skill) * 0.22;
  const kp = 1.4 + skill * 2.0;
  const kd = 0.45 + skill * 0.55;
  const noiseAmp = 0.12 + (1 - skill) * 0.45;
  const hist: { t: number; x: number; y: number }[] = [];
  let vx = 0;
  let vy = 0;
  let px = 0;
  let py = 0;
  let nx = 0;
  let ny = 0;
  let ph = rand() * 10;
  // a lapse: every so often a low-skill bot "looks away" for a moment
  let lapseUntil = 0;
  let nextLapse = 4 + rand() * 8;
  return {
    step({ msg, dt, time, hint }) {
      if (msg.ph !== 'play') return {};
      ph += dt;
      nx += ((rand() * 2 - 1) * noiseAmp - nx) * Math.min(1, dt * 3);
      ny += ((rand() * 2 - 1) * noiseAmp - ny) * Math.min(1, dt * 3);
      if (!hint || hint.length < 2) {
        return { stream: [Math.round(Math.sin(ph * 0.9) * 150 + nx * 250), Math.round(Math.cos(ph * 0.7) * 150 + ny * 250), 0] };
      }
      hist.push({ t: time, x: hint[0] / 1000, y: hint[1] / 1000 });
      while (hist.length > 2 && hist[1].t <= time - lag) hist.shift();
      const s = hist[0];
      if (dt > 0) {
        const k = Math.min(1, dt * 8);
        vx += ((s.x - px) / dt - vx) * k;
        vy += ((s.y - py) / dt - vy) * k;
      }
      px = s.x;
      py = s.y;
      if (time > nextLapse) {
        lapseUntil = time + (1 - skill) * 1.2;
        nextLapse = time + 5 + rand() * 10;
      }
      if (time < lapseUntil) return { stream: [Math.round(nx * 1000), Math.round(-ny * 1000), 0] };
      // desired acceleration (y screen-down) → tilt: a = right, b = forward (= up the screen)
      const ux = -(kp * s.x + kd * vx) + nx;
      const uy = -(kp * s.y + kd * vy) + ny;
      return { stream: [Math.round(ux * 1000), Math.round(-uy * 1000), 0] };
    },
  };
};
