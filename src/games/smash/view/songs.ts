/**
 * Smash Party procedural music: per-stage songs played by the shared kart `Sequencer`
 * (src/audio/music.ts). Original compositions, built from note tables.
 */
import { buildResultsSong, type Bar, type Instrument, type NoteEvent, type Song } from '../../../audio/music';

export type SmashTrack = 'sky' | 'arena' | 'forge' | 'training' | 'attract' | 'results' | 'none';

class B {
  readonly notes: NoteEvent[] = [];
  add(inst: Instrument, step: number, note: number, dur: number, vel = 1): this {
    this.notes.push({ inst, step, note, dur, vel });
    return this;
  }
  drums(pattern: { k?: number[]; s?: number[]; h?: number[]; o?: number[] }, vel = 1): this {
    for (const s of pattern.k ?? []) this.add('kick', s, 0, 1, vel);
    for (const s of pattern.s ?? []) this.add('snare', s, 0, 1, 0.9 * vel);
    for (const s of pattern.h ?? []) this.add('hatC', s, 0, 1, (s % 4 === 2 ? 0.7 : 0.4) * vel);
    for (const s of pattern.o ?? []) this.add('hatO', s, 0, 1, 0.45 * vel);
    return this;
  }
  chord(inst: Instrument, step: number, notes: readonly number[], dur: number, vel = 1): this {
    for (const n of notes) this.add(inst, step, n, dur, vel);
    return this;
  }
  mel(inst: Instrument, m: readonly (readonly [number, number, number])[], vel = 1): this {
    for (const [s, n, d] of m) this.add(inst, s, n, d, vel);
    return this;
  }
  build(): Bar {
    return { notes: this.notes };
  }
}

const range = (a: number, b: number, step = 1): number[] => {
  const r: number[] = [];
  for (let i = a; i < b; i += step) r.push(i);
  return r;
};

type Ch = { root: number; tones: number[] };

/** Skyline Summit: bright heroic A major, 144 bpm. */
function skySong(): Song {
  const A: Ch = { root: 45, tones: [69, 73, 76] };
  const E: Ch = { root: 40, tones: [68, 71, 76] };
  const Fm: Ch = { root: 42, tones: [69, 73, 78] };
  const D: Ch = { root: 38, tones: [66, 69, 74] };
  const prog = [A, E, Fm, D, A, E, D, E];
  const lead: (readonly [number, number, number])[][] = [
    [[0, 81, 3], [4, 83, 2], [6, 85, 4], [12, 88, 4]],
    [[0, 86, 2], [2, 85, 2], [4, 83, 4], [8, 80, 4], [12, 83, 4]],
    [[0, 85, 3], [4, 81, 2], [6, 78, 2], [8, 81, 6], [14, 85, 2]],
    [[0, 86, 4], [4, 85, 2], [6, 83, 2], [8, 81, 4], [12, 78, 4]],
    [[0, 81, 2], [2, 85, 2], [4, 88, 4], [8, 90, 2], [10, 88, 2], [12, 85, 4]],
    [[0, 83, 2], [2, 85, 2], [4, 86, 4], [8, 88, 4], [12, 83, 4]],
    [[0, 86, 2], [2, 88, 2], [4, 90, 4], [8, 88, 2], [10, 86, 2], [12, 85, 4]],
    [[0, 83, 6], [8, 85, 2], [10, 86, 2], [12, 88, 4]],
  ];
  const bars: Bar[] = [];
  for (let i = 0; i < 16; i++) {
    const c = prog[i % 8];
    const b = new B();
    b.drums({ k: [0, 6, 8, 11], s: [4, 12], h: range(0, 16, 2), o: i % 2 ? [14] : [] });
    if (i % 8 === 0) b.add('crash', 0, 0, 1, 0.7);
    for (let s = 0; s < 16; s += 2) b.add('bass', s, c.root + (s % 8 === 6 ? 12 : 0), 2, s % 4 === 0 ? 1 : 0.75);
    b.chord('chord', 0, c.tones, 3, 0.8).chord('chord', 6, c.tones, 2, 0.6).chord('chord', 10, c.tones, 3, 0.7);
    if (i >= 8) b.mel('lead', lead[i - 8], 0.95);
    else for (let s = 0; s < 16; s += 2) b.add('arp', s, c.tones[(s / 2) % 3] + 12, 1, 0.5);
    bars.push(b.build());
  }
  return { bpm: 144, transpose: 0, bars, loopStart: 0, leadDelay: 1, gain: 0.9 };
}

