import { dsigmoid, dtanh } from './dmath.ts';
import type { Rng } from './rng.ts';
import { inputCount, type InputConfig, sameInputs } from './sensors.ts';

/**
 * Rede neural feedforward.
 *
 * Entradas → camadas ocultas (tanh) → 3 saídas:
 *   direção    = tanh(o0)      em −1..1
 *   acelerador = sigmoide(o1)  em 0..1
 *   freio      = sigmoide(o2)  em 0..1
 *
 * O genoma é um Float64Array com, para cada camada, os pesos (linha por
 * neurônio de saída) seguidos dos vieses.
 */

export const OUTPUTS = 3;

export interface Brain {
  inputs: InputConfig;
  hidden: number[];
  genome: Float64Array;
}

export function layerSizes(inputs: InputConfig, hidden: number[]): number[] {
  return [inputCount(inputs), ...hidden, OUTPUTS];
}

export function paramCount(inputs: InputConfig, hidden: number[]): number {
  const sizes = layerSizes(inputs, hidden);
  let n = 0;
  for (let l = 1; l < sizes.length; l++) n += sizes[l] * sizes[l - 1] + sizes[l];
  return n;
}

/** Multiplicações por passo de simulação (custo aproximado de processamento da rede). */
export function macsPerStep(inputs: InputConfig, hidden: number[]): number {
  const sizes = layerSizes(inputs, hidden);
  let n = 0;
  for (let l = 1; l < sizes.length; l++) n += sizes[l] * sizes[l - 1];
  return n;
}

/** Custo relativo por passo: multiplicações da rede + raios lançados (≈ 40 operações cada). */
export function costPerStep(inputs: InputConfig, hidden: number[]): number {
  return macsPerStep(inputs, hidden) + inputs.rays * 40;
}

export function archKey(inputs: InputConfig, hidden: number[]): string {
  const i = inputs;
  return `${i.rays}${i.speed ? 'v' : ''}${i.prevSteer ? 'p' : ''}${i.trackAngle ? 'a' : ''}${i.lateral ? 'l' : ''}${i.lookahead ? 'k' : ''}|${hidden.join('x')}`;
}

export function sameArch(a: Pick<Brain, 'inputs' | 'hidden'>, b: Pick<Brain, 'inputs' | 'hidden'>): boolean {
  return sameInputs(a.inputs, b.inputs) && a.hidden.length === b.hidden.length && a.hidden.every((h, i) => h === b.hidden[i]);
}

export function describeArch(inputs: InputConfig, hidden: number[]): string {
  return layerSizes(inputs, hidden).join(' → ');
}

/** Inicialização LeCun normal: desvio 1/√(entradas da camada). Evita saturar tanh. */
export function randomGenome(inputs: InputConfig, hidden: number[], rng: Rng): Float64Array {
  const sizes = layerSizes(inputs, hidden);
  const g = new Float64Array(paramCount(inputs, hidden));
  let o = 0;
  for (let l = 1; l < sizes.length; l++) {
    const fanIn = sizes[l - 1];
    const std = 1 / Math.sqrt(fanIn);
    for (let k = 0; k < sizes[l] * fanIn; k++) g[o++] = rng.gaussian() * std;
    for (let k = 0; k < sizes[l]; k++) g[o++] = 0;
  }
  return g;
}

/** Executor reutilizável: buffers alocados uma vez por arquitetura. */
export class NetRunner {
  readonly sizes: number[];
  private readonly bufs: Float64Array[];

  constructor(inputs: InputConfig, hidden: number[]) {
    this.sizes = layerSizes(inputs, hidden);
    this.bufs = this.sizes.map((n) => new Float64Array(n));
  }

  /** Calcula as saídas brutas (antes das ativações finais) e aplica as ativações. */
  run(genome: Float64Array, input: Float64Array, out: Float64Array): void {
    const sizes = this.sizes;
    let src = input;
    let o = 0;
    const last = sizes.length - 1;
    for (let l = 1; l <= last; l++) {
      const nIn = sizes[l - 1];
      const nOut = sizes[l];
      const dst = this.bufs[l];
      const bOff = o + nIn * nOut;
      for (let j = 0; j < nOut; j++) {
        let sum = genome[bOff + j];
        const row = o + j * nIn;
        for (let i = 0; i < nIn; i++) sum += genome[row + i] * src[i];
        dst[j] = l < last ? dtanh(sum) : sum;
      }
      o = bOff + nOut;
      src = dst;
    }
    out[0] = dtanh(src[0]);
    out[1] = dsigmoid(src[1]);
    out[2] = dsigmoid(src[2]);
  }

  /** Ativações das camadas ocultas da última execução (para visualização). */
  activations(): Float64Array[] {
    return this.bufs.slice(1, -1);
  }
}

// ---------- Serialização compacta (base64 de float64 little-endian) ----------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '==';
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=';
  }
  return out;
}

const B64_LOOKUP = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

export function base64ToBytes(s: string): Uint8Array {
  if (typeof s !== 'string' || s.length % 4 !== 0) throw new Error('Base64 inválido.');
  let pad = 0;
  if (s.endsWith('==')) pad = 2;
  else if (s.endsWith('=')) pad = 1;
  const len = (s.length / 4) * 3 - pad;
  const out = new Uint8Array(len);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const ch = s.charCodeAt(i + k);
      let v: number;
      if (ch === 61 /* = */) {
        if (i + k < s.length - pad) throw new Error('Base64 inválido.');
        v = 0;
      } else {
        v = ch < 128 ? B64_LOOKUP[ch] : -1;
        if (v < 0) throw new Error('Base64 inválido.');
      }
      n = (n << 6) | v;
    }
    if (o < len) out[o++] = (n >> 16) & 255;
    if (o < len) out[o++] = (n >> 8) & 255;
    if (o < len) out[o++] = n & 255;
  }
  return out;
}

export function genomeToBase64(g: Float64Array): string {
  const bytes = new Uint8Array(g.length * 8);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < g.length; i++) dv.setFloat64(i * 8, g[i], true);
  return bytesToBase64(bytes);
}

export function base64ToGenome(s: string): Float64Array {
  const bytes = base64ToBytes(s);
  if (bytes.length % 8 !== 0) throw new Error('Genoma com tamanho inválido.');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const g = new Float64Array(bytes.length / 8);
  for (let i = 0; i < g.length; i++) g[i] = dv.getFloat64(i * 8, true);
  return g;
}

export function float32ToBase64(a: Float32Array): string {
  const bytes = new Uint8Array(a.length * 4);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < a.length; i++) dv.setFloat32(i * 4, a[i], true);
  return bytesToBase64(bytes);
}

export function base64ToFloat32(s: string): Float32Array {
  const bytes = base64ToBytes(s);
  if (bytes.length % 4 !== 0) throw new Error('Dados com tamanho inválido.');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const a = new Float32Array(bytes.length / 4);
  for (let i = 0; i < a.length; i++) a[i] = dv.getFloat32(i * 4, true);
  return a;
}
