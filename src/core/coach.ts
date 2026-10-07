import { cloneConfig, sanitizeExperiment, type ExperimentConfig } from './config.ts';
import { dexp, dlog } from './dmath.ts';
import { compareMulti, evaluateBrain, summarize, type AttemptResult, type MultiResult } from './evaluation.ts';
import { POPULATION_OPTIONS } from './evolution.ts';
import { costPerStep, paramCount } from './nn.ts';
import { REWARD_LIMITS, presetOf, type RewardWeights } from './rewards.ts';
import { Rng, type RngState } from './rng.ts';
import { CONSISTENCY_STARTS, officialRules } from './rules.ts';
import type { RayCount } from './sensors.ts';
import { buildTrack, type Track, type TrackDef } from './track.ts';
import { Trainer, type TrainerSnapshot } from './trainer.ts';

/**
 * IA treinadora: otimização automática de configurações.
 *
 * 1. Fase de exploração: configurações aleatórias dentro dos limites
 *    (a primeira é sempre a configuração base do jogador, como referência).
 * 2. Fase de refinamento: escolhe uma das melhores e perturba alguns parâmetros.
 * 3. Se parar de melhorar, aumenta a variedade (perturbações maiores e
 *    configurações aleatórias).
 *
 * Cada configuração recebe o mesmo orçamento em passos de simulação (carro × passo),
 * treina com as mesmas sementes, e o melhor piloto é avaliado nas pistas de
 * validação pelas regras oficiais fixas. O teste final usa pistas reservadas e
 * acontece uma única vez, no fim — ele não orienta nenhuma decisão.
 */

export type CoachObjective = 'completar' | 'tempo' | 'generalizar';

export const OBJECTIVE_LABEL: Record<CoachObjective, string> = {
  completar: 'Completar pistas',
  tempo: 'Reduzir tempo mantendo conclusão mínima',
  generalizar: 'Generalizar para circuitos diferentes',
};

export interface RangeSpec {
  vary: boolean;
  min: number;
  max: number;
}

export interface ParamSpace {
  population: { vary: boolean; options: number[] };
  architecture: { vary: boolean; options: number[][] };
  rays: { vary: boolean; options: RayCount[] };
  mutationRate: RangeSpec;
  mutationStrength: RangeSpec;
  eliteCount: RangeSpec;
  selectionFraction: RangeSpec;
  crossoverRate: RangeSpec;
  freshFraction: RangeSpec;
  /** Só varia recompensas se permitido; fator máximo multiplicativo de cada peso */
  rewards: { vary: boolean; factor: number };
}

export type StopKind = 'orcamento' | 'alvo' | 'estagnacao';

export interface CoachConfig {
  version: 1;
  name: string;
  objective: CoachObjective;
  /** Conclusão mínima exigida no objetivo de tempo (0..1) */
  minCompletion: number;
  trainTracks: string[];
  valTracks: string[];
  testTracks: string[];
  base: ExperimentConfig;
  space: ParamSpace;
  maxExperiments: number;
  /** Orçamento total de treino em passos-carro */
  totalBudget: number;
  seeds: string[];
  stop: { kind: StopKind; patience: number; targetCompletion: number; targetTimeIndex: number };
  /** Fração dos experimentos na fase aleatória */
  randomFraction: number;
  /** Largadas por pista de validação (1, 3 ou 5) */
  valAttempts: number;
}

export const COACH_LIMITS = {
  maxExperiments: { min: 2, max: 60 },
  totalBudget: { min: 2_000_000, max: 600_000_000 },
  seeds: { min: 1, max: 3 },
  patience: { min: 2, max: 20 },
};

export function defaultCoachConfig(base: ExperimentConfig): CoachConfig {
  return {
    version: 1,
    name: 'Treinadora',
    objective: 'completar',
    minCompletion: 0.8,
    trainTracks: [...base.trackIds],
    valTracks: [...base.trackIds],
    testTracks: [],
    base: cloneConfig(base),
    space: {
      population: { vary: true, options: [20, 50, 100] },
      architecture: { vary: true, options: [[8], [16], [16, 16], [24, 24]] },
      rays: { vary: false, options: [5, 9, 13] },
      mutationRate: { vary: true, min: 0.02, max: 0.3 },
      mutationStrength: { vary: true, min: 0.05, max: 0.5 },
      eliteCount: { vary: true, min: 1, max: 8 },
      selectionFraction: { vary: true, min: 0.1, max: 0.4 },
      crossoverRate: { vary: false, min: 0, max: 0.5 },
      freshFraction: { vary: false, min: 0, max: 0.1 },
      rewards: { vary: false, factor: 2 },
    },
    maxExperiments: 10,
    totalBudget: 30_000_000,
    seeds: ['t1'],
    stop: { kind: 'orcamento', patience: 4, targetCompletion: 1, targetTimeIndex: 0 },
    randomFraction: 0.4,
    valAttempts: 3,
  };
}

