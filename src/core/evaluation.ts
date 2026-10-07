import type { Brain } from './nn.ts';
import { PHYSICS } from './physics.ts';
import type { Replay } from './replay.ts';
import { REPLAY_EVERY } from './replay.ts';
import { RaceSim, type EndReason, type RunRules, type StartCondition } from './sim.ts';
import type { Track } from './track.ts';

/**
 * Avaliação oficial (fixa). Não depende das recompensas de treinamento.
 *
 * Uma tentativa:
 *   1. quem completa vence quem não completa;
 *   2. entre quem completa, menor tempo;
 *   3. entre quem falha, maior progresso válido;
 *   4. empate de progresso: menor tempo para atingi-lo.
 *
 * Várias tentativas:
 *   1. maior taxa de conclusão;
 *   2. menor mediana dos tempos válidos;
 *   3. maior progresso médio;
 *   4. menor melhor tempo;
 *   5. menor tempo médio até o progresso máximo.
 */

export interface AttemptResult {
  completed: boolean;
  /** Tempo da volta (completou) ou tempo até encerrar (s) */
  time: number;
  /** Progresso válido em fração da volta (0..1) */
  progress: number;
  /** Tempo em que atingiu o progresso máximo (s) */
  timeAtProgress: number;
  reason: EndReason;
  crash?: { x: number; y: number };
}

export interface MultiResult {
  attempts: AttemptResult[];
  completionRate: number;
  /** Mediana dos tempos de quem completou (null se ninguém completou) */
  medianTime: number | null;
  bestTime: number | null;
  meanProgress: number;
  meanTimeAtProgress: number;
}

export const SINGLE_CRITERIA = [
  'Quem completa a volta vence quem não completa.',
  'Entre quem completa: menor tempo.',
  'Entre quem não completa: maior progresso válido.',
  'Empate de progresso: menor tempo para atingi-lo.',
];

export const MULTI_CRITERIA = [
  'Maior taxa de conclusão.',
  'Menor mediana dos tempos válidos.',
  'Maior progresso médio.',
  'Menor melhor tempo.',
  'Menor tempo médio até o progresso máximo.',
];

const PROGRESS_EPS = 1e-6;
const TIME_EPS = 1e-9;

export function compareAttempts(a: AttemptResult, b: AttemptResult): number {
  if (a.completed !== b.completed) return a.completed ? -1 : 1;
  if (a.completed) {
    if (Math.abs(a.time - b.time) > TIME_EPS) return a.time - b.time;
    return 0;
  }
  if (Math.abs(a.progress - b.progress) > PROGRESS_EPS) return b.progress - a.progress;
  if (Math.abs(a.timeAtProgress - b.timeAtProgress) > TIME_EPS) return a.timeAtProgress - b.timeAtProgress;
  return 0;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function summarize(attempts: AttemptResult[]): MultiResult {
  const done = attempts.filter((a) => a.completed).map((a) => a.time);
  const n = Math.max(1, attempts.length);
  return {
    attempts,
    completionRate: done.length / n,
    medianTime: median(done),
    bestTime: done.length ? Math.min(...done) : null,
    meanProgress: attempts.reduce((s, a) => s + a.progress, 0) / n,
    meanTimeAtProgress: attempts.reduce((s, a) => s + a.timeAtProgress, 0) / n,
  };
}

export function compareMulti(a: MultiResult, b: MultiResult): number {
  if (Math.abs(a.completionRate - b.completionRate) > 1e-9) return b.completionRate - a.completionRate;
  if (a.medianTime !== null && b.medianTime !== null && Math.abs(a.medianTime - b.medianTime) > TIME_EPS) return a.medianTime - b.medianTime;
  if (Math.abs(a.meanProgress - b.meanProgress) > PROGRESS_EPS) return b.meanProgress - a.meanProgress;
  if (a.bestTime !== null && b.bestTime !== null && Math.abs(a.bestTime - b.bestTime) > TIME_EPS) return a.bestTime - b.bestTime;
  if (Math.abs(a.meanTimeAtProgress - b.meanTimeAtProgress) > TIME_EPS) return a.meanTimeAtProgress - b.meanTimeAtProgress;
  return 0;
}

export function attemptFromSim(sim: RaceSim, i: number): AttemptResult {
  const car = sim.cars[i];
  const completed = car.status === 'completou';
  const lap = sim.track.lapDistance;
  return {
    completed,
    time: completed ? car.lapTime : car.time,
    progress: completed ? 1 : Math.max(0, Math.min(1, car.maxProgress / lap)),
    timeAtProgress: car.timeAtMax,
    reason: car.status,
    crash: car.status === 'batida' ? { x: car.crashX, y: car.crashY } : undefined,
  };
}

export function replayFromSim(sim: RaceSim, i: number, extra: { pilotName?: string; color?: string } = {}): Replay | null {
  const car = sim.cars[i];
  if (!car.recorder) return null;
  const r = attemptFromSim(sim, i);
  return {
    meta: {
      trackId: sim.track.def.id,
      trackVersion: sim.track.def.version,
      trackHash: sim.track.hash,
      physicsVersion: PHYSICS.version,
      dt: PHYSICS.dt,
      frameDt: PHYSICS.dt * REPLAY_EVERY,
      pilotName: extra.pilotName,
      color: extra.color,
      completed: r.completed,
      time: r.time,
      progress: r.progress,
      reason: r.reason,
      crash: r.crash,
    },
    frames: car.recorder.finish(),
  };
}

export interface EvalOutput {
  result: MultiResult;
  replays: (Replay | null)[];
  carSteps: number;
}

/**
 * Executa um cérebro em várias largadas na mesma pista (todas em paralelo,
 * sem colisão entre carros) e resume pelos critérios oficiais.
 */
export function evaluateBrain(brain: Brain, track: Track, rules: RunRules, starts: StartCondition[], record = false, maxSteps = Infinity): EvalOutput {
  const sim = new RaceSim(
    track,
    starts.map(() => brain),
    rules,
    starts,
    record,
  );
  sim.runToEnd(maxSteps);
  const attempts = sim.cars.map((_, i) => attemptFromSim(sim, i));
  return {
    result: summarize(attempts),
    replays: record ? sim.cars.map((_, i) => replayFromSim(sim, i)) : [],
    carSteps: sim.carSteps,
  };
}

export function formatTime(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return '—';
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return m > 0 ? `${m}:${r.toFixed(3).padStart(6, '0')}` : `${r.toFixed(3)} s`;
}

export function formatPct(v: number): string {
  return `${Math.round(v * 100)}%`;
}
