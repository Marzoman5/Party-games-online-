/**
 * In-race heads-up display for ONE viewport. Pure DOM inside the viewport's
 * container; DOM writes only happen when a displayed value actually changes.
 *
 * Several HUDs can exist at once (split-screen), so every event handler filters
 * on this HUD's `kartId` (several karts are `isPlayer` now). Sizes are in
 * container-query units (see style.css `.vp`), so the same markup works full
 * screen and in a quadrant; `compact` only hides secondary elements.
 */
import type { IKart, ITrack, ItemType } from '../core/types';
import { ALL_ITEM_TYPES } from '../core/types';
import { events } from '../core/events';
import { BASE_TOP_SPEED } from '../core/constants';
import { clamp01, damp, formatRaceTime, ordinal } from '../core/math';
import { itemInfo } from '../net/items';
import { el, restartAnimation, TextField } from './dom';
import { Minimap } from './Minimap';

/** Speedometer gauge arc length in SVG units (240° of a r=44 circle). */
const GAUGE_ARC = 184.3;
const ROULETTE_FALLBACK_INTERVAL = 0.09;
const SPEED_MAX_KMH = BASE_TOP_SPEED * 3.6 * 1.7;
const TIP_SECONDS = 3.6;

interface TimedNode {
  node: HTMLElement;
  ttl: number;
}

export interface HUDOptions {
  /** Kart this HUD follows. */
  kartId: number;
  /** Split-screen sizing (hides the speedometer + timer on small views). */
  compact?: boolean;
  /** Name tag (party mode). Omit for the solo HUD. */
  name?: string;
  /** Slot colour for the name tag / minimap ring. */
  color?: string;
  /** Show the per-viewport minimap (default true). */
  minimap?: boolean;
  /** kartId -> CSS colour for human karts (minimap rings). */
  humanColors?: ReadonlyMap<number, string>;
}

export type StartResultKind = 'rocket' | 'good' | 'burnout' | 'none';

export class HUD {
  readonly kartId: number;
  private readonly rootNode: HTMLElement;
  private readonly minimap: Minimap | null;
  private readonly unsubs: (() => void)[] = [];
  private visible = false;

  // Item slot
  private readonly itemFrame: HTMLElement;
  private readonly itemIconHost: HTMLElement;
  private readonly itemCount: TextField;
  private readonly itemLabel: TextField;
  private readonly iconCache = new Map<ItemType, HTMLCanvasElement>();
  private shownIcon: ItemType = 'none';
  private shownCount = 0;
  private rouletteTimer = 0;
  private rouletteVisual = false;

  // Place / lap / timer / speed
  private readonly placeNode: HTMLElement;
  private readonly placeNum: TextField;
  private readonly placeSuffix: TextField;
  private lastPlace = 0;
  private readonly lapText: TextField;
  private readonly timerText: TextField;
  private readonly speedText: TextField;
  private readonly gaugeFill: SVGCircleElement;
  private gaugeValue = -1;
  private speedSmooth = 0;

  // Name tag + AI badge
  private readonly aiBadge: HTMLElement | null = null;
  private aiShown = false;

  // Centre overlays
  private readonly center: HTMLElement;
  private readonly wrongWay: HTMLElement;
  private wrongWayShown = false;
  private readonly vignette: HTMLElement;
  private vignetteAlpha = 0;
  private vignetteApplied = -1;
  private readonly timed: TimedNode[] = [];
  private readonly boostGlow: HTMLElement;
  private boostGlowApplied = -1;
  private readonly tipNode: HTMLElement;
  private readonly tipText: TextField;
  private tipTtl = 0;

