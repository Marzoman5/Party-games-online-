/**
 * RaceFx — maps engine event-bus events to PhoneFx one-shots (haptics / sfx on the phone)
 * for the kart's owner. Subscribed once for the session lifetime; every handler checks the
 * current race's kart → player map, and dispose() unsubscribes everything.
 */
import { events } from '../core/events';
import type { PhoneFx } from '../net/protocol';
import type { NetPort } from './net/HostNet';
import type { PartySession } from './PartySession';

export class RaceFx {
  private readonly offs: (() => void)[] = [];
  /** Last 'hit' per kart, to merge item:hit + kart:spin for the same impact. */
  private readonly lastHit = new Map<number, number>();

  constructor(
    private readonly s: PartySession,
    private readonly net: NetPort,
  ) {
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
        const race = this.s.race;
        if (!race) return;
        for (let k = 0; k < race.playerOfKart.length; k++) this.send(k, 'go');
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
    const race = s.race;
    if (!race || s.soloActive) return;
    if (s.screen !== 'race' && s.screen !== 'loading') return;
    const pid = race.playerOfKart[kartId];
    if (!pid) return;
    const p = s.player(pid);
    if (!p || !p.connected) return;
    this.net.sendTo(pid, { t: 'fx', kind });
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.lastHit.clear();
  }
}
