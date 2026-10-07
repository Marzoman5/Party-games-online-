/**
 * PARTY HUB game registry: every game the hub offers, in picker order.
 * Adding a game = write a `GameModule` (src/engine/GameModule.ts) + add it here
 * (+ add its id to `GameId` / `GAME_IDS` in the protocol and a phone controller layout).
 */
import type { IGameHost } from '../game/api';
import type { GameModule } from '../engine/GameModule';
import { KartModule } from './kart/KartModule';
import { SmashModule } from './smash/module/SmashModule';
import { RushModule } from './rush/RushModule';

export interface RegistryOptions {
  /** The kart engine (Game, or StubGame with ?stub=1) — constructed eagerly at boot. */
  kart: IGameHost;
  /** Element lazy engines attach their canvas to (#app). */
  container: HTMLElement;
}

export function createGameModules(o: RegistryOptions): GameModule[] {
  return [new KartModule(o.kart), new SmashModule(o.container), new RushModule(o.container)];
}
