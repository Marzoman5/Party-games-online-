/**
 * Tilt Maze bot brain (MG2). PURE: no DOM, importable from Node (scripts/bots.ts).
 * Host hint = [dirX, dirY, velX, velY] ×1000 (direction to the next BFS cell, y screen-down; velocity as a
 * fraction of terminal speed). The bot steers toward a skill-scaled cruise speed along that direction
 * with lag, noise and the odd wrong-way lapse. Without a hint it wanders, drifting right (exits are right).
 */
import type { BotFactory } from '../types';

export const tiltMazeBot: BotFactory = (rand, skill) => {
  const cruise = 0.45 + skill * 0.45;
  const gain = 1.2 + skill * 1.6;
  const lag = 0.05 + (1 - skill) * 0.25;
  const noiseAmp = 0.1 + (1 - skill) * 0.4;
  const hist: { t: number; h: number[] }[] = [];
  let nx = 0;
  let ny = 0;
  let wanderA = rand() * Math.PI * 2;
  let lapseUntil = 0;
  let lapseA = 0;
  let nextLapse = 3 + rand() * 6;
  return {
    step({ msg, dt, time, hint }) {
      if (msg.ph !== 'play') return {};
      nx += ((rand() * 2 - 1) * noiseAmp - nx) * Math.min(1, dt * 2.5);
      ny += ((rand() * 2 - 1) * noiseAmp - ny) * Math.min(1, dt * 2.5);
      if (!hint || hint.length < 2) {
        wanderA += (rand() - 0.5) * dt * 4;
        const ax = Math.cos(wanderA) * 0.6 + 0.35 + nx;
        const ay = Math.sin(wanderA) * 0.6 + ny;
        return { stream: [Math.round(ax * 1000), Math.round(-ay * 1000), 0] };
      }
      hist.push({ t: time, h: hint });
      while (hist.length > 2 && hist[1].t <= time - lag) hist.shift();
      const hh = hist[0].h;
      const dx = hh[0] / 1000;
      const dy = hh[1] / 1000;
      const vx = (hh[2] ?? 0) / 1000;
      const vy = (hh[3] ?? 0) / 1000;
      if (time > nextLapse) {
        lapseUntil = time + 0.3 + (1 - skill) * 1.2;
        lapseA = rand() * Math.PI * 2;
        nextLapse = time + 4 + rand() * 8 * (0.5 + skill);
      }
      let ux: number;
      let uy: number;
      if (time < lapseUntil) {
        ux = Math.cos(lapseA) * 0.7;
        uy = Math.sin(lapseA) * 0.7;
      } else {
        // feed-forward cruise + velocity error feedback (in units of full tilt)
        ux = dx * cruise + gain * (dx * cruise - vx);
        uy = dy * cruise + gain * (dy * cruise - vy);
      }
      ux += nx;
      uy += ny;
      const m = Math.hypot(ux, uy);
      if (m > 1) {
        ux /= m;
        uy /= m;
      }
      return { stream: [Math.round(ux * 1000), Math.round(-uy * 1000), 0] };
    },
  };
};
