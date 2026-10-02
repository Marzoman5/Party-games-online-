/**
 * 3-player split-screen: the 4th quadrant shows a large live minimap plus live
 * standings (human names in their slot colours, AI names in white).
 */
import type { IKart, ITrack } from '../core/types';
import { ordinal } from '../core/math';
import { cssHex, el, TextField } from './dom';
import { Minimap } from './Minimap';

const REFRESH = 0.25;

interface Row {
  node: HTMLElement;
  place: TextField;
  chip: HTMLElement;
  name: TextField;
  info: TextField;
  kartId: number;
}

export class StandingsPanel {
  private readonly rootNode: HTMLElement;
  private readonly minimap: Minimap;
  private readonly rows: Row[] = [];
  private readonly lapText: TextField;
  private timer = REFRESH;
  private readonly order: IKart[] = [];

  constructor(
    container: HTMLElement,
    private readonly names: ReadonlyMap<number, string>,
    private readonly humanColors: ReadonlyMap<number, string>,
    rowCount: number,
  ) {
    this.rootNode = el('div', 'standings-panel', undefined, container);
    const mapWrap = el('div', 'sp-map', undefined, this.rootNode);
    this.minimap = new Minimap(mapWrap, { size: 420, humanColors });
    const side = el('div', 'sp-side', undefined, this.rootNode);
    const head = el('div', 'sp-head', undefined, side);
    el('span', 'sp-title', 'STANDINGS', head);
    this.lapText = new TextField(el('span', 'sp-lap', '', head));
    const list = el('div', 'sp-list', undefined, side);
    for (let i = 0; i < rowCount; i++) {
      const node = el('div', 'sp-row', undefined, list);
      const place = new TextField(el('span', 'sp-place', '', node));
      const chip = el('span', 'sp-chip', undefined, node);
      const name = new TextField(el('span', 'sp-name', '', node));
      const info = new TextField(el('span', 'sp-info', '', node));
      this.rows.push({ node, place, chip, name, info, kartId: -1 });
    }
  }

  setTrack(track: ITrack | null): void {
    this.minimap.setTrack(track);
  }

  update(dt: number, karts: readonly IKart[], totalLaps: number): void {
    this.minimap.update(dt, karts, -1);
    this.timer += dt;
    if (this.timer < REFRESH) return;
    this.timer = 0;
    this.order.length = 0;
    for (const k of karts) this.order.push(k);
    this.order.sort((a, b) => a.state.place - b.state.place);
    let leaderLap = 1;
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      const k = this.order[i];
      if (!k) {
        row.node.style.display = 'none';
        continue;
      }
      row.node.style.display = '';
      const s = k.state;
      if (i === 0) leaderLap = Math.min(Math.max(1, s.lap), totalLaps);
      row.place.set(ordinal(s.place || i + 1));
      if (row.kartId !== s.id) {
        row.kartId = s.id;
        const human = this.humanColors.get(s.id);
        row.chip.style.background = cssHex(s.character.color);
        row.node.classList.toggle('human', !!human);
        row.node.style.setProperty('--row-color', human ?? '#ffffff');
      }
      row.name.set(this.names.get(s.id) ?? s.character.name);
      row.info.set(s.finished ? 'FIN' : `L${Math.min(Math.max(1, s.lap), totalLaps)}`);
    }
    this.lapText.set(`LAP ${leaderLap}/${totalLaps}`);
  }

  dispose(): void {
    this.minimap.dispose();
    this.rootNode.remove();
  }
}
