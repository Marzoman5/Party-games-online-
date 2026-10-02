/**
 * Controller layouts: the in-game part of the phone (race / tutorial / sandbox screens).
 *
 * The App shell owns everything shared (connection + reconnect banners, wake lock,
 * fullscreen + orientation, settings sheet, rotate overlay, haptics, room/conn corner)
 * and mounts exactly ONE layout at a time, chosen by `PhoneState.game`. A layout owns its
 * DOM, its input driver (which sends packets while active) and its HUD / tutorial mirror.
 *
 * Adding a game: implement ControllerLayout (see screens/controller.ts for kart and
 * screens/fighter.ts for smash), register a factory in LAYOUT_FACTORIES and map the GameId
 * in LAYOUT_FOR_GAME. Unknown / missing games fall back to the kart layout.
 */
import type { GameId, PhoneFx } from '../../net/protocol';
import type { View } from '../screens/view';

export type LayoutId = 'kart' | 'fighter';

/** The packet-sending side of a layout. */
export interface InputDriver {
  readonly isActive: boolean;
  /** Start/stop the 60 Hz packet loop (stopping releases everything). */
  setActive(on: boolean): void;
  /** Forget every finger / held button (sends one neutral packet if active). */
  releaseAll(): void;
}

export interface ControllerLayout extends View {
  readonly id: LayoutId;
  readonly input: InputDriver;
  /** Recompute thumb-friendly positions (resize, settings change). */
  layout(): void;
  /** One-shot host feedback (haptics + flashes). */
  fx(m: PhoneFx): void;
}

export const LAYOUT_FOR_GAME: Record<GameId, LayoutId> = {
  kart: 'kart',
  smash: 'fighter',
};

export function layoutForGame(game: GameId | string | undefined | null): LayoutId {
  return (game && (LAYOUT_FOR_GAME as Record<string, LayoutId>)[game]) || 'kart';
}