/** Neon Arena: driving E minor rock pulse, 156 bpm. */
function arenaSong(): Song {
  const Em: Ch = { root: 40, tones: [64, 67, 71] };
  const C: Ch = { root: 36, tones: [64, 67, 72] };
  const G: Ch = { root: 43, tones: [62, 67, 71] };
  const Dm: Ch = { root: 38, tones: [62, 66, 69] };
  const prog = [Em, Em, C, Dm, Em, Em, C, G];
  const riff = [0, 0, 12, 0, 10, 0, 7, 0, 0, 0, 12, 0, 15, 12, 10, 7];
  const lead: (readonly [number, number, number])[][] = [
    [[0, 76, 2], [2, 79, 2], [4, 83, 6], [12, 81, 2], [14, 79, 2]],
    [[0, 78, 4], [4, 79, 2], [6, 76, 6], [12, 74, 4]],
    [[0, 76, 2], [2, 79, 2], [4, 84, 6], [12, 83, 2], [14, 81, 2]],
    [[0, 79, 4], [4, 78, 4], [8, 74, 8]],
  ];
  const bars: Bar[] = [];
  for (let i = 0; i < 16; i++) {
    const c = prog[i % 8];
    const b = new B();
    b.drums({ k: [0, 3, 8, 10], s: [4, 12], h: range(0, 16, 1).filter((s) => s % 2 === 0 || i >= 8) }, 1);
    if (i % 4 === 3) b.add('snare', 14, 0, 1, 0.6).add('snare', 15, 0, 1, 0.8);
    if (i % 8 === 0) b.add('crash', 0, 0, 1, 0.8);
    for (let s = 0; s < 16; s++) if (s % 2 === 0 || riff[s] !== 0) b.add('bass', s, c.root + riff[s], 1, s % 4 === 0 ? 1 : 0.7);
    b.chord('chord', 0, c.tones, 6, 0.85).chord('chord', 8, c.tones, 6, 0.8);
    if (i >= 8) b.mel('lead', lead[(i - 8) % 4], 1);
    else b.add('bell', 0, c.tones[2] + 12, 4, 0.4);
    bars.push(b.build());
  }
  return { bpm: 156, transpose: 0, bars, loopStart: 0, leadDelay: 0.7, gain: 0.9 };
}

/** Magma Forge: heavy D phrygian groove with anvil bells, 128 bpm. */
function forgeSong(): Song {
  const Dm: Ch = { root: 38, tones: [62, 65, 69] };
  const Eb: Ch = { root: 39, tones: [63, 67, 70] };
  const Bb: Ch = { root: 34, tones: [62, 65, 70] };
  const A: Ch = { root: 33, tones: [61, 64, 69] };
  const prog = [Dm, Eb, Dm, Eb, Bb, A, Dm, A];
  const lead: (readonly [number, number, number])[][] = [
    [[0, 74, 4], [4, 75, 4], [8, 74, 2], [10, 72, 2], [12, 70, 4]],
    [[0, 69, 6], [8, 70, 4], [12, 72, 4]],
    [[0, 74, 4], [4, 77, 4], [8, 75, 4], [12, 74, 4]],
    [[0, 73, 8], [8, 76, 4], [12, 73, 4]],
  ];
  const bars: Bar[] = [];
  for (let i = 0; i < 16; i++) {
    const c = prog[i % 8];
    const b = new B();
    b.drums({ k: [0, 2, 8, 10, 11], s: [4, 12], h: range(2, 16, 4), o: [14] });
    if (i % 8 === 0) b.add('crash', 0, 0, 1, 0.9);
    for (const s of [0, 2, 3, 6, 8, 10, 11, 14]) b.add('bass', s, c.root + (s === 14 ? 1 : 0), 1, s % 8 === 0 ? 1 : 0.8);
    b.add('bell', 0, c.root + 36, 2, 0.6).add('bell', 7, c.root + 37, 2, 0.4);
    b.chord('pad', 0, c.tones, 16, 0.9);
    if (i >= 8) b.mel('lead', lead[(i - 8) % 4], 0.85);
    bars.push(b.build());
  }
  return { bpm: 128, transpose: 0, bars, loopStart: 0, leadDelay: 0.9, gain: 0.95 };
}

