/**
 * Smash Party audio: procedural SFX (built on src/audio/synth.ts), crowd, announcer
 * (speechSynthesis when available, ALWAYS backed by synth stingers) and per-stage music
 * (the shared kart `Sequencer`) with crossfades. Never throws.
 */
import { Sequencer } from '../../../audio/music';
import { midiToFreq, playChord, playNoiseBurst, playSequence, playTone, softClipCurve } from '../../../audio/synth';
import type { HitKind } from '../types';
import { buildSmashSong, type SmashTrack } from './songs';

const CROSSFADE = 0.9;

export class SmashAudio {
  ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private crowdBus: GainNode | null = null;
  private music: Sequencer | null = null;
  private trackValue: SmashTrack = 'none';
  private wantTrack: SmashTrack = 'none';
  private mutedValue = false;
  private volume = 0.9;
  private musicLevel = 1;
  private crowdSrc: AudioBufferSourceNode | null = null;
  private crowdGain: GainNode | null = null;
  private lastHitAt = 0;
  private active = false;

  get muted(): boolean {
    return this.mutedValue;
  }
  get track(): SmashTrack {
    return this.trackValue;
  }

  /** Create (first gesture / activate) or resume the context. */
  ensure(): void {
    try {
      if (!this.ctx) {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        const ctx = new Ctor();
        this.ctx = ctx;
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -14;
        comp.ratio.value = 5;
        comp.attack.value = 0.003;
        comp.release.value = 0.2;
        const shaper = ctx.createWaveShaper();
        shaper.curve = softClipCurve(1.3);
        this.master = ctx.createGain();
        this.master.gain.value = this.mutedValue ? 0 : this.volume;
        this.master.connect(comp);
        comp.connect(shaper);
        shaper.connect(ctx.destination);
        this.sfx = ctx.createGain();
        this.sfx.gain.value = 0.9;
        this.sfx.connect(this.master);
        this.musicBus = ctx.createGain();
        this.musicBus.gain.value = 0.42 * this.musicLevel;
        this.musicBus.connect(this.master);
        this.crowdBus = ctx.createGain();
        this.crowdBus.gain.value = 0.5;
        this.crowdBus.connect(this.master);
      }
      if (this.active && this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
      if (this.active && this.wantTrack !== this.trackValue) this.playMusic(this.wantTrack);
    } catch (err) {
      console.warn('[smash] audio init failed', err);
    }
  }

  setActive(on: boolean): void {
    this.active = on;
    if (on) {
      this.ensure();
    } else {
      this.stopCrowd();
      this.stopMusic(0.1);
      try {
        speechSynthesis?.cancel();
      } catch {
        /* no speech */
      }
      const ctx = this.ctx;
      if (ctx && ctx.state === 'running') setTimeout(() => {
        if (!this.active) void ctx.suspend().catch(() => undefined);
      }, 200);
    }
  }

  setMuted(m: boolean): void {
    this.mutedValue = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.03);
    if (m) {
      try {
        speechSynthesis?.cancel();
      } catch {
        /* */
      }
    }
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    this.setMuted(this.mutedValue);
  }

  /** 1 = match level, lower for the attract demo. */
  setMusicLevel(l: number): void {
    this.musicLevel = l;
    if (this.musicBus && this.ctx) this.musicBus.gain.setTargetAtTime(0.42 * l, this.ctx.currentTime, 0.3);
  }

  // ------------------------------------------------------------------ music

  playMusic(track: SmashTrack): void {
    this.wantTrack = track;
    const ctx = this.ctx;
    if (!ctx || !this.musicBus || !this.active) return;
    if (track === this.trackValue) return;
    try {
      if (this.music) this.music.stop(CROSSFADE);
      this.music = null;
      this.trackValue = track;
      const song = buildSmashSong(track);
      if (!song) return;
      const seq = new Sequencer(ctx, this.musicBus, song);
      seq.start(ctx.currentTime + 0.05, CROSSFADE);
      this.music = seq;
    } catch (err) {
      console.warn('[smash] music failed', err);
    }
  }

  stopMusic(fade = CROSSFADE): void {
    try {
      this.music?.stop(fade);
    } catch {
      /* */
    }
    this.music = null;
    this.trackValue = 'none';
    if (!this.active) this.wantTrack = 'none';
  }

  /** Duck the music (pause, GAME!). */
  duck(on: boolean): void {
    if (this.musicBus && this.ctx) this.musicBus.gain.setTargetAtTime(on ? 0.12 * this.musicLevel : 0.42 * this.musicLevel, this.ctx.currentTime, 0.15);
  }

  // ------------------------------------------------------------------ helpers

