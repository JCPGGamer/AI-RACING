/**
 * Áudio procedural com Web Audio API (sem arquivos).
 * - Efeitos curtos (cliques, batida, volta, recorde, fim de geração).
 * - Motor apenas do carro acompanhado; some ao pausar.
 * - Música eletrônica discreta gerada por um sequenciador simples.
 * O contexto de áudio só é criado após a primeira interação do jogador.
 */

export interface AudioPrefs {
  musicVolume: number;
  sfxVolume: number;
  engineVolume: number;
  muted: boolean;
}

const NOTE = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

// Progressão Am – F – C – G (raízes MIDI) e acordes
const CHORDS = [
  { root: 45, notes: [57, 60, 64] },
  { root: 41, notes: [53, 57, 60] },
  { root: 48, notes: [55, 60, 64] },
  { root: 43, notes: [55, 59, 62] },
];

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private sfxBus!: GainNode;
  private engineBus!: GainNode;
  private noise!: AudioBuffer;
  private prefs: AudioPrefs = { musicVolume: 0.35, sfxVolume: 0.6, engineVolume: 0.4, muted: false };
  private engineOsc: OscillatorNode | null = null;
  private engineOsc2: OscillatorNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private engineGain: GainNode | null = null;
  private musicOn = false;
  private musicTimer: ReturnType<typeof setInterval> | null = null;
  private nextStepTime = 0;
  private step = 0;
  private crashTimes: number[] = [];
  private seed = 1;

  /** Liga o áudio na primeira interação (exigência dos navegadores). */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const AC = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as typeof AudioContext | undefined;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 4;
    comp.connect(this.master);
    this.musicBus = ctx.createGain();
    this.sfxBus = ctx.createGain();
    this.engineBus = ctx.createGain();
    this.musicBus.connect(comp);
    this.sfxBus.connect(comp);
    this.engineBus.connect(comp);
    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.applyPrefs(this.prefs);
    if (this.musicOn) this.startSequencer();
  }

  get ready(): boolean {
    return !!this.ctx;
  }

  applyPrefs(p: AudioPrefs): void {
    this.prefs = { ...p };
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(p.muted ? 0 : 1, t, 0.05);
    this.musicBus.gain.setTargetAtTime(p.musicVolume * 0.5, t, 0.1);
    this.sfxBus.gain.setTargetAtTime(p.sfxVolume, t, 0.05);
    this.engineBus.gain.setTargetAtTime(p.engineVolume, t, 0.05);
  }

  private tone(freq: number, start: number, dur: number, type: OscillatorType, vol: number, bus?: AudioNode, attack = 0.005): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(vol, start + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g);
    g.connect(bus ?? this.sfxBus);
    o.start(start);
    o.stop(start + dur + 0.05);
  }

  private noiseBurst(start: number, dur: number, vol: number, filterFreq: number, type: BiquadFilterType, bus?: AudioNode): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + this.rand() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = filterFreq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, start);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    src.connect(f);
    f.connect(g);
    g.connect(bus ?? this.sfxBus);
    src.start(start, this.rand() * 0.5);
    src.stop(start + dur + 0.05);
  }

  private rand(): number {
    // pseudoaleatório simples só para variação sonora
    this.seed = (this.seed * 16807) % 2147483647;
    return (this.seed - 1) / 2147483646;
  }

  private now(): number | null {
    if (!this.ctx || this.prefs.muted) return null;
    return this.ctx.currentTime + 0.01;
  }

  click(): void {
    const t = this.now();
    if (t === null) return;
    this.tone(1250, t, 0.04, 'sine', 0.08);
  }

  start(): void {
    const t = this.now();
    if (t === null) return;
    [60, 64, 67, 72].forEach((n, i) => this.tone(NOTE(n), t + i * 0.07, 0.25, 'triangle', 0.12));
  }

  crash(): void {
    const t = this.now();
    if (t === null) return;
    const ms = performance.now();
    this.crashTimes = this.crashTimes.filter((x) => ms - x < 200);
    if (this.crashTimes.length >= 3) return; // limita batidas simultâneas
    this.crashTimes.push(ms);
    this.noiseBurst(t, 0.22, 0.25, 900, 'lowpass');
    this.tone(90, t, 0.18, 'sine', 0.18);
  }

  lap(): void {
    const t = this.now();
    if (t === null) return;
    this.tone(NOTE(76), t, 0.3, 'sine', 0.16);
    this.tone(NOTE(81), t + 0.11, 0.45, 'sine', 0.16);
  }

  record(): void {
    const t = this.now();
    if (t === null) return;
    [72, 76, 79, 84].forEach((n, i) => this.tone(NOTE(n), t + i * 0.09, 0.5, 'triangle', 0.14));
  }

  genEnd(): void {
    const t = this.now();
    if (t === null) return;
    this.tone(660, t, 0.12, 'sine', 0.07);
    this.tone(990, t + 0.06, 0.12, 'sine', 0.05);
  }

  approved(): void {
    const t = this.now();
    if (t === null) return;
    [60, 64, 67].forEach((n) => this.tone(NOTE(n), t, 0.9, 'triangle', 0.09, undefined, 0.02));
    [72, 76, 79, 84, 88].forEach((n, i) => this.tone(NOTE(n), t + 0.15 + i * 0.08, 0.45, 'sine', 0.1));
  }

  error(): void {
    const t = this.now();
    if (t === null) return;
    this.tone(220, t, 0.18, 'square', 0.05);
    this.tone(180, t + 0.12, 0.22, 'square', 0.05);
  }

  /** Motor do carro acompanhado. active=false suaviza até o silêncio. */
  setEngine(active: boolean, speed01: number, throttle: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    if (!this.engineOsc) {
      this.engineOsc = ctx.createOscillator();
      this.engineOsc2 = ctx.createOscillator();
      this.engineFilter = ctx.createBiquadFilter();
      this.engineGain = ctx.createGain();
      this.engineOsc.type = 'sawtooth';
      this.engineOsc2.type = 'square';
      this.engineFilter.type = 'lowpass';
      this.engineFilter.Q.value = 2;
      this.engineGain.gain.value = 0;
      this.engineOsc.connect(this.engineFilter);
      this.engineOsc2.connect(this.engineFilter);
      this.engineFilter.connect(this.engineGain);
      this.engineGain.connect(this.engineBus);
      this.engineOsc.start();
      this.engineOsc2.start();
    }
    const s = Math.max(0, Math.min(1, speed01));
    // "marchas": a rotação sobe e cai em faixas de velocidade
    const gear = Math.min(5, Math.floor(s * 6));
    const inGear = s * 6 - gear;
    const rpm = 0.35 + 0.65 * inGear;
    const f = 48 + gear * 14 + rpm * 90 + throttle * 12;
    this.engineOsc.frequency.setTargetAtTime(f, t, 0.05);
    this.engineOsc2!.frequency.setTargetAtTime(f * 0.5, t, 0.05);
    this.engineFilter!.frequency.setTargetAtTime(300 + 1400 * (0.3 * s + 0.7 * throttle), t, 0.08);
    const vol = active ? 0.05 + 0.1 * throttle + 0.04 * s : 0;
    this.engineGain!.gain.setTargetAtTime(vol, t, active ? 0.06 : 0.25);
  }

  // ---------- Música ----------

  setMusic(on: boolean): void {
    this.musicOn = on;
    if (!this.ctx) return;
    if (on) this.startSequencer();
    else this.stopSequencer();
  }

  private startSequencer(): void {
    if (this.musicTimer || !this.ctx) return;
    this.nextStepTime = this.ctx.currentTime + 0.1;
    this.musicTimer = setInterval(() => this.schedule(), 25);
  }

  private stopSequencer(): void {
    if (this.musicTimer) clearInterval(this.musicTimer);
    this.musicTimer = null;
  }

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const stepDur = 60 / 96 / 4; // semicolcheias a 96 BPM
    while (this.nextStepTime < ctx.currentTime + 0.15) {
      this.playStep(this.step, this.nextStepTime, stepDur);
      this.step = (this.step + 1) % 256;
      this.nextStepTime += stepDur;
    }
  }

  private playStep(step: number, t: number, sd: number): void {
    const bar = Math.floor(step / 16) % 4;
    const s16 = step % 16;
    const chord = CHORDS[bar];
    const bus = this.musicBus;
    // Pad: acorde suave no começo de cada compasso
    if (s16 === 0) {
      for (const n of chord.notes) {
        for (const det of [-6, 6]) {
          const o = this.ctx!.createOscillator();
          const g = this.ctx!.createGain();
          const f = this.ctx!.createBiquadFilter();
          o.type = 'sawtooth';
          o.frequency.value = NOTE(n);
          o.detune.value = det;
          f.type = 'lowpass';
          f.frequency.value = 700;
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(0.025, t + 0.6);
          g.gain.linearRampToValueAtTime(0.0001, t + sd * 16);
          o.connect(f);
          f.connect(g);
          g.connect(bus);
          o.start(t);
          o.stop(t + sd * 16 + 0.05);
        }
      }
    }
    // Baixo em colcheias com oitava
    if (s16 % 2 === 0) {
      const n = chord.root + (s16 % 8 === 4 ? 12 : 0);
      this.tone(NOTE(n), t, sd * 1.8, 'triangle', 0.11, bus, 0.01);
    }
    // Chimbal discreto nos contratempos
    if (s16 % 4 === 2) this.noiseBurst(t, 0.05, 0.035, 7000, 'highpass', bus);
    // Bumbo leve
    if (s16 === 0 || s16 === 8) {
      const o = this.ctx!.createOscillator();
      const g = this.ctx!.createGain();
      o.frequency.setValueAtTime(110, t);
      o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      g.gain.setValueAtTime(0.12, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.connect(g);
      g.connect(bus);
      o.start(t);
      o.stop(t + 0.2);
    }
    // Arpejo: notas do acorde, padrão que muda a cada 4 compassos
    const phrase = Math.floor(step / 64) % 2;
    const pattern = phrase === 0 ? [0, 1, 2, 1, 0, 2, 1, 2] : [2, 1, 0, 1, 2, 0, 1, 0];
    if (s16 % 2 === 1) {
      const idx = pattern[(s16 >> 1) % pattern.length];
      this.tone(NOTE(chord.notes[idx] + 12), t, sd * 1.5, 'sine', 0.04, bus, 0.004);
    }
  }
}

export const audio = new AudioEngine();
