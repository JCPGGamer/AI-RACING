/**
 * Pontuação de treinamento (configurável). É ela que decide quem vira pai
 * na próxima geração. A avaliação oficial (evaluation.ts) é fixa e separada.
 *
 * Todos os termos são normalizados:
 * - distâncias são divididas pelo comprimento da volta (pistas longas não valem mais);
 * - tempos são divididos pelo tempo de referência da pista (volta a 40 m/s);
 * - a oscilação soma as variações do comando de direção a cada passo fixo,
 *   dividida pelo tempo de referência.
 */

export interface RewardWeights {
  /** Pontos por volta inteira de progresso novo na direção certa */
  progress: number;
  /** Pontos distribuídos entre todos os checkpoints inéditos */
  checkpoint: number;
  /** Bônus ao completar a volta */
  completion: number;
  /** Penalidade por tempo de referência gasto */
  time: number;
  /** Penalidade por bater */
  collision: number;
  /** Penalidade por ficar parado (tentativa encerrada por falta de progresso) */
  stall: number;
  /** Penalidade por volta inteira percorrida para trás */
  backward: number;
  /** Penalidade por oscilação da direção */
  oscillation: number;
}

export type RewardPresetId = 'completar' | 'velocidade' | 'consistencia' | 'personalizado';

export const REWARD_PRESETS: Record<Exclude<RewardPresetId, 'personalizado'>, { name: string; description: string; weights: RewardWeights }> = {
  completar: {
    name: 'Aprender a completar',
    description: 'Valoriza avançar e chegar ao fim. Bom para começar.',
    weights: { progress: 100, checkpoint: 20, completion: 60, time: 0, collision: 10, stall: 10, backward: 50, oscillation: 0 },
  },
  velocidade: {
    name: 'Buscar velocidade',
    description: 'Completar ainda vale muito, mas cada segundo gasto custa pontos.',
    weights: { progress: 100, checkpoint: 10, completion: 100, time: 40, collision: 20, stall: 20, backward: 50, oscillation: 0 },
  },
  consistencia: {
    name: 'Priorizar consistência',
    description: 'Pune batidas e direção nervosa. Gera pilotos mais suaves.',
    weights: { progress: 100, checkpoint: 20, completion: 80, time: 10, collision: 50, stall: 50, backward: 50, oscillation: 0.5 },
  },
};

export const REWARD_LIMITS: Record<keyof RewardWeights, { min: number; max: number; step: number; label: string; hint: string }> = {
  progress: { min: 0, max: 300, step: 5, label: 'Progresso novo', hint: 'Pontos por avançar em trechos ainda não percorridos, na direção certa.' },
  checkpoint: { min: 0, max: 200, step: 5, label: 'Checkpoints inéditos', hint: 'Pontos por passar pelos checkpoints na ordem (cada um conta uma vez).' },
  completion: { min: 0, max: 500, step: 10, label: 'Conclusão', hint: 'Bônus ao cruzar a chegada depois de todos os checkpoints.' },
  time: {
    min: 0,
    max: 200,
    step: 5,
    label: 'Tempo gasto',
    hint: 'Penalidade pelo tempo simulado da volta. Quem não completa paga o tempo máximo, para que bater cedo não vire vantagem.',
  },
  collision: { min: 0, max: 300, step: 5, label: 'Colisão', hint: 'Penalidade ao encostar na borda.' },
  stall: {
    min: 0,
    max: 300,
    step: 5,
    label: 'Ficar parado',
    hint: 'Penalidade quando a tentativa acaba por falta de progresso. Se for bem menor que a de colisão, os pilotos podem aprender a não sair do lugar.',
  },
  backward: { min: 0, max: 300, step: 5, label: 'Recuo na pista', hint: 'Penalidade por andar para trás na pista.' },
  oscillation: { min: 0, max: 5, step: 0.05, label: 'Oscilação da direção', hint: 'Penalidade por mexer o volante de um lado para o outro sem necessidade.' },
};

export const DEFAULT_REWARDS: RewardWeights = { ...REWARD_PRESETS.completar.weights };

export interface AttemptStats {
  /** Maior progresso válido (m), a partir da largada */
  maxProgress: number;
  lapDistance: number;
  /** Checkpoints inéditos atravessados (inclui a chegada) */
  checkpoints: number;
  checkpointTotal: number;
  completed: boolean;
  crashed: boolean;
  stalled: boolean;
  /** Tempo simulado da tentativa (s) */
  time: number;
  /** Tempo máximo permitido (s): cobrado de quem não completa */
  maxTime: number;
  /** Distância percorrida para trás (m) */
  backDistance: number;
  /** Soma de |Δ comando de direção| a cada passo */
  steerVariation: number;
  refTime: number;
}

export interface ScoreTerm {
  key: keyof RewardWeights;
  label: string;
  value: number;
}

export function scoreTerms(s: AttemptStats, w: RewardWeights): ScoreTerm[] {
  const lap = Math.max(1, s.lapDistance);
  const ref = Math.max(1, s.refTime);
  return [
    { key: 'progress', label: REWARD_LIMITS.progress.label, value: w.progress * (s.maxProgress / lap) },
    { key: 'checkpoint', label: REWARD_LIMITS.checkpoint.label, value: w.checkpoint * (s.checkpoints / Math.max(1, s.checkpointTotal)) },
    { key: 'completion', label: REWARD_LIMITS.completion.label, value: s.completed ? w.completion : 0 },
    { key: 'time', label: REWARD_LIMITS.time.label, value: -w.time * ((s.completed ? s.time : s.maxTime) / ref) },
    { key: 'collision', label: REWARD_LIMITS.collision.label, value: s.crashed ? -w.collision : 0 },
    { key: 'stall', label: REWARD_LIMITS.stall.label, value: s.stalled ? -w.stall : 0 },
    { key: 'backward', label: REWARD_LIMITS.backward.label, value: -w.backward * (s.backDistance / lap) },
    { key: 'oscillation', label: REWARD_LIMITS.oscillation.label, value: -w.oscillation * (s.steerVariation / ref) },
  ];
}

export function trainingScore(s: AttemptStats, w: RewardWeights): number {
  let total = 0;
  for (const t of scoreTerms(s, w)) total += t.value;
  return total;
}

export function sanitizeRewards(w: Partial<RewardWeights> | undefined): RewardWeights {
  const out = { ...DEFAULT_REWARDS };
  if (!w) return out;
  for (const k of Object.keys(REWARD_LIMITS) as (keyof RewardWeights)[]) {
    const v = w[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = Math.min(REWARD_LIMITS[k].max, Math.max(REWARD_LIMITS[k].min, v));
    }
  }
  return out;
}

export function presetOf(w: RewardWeights): RewardPresetId {
  for (const [id, p] of Object.entries(REWARD_PRESETS)) {
    const pw = p.weights;
    if ((Object.keys(pw) as (keyof RewardWeights)[]).every((k) => Math.abs(pw[k] - w[k]) < 1e-9)) return id as RewardPresetId;
  }
  return 'personalizado';
}