  private ok(): { ctx: AudioContext; out: GainNode } | null {
    if (!this.ctx || !this.sfx || !this.active || this.mutedValue) return null;
    if (this.ctx.state !== 'running') return null;
    return { ctx: this.ctx, out: this.sfx };
  }

  private safe(fn: (ctx: AudioContext, out: GainNode) => void): void {
    const a = this.ok();
    if (!a) return;
    try {
      fn(a.ctx, a.out);
    } catch (err) {
      console.warn('[smash] sfx error', err);
    }
  }

  // ------------------------------------------------------------------ SFX

  hit(strength: number, kind: HitKind, pan: number, shielded: boolean): void {
    this.safe((ctx, out) => {
      const now = ctx.currentTime;
      if (now - this.lastHitAt < 0.025) return;
      this.lastHitAt = now;
      const s = Math.max(0.05, Math.min(1, strength));
      if (shielded) {
        playTone(ctx, out, { freq: 900, endFreq: 500, type: 'triangle', duration: 0.06, gain: 0.18, pan, env: { attack: 0.002, decay: 0.05, sustain: 0.2, release: 0.08 } });
        playNoiseBurst(ctx, out, { duration: 0.05, gain: 0.12, filter: { type: 'bandpass', freq: 3000, q: 2 }, pan });
        return;
      }
      // body thump common to all
      playTone(ctx, out, { freq: 160 + 60 * (1 - s), endFreq: 45, type: 'sine', duration: 0.08 + 0.12 * s, gain: 0.35 + 0.45 * s, pan, env: { attack: 0.002, decay: 0.08, sustain: 0.3, release: 0.1 } });
      switch (kind) {
        case 'sword':
          playNoiseBurst(ctx, out, { duration: 0.12 + 0.1 * s, gain: 0.3 + 0.3 * s, filter: { type: 'highpass', freq: 3200, endFreq: 1800 }, pan });
          playTone(ctx, out, { freq: 1800, endFreq: 1200, type: 'sawtooth', duration: 0.05, gain: 0.08, pan, filter: { type: 'bandpass', freq: 2500, q: 4 } });
          break;
        case 'electric':
          playTone(ctx, out, { freq: 220, type: 'square', duration: 0.18 + 0.12 * s, gain: 0.13, pan, vibrato: { rate: 45, depth: 900 }, filter: { type: 'lowpass', freq: 3000 } });
          playNoiseBurst(ctx, out, { duration: 0.15, gain: 0.2, filter: { type: 'highpass', freq: 5000 }, pan });
          break;
        case 'fire':
        case 'explosion':
          playNoiseBurst(ctx, out, { duration: 0.25 + 0.3 * s, gain: 0.45 + 0.3 * s, color: 'brown', filter: { type: 'lowpass', freq: 1800, endFreq: 200 }, pan });
          playNoiseBurst(ctx, out, { duration: 0.2, gain: 0.2, filter: { type: 'bandpass', freq: 900, q: 1 }, pan });
          break;
        case 'bat':
          // the home-run CRACK
          playNoiseBurst(ctx, out, { duration: 0.04, gain: 0.7, filter: { type: 'bandpass', freq: 2400, q: 1.5 }, pan, env: { attack: 0.001, decay: 0.03, sustain: 0.2, release: 0.15 } });
          playTone(ctx, out, { freq: 1300, endFreq: 900, type: 'triangle', duration: 0.18, gain: 0.25, pan, env: { attack: 0.001, decay: 0.15, sustain: 0.2, release: 0.3 } });
          playSequence(ctx, out, [[0, 0.06], [7, 0.06], [12, 0.2]], { baseMidi: 84, type: 'triangle', gain: 0.1, when: now + 0.08 });
          break;
        case 'water':
          playNoiseBurst(ctx, out, { duration: 0.2, gain: 0.3, filter: { type: 'bandpass', freq: 1200, endFreq: 500, q: 3 }, pan });
          break;
        default:
          // punch / kick: snappy noise slap, brighter for strong hits
          playNoiseBurst(ctx, out, { duration: 0.05 + 0.08 * s, gain: 0.35 + 0.35 * s, filter: { type: 'bandpass', freq: 1400 + 1200 * s, q: 0.9 }, pan, env: { attack: 0.001, decay: 0.05, sustain: 0.15, release: 0.05 + 0.1 * s } });
          if (s > 0.6) playNoiseBurst(ctx, out, { duration: 0.3, gain: 0.3 * s, color: 'brown', filter: { type: 'lowpass', freq: 600 }, pan });
          break;
      }
    });
  }

