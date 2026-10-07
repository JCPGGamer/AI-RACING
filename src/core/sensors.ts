import { dcos, dsin, deg } from './dmath.ts';

/**
 * Sensores e entradas da rede.
 *
 * Sensores físicos: o que o próprio carro mede (raios de distância, velocidade,
 * último comando de direção).
 * Informações da pista: dados fornecidos pelo circuito (ângulo em relação à
 * pista, deslocamento lateral, direção de pontos logo à frente). Algumas
 * categorias do ranking não permitem essas informações.
 */

export type RayCount = 5 | 9 | 13;

export interface InputConfig {
  rays: RayCount;
  /** Velocidade normalizada (físico) */
  speed: boolean;
  /** Último comando de direção (físico) */
  prevSteer: boolean;
  /** Seno e cosseno do ângulo entre o carro e a direção da pista (pista) */
  trackAngle: boolean;
  /** Deslocamento lateral em relação ao centro, −1..1 (pista) */
  lateral: boolean;
  /** Direção de dois pontos da linha central à frente: 25 m e 60 m (pista) */
  lookahead: boolean;
}

export const RAY_ANGLES_DEG: Record<RayCount, number[]> = {
  5: [-75, -35, 0, 35, 75],
  9: [-90, -60, -35, -15, 0, 15, 35, 60, 90],
  13: [-90, -70, -50, -32, -18, -8, 0, 8, 18, 32, 50, 70, 90],
};

/** Alcance máximo dos sensores de distância (m). */
export const RAY_RANGE = 120;
export const LOOKAHEAD_DIST = [25, 60];

export const DEFAULT_INPUTS: InputConfig = {
  rays: 9,
  speed: true,
  prevSteer: true,
  trackAngle: true,
  lateral: false,
  lookahead: false,
};

const rayCache = new Map<RayCount, { cos: Float64Array; sin: Float64Array }>();
export function rayDirs(n: RayCount): { cos: Float64Array; sin: Float64Array } {
  let v = rayCache.get(n);
  if (!v) {
    const a = RAY_ANGLES_DEG[n];
    v = { cos: new Float64Array(a.map((d) => dcos(deg(d)))), sin: new Float64Array(a.map((d) => dsin(deg(d)))) };
    rayCache.set(n, v);
  }
  return v;
}

export function inputCount(c: InputConfig): number {
  return c.rays + (c.speed ? 1 : 0) + (c.prevSteer ? 1 : 0) + (c.trackAngle ? 2 : 0) + (c.lateral ? 1 : 0) + (c.lookahead ? 4 : 0);
}

export interface InputLabel {
  label: string;
  short: string;
  group: 'fisico' | 'pista';
  range: '0..1' | '-1..1';
}

export function inputLabels(c: InputConfig): InputLabel[] {
  const out: InputLabel[] = [];
  for (const a of RAY_ANGLES_DEG[c.rays]) {
    const side = a === 0 ? 'frente' : a < 0 ? `${-a}° esq.` : `${a}° dir.`;
    out.push({ label: `Sensor ${side}`, short: a === 0 ? 'S0°' : `S${a > 0 ? '+' : ''}${a}°`, group: 'fisico', range: '0..1' });
  }
  if (c.speed) out.push({ label: 'Velocidade', short: 'Vel', group: 'fisico', range: '0..1' });
  if (c.prevSteer) out.push({ label: 'Direção anterior', short: 'Dir-1', group: 'fisico', range: '-1..1' });
  if (c.trackAngle) {
    out.push({ label: 'Ângulo da pista (seno)', short: 'sen θ', group: 'pista', range: '-1..1' });
    out.push({ label: 'Ângulo da pista (cosseno)', short: 'cos θ', group: 'pista', range: '-1..1' });
  }
  if (c.lateral) out.push({ label: 'Deslocamento lateral', short: 'Lat', group: 'pista', range: '-1..1' });
  if (c.lookahead) {
    for (const d of LOOKAHEAD_DIST) {
      out.push({ label: `Ponto a ${d} m (seno)`, short: `sen ${d}m`, group: 'pista', range: '-1..1' });
      out.push({ label: `Ponto a ${d} m (cosseno)`, short: `cos ${d}m`, group: 'pista', range: '-1..1' });
    }
  }
  return out;
}

export function usesTrackInfo(c: InputConfig): boolean {
  return c.trackAngle || c.lateral || c.lookahead;
}

export function describeInputs(c: InputConfig): string {
  const parts = [`${c.rays} sensores`];
  if (c.speed) parts.push('velocidade');
  if (c.prevSteer) parts.push('direção anterior');
  if (c.trackAngle) parts.push('ângulo da pista');
  if (c.lateral) parts.push('posição lateral');
  if (c.lookahead) parts.push('pontos à frente');
  return parts.join(', ');
}

export function sameInputs(a: InputConfig, b: InputConfig): boolean {
  return a.rays === b.rays && a.speed === b.speed && a.prevSteer === b.prevSteer && a.trackAngle === b.trackAngle && a.lateral === b.lateral && a.lookahead === b.lookahead;
}

export function normalizeInputs(c: Partial<InputConfig> | undefined): InputConfig {
  const rays = c?.rays === 5 || c?.rays === 13 ? c.rays : 9;
  const d = DEFAULT_INPUTS;
  return {
    rays,
    speed: typeof c?.speed === 'boolean' ? c.speed : d.speed,
    prevSteer: typeof c?.prevSteer === 'boolean' ? c.prevSteer : d.prevSteer,
    trackAngle: typeof c?.trackAngle === 'boolean' ? c.trackAngle : d.trackAngle,
    lateral: typeof c?.lateral === 'boolean' ? c.lateral : d.lateral,
    lookahead: typeof c?.lookahead === 'boolean' ? c.lookahead : d.lookahead,
  };
}