export function sanitizeCoachConfig(raw: CoachConfig): { config: CoachConfig; warnings: string[] } {
  const warnings: string[] = [];
  const c: CoachConfig = JSON.parse(JSON.stringify({ ...raw, base: undefined }));
  c.base = sanitizeExperiment(raw.base).config;
  const clampI = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number.isFinite(v) ? v : lo)));
  c.maxExperiments = clampI(c.maxExperiments, COACH_LIMITS.maxExperiments.min, COACH_LIMITS.maxExperiments.max);
  c.totalBudget = Math.min(COACH_LIMITS.totalBudget.max, Math.max(COACH_LIMITS.totalBudget.min, Number(c.totalBudget) || COACH_LIMITS.totalBudget.min));
  c.seeds = (Array.isArray(c.seeds) ? c.seeds : []).map(String).filter(Boolean).slice(0, COACH_LIMITS.seeds.max);
  if (!c.seeds.length) c.seeds = ['t1'];
  c.stop.patience = clampI(c.stop.patience, COACH_LIMITS.patience.min, COACH_LIMITS.patience.max);
  c.minCompletion = Math.min(1, Math.max(0, Number(c.minCompletion) || 0));
  c.stop.targetCompletion = Math.min(1, Math.max(0, Number(c.stop.targetCompletion) || 0));
  c.stop.targetTimeIndex = Math.max(0, Number(c.stop.targetTimeIndex) || 0);
  c.randomFraction = Math.min(1, Math.max(0.1, Number(c.randomFraction) || 0.4));
  c.valAttempts = [1, 3, 5].includes(c.valAttempts) ? c.valAttempts : 3;
  c.trainTracks = [...new Set(c.trainTracks)].slice(0, 3);
  c.valTracks = [...new Set(c.valTracks)].slice(0, 5);
  if (!c.trainTracks.length) {
    c.trainTracks = [...c.base.trackIds];
    warnings.push('Sem pistas de treino; usando a pista do experimento.');
  }
  if (!c.valTracks.length) {
    c.valTracks = [...c.trainTracks];
    warnings.push('Sem pistas de validação; usando as de treino.');
  }
  const used = new Set([...c.trainTracks, ...c.valTracks]);
  const test = [...new Set(c.testTracks)].filter((t) => !used.has(t));
  if (test.length !== new Set(c.testTracks).size) warnings.push('Pistas de teste não podem ser usadas em treino ou validação; foram removidas do teste.');
  c.testTracks = test.slice(0, 5);
  if (c.objective === 'generalizar' && c.valTracks.every((t) => c.trainTracks.includes(t))) {
    warnings.push('Para generalizar, escolha pistas de validação diferentes das de treino.');
  }
  const s = c.space;
  const fix = (r: RangeSpec, lo: number, hi: number) => {
    r.min = Math.min(hi, Math.max(lo, Number(r.min)));
    r.max = Math.min(hi, Math.max(lo, Number(r.max)));
    if (r.min > r.max) [r.min, r.max] = [r.max, r.min];
  };
  fix(s.mutationRate, 0.005, 0.6);
  fix(s.mutationStrength, 0.01, 1.5);
  fix(s.eliteCount, 0, 20);
  fix(s.selectionFraction, 0.05, 0.6);
  fix(s.crossoverRate, 0, 1);
  fix(s.freshFraction, 0, 0.3);
  s.population.options = s.population.options.filter((p) => (POPULATION_OPTIONS as readonly number[]).includes(p));
  if (!s.population.options.length) s.population.options = [c.base.evo.populationSize];
  s.architecture.options = s.architecture.options.filter((h) => Array.isArray(h) && h.length >= 1 && h.length <= 4 && h.every((n) => n >= 2 && n <= 64));
  if (!s.architecture.options.length) s.architecture.options = [c.base.hidden];
  s.rays.options = s.rays.options.filter((r) => r === 5 || r === 9 || r === 13);
  if (!s.rays.options.length) s.rays.options = [c.base.inputs.rays];
  s.rewards.factor = Math.min(4, Math.max(1.1, Number(s.rewards.factor) || 2));
  return { config: c, warnings };
}

