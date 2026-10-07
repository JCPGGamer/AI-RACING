import { DEFAULT_EVO, sanitizeEvo, type EvoConfig } from './evolution.ts';
import { paramCount } from './nn.ts';
import { DEFAULT_REWARDS, presetOf, REWARD_LIMITS, sanitizeRewards, type RewardPresetId, type RewardWeights } from './rewards.ts';
import { DEFAULT_INPUTS, normalizeInputs, sameInputs, type InputConfig } from './sensors.ts';

/** Configuração completa de um experimento de treinamento. */
export interface ExperimentConfig {
  version: 1;
  seed: string;
  trackIds: string[];
  inputs: InputConfig;
  hidden: number[];
  evo: EvoConfig;
  rewards: RewardWeights;
  rewardPreset: RewardPresetId;
  /** Tempo máximo de cada tentativa no treino (s) */
  maxTime: number;
  /** Encerra a tentativa após este tempo sem progresso (s) */
  stallTime: number;
  /** Sorteia uma largada levemente diferente a cada geração */
  startVariation: boolean;
}

export const EXPERIMENT_LIMITS = {
  maxTime: { min: 10, max: 300 },
  stallTime: { min: 1, max: 30 },
  hiddenLayers: { min: 1, max: 4 },
  neurons: { min: 2, max: 64 },
  maxParams: 20000,
  trackCount: { min: 1, max: 5 },
};

export const TRAINING_STALL_DIST = 5;

export const ARCH_PRESETS: { label: string; hidden: number[] }[] = [
  { label: 'Mínima (8)', hidden: [8] },
  { label: 'Pequena (16)', hidden: [16] },
  { label: 'Padrão (16 × 16)', hidden: [16, 16] },
  { label: 'Média (24 × 24)', hidden: [24, 24] },
  { label: 'Grande (32 × 32)', hidden: [32, 32] },
  { label: 'Profunda (16 × 16 × 16)', hidden: [16, 16, 16] },
];

export function defaultExperiment(trackId = 'oval-largo', seed = 'evorace'): ExperimentConfig {
  return {
    version: 1,
    seed,
    trackIds: [trackId],
    inputs: { ...DEFAULT_INPUTS },
    hidden: [16, 16],
    evo: { ...DEFAULT_EVO },
    rewards: { ...DEFAULT_REWARDS },
    rewardPreset: 'completar',
    maxTime: 150,
    stallTime: 4,
    startVariation: false,
  };
}

/** Corrige valores fora dos limites e devolve avisos legíveis. */
export function sanitizeExperiment(raw: Partial<ExperimentConfig> | undefined): { config: ExperimentConfig; warnings: string[] } {
  const d = defaultExperiment();
  const warnings: string[] = [];
  const num = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
  const evo = sanitizeEvo(raw?.evo);
  warnings.push(...evo.warnings);
  const inputs = normalizeInputs(raw?.inputs);
  let hidden = Array.isArray(raw?.hidden) ? raw!.hidden.map((h) => Math.round(Number(h))) : d.hidden;
  hidden = hidden.filter((h) => Number.isFinite(h));
  if (hidden.length < EXPERIMENT_LIMITS.hiddenLayers.min || hidden.length > EXPERIMENT_LIMITS.hiddenLayers.max) {
    warnings.push('Número de camadas ocultas inválido; usando 16 × 16.');
    hidden = [16, 16];
  }
  hidden = hidden.map((h) => Math.min(EXPERIMENT_LIMITS.neurons.max, Math.max(EXPERIMENT_LIMITS.neurons.min, h)));
  if (paramCount(inputs, hidden) > EXPERIMENT_LIMITS.maxParams) {
    warnings.push('Rede grande demais; usando 16 × 16.');
    hidden = [16, 16];
  }
  const rewards = sanitizeRewards(raw?.rewards);
  const trackIds = Array.isArray(raw?.trackIds) && raw!.trackIds.length ? raw!.trackIds.filter((t) => typeof t === 'string').slice(0, EXPERIMENT_LIMITS.trackCount.max) : d.trackIds;
  const maxTime = Math.min(EXPERIMENT_LIMITS.maxTime.max, Math.max(EXPERIMENT_LIMITS.maxTime.min, num(raw?.maxTime, d.maxTime)));
  let stallTime = Math.min(EXPERIMENT_LIMITS.stallTime.max, Math.max(EXPERIMENT_LIMITS.stallTime.min, num(raw?.stallTime, d.stallTime)));
  if (stallTime >= maxTime) {
    stallTime = Math.max(1, Math.min(stallTime, maxTime / 2));
    warnings.push('O limite sem progresso precisa ser menor que o tempo máximo.');
  }
  const seed = typeof raw?.seed === 'string' && raw.seed.trim() ? raw.seed.trim().slice(0, 40) : typeof raw?.seed === 'number' ? String(raw.seed) : d.seed;
  return {
    config: {
      version: 1,
      seed,
      trackIds: trackIds.length ? trackIds : d.trackIds,
      inputs,
      hidden,
      evo: evo.config,
      rewards,
      rewardPreset: presetOf(rewards),
      maxTime,
      stallTime,
      startVariation: !!raw?.startVariation,
    },
    warnings,
  };
}

