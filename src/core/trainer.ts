import { cloneConfig, compatibleArch, describeConfigChanges, sanitizeExperiment, TRAINING_STALL_DIST, type ExperimentConfig } from './config.ts';
import { compareMulti, evaluateBrain, summarize, type AttemptResult, type MultiResult } from './evaluation.ts';
import { mutate, nextGeneration, randomPopulation, rankOrder, type Individual, type IndividualKind } from './evolution.ts';
import { layerSizes, type Brain } from './nn.ts';
import type { Replay } from './replay.ts';
import { trainingScore } from './rewards.ts';
import { Rng, type RngState } from './rng.ts';
import { OFFICIAL_START, officialRules } from './rules.ts';
import { RaceSim, STANDARD_START, type EndReason, type RunRules, type StartCondition } from './sim.ts';
import { buildTrack, type Track, type TrackDef } from './track.ts';

/**
 * Treinador de uma população. Independente de interface: roda em worker,
 * em testes e em scripts. Cada geração:
 *   1. coloca todos os carros na largada de cada pista de treino;
 *   2. roda a simulação passo a passo (rede → física → progresso);
 *   3. calcula a pontuação de treinamento;
 *   4. avalia os melhores pelas regras oficiais (campeão oficial separado);
 *   5. cria a próxima geração (elite, filhos com mutação, novos).
 */

export interface IndividualResult {
  id: number;
  kind: IndividualKind;
  score: number;
  /** progresso médio nas pistas (0..1) */
  progress: number;
  completed: number;
  /** tempo da volta na primeira pista (se completou) */
  lapTime: number | null;
  reason: EndReason;
}

export interface GenStats {
  gen: number;
  bestScore: number;
  meanScore: number;
  medianScore: number;
  bestProgress: number;
  completionRate: number;
  bestLapTime: number | null;
  deaths: Record<EndReason, number>;
  bestId: number;
  bestKind: IndividualKind;
  official: { completionRate: number; medianTime: number | null; bestTime: number | null; meanProgress: number } | null;
  newOfficialRecord: boolean;
  newScoreRecord: boolean;
  carSteps: number;
  populationSize: number;
}

export interface ConfigChange {
  gen: number;
  changes: string[];
}

export interface ChampionRecord {
  id: number;
  generation: number;
  genome: Float64Array;
  score: number;
  official: MultiResult | null;
  replay: Replay | null;
}

export interface TrainerSnapshot {
  format: 'evorace-trainer';
  version: 1;
  config: ExperimentConfig;
  trackDefs: TrackDef[];
  generation: number;
  nextId: number;
  rng: RngState;
  population: Individual[];
  history: GenStats[];
  changes: ConfigChange[];
  bestEver: ChampionRecord | null;
  bestOfficial: ChampionRecord | null;
  lastGenBestReplay: Replay | null;
  carStepsTotal: number;
  trainCarSteps?: number;
  deaths: Record<string, number[]>;
  /** Mudança de configuração agendada para o próximo limite de geração */
  pending?: { config: ExperimentConfig; trackDefs: TrackDef[] | null } | null;
}

export const MAX_HISTORY = 3000;
export const MAX_DEATH_POINTS = 3000;
const OFFICIAL_CANDIDATES = 3;

export interface StepOutcome {
  /** Estatísticas quando uma geração terminou neste avanço */
  generationDone: GenStats | null;
}

export class Trainer {
  config: ExperimentConfig;
  tracks: Track[];
  trackDefs: TrackDef[];
  generation = 1;
  nextId = 1;
  rng: Rng;
  population: Individual[];
  history: GenStats[] = [];
  changes: ConfigChange[] = [];
  bestEver: ChampionRecord | null = null;
  bestOfficial: ChampionRecord | null = null;
  lastGenBestReplay: Replay | null = null;
  lastResults: IndividualResult[] = [];
  carStepsTotal = 0;
  /** Só os passos das simulações de treino (sem as avaliações oficiais) */
  trainCarSteps = 0;
  deaths = new Map<string, number[]>();
  /** Cópia do mapa de mortes no início da geração (para a retomada não duplicar pontos) */
  private deathsAtGenStart: Record<string, number[]> = {};

