/**
 * Alert sounds, generated with WebAudio — no sound files (different sounds for stop vs target).
 * In the app they play directly in the page (the extension needed an offscreen document for this).
 */
export type SoundKind = 'stop' | 'target' | 'info';

interface Tone {
  freq: number;
  start: number;
  dur: number;
  type: OscillatorType;
  gain: number;
}

const PATTERNS: Record<SoundKind, Tone[]> = {
  // urgent: three falling square-wave beeps
  stop: [
    { freq: 880, start: 0, dur: 0.18, type: 'square', gain: 0.18 },
    { freq: 660, start: 0.24, dur: 0.18, type: 'square', gain: 0.18 },
    { freq: 440, start: 0.48, dur: 0.32, type: 'square', gain: 0.18 },
  ],
  // pleasant: rising C–E–G chime
  target: [
    { freq: 523.25, start: 0, dur: 0.22, type: 'sine', gain: 0.35 },
    { freq: 659.25, start: 0.2, dur: 0.22, type: 'sine', gain: 0.35 },
    { freq: 783.99, start: 0.4, dur: 0.45, type: 'sine', gain: 0.35 },
  ],
  info: [{ freq: 660, start: 0, dur: 0.18, type: 'sine', gain: 0.3 }],
};

let ctx: AudioContext | null = null;

export async function playTone(kind: SoundKind): Promise<void> {
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') await ctx.resume();
  const t0 = ctx.currentTime + 0.05;
  for (const t of PATTERNS[kind] ?? PATTERNS.info) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = t.type;
    osc.frequency.value = t.freq;
    g.gain.setValueAtTime(0, t0 + t.start);
    g.gain.linearRampToValueAtTime(t.gain, t0 + t.start + 0.02);
    g.gain.linearRampToValueAtTime(0, t0 + t.start + t.dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0 + t.start);
    osc.stop(t0 + t.start + t.dur + 0.05);
  }
}
