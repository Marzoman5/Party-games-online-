/**
 * SHELL — the Party Rush race view: one full-window <canvas> (minigame + HUD + backgrounds, the
 * 1920×1080 logical stage letterboxed 16:9, devicePixelRatio ≤ 2 and a total-pixel cap for 4K TVs) plus
 * DOM overlays positioned on the same letterboxed frame (`--su` = px per stage unit). TV mode adds ~5 %
 * overscan-safe margins and a slightly larger HUD.
 *
 * Test ids: overlays carry `data-rtid`; this view turns them into `data-testid` only while the layer is
 * actually visible (HostUI's data-tid mechanism would also tag hidden layers).
 */
import type { PartySession } from '../../../../engine/PartySession';
import type { ScreenView, UiContext } from '../../../../party/ui/HostUI';
import { h, toggle } from '../../../../party/ui/dom';
import { drawEmoji, drawText, FONT, roundRect } from '../../draw';
import { HUD_H, STAGE_H, STAGE_W } from '../../types';
import type { RushShell } from '../loop';
import { RushMenu, type MenuActions } from './menu';
import { CornerQr, Countdown, OopsOverlay, PausedOverlay, ResultsCard, StingerView, UpNextCard } from './overlays';
import { Scoreboard } from './scoreboard';

const MAX_PIXELS = 1920 * 1080 * 2;

export interface StageHooks extends MenuActions {
  /** Click / tap on the stage = next. */
  click(): void;
  openMenu(): void;
}

export class StageView implements ScreenView {
  readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly frameEl: HTMLDivElement;
  readonly scoreboard: Scoreboard;
  private readonly upnext = new UpNextCard();
  private readonly countdown = new Countdown();
  private readonly results = new ResultsCard();
  private readonly paused = new PausedOverlay();
  private readonly oops = new OopsOverlay();
  private readonly sting = new StingerView();
  private readonly corner: CornerQr;
  readonly menu: RushMenu;
  private visible = false;
  private rect = { x: 0, y: 0, w: 0, h: 0, dpr: 1, W: 0, H: 0, tv: false };
  private lastFrame = 0;
  private bgT = 0;
  private readonly testIdState = new Map<HTMLElement, boolean>();

  constructor(
    private readonly ctx: UiContext,
    private readonly sh: RushShell,
    hooks: StageHooks,
  ) {
    this.canvas = h('canvas', { class: 'rush-canvas', 'data-tid': 'rush-stage' });
    this.g = this.canvas.getContext('2d', { alpha: false }) ?? (this.canvas.getContext('2d') as CanvasRenderingContext2D);
    this.scoreboard = new Scoreboard(ctx.apiBase, () => hooks.openMenu());
    this.corner = new CornerQr(ctx.apiBase);
    this.menu = new RushMenu(sh, hooks);
    this.frameEl = h(
      'div',
      'rush-frame',
      this.scoreboard.root,
      this.upnext.root,
      this.countdown.root,
      this.results.root,
      this.corner.root,
      this.oops.root,
      this.sting.root,
      this.paused.root,
      this.menu.root,
    );
    this.root = h('div', { class: 'rush-root' }, this.canvas, this.frameEl);
    this.root.addEventListener('click', () => hooks.click());
  }

  // ------------------------------------------------------------------ ScreenView

  update(_s: PartySession): void {
    /* state is pulled every animation frame (frame()); nothing to do on session changes */
  }

  show(): void {
    this.visible = true;
    this.layout();
  }

