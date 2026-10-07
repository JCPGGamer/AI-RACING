import { describe, expect, it } from 'vitest';
import { BUILTIN_TRACKS, getBuiltinTrack } from '../src/core/builtinTracks.ts';
import { Coach, defaultCoachConfig } from '../src/core/coach.ts';
import { defaultExperiment } from '../src/core/config.ts';
import { compareAttempts, compareMulti, summarize, type AttemptResult } from '../src/core/evaluation.ts';
import { crossover, DEFAULT_EVO, mutate, nextGeneration, randomPopulation, type Individual } from '../src/core/evolution.ts';
import { exportJson, parseImport } from '../src/core/io.ts';
import { base64ToGenome, genomeToBase64, layerSizes, NetRunner, paramCount, randomGenome } from '../src/core/nn.ts';
import { scoreTerms, trainingScore, type AttemptStats } from '../src/core/rewards.ts';
import { Rng } from '../src/core/rng.ts';
import { DEFAULT_INPUTS, inputCount } from '../src/core/sensors.ts';
import { Trainer } from '../src/core/trainer.ts';

const oval = getBuiltinTrack('oval-largo')!;

describe('redes neurais', () => {
  it('dimensões, parâmetros e faixas de saída', () => {
    const hidden = [16, 16];
    expect(inputCount(DEFAULT_INPUTS)).toBe(13);
    expect(paramCount(DEFAULT_INPUTS, hidden)).toBe(13 * 16 + 16 + 16 * 16 + 16 + 16 * 3 + 3);
    const rng = new Rng(1);
    const g = randomGenome(DEFAULT_INPUTS, hidden, rng);
    const net = new NetRunner(DEFAULT_INPUTS, hidden);
    const input = new Float64Array(13);
    const out = new Float64Array(3);
    for (let k = 0; k < 200; k++) {
      for (let i = 0; i < 13; i++) input[i] = rng.range(-1, 1);
      net.run(g, input, out);
      expect(out[0]).toBeGreaterThanOrEqual(-1);
      expect(out[0]).toBeLessThanOrEqual(1);
      expect(out[1]).toBeGreaterThanOrEqual(0);
      expect(out[1]).toBeLessThanOrEqual(1);
      expect(out[2]).toBeGreaterThanOrEqual(0);
      expect(out[2]).toBeLessThanOrEqual(1);
    }
  });

  it('inicialização não satura as camadas (desvio ≈ 1/√entradas)', () => {
    const g = randomGenome(DEFAULT_INPUTS, [64], new Rng(2));
    const w = Array.from(g.slice(0, 13 * 64));
    const std = Math.sqrt(w.reduce((s, x) => s + x * x, 0) / w.length);
    expect(std).toBeGreaterThan(0.8 / Math.sqrt(13));
    expect(std).toBeLessThan(1.2 / Math.sqrt(13));
  });

  it('genoma ida e volta em base64 é exato', () => {
    const g = randomGenome(DEFAULT_INPUTS, [16, 16], new Rng(3));
    const back = base64ToGenome(genomeToBase64(g));
    expect(Array.from(back)).toEqual(Array.from(g));
  });
});

