import type { Rng } from './rng.ts';
import { randomGenome } from './nn.ts';
import type { InputConfig } from './sensors.ts';

/**
 * Evolução de redes neurais (neuroevolução com pesos fixos de arquitetura).
 *
 * A cada geração: elite copiada sem mutação → filhos de pais selecionados
 * (com cruzamento opcional) e mutação gaussiana → alguns pilotos novos aleatórios.
 * A seleção usa a ordem das pontuações, então funciona com pontuações negativas.
 */

export type SelectionMethod = 'truncamento' | 'torneio';

export interface EvoConfig {
  populationSize: number;
  eliteCount: number;
  selection: SelectionMethod;
  /** Fração dos melhores que pode virar pai (truncamento) */
  selectionFraction: number;
  /** Tamanho do torneio */
  tournamentSize: number;
  /** Probabilidade de cada parâmetro sofrer mutação */
  mutationRate: number;
  /** Desvio padrão do ruído gaussiano aplicado quando há mutação */
  mutationStrength: number;
  /** Probabilidade de um filho nascer de cruzamento entre dois pais */
  crossoverRate: number;
  /** Fração da população substituída por pilotos novos a cada geração */
  freshFraction: number;
}

export const POPULATION_OPTIONS = [20, 50, 100, 200] as const;

export const DEFAULT_EVO: EvoConfig = {
  populationSize: 50,
  eliteCount: 4,
  selection: 'truncamento',
  selectionFraction: 0.2,
  tournamentSize: 3,
  mutationRate: 0.1,
  mutationStrength: 0.15,
  crossoverRate: 0,
  freshFraction: 0.04,
};

export const EVO_LIMITS = {
  eliteCount: { min: 0, max: 20 },
  selectionFraction: { min: 0.05, max: 0.6 },
  tournamentSize: { min: 2, max: 10 },
  mutationRate: { min: 0.005, max: 0.6 },
  mutationStrength: { min: 0.01, max: 1.5 },
  crossoverRate: { min: 0, max: 1 },
  freshFraction: { min: 0, max: 0.3 },
};

export type IndividualKind = 'elite' | 'filho' | 'cruzado' | 'novo';

export interface Individual {
  id: number;
  genome: Float64Array;
  kind: IndividualKind;
  parents: number[];
}

/** Valida e corrige combinações incoerentes. Devolve a config ajustada e avisos. */
export function sanitizeEvo(c: Partial<EvoConfig> | undefined): { config: EvoConfig; warnings: string[] } {
  const warnings: string[] = [];
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const cfg: EvoConfig = { ...DEFAULT_EVO };
  const pop = Math.round(num(c?.populationSize, DEFAULT_EVO.populationSize));
  cfg.populationSize = Math.min(300, Math.max(10, pop));
  if (cfg.populationSize !== pop) warnings.push(`População ajustada para ${cfg.populationSize}.`);
  const clampNum = (k: keyof typeof EVO_LIMITS, v: number) => Math.min(EVO_LIMITS[k].max, Math.max(EVO_LIMITS[k].min, v));
  cfg.eliteCount = Math.round(clampNum('eliteCount', num(c?.eliteCount, DEFAULT_EVO.eliteCount)));
  const maxElite = Math.floor(cfg.populationSize / 3);
  if (cfg.eliteCount > maxElite) {
    warnings.push(`Elite reduzida para ${maxElite} (no máximo um terço da população).`);
    cfg.eliteCount = maxElite;
  }
  cfg.selection = c?.selection === 'torneio' ? 'torneio' : 'truncamento';
  cfg.selectionFraction = clampNum('selectionFraction', num(c?.selectionFraction, DEFAULT_EVO.selectionFraction));
  cfg.tournamentSize = Math.round(clampNum('tournamentSize', num(c?.tournamentSize, DEFAULT_EVO.tournamentSize)));
  cfg.mutationRate = clampNum('mutationRate', num(c?.mutationRate, DEFAULT_EVO.mutationRate));
  cfg.mutationStrength = clampNum('mutationStrength', num(c?.mutationStrength, DEFAULT_EVO.mutationStrength));
  cfg.crossoverRate = clampNum('crossoverRate', num(c?.crossoverRate, DEFAULT_EVO.crossoverRate));
  cfg.freshFraction = clampNum('freshFraction', num(c?.freshFraction, DEFAULT_EVO.freshFraction));
  const fresh = freshCount(cfg);
  if (cfg.eliteCount + fresh >= cfg.populationSize) {
    cfg.freshFraction = 0;
    warnings.push('Elite + novos ocupariam a população inteira; pilotos novos desativados.');
  }
  if (Math.max(2, Math.round(cfg.populationSize * cfg.selectionFraction)) < 2) {
    warnings.push('Seleção muito restrita.');
  }
  return { config: cfg, warnings };
}