  constructor(
    container: HTMLElement,
    private readonly buildIcon: (item: ItemType) => HTMLCanvasElement,
    opts: HUDOptions = { kartId: 0 },
  ) {
    this.kartId = opts.kartId;
    this.rootNode = el('div', 'hud hidden', undefined, container);
    if (opts.compact) this.rootNode.classList.add('compact');
    if (opts.color) this.rootNode.style.setProperty('--slot', opts.color);

    // Top-left: item slot
    const itemWrap = el('div', 'hud-item', undefined, this.rootNode);
    this.itemFrame = el('div', 'item-frame', undefined, itemWrap);
    this.itemIconHost = el('div', 'item-icon', undefined, this.itemFrame);
    this.itemCount = new TextField(el('div', 'item-count', '', this.itemFrame));
    this.itemLabel = new TextField(el('div', 'item-label', '', itemWrap));

    // Top-centre: name tag (party)
    if (opts.name !== undefined) {
      const tag = el('div', 'hud-nametag', undefined, this.rootNode);
      el('span', 'hud-nametag-name', opts.name, tag);
      this.aiBadge = el('span', 'hud-ai-badge', 'AI DRIVING', tag);
    }

    // Top-right: lap + timer
    const topRight = el('div', 'hud-topright', undefined, this.rootNode);
    const lapBox = el('div', 'hud-lap glass', undefined, topRight);
    el('span', 'hud-lap-label', 'LAP', lapBox);
    this.lapText = new TextField(el('span', 'hud-lap-value', '', lapBox));
    this.timerText = new TextField(el('div', 'hud-timer glass', '0:00.000', topRight));

    // Bottom-left: place
    this.placeNode = el('div', 'hud-place', undefined, this.rootNode);
    this.placeNum = new TextField(el('span', 'place-num', '', this.placeNode));
    this.placeSuffix = new TextField(el('span', 'place-suffix', '', this.placeNode));

    // Bottom-centre: speedometer
    const speedWrap = el('div', 'hud-speed', undefined, this.rootNode);
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.classList.add('gauge');
    const bg = document.createElementNS(svgNS, 'circle');
    bg.setAttribute('cx', '50');
    bg.setAttribute('cy', '50');
    bg.setAttribute('r', '44');
    bg.classList.add('gauge-bg');
    bg.setAttribute('stroke-dasharray', `${GAUGE_ARC} 276.5`);
    svg.appendChild(bg);
    this.gaugeFill = document.createElementNS(svgNS, 'circle');
    this.gaugeFill.setAttribute('cx', '50');
    this.gaugeFill.setAttribute('cy', '50');
    this.gaugeFill.setAttribute('r', '44');
    this.gaugeFill.classList.add('gauge-fill');
    this.gaugeFill.setAttribute('stroke-dasharray', `0 276.5`);
    svg.appendChild(this.gaugeFill);
    speedWrap.appendChild(svg);
    const speedInner = el('div', 'speed-inner', undefined, speedWrap);
    this.speedText = new TextField(el('div', 'speed-value', '0', speedInner));
    el('div', 'speed-unit', 'km/h', speedInner);

    // Bottom-right: minimap
    if (opts.minimap !== false) {
      const mapWrap = el('div', 'hud-minimap glass', undefined, this.rootNode);
      this.minimap = new Minimap(mapWrap, { humanColors: opts.humanColors });
    } else {
      this.minimap = null;
    }

    // Centre overlays
    this.center = el('div', 'hud-center', undefined, this.rootNode);
    this.wrongWay = el('div', 'hud-wrongway', undefined, this.rootNode);
    el('span', 'wrongway-arrow', '⟲', this.wrongWay);
    el('span', 'wrongway-text', 'WRONG WAY', this.wrongWay);
    this.vignette = el('div', 'hud-vignette', undefined, this.rootNode);
    this.boostGlow = el('div', 'hud-boostglow', undefined, this.rootNode);
    this.tipNode = el('div', 'hud-tip', undefined, this.rootNode);
    this.tipText = new TextField(el('span', 'hud-tip-text', '', this.tipNode));

    this.subscribe();
  }

  // ------------------------------------------------------------------ public

  get element(): HTMLElement {
    return this.rootNode;
  }

  setTrack(track: ITrack | null): void {
    this.minimap?.setTrack(track);
  }

  show(): void {
    this.rootNode.classList.remove('hidden');
    this.visible = true;
  }

  hide(): void {
    this.rootNode.classList.add('hidden');
    this.visible = false;
  }

  /** Friendly contextual tip banner (auto-hides). */
  showTip(text: string): void {
    this.tipText.set(text);
    this.tipTtl = TIP_SECONDS;
    this.tipNode.classList.add('visible');
    restartAnimation(this.tipNode, 'tip-pop');
  }

  /** Rocket start / burnout feedback at GO. */
  showStartResult(kind: StartResultKind): void {
    if (kind === 'rocket') this.flashCenter('ROCKET START!', 'hud-posflash up hud-start', 1.6);
    else if (kind === 'good') this.flashCenter('GOOD START', 'hud-posflash up hud-start', 1.3);
    else if (kind === 'burnout') this.flashCenter('BURNOUT!', 'hud-posflash down hud-start', 1.4);
  }