  whoosh(strength: number, pan: number): void {
    this.safe((ctx, out) => {
      const s = Math.max(0.2, Math.min(1, strength));
      playNoiseBurst(ctx, out, {
        duration: 0.1 + 0.08 * s,
        gain: 0.1 + 0.12 * s,
        color: 'pink',
        filter: { type: 'bandpass', freq: 600, endFreq: 2600, q: 1.4 },
        env: { attack: 0.04, decay: 0.08, sustain: 0.3, release: 0.08 },
        pan,
      });
    });
  }

  jump(double: boolean, pan: number): void {
    this.safe((ctx, out) => {
      playTone(ctx, out, { freq: double ? 520 : 330, endFreq: double ? 980 : 640, type: 'triangle', duration: 0.07, gain: 0.07, pan, env: { attack: 0.003, decay: 0.05, sustain: 0.2, release: 0.05 } });
    });
  }

  land(hard: boolean, pan: number): void {
    this.safe((ctx, out) => {
      playNoiseBurst(ctx, out, { duration: hard ? 0.09 : 0.04, gain: hard ? 0.2 : 0.08, color: 'brown', filter: { type: 'lowpass', freq: 500 }, pan });
    });
  }

  dodge(pan: number): void {
    this.safe((ctx, out) => {
      playNoiseBurst(ctx, out, { duration: 0.12, gain: 0.08, filter: { type: 'highpass', freq: 2500, endFreq: 6000 }, pan });
      playTone(ctx, out, { freq: 1200, endFreq: 1800, type: 'sine', duration: 0.06, gain: 0.04, pan });
    });
  }

  ledge(pan: number): void {
    this.safe((ctx, out) => playTone(ctx, out, { freq: 700, endFreq: 520, type: 'square', duration: 0.03, gain: 0.05, pan, filter: { type: 'lowpass', freq: 2000 } }));
  }

  shieldBreak(pan: number): void {
    this.safe((ctx, out) => {
      playNoiseBurst(ctx, out, { duration: 0.35, gain: 0.4, filter: { type: 'highpass', freq: 3000 }, pan });
      playSequence(ctx, out, [[12, 0.06], [7, 0.06], [3, 0.06], [0, 0.25]], { baseMidi: 72, type: 'square', gain: 0.08, filter: { type: 'lowpass', freq: 3000 } });
    });
  }

  grab(pan: number): void {
    this.safe((ctx, out) => playNoiseBurst(ctx, out, { duration: 0.05, gain: 0.15, filter: { type: 'bandpass', freq: 800, q: 2 }, pan }));
  }

  pickup(): void {
    this.safe((ctx, out) => playSequence(ctx, out, [[0, 0.04], [7, 0.06]], { baseMidi: 79, type: 'square', gain: 0.06, filter: { type: 'lowpass', freq: 4000 } }));
  }

  heal(): void {
    this.safe((ctx, out) => playSequence(ctx, out, [[0, 0.07], [4, 0.07], [7, 0.07], [12, 0.18]], { baseMidi: 76, type: 'triangle', gain: 0.1 }));
  }

  powerUp(): void {
    this.safe((ctx, out) => {
      playSequence(ctx, out, [[0, 0.05], [4, 0.05], [7, 0.05], [12, 0.05], [16, 0.05], [19, 0.05], [24, 0.4]], { baseMidi: 72, type: 'square', gain: 0.07, filter: { type: 'lowpass', freq: 5000 } });
      playChord(ctx, out, [60, 64, 67, 72], { duration: 0.8, gain: 0.05, env: { attack: 0.2, decay: 0.3, sustain: 0.6, release: 0.5 } });
    });
  }

  explosion(size: number, pan: number): void {
    this.safe((ctx, out) => {
      const s = Math.max(0.4, Math.min(1.5, size));
      playNoiseBurst(ctx, out, { duration: 0.6 * s, gain: 0.65, color: 'brown', filter: { type: 'lowpass', freq: 2200, endFreq: 120 }, pan, env: { attack: 0.002, decay: 0.4, sustain: 0.3, release: 0.4 } });
      playTone(ctx, out, { freq: 90, endFreq: 30, type: 'sine', duration: 0.4, gain: 0.6, pan });
    });
  }

