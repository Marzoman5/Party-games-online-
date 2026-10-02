/**
 * RaceFx — maps kart engine event-bus events to PhoneFx one-shots (haptics / sfx on the phone)
 * for the kart's owner. Subscribed once for the session lifetime; every handler checks that kart
 * is the active game and the current match's seat → player map; dispose() unsubscribes.
 */
import { events } from '../../core/events';
import type { PhoneFx } from '../../net/protocol';
import type { PartySession } from '../../engine/PartySession';

export class RaceFx {
  private readonly offs: (() => void)[] = [];
  /** Last 'hit' per kart, to merge item:hit + kart:spin for the same impact. */
  private readonly lastHit = new Map<number, number>();

  constructor(private readonly s: PartySession) {
    const on = events.on.bind(events);
    this.offs.push(
      on('item:hit', (e) => this.hit(e.kartId)),
      on('kart:spin', (e) => this.hit(e.kartId)),
      on('kart:driftEnd', (e) => {
        if (e.boostStage > 0) this.send(e.kartId, 'miniturbo');
      }),
      on('race:lap', (e) => {
        if (e.lap > e.totalLaps) return;
        this.send(e.kartId, e.isFinalLap ? 'finalLap' : 'lap');
      }),
      on('item:rouletteEnd', (e) => this.send(e.kartId, 'item')),
      on('race:start', () => {
        const m = this.s.match;
        if (!m) return;
        for (let k = 0; k < m.playerOfSlot.length; k++) this.send(k, 'go');
      }),
      on('race:finish', (e) => this.send(e.kartId, 'finish')),
      on('kart:boost', (e) => {
        // Drift releases already buzz as 'miniturbo'.
        if (e.source !== 'drift') this.send(e.kartId, 'boost');
      }),
    );
  }

  private hit(kartId: number): void {
    const now = performance.now();
    const last = this.lastHit.get(kartId) ?? -1e9;
    if (now - last < 350) return;
    this.lastHit.set(kartId, now);
    this.send(kartId, 'hit');
  }

  private send(kartId: number, kind: PhoneFx['kind']): void {
    const s = this.s;
    const m = s.match;
    if (!m || m.kind !== 'match' || m.game !== 'kart' || s.gameId !== 'kart' || s.soloActive) return;
    if (s.screen !== 'race' && s.screen !== 'loading') return;
    const p = s.connectedAtSeat(kartId);
    if (!p) return;
    s.send(p.playerId, { t: 'fx', kind });
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.lastHit.clear();
  }
}