/** Training Room: laid-back F major funk, 108 bpm. */
function trainingSong(): Song {
  const F: Ch = { root: 41, tones: [65, 69, 72, 76] };
  const Dm: Ch = { root: 38, tones: [65, 69, 72, 74] };
  const Bb: Ch = { root: 46, tones: [65, 69, 70, 74] };
  const C: Ch = { root: 36, tones: [64, 67, 70, 72] };
  const prog = [F, Dm, Bb, C];
  const bars: Bar[] = [];
  for (let i = 0; i < 8; i++) {
    const c = prog[i % 4];
    const b = new B();
    b.drums({ k: [0, 7, 10], s: [4, 12], h: range(0, 16, 2) }, 0.75);
    b.add('bass', 0, c.root, 3, 1).add('bass', 3, c.root + 12, 1, 0.6).add('bass', 6, c.root + 7, 2, 0.8).add('bass', 10, c.root, 2, 0.8).add('bass', 14, c.root + 10, 2, 0.6);
    b.chord('chord', 2, c.tones, 1, 0.6).chord('chord', 6, c.tones, 1, 0.5).chord('chord', 10, c.tones, 1, 0.6).chord('chord', 13, c.tones, 2, 0.5);
    if (i >= 4) for (let s = 0; s < 16; s += 2) b.add('arp', s, c.tones[(s / 2) % 4] + 12, 1, 0.35);
    bars.push(b.build());
  }
  return { bpm: 108, transpose: 0, bars, loopStart: 0, leadDelay: 0.6, gain: 0.85 };
}

/** Calm attract-demo variant (behind the hub menus). */
function attractSong(): Song {
  const prog: Ch[] = [
    { root: 45, tones: [64, 69, 73, 76] },
    { root: 42, tones: [64, 69, 73, 78] },
    { root: 38, tones: [62, 66, 69, 73] },
    { root: 40, tones: [64, 68, 71, 76] },
  ];
  const bars: Bar[] = [];
  for (let i = 0; i < 8; i++) {
    const c = prog[i % 4];
    const b = new B();
    b.add('kick', 0, 0, 1, 0.45).add('kick', 10, 0, 1, 0.3);
    for (const s of [4, 12]) b.add('hatC', s, 0, 1, 0.25);
    b.add('bass', 0, c.root, 8, 0.65).add('bass', 8, c.root + 7, 8, 0.45);
    b.chord('pad', 0, c.tones, 16, 0.75);
    const seq = [0, 1, 2, 3, 2, 1, 2, 3];
    for (let k = 0; k < 8; k++) b.add('arp', k * 2, c.tones[seq[k]] + 12, 2, 0.35);
    if (i >= 4) b.add('bell', 0, c.tones[3] + 12, 6, 0.3).add('bell', 8, c.tones[2] + 12, 6, 0.25);
    bars.push(b.build());
  }
  return { bpm: 92, transpose: 0, bars, loopStart: 0, leadDelay: 1, gain: 0.7 };
}

export function buildSmashSong(track: SmashTrack): Song | null {
  switch (track) {
    case 'sky':
      return skySong();
    case 'arena':
      return arenaSong();
    case 'forge':
      return forgeSong();
    case 'training':
      return trainingSong();
    case 'attract':
      return attractSong();
    case 'results': {
      const s = buildResultsSong();
      return { ...s, transpose: 2, bpm: 120 };
    }
    default:
      return null;
  }
}