  /** Simulação da pista atual da geração atual */
  sim!: RaceSim;
  trackIdx = 0;
  private scores!: Float64Array;
  private progress!: Float64Array;
  private completions!: Int32Array;
  private lapTimes!: Float64Array;
  private reasons!: EndReason[];
  private genCarSteps = 0;
  private genStart: StartCondition = STANDARD_START;
  private pending: ExperimentConfig | null = null;
  private pendingDefs: TrackDef[] | null = null;
  /** Estado do gerador no início da geração atual (retomada exata) */
  private rngAtGenStart: RngState = [0, 0, 0, 0];
  private trainStepsAtGenStart = 0;

  constructor(config: ExperimentConfig, trackDefs: TrackDef[], snapshot?: TrainerSnapshot) {
    this.config = sanitizeExperiment(config).config;
    this.trackDefs = trackDefs;
    if (trackDefs.length !== this.config.trackIds.length) throw new Error('Pistas de treino não encontradas.');
    this.tracks = trackDefs.map((d) => buildTrack(d));
    if (snapshot) {
      this.rng = new Rng(snapshot.rng);
      this.generation = snapshot.generation;
      this.nextId = snapshot.nextId;
      this.population = snapshot.population.map((p) => ({ ...p, genome: Float64Array.from(p.genome), parents: [...p.parents] }));
      this.history = snapshot.history.slice();
      this.changes = snapshot.changes.slice();
      this.bestEver = snapshot.bestEver;
      this.bestOfficial = snapshot.bestOfficial;
      this.lastGenBestReplay = snapshot.lastGenBestReplay;
      this.carStepsTotal = snapshot.carStepsTotal;
      this.trainCarSteps = snapshot.trainCarSteps ?? snapshot.carStepsTotal;
      for (const [k, v] of Object.entries(snapshot.deaths ?? {})) this.deaths.set(k, v.slice());
      if (snapshot.pending) {
        this.pending = sanitizeExperiment(snapshot.pending.config).config;
        this.pendingDefs = snapshot.pending.trackDefs;
      }
      const expected = layerSizes(this.config.inputs, this.config.hidden);
      let params = 0;
      for (let l = 1; l < expected.length; l++) params += expected[l] * expected[l - 1] + expected[l];
      if (this.population.some((p) => p.genome.length !== params)) throw new Error('População incompatível com a arquitetura.');
    } else {
      this.rng = new Rng(this.config.seed);
      this.population = randomPopulation(this.config.evo.populationSize, this.config.inputs, this.config.hidden, this.rng, 1);
      this.nextId = this.population.length + 1;
    }
    this.beginGeneration();
  }

  /** Passos-carro já simulados, incluindo a geração em andamento. */
  get workSoFar(): number {
    return this.carStepsTotal + this.genCarSteps + this.sim.carSteps;
  }

  /** Passos-carro de treino (sem avaliações), incluindo a geração em andamento. */
  get trainingWorkSoFar(): number {
    return this.trainCarSteps + this.sim.carSteps;
  }

  /**
   * Novo experimento a partir de um campeão: a população começa com uma cópia
   * exata do cérebro, variações dele (mutação) e alguns pilotos aleatórios.
   * É diferente de retomar: o histórico e o gerador começam do zero.
   */
  static fromChampion(config: ExperimentConfig, trackDefs: TrackDef[], genome: Float64Array): Trainer {
    const tr = new Trainer(config, trackDefs);
    const expected = tr.population[0].genome.length;
    if (genome.length !== expected) throw new Error('O campeão tem uma arquitetura diferente da configuração escolhida.');
    const N = tr.population.length;
    const mutants = Math.max(1, Math.round(N * 0.7));
    for (let i = 0; i < N; i++) {
      const ind = tr.population[i];
      if (i === 0) {
        ind.genome = genome.slice();
        ind.kind = 'elite';
      } else if (i < mutants) {
        const g = genome.slice();
        mutate(g, tr.config.evo.mutationRate, tr.config.evo.mutationStrength, tr.rng);
        ind.genome = g;
        ind.kind = 'filho';
      }
    }
    tr.beginGeneration();
    return tr;
  }

