import { PACK, type Project } from '../shared/protocol';

export class AudioEngine {
  private context: AudioContext;
  private buffers: AudioBuffer[] = [];
  private master: GainNode;
  private timer: ReturnType<typeof setInterval> | undefined;
  private sources = new Set<AudioBufferSourceNode>();
  private project: Project | null = null;
  private epoch = '';
  private nextStep = 0;
  offset = 0;
  constructor() {
    this.context = new AudioContext();
    this.master = this.context.createGain(); this.master.gain.value = .65;
    const limiter = this.context.createDynamicsCompressor();
    limiter.threshold.value = -6; limiter.ratio.value = 12;
    this.master.connect(limiter); limiter.connect(this.context.destination);
  }
  async prepare(): Promise<void> {
    // Called synchronously from a user gesture, before network awaits.
    await this.context.resume();
    if (this.buffers.length) return;
    const response = await fetch(`/samples/${PACK}/manifest.json`);
    if (!response.ok) throw new Error('Sample pack unavailable. Please retry.');
    const manifest = await response.json() as { id: string; samples: { url: string; sha256: string }[] };
    if (manifest.id !== PACK || manifest.samples.length !== 6) throw new Error('Incorrect sample pack.');
    this.buffers = await Promise.all(manifest.samples.map(async sample => {
      const response = await fetch(sample.url);
      if (!response.ok) throw new Error('Could not load all samples.');
      const bytes = await response.arrayBuffer();
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
      if (hash !== sample.sha256) throw new Error('Sample integrity check failed.');
      return this.context.decodeAudioData(bytes);
    }));
    this.timer = setInterval(() => this.schedule(), 25);
  }
  get running(): boolean { return this.context.state === 'running'; }
  async resume(): Promise<void> { await this.context.resume(); }
  setVolume(value: number): void { this.master.gain.setTargetAtTime(value, this.context.currentTime, .02); }
  setProject(project: Project | null): void {
    const epoch = project ? `${project.startedAt}:${project.bpm}:${project.playing}` : '';
    if (epoch !== this.epoch) { this.stopSources(); this.nextStep = 0; this.epoch = epoch; }
    this.project = project;
  }
  private schedule(): void {
    const p = this.project;
    if (!p?.playing || !this.running) return;
    const now = Date.now() + this.offset;
    const stepMs = 60000 / p.bpm / 4;
    this.nextStep = Math.max(this.nextStep, Math.ceil((now - p.startedAt) / stepMs));
    const solo = p.tracks.some(t => t.solo);
    while (p.startedAt + this.nextStep * stepMs < now + 110) {
      const when = this.context.currentTime + Math.max(0, (p.startedAt + this.nextStep * stepMs - now) / 1000);
      p.tracks.forEach((track, i) => {
        if (!track.steps[this.nextStep % 16] || track.muted || (solo && !track.solo)) return;
        const source = this.context.createBufferSource(); source.buffer = this.buffers[i];
        const gain = this.context.createGain(); gain.gain.value = track.volume;
        const pan = this.context.createStereoPanner(); pan.pan.value = track.pan;
        source.connect(gain); gain.connect(pan); pan.connect(this.master);
        this.sources.add(source);
        source.onended = () => { this.sources.delete(source); source.disconnect(); gain.disconnect(); pan.disconnect(); };
        source.start(when);
      });
      this.nextStep++;
    }
  }
  private stopSources(): void { for (const source of this.sources) { try { source.stop(); } catch { /* Already ended. */ } } this.sources.clear(); }
  dispose(): void { clearInterval(this.timer); this.stopSources(); void this.context.close(); }
}