export interface CandidateParams {
  population: number;
  hidden: number[];
  rays: RayCount;
  mutationRate: number;
  mutationStrength: number;
  eliteCount: number;
  selectionFraction: number;
  crossoverRate: number;
  freshFraction: number;
  rewards: RewardWeights;
}

export interface RunResult {
  seed: string;
  generations: number;
  carSteps: number;
  official: MultiResult | null;
  validation: MultiResult;
  byTrack: TrackValidation[];
}

export interface TrackValidation {
  trackId: string;
  result: MultiResult;
}

export interface CandidateResult {
  index: number;
  phase: 'base' | 'aleatoria' | 'refinamento' | 'variedade';
  parent: number | null;
  params: CandidateParams;
  config: ExperimentConfig;
  runs: RunResult[];
  /** Resultado combinado (tempos normalizados pelo tempo de referência de cada pista) */
  validation: MultiResult;
  byTrack: TrackValidation[];
  /** Mediana de tempo/tempo de referência nas tentativas completadas */
  timeIndex: number | null;
  params_count: number;
  cost: number;
  carSteps: number;
  valSteps: number;
  bestGenome: Float64Array;
}

export interface CoachMessage {
  experiment: number;
  kind: 'info' | 'melhoria' | 'alerta' | 'decisao';
  text: string;
}

export interface CoachSnapshot {
  format: 'evorace-coach';
  version: 1;
  config: CoachConfig;
  trackDefs: TrackDef[];
  rng: RngState;
  candidates: CandidateResult[];
  current: { index: number; phase: CandidateResult['phase']; parent: number | null; params: CandidateParams; seedIdx: number; runs: RunResult[]; runGenomes: Float64Array[]; trainer: TrainerSnapshot | null } | null;
  budgetUsed: number;
  valStepsUsed: number;
  stagnation: number;
  variety: number;
  bestIndex: number;
  messages: CoachMessage[];
  finished: boolean;
  stopReason: string;
  finalTest: { result: MultiResult; byTrack: TrackValidation[] } | null;
  testUsed: boolean;
}

export type CoachStatus = 'treinando' | 'concluida';

const MAX_MESSAGES = 300;

export class Coach {
  config: CoachConfig;
  private defs = new Map<string, TrackDef>();
  private tracks = new Map<string, Track>();
  rng: Rng;
  candidates: CandidateResult[] = [];
  current: CoachSnapshot['current'] = null;
  trainer: Trainer | null = null;
  budgetUsed = 0;
  valStepsUsed = 0;
  stagnation = 0;
  variety = 1;
  bestIndex = -1;
  messages: CoachMessage[] = [];
  finished = false;
  stopReason = '';
  finalTest: CoachSnapshot['finalTest'] = null;
  private testUsed = false;

  constructor(config: CoachConfig, trackDefs: TrackDef[], snapshot?: CoachSnapshot) {
    this.config = sanitizeCoachConfig(config).config;
    for (const d of trackDefs) this.defs.set(d.id, d);
    for (const id of [...this.config.trainTracks, ...this.config.valTracks, ...this.config.testTracks]) {
      if (!this.defs.has(id)) throw new Error(`Pista "${id}" não encontrada.`);
    }
    if (snapshot) {
      this.rng = new Rng(snapshot.rng);
      this.candidates = snapshot.candidates;
      this.current = snapshot.current;
      this.budgetUsed = snapshot.budgetUsed;
      this.valStepsUsed = snapshot.valStepsUsed;
      this.stagnation = snapshot.stagnation;
      this.variety = snapshot.variety;
      this.bestIndex = snapshot.bestIndex;
      this.messages = snapshot.messages;
      this.finished = snapshot.finished;
      this.stopReason = snapshot.stopReason;
      this.finalTest = snapshot.finalTest;
      this.testUsed = snapshot.testUsed;
      if (this.current?.trainer) this.trainer = Trainer.fromSnapshot(this.current.trainer);
    } else {
      this.rng = new Rng(`treinadora:${this.config.name}:${this.config.seeds.join(',')}`);
      const nRandom = this.randomCount();
      this.say(0, 'info', `Objetivo: ${OBJECTIVE_LABEL[this.config.objective].toLowerCase()}. Vou começar explorando ${nRandom} configurações (a primeira é a sua configuração atual).`);
      this.say(0, 'info', `Cada experimento recebe ${fmtSteps(this.budgetPerRun())} passos de simulação por semente — o mesmo para todos, independente do tamanho da população.`);
    }
  }

