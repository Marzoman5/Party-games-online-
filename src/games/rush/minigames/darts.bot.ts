/**
 * Darts bot brain (MG2). PURE: no DOM, importable from Node (scripts/bots.ts).
 * Like a phone, the bot keeps a gyro-style aim (a, b ±1000, y up) that re-centres after each dart.
 * With the host hint [crossX, crossY] (crosshair offset from the bull ×1000, y up) it steers the aim toward
 * a skill-scaled spot near the bull and flicks once it settles (or gets impatient). Without a hint it
 * drifts around the middle and flicks every few seconds.
 */
import type { BotFactory } from '../types';

export const dartsBot: BotFactory = (rand, skill) => {
  const err = 0.06 + (1 - skill) * 0.5;
  const speed = 2 + skill * 2.5;
  const tol = 0.035 + (1 - skill) * 0.08;
  let ax = 0;
  let ay = 0;
  let thrown = 0;
  let wait = 0.4 + rand() * 1.2;
  let aimFor = 0;
  let settled = 0;
  let gx = 0;
  let gy = 0;
  const pickGoal = () => {
    const a = rand() * Math.PI * 2;
    const r = err * Math.sqrt(rand()) * 1.2;
    gx = Math.cos(a) * r;
    gy = Math.sin(a) * r;
  };
  pickGoal();
  let patience = 2 + rand() * 2.5;
  return {
    step({ msg, dt, hint }) {
      if (msg.ph !== 'play' || thrown >= 3) return {};
      if (wait > 0) {
        wait -= dt;
        return { stream: [0, 0, 0] };
      }
      aimFor += dt;
      let flick = false;
      if (hint && hint.length >= 2) {
        const ex = gx - hint[0] / 1000;
        const ey = gy - hint[1] / 1000;
        const step = Math.min(1, speed * dt);
        ax += ex * step * 1000 + (rand() - 0.5) * (1 - skill) * 40;
        ay += ey * step * 1000 + (rand() - 0.5) * (1 - skill) * 40;
        settled = Math.hypot(ex, ey) < tol ? settled + dt : 0;
        flick = settled > 0.15 + rand() * 0.2 || aimFor > patience;
      } else {
        ax += (rand() - 0.5) * 60;
        ay += (rand() - 0.5) * 60;
        ax *= 0.98;
        ay *= 0.98;
        flick = aimFor > patience;
      }
      ax = Math.max(-1000, Math.min(1000, ax));
      ay = Math.max(-1000, Math.min(1000, ay));
      const out: ReturnType<ReturnType<BotFactory>['step']> = { stream: [Math.round(ax), Math.round(ay), 0] };
      if (flick) {
        out.events = [{ k: 'tap', v: 0, x: 0, y: 0 }];
        thrown++;
        ax = ay = 0;
        aimFor = 0;
        settled = 0;
        wait = 0.8 + rand() * 1.0;
        patience = 2 + rand() * 2.5;
        pickGoal();
      }
      return out;
    },
  };
};