  /** Blast-zone KO: big boom + rising shimmer. */
  koBoom(pan: number): void {
    this.safe((ctx, out) => {
      const now = ctx.currentTime;
      playTone(ctx, out, { freq: 70, endFreq: 25, type: 'sine', duration: 0.7, gain: 0.9, pan, env: { attack: 0.002, decay: 0.5, sustain: 0.4, release: 0.6 } });
      playNoiseBurst(ctx, out, { duration: 0.9, gain: 0.6, color: 'brown', filter: { type: 'lowpass', freq: 3000, endFreq: 150 }, pan, env: { attack: 0.002, decay: 0.6, sustain: 0.3, release: 0.6 } });
      playNoiseBurst(ctx, out, { duration: 0.5, gain: 0.25, filter: { type: 'highpass', freq: 4000, endFreq: 9000 }, pan, when: now + 0.02 });
      playTone(ctx, out, { freq: 300, endFreq: 2400, type: 'sawtooth', duration: 0.5, gain: 0.06, filter: { type: 'lowpass', freq: 3000 }, pan, when: now + 0.05 });
    });
    this.crowd('cheer', 1);
  }

  hazardWarning(): void {
    this.safe((ctx, out) => {
      const now = ctx.currentTime;
      for (let i = 0; i < 3; i++) playTone(ctx, out, { freq: 440, endFreq: 660, type: 'square', duration: 0.18, gain: 0.05, when: now + i * 0.3, filter: { type: 'lowpass', freq: 2000 } });
    });
  }

  hazardErupt(): void {
    this.safe((ctx, out) => {
      playNoiseBurst(ctx, out, { duration: 1.4, gain: 0.5, color: 'brown', filter: { type: 'lowpass', freq: 900, endFreq: 300 }, env: { attack: 0.05, decay: 0.6, sustain: 0.6, release: 0.6 } });
      playTone(ctx, out, { freq: 55, endFreq: 40, type: 'sawtooth', duration: 1.0, gain: 0.15, filter: { type: 'lowpass', freq: 300 } });
    });
  }

  tick(urgent: boolean): void {
    this.safe((ctx, out) => playTone(ctx, out, { freq: urgent ? 1320 : 880, type: 'square', duration: 0.04, gain: 0.06, filter: { type: 'lowpass', freq: 3500 } }));
  }

  /** Short UI blip for the intro name cards. */
  swoosh(): void {
    this.safe((ctx, out) => playNoiseBurst(ctx, out, { duration: 0.25, gain: 0.12, color: 'pink', filter: { type: 'bandpass', freq: 400, endFreq: 3000, q: 1 }, env: { attack: 0.08, decay: 0.1, sustain: 0.3, release: 0.1 } }));
  }

  // ------------------------------------------------------------------ crowd

  /** Crowd reactions: 'ooh' on big hits, 'cheer' on KOs, 'roar' at GAME. */
  crowd(kind: 'ooh' | 'cheer' | 'roar', amount: number): void {
    this.safe((ctx) => {
      const out = this.crowdBus!;
      const now = ctx.currentTime;
      const a = Math.max(0.2, Math.min(1, amount));
      if (kind === 'ooh') {
        // a vowel-ish formant swell made of band-passed noise + a low murmur chord
        playNoiseBurst(ctx, out, { duration: 0.7, gain: 0.25 * a, color: 'pink', filter: { type: 'bandpass', freq: 500, endFreq: 380, q: 6 }, env: { attack: 0.12, decay: 0.3, sustain: 0.6, release: 0.4 } });
        playNoiseBurst(ctx, out, { duration: 0.7, gain: 0.12 * a, color: 'pink', filter: { type: 'bandpass', freq: 900, endFreq: 700, q: 8 }, env: { attack: 0.12, decay: 0.3, sustain: 0.6, release: 0.4 } });
        for (const m of [52, 55, 59, 64]) playTone(ctx, out, { freq: midiToFreq(m) * (1 + (Math.random() - 0.5) * 0.02), endFreq: midiToFreq(m - 2), type: 'sawtooth', duration: 0.5, gain: 0.012 * a, filter: { type: 'lowpass', freq: 900 }, env: { attack: 0.15, decay: 0.2, sustain: 0.7, release: 0.4 } });
      } else {
        const dur = kind === 'roar' ? 2.2 : 1.4;
        playNoiseBurst(ctx, out, { duration: dur, gain: 0.35 * a, color: 'pink', filter: { type: 'bandpass', freq: 1100, q: 0.7 }, env: { attack: 0.08, decay: 0.5, sustain: 0.6, release: 0.9 } });
        playNoiseBurst(ctx, out, { duration: dur * 0.8, gain: 0.18 * a, filter: { type: 'bandpass', freq: 2600, q: 1.5 }, env: { attack: 0.1, decay: 0.4, sustain: 0.5, release: 0.8 } });
        // a few whistles
        for (let i = 0; i < (kind === 'roar' ? 3 : 2); i++) {
          const t = now + 0.1 + Math.random() * 0.6;
          const f = 1800 + Math.random() * 900;
          playTone(ctx, out, { freq: f, endFreq: f * 1.25, type: 'sine', duration: 0.18, gain: 0.03 * a, when: t });
        }
      }
    });
  }