  static fromSnapshot(s: CoachSnapshot): Coach {
    if (s.format !== 'evorace-coach' || s.version !== 1) throw new Error('Formato de treinadora desconhecido.');
    return new Coach(s.config, s.trackDefs, s);
  }

  get best(): CandidateResult | null {
    return this.bestIndex >= 0 ? this.candidates.find((c) => c.index === this.bestIndex) ?? null : null;
  }

  budgetPerRun(): number {
    return Math.floor(this.config.totalBudget / this.config.maxExperiments / this.config.seeds.length);
  }

  private randomCount(): number {
    return Math.max(2, Math.ceil(this.config.maxExperiments * this.config.randomFraction));
  }

  private track(id: string): Track {
    let t = this.tracks.get(id);
    if (!t) {
      t = buildTrack(this.defs.get(id)!);
      this.tracks.set(id, t);
    }
    return t;
  }

  private say(experiment: number, kind: CoachMessage['kind'], text: string): void {
    this.messages.push({ experiment, kind, text });
    if (this.messages.length > MAX_MESSAGES) this.messages.splice(0, this.messages.length - MAX_MESSAGES);
  }

  // ---------- Amostragem de configurações ----------

  private baseParams(): CandidateParams {
    const b = this.config.base;
    return {
      population: b.evo.populationSize,
      hidden: [...b.hidden],
      rays: b.inputs.rays,
      mutationRate: b.evo.mutationRate,
      mutationStrength: b.evo.mutationStrength,
      eliteCount: b.evo.eliteCount,
      selectionFraction: b.evo.selectionFraction,
      crossoverRate: b.evo.crossoverRate,
      freshFraction: b.evo.freshFraction,
      rewards: { ...b.rewards },
    };
  }

  private randomParams(): CandidateParams {
    const s = this.config.space;
    const p = this.baseParams();
    const r = this.rng;
    const logU = (lo: number, hi: number) => dexp(dlog(Math.max(lo, 1e-4)) + r.next() * (dlog(Math.max(hi, 1e-4)) - dlog(Math.max(lo, 1e-4))));
    if (s.population.vary) p.population = r.pick(s.population.options);
    if (s.architecture.vary) p.hidden = [...r.pick(s.architecture.options)];
    if (s.rays.vary) p.rays = r.pick(s.rays.options);
    if (s.mutationRate.vary) p.mutationRate = logU(s.mutationRate.min, s.mutationRate.max);
    if (s.mutationStrength.vary) p.mutationStrength = logU(s.mutationStrength.min, s.mutationStrength.max);
    if (s.eliteCount.vary) p.eliteCount = Math.round(r.range(s.eliteCount.min, s.eliteCount.max));
    if (s.selectionFraction.vary) p.selectionFraction = r.range(s.selectionFraction.min, s.selectionFraction.max);
    if (s.crossoverRate.vary) p.crossoverRate = r.range(s.crossoverRate.min, s.crossoverRate.max);
    if (s.freshFraction.vary) p.freshFraction = r.range(s.freshFraction.min, s.freshFraction.max);
    if (s.rewards.vary) {
      const f = dlog(s.rewards.factor);
      for (const k of Object.keys(p.rewards) as (keyof RewardWeights)[]) {
        if (p.rewards[k] > 0) p.rewards[k] = clampReward(k, p.rewards[k] * dexp(r.range(-f, f)));
      }
    }
    return p;
  }

