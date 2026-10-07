/**
 * LEAD — the Party Rush minigame registry (picker order). Adding an 11th minigame = one file in
 * minigames/ + one bot file + a line here and in bots.ts (see README "Adding a minigame").
 */
import type { MinigameDef } from '../types';
import { shakeRace } from './shake-race';
import { quickDraw } from './quick-draw';
import { balance } from './balance';
import { tiltMaze } from './tilt-maze';
import { hotPotato } from './hot-potato';
import { dontMove } from './dont-move';
import { tugOfWar } from './tug-of-war';
import { copyPose } from './copy-pose';
import { fishing } from './fishing';
import { darts } from './darts';

export const MINIGAMES: readonly MinigameDef[] = [shakeRace, quickDraw, balance, tiltMaze, hotPotato, dontMove, tugOfWar, copyPose, fishing, darts];

export function minigameById(id: string): MinigameDef | undefined {
  return MINIGAMES.find((m) => m.meta.id === id);
}