  hide(): void {
    this.visible = false;
    this.applyTestIds(false);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  // ------------------------------------------------------------------ per frame

  /** Render one frame (called by the module's rAF driver). */
  frame(now: number): void {
    if (!this.visible) return;
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 1 / 60;
    this.lastFrame = now;
    this.layout();
    this.draw(dt);
    this.updateLayers();
  }

  private layout(): void {
    const W = Math.max(1, window.innerWidth);
    const H = Math.max(1, window.innerHeight);
    const tv = this.ctx.display.tvMode;
    const r = this.rect;
    let dpr = Math.min(2, window.devicePixelRatio || 1);
    if (W * H * dpr * dpr > MAX_PIXELS) dpr = Math.sqrt(MAX_PIXELS / (W * H));
    if (r.W === W && r.H === H && r.dpr === dpr && r.tv === tv) return;
    const m = tv ? Math.round(Math.min(W, H) * 0.05) : 0;
    const aw = W - 2 * m;
    const ah = H - 2 * m;
    const fw = Math.min(aw, (ah * STAGE_W) / STAGE_H);
    const fh = (fw * STAGE_H) / STAGE_W;
    this.rect = { x: Math.round((W - fw) / 2), y: Math.round((H - fh) / 2), w: fw, h: fh, dpr, W, H, tv };
    const cw = Math.round(W * dpr);
    const ch = Math.round(H * dpr);
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    const f = this.frameEl.style;
    f.left = `${this.rect.x}px`;
    f.top = `${this.rect.y}px`;
    f.width = `${fw}px`;
    f.height = `${fh}px`;
    f.setProperty('--su', `${fw / STAGE_W}px`);
    this.frameEl.classList.toggle('rush-tv', tv);
  }

  private draw(dt: number): void {
    const g = this.g;
    const r = this.rect;
    const sh = this.sh;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#07041a';
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const s = (r.w * r.dpr) / STAGE_W;
    g.setTransform(s, 0, 0, s, r.x * r.dpr, r.y * r.dpr);
    g.save();
    g.beginPath();
    g.rect(0, 0, STAGE_W, STAGE_H);
    g.clip();
    const drew = sh.renderMinigame(g, dt, s);
    if (!drew) this.background(g, dt);
    if (drew && (sh.phase === 'count' || sh.phase === 'play')) {
      this.drawShout(g);
      this.drawHud(g);
    }
    g.restore();
  }

  /** Animated party background behind the scoreboard / UP NEXT / oops. */
  private background(g: CanvasRenderingContext2D, dt: number): void {
    if (!this.sh.paused) this.bgT += dt;
    const t = this.bgT;
    const accent = this.sh.phase === 'intro' && this.sh.round ? this.sh.round.def.meta.color : '#ff3ab8';
    const gr = g.createLinearGradient(0, 0, 0, STAGE_H);
    gr.addColorStop(0, '#22125a');
    gr.addColorStop(1, '#0b0722');
    g.fillStyle = gr;
    g.fillRect(0, 0, STAGE_W, STAGE_H);
    // Slow rotating sunburst.
    g.save();
    g.translate(STAGE_W / 2, STAGE_H * 1.1);
    g.rotate(t * 0.05);
    g.globalAlpha = 0.07;
    g.fillStyle = accent;
    for (let i = 0; i < 16; i++) {
      g.rotate((Math.PI * 2) / 16);
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(-90, -1700);
      g.lineTo(90, -1700);
      g.closePath();
      g.fill();
    }
    g.restore();
    // Floating blobs.
    const cols = ['#ff3ab8', '#2de2e6', '#ffd23f', '#3ddc5a', '#8d6bff'];
    g.save();
    g.globalAlpha = 0.09;
    for (let i = 0; i < 7; i++) {
      const x = ((i * 337 + t * (18 + i * 4)) % (STAGE_W + 400)) - 200;
      const y = 200 + ((i * 211) % 700) + Math.sin(t * 0.6 + i) * 40;
      g.fillStyle = cols[i % cols.length];
      g.beginPath();
      g.arc(x, y, 120 + (i % 3) * 50, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }

  private drawShout(g: CanvasRenderingContext2D): void {
    const r = this.sh.round;
    const sh = r?.shout;
    if (!r || !sh) return;
    const age = (this.sh.clock - sh.at) * 1000;
    if (age < 0 || age > sh.ms) return;
    const k = age / sh.ms;
    const pop = age < 140 ? 0.6 + (age / 140) * 0.5 : 1.1 - Math.min(0.1, (age - 140) / 1000);
    g.save();
    g.globalAlpha = k > 0.75 ? Math.max(0, (1 - k) / 0.25) : 1;
    g.translate(STAGE_W / 2, STAGE_H / 2 + 20);
    g.scale(pop, pop);
    drawText(g, sh.text, 0, 0, 140 * sh.size, sh.color, { outline: 16 * sh.size, maxWidth: 1700 });
    g.restore();
  }

  /** HUD bar (top HUD_H units): minigame icon + name, big seconds left, heat chip (QR corner is DOM). */
  private drawHud(g: CanvasRenderingContext2D): void {
    const sh = this.sh;
    const r = sh.round;
    if (!r) return;
    const tv = this.rect.tv;
    const k = tv ? 1.08 : 1;
    const m = r.def.meta;
    g.save();
    const grd = g.createLinearGradient(0, 0, 0, HUD_H);
    grd.addColorStop(0, 'rgba(8,4,26,0.92)');
    grd.addColorStop(1, 'rgba(8,4,26,0.7)');
    g.fillStyle = grd;
    g.fillRect(0, 0, STAGE_W, HUD_H);
    g.fillStyle = m.color;
    g.fillRect(0, HUD_H - 6, STAGE_W, 6);
    drawEmoji(g, m.icon, 70, HUD_H / 2 - 2, 66 * k);
    drawText(g, m.name, 120, HUD_H / 2, 54 * k, '#ffffff', { align: 'left', maxWidth: 560 });
    // Seconds left.
    const left = sh.phase === 'play' ? Math.max(0, r.duration - r.time) : r.duration;
    const secs = Math.ceil(left);
    const low = sh.phase === 'play' && left <= 5;
    const pulse = low ? 1 + 0.12 * Math.max(0, Math.sin((left % 1) * Math.PI)) : 1;
    g.save();
    g.translate(STAGE_W / 2, HUD_H / 2 + 2);
    g.scale(pulse, pulse);
    drawText(g, String(secs), 0, 0, 92 * k, low ? '#ff4d4d' : '#ffffff', { outline: 10 });
    g.restore();
    // Heat chip.
    const hx = 1250;
    g.font = `900 ${Math.round(34 * k)}px ${FONT}`;
    const label = `🔥 HEAT ${r.heat}`;
    const w = Math.max(170, g.measureText(label).width + 40);
    g.fillStyle = r.heat >= 3 ? '#ff4d4d' : r.heat === 2 ? '#ff7a2f' : 'rgba(255,255,255,0.14)';
    roundRect(g, hx, HUD_H / 2 - 28, w, 56, 28);
    g.fill();
    drawText(g, label, hx + w / 2, HUD_H / 2, 32 * k, '#ffffff', { outline: 0 });
    // Round chip.
    drawText(g, `ROUND ${r.n}`, hx - 30, HUD_H / 2, 30 * k, 'rgba(255,255,255,0.7)', { align: 'right', outline: 0 });
    g.restore();
  }

  // ------------------------------------------------------------------ DOM layers

  private updateLayers(): void {
    const sh = this.sh;
    const s = this.ctx.session;
    const ph = sh.phase;
    const on = new Map<HTMLElement, boolean>();
    on.set(this.scoreboard.root, ph === 'lobby');
    on.set(this.upnext.root, ph === 'intro');
    const goShow = ph === 'play' && sh.phaseT < 0.8;
    on.set(this.countdown.root, ph === 'count' || goShow);
    on.set(this.results.root, ph === 'results' && !!sh.lastResults);
    on.set(this.corner.root, ph === 'count' || ph === 'play');
    on.set(this.oops.root, ph === 'oops');
    on.set(this.paused.root, sh.paused && !sh.menuOpen);
    on.set(this.menu.root, sh.menuOpen);
    on.set(this.sting.root, this.sting.update(sh));

    if (ph === 'lobby') {
      this.scoreboard.update(sh, { room: s.room, joinUrl: s.joinUrl, https: s.https });
      this.scoreboard.frame(sh);
    } else if (ph === 'intro') this.upnext.update(sh);
    if (ph === 'count' || goShow) this.countdown.update(sh);
    if (ph === 'results') this.results.update(sh);
    if (ph === 'oops') this.oops.update(sh);
    if (ph === 'count' || ph === 'play') this.corner.update(s.room, s.joinUrl);
    if (sh.menuOpen) this.menu.refresh();
    for (const [el, v] of on) toggle(el, 'rush-on', v);
    toggle(this.root, 'rush-playing', ph === 'count' || ph === 'play');
    this.applyTestIds(true, on);
  }

  /** Visible layers get `data-testid` for their `data-rtid` elements; hidden ones lose them. */
  private applyTestIds(viewOn: boolean, on?: Map<HTMLElement, boolean>): void {
    const layers = [this.scoreboard.root, this.upnext.root, this.countdown.root, this.results.root, this.corner.root, this.oops.root, this.paused.root, this.menu.root, this.sting.root];
    for (const el of layers) {
      const want = viewOn && !!on?.get(el);
      const prev = this.testIdState.get(el);
      // Rows / dynamic children change while visible: re-apply every frame for visible layers (cheap).
      if (prev === want && !want) continue;
      this.testIdState.set(el, want);
      const nodes: HTMLElement[] = el.dataset.rtid ? [el] : [];
      el.querySelectorAll<HTMLElement>('[data-rtid]').forEach((n) => nodes.push(n));
      for (const n of nodes) {
        const id = n.dataset.rtid!;
        const hiddenChild = n !== el && n.closest('.rush-hide') !== null;
        if (want && !hiddenChild) {
          if (n.getAttribute('data-testid') !== id) n.setAttribute('data-testid', id);
        } else if (n.hasAttribute('data-testid')) n.removeAttribute('data-testid');
      }
    }
  }
}
