/**
 * LEAD — bot brains by minigame id. PURE (no DOM): imported by the host shell (solo bots) and by
 * scripts/bots.ts (Node bot phones).
 */
import type { BotFactory } from './types';
import { shakeRaceBot } from './minigames/shake-race.bot';
import { quickDrawBot } from './minigames/quick-draw.bot';
import { balanceBot } from './minigames/balance.bot';
import { tiltMazeBot } from './minigames/tilt-maze.bot';
import { hotPotatoBot } from './minigames/hot-potato.bot';
import { dontMoveBot } from './minigames/dont-move.bot';
import { tugOfWarBot } from './minigames/tug-of-war.bot';
import { copyPoseBot } from './minigames/copy-pose.bot';
import { fishingBot } from './minigames/fishing.bot';
import { dartsBot } from './minigames/darts.bot';

export const BOTS: Record<string, BotFactory> = {
  'shake-race': shakeRaceBot,
  'quick-draw': quickDrawBot,
  'balance': balanceBot,
  'tilt-maze': tiltMazeBot,
  'hot-potato': hotPotatoBot,
  'dont-move': dontMoveBot,
  'tug-of-war': tugOfWarBot,
  'copy-pose': copyPoseBot,
  'fishing': fishingBot,
  'darts': dartsBot,
};