  private perturb(parent: CandidateParams): CandidateParams {
    const s = this.config.space;
    const r = this.rng;
    const p: CandidateParams = { ...parent, hidden: [...parent.hidden], rewards: { ...parent.rewards } };
    const scale = 0.35 * this.variety;
    const knobs: (() => void)[] = [];
    const neighbor = <T>(opts: T[], cur: T, eq: (a: T, b: T) => boolean) => {
      const i = opts.findIndex((o) => eq(o, cur));
      if (i < 0) return r.pick(opts);
      const step = r.bool() ? 1 : -1;
      return opts[Math.min(opts.length - 1, Math.max(0, i + step))];
    };
    const mulRange = (v: number, spec: RangeSpec) => Math.min(spec.max, Math.max(spec.min, v * dexp(r.gaussian() * scale)));
    if (s.population.vary && s.population.options.length > 1) knobs.push(() => (p.population = neighbor(s.population.options, p.population, (a, b) => a === b)));
    if (s.architecture.vary && s.architecture.options.length > 1)
      knobs.push(() => (p.hidden = [...neighbor(s.architecture.options, p.hidden, (a, b) => a.join('x') === b.join('x'))]));
    if (s.rays.vary && s.rays.options.length > 1) knobs.push(() => (p.rays = neighbor(s.rays.options, p.rays, (a, b) => a === b)));
    if (s.mutationRate.vary) knobs.push(() => (p.mutationRate = mulRange(p.mutationRate, s.mutationRate)));
    if (s.mutationStrength.vary) knobs.push(() => (p.mutationStrength = mulRange(p.mutationStrength, s.mutationStrength)));
    if (s.eliteCount.vary)
      knobs.push(() => (p.eliteCount = Math.round(Math.min(s.eliteCount.max, Math.max(s.eliteCount.min, p.eliteCount + (r.bool() ? 1 : -1) * Math.max(1, Math.round(2 * this.variety)))))));
    if (s.selectionFraction.vary) knobs.push(() => (p.selectionFraction = mulRange(p.selectionFraction, s.selectionFraction)));
    if (s.crossoverRate.vary) knobs.push(() => (p.crossoverRate = Math.min(s.crossoverRate.max, Math.max(s.crossoverRate.min, p.crossoverRate + r.gaussian() * 0.15 * this.variety))));
    if (s.freshFraction.vary) knobs.push(() => (p.freshFraction = Math.min(s.freshFraction.max, Math.max(s.freshFraction.min, p.freshFraction + r.gaussian() * 0.03 * this.variety))));
    if (s.rewards.vary)
      knobs.push(() => {
        const keys = (Object.keys(p.rewards) as (keyof RewardWeights)[]).filter((k) => p.rewards[k] > 0);
        const k = r.pick(keys);
        p.rewards[k] = clampReward(k, p.rewards[k] * dexp(r.gaussian() * scale));
      });
    if (!knobs.length) return p;
    // Muda pelo menos um parâmetro; cada um com chance de 40%.
    let changed = false;
    for (const k of knobs) {
      if (r.next() < 0.4) {
        k();
        changed = true;
      }
    }
    if (!changed) r.pick(knobs)();
    return p;
  }

  private configFor(p: CandidateParams, seed: string): ExperimentConfig {
    const c = cloneConfig(this.config.base);
    c.seed = seed;
    c.trackIds = [...this.config.trainTracks];
    c.hidden = [...p.hidden];
    c.inputs = { ...c.inputs, rays: p.rays };
    c.evo = {
      ...c.evo,
      populationSize: p.population,
      mutationRate: p.mutationRate,
      mutationStrength: p.mutationStrength,
      eliteCount: p.eliteCount,
      selectionFraction: p.selectionFraction,
      crossoverRate: p.crossoverRate,
      freshFraction: p.freshFraction,
    };
    c.rewards = { ...p.rewards };
    c.rewardPreset = presetOf(c.rewards);
    return sanitizeExperiment(c).config;
  }

  private nextCandidate(): void {
    const index = this.candidates.length + 1;
    let params: CandidateParams;
    let phase: CandidateResult['phase'];
    let parent: number | null = null;
    if (index === 1) {
      params = this.baseParams();
      phase = 'base';
    } else if (index <= this.randomCount() || this.candidates.length === 0) {
      params = this.randomParams();
      phase = 'aleatoria';
    } else {
      if (index === this.randomCount() + 1) this.say(index, 'decisao', 'Fase de exploração concluída. Agora vou refinar as melhores configurações.');
      if (this.variety > 1 && this.rng.next() < 0.5) {
        params = this.randomParams();
        phase = 'variedade';
      } else {
        const ranked = this.ranked();
        const top = ranked.slice(0, Math.min(3, ranked.length));
        // torneio simples entre os 3 melhores, favorecendo o primeiro
        const pick = this.rng.next() < 0.6 ? top[0] : this.rng.pick(top);
        parent = pick.index;
        params = this.perturb(pick.params);
        phase = this.variety > 1 ? 'variedade' : 'refinamento';
      }
    }
    // Ajusta incoerências (ex.: elite maior que a população permite).
    const cfg = this.configFor(params, this.config.seeds[0]);
    params.eliteCount = cfg.evo.eliteCount;
    params.freshFraction = cfg.evo.freshFraction;
    this.current = { index, phase, parent, params, seedIdx: 0, runs: [], runGenomes: [], trainer: null };
    this.say(
      index,
      'info',
      `Experimento ${index}/${this.config.maxExperiments}${parent ? ` (variação do nº ${parent})` : ''}: população ${params.population}, rede ${params.hidden.join('×')}, ` +
        `${params.rays} sensores, mutação ${(params.mutationRate * 100).toFixed(1)}% × ${params.mutationStrength.toFixed(2)}, elite ${params.eliteCount}.`,
    );
    this.startRun();
  }

