import { BUILTIN_TRACKS } from '../src/core/builtinTracks.ts';
import { Coach, defaultCoachConfig } from '../src/core/coach.ts';
import { defaultExperiment } from '../src/core/config.ts';

const base = defaultExperiment('oval-largo', 'coach');
const cfg = defaultCoachConfig(base);
cfg.maxExperiments = Number(process.argv[2] ?? 5);
cfg.totalBudget = Number(process.argv[3] ?? 8_000_000);
cfg.valTracks = ['oval-largo', 'curvas-s'];
cfg.testTracks = ['circuito-misto'];
const coach = new Coach(cfg, BUILTIN_TRACKS);
const t0 = performance.now();
let printed = 0;
while (coach.advance(200_000)) {
  while (printed < coach.messages.length) console.log(`[${coach.messages[printed].kind}] ${coach.messages[printed++].text}`);
}
while (printed < coach.messages.length) console.log(`[${coach.messages[printed].kind}] ${coach.messages[printed++].text}`);
console.log('orçamento usado', coach.budgetUsed, 'validação', coach.valStepsUsed, 'tempo', ((performance.now() - t0) / 1000).toFixed(1), 's');
const snap = coach.snapshot();
console.log('snapshot bytes ~', JSON.stringify(snap, (k, v) => (v instanceof Float64Array || v instanceof Float32Array ? v.length : v)).length);
