/**
 * SHELL — Party Rush TV audio: every `RushSfx` + shell stingers, synthesised with the shared WebAudio
 * helpers (src/audio/synth.ts), and a light looping music bed (procedural step sequencer) whose tempo
 * rises with the heat. The AudioContext is created / resumed on the first host key or click (browser
 * autoplay rules). Muted while paused, while the module is inactive and outside the loop.
 */
import { midiToFreq, playChord, playNoiseBurst, playTone } from '../../../audio/synth';
import type { RushSfx } from '../types';
import type { ShellSfx } from './state';

type Mood = 'off' | 'lobby' | 'intro' | 'play' | 'results';

/** Bars of the music bed: root notes (MIDI) of a cheerful I–V–vi–IV loop in C. */
const PROG = [48, 43, 45, 41];
const PROG_CHORD: number[][] = [
  [60, 64, 67],
  [59, 62, 67],
  [57, 60, 64],
  [57, 60, 65],
];
/** Lead riff (scale degrees above C5, -1 = rest), 16 steps per bar. */
const RIFF = [0, -1, 4, -1, 7, -1, 4, 9, -1, 7, -1, 4, 2, -1, 4, -1];
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];

export class RushAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private volume = 0.7;
  private muted = true;
  private mood: Mood = 'off';
  private heat = 1;
  private seqTimer = 0;
  private nextStep = 0;
  private step = 0;
  private armedOff: (() => void) | null = null;
  private lastSfx = new Map<string, number>();

  /** Listen for the first user gesture to unlock audio. */
  arm(): void {
    if (this.armedOff) return;
    const unlock = (): void => this.unlock();
    const opts = { capture: true, passive: true } as const;
    window.addEventListener('pointerdown', unlock, opts);
    window.addEventListener('keydown', unlock, opts);
    this.armedOff = () => {
      window.removeEventListener('pointerdown', unlock, opts);
      window.removeEventListener('keydown', unlock, opts);
    };
  }

  unlock(): void {
    try {
      if (!this.ctx) {
        const AC: typeof AudioContext | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0;
        const comp = this.ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.ratio.value = 4;
        this.master.connect(comp);
        comp.connect(this.ctx.destination);
        this.musicBus = this.ctx.createGain();
        this.musicBus.gain.value = 0.0001;
        this.musicBus.connect(this.master);
        this.sfxBus = this.ctx.createGain();
        this.sfxBus.gain.value = 0.9;
        this.sfxBus.connect(this.master);
        this.applyGain();
        this.applyMood();
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
    } catch {
      this.ctx = null;
    }
  }

  get unlocked(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    this.applyGain();
  }

  /** Mute everything (paused / inactive). */
  setMuted(m: boolean): void {
    if (m === this.muted) return;
    this.muted = m;
    this.applyGain();
  }

  setHeat(h: number): void {
    this.heat = Math.max(1, Math.min(3, h));
  }

  setMood(m: Mood): void {
    if (m === this.mood) return;
    this.mood = m;
    this.applyMood();
  }

  private applyGain(): void {
    const c = this.ctx;
    if (!c || !this.master) return;
    const g = this.muted ? 0 : this.volume * this.volume * 0.9;
    this.master.gain.setTargetAtTime(g, c.currentTime, 0.05);
  }

  private applyMood(): void {
    const c = this.ctx;
    if (!c || !this.musicBus) return;
    const level = this.mood === 'off' ? 0 : this.mood === 'play' ? 0.32 : this.mood === 'intro' ? 0.4 : 0.5;
    this.musicBus.gain.setTargetAtTime(Math.max(0.0001, level), c.currentTime, 0.3);
    if (this.mood === 'off') {
      window.clearInterval(this.seqTimer);
      this.seqTimer = 0;
    } else if (!this.seqTimer) {
      this.nextStep = c.currentTime + 0.1;
      this.seqTimer = window.setInterval(() => this.schedule(), 60);
    }
  }

  /** Look-ahead sequencer: schedule 16th notes up to 0.25 s ahead. */
  private schedule(): void {
    const c = this.ctx;
    const bus = this.musicBus;
    if (!c || !bus || c.state !== 'running') return;
    if (this.muted) {
      this.nextStep = c.currentTime + 0.05;
      return;
    }
    const bpm = 112 + (this.heat - 1) * 16 + (this.mood === 'play' ? 6 : 0);
    const stepDur = 60 / bpm / 4;
    if (this.nextStep < c.currentTime - 0.2) this.nextStep = c.currentTime + 0.02;
    while (this.nextStep < c.currentTime + 0.25) {
      this.playStep(this.step, this.nextStep, stepDur);
      this.nextStep += stepDur;
      this.step = (this.step + 1) % 64;
    }
  }

  private playStep(step: number, t: number, sd: number): void {
    const c = this.ctx!;
    const bus = this.musicBus!;
    const bar = Math.floor(step / 16) % 4;
    const s = step % 16;
    const playing = this.mood === 'play';
    // Kick on beats, a soft clap on 2 + 4.
    if (s % 4 === 0) playTone(c, bus, { freq: 150, endFreq: 45, sweepTime: 0.12, type: 'sine', duration: 0.09, gain: 0.55, when: t, env: { attack: 0.002, decay: 0.08, sustain: 0.2, release: 0.06 } });
    if (s === 4 || s === 12) playNoiseBurst(c, bus, { duration: 0.08, gain: 0.16, when: t, color: 'white', filter: { type: 'bandpass', freq: 1800, q: 0.8 } });
    // Hats (8ths, 16ths at heat 3 / during play).
    if (s % 2 === 0 || (playing && this.heat >= 2)) playNoiseBurst(c, bus, { duration: 0.025, gain: s % 4 === 2 ? 0.09 : 0.05, when: t, color: 'white', filter: { type: 'highpass', freq: 7000 } });
    // Bass: root on 8ths with an octave bounce.
    if (s % 2 === 0) {
      const root = PROG[bar] + (s % 4 === 2 ? 12 : 0);
      playTone(c, bus, { freq: midiToFreq(root), type: 'triangle', duration: sd * 1.4, gain: 0.22, when: t, env: { attack: 0.005, decay: 0.08, sustain: 0.5, release: 0.04 } });
    }
    // Stabs on the off-beats (lobby/intro feel lighter, play more driving).
    if (s === 2 || s === 10 || (playing && (s === 6 || s === 14))) {
      playChord(c, bus, PROG_CHORD[bar], { type: 'square', gain: 0.025, duration: sd * 0.9, when: t, env: { attack: 0.004, decay: 0.05, sustain: 0.3, release: 0.05 }, filter: { type: 'lowpass', freq: 2200 } });
    }
    // Lead riff only on the scoreboard / intro (keeps play uncluttered for the minigame sfx).
    if (!playing && bar % 2 === 1) {
      const n = RIFF[s];
      if (n >= 0) playTone(c, bus, { freq: midiToFreq(72 + n), type: 'square', duration: sd * 0.8, gain: 0.045, when: t, env: { attack: 0.003, decay: 0.05, sustain: 0.4, release: 0.05 }, filter: { type: 'lowpass', freq: 3000 } });
    }
  }

  /** Play a TV sound effect (minigame RushSfx or a shell stinger). */
  sfx(name: RushSfx | ShellSfx, o: { pan?: number; vol?: number; pitch?: number } = {}): void {
    const c = this.ctx;
    const bus = this.sfxBus;
    if (!c || !bus || c.state !== 'running' || this.muted) return;
    // Rate-limit identical sounds (16 players flicking at once must not clip into noise).
    const now = c.currentTime;
    const last = this.lastSfx.get(name) ?? -1;
    if (now - last < 0.035) return;
    this.lastSfx.set(name, now);
    const v = Math.max(0, Math.min(1, o.vol ?? 1));
    const p = Math.max(0.25, Math.min(4, o.pitch ?? 1));
    const pan = o.pan;
    const tone = (freq: number, dur: number, type: OscillatorType, gain: number, endFreq?: number, when = 0): void => {
      playTone(c, bus, { freq: freq * p, endFreq: endFreq ? endFreq * p : undefined, type, duration: dur, gain: gain * v, when: now + when, pan, env: { attack: 0.004, decay: dur * 0.5, sustain: 0.4, release: 0.06 } });
    };
    const noise = (dur: number, gain: number, f: BiquadFilterType, freq: number, endFreq?: number, color: 'white' | 'pink' | 'brown' = 'white', when = 0): void => {
      playNoiseBurst(c, bus, { duration: dur, gain: gain * v, color, when: now + when, pan, filter: { type: f, freq, endFreq } });
    };
    switch (name) {
      case 'tick':
        tone(1200, 0.04, 'triangle', 0.25);
        break;
      case 'count':
        tone(660, 0.12, 'square', 0.22);
        break;
      case 'go':
        tone(523, 0.1, 'square', 0.3);
        tone(784, 0.1, 'square', 0.3, undefined, 0.08);
        tone(1047, 0.35, 'square', 0.32, undefined, 0.16);
        noise(0.4, 0.18, 'highpass', 3000, 8000, 'white', 0.16);
        break;
      case 'whoosh':
        noise(0.35, 0.3, 'bandpass', 400, 3000);
        break;
      case 'pop':
        tone(500, 0.06, 'square', 0.3, 1500);
        noise(0.05, 0.2, 'highpass', 2000);
        break;
      case 'boom':
        tone(120, 0.5, 'sine', 0.6, 30);
        noise(0.7, 0.55, 'lowpass', 1200, 80, 'brown');
        break;
      case 'ding':
        tone(1320, 0.25, 'triangle', 0.3);
        tone(1760, 0.3, 'sine', 0.2, undefined, 0.05);
        break;
      case 'buzz':
        tone(140, 0.28, 'sawtooth', 0.22, 110);
        break;
      case 'splash':
        noise(0.45, 0.35, 'bandpass', 1500, 300, 'pink');
        tone(600, 0.1, 'sine', 0.15, 200);
        break;
      case 'thud':
        tone(180, 0.12, 'sine', 0.5, 60);
        noise(0.08, 0.25, 'lowpass', 800);
        break;
      case 'drum':
        tone(110, 0.18, 'sine', 0.6, 50);
        noise(0.12, 0.25, 'lowpass', 600, 200, 'brown');
        break;
      case 'boing':
        playTone(c, bus, { freq: 220 * p, endFreq: 660 * p, type: 'sine', duration: 0.3, gain: 0.3 * v, when: now, pan, vibrato: { rate: 18, depth: 60 } });
        break;
      case 'honk':
        tone(330, 0.25, 'sawtooth', 0.18);
        tone(262, 0.3, 'sawtooth', 0.16, undefined, 0.22);
        break;
      case 'fanfare':
        [0, 4, 7, 12].forEach((n, i) => tone(midiToFreq(67 + n), i === 3 ? 0.5 : 0.12, 'square', 0.2, undefined, i * 0.11));
        playChord(c, bus, [67, 71, 74, 79], { type: 'sawtooth', gain: 0.05 * v, duration: 0.6, when: now + 0.44, filter: { type: 'lowpass', freq: 3000 } });
        break;
      case 'reel':
        noise(0.03, 0.2, 'highpass', 4000);
        break;
      case 'crowd':
        noise(1.1, 0.25, 'bandpass', 500, 900, 'pink');
        break;
      case 'join':
        tone(523, 0.08, 'square', 0.2);
        tone(659, 0.08, 'square', 0.2, undefined, 0.07);
        tone(784, 0.16, 'square', 0.22, undefined, 0.14);
        break;
      case 'heat':
        tone(200, 0.6, 'sawtooth', 0.22, 800);
        noise(0.6, 0.25, 'bandpass', 300, 3000, 'pink');
        break;
      case 'crown':
        [0, 4, 7, 12, 16].forEach((n, i) => tone(midiToFreq(72 + n), 0.14, 'triangle', 0.25, undefined, i * 0.09));
        break;
      case 'oops':
        tone(392, 0.15, 'square', 0.2);
        tone(330, 0.15, 'square', 0.2, undefined, 0.15);
        tone(262, 0.35, 'square', 0.2, 200, 0.3);
        break;
      case 'card':
        noise(0.3, 0.2, 'bandpass', 600, 2500);
        tone(880, 0.12, 'triangle', 0.15, undefined, 0.15);
        break;
      case 'pts':
        tone(PENTA[Math.floor(Math.random() * PENTA.length)] * 10 + 900, 0.06, 'triangle', 0.14);
        break;
      case 'pause':
        tone(440, 0.1, 'triangle', 0.2, 330);
        break;
    }
  }

  dispose(): void {
    window.clearInterval(this.seqTimer);
    this.seqTimer = 0;
    this.armedOff?.();
    this.armedOff = null;
    try {
      void this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.ctx = null;
  }
}
