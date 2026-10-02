/**
 * In-match DOM HUD: damage panels, timer, sudden death banner, big countdown/GO/GAME text,
 * intro name cards, KO pops and name tags. Pure DOM, scaled by CSS (--ui-scale, --safe, html.tv).
 */

export interface PanelInfo {
  name: string;
  characterId: string;
  tag: string; // 'P1'..'P4' | 'CPU' | 'DUMMY'
  color: string;
  cpu: boolean;
  dummy: boolean;
  portrait: string | null;
  charColor: string;
}

export interface PanelState {
  damage: number;
  stocks: number; // -1 = time mode / infinite
  kos: number;
  score: number;
  out: boolean;
  cpu: boolean;
  timeMode: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

const DMG_STOPS: [number, [number, number, number]][] = [
  [0, [255, 255, 255]],
  [35, [255, 244, 150]],
  [70, [255, 196, 64]],
  [110, [255, 122, 42]],
  [150, [255, 48, 48]],
  [220, [190, 16, 40]],
];

export function damageColor(d: number): string {
  if (d <= 0) return 'rgb(255,255,255)';
  for (let i = 1; i < DMG_STOPS.length; i++) {
    const [b, cb] = DMG_STOPS[i];
    const [a, ca] = DMG_STOPS[i - 1];
    if (d <= b) {
      const t = (d - a) / (b - a);
      return `rgb(${Math.round(ca[0] + (cb[0] - ca[0]) * t)},${Math.round(ca[1] + (cb[1] - ca[1]) * t)},${Math.round(ca[2] + (cb[2] - ca[2]) * t)})`;
    }
  }
  const c = DMG_STOPS[DMG_STOPS.length - 1][1];
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

class Panel {
  readonly root: HTMLDivElement;
  private readonly dmg: HTMLDivElement;
  private readonly dmgNum: HTMLSpanElement;
  private readonly stocks: HTMLDivElement;
  private readonly kos: HTMLDivElement;
  private readonly portrait: HTMLDivElement;
  private readonly cpuBadge: HTMLDivElement;
  private lastDamage = -1;
  private lastStocks = -99;
  private lastKos = -1;
  private lastOut = false;
  private lastCpu: boolean | null = null;
  private portraitSet = false;

  constructor(parent: HTMLElement, readonly info: PanelInfo) {
    const r = el('div', 'sm-panel', parent);
    r.style.setProperty('--pc', info.color);
    r.style.setProperty('--cc', info.charColor);
    if (info.dummy) r.classList.add('dummy');
    this.root = r;
    const plate = el('div', 'sm-plate', r);
    this.portrait = el('div', 'sm-portrait', plate);
    this.portrait.textContent = info.name.slice(0, 1).toUpperCase();
    const body = el('div', 'sm-pbody', plate);
    const top = el('div', 'sm-ptop', body);
    el('span', 'sm-ptag', top, info.tag);
    el('span', 'sm-pname', top, info.name);
    this.dmg = el('div', 'sm-dmg', body);
    this.dmgNum = el('span', 'sm-dmg-num', this.dmg, '0');
    el('span', 'sm-dmg-pct', this.dmg, '%');
    const bottom = el('div', 'sm-pbottom', body);
    this.stocks = el('div', 'sm-stocks', bottom);
    this.kos = el('div', 'sm-kos', bottom);
    this.cpuBadge = el('div', 'sm-cpu', plate, 'CPU');
    this.setPortrait(info.portrait);
  }

  setPortrait(url: string | null): void {
    if (!url || this.portraitSet) return;
    this.portraitSet = true;
    this.portrait.textContent = '';
    this.portrait.style.backgroundImage = `url("${url}")`;
    this.portrait.classList.add('img');
  }

  update(s: PanelState): void {
    const d = Math.max(0, Math.floor(s.damage));
    if (d !== this.lastDamage) {
      const delta = d - Math.max(0, this.lastDamage);
      this.dmgNum.textContent = String(d);
      this.dmg.style.color = damageColor(d);
      if (this.lastDamage >= 0 && delta > 0) {
        const amp = Math.min(1, 0.25 + delta / 18);
        this.dmg.style.setProperty('--amp', String(amp));
        this.dmg.classList.remove('shake');
        void this.dmg.offsetWidth;
        this.dmg.classList.add('shake');
      }
      if (delta < 0 && this.lastDamage > 0) {
        this.dmg.classList.remove('heal');
        void this.dmg.offsetWidth;
        this.dmg.classList.add('heal');
      }
      this.lastDamage = d;
    }
    const st = s.timeMode ? -1 : s.stocks;
    if (st !== this.lastStocks) {
      this.lastStocks = st;
      this.stocks.textContent = '';
      if (st >= 0 && st <= 8) {
        for (let i = 0; i < st; i++) el('span', 'sm-stock', this.stocks);
      } else if (st > 8) {
        el('span', 'sm-stock', this.stocks);
        el('span', 'sm-stock-x', this.stocks, `×${st}`);
      }
    }
    const k = s.timeMode ? s.score : s.kos;
    if (k !== this.lastKos) {
      this.lastKos = k;
      this.kos.textContent = s.timeMode ? `${k > 0 ? '+' : ''}${k}` : k > 0 ? `KO ${k}` : '';
    }
    if (s.out !== this.lastOut) {
      this.lastOut = s.out;
      this.root.classList.toggle('out', s.out);
    }
    if (s.cpu !== this.lastCpu) {
      this.lastCpu = s.cpu;
      this.cpuBadge.style.display = s.cpu && !this.info.dummy ? '' : 'none';
    }
  }

  koPop(): void {
    const p = el('div', 'sm-kopop', this.root, 'KO!');
    this.root.classList.remove('flash');
    void this.root.offsetWidth;
    this.root.classList.add('flash');
    setTimeout(() => p.remove(), 1400);
  }
}

export class Hud {
  readonly root: HTMLDivElement;
  private readonly tagsLayer: HTMLDivElement;
  private readonly panelsRow: HTMLDivElement;
  private readonly timer: HTMLDivElement;
  private readonly banner: HTMLDivElement;
  private readonly big: HTMLDivElement;
  private readonly introCard: HTMLDivElement;
  private readonly introName: HTMLDivElement;
  private readonly introTag: HTMLDivElement;
  private readonly introSub: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  readonly mute: HTMLDivElement;
  private panels: Panel[] = [];
  private tags: HTMLDivElement[] = [];
  private lastTimer = '';
  private bigTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(root: HTMLDivElement) {
    this.root = root;
    this.tagsLayer = el('div', 'sm-tags', root);
    this.panelsRow = el('div', 'sm-panels', root);
    this.timer = el('div', 'sm-timer', root);
    this.banner = el('div', 'sm-banner', root, 'SUDDEN DEATH');
    this.big = el('div', 'sm-big', root);
    this.introCard = el('div', 'sm-intro', root);
    this.introTag = el('div', 'sm-intro-tag', this.introCard);
    this.introName = el('div', 'sm-intro-name', this.introCard);
    this.introSub = el('div', 'sm-intro-sub', this.introCard);
    this.hint = el('div', 'sm-hint', root);
    this.mute = el('div', 'sm-mute', root, 'MUTED (M)');
  }

  setMode(mode: 'hidden' | 'intro' | 'match' | 'sandbox' | 'results'): void {
    this.root.dataset.mode = mode;
  }

  build(infos: PanelInfo[]): void {
    this.panelsRow.textContent = '';
    this.tagsLayer.textContent = '';
    this.panels = infos.map((i) => new Panel(this.panelsRow, i));
    this.panelsRow.dataset.n = String(infos.length);
    this.tags = infos.map((i) => {
      const t = el('div', 'sm-tag', this.tagsLayer);
      t.style.setProperty('--pc', i.color);
      el('span', 'sm-tag-txt', t, i.dummy ? '' : i.tag);
      el('span', 'sm-tag-arrow', t);
      if (i.dummy) t.classList.add('dummy');
      if (i.tag === 'CPU') t.classList.add('cpu');
      return t;
    });
    this.lastTimer = '';
    this.timer.textContent = '';
    this.timer.classList.remove('urgent');
    this.setSuddenDeath(false);
    this.showBig(null);
    this.showIntro(null);
  }

  clear(): void {
    this.build([]);
  }

  setPortrait(characterId: string, url: string): void {
    for (const p of this.panels) if (p.info.characterId === characterId) p.setPortrait(url);
  }

  updatePanel(i: number, s: PanelState): void {
    this.panels[i]?.update(s);
  }

  hidePanel(i: number, hide: boolean): void {
    const p = this.panels[i];
    if (p) p.root.style.display = hide ? 'none' : '';
  }

  koPop(i: number): void {
    this.panels[i]?.koPop();
  }

  /** Screen-space name tag position (px in the HUD root) or null to hide. */
  setTag(i: number, x: number | null, y = 0): void {
    const t = this.tags[i];
    if (!t) return;
    if (x === null) {
      if (t.style.display !== 'none') t.style.display = 'none';
      return;
    }
    if (t.style.display === 'none') t.style.display = '';
    t.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
  }

  setTimer(sec: number): void {
    let txt = '';
    if (sec >= 0) {
      const s = Math.max(0, Math.ceil(sec));
      txt = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }
    if (txt !== this.lastTimer) {
      this.lastTimer = txt;
      this.timer.textContent = txt;
      this.timer.style.display = txt ? '' : 'none';
      const urgent = sec >= 0 && sec <= 10.01;
      this.timer.classList.toggle('urgent', urgent);
      if (urgent) {
        this.timer.classList.remove('tick');
        void this.timer.offsetWidth;
        this.timer.classList.add('tick');
      }
    }
  }

  setSuddenDeath(on: boolean): void {
    this.banner.classList.toggle('on', on);
  }

  /** Big centre text ("3", "GO!", "GAME!"); null hides. */
  showBig(text: string | null, kind = '', holdMs = 0): void {
    if (this.bigTimer) {
      clearTimeout(this.bigTimer);
      this.bigTimer = null;
    }
    if (!text) {
      this.big.className = 'sm-big';
      this.big.textContent = '';
      return;
    }
    this.big.textContent = text;
    this.big.className = 'sm-big';
    void this.big.offsetWidth;
    this.big.className = `sm-big on ${kind}`;
    if (holdMs > 0) this.bigTimer = setTimeout(() => this.showBig(null), holdMs);
  }

  showIntro(card: { name: string; tag: string; color: string; sub: string } | null): void {
    if (!card) {
      this.introCard.classList.remove('on');
      return;
    }
    this.introCard.style.setProperty('--pc', card.color);
    this.introTag.textContent = card.tag;
    this.introName.textContent = card.name;
    this.introSub.textContent = card.sub;
    this.introCard.classList.remove('on');
    void this.introCard.offsetWidth;
    this.introCard.classList.add('on');
  }

  setHint(text: string): void {
    this.hint.textContent = text;
    this.hint.style.display = text ? '' : 'none';
  }

  setMuted(m: boolean): void {
    this.mute.classList.toggle('on', m);
  }
}