describe('evolução', () => {
  const hidden = [8];
  const sizes = layerSizes(DEFAULT_INPUTS, hidden);

  it('mutação separa probabilidade e intensidade', () => {
    const rng = new Rng(4);
    const base = new Float64Array(20000);
    const g = base.slice();
    const changed = mutate(g, 0.1, 0.5, rng);
    expect(changed / g.length).toBeGreaterThan(0.09);
    expect(changed / g.length).toBeLessThan(0.11);
    const deltas = Array.from(g).filter((v) => v !== 0);
    const std = Math.sqrt(deltas.reduce((s, x) => s + x * x, 0) / deltas.length);
    expect(std).toBeGreaterThan(0.45);
    expect(std).toBeLessThan(0.55);
  });

  it('cruzamento só entre arquiteturas compatíveis e por neurônio inteiro', () => {
    const rng = new Rng(5);
    const a = randomGenome(DEFAULT_INPUTS, hidden, rng);
    const b = randomGenome(DEFAULT_INPUTS, hidden, rng);
    const c = crossover(a, b, sizes, rng);
    // cada neurônio da primeira camada vem inteiro de um pai
    const nIn = sizes[0];
    for (let j = 0; j < sizes[1]; j++) {
      const row = Array.from(c.slice(j * nIn, (j + 1) * nIn));
      const fromA = row.every((v, i) => v === a[j * nIn + i]);
      const fromB = row.every((v, i) => v === b[j * nIn + i]);
      expect(fromA || fromB).toBe(true);
    }
    expect(() => crossover(a, randomGenome(DEFAULT_INPUTS, [9], rng), sizes, rng)).toThrow();
  });

  it('elite é copiada sem mutação e de forma independente', () => {
    const rng = new Rng(6);
    const pop = randomPopulation(20, DEFAULT_INPUTS, hidden, rng);
    const fitness = pop.map((_, i) => -i * 3); // pontuações negativas funcionam
    const cfg = { ...DEFAULT_EVO, populationSize: 20, eliteCount: 3, mutationRate: 1, mutationStrength: 1, freshFraction: 0.1 };
    const next = nextGeneration(pop, fitness, cfg, DEFAULT_INPUTS, hidden, sizes, rng, 100);
    expect(next.population.length).toBe(20);
    for (let e = 0; e < 3; e++) {
      expect(next.population[e].kind).toBe('elite');
      expect(Array.from(next.population[e].genome)).toEqual(Array.from(pop[e].genome));
      expect(next.population[e].genome).not.toBe(pop[e].genome);
    }
    expect(next.population.filter((p: Individual) => p.kind === 'novo').length).toBe(2);
    // filhos vêm dos melhores 20% (índices 0..3)
    for (const ch of next.population.filter((p) => p.kind === 'filho')) expect(ch.parents[0]).toBeLessThanOrEqual(4);
  });
});

describe('recompensas', () => {
  const stats = (lap: number): AttemptStats => ({
    maxProgress: lap * 0.5,
    lapDistance: lap,
    checkpoints: 10,
    checkpointTotal: 20,
    completed: false,
    crashed: true,
    stalled: false,
    time: lap / 40,
    maxTime: 90,
    backDistance: lap * 0.1,
    steerVariation: 5,
    refTime: lap / 40,
  });
  it('normaliza pelo tamanho da pista', () => {
    const w = { progress: 100, checkpoint: 20, completion: 50, time: 0, collision: 10, stall: 10, backward: 50, oscillation: 0 };
    expect(trainingScore(stats(800), w)).toBeCloseTo(trainingScore(stats(1600), w) + 0, 0); // diferença só da oscilação absoluta
    const t800 = scoreTerms(stats(800), w);
    const t1600 = scoreTerms(stats(1600), w);
    expect(t800.find((t) => t.key === 'progress')!.value).toBeCloseTo(t1600.find((t) => t.key === 'progress')!.value);
    expect(t800.find((t) => t.key === 'backward')!.value).toBeCloseTo(t1600.find((t) => t.key === 'backward')!.value);
  });
  it('recompensas influenciam a seleção', () => {
    const a = { ...stats(1000), crashed: false, stalled: true, maxProgress: 10 };
    const b = { ...stats(1000), crashed: true, maxProgress: 60 };
    const brave = { progress: 100, checkpoint: 0, completion: 0, time: 0, collision: 5, stall: 5, backward: 0, oscillation: 0 };
    const cautious = { ...brave, collision: 200 };
    expect(trainingScore(b, brave)).toBeGreaterThan(trainingScore(a, brave));
    expect(trainingScore(b, cautious)).toBeLessThan(trainingScore(a, cautious));
  });
});