export function freshCount(c: EvoConfig): number {
  return Math.round(c.populationSize * c.freshFraction);
}

/** Índices ordenados da melhor para a pior pontuação (desempate: índice menor). */
export function rankOrder(fitness: ArrayLike<number>): number[] {
  const idx = Array.from({ length: fitness.length }, (_, i) => i);
  idx.sort((a, b) => {
    const fa = Number.isFinite(fitness[a]) ? fitness[a] : -Infinity;
    const fb = Number.isFinite(fitness[b]) ? fitness[b] : -Infinity;
    return fb - fa || a - b;
  });
  return idx;
}

export function selectParent(order: number[], cfg: EvoConfig, rng: Rng): number {
  if (cfg.selection === 'torneio') {
    // Torneio: sorteia k e vence quem tem a melhor posição no ranking.
    let bestRank = Infinity;
    for (let i = 0; i < cfg.tournamentSize; i++) {
      const r = rng.int(order.length);
      if (r < bestRank) bestRank = r;
    }
    return order[bestRank];
  }
  const pool = Math.max(2, Math.round(order.length * cfg.selectionFraction));
  return order[rng.int(Math.min(pool, order.length))];
}

/** Mutação gaussiana: cada parâmetro muda com probabilidade `rate`, somando N(0, strength). */
export function mutate(g: Float64Array, rate: number, strength: number, rng: Rng): number {
  let changed = 0;
  for (let i = 0; i < g.length; i++) {
    if (rng.next() < rate) {
      g[i] += rng.gaussian() * strength;
      changed++;
    }
  }
  return changed;
}

/**
 * Cruzamento por neurônio: cada neurônio (pesos de entrada + viés) vem
 * inteiro de um dos pais. Preserva melhor as "habilidades" de cada neurônio
 * do que misturar pesos soltos. Só aceita genomas de mesma arquitetura.
 */
export function crossover(a: Float64Array, b: Float64Array, sizes: number[], rng: Rng): Float64Array {
  if (a.length !== b.length) throw new Error('Cruzamento entre arquiteturas diferentes não é permitido.');
  const child = new Float64Array(a.length);
  let o = 0;
  for (let l = 1; l < sizes.length; l++) {
    const nIn = sizes[l - 1];
    const nOut = sizes[l];
    const bOff = o + nIn * nOut;
    for (let j = 0; j < nOut; j++) {
      const src = rng.next() < 0.5 ? a : b;
      const row = o + j * nIn;
      for (let i = 0; i < nIn; i++) child[row + i] = src[row + i];
      child[bOff + j] = src[bOff + j];
    }
    o = bOff + nOut;
  }
  return child;
}

export interface NextGenResult {
  population: Individual[];
  nextId: number;
}

/**
 * Cria a próxima geração a partir da população avaliada.
 * Ordem do resultado: elite, filhos, novos.
 */
export function nextGeneration(
  pop: Individual[],
  fitness: ArrayLike<number>,
  cfg: EvoConfig,
  inputs: InputConfig,
  hidden: number[],
  sizes: number[],
  rng: Rng,
  nextId: number,
): NextGenResult {
  const N = cfg.populationSize;
  const order = rankOrder(fitness);
  const out: Individual[] = [];
  const elite = Math.min(cfg.eliteCount, pop.length, N);
  for (let e = 0; e < elite; e++) {
    const src = pop[order[e]];
    out.push({ id: src.id, genome: src.genome.slice(), kind: 'elite', parents: [src.id] });
  }
  const fresh = Math.min(freshCount(cfg), N - out.length);
  const children = N - out.length - fresh;
  for (let c = 0; c < children; c++) {
    const pa = pop[selectParent(order, cfg, rng)];
    let genome: Float64Array;
    let kind: IndividualKind = 'filho';
    let parents = [pa.id];
    if (cfg.crossoverRate > 0 && rng.next() < cfg.crossoverRate) {
      const pb = pop[selectParent(order, cfg, rng)];
      genome = crossover(pa.genome, pb.genome, sizes, rng);
      kind = 'cruzado';
      parents = [pa.id, pb.id];
    } else {
      genome = pa.genome.slice();
    }
    mutate(genome, cfg.mutationRate, cfg.mutationStrength, rng);
    out.push({ id: nextId++, genome, kind, parents });
  }
  for (let f = 0; f < fresh; f++) {
    out.push({ id: nextId++, genome: randomGenome(inputs, hidden, rng), kind: 'novo', parents: [] });
  }
  return { population: out, nextId };
}

export function randomPopulation(n: number, inputs: InputConfig, hidden: number[], rng: Rng, firstId = 1): Individual[] {
  const out: Individual[] = [];
  for (let i = 0; i < n; i++) out.push({ id: firstId + i, genome: randomGenome(inputs, hidden, rng), kind: 'novo', parents: [] });
  return out;
}