  static fromSnapshot(s: TrainerSnapshot): Trainer {
    if (s.format !== 'evorace-trainer' || s.version !== 1) throw new Error('Formato de treino desconhecido.');
    return new Trainer(s.config, s.trackDefs, s);
  }

  get rules(): RunRules {
    return { maxTime: this.config.maxTime, stallTime: this.config.stallTime, stallDist: TRAINING_STALL_DIST };
  }

  brainOf(genome: Float64Array): Brain {
    return { inputs: this.config.inputs, hidden: this.config.hidden, genome };
  }

  /** Agenda uma mudança de configuração para o próximo limite de geração. */
  requestConfig(next: ExperimentConfig, trackDefs?: TrackDef[]): { ok: true; warnings: string[] } | { ok: false; error: string } {
    const s = sanitizeExperiment(next);
    if (!compatibleArch(this.config, s.config)) {
      return { ok: false, error: 'Sensores ou arquitetura mudaram: é preciso começar um experimento novo.' };
    }
    if (s.config.trackIds.join(',') !== this.config.trackIds.join(',') && !trackDefs) {
      return { ok: false, error: 'Pistas novas precisam ser informadas.' };
    }
    this.pending = s.config;
    this.pendingDefs = trackDefs ?? null;
    return { ok: true, warnings: s.warnings };
  }

  get hasPendingConfig(): boolean {
    return this.pending !== null;
  }

  private beginGeneration(): void {
    this.rngAtGenStart = this.rng.getState();
    this.deathsAtGenStart = {};
    for (const [k, v] of this.deaths) this.deathsAtGenStart[k] = v.slice();
    this.trainStepsAtGenStart = this.trainCarSteps;
    const N = this.population.length;
    this.scores = new Float64Array(N);
    this.progress = new Float64Array(N);
    this.completions = new Int32Array(N);
    this.lapTimes = new Float64Array(N).fill(NaN);
    this.reasons = new Array(N).fill('correndo');
    this.genCarSteps = 0;
    this.trackIdx = 0;
    this.genStart = this.config.startVariation
      ? { lateral: this.rng.range(-1.5, 1.5), heading: this.rng.range(-0.06, 0.06) }
      : STANDARD_START;
    this.startTrack();
  }

  private startTrack(): void {
    const brains = this.population.map((p) => this.brainOf(p.genome));
    this.sim = new RaceSim(this.tracks[this.trackIdx], brains, this.rules, this.genStart, false);
  }

  /** Avança até `maxSteps` passos de simulação. Para no fim da geração. */
  advance(maxSteps: number): StepOutcome {
    for (let i = 0; i < maxSteps; i++) {
      this.sim.stepAll();
      if (this.sim.done) {
        const stats = this.onTrackDone();
        if (stats) return { generationDone: stats };
      }
    }
    return { generationDone: null };
  }

  /** Roda até o fim da geração atual. */
  runGeneration(): GenStats {
    for (;;) {
      const r = this.advance(1 << 20);
      if (r.generationDone) return r.generationDone;
    }
  }

  private onTrackDone(): GenStats | null {
    const sim = this.sim;
    const track = this.tracks[this.trackIdx];
    this.genCarSteps += sim.carSteps;
    this.trainCarSteps += sim.carSteps;
    const deathList = this.deaths.get(track.def.id) ?? [];
    for (let i = 0; i < sim.cars.length; i++) {
      const car = sim.cars[i];
      this.scores[i] += trainingScore(sim.statsOf(i), this.config.rewards) / this.tracks.length;
      const prog = car.status === 'completou' ? 1 : Math.max(0, car.maxProgress / track.lapDistance);
      this.progress[i] += prog / this.tracks.length;
      if (car.status === 'completou') {
        this.completions[i]++;
        if (this.trackIdx === 0) this.lapTimes[i] = car.lapTime;
      }
      if (this.trackIdx === 0) this.reasons[i] = car.status;
      if (car.status === 'batida') deathList.push(Math.round(car.crashX * 10) / 10, Math.round(car.crashY * 10) / 10);
    }
    if (deathList.length > MAX_DEATH_POINTS * 2) deathList.splice(0, deathList.length - MAX_DEATH_POINTS * 2);
    this.deaths.set(track.def.id, deathList);
    this.trackIdx++;
    if (this.trackIdx < this.tracks.length) {
      this.startTrack();
      return null;
    }
    return this.finishGeneration();
  }

