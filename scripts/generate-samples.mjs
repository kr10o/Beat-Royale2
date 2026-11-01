import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const folder = new URL('../public/samples/foundry-v1/', import.meta.url);
await mkdir(folder, { recursive: true });
const rate = 24000;
const sounds = ['kick', 'snare', 'closed-hat', 'open-hat', 'clap', 'sub'];
const samples = [];
for (const [index, name] of sounds.entries()) {
  const duration = [.5, .25, .1, .45, .25, .65][index];
  const length = Math.floor(rate * duration);
  const wav = Buffer.alloc(44 + length * 2);
  wav.write('RIFF'); wav.writeUInt32LE(36 + length * 2, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(length * 2, 40);
  let seed = 1977 + index, previous = 0;
  for (let i = 0; i < length; i++) {
    const t = i / rate;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = seed / 2147483648 - 1;
    const high = noise - previous; previous = noise;
    let value;
    if (index === 0) value = Math.sin(2 * Math.PI * (48 * t + 7 * (1 - Math.exp(-t * 35)))) * Math.exp(-t * 11);
    else if (index === 1) value = (.65 * noise + .35 * Math.sin(2 * Math.PI * 180 * t)) * Math.exp(-t * 19);
    else if (index === 2 || index === 3) value = high * .35 * Math.exp(-t * (index === 2 ? 55 : 12));
    else if (index === 4) value = noise * .65 * Math.exp(-t * 20) * (.4 + .6 * Math.pow(Math.cos(t * 240), 2));
    else value = Math.sin(2 * Math.PI * 65.406 * t) * Math.min(1, t * 150) * Math.exp(-t * 6);
    wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 28000), 44 + i * 2);
  }
  await writeFile(new URL(`${name}.wav`, folder), wav);
  samples.push({ name, url: `/samples/foundry-v1/${name}.wav`, sha256: createHash('sha256').update(wav).digest('hex') });
}
await writeFile(new URL('manifest.json', folder), JSON.stringify({ id: 'foundry-v1', license: 'CC0-1.0', samples }, null, 2));
console.log('Generated 6 original deterministic PCM samples and integrity manifest.');
