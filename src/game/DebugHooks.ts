/**
 * `window.__game` test / debug hooks (GameDebugHooks in api.ts). ALWAYS
 * installed, production builds included: the Playwright suite drives the real
 * build through these. `__game.engine` is the Game instance itself.
 */
import type { ItemType } from '../core/types';
import { CHARACTERS } from '../kart/roster';
import { TRACKS } from '../track/tracks';
import { SLOT_COLORS } from '../net/protocol';
import type { GameDebugHooks, PartyRaceConfig, QualityTier } from './api';
import type { Game } from './Game';

type HookHost = GameDebugHooks & { engine: Game };

export function installDebugHooks(game: Game): HookHost {
  const hooks: HookHost = {
    engine: game,

    startRace(cfg?: Partial<PartyRaceConfig>): void {
      const c = cfg ?? {};
      const full: PartyRaceConfig = {
        trackId: c.trackId ?? TRACKS[0].id,
        cc: c.cc ?? 150,
        laps: c.laps ?? 1,
        humans:
          c.humans && c.humans.length > 0
            ? c.humans
            : [{ playerId: 'local', name: 'YOU', characterId: CHARACTERS[0].id, color: SLOT_COLORS[0], source: 'local' }],
        showTips: c.showTips ?? false,
        introFlyover: c.introFlyover,
        ui: c.ui ?? 'solo',
      };
      game.startRace(full);
    },

    finishPlayer(slot = 0): void {
      game.debugFinishPlayer(slot);
    },

    finishAll(): void {
      game.debugFinishAll();
    },

    autopilot(on: boolean, slot = 0): void {
      game.debugAutopilot(!!on, slot);
    },

    giveItem(slot: number, item: ItemType): void {
      game.debugGiveItem(slot, item);
    },

    setQuality(tier: QualityTier | null): void {
      game.quality.setForced(tier);
    },

    getState() {
      const s = game.debugSession();
      const r = game.debugRenderer();
      const info = r.info as unknown as {
        memory: { geometries: number; textures: number };
        programs?: unknown[] | null;
      };
      const rm = s?.raceManager;
      return {
        phase: game.phase,
        viewports: game.debugViewportCount(),
        qualityTier: game.quality.tier,
        fps: Math.round(game.quality.fps * 10) / 10,
        raceTime: rm ? rm.raceTime : 0,
        memory: {
          geometries: info.memory.geometries,
          textures: info.memory.textures,
          programs: Array.isArray(info.programs) ? info.programs.length : 0,
        },
        racesStarted: game.racesStarted,
        karts: (s?.karts ?? []).map((k) => {
          const st = k.state;
          const human = !!s && st.id < s.humans.length && s.kind === 'race';
          return {
            id: st.id,
            human,
            aiControlled: human ? game.debugIsAIControlled(st.id) : true,
            x: st.position.x,
            y: st.position.y,
            z: st.position.z,
            heading: st.heading,
            speed: st.speed,
            lap: st.lap,
            place: st.place,
            item: st.item,
            driftStage: st.driftStage,
            isDrifting: st.isDrifting,
            isSpinning: st.isSpinning,
            isBoosting: st.isBoosting,
            finished: st.finished,
            itemsUsed: s ? (s.itemsUsed[st.id] ?? 0) : 0,
            lastSteer: human ? game.debugLastSteer(st.id) : k.input.steer,
          };
        }),
      };
    },
  };
  (window as unknown as { __game?: HookHost }).__game = hooks;
  return hooks;
}