  update(
    dt: number,
    player: IKart,
    karts: readonly IKart[],
    raceTime: number,
    totalLaps: number,
    aiControlled = false,
  ): void {
    if (!this.visible) return;
    const s = player.state;

    if (this.aiBadge && aiControlled !== this.aiShown) {
      this.aiShown = aiControlled;
      this.rootNode.classList.toggle('ai-driving', aiControlled);
    }

    // Place numeral
    const place = s.place > 0 ? s.place : karts.length;
    if (place !== this.lastPlace) {
      this.lastPlace = place;
      const ord = ordinal(place);
      this.placeNum.set(String(place));
      this.placeSuffix.set(ord.slice(String(place).length));
      this.placeNode.classList.toggle('gold', place === 1);
      this.placeNode.classList.toggle('silver', place === 2);
      this.placeNode.classList.toggle('bronze', place === 3);
      restartAnimation(this.placeNode, 'punch');
    }

    // Lap + timer
    const lapShown = Math.min(Math.max(1, s.lap), totalLaps);
    this.lapText.set(`${lapShown}/${totalLaps}`);
    this.timerText.set(formatRaceTime(s.finished && s.finishTime > 0 ? s.finishTime : raceTime));

    // Speedometer
    const kmh = Math.abs(s.speed) * 3.6;
    this.speedSmooth = damp(this.speedSmooth, kmh, 12, dt);
    this.speedText.set(String(Math.round(this.speedSmooth)));
    const g = clamp01(this.speedSmooth / SPEED_MAX_KMH);
    if (Math.abs(g - this.gaugeValue) > 0.004) {
      this.gaugeValue = g;
      this.gaugeFill.setAttribute('stroke-dasharray', `${(g * GAUGE_ARC).toFixed(1)} 276.5`);
    }
    const boost = s.isBoosting ? 1 : 0;
    if (boost !== this.boostGlowApplied) {
      this.boostGlowApplied = boost;
      this.boostGlow.classList.toggle('on', boost === 1);
      this.rootNode.classList.toggle('boosting', boost === 1);
    }

    // Item slot
    this.updateItemSlot(dt, s.item, s.itemCount, s.itemRouletteActive);

    // Wrong way
    const ww = s.wrongWay && !s.finished;
    if (ww !== this.wrongWayShown) {
      this.wrongWayShown = ww;
      this.wrongWay.classList.toggle('visible', ww);
    }

    // Hit vignette decay
    if (this.vignetteAlpha > 0.001) {
      this.vignetteAlpha = damp(this.vignetteAlpha, 0, 3.5, dt);
      if (this.vignetteAlpha < 0.001) this.vignetteAlpha = 0;
    }
    if (Math.abs(this.vignetteAlpha - this.vignetteApplied) > 0.01) {
      this.vignetteApplied = this.vignetteAlpha;
      this.vignette.style.opacity = this.vignetteAlpha.toFixed(2);
    }

    // Tip banner
    if (this.tipTtl > 0) {
      this.tipTtl -= dt;
      if (this.tipTtl <= 0) this.tipNode.classList.remove('visible');
    }

    this.tickTimed(dt);
    this.minimap?.update(dt, karts, s.id);
  }

  /** Keep timed banners ticking while the HUD is visible but the race isn't updating it. */
  tickTimed(dt: number): void {
    for (let i = this.timed.length - 1; i >= 0; i--) {
      const t = this.timed[i];
      t.ttl -= dt;
      if (t.ttl <= 0) {
        t.node.remove();
        this.timed.splice(i, 1);
      }
    }
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.minimap?.dispose();
    this.iconCache.clear();
    this.timed.length = 0;
    this.rootNode.remove();
  }

  // ----------------------------------------------------------------- private

