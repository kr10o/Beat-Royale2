import type { Project } from './protocol';

const RATE = 24000;
// Mirrors the generated Foundry v1 PCM pack; no browser-supplied audio is trusted.
export function samplePcm(index: number): Int16Array {
  const duration = [.5, .25, .1, .45, .25, .65][index];
  const out = new Int16Array(Math.floor(RATE * duration));
  let seed = 1977 + index, previous = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE; seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = seed / 2147483648 - 1, high = noise - previous; previous = noise;
    let value: number;
    if (index === 0) value = Math.sin(2 * Math.PI * (48 * t + 7 * (1 - Math.exp(-t * 35)))) * Math.exp(-t * 11);
    else if (index === 1) value = (.65 * noise + .35 * Math.sin(2 * Math.PI * 180 * t)) * Math.exp(-t * 19);
    else if (index === 2 || index === 3) value = high * .35 * Math.exp(-t * (index === 2 ? 55 : 12));
    else if (index === 4) value = noise * .65 * Math.exp(-t * 20) * (.4 + .6 * Math.pow(Math.cos(t * 240), 2));
    else value = Math.sin(2 * Math.PI * 65.406 * t) * Math.min(1, t * 150) * Math.exp(-t * 6);
    out[i] = Math.round(Math.max(-1, Math.min(1, value)) * 28000);
  }
  return out;
}
export function renderBeat(project: Project, seconds = 8): Uint8Array {
  const length = Math.floor(RATE * seconds), mix = new Float32Array(length * 2);
  const solo = project.tracks.some(t => t.solo), stepFrames = RATE * 60 / project.bpm / 4;
  project.tracks.forEach((track, index) => {
    if (track.muted || (solo && !track.solo)) return;
    const sample = samplePcm(index), left = Math.cos((track.pan + 1) * Math.PI / 4) * track.volume, right = Math.sin((track.pan + 1) * Math.PI / 4) * track.volume;
    for (let step = 0; step * stepFrames < length; step++) {
      if (!track.steps[step % 16]) continue;
      const start = Math.round(step * stepFrames);
      for (let i = 0; i < sample.length && start + i < length; i++) {
        mix[(start + i) * 2] += sample[i] * left; mix[(start + i) * 2 + 1] += sample[i] * right;
      }
    }
  });
  let peak = 0; for (const n of mix) peak = Math.max(peak, Math.abs(n));
  const scale = peak ? 27852 / peak : 1; // Equal peak headroom prevents loudness gaming.
  const wav = new Uint8Array(44 + mix.length * 2), view = new DataView(wav.buffer);
  function ascii(offset: number, text: string) { for (let i = 0; i < text.length; i++) wav[offset + i] = text.charCodeAt(i); }
  ascii(0, 'RIFF'); view.setUint32(4, wav.length - 8, true); ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, RATE, true); view.setUint32(28, RATE * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, mix.length * 2, true);
  for (let i = 0; i < mix.length; i++) view.setInt16(44 + i * 2, Math.round(mix[i] * scale), true);
  return wav;
}
