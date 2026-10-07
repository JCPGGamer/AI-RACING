import { PI, TWO_PI } from './dmath.ts';

/**
 * Replays compactos: estados amostrados a cada REPLAY_EVERY passos
 * (x, y, direção, velocidade, comando de direção, acelerador, freio) em Float32.
 * Uma volta de 40 s ocupa ≈ 34 KB. Os sensores podem ser recalculados a partir
 * da pose e da geometria da pista (mesma versão), por isso não são gravados.
 */

export const FRAME_STRIDE = 7;
export const REPLAY_EVERY = 2;

export interface ReplayMeta {
  trackId: string;
  trackVersion: number;
  trackHash: string;
  physicsVersion: number;
  dt: number;
  /** Intervalo entre quadros em segundos */
  frameDt: number;
  pilotName?: string;
  color?: string;
  completed: boolean;
  time: number;
  progress: number;
  reason: string;
  /** Ponto da batida, se houver */
  crash?: { x: number; y: number };
}

export interface Replay {
  meta: ReplayMeta;
  /** quadros: [x, y, heading, speed, steer, throttle, brake] × n */
  frames: Float32Array;
}

export class ReplayRecorder {
  private buf: Float32Array;
  private n = 0;

  constructor(expectedFrames = 1024) {
    this.buf = new Float32Array(expectedFrames * FRAME_STRIDE);
  }

  push(x: number, y: number, heading: number, speed: number, steer: number, throttle: number, brake: number): void {
    const need = (this.n + 1) * FRAME_STRIDE;
    if (need > this.buf.length) {
      const nb = new Float32Array(Math.max(need, this.buf.length * 2));
      nb.set(this.buf);
      this.buf = nb;
    }
    const o = this.n * FRAME_STRIDE;
    this.buf[o] = x;
    this.buf[o + 1] = y;
    this.buf[o + 2] = heading;
    this.buf[o + 3] = speed;
    this.buf[o + 4] = steer;
    this.buf[o + 5] = throttle;
    this.buf[o + 6] = brake;
    this.n++;
  }

  get frameCount(): number {
    return this.n;
  }

  finish(): Float32Array {
    return this.buf.slice(0, this.n * FRAME_STRIDE);
  }
}

export interface ReplaySample {
  x: number;
  y: number;
  heading: number;
  speed: number;
  steer: number;
  throttle: number;
  brake: number;
  /** true quando o replay já terminou neste instante */
  ended: boolean;
}

export function replayDuration(r: Replay): number {
  const n = r.frames.length / FRAME_STRIDE;
  return Math.max(0, (n - 1) * r.meta.frameDt);
}

/** Interpola o replay no tempo t (s). */
export function sampleReplay(r: Replay, t: number, out: ReplaySample): void {
  const f = r.frames;
  const n = f.length / FRAME_STRIDE;
  if (n === 0) {
    out.x = out.y = out.heading = out.speed = out.steer = out.throttle = out.brake = 0;
    out.ended = true;
    return;
  }
  const pos = t / r.meta.frameDt;
  let i = Math.floor(pos);
  let u = pos - i;
  out.ended = false;
  if (i >= n - 1) {
    i = n - 1;
    u = 0;
    out.ended = t > (n - 1) * r.meta.frameDt;
  } else if (i < 0) {
    i = 0;
    u = 0;
  }
  const a = i * FRAME_STRIDE;
  const b = Math.min(n - 1, i + 1) * FRAME_STRIDE;
  const lerp = (k: number) => f[a + k] + (f[b + k] - f[a + k]) * u;
  out.x = lerp(0);
  out.y = lerp(1);
  let dh = f[b + 2] - f[a + 2];
  if (dh > PI) dh -= TWO_PI;
  else if (dh < -PI) dh += TWO_PI;
  out.heading = f[a + 2] + dh * u;
  out.speed = lerp(3);
  out.steer = lerp(4);
  out.throttle = lerp(5);
  out.brake = lerp(6);
}

/** Trajetória (x, y) do replay para desenhar a linha percorrida. */
export function replayPath(r: Replay, every = 1): Float32Array {
  const n = r.frames.length / FRAME_STRIDE;
  const m = Math.ceil(n / every);
  const out = new Float32Array(m * 2);
  let k = 0;
  for (let i = 0; i < n; i += every) {
    out[k++] = r.frames[i * FRAME_STRIDE];
    out[k++] = r.frames[i * FRAME_STRIDE + 1];
  }
  return out;
}