  private subscribe(): void {
    const on = events.on.bind(events);
    const mine = (id: number): boolean => id === this.kartId;
    this.unsubs.push(
      on('item:rouletteTick', (e) => {
        if (!mine(e.kartId)) return;
        this.rouletteVisual = true;
        this.rouletteTimer = 0;
        this.setIcon(this.randomItem(), false);
        this.itemFrame.classList.add('spinning');
      }),
      on('item:rouletteEnd', (e) => {
        if (!mine(e.kartId)) return;
        this.rouletteVisual = false;
        this.itemFrame.classList.remove('spinning');
        this.setIcon(e.item, true);
      }),
      on('race:countdown', (e) => {
        if (!this.visible) return;
        this.flashCenter(String(e.count), 'hud-count', 0.95);
      }),
      on('race:start', () => {
        if (!this.visible) return;
        this.flashCenter('GO!', 'hud-count hud-go', 1.1);
      }),
      on('race:lap', (e) => {
        if (!mine(e.kartId)) return;
        if (e.isFinalLap) this.flashCenter('FINAL LAP!', 'hud-banner final', 2.4);
        else if (e.lap > 1) this.flashCenter(`LAP ${e.lap}`, 'hud-banner lap', 1.4);
      }),
      on('race:positionChange', (e) => {
        if (!mine(e.kartId) || !this.visible) return;
        const up = e.to < e.from;
        this.flashCenter(`${up ? '▲' : '▼'} ${ordinal(e.to).toUpperCase()}`, `hud-posflash ${up ? 'up' : 'down'}`, 1.0);
      }),
      on('item:hit', (e) => {
        if (!mine(e.kartId)) return;
        this.vignetteAlpha = 1;
        restartAnimation(this.rootNode, 'hit-shake');
      }),
      on('race:finish', (e) => {
        if (!mine(e.kartId)) return;
        const node = this.flashCenter('FINISH', 'hud-finish', 4.5);
        el('div', 'hud-finish-place', ordinal(e.place).toUpperCase() + ' PLACE', node);
      }),
      on('kart:respawn', (e) => {
        if (!mine(e.kartId)) return;
        this.vignetteAlpha = Math.max(this.vignetteAlpha, 0.6);
      }),
    );
  }

  private randomItem(): ItemType {
    return ALL_ITEM_TYPES[Math.floor(Math.random() * ALL_ITEM_TYPES.length)];
  }

  private updateItemSlot(dt: number, item: ItemType, count: number, rouletteActive: boolean): void {
    if (rouletteActive) {
      // If the item system doesn't emit ticks we still animate the roulette locally.
      this.rouletteTimer += dt;
      if (this.rouletteTimer >= ROULETTE_FALLBACK_INTERVAL) {
        this.rouletteTimer = 0;
        this.rouletteVisual = true;
        this.setIcon(this.randomItem(), false);
        this.itemFrame.classList.add('spinning');
      }
      if (this.shownCount !== 0) {
        this.shownCount = 0;
        this.itemCount.set('');
      }
      return;
    }
    if (this.rouletteVisual) {
      // Roulette ended without an explicit event; land on the real item.
      this.rouletteVisual = false;
      this.itemFrame.classList.remove('spinning');
      this.setIcon(item, true);
    } else if (item !== this.shownIcon) {
      this.setIcon(item, item !== 'none');
    }
    const shownCount = item === 'none' || count <= 1 ? 0 : count;
    if (shownCount !== this.shownCount) {
      this.shownCount = shownCount;
      this.itemCount.set(shownCount > 0 ? `×${shownCount}` : '');
    }
  }

  private setIcon(item: ItemType, pop: boolean): void {
    if (item === this.shownIcon && !pop) return;
    this.shownIcon = item;
    this.itemIconHost.replaceChildren();
    if (item !== 'none') {
      this.itemIconHost.appendChild(this.getIcon(item));
    }
    this.itemFrame.classList.toggle('has-item', item !== 'none');
    this.itemLabel.set(this.rouletteVisual ? '' : itemInfo(item).label);
    if (pop) restartAnimation(this.itemFrame, 'pop');
  }

  private getIcon(item: ItemType): HTMLCanvasElement {
    let icon = this.iconCache.get(item);
    if (icon) return icon;
    try {
      icon = this.buildIcon(item);
      if (!(icon instanceof HTMLCanvasElement)) throw new Error('buildItemIcon did not return a canvas');
    } catch (err) {
      console.warn('[HUD] item icon fallback for', item, err);
      icon = this.fallbackIcon(item);
    }
    icon.classList.add('item-icon-canvas');
    this.iconCache.set(item, icon);
    return icon;
  }

  private fallbackIcon(item: ItemType): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d');
    if (ctx) {
      const info = itemInfo(item);
      ctx.fillStyle = info.color;
      ctx.beginPath();
      ctx.arc(32, 32, 26, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 22px Impact, "Arial Narrow", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(info.label[0] ?? '?', 32, 34);
    }
    return c;
  }

  private flashCenter(text: string, cls: string, ttl: number): HTMLElement {
    const node = el('div', `hud-msg ${cls}`, text, this.center);
    node.style.setProperty('--ttl', `${ttl}s`);
    this.timed.push({ node, ttl });
    return node;
  }
}
