/**
 * Medição de desempenho da simulação (sem interface).
 * Uso: node scripts/bench.ts [pista] [segundos por medição]
 *
 * Mede passos-carro por segundo treinando de verdade com populações de
 * 20, 50, 100 e 200 carros, e compara a grade espacial com força bruta.
 */
import { getBuiltinTrack } from '../src/core/builtinTracks.ts';
import { defaultExperiment } from '../src/core/config.ts';
import { Trainer } from '../src/core/trainer.ts';

const trackId = process.argv[2] ?? 'curvas-s';
const seconds = Number(process.argv[3] ?? 3);
const def = getBuiltinTrack(trackId)!;

function measure(pop: number, brute: boolean): { carSteps: number; steps: number; gens: number } {
  const cfg = defaultExperiment(trackId, 'bench');
  cfg.evo = { ...cfg.evo, populationSize: pop };
  const tr = new Trainer(cfg, [def]);
  tr.tracks.forEach((t) => (t.grid.bruteForce = brute));
  // aquecimento (JIT)
  tr.advance(200);
  const w0 = tr.workSoFar;
  const g0 = tr.generation;
  let steps = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < seconds * 1000) {
    tr.advance(50);
    steps += 50;
  }
  const dt = (performance.now() - t0) / 1000;
  tr.tracks.forEach((t) => (t.grid.bruteForce = false));
  return { carSteps: (tr.workSoFar - w0) / dt, steps: steps / dt, gens: tr.generation - g0 };
}

console.log(`Pista ${def.name}, ${seconds} s por medição, Node ${process.version}`);
console.log('pop  | modo        | passos-carro/s | passos/s | ×tempo real | gerações');
for (const pop of [20, 50, 100, 200]) {
  for (const brute of [false, true]) {
    if (brute && pop > 50) continue;
    const r = measure(pop, brute);
    console.log(
      `${String(pop).padStart(4)} | ${(brute ? 'força bruta' : 'grade').padEnd(11)} | ${Math.round(r.carSteps).toLocaleString('pt-BR').padStart(14)} | ${Math.round(r.steps)
        .toLocaleString('pt-BR')
        .padStart(8)} | ${(r.steps / 60).toFixed(0).padStart(11)} | ${r.gens}`,
    );
  }
}