describe('avaliação oficial', () => {
  const r = (completed: boolean, time: number, progress: number, tap = time): AttemptResult => ({ completed, time, progress, timeAtProgress: tap, reason: completed ? 'completou' : 'batida' });
  it('ordena uma tentativa pelos critérios fixos', () => {
    expect(compareAttempts(r(true, 40, 1), r(false, 10, 0.99))).toBeLessThan(0);
    expect(compareAttempts(r(true, 30, 1), r(true, 31, 1))).toBeLessThan(0);
    expect(compareAttempts(r(false, 20, 0.6), r(false, 10, 0.5))).toBeLessThan(0);
    expect(compareAttempts(r(false, 20, 0.5, 9), r(false, 10, 0.5, 10))).toBeLessThan(0);
  });
  it('ordena várias tentativas: conclusão, mediana, progresso', () => {
    const consistent = summarize([r(true, 40, 1), r(true, 41, 1), r(true, 42, 1)]);
    const fastButFlaky = summarize([r(true, 30, 1), r(false, 5, 0.1), r(true, 31, 1)]);
    expect(compareMulti(consistent, fastButFlaky)).toBeLessThan(0);
    const fast = summarize([r(true, 30, 1), r(true, 35, 1), r(true, 50, 1)]);
    expect(compareMulti(fast, consistent)).toBeLessThan(0);
  });
});

describe('treinador', () => {
  it('é reproduzível pela semente', () => {
    const cfg = { ...defaultExperiment('oval-largo', 'repro'), evo: { ...DEFAULT_EVO, populationSize: 20 } };
    const a = new Trainer(cfg, [oval]);
    const b = new Trainer(cfg, [oval]);
    for (let i = 0; i < 3; i++) {
      const sa = a.runGeneration();
      const sb = b.runGeneration();
      expect(sa.bestScore).toBe(sb.bestScore);
      expect(sa.meanScore).toBe(sb.meanScore);
    }
    expect(Array.from(a.population[7].genome)).toEqual(Array.from(b.population[7].genome));
    const c = new Trainer({ ...cfg, seed: 'outra' }, [oval]);
    c.runGeneration();
    expect(c.history[0].meanScore).not.toBe(a.history[0].meanScore);
  });

  it('o resultado não depende da velocidade de reprodução', () => {
    const cfg = { ...defaultExperiment('oval-largo', 'velocidade'), evo: { ...DEFAULT_EVO, populationSize: 20 } };
    const slow = new Trainer(cfg, [oval]);
    const fast = new Trainer(cfg, [oval]);
    let gensSlow = 0;
    while (gensSlow < 2) if (slow.advance(1).generationDone) gensSlow++;
    let gensFast = 0;
    while (gensFast < 2) if (fast.advance(5000).generationDone) gensFast++;
    expect(slow.history.map((h) => h.bestScore)).toEqual(fast.history.map((h) => h.bestScore));
    expect(Array.from(slow.population[3].genome)).toEqual(Array.from(fast.population[3].genome));
  });

  it('salva e retoma exatamente (inclusive via arquivo JSON)', () => {
    const cfg = { ...defaultExperiment('oval-largo', 'retomar'), evo: { ...DEFAULT_EVO, populationSize: 20 }, startVariation: true };
    const full = new Trainer(cfg, [oval]);
    for (let i = 0; i < 5; i++) full.runGeneration();

    const part = new Trainer(cfg, [oval]);
    for (let i = 0; i < 3; i++) part.runGeneration();
    part.advance(100); // meio de geração: a retomada recomeça a geração atual
    const json = exportJson('projeto', { name: 'teste', snapshot: part.snapshot() });
    const imported = parseImport(json);
    expect(imported.tipo).toBe('projeto');
    if (imported.tipo !== 'projeto') return;
    const resumed = Trainer.fromSnapshot(imported.data.snapshot!);
    for (let i = 0; i < 2; i++) resumed.runGeneration();
    expect(resumed.history.map((h) => h.bestScore)).toEqual(full.history.map((h) => h.bestScore));
    expect(Array.from(resumed.population[0].genome)).toEqual(Array.from(full.population[0].genome));
  });

  it('preserva o melhor piloto histórico e separa os campeões', () => {
    const cfg = { ...defaultExperiment('oval-largo', 'campeoes'), evo: { ...DEFAULT_EVO, populationSize: 20 } };
    const tr = new Trainer(cfg, [oval]);
    let bestSoFar = -Infinity;
    for (let i = 0; i < 6; i++) {
      const s = tr.runGeneration();
      bestSoFar = Math.max(bestSoFar, s.bestScore);
      expect(tr.bestEver!.score).toBe(bestSoFar);
    }
    const copy = tr.bestEver!.genome;
    expect(tr.population.some((p) => p.genome === copy)).toBe(false);
    expect(tr.bestOfficial?.official).toBeTruthy();
  });

  it('mudança incompatível de arquitetura é recusada; compatível entra no limite da geração', () => {
    const cfg = { ...defaultExperiment('oval-largo', 'mudancas'), evo: { ...DEFAULT_EVO, populationSize: 20 } };
    const tr = new Trainer(cfg, [oval]);
    expect(tr.requestConfig({ ...cfg, hidden: [8] }).ok).toBe(false);
    expect(tr.requestConfig({ ...cfg, evo: { ...cfg.evo, populationSize: 50 } }).ok).toBe(true);
    tr.advance(10);
    expect(tr.population.length).toBe(20);
    tr.runGeneration();
    expect(tr.population.length).toBe(50);
    expect(tr.changes[0].changes[0]).toContain('População');
  });

  it('aprende de verdade: completa o oval com sementes fixas', () => {
    let solved = 0;
    for (const seed of ['v1', 'v2', 'v3']) {
      const tr = new Trainer({ ...defaultExperiment('oval-largo', seed) }, [oval]);
      const first = tr.runGeneration();
      for (let i = 0; i < 24; i++) tr.runGeneration();
      const last = tr.history[tr.history.length - 1];
      expect(last.bestProgress).toBeGreaterThanOrEqual(first.bestProgress);
      if (tr.bestOfficial?.official && tr.bestOfficial.official.completionRate === 1) solved++;
    }
    expect(solved).toBeGreaterThanOrEqual(2);
  });
});

