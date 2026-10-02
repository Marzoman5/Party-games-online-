/**
 * SANDBOX (host) — light overlay over the training-stage practice: "PRACTICE — hit the dummy!",
 * the dummy's damage %, a ready chip per player (✓ once they tapped "I'm ready" on their phone)
 * and how to leave. Doesn't hide the action (no scrim).
 */
import { SLOT_COLORS } from '../../../../net/protocol';
import type { PartySession } from '../../../../engine/PartySession';
import type { ScreenView, UiContext } from '../../../../party/ui/HostUI';
import { FaceView } from '../../../../party/ui/LobbyScreen';
import { button, h, replay, setText, toggle } from '../../../../party/ui/dom';
import { blip } from '../../../../party/ui/sfx';
import type { SmashModule } from '../SmashModule';

class ReadyChip {
  readonly root: HTMLDivElement;
  readonly face = new FaceView('sh-chip-avatar');
  private readonly name = h('div', 'sh-chip-name');
  private readonly state = h('div', 'sh-chip-state');
  private done = false;
  constructor() {
    this.root = h('div', 'sh-chip', this.face.root, h('div', 'sh-chip-text', this.name, this.state));
  }
  set(name: string, characterId: string, slot: number, done: boolean, connected: boolean, mod: SmashModule): void {
    this.root.style.setProperty('--slot', SLOT_COLORS[slot]);
    this.face.set(characterId, SLOT_COLORS[slot], String(slot + 1), mod.look(characterId));
    setText(this.name, name);
    setText(this.state, !connected ? 'disconnected' : done ? 'READY ✓' : 'practising…');
    toggle(this.root, 'sh-done', done);
    toggle(this.root, 'kp-dc', !connected);
    if (done && !this.done) {
      replay(this.root, 'kp-pop');
      blip('ready');
    }
    this.done = done;
  }
}

export class SandboxOverlay implements ScreenView {
  readonly root: HTMLDivElement;
  private readonly pct = h('b', 'sh-dummy-pct', '0%');
  private readonly chipsRow = h('div', 'sh-chips');
  private readonly chips = new Map<string, ReadyChip>();
  private readonly hintText = h('span');
  private timer = 0;
  private lastPct = -1;

  constructor(
    private readonly ctx: UiContext,
    private readonly mod: SmashModule,
  ) {
    const s = ctx.session;
    this.root = h(
      'div',
      { class: 'sh-sandbox', 'data-tid': 'screen-sandbox' },
      h(
        'div',
        'sh-sandbox-top',
        h(
          'div',
          'sh-sandbox-left',
          h('div', 'sh-sandbox-title', h('span', 'sh-sandbox-kicker', 'PRACTICE'), h('span', {}, 'Hit the dummy!')),
          h('div', 'sh-sandbox-hint', this.hintText, button('Done practising ▶ <kbd>Esc</kbd>', 'kp-mini', () => s.hostSkipSandbox(), 'btn-skip-sandbox')),
          this.chipsRow,
        ),
        h('div', 'sh-dummy', h('span', 'sh-dummy-label', 'DUMMY'), this.pct),
      ),
    );
  }

  show(): void {
    window.clearInterval(this.timer);
    this.timer = window.setInterval(() => this.tickPct(), 200);
  }

  hide(): void {
    window.clearInterval(this.timer);
    this.timer = 0;
  }

  private tickPct(): void {
    const d = this.mod.dummyDamage();
    const v = d === null ? 0 : Math.round(d);
    if (v !== this.lastPct) {
      if (v > this.lastPct && this.lastPct >= 0) replay(this.pct, 'sh-pct-bump');
      this.lastPct = v;
      setText(this.pct, `${v}%`);
      this.pct.style.setProperty('--heat', String(Math.min(1, v / 150)));
    }
  }

  update(s: PartySession): void {
    this.tickPct();
    const done = s.sandbox?.done ?? new Set<string>();
    const seen = new Set<string>();
    for (const p of s.racers) {
      seen.add(p.playerId);
      let chip = this.chips.get(p.playerId);
      if (!chip) {
        chip = new ReadyChip();
        this.chips.set(p.playerId, chip);
      }
      chip.set(p.name, p.characterId, p.slot, done.has(p.playerId), p.connected, this.mod);
      if (chip.root.parentElement !== this.chipsRow) this.chipsRow.appendChild(chip.root);
    }
    for (const [id, chip] of this.chips) {
      if (!seen.has(id)) {
        chip.root.remove();
        this.chips.delete(id);
      }
    }
    const leader = s.leader;
    setText(this.hintText, `Tap I’M READY on your phone when you’re done${leader ? ` · ${leader.name} can START any time` : ''}`);
  }

  dispose(): void {
    this.hide();
  }
}
