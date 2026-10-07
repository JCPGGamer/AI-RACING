import { dcos, dlog, TWO_PI } from './dmath.ts';

/** Estado serializável do gerador (4 inteiros de 32 bits). */
export type RngState = [number, number, number, number];

/** Converte texto ou número em uma semente de 32 bits (FNV-1a). */
export function hashSeed(seed: string | number): number {
  const s = String(seed);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function splitmix32(a: number): () => number {
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

/**
 * Gerador pseudoaleatório SFC32 com semente. Rápido, com estado pequeno
 * e totalmente reproduzível: salvar o estado permite retomar um experimento
 * exatamente do mesmo ponto.
 */
export class Rng {
  private a = 0;
  private b = 0;
  private c = 0;
  private d = 0;

  constructor(seed: string | number | RngState = 1) {
    if (Array.isArray(seed)) {
      this.setState(seed);
    } else {
      const sm = splitmix32(hashSeed(seed));
      this.a = sm();
      this.b = sm();
      this.c = sm();
      this.d = sm();
      for (let i = 0; i < 12; i++) this.nextU32();
    }
  }

  nextU32(): number {
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return t >>> 0;
  }

  /** Número em [0, 1). */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** Inteiro em [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }

  /** Normal padrão (Box–Muller, sem cache para manter o estado simples). */
  gaussian(): number {
    const u1 = 1 - this.next(); // (0, 1]
    const u2 = this.next();
    return Math.sqrt(-2 * dlog(u1)) * dcos(TWO_PI * u2);
  }

  /** Cria um gerador derivado independente (para subexperimentos). */
  fork(label: string | number): Rng {
    return new Rng(`${this.nextU32()}:${label}`);
  }

  getState(): RngState {
    return [this.a >>> 0, this.b >>> 0, this.c >>> 0, this.d >>> 0];
  }

  setState(s: RngState): void {
    if (!Array.isArray(s) || s.length !== 4 || s.some((v) => !Number.isInteger(v) || v < 0 || v > 0xffffffff)) {
      throw new Error('Estado do gerador aleatório inválido.');
    }
    this.a = s[0] | 0;
    this.b = s[1] | 0;
    this.c = s[2] | 0;
    this.d = s[3] | 0;
  }
}
