/**
 * PARTY RUSH — tiny procedural WebAudio blips from the phone itself (no assets).
 * The phone sound is one third of the triple cue: iPhones can't vibrate from the web, so flash + sound
 * must work on their own. `unlockAudio()` must run inside the join tap (iOS/Android autoplay rules).
 */
import type { RushFx } from '../../net/protocol';

type AC = AudioContext;
let ctx: AC | null = null;
let master: GainNode | null = null;

/** Create / resume the AudioContext. Call from a user gesture (tap). Safe to call often. */
export function unlockAudio(): void {
  try {
    if (!ctx) {
      const Ctor = (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as
        | typeof AudioContext
        | undefined;
      if (!Ctor) return;
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = 0.55;
      master.connect(ctx.destination);
    }
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    // iOS: play one silent buffer inside the gesture so later sounds are allowed.
    const b = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = b;
    src.connect(ctx.destination);
    src.start(0);
  } catch {
    /* no audio: the flash still works */
  }
}

export function audioState(): string {
  return ctx ? ctx.state : 'none';
}

function tone(freq: number, dur: number, opts: { type?: OscillatorType; vol?: number; at?: number; slide?: number; attack?: number } = {}): void {
  if (!ctx || !master || ctx.state !== 'running') return;
  const t0 = ctx.currentTime + (opts.at ?? 0);
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = opts.type ?? 'square';
  o.frequency.setValueAtTime(freq, t0);
  if (opts.slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, opts.slide), t0 + dur);
  const v = opts.vol ?? 0.3;
  const a = opts.attack ?? 0.005;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(v, t0 + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g);
  g.connect(master);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

function noise(dur: number, vol = 0.4, at = 0, lowpass = 1800): void {
  if (!ctx || !master || ctx.state !== 'running') return;
  const t0 = ctx.currentTime + at;
  const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = lowpass;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f);
  f.connect(g);
  g.connect(master);
  src.start(t0);
}

export type RushSfx = RushFx | 'count' | 'fuse' | 'tap' | 'join';

/** Play one short blip. Every call is fire-and-forget and silently no-ops without audio. */
export function sfx(kind: RushSfx, strength = 0.5): void {
  try {
    switch (kind) {
      case 'none':
        return;
      case 'count':
        tone(660, 0.12, { type: 'square', vol: 0.22 });
        return;
      case 'go':
        tone(880, 0.09, { type: 'square', vol: 0.3 });
        tone(1320, 0.28, { type: 'square', vol: 0.3, at: 0.08 });
        return;
      case 'good':
        tone(784, 0.1, { type: 'triangle', vol: 0.35 });
        tone(1175, 0.18, { type: 'triangle', vol: 0.35, at: 0.08 });
        return;
      case 'bad':
        tone(220, 0.35, { type: 'sawtooth', vol: 0.25, slide: 110 });
        return;
      case 'buzz':
        for (let i = 0; i < 4; i++) tone(i % 2 ? 980 : 740, 0.07, { type: 'square', vol: 0.3, at: i * 0.075 });
        return;
      case 'boom':
        noise(0.7, 0.7, 0, 900);
        tone(120, 0.6, { type: 'sine', vol: 0.6, slide: 40 });
        return;
      case 'tick':
        tone(1000 + strength * 400, 0.04, { type: 'square', vol: 0.18 });
        return;
      case 'fuse':
        tone(1500 + strength * 900, 0.035, { type: 'square', vol: 0.14 + strength * 0.12 });
        return;
      case 'win':
        [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, { type: 'triangle', vol: 0.32, at: i * 0.09 }));
        return;
      case 'tap':
        tone(520 + Math.random() * 80, 0.03, { type: 'triangle', vol: 0.12 });
        return;
      case 'join':
        tone(523, 0.08, { type: 'triangle', vol: 0.3 });
        tone(784, 0.08, { type: 'triangle', vol: 0.3, at: 0.07 });
        tone(1047, 0.16, { type: 'triangle', vol: 0.3, at: 0.14 });
        return;
    }
  } catch {
    /* ignore */
  }
}