/** Mudar sensores ou arquitetura exige um experimento novo (os pesos não servem mais). */
export function compatibleArch(a: ExperimentConfig, b: ExperimentConfig): boolean {
  return sameInputs(a.inputs, b.inputs) && a.hidden.length === b.hidden.length && a.hidden.every((h, i) => h === b.hidden[i]);
}

/** Lista legível das diferenças entre duas configurações (para o histórico). */
export function describeConfigChanges(a: ExperimentConfig, b: ExperimentConfig): string[] {
  const out: string[] = [];
  const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;
  if (a.evo.populationSize !== b.evo.populationSize) out.push(`População: ${a.evo.populationSize} → ${b.evo.populationSize}`);
  if (a.evo.eliteCount !== b.evo.eliteCount) out.push(`Elite: ${a.evo.eliteCount} → ${b.evo.eliteCount}`);
  if (a.evo.selection !== b.evo.selection) out.push(`Seleção: ${a.evo.selection} → ${b.evo.selection}`);
  if (a.evo.selectionFraction !== b.evo.selectionFraction) out.push(`Fração de pais: ${pct(a.evo.selectionFraction)} → ${pct(b.evo.selectionFraction)}`);
  if (a.evo.tournamentSize !== b.evo.tournamentSize) out.push(`Torneio: ${a.evo.tournamentSize} → ${b.evo.tournamentSize}`);
  if (a.evo.mutationRate !== b.evo.mutationRate) out.push(`Prob. de mutação: ${pct(a.evo.mutationRate)} → ${pct(b.evo.mutationRate)}`);
  if (a.evo.mutationStrength !== b.evo.mutationStrength) out.push(`Intensidade de mutação: ${a.evo.mutationStrength} → ${b.evo.mutationStrength}`);
  if (a.evo.crossoverRate !== b.evo.crossoverRate) out.push(`Cruzamento: ${pct(a.evo.crossoverRate)} → ${pct(b.evo.crossoverRate)}`);
  if (a.evo.freshFraction !== b.evo.freshFraction) out.push(`Pilotos novos: ${pct(a.evo.freshFraction)} → ${pct(b.evo.freshFraction)}`);
  if (a.maxTime !== b.maxTime) out.push(`Tempo máximo: ${a.maxTime} s → ${b.maxTime} s`);
  if (a.stallTime !== b.stallTime) out.push(`Limite sem progresso: ${a.stallTime} s → ${b.stallTime} s`);
  if (a.startVariation !== b.startVariation) out.push(`Largada variada: ${a.startVariation ? 'sim' : 'não'} → ${b.startVariation ? 'sim' : 'não'}`);
  if (a.trackIds.join(',') !== b.trackIds.join(',')) out.push(`Pistas de treino: ${a.trackIds.join(', ')} → ${b.trackIds.join(', ')}`);
  for (const k of Object.keys(a.rewards) as (keyof RewardWeights)[]) {
    if (a.rewards[k] !== b.rewards[k]) out.push(`Recompensa "${REWARD_LIMITS[k].label}": ${a.rewards[k]} → ${b.rewards[k]}`);
  }
  return out;
}

export function cloneConfig(c: ExperimentConfig): ExperimentConfig {
  return {
    ...c,
    trackIds: [...c.trackIds],
    inputs: { ...c.inputs },
    hidden: [...c.hidden],
    evo: { ...c.evo },
    rewards: { ...c.rewards },
  };
}