  private startRun(): void {
    const cur = this.current!;
    const cfg = this.configFor(cur.params, this.config.seeds[cur.seedIdx]);
    this.trainer = new Trainer(
      cfg,
      cfg.trackIds.map((id) => this.defs.get(id)!),
    );
  }

  /** Comparação de candidatas pelo objetivo (sempre com os critérios oficiais por baixo). */
  compare(a: CandidateResult, b: CandidateResult): number {
    const obj = this.config.objective;
    if (obj === 'tempo') {
      const min = this.config.minCompletion;
      const am = a.validation.completionRate >= min - 1e-9;
      const bm = b.validation.completionRate >= min - 1e-9;
      if (am !== bm) return am ? -1 : 1;
      if (am && bm && a.timeIndex !== null && b.timeIndex !== null && Math.abs(a.timeIndex - b.timeIndex) > 1e-9) return a.timeIndex - b.timeIndex;
    }
    const c = compareMulti(a.validation, b.validation);
    if (c !== 0) return c;
    return a.cost - b.cost || a.index - b.index;
  }

  ranked(): CandidateResult[] {
    return [...this.candidates].sort((a, b) => this.compare(a, b));
  }

  /** Avalia um piloto em pistas, com tempos normalizados pela referência de cada pista. */
  private evaluateOn(genome: Float64Array, cfg: ExperimentConfig, trackIds: string[]): { combined: MultiResult; byTrack: TrackValidation[]; steps: number } {
    const brain = { inputs: cfg.inputs, hidden: cfg.hidden, genome };
    const starts = CONSISTENCY_STARTS.slice(0, this.config.valAttempts);
    const normalized: AttemptResult[] = [];
    const byTrack: TrackValidation[] = [];
    let steps = 0;
    for (const id of trackIds) {
      const t = this.track(id);
      const out = evaluateBrain(brain, t, officialRules(t), starts, false);
      steps += out.carSteps;
      byTrack.push({ trackId: id, result: out.result });
      for (const a of out.result.attempts) normalized.push({ ...a, time: a.time / t.refTime, timeAtProgress: a.timeAtProgress / t.refTime });
    }
    return { combined: summarize(normalized), byTrack, steps };
  }

  /**
   * Avança o trabalho em até `maxCarSteps` passos-carro.
   * Devolve true enquanto ainda houver trabalho.
   */
  advance(maxCarSteps: number): boolean {
    if (this.finished) return false;
    if (!this.current) {
      if (this.shouldStop()) {
        this.finish();
        return false;
      }
      this.nextCandidate();
    }
    const tr = this.trainer!;
    const runBudget = this.budgetPerRun();
    const start = tr.workSoFar;
    while (tr.workSoFar - start < maxCarSteps) {
      tr.advance(8);
      // Orçamento exato em passos de treino: para no meio da geração se precisar.
      // O piloto escolhido vem das gerações completas.
      if (tr.trainingWorkSoFar >= runBudget && (tr.bestOfficial || tr.bestEver)) {
        this.finishRun();
        return !this.finished;
      }
    }
    return true;
  }

  private finishRun(): void {
    const cur = this.current!;
    const tr = this.trainer!;
    const champion = tr.bestOfficial ?? tr.bestEver!;
    const val = this.evaluateOn(champion.genome, tr.config, this.config.valTracks);
    this.valStepsUsed += val.steps;
    const trainSteps = tr.trainingWorkSoFar;
    this.budgetUsed += trainSteps;
    cur.runs.push({
      seed: this.config.seeds[cur.seedIdx],
      generations: tr.generation - 1,
      carSteps: trainSteps,
      official: champion.official,
      validation: val.combined,
      byTrack: val.byTrack,
    });
    cur.runGenomes.push(champion.genome.slice());
    cur.seedIdx++;
    this.trainer = null;
    cur.trainer = null;
    if (cur.seedIdx < this.config.seeds.length) {
      this.startRun();
      return;
    }
    this.finishCandidate();
  }