describe('treinadora', () => {
  it('respeita o orçamento, compara de forma justa e faz o teste final uma vez', () => {
    const cfg = defaultCoachConfig(defaultExperiment('oval-largo', 'coach-test'));
    cfg.maxExperiments = 3;
    cfg.totalBudget = 2_400_000;
    cfg.valTracks = ['oval-largo'];
    cfg.testTracks = ['curvas-s'];
    cfg.space.population.options = [20, 50];
    const coach = new Coach(cfg, BUILTIN_TRACKS);
    let guard = 0;
    while (coach.advance(100_000) && guard++ < 10_000) {
      /* roda */
    }
    expect(coach.finished).toBe(true);
    expect(coach.candidates.length).toBe(3);
    const per = coach.budgetPerRun();
    for (const c of coach.candidates) {
      for (const r of c.runs) {
        // mesmo orçamento de treino para todos, independente da população
        expect(r.carSteps).toBeGreaterThanOrEqual(per);
        expect(r.carSteps).toBeLessThanOrEqual(per + 8 * c.params.population);
      }
      // validação só usa as pistas de validação
      expect(c.byTrack.map((b) => b.trackId)).toEqual(['oval-largo']);
    }
    expect(coach.finalTest).not.toBeNull();
    expect(coach.finalTest!.byTrack.map((b) => b.trackId)).toEqual(['curvas-s']);
    const msgs = coach.messages.filter((m) => m.text.startsWith('Teste final'));
    expect(msgs.length).toBe(1);
    // retomar uma treinadora concluída não repete o teste
    const again = Coach.fromSnapshot(coach.snapshot());
    expect(again.advance(1000)).toBe(false);
    expect(again.messages.filter((m) => m.text.startsWith('Teste final')).length).toBe(1);
  });
});
