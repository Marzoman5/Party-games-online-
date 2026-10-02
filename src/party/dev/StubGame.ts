/**
 * DEV/TEST ONLY — a stand-in IGameHost so the party layer can be exercised without WebGL or
 * while the real engine is being rewritten. Loaded only via `?stub=1` (dynamic import in main.ts).
 * It paints an animated "race" backdrop on a 2D canvas and fakes the race phases/timings.
 */
import { events } from '../../core/events';
import { CHARACTERS } from '../../kart/roster';
import type { EnginePhase, HumanInput, IGameHost, PartyRaceConfig, RaceResult, SlotStatus } from '../../game/api';

export class StubGame implements IGameHost {
  phase: EnginePhase = 'idle';
  onPhaseChange: ((phase: EnginePhase) => void) | null = null;
  onRaceComplete: ((results: RaceResult[]) => void) | null = null;
  onPauseRequest: (() => void) | null = null;
  onSoloExit: (() => void) | null = null;

  private cfg: PartyRaceConfig | null = null;
  private timers: number[] = [];
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private t0 = performance.now();
  private raf = 0;
  private prePause: EnginePhase = 'racing';
  private countdown = 0;
  private readonly inputs: HumanInput[] = [];
  private readonly ai = new Set<number>();
  tv = false;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'game-canvas';
    container.appendChild(this.canvas);
    this.g = this.canvas.getContext('2d')!;
    const loop = (): void => {
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.cfg?.ui === 'party' && ['racing', 'countdown', 'intro', 'finished', 'paused'].includes(this.phase))
        this.onPauseRequest?.();
    });
    (window as unknown as { __game: unknown }).__game = {
      finishAll: () => this.finishAll(),
      startRace: (c?: Partial<PartyRaceConfig>) =>
        this.startRace({ trackId: 'sunny', cc: 150, laps: 1, humans: [], showTips: false, ui: 'solo', ...c }),
      getState: () => ({ phase: this.phase, inputs: this.inputs, ai: [...this.ai], cfg: this.cfg }),
      setPhase: (p: EnginePhase) => this.set(p),
    };
  }

  private set(p: EnginePhase): void {
    if (this.phase === p) return;
    this.phase = p;
    this.onPhaseChange?.(p);
  }

  private later(ms: number, fn: () => void): void {
    this.timers.push(window.setTimeout(fn, ms));
  }

  private clear(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  showDemo(): void {
    this.clear();
    this.cfg = null;
    this.set('demo');
  }

  startRace(cfg: PartyRaceConfig): void {
    this.clear();
    this.cfg = cfg;
    this.ai.clear();
    this.set('loading');
    this.later(900, () => this.set('intro'));
    this.later(1800, () => {
      this.set('countdown');
      this.countdown = 3;
    });
    this.later(2400, () => (this.countdown = 2));
    this.later(3000, () => (this.countdown = 1));
    this.later(3600, () => {
      this.countdown = 0;
      this.set('racing');
      events.emit('race:start', { trackId: cfg.trackId });
    });
  }

  setHumanInput(slot: number, input: HumanInput): void {
    this.inputs[slot] = input;
  }

  setSlotAI(slot: number, ai: boolean): void {
    if (ai) this.ai.add(slot);
    else this.ai.delete(slot);
  }

  pause(): void {
    if (this.phase === 'paused') return;
    this.prePause = this.phase;
    this.set('paused');
  }

  resume(): void {
    if (this.phase === 'paused') this.set(this.prePause);
  }

  restartRace(): void {
    if (this.cfg) this.startRace(this.cfg);
  }

  quitRace(): void {
    this.showDemo();
  }

  getSlotStatus(slot: number): SlotStatus | null {
    if (!this.cfg || slot >= this.cfg.humans.length) return null;
    return {
      kartId: slot,
      place: slot + 1,
      lap: 1,
      laps: this.cfg.laps,
      item: 'none',
      itemCount: 0,
      roulette: false,
      driftStage: this.inputs[slot]?.drift ? 2 : 0,
      countdown: this.countdown,
      finished: false,
      aiControlled: this.ai.has(slot),
      speed: 20,
    };
  }

  getResults(): RaceResult[] | null {
    if (!this.cfg) return null;
    const humans = this.cfg.humans;
    const ais = CHARACTERS.filter((c) => !humans.some((h) => h.characterId === c.id));
    const out: RaceResult[] = [];
    const order = Array.from({ length: 8 }, (_, i) => i).sort(() => Math.random() - 0.5);
    order.forEach((k, place) => {
      const h = humans[k];
      const ai = ais[(k - humans.length + ais.length) % ais.length];
      out.push({
        kartId: k,
        place: place + 1,
        name: h ? h.name : ai.name,
        characterId: h ? h.characterId : ai.id,
        color: h ? h.color : '#' + ai.color.toString(16).padStart(6, '0'),
        time: 95 + place * 2.37 + Math.random(),
        slot: h ? k : -1,
      });
    });
    return out;
  }

  finishAll(): void {
    const r = this.getResults();
    this.clear();
    this.set('results');
    if (r) this.onRaceComplete?.(r);
  }

  openSoloMenu(): void {
    this.set('soloMenu');
    this.later(1500, () => {
      this.showDemo();
      this.onSoloExit?.();
    });
  }

  setTvMode(on: boolean): void {
    this.tv = on;
  }

  private draw(): void {
    const c = this.canvas;
    const w = (c.width = Math.floor(innerWidth / 2));
    const h = (c.height = Math.floor(innerHeight / 2));
    const g = this.g;
    const t = (performance.now() - this.t0) / 1000;
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#3a7bd5');
    sky.addColorStop(0.55, '#9fd3ff');
    sky.addColorStop(0.56, '#3fae4a');
    sky.addColorStop(1, '#23722d');
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#555a66';
    g.beginPath();
    g.moveTo(w * 0.47, h * 0.56);
    g.lineTo(w * 0.53, h * 0.56);
    g.lineTo(w * 0.95, h);
    g.lineTo(w * 0.05, h);
    g.fill();
    for (let i = 0; i < 8; i++) {
      const z = ((t * 0.6 + i / 8) % 1) ** 2;
      g.fillStyle = '#fff';
      g.fillRect(w * 0.5 - 2 - z * 8, h * 0.56 + z * h * 0.44, 4 + z * 16, 2 + z * 14);
    }
    const colors = ['#ff4d4d', '#3d8bff', '#3ddc5a', '#ffc21a'];
    for (let i = 0; i < 4; i++) {
      const x = w * (0.35 + 0.1 * i) + Math.sin(t * 1.3 + i) * 20;
      g.fillStyle = colors[i];
      g.fillRect(x, h * 0.78, 30, 14);
    }
    g.fillStyle = 'rgba(0,0,0,0.6)';
    g.font = 'bold 14px sans-serif';
    g.fillText(`STUB ENGINE · ${this.phase}${this.countdown ? ' ' + this.countdown : ''}`, 8, 18);
  }
}
