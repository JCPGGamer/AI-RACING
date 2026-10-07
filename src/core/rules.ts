import { BUILTIN_TRACKS } from './builtinTracks.ts';
import { paramCount, type Brain } from './nn.ts';
import { PHYSICS } from './physics.ts';
import { inputCount, usesTrackInfo, type InputConfig, type RayCount } from './sensors.ts';
import type { RunRules, StartCondition } from './sim.ts';
import type { Track, TrackDef } from './track.ts';

/**
 * Regras oficiais: iguais para todos, fixas e versionadas. A treinadora e as
 * recompensas de treinamento não alteram nada aqui.
 */

/** Versão das regras de avaliação. Mudou física, pista ou regra → nova versão do ranking. */
export const RULES_VERSION = 1;

export interface Category {
  id: string;
  name: string;
  description: string;
  allowTrackInfo: boolean;
  rays: RayCount[];
  maxHiddenLayers: number;
  maxNeurons: number;
  maxParams: number;
}

export const CATEGORIES: Category[] = [
  {
    id: 'sensores',
    name: 'Sensores',
    description: 'Só sensores físicos: raios de distância, velocidade e direção anterior. Nada de informações da pista.',
    allowTrackInfo: false,
    rays: [5, 9, 13],
    maxHiddenLayers: 3,
    maxNeurons: 32,
    maxParams: 4000,
  },
  {
    id: 'aberta',
    name: 'Aberta',
    description: 'Qualquer entrada permitida, incluindo ângulo, posição lateral e pontos à frente da pista.',
    allowTrackInfo: true,
    rays: [5, 9, 13],
    maxHiddenLayers: 4,
    maxNeurons: 64,
    maxParams: 20000,
  },
];

export function getCategory(id: string): Category | undefined {
  return CATEGORIES.find((c) => c.id === id);
}

export const OFFICIAL_TRACK_IDS = BUILTIN_TRACKS.map((t) => t.id);

export const OFFICIAL_STALL_TIME = 8;
export const OFFICIAL_STALL_DIST = 5;

/** Tempo máximo oficial de uma tentativa na pista. */
export function officialMaxTime(track: Track): number {
  return Math.ceil(track.lapDistance / 12) + 30;
}

export function officialRules(track: Track): RunRules {
  return { maxTime: officialMaxTime(track), stallTime: OFFICIAL_STALL_TIME, stallDist: OFFICIAL_STALL_DIST };
}

/** Largada oficial: parado, no centro, alinhado com a pista. */
export const OFFICIAL_START: StartCondition = Object.freeze({ lateral: 0, heading: 0 });

/**
 * Largadas padronizadas para avaliações com várias tentativas (consistência).
 * São fixas para que comparações sejam justas.
 */
export const CONSISTENCY_STARTS: StartCondition[] = [
  { lateral: 0, heading: 0 },
  { lateral: -1.6, heading: -0.05 },
  { lateral: 1.6, heading: 0.05 },
  { lateral: -0.8, heading: 0.08 },
  { lateral: 0.8, heading: -0.08 },
];

/** Chave da versão do ranking: regras + física + versão da pista. */
export function rulesKey(track: Pick<TrackDef, 'version'>): string {
  return `r${RULES_VERSION}.f${PHYSICS.version}.p${track.version}`;
}

/** Descrição completa das regras de uma categoria numa pista (exibida ao jogador). */
export function describeRules(track: Track, cat: Category): { label: string; value: string }[] {
  return [
    { label: 'Pista e versão', value: `${track.def.name} v${track.def.version} (${track.hash})` },
    { label: 'Física', value: `versão ${PHYSICS.version}` },
    { label: 'Passo de simulação', value: '1/60 s (fixo)' },
    { label: 'Largada', value: 'Parado, no centro da pista, alinhado' },
    { label: 'Entradas permitidas', value: cat.allowTrackInfo ? 'Sensores físicos + informações da pista' : 'Somente sensores físicos' },
    { label: 'Arquitetura', value: `até ${cat.maxHiddenLayers} camadas ocultas, ${cat.maxNeurons} neurônios por camada, ${cat.maxParams} parâmetros` },
    { label: 'Tempo máximo', value: `${officialMaxTime(track)} s` },
    { label: 'Sem progresso', value: `encerra após ${OFFICIAL_STALL_TIME} s sem avançar ${OFFICIAL_STALL_DIST} m` },
    { label: 'Conclusão', value: 'Todos os checkpoints em ordem + chegada no sentido certo' },
    { label: 'Colisão', value: 'Encostar o corpo do carro na borda encerra a tentativa' },
    { label: 'Versão do ranking', value: rulesKey(track.def) },
  ];
}

/** Lista problemas que impedem o cérebro de participar da categoria. */
export function checkBrainForCategory(brain: Pick<Brain, 'inputs' | 'hidden'> & { genome?: Float64Array }, cat: Category): string[] {
  const p: string[] = [];
  const inp: InputConfig = brain.inputs;
  if (!cat.rays.includes(inp.rays)) p.push(`A categoria não permite ${inp.rays} sensores.`);
  if (!cat.allowTrackInfo && usesTrackInfo(inp)) p.push('A categoria não permite informações da pista (ângulo, posição lateral ou pontos à frente).');
  if (brain.hidden.length < 1) p.push('A rede precisa de pelo menos uma camada oculta.');
  if (brain.hidden.length > cat.maxHiddenLayers) p.push(`Máximo de ${cat.maxHiddenLayers} camadas ocultas.`);
  if (brain.hidden.some((h) => !Number.isInteger(h) || h < 1 || h > cat.maxNeurons)) p.push(`Cada camada deve ter de 1 a ${cat.maxNeurons} neurônios.`);
  const params = paramCount(inp, brain.hidden);
  if (params > cat.maxParams) p.push(`A rede tem ${params} parâmetros (máximo ${cat.maxParams}).`);
  if (brain.genome && brain.genome.length !== params) p.push('O número de pesos não corresponde à arquitetura.');
  if (inputCount(inp) < 1) p.push('Sem entradas.');
  return p;
}

/** Categorias em que o cérebro pode competir. */
export function eligibleCategories(brain: Pick<Brain, 'inputs' | 'hidden'>): Category[] {
  return CATEGORIES.filter((c) => checkBrainForCategory(brain, c).length === 0);
}
