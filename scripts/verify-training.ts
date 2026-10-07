/**
 * Treinamentos de verificação com sementes fixas.
 * Uso: node scripts/verify-training.ts [pista] [gerações] [sementes] [população]
 * Confirma melhoria real e conclusão do circuito (sem direção programada).
 */
import { getBuiltinTrack } from '../src/core/builtinTracks.ts';
import { defaultExperiment } from '../src/core/config.ts';
import { formatTime } from '../src/core/evaluation.ts';
import { REWARD_PRESETS } from '../src/core/rewards.ts';
import { Trainer } from '../src/core/trainer.ts';

const trackId = process.argv[2] ?? 'oval-largo';
const gens = Number(process.argv[3] ?? 40);
const seeds = (process.argv[4] ?? '1,2,3').split(',');
const pop = Number(process.argv[5] ?? 50);
const preset = process.argv[6];

const def = getBuiltinTrack(trackId);
if (!def) throw new Error('pista desconhecida');

let solved = 0;
for (const seed of seeds) {
  const cfg = defaultExperiment(trackId, `verificacao-${seed}`);
  cfg.evo.populationSize = pop;
  if (preset === 'velocidade' || preset === 'consistencia') cfg.rewards = { ...REWARD_PRESETS[preset].weights };
  const tr = new Trainer(cfg, [def]);
  const t0 = performance.now();
  let firstComplete = -1;
  let line = '';
  for (let g = 0; g < gens; g++) {
    const s = tr.runGeneration();
    if (firstComplete < 0 && s.completionRate > 0) firstComplete = s.gen;
    if (s.gen % 5 === 0 || s.gen === 1) {
      line += `\n  g${s.gen}: melhor=${s.bestScore.toFixed(1)} média=${s.meanScore.toFixed(1)} prog=${(s.bestProgress * 100).toFixed(0)}% concl=${(s.completionRate * 100).toFixed(0)}% volta=${formatTime(s.bestLapTime)} oficial=${s.official ? formatTime(s.official.bestTime) : '-'} mortes=${JSON.stringify(s.deaths)}`;
    }
  }
  const ms = performance.now() - t0;
  const bo = tr.bestOfficial?.official;
  if (bo && bo.completionRate > 0) solved++;
  console.log(
    `semente ${seed}: 1ª conclusão na geração ${firstComplete < 0 ? 'nunca' : firstComplete}; melhor oficial ${bo ? formatTime(bo.bestTime) : '-'}; ` +
      `${(tr.carStepsTotal / (ms / 1000) / 1000).toFixed(0)} mil passos-carro/s; ${(ms / 1000).toFixed(1)} s` +
      line,
  );
}
console.log(`\n${solved}/${seeds.length} sementes completaram a pista em ${gens} gerações.`);
