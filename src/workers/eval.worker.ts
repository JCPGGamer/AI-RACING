import { runChampionship } from '../core/championship.ts';
import { evaluateBrain } from '../core/evaluation.ts';
import { officialTrack, runOfficial } from '../core/official.ts';
import { CONSISTENCY_STARTS, officialRules } from '../core/rules.ts';
import { buildTrack } from '../core/track.ts';
import { getBuiltinTrack } from '../core/builtinTracks.ts';
import { defaultExperiment } from '../core/config.ts';
import { Trainer } from '../core/trainer.ts';
import type { EvalIn, EvalOut } from './protocol.ts';

/** Worker de avaliações: comparações, testes em outras pistas, campeonatos e conferência oficial. */

const ctx = self as unknown as { postMessage(m: EvalOut): void; onmessage: ((e: MessageEvent<EvalIn>) => void) | null };
const cancelled = new Set<number>();

ctx.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'cancel') {
    cancelled.add(m.id);
    return;
  }
  try {
    if (m.type === 'evaluate') {
      const results = [];
      let done = 0;
      for (const def of m.trackDefs) {
        if (cancelled.has(m.id)) throw new Error('cancelado');
        ctx.postMessage({ type: 'progress', id: m.id, done, total: m.trackDefs.length, label: def.name });
        const track = buildTrack(def);
        const out = evaluateBrain(m.brain, track, officialRules(track), CONSISTENCY_STARTS.slice(0, Math.max(1, Math.min(5, m.attempts))), true);
        const rep = out.replays[0] ?? null;
        if (rep) {
          rep.meta.pilotName = m.pilotName;
          rep.meta.color = m.color;
        }
        results.push({ trackId: def.id, trackName: def.name, result: out.result, replay: rep });
        done++;
      }
      ctx.postMessage({ type: 'evaluated', id: m.id, results });
    } else if (m.type === 'official') {
      const t = officialTrack(m.trackId);
      if (!t) {
        ctx.postMessage({ type: 'official', id: m.id, run: null, error: 'Pista fora do ranking oficial.' });
        return;
      }
      ctx.postMessage({ type: 'official', id: m.id, run: runOfficial(m.brain, t, m.pilotName) });
    } else if (m.type === 'benchmark') {
      // Mede passos de simulação por segundo neste aparelho (treino real, população dada).
      const cfg = defaultExperiment('curvas-s', 'medicao');
      cfg.evo = { ...cfg.evo, populationSize: m.population };
      const tr = new Trainer(cfg, [getBuiltinTrack('curvas-s')!]);
      tr.advance(30); // aquecimento
      const start = tr.workSoFar;
      let steps = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < m.ms) {
        tr.advance(10);
        steps += 10;
      }
      const sec = (performance.now() - t0) / 1000;
      ctx.postMessage({ type: 'benchmark', id: m.id, carStepsPerSec: (tr.workSoFar - start) / sec, stepsPerSec: steps / sec });
    } else if (m.type === 'championship') {
      const result = runChampionship(
        m.entries,
        m.trackDefs,
        m.config,
        (done, total, label) => ctx.postMessage({ type: 'progress', id: m.id, done, total, label }),
        () => cancelled.has(m.id),
      );
      ctx.postMessage({ type: 'championship', id: m.id, result });
    }
  } catch (err) {
    ctx.postMessage({ type: 'error', id: m.id, message: (err as Error).message });
  } finally {
    cancelled.delete(m.id);
  }
};
