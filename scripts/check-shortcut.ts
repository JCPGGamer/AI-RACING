import { BUILTIN_TRACKS } from '../src/core/builtinTracks.ts';
import { defaultExperiment } from '../src/core/config.ts';
import { RaceSim } from '../src/core/sim.ts';
import { Trainer } from '../src/core/trainer.ts';

let mismatches = 0;
for (const def of BUILTIN_TRACKS) {
  for (const seed of ['a', 'b']) {
    const runs: string[] = [];
    for (const always of [false, true]) {
      RaceSim.alwaysTestCollision = always;
      const cfg = defaultExperiment(def.id, `atalho-${seed}`);
      cfg.startVariation = true;
      const tr = new Trainer(cfg, [def]);
      for (let g = 0; g < 12; g++) tr.runGeneration();
      runs.push(JSON.stringify(tr.history.map((h) => [h.bestScore, h.meanScore, h.deaths])) + Array.from(tr.population[5].genome.slice(0, 5)).join(','));
    }
    const ok = runs[0] === runs[1];
    if (!ok) mismatches++;
    console.log(def.id, seed, ok ? 'idêntico' : 'DIFERENTE');
  }
}
RaceSim.alwaysTestCollision = false;
process.exit(mismatches ? 1 : 0);