  private finishGeneration(): GenStats {
    const N = this.population.length;
    const order = rankOrder(this.scores);
    const best = order[0];
    const sorted = Array.from(this.scores).sort((a, b) => a - b);
    const attempts = N * this.tracks.length;
    let completions = 0;
    for (let i = 0; i < N; i++) completions += this.completions[i];
    let bestLap: number | null = null;
    for (let i = 0; i < N; i++) if (Number.isFinite(this.lapTimes[i]) && (bestLap === null || this.lapTimes[i] < bestLap)) bestLap = this.lapTimes[i];
    const deaths: Record<EndReason, number> = { correndo: 0, batida: 0, completou: 0, tempo: 0, parado: 0 };
    for (const r of this.reasons) deaths[r]++;

    this.lastResults = order.map((i) => ({
      id: this.population[i].id,
      kind: this.population[i].kind,
      score: this.scores[i],
      progress: this.progress[i],
      completed: this.completions[i],
      lapTime: Number.isFinite(this.lapTimes[i]) ? this.lapTimes[i] : null,
      reason: this.reasons[i],
    }));

    // Campeão por recompensa (cópia independente).
    let newScoreRecord = false;
    if (!this.bestEver || this.scores[best] > this.bestEver.score) {
      this.bestEver = {
        id: this.population[best].id,
        generation: this.generation,
        genome: this.population[best].genome.slice(),
        score: this.scores[best],
        official: null,
        replay: null,
      };
      newScoreRecord = true;
    }

    // Campeão oficial: avalia os melhores pelas regras fixas nas pistas de treino.
    let genOfficial: MultiResult | null = null;
    let newOfficialRecord = false;
    const seen = new Set<number>();
    // Candidatos: os melhores pela pontuação + o mais rápido que completou no treino.
    const candidates = order.slice(0, Math.min(OFFICIAL_CANDIDATES, N));
    let fastest = -1;
    for (let i = 0; i < N; i++) if (Number.isFinite(this.lapTimes[i]) && (fastest < 0 || this.lapTimes[i] < this.lapTimes[fastest])) fastest = i;
    if (fastest >= 0 && !candidates.includes(fastest)) candidates.push(fastest);
    for (let r = 0; r < candidates.length; r++) {
      const ind = this.population[candidates[r]];
      if (seen.has(ind.id)) continue;
      seen.add(ind.id);
      const { result, replay, steps } = this.officialEval(ind.genome);
      this.genCarSteps += steps;
      if (r === 0) this.lastGenBestReplay = replay;
      if (!genOfficial || compareMulti(result, genOfficial) < 0) genOfficial = result;
      if (!this.bestOfficial || !this.bestOfficial.official || compareMulti(result, this.bestOfficial.official) < 0) {
        this.bestOfficial = {
          id: ind.id,
          generation: this.generation,
          genome: ind.genome.slice(),
          score: this.scores[candidates[r]],
          official: result,
          replay,
        };
        newOfficialRecord = true;
      }
    }
    if (this.bestEver && this.bestEver.id === this.population[best].id && this.bestEver.generation === this.generation) {
      this.bestEver.replay = this.lastGenBestReplay;
    }

    this.carStepsTotal += this.genCarSteps;
    const stats: GenStats = {
      gen: this.generation,
      bestScore: this.scores[best],
      meanScore: sorted.reduce((a, b) => a + b, 0) / N,
      medianScore: sorted.length % 2 ? sorted[sorted.length >> 1] : (sorted[(sorted.length >> 1) - 1] + sorted[sorted.length >> 1]) / 2,
      bestProgress: Math.max(...Array.from(this.progress)),
      completionRate: completions / attempts,
      bestLapTime: bestLap,
      deaths,
      bestId: this.population[best].id,
      bestKind: this.population[best].kind,
      official: genOfficial
        ? { completionRate: genOfficial.completionRate, medianTime: genOfficial.medianTime, bestTime: genOfficial.bestTime, meanProgress: genOfficial.meanProgress }
        : null,
      newOfficialRecord,
      newScoreRecord,
      carSteps: this.genCarSteps,
      populationSize: N,
    };
    this.history.push(stats);
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);