  private finishCandidate(): void {
    const cur = this.current!;
    const cfg = this.configFor(cur.params, this.config.seeds[0]);
    // Junta as tentativas de todas as sementes (mesmo peso para cada uma).
    const all: AttemptResult[] = cur.runs.flatMap((r) => r.validation.attempts);
    const validation = summarize(all);
    let bestRun = 0;
    for (let i = 1; i < cur.runs.length; i++) if (compareMulti(cur.runs[i].validation, cur.runs[bestRun].validation) < 0) bestRun = i;
    const cand: CandidateResult = {
      index: cur.index,
      phase: cur.phase,
      parent: cur.parent,
      params: cur.params,
      config: cfg,
      runs: cur.runs,
      validation,
      byTrack: cur.runs[bestRun].byTrack,
      timeIndex: validation.medianTime,
      params_count: paramCount(cfg.inputs, cfg.hidden),
      cost: costPerStep(cfg.inputs, cfg.hidden),
      carSteps: cur.runs.reduce((s, r) => s + r.carSteps, 0),
      valSteps: this.valStepsUsed,
      bestGenome: cur.runGenomes[bestRun],
    };
    this.candidates.push(cand);
    this.current = null;

    const txt = `Experimento ${cand.index}: conclusão ${(validation.completionRate * 100).toFixed(0)}% na validação` +
      (validation.medianTime !== null ? `, tempo mediano ${validation.medianTime.toFixed(3)}× a referência` : `, progresso médio ${(validation.meanProgress * 100).toFixed(0)}%`) +
      ` (${cand.runs.map((r) => r.generations).join('+')} gerações).`;
    this.say(cand.index, 'info', txt);

    const prev = this.best;
    if (!prev || this.compare(cand, prev) < 0) {
      if (prev) {
        let why = '';
        if (cand.validation.completionRate > prev.validation.completionRate) why = `conclusão ${(prev.validation.completionRate * 100).toFixed(0)}% → ${(cand.validation.completionRate * 100).toFixed(0)}%`;
        else if (cand.timeIndex !== null && prev.timeIndex !== null && cand.timeIndex < prev.timeIndex) why = `tempo ${prev.timeIndex.toFixed(3)} → ${cand.timeIndex.toFixed(3)}`;
        else why = `progresso ${(prev.validation.meanProgress * 100).toFixed(0)}% → ${(cand.validation.meanProgress * 100).toFixed(0)}%`;
        this.say(cand.index, 'melhoria', `Nova melhor configuração (${why}).`);
        if (cand.params_count < prev.params_count * 0.75) this.say(cand.index, 'melhoria', 'E ainda usa uma rede menor, com menor custo de processamento.');
      } else {
        this.say(cand.index, 'melhoria', 'Primeira configuração avaliada: ela vira a referência.');
      }
      this.bestIndex = cand.index;
      this.stagnation = 0;
      if (this.variety > 1) {
        this.variety = 1;
        this.say(cand.index, 'decisao', 'Voltando a refinar com variações pequenas.');
      }
    } else {
      this.stagnation++;
      const best = prev;
      if (cand.timeIndex !== null && best.timeIndex !== null && cand.timeIndex < best.timeIndex - 1e-6 && cand.validation.completionRate < best.validation.completionRate) {
        this.say(cand.index, 'alerta', 'O novo piloto é mais rápido, mas completa menos tentativas.');
      }
      const similar =
        Math.abs(cand.validation.completionRate - best.validation.completionRate) < 1e-9 &&
        (cand.timeIndex !== null && best.timeIndex !== null
          ? cand.timeIndex <= best.timeIndex * 1.03
          : Math.abs(cand.validation.meanProgress - best.validation.meanProgress) < 0.02);
      if (similar && cand.params_count < best.params_count * 0.75) {
        this.say(cand.index, 'decisao', 'Uma rede menor conseguiu resultado semelhante com menor custo.');
      }
      const inRefine = cand.index > this.randomCount();
      if (inRefine && this.stagnation >= Math.max(2, Math.floor(this.config.stop.patience / 2)) && this.variety === 1) {
        this.variety = 2;
        this.say(cand.index, 'decisao', 'A configuração deixou de melhorar. Vou testar mais variedade.');
      }
    }
    if (this.shouldStop()) this.finish();
  }

