import type { ChampionshipConfig, ChampionshipEntry, ChampionshipResult } from '../core/championship.ts';
import type { Brain } from '../core/nn.ts';
import type { OfficialRun } from '../core/official.ts';
import type { TrackDef } from '../core/track.ts';
import type { EvalIn, EvalOut, EvalTrackResult } from '../workers/protocol.ts';

/** Cliente do worker de avaliação (uma fila de pedidos com identificador). */

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (done: number, total: number, label: string) => void;
};

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../workers/eval.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<EvalOut>) => {
    const m = e.data;
    const p = pending.get(m.id);
    if (!p) return;
    if (m.type === 'progress') {
      p.onProgress?.(m.done, m.total, m.label);
      return;
    }
    pending.delete(m.id);
    if (m.type === 'error') p.reject(new Error(m.message));
    else if (m.type === 'evaluated') p.resolve(m.results);
    else if (m.type === 'official') (m.run ? p.resolve(m.run) : p.reject(new Error(m.error ?? 'Falha na avaliação oficial.')));
    else if (m.type === 'championship') p.resolve(m.result);
    else if (m.type === 'benchmark') p.resolve({ carStepsPerSec: m.carStepsPerSec, stepsPerSec: m.stepsPerSec });
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'Erro no worker de avaliação.'));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

function request<T>(msg: EvalIn, onProgress?: Pending['onProgress']): { id: number; promise: Promise<T> } {
  const w = getWorker();
  const id = msg.id;
  const promise = new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
  });
  w.postMessage(msg);
  return { id, promise };
}

export function cancelEval(id: number): void {
  worker?.postMessage({ type: 'cancel', id } satisfies EvalIn);
}

export function evaluateOnTracks(brain: Brain, trackDefs: TrackDef[], attempts: number, extra: { pilotName?: string; color?: string; onProgress?: Pending['onProgress'] } = {}) {
  return request<EvalTrackResult[]>({ type: 'evaluate', id: nextId++, brain, trackDefs, attempts, pilotName: extra.pilotName, color: extra.color }, extra.onProgress);
}

export function officialCheck(brain: Brain, trackId: string, pilotName?: string) {
  return request<OfficialRun>({ type: 'official', id: nextId++, brain, trackId, pilotName });
}

export function championship(entries: ChampionshipEntry[], trackDefs: TrackDef[], config: ChampionshipConfig, onProgress?: Pending['onProgress']) {
  return request<ChampionshipResult>({ type: 'championship', id: nextId++, entries, trackDefs, config }, onProgress);
}

export function benchmark(population: number, ms = 1500) {
  return request<{ carStepsPerSec: number; stepsPerSec: number }>({ type: 'benchmark', id: nextId++, population, ms });
}
