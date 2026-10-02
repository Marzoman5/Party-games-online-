/**
 * Tiny WebAudio blip synth for party overlays (tutorial callouts, joins, ready ticks).
 * The AudioContext is created lazily on the first user gesture; every failure is silent.
 */
type Ctx = AudioContext;

let ctx: Ctx | null = null;
let master: GainNode | null = null;
let armed = false;

function unlock(): void {
  try {
    if (!ctx) {
      const AC: typeof AudioContext | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.22;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  } catch {
    ctx = null;
  }
}

/** Arm gesture listeners once (pointer/key/touch anywhere on the host page). */
export function armSfx(): () => void {
  if (armed) return () => undefined;
  armed = true;
  const opts = { capture: true, passive: true } as const;
  window.addEventListener('pointerdown', unlock, opts);
  window.addEventListener('keydown', unlock, opts);
  return () => {
    window.removeEventListener('pointerdown', unlock, opts);
    window.removeEventListener('keydown', unlock, opts);
    armed = false;
  };
}

function tone(freq: number, start: number, dur: number, type: OscillatorType, gain: number, slideTo?: number): void {
  if (!ctx || !master || ctx.state !== 'running') return;
  try {
    const t0 = ctx.currentTime + start;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(master);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  } catch {
    /* ignore */
  }
}

export type Blip = 'pop' | 'step' | 'join' | 'ready' | 'spark' | 'item' | 'boost' | 'done';

export function blip(kind: Blip): void {
  if (!ctx) return;
  switch (kind) {
    case 'pop':
      tone(520, 0, 0.09, 'square', 0.35, 880);
      break;
    case 'step':
      tone(660, 0, 0.08, 'triangle', 0.5);
      tone(990, 0.07, 0.12, 'triangle', 0.45);
      break;
    case 'join':
      tone(523, 0, 0.1, 'square', 0.3);
      tone(659, 0.08, 0.1, 'square', 0.3);
      tone(784, 0.16, 0.18, 'square', 0.3);
      break;
    case 'ready':
      tone(880, 0, 0.07, 'triangle', 0.5);
      tone(1320, 0.06, 0.14, 'triangle', 0.4);
      break;
    case 'spark':
      tone(1200, 0, 0.05, 'sawtooth', 0.15, 2400);
      break;
    case 'item':
      tone(300, 0, 0.12, 'square', 0.3, 1200);
      break;
    case 'boost':
      tone(180, 0, 0.35, 'sawtooth', 0.25, 900);
      break;
    case 'done':
      tone(523, 0, 0.12, 'triangle', 0.5);
      tone(784, 0.1, 0.12, 'triangle', 0.5);
      tone(1047, 0.2, 0.3, 'triangle', 0.5);
      break;
  }
}
