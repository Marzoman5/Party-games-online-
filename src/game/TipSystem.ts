/**
 * Contextual first-race tips ("Hold DRIFT through this corner!") shown as small
 * banners in the relevant player's viewport. Rate-limited per player, each tip
 * kind has a max count, banners auto-hide (HUD.showTip).
 */
import * as THREE from 'three';
import type { IKart, ITrack, TrackSample } from '../core/types';
import { events } from '../core/events';
import { wrap01 } from '../core/math';
import { itemInfo } from '../net/items';
import type { HUD } from '../ui/HUD';

const MIN_GAP_SECONDS = 5.5;
const CORNER_CHECK_INTERVAL = 0.25;
const CORNER_ANGLE = 0.95; // rad of heading change over the look-ahead window
const CORNER_COOLDOWN = 12;

type TipKind = 'corner' | 'item' | 'miniturbo' | 'wrongway' | 'airtrick' | 'trick';
const MAX_COUNT: Record<TipKind, number> = { corner: 3, item: 2, miniturbo: 1, wrongway: 2, airtrick: 1, trick: 1 };

interface PlayerTips {
  kartId: number;
  hud: HUD;
  lastTipAt: number;
  counts: Record<TipKind, number>;
  cornerTimer: number;
  lastCornerAt: number;
  airTime: number;
}

function makeSample(): TrackSample {
  return {
    position: new THREE.Vector3(),
    tangent: new THREE.Vector3(0, 0, -1),
    normal: new THREE.Vector3(0, 1, 0),
    binormal: new THREE.Vector3(1, 0, 0),
    halfWidth: 0,
    wallHalfWidth: 0,
    t: 0,
  };
}

export class TipSystem {
  private readonly players = new Map<number, PlayerTips>();
  private readonly unsubs: (() => void)[] = [];
  private time = 0;
  private readonly sA = makeSample();
  private readonly sB = makeSample();
  /** Gameplay must be live for tips (set by Game: racing phase). */
  active = false;

  constructor(
    private readonly track: ITrack,
    huds: readonly HUD[],
  ) {
    for (const hud of huds) {
      this.players.set(hud.kartId, {
        kartId: hud.kartId,
        hud,
        lastTipAt: -100,
        counts: { corner: 0, item: 0, miniturbo: 0, wrongway: 0, airtrick: 0, trick: 0 },
        cornerTimer: 0,
        lastCornerAt: -100,
        airTime: 0,
      });
    }
    this.unsubs.push(
      events.on('item:rouletteEnd', (e) => {
        if (e.item === 'none') return;
        const label = itemInfo(e.item).label || 'an item';
        this.tip(e.kartId, 'item', `You got ${label} — tap ITEM!`, true);
      }),
      events.on('kart:boost', (e) => {
        if (e.source === 'drift') this.tip(e.kartId, 'miniturbo', 'Nice! Mini-turbo!', true);
      }),
      events.on('race:wrongWay', (e) => {
        if (e.wrongWay) this.tip(e.kartId, 'wrongway', 'Wrong way! Turn around', true);
      }),
    );
    // 'kart:trick' is an ENGINE-B addition; subscribe loosely so this compiles either way.
    const loose = events as unknown as {
      on(name: string, fn: (e: { kartId: number }) => void): () => void;
    };
    try {
      this.unsubs.push(
        loose.on('kart:trick', (e) => this.tip(e.kartId, 'trick', 'Trick boost! Nice air!', true)),
        loose.on('kart:ramp', (e) => this.tip(e.kartId, 'airtrick', 'Press DRIFT mid-air for a trick boost!', true)),
      );
    } catch {
      /* ignore */
    }
  }

  update(dt: number, karts: readonly IKart[]): void {
    this.time += dt;
    if (!this.active) return;
    for (const p of this.players.values()) {
      const kart = karts[p.kartId];
      if (!kart) continue;
      const s = kart.state;
      if (s.finished) continue;

      // Ramp / crest air -> trick hint (once).
      if (s.isAirborne && !s.isHopping) p.airTime += dt;
      else p.airTime = 0;
      if (p.airTime > 0.3) this.tip(p.kartId, 'airtrick', 'Airborne! Press DRIFT mid-air for a trick boost!', false);

      // Sharp corner ahead -> drift hint.
      p.cornerTimer += dt;
      if (p.cornerTimer < CORNER_CHECK_INTERVAL) continue;
      p.cornerTimer = 0;
      if (s.isDrifting || s.speed < 11 || this.time - p.lastCornerAt < CORNER_COOLDOWN) continue;
      const len = Math.max(100, this.track.length);
      const t = wrap01(s.trackT);
      this.track.sample(wrap01(t + 12 / len), this.sA);
      this.track.sample(wrap01(t + 42 / len), this.sB);
      const a = this.sA.tangent;
      const b = this.sB.tangent;
      const cross = a.z * b.x - a.x * b.z;
      const dot = a.x * b.x + a.z * b.z;
      const turn = Math.abs(Math.atan2(cross, dot));
      if (turn > CORNER_ANGLE) {
        if (this.tip(p.kartId, 'corner', 'Hold DRIFT through this corner!', false)) p.lastCornerAt = this.time;
      }
    }
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.players.clear();
  }

  private tip(kartId: number, kind: TipKind, text: string, urgent: boolean): boolean {
    if (!this.active) return false;
    const p = this.players.get(kartId);
    if (!p) return false;
    if (p.counts[kind] >= MAX_COUNT[kind]) return false;
    const gap = urgent ? MIN_GAP_SECONDS * 0.5 : MIN_GAP_SECONDS;
    if (this.time - p.lastTipAt < gap) return false;
    p.counts[kind]++;
    p.lastTipAt = this.time;
    p.hud.showTip(text);
    return true;
  }
}
