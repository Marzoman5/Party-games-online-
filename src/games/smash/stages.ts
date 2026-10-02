/**
 * Smash Party stage catalogue — pure data (no three.js / DOM). World units, +y up, fighter ≈ 1.8 tall.
 * Platform (x, y) = centre of the TOP surface. Main stages are solid with grabbable ledges;
 * floating platforms are pass-through (jump up through, drop down with a fresh down push).
 */
import type { StageDef } from './types';

export const STAGES: StageDef[] = [
  {
    id: 'skyline',
    name: 'Skyline Summit',
    tagline: 'A floating rooftop above the clouds — three platforms, classic battle.',
    theme: 'sky',
    hazard: null,
    platforms: [
      { id: 'main', x: 0, y: 0, w: 18, h: 3.5, solid: true, ledges: true },
      { id: 'left', x: -5.2, y: 2.7, w: 5, h: 0.3, solid: false, ledges: false },
      { id: 'right', x: 5.2, y: 2.7, w: 5, h: 0.3, solid: false, ledges: false },
      { id: 'top', x: 0, y: 5.4, w: 5, h: 0.3, solid: false, ledges: false },
    ],
    blast: { left: -22.5, right: 22.5, top: 18, bottom: -12 },
    camera: { left: -20, right: 20, top: 14.5, bottom: -9 },
    spawns: [
      { x: -5.2, y: 2.7 },
      { x: 5.2, y: 2.7 },
      { x: -2.2, y: 0 },
      { x: 2.2, y: 0 },
    ],
    respawn: { x: 0, y: 9 },
  },
  {
    id: 'arena',
    name: 'Neon Arena',
    tagline: 'One long, flat battleground. Nowhere to hide.',
    theme: 'arena',
    hazard: null,
    platforms: [{ id: 'main', x: 0, y: 0, w: 22, h: 4, solid: true, ledges: true }],
    blast: { left: -24.5, right: 24.5, top: 17.5, bottom: -12 },
    camera: { left: -22, right: 22, top: 14, bottom: -9 },
    spawns: [
      { x: -7, y: 0 },
      { x: 7, y: 0 },
      { x: -2.5, y: 0 },
      { x: 2.5, y: 0 },
    ],
    respawn: { x: 0, y: 8 },
  },
  {
    id: 'forge',
    name: 'Magma Forge',
    tagline: 'Moving platforms over a bubbling lava pit. Watch the floor glow!',
    theme: 'forge',
    hazard: 'lava',
    platforms: [
      { id: 'main', x: 0, y: 0, w: 18, h: 4, solid: true, ledges: true },
      { id: 'lift', x: -5.5, y: 2.4, w: 4.2, h: 0.35, solid: false, ledges: false, path: { dx: 0, dy: 3.2, period: 420 } },
      { id: 'ferry', x: 6.2, y: 3.4, w: 4.2, h: 0.35, solid: false, ledges: false, path: { dx: -4.6, dy: 0, period: 540 } },
    ],
    blast: { left: -22.5, right: 22.5, top: 18, bottom: -12 },
    camera: { left: -20, right: 20, top: 14.5, bottom: -9 },
    spawns: [
      { x: -6, y: 0 },
      { x: 6, y: 0 },
      { x: -2, y: 0 },
      { x: 2, y: 0 },
    ],
    respawn: { x: 0, y: 9 },
  },
  {
    id: 'training',
    name: 'Training Room',
    tagline: 'Practice your moves on the dummy. Its % only goes up!',
    theme: 'training',
    hazard: null,
    training: true,
    platforms: [
      { id: 'main', x: 0, y: 0, w: 30, h: 4, solid: true, ledges: true },
      { id: 'left', x: -7, y: 2.8, w: 5, h: 0.3, solid: false, ledges: false },
      { id: 'right', x: 7, y: 2.8, w: 5, h: 0.3, solid: false, ledges: false },
    ],
    blast: { left: -32, right: 32, top: 20, bottom: -12 },
    camera: { left: -28, right: 28, top: 15, bottom: -9 },
    spawns: [
      { x: -6, y: 0 },
      { x: -3, y: 0 },
      { x: 3, y: 0 },
      { x: 6, y: 0 },
    ],
    respawn: { x: 0, y: 8 },
  },
];

/** Stages the leader can pick in setup (training is sandbox-only). */
export const PICKABLE_STAGES: StageDef[] = STAGES.filter((s) => !s.training);

export function getStage(id: string): StageDef {
  for (let i = 0; i < STAGES.length; i++) if (STAGES[i].id === id) return STAGES[i];
  return STAGES[0];
}