    // Mudanças pedidas durante a geração entram agora, num limite claro.
    if (this.pending) {
      const changes = describeConfigChanges(this.config, this.pending);
      if (this.pendingDefs) {
        this.trackDefs = this.pendingDefs;
        this.tracks = this.pendingDefs.map((d) => buildTrack(d));
      }
      this.config = this.pending;
      this.pending = null;
      this.pendingDefs = null;
      if (changes.length) this.changes.push({ gen: this.generation + 1, changes });
    }

    // Próxima geração.
    const next = nextGeneration(
      this.population,
      this.scores,
      this.config.evo,
      this.config.inputs,
      this.config.hidden,
      layerSizes(this.config.inputs, this.config.hidden),
      this.rng,
      this.nextId,
    );
    this.population = next.population;
    this.nextId = next.nextId;
    this.generation++;
    this.beginGeneration();
    return stats;
  }

  /** Avaliação oficial (largada padrão, regras fixas) em todas as pistas de treino. */
  officialEval(genome: Float64Array): { result: MultiResult; replay: Replay | null; steps: number } {
    const brain = this.brainOf(genome);
    const attempts: AttemptResult[] = [];
    let replay: Replay | null = null;
    let steps = 0;
    this.tracks.forEach((track, ti) => {
      const out = evaluateBrain(brain, track, officialRules(track), [OFFICIAL_START], ti === 0);
      attempts.push(...out.result.attempts);
      steps += out.carSteps;
      if (ti === 0) replay = out.replays[0] ?? null;
    });
    return { result: summarize(attempts), replay, steps };
  }

  /** Estado completo para retomada exata (tirado no limite de geração). */
  snapshot(): TrainerSnapshot {
    // Estado do início da geração: a retomada recomeça esta geração do zero.
    const deaths: Record<string, number[]> = {};
    for (const [k, v] of Object.entries(this.deathsAtGenStart)) deaths[k] = v.slice();
    return {
      format: 'evorace-trainer',
      version: 1,
      config: cloneConfig(this.config),
      trackDefs: this.trackDefs,
      generation: this.generation,
      nextId: this.nextId,
      rng: [...this.rngAtGenStart] as RngState,
      population: this.population.map((p) => ({ ...p, genome: p.genome.slice(), parents: [...p.parents] })),
      history: this.history.slice(),
      changes: this.changes.slice(),
      bestEver: this.bestEver,
      bestOfficial: this.bestOfficial,
      lastGenBestReplay: this.lastGenBestReplay,
      carStepsTotal: this.carStepsTotal,
      trainCarSteps: this.trainStepsAtGenStart,
      deaths,
      pending: this.pending ? { config: cloneConfig(this.pending), trackDefs: this.pendingDefs } : null,
    };
  }

  /** Resultados da geração em andamento até agora (para a interface). */
  liveSummary(): { alive: number; total: number; bestProgress: number; completed: number; bestLap: number | null } {
    const sim = this.sim;
    let best = 0;
    let completed = 0;
    let bestLap: number | null = null;
    for (const c of sim.cars) {
      const p = c.status === 'completou' ? 1 : c.maxProgress / sim.track.lapDistance;
      if (p > best) best = p;
      if (c.status === 'completou') {
        completed++;
        if (bestLap === null || c.lapTime < bestLap) bestLap = c.lapTime;
      }
    }
    return { alive: sim.alive, total: sim.cars.length, bestProgress: Math.max(0, best), completed, bestLap };
  }
}
