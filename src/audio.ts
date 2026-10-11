import type { AudioSettings, SortStep } from './contracts';

type ClipName = 'manbo' | 'ha' | 'laugh' | 'compare' | 'swap' | 'land' | 'complete' | 'background';
type Channel = 'voice' | 'effects' | 'music';
interface Sound {
  clip: ClipName;
  channel: Channel;
  factor: number;
  rate: number;
  offset: number;
  started: number;
  loop: boolean;
  source: AudioBufferSourceNode | null;
  gain: GainNode;
}
const FILES: Record<ClipName, string> = {
  manbo: '/audio/manbo.mp3', ha: '/audio/ha.mp3', laugh: '/audio/laugh.mp3',
  compare: '/audio/Synth/Compare.mp3', swap: '/audio/Synth/Swap.mp3',
  land: '/audio/Synth/Land.mp3', complete: '/audio/Synth/Complete.mp3',
  background: '/audio/Synth/Background.mp3',
};

/** Native, non-spatial audio; stopping a source retains its sample offset on pause. */
export class Audio {
  settings: AudioSettings = { master: 0.7, voice: 0.75, effects: 0.3, music: 0.28, muted: false };
  private context: AudioContext | null = null;
  private buffers = new Map<ClipName, AudioBuffer>();
  private sounds = new Set<Sound>();
  private loadPromise: Promise<void> | null = null;
  private ready = false;
  private paused = false;
  private disposed = false;
  private musicGain = 0;
  private pendingStep: SortStep | null = null;
  private pendingLand = false;
  private readonly requests = new AbortController();

  async unlock(): Promise<void> {
    if (this.disposed) return;
    if (!this.context) this.context = new AudioContext();
    // resume MUST run in the gesture, before waiting for network or decoding.
    const resumed = this.context.resume();
    if (!this.loadPromise) {
      const context = this.context;
      this.loadPromise = Promise.all((Object.entries(FILES) as [ClipName, string][]).map(async ([name, url]) => {
        const response = await fetch(url, { signal: this.requests.signal });
        if (!response.ok) throw new Error(`无法加载音频 ${url} (${response.status})`);
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        if (!this.disposed) this.buffers.set(name, buffer);
      })).then(() => {
        if (this.disposed) return;
        this.ready = true;
        this.create('background', 'music', 1, 1, true);
        if (this.pendingStep) {
          const step = this.pendingStep;
          this.pendingStep = null;
          this.playStep(step);
        }
        if (this.pendingLand) { this.pendingLand = false; this.land(); }
      }).catch(error => {
        this.loadPromise = null;
        throw error;
      });
    }
    await Promise.all([resumed, this.loadPromise]);
  }

  playStep(step: SortStep): void {
    if (this.disposed) return;
    this.resume();
    if (!this.ready) { this.pendingStep = step; return; }
    if (step.kind === 'compare' && step.j >= 0 && step.j < step.values.length) {
      this.create('compare', 'effects', 1, Math.pow(2, (step.values[step.j] - 3) / 12));
    } else if (step.kind === 'swap') {
      this.stopVoices();
      const a = step.values[step.swapA];
      const b = step.values[step.swapB];
      if (a !== undefined) this.create(a % 2 ? 'manbo' : 'ha', 'voice', 0.55);
      if (b !== undefined) this.create(b % 2 ? 'manbo' : 'ha', 'voice', 0.55);
      this.create('swap', 'effects');
    } else if (step.kind === 'complete') {
      this.stopVoices();
      this.create('laugh', 'voice');
      this.create('complete', 'effects');
    }
  }

  land(): void {
    if (this.disposed) return;
    if (!this.ready) { this.pendingLand = true; return; }
    this.create('land', 'effects');
  }

  pause(): void {
    if (this.paused || this.disposed) return;
    this.paused = true;
    for (const sound of this.sounds) this.hold(sound);
  }

  resume(): void {
    if (!this.paused || this.disposed) return;
    this.paused = false;
    for (const sound of this.sounds) this.start(sound);
  }

  stopTransient(): void {
    this.pendingStep = null;
    this.pendingLand = false;
    for (const sound of this.sounds) if (sound.channel !== 'music') this.remove(sound);
  }

  update(dt: number, running: boolean): void {
    if (!this.context || this.disposed) return;
    let talking = false;
    for (const sound of this.sounds) if (sound.channel === 'voice' && sound.source) talking = true;
    const target = running && !this.paused ? (talking ? 0.4 : 1) : 0;
    this.musicGain += (target - this.musicGain) * (1 - Math.exp(-Math.max(0, dt) * 8));
    for (const sound of this.sounds) this.applyGain(sound);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.requests.abort();
    for (const sound of this.sounds) this.remove(sound);
    this.buffers.clear();
    this.pendingStep = null;
    if (this.context) void this.context.close();
    this.context = null;
  }

  private create(clip: ClipName, channel: Channel, factor = 1, rate = 1, loop = false): void {
    if (!this.context || !this.buffers.has(clip) || this.disposed) return;
    const gain = this.context.createGain();
    gain.connect(this.context.destination);
    const sound: Sound = { clip, channel, factor, rate, offset: 0, started: 0, loop, source: null, gain };
    this.sounds.add(sound);
    this.applyGain(sound);
    if (!this.paused) this.start(sound);
  }

  private applyGain(sound: Sound): void {
    if (!this.context) return;
    const level = this.settings.muted ? 0 : this.settings.master * this.settings[sound.channel] * sound.factor;
    sound.gain.gain.setTargetAtTime(level * (sound.loop ? this.musicGain : 1), this.context.currentTime, 0.012);
  }

  private start(sound: Sound): void {
    if (!this.context || sound.source) return;
    const buffer = this.buffers.get(sound.clip);
    if (!buffer) return;
    if (!sound.loop && sound.offset >= buffer.duration) { this.remove(sound); return; }
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = sound.loop;
    source.playbackRate.value = sound.rate;
    source.connect(sound.gain);
    sound.source = source;
    sound.started = this.context.currentTime;
    source.onended = () => {
      source.disconnect();
      if (sound.source === source) { sound.source = null; this.remove(sound); }
    };
    source.start(0, sound.loop ? sound.offset % buffer.duration : sound.offset);
  }

  private hold(sound: Sound): void {
    if (!sound.source || !this.context) return;
    sound.offset += (this.context.currentTime - sound.started) * sound.rate;
    const source = sound.source;
    sound.source = null;
    source.onended = null;
    source.stop();
    source.disconnect();
  }

  private remove(sound: Sound): void {
    this.hold(sound);
    sound.gain.disconnect();
    this.sounds.delete(sound);
  }

  private stopVoices(): void {
    for (const sound of this.sounds) if (sound.channel === 'voice') this.remove(sound);
  }
}