  private shouldStop(): boolean {
    const c = this.config;
    if (this.candidates.length >= c.maxExperiments) {
      this.stopReason = 'Número máximo de experimentos atingido.';
      return true;
    }
    if (this.budgetUsed + this.budgetPerRun() * c.seeds.length > c.totalBudget * 1.05) {
      this.stopReason = 'Orçamento esgotado.';
      return true;
    }
    const best = this.best;
    if (c.stop.kind === 'alvo' && best) {
      const okC = best.validation.completionRate >= c.stop.targetCompletion - 1e-9;
      const okT = c.stop.targetTimeIndex <= 0 || (best.timeIndex !== null && best.timeIndex <= c.stop.targetTimeIndex);
      if (okC && okT) {
        this.stopReason = 'Alvo atingido.';
        return true;
      }
    }
    if (c.stop.kind === 'estagnacao' && this.candidates.length > this.randomCount() && this.stagnation >= c.stop.patience) {
      this.stopReason = `Sem melhoria em ${this.stagnation} experimentos seguidos.`;
      return true;
    }
    return false;
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.trainer = null;
    this.current = null;
    this.say(this.candidates.length, 'decisao', `${this.stopReason} Melhor configuração: experimento ${this.bestIndex}.`);
    this.runFinalTest();
  }

  /** Teste final em pistas reservadas. Executado uma única vez e nunca usado para decidir. */
  private runFinalTest(): void {
    if (this.testUsed) return;
    this.testUsed = true;
    const best = this.best;
    if (!best || !this.config.testTracks.length) {
      this.say(this.candidates.length, 'info', 'Sem pistas de teste reservadas: o teste final foi pulado.');
      return;
    }
    const ev = this.evaluateOn(best.bestGenome, best.config, this.config.testTracks);
    this.finalTest = { result: ev.combined, byTrack: ev.byTrack };
    this.say(
      this.candidates.length,
      'info',
      `Teste final (pistas nunca vistas pela treinadora): conclusão ${(ev.combined.completionRate * 100).toFixed(0)}%` +
        (ev.combined.medianTime !== null ? `, tempo ${ev.combined.medianTime.toFixed(3)}× a referência.` : `, progresso médio ${(ev.combined.meanProgress * 100).toFixed(0)}%.`),
    );
  }

  /** Cancela agora: encerra a busca mantendo o melhor encontrado até aqui. */
  cancel(): void {
    if (this.finished) return;
    this.stopReason = 'Cancelada pelo jogador.';
    this.finish();
  }

  progress(): { experiment: number; total: number; budgetUsed: number; budget: number; runSteps: number; runBudget: number; generation: number; seedIdx: number } {
    return {
      experiment: this.current?.index ?? this.candidates.length,
      total: this.config.maxExperiments,
      budgetUsed: this.budgetUsed + (this.trainer?.trainingWorkSoFar ?? 0),
      budget: this.config.totalBudget,
      runSteps: this.trainer?.trainingWorkSoFar ?? 0,
      runBudget: this.budgetPerRun(),
      generation: this.trainer?.generation ?? 0,
      seedIdx: this.current?.seedIdx ?? 0,
    };
  }

  snapshot(): CoachSnapshot {
    const cur = this.current
      ? { ...this.current, runs: [...this.current.runs], runGenomes: this.current.runGenomes.map((g) => g.slice()), trainer: this.trainer ? this.trainer.snapshot() : null }
      : null;
    return {
      format: 'evorace-coach',
      version: 1,
      config: this.config,
      trackDefs: [...this.defs.values()],
      rng: this.rng.getState(),
      candidates: this.candidates,
      current: cur,
      budgetUsed: this.budgetUsed,
      valStepsUsed: this.valStepsUsed,
      stagnation: this.stagnation,
      variety: this.variety,
      bestIndex: this.bestIndex,
      messages: this.messages.slice(),
      finished: this.finished,
      stopReason: this.stopReason,
      finalTest: this.finalTest,
      testUsed: this.testUsed,
    };
  }
}

function clampReward(k: keyof RewardWeights, v: number): number {
  const l = REWARD_LIMITS[k];
  return Math.min(l.max, Math.max(l.min, Math.round(v / l.step) * l.step));
}

export function fmtSteps(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} mi`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} mil`;
  return String(Math.round(n));
}
