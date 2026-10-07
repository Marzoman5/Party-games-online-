/**
 * "Switch game" picker for results screens: one button per OTHER game (`post switch` with that game),
 * never a blind cycle. The first button keeps the legacy `btn-switch` test id.
 */
import type { GameId } from '../../net/protocol';
import type { PartySession } from '../../engine/PartySession';
import { GAME_IDS } from '../../net/protocol';
import { button, esc, h } from './dom';

export class SwitchPicker {
  readonly root: HTMLSpanElement = h('span', 'kp-switch-row');
  private key = '';

  constructor(private readonly s: PartySession) {}

  update(): void {
    const s = this.s;
    const others = GAME_IDS.filter((id) => id !== s.gameId && s.modules[id]);
    const key = others.join(',');
    if (key === this.key) return;
    this.key = key;
    this.root.replaceChildren(
      ...others.map((id: GameId, i) => {
        const info = s.modules[id].info;
        const b = button(`${info.emoji} Play ${esc(info.title)}`, 'kp-switch', () => s.hostPost('switch', id), i === 0 ? 'btn-switch' : `btn-switch-${id}`);
        b.dataset.game = id;
        return b;
      }),
    );
  }
}