  /** Constant low crowd murmur bed (arena / matches). */
  startCrowd(level: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.crowdBus || this.crowdSrc) return;
    try {
      const len = Math.floor(ctx.sampleRate * 2);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) {
        last = 0.97 * last + 0.03 * (Math.random() * 2 - 1);
        d[i] = last * 4;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 700;
      f.Q.value = 0.5;
      const g = ctx.createGain();
      g.gain.value = 0.0001;
      g.gain.setTargetAtTime(0.18 * level, ctx.currentTime, 0.8);
      src.connect(f);
      f.connect(g);
      g.connect(this.crowdBus);
      src.start();
      this.crowdSrc = src;
      this.crowdGain = g;
    } catch {
      /* */
    }
  }

  stopCrowd(): void {
    const src = this.crowdSrc;
    const g = this.crowdGain;
    this.crowdSrc = null;
    this.crowdGain = null;
    if (!src || !g || !this.ctx) return;
    try {
      g.gain.setTargetAtTime(0.0001, this.ctx.currentTime, 0.2);
      src.stop(this.ctx.currentTime + 1);
      src.onended = () => {
        src.disconnect();
        g.disconnect();
      };
    } catch {
      /* */
    }
  }

  // ------------------------------------------------------------------ announcer

  private say(text: string, rate = 0.78, pitch = 0.35): void {
    if (this.mutedValue || !this.active) return;
    try {
      const ss = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
      if (!ss || typeof SpeechSynthesisUtterance === 'undefined') return;
      const u = new SpeechSynthesisUtterance(text);
      u.rate = rate;
      u.pitch = pitch;
      u.volume = Math.min(1, this.volume + 0.1);
      const voices = ss.getVoices?.() ?? [];
      const en = voices.filter((v) => /^en/i.test(v.lang));
      const male = en.find((v) => /male|daniel|fred|alex|david|george|guy|james|arthur/i.test(v.name) && !/female/i.test(v.name));
      const v = male ?? en[0];
      if (v) u.voice = v;
      ss.cancel();
      ss.speak(u);
    } catch {
      /* speech unavailable */
    }
  }

  /** "3", "2", "1" beeps (deep). */
  countdown(n: number): void {
    this.safe((ctx, out) => {
      playTone(ctx, out, { freq: midiToFreq(57), type: 'square', duration: 0.16, gain: 0.12, filter: { type: 'lowpass', freq: 1800 } });
      playTone(ctx, out, { freq: midiToFreq(45), type: 'sine', duration: 0.3, gain: 0.3 });
    });
    this.say(String(n), 0.85, 0.3);
  }

  go(): void {
    this.safe((ctx, out) => {
      playChord(ctx, out, [57, 64, 69, 73, 76], { duration: 0.5, gain: 0.07, type: 'sawtooth', env: { attack: 0.005, decay: 0.2, sustain: 0.6, release: 0.5 }, filter: { type: 'lowpass', freq: 4000 } });
      playTone(ctx, out, { freq: midiToFreq(81), type: 'square', duration: 0.4, gain: 0.1, filter: { type: 'lowpass', freq: 3500 } });
      playNoiseBurst(ctx, out, { duration: 0.6, gain: 0.25, filter: { type: 'highpass', freq: 4500 } });
    });
    this.crowd('cheer', 0.8);
    this.say('Go!', 0.8, 0.3);
  }

  game(): void {
    this.safe((ctx, out) => {
      const now = ctx.currentTime;
      playNoiseBurst(ctx, out, { duration: 1.2, gain: 0.35, filter: { type: 'highpass', freq: 3500 }, env: { attack: 0.002, decay: 0.8, sustain: 0.2, release: 0.8 } });
      playTone(ctx, out, { freq: 60, endFreq: 30, type: 'sine', duration: 0.8, gain: 0.8 });
      playChord(ctx, out, [45, 52, 57, 61, 64], { duration: 1.6, gain: 0.08, type: 'sawtooth', when: now + 0.05, env: { attack: 0.01, decay: 0.4, sustain: 0.7, release: 1.2 }, filter: { type: 'lowpass', freq: 2600 } });
    });
    this.crowd('roar', 1);
    this.say('Game!', 0.7, 0.25);
  }

  announce(text: string): void {
    this.say(text, 0.8, 0.3);
  }

  dispose(): void {
    this.setActive(false);
    try {
      void this.ctx?.close();
    } catch {
      /* */
    }
    this.ctx = null;
  }
}
