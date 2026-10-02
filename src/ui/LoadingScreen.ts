/**
 * Loading overlay shown while a Track is being built. Track name, theme colour
 * band, animated progress bar and rotating tips.
 */
import type { TrackDefinition } from '../core/types';
import { clamp01 } from '../core/math';
import { cssHex, el, TextField } from './dom';

const TIPS: readonly string[] = [
  'Hold DRIFT through a corner and release for a mini-turbo. Longer drift = bigger boost.',
  'Press GAS just as the countdown hits 1 for a ROCKET START. Too early and your engine burns out!',
  'Already holding gas? Tap DRIFT on "1" for a rocket start.',
  'Hold BRAKE while using a BOUNCER or SEEKER to throw it backwards.',
  'Use LOOK BACK to check what is coming before dropping a BANANA.',
  'Boost pads (glowing chevrons) give a free speed burst. Line them up.',
  'Item odds depend on your place. Trailing racers get SUPERNOVA, THUNDER and LEADER ZAP.',
  'SUPERNOVA makes you invincible and smashes any hazard you touch.',
  'Staying on the road matters: off-road cuts your top speed almost in half.',
  'Save a TURBO for the long straight, or to recover after a hit.',
  'Heavy karts bump light karts around. Pick your racer wisely.',
  'Hop off ramps and press DRIFT mid-air for a trick boost on landing.',
  'Press M on the host keyboard to mute the audio.',
];

const TIP_INTERVAL = 2.4;

export class LoadingScreen {
  private readonly rootNode: HTMLElement;
  private readonly title: TextField;
  private readonly subtitle: TextField;
  private readonly band: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly tipNode: HTMLElement;
  private readonly tipText: TextField;
  private tipTimer = 0;
  private tipIndex = 0;
  private progress = 0;
  private visible = false;

  constructor(root: HTMLElement) {
    this.rootNode = el('div', 'screen loading hidden', undefined, root);
    const panel = el('div', 'loading-panel', undefined, this.rootNode);
    this.band = el('div', 'loading-band', undefined, panel);
    const inner = el('div', 'loading-inner', undefined, panel);
    el('div', 'loading-kicker', 'NOW LOADING', inner);
    this.title = new TextField(el('h2', 'loading-title', '', inner));
    this.subtitle = new TextField(el('div', 'loading-subtitle', '', inner));
    const track = el('div', 'loading-track', undefined, inner);
    this.bar = el('div', 'loading-bar', undefined, track);
    el('div', 'loading-bar-shimmer', undefined, this.bar);
    this.tipNode = el('div', 'loading-tip', undefined, inner);
    el('span', 'loading-tip-label', 'TIP', this.tipNode);
    this.tipText = new TextField(el('span', 'loading-tip-text', '', this.tipNode));
  }

  show(def: TrackDefinition, laps = def.laps): void {
    this.title.set(def.name.toUpperCase());
    const stars = '★'.repeat(def.difficulty) + '☆'.repeat(3 - def.difficulty);
    this.subtitle.set(`${laps} LAP${laps === 1 ? '' : 'S'}  ·  ${stars}  ·  ${def.theme.toUpperCase()}`);
    const env = def.environment;
    this.band.style.background = `linear-gradient(90deg, ${cssHex(env.skyTop)}, ${cssHex(env.skyHorizon)}, ${cssHex(
      def.palette.road,
    )})`;
    this.tipIndex = Math.floor(Math.random() * TIPS.length);
    this.tipText.set(TIPS[this.tipIndex]);
    this.tipTimer = 0;
    this.setProgress(0);
    this.rootNode.classList.remove('hidden');
    this.visible = true;
  }

  hide(): void {
    this.rootNode.classList.add('hidden');
    this.visible = false;
  }

  setProgress(p: number): void {
    p = clamp01(p);
    if (Math.abs(p - this.progress) < 0.002) return;
    this.progress = p;
    this.bar.style.transform = `scaleX(${p.toFixed(3)})`;
  }

  update(dt: number): void {
    if (!this.visible) return;
    this.tipTimer += dt;
    if (this.tipTimer >= TIP_INTERVAL) {
      this.tipTimer = 0;
      this.tipIndex = (this.tipIndex + 1) % TIPS.length;
      this.tipText.set(TIPS[this.tipIndex]);
      this.tipNode.classList.remove('tip-in');
      void this.tipNode.offsetWidth;
      this.tipNode.classList.add('tip-in');
    }
  }

  dispose(): void {
    this.rootNode.remove();
  }
}
