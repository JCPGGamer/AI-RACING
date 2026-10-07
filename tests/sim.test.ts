import { describe, expect, it } from 'vitest';
import { BUILTIN_TRACKS } from '../src/core/builtinTracks.ts';
import { dcos, dexp, dlog, dsin, dtanh, datan2 } from '../src/core/dmath.ts';
import { buildGrid, raycast } from '../src/core/geometry.ts';
import { carCorners, PHYSICS } from '../src/core/physics.ts';
import { Rng } from '../src/core/rng.ts';
import { RaceSim, type RunRules } from '../src/core/sim.ts';
import { buildTrack, START_OFFSET } from '../src/core/track.ts';
import { hasErrors, validateTrackDef } from '../src/core/trackValidation.ts';
import { followCenter, kinematic, randomBrain, track } from './helpers.ts';

const RULES: RunRules = { maxTime: 120, stallTime: 4, stallDist: 5 };

describe('matemática determinística', () => {
  it('aproxima as funções nativas', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 2000; i++) {
      const x = rng.range(-50, 50);
      expect(Math.abs(dsin(x) - Math.sin(x))).toBeLessThan(1e-13);
      expect(Math.abs(dcos(x) - Math.cos(x))).toBeLessThan(1e-13);
      const t = rng.range(-20, 20);
      expect(Math.abs(dtanh(t) - Math.tanh(t))).toBeLessThan(1e-14);
      const e = rng.range(-30, 30);
      expect(Math.abs(dexp(e) - Math.exp(e)) / Math.exp(e)).toBeLessThan(1e-14);
      const l = rng.range(1e-6, 1e6);
      expect(Math.abs(dlog(l) - Math.log(l))).toBeLessThan(1e-12);
      const y = rng.range(-5, 5);
      expect(Math.abs(datan2(y, x) - Math.atan2(y, x))).toBeLessThan(1e-12);
    }
  });
});

describe('pistas', () => {
  it('as cinco pistas iniciais são válidas e têm dificuldade crescente', () => {
    expect(BUILTIN_TRACKS.length).toBeGreaterThanOrEqual(5);
    BUILTIN_TRACKS.forEach((def, i) => {
      expect(hasErrors(validateTrackDef(def)), def.id).toBe(false);
      expect(def.difficulty).toBe(i + 1);
      const t = buildTrack(def);
      expect(t.checkpoints.length).toBeGreaterThanOrEqual(8);
      expect(t.hash).toMatch(/^[0-9a-f]{8}$/);
    });
  });

  it('o editor detecta pistas que se cruzam', () => {
    const def = {
      id: 'x',
      name: 'Oito',
      version: 1,
      smooth: true,
      startIndex: 0,
      reverse: false,
      points: [
        { x: 0, y: 0, w: 12 },
        { x: 200, y: 200, w: 12 },
        { x: 400, y: 0, w: 12 },
        { x: 400, y: 200, w: 12 },
        { x: 200, y: 0, w: 12 },
        { x: 0, y: 200, w: 12 },
      ],
    };
    const issues = validateTrackDef(def);
    expect(issues.some((i) => i.code === 'cruzamento' || i.code === 'trechos-proximos')).toBe(true);
  });
});

describe('raycast', () => {
  it('mede a distância exata até um segmento', () => {
    const segs = new Float64Array([10, -5, 10, 5, -3, -100, -3, 100]);
    const g = buildGrid(segs, 2, 4);
    expect(raycast(g, 0, 0, 1, 0, 100)).toBeCloseTo(10, 12);
    expect(raycast(g, 0, 0, -1, 0, 100)).toBeCloseTo(3, 12);
    expect(raycast(g, 0, 0, 0, 1, 50)).toBe(50);
  });

  it('grade espacial e força bruta dão o mesmo resultado', () => {
    const t = track('circuito-misto');
    const rng = new Rng(3);
    for (let i = 0; i < 500; i++) {
      const k = rng.int(t.n);
      const x = t.cx[k] + t.nx[k] * rng.range(-t.hw[k] * 0.8, t.hw[k] * 0.8);
      const y = t.cy[k] + t.ny[k] * rng.range(-t.hw[k] * 0.8, t.hw[k] * 0.8);
      const a = rng.range(-Math.PI, Math.PI);
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      t.grid.bruteForce = false;
      const d1 = raycast(t.grid, x, y, dx, dy, 120);
      t.grid.bruteForce = true;
      const d2 = raycast(t.grid, x, y, dx, dy, 120);
      t.grid.bruteForce = false;
      expect(d1).toBeCloseTo(d2, 9);
    }
  });

  it('na reta, o sensor lateral mede meia largura', () => {
    const t = track('oval-largo');
    const sim = new RaceSim(t, [randomBrain()], RULES);
    const car = sim.cars[0];
    // 9 sensores: índices 0 e 8 são −90° e +90°
    expect(car.rays[0]).toBeCloseTo(9, 1);
    expect(car.rays[8]).toBeCloseTo(9, 1);
  });
});

describe('colisões', () => {
  it('considera o corpo inteiro, não só o centro', () => {
    const t = track('oval-largo');
    // centro 0,5 m dentro da borda: o centro está na pista, mas a lateral do carro não.
    const lateral = t.hw[t.start.sample] - 0.5;
    const sim = new RaceSim(t, [randomBrain()], RULES, { lateral, heading: 0 });
    sim.stepAll();
    expect(sim.cars[0].status).toBe('batida');
    expect(Number.isFinite(sim.cars[0].crashX)).toBe(true);
  });

  it('carro com folga lateral não bate', () => {
    const t = track('oval-largo');
    const lateral = t.hw[t.start.sample] - PHYSICS.carWidth / 2 - 0.3;
    const sim = new RaceSim(t, [randomBrain()], RULES, { lateral, heading: 0 });
    sim.cars[0].controller = (_c, out) => {
      out[0] = 0;
      out[1] = 0;
      out[2] = 1;
    };
    for (let i = 0; i < 30; i++) sim.stepAll();
    expect(sim.cars[0].status).toBe('correndo');
  });

  it('não atravessa a borda em velocidade muito alta', () => {
    const t = track('oval-largo');
    const sim = new RaceSim(t, [randomBrain()], RULES, { lateral: 0, heading: Math.PI / 2 });
    const car = sim.cars[0];
    car.controller = (c, out) => {
      c.phys.speed = 400; // 6,7 m por passo, maior que o próprio carro
      out[0] = 0;
      out[1] = 1;
      out[2] = 0;
    };
    for (let i = 0; i < 20 && car.alive; i++) sim.stepAll();
    expect(car.status).toBe('batida');
    // o ponto da batida está sobre a borda (meia largura do centro)
    const dx = car.crashX - t.start.x;
    const dy = car.crashY - t.start.y;
    expect(Math.sqrt(dx * dx + dy * dy)).toBeLessThan(t.hw[t.start.sample] + 0.2);
  });

  it('cantos do corpo usam as mesmas dimensões do desenho', () => {
    const c = new Float64Array(8);
    carCorners(0, 0, 0, c);
    expect(c[0]).toBeCloseTo(PHYSICS.carLength / 2);
    expect(Math.abs(c[1])).toBeCloseTo(PHYSICS.carWidth / 2);
  });
});

describe('progresso e checkpoints', () => {
  it('completa a volta passando todos os checkpoints em ordem', () => {
    const t = track('oval-largo');
    const sim = new RaceSim(t, [randomBrain()], RULES);
    const car = sim.cars[0];
    car.controller = followCenter(22);
    sim.runToEnd(20000);
    expect(car.status).toBe('completou');
    expect(car.cpPassed).toBe(t.checkpoints.length);
    expect(car.maxProgress).toBeCloseTo(t.lapDistance, 6);
    // tempo coerente com ~22 m/s (com arrancada)
    expect(car.lapTime).toBeGreaterThan(t.lapDistance / 22);
    expect(car.lapTime).toBeLessThan(t.lapDistance / 22 + 6);
  });

  it('segue trechos vizinhos sem confundir (grampos)', () => {
    const t = track('retas-grampos');
    const sim = new RaceSim(t, [randomBrain()], { maxTime: 300, stallTime: 10, stallDist: 5 });
    const car = sim.cars[0];
    car.controller = followCenter(11, 7);
    let maxJump = 0;
    let prev = car.progress;
    while (car.alive) {
      sim.stepAll();
      maxJump = Math.max(maxJump, Math.abs(car.progress - prev));
      prev = car.progress;
    }
    expect(car.status).toBe('completou');
    expect(maxJump).toBeLessThan(1);
  });

  it('não ganha progresso indo e voltando', () => {
    const t = track('oval-largo');
    const sim = new RaceSim(t, [randomBrain()], RULES);
    const car = sim.cars[0];
    // 1,5 s para frente, 1,5 s para trás, de novo 1,5 s para frente (≈ mesma faixa)
    car.controller = kinematic((step) => ({ forward: Math.floor(step / 90) % 2 === 0, speed: 10 }));
    const maxes: number[] = [];
    for (let i = 0; i < 270; i++) {
      sim.stepAll();
      if (i === 89 || i === 179 || i === 269) maxes.push(car.maxProgress);
    }
    expect(maxes[0]).toBeGreaterThan(10);
    expect(maxes[1]).toBeCloseTo(maxes[0], 6); // voltar não altera o máximo
    expect(maxes[2]).toBeLessThan(maxes[0] + 1.5); // repassar o mesmo trecho não acumula
    expect(car.backDist).toBeGreaterThan(10);
    const stats = sim.statsOf(0);
    expect(stats.checkpoints).toBe(car.cpPassed);
  });

  it('não completa cruzando a chegada logo após nascer (de ré e de novo para frente)', () => {
    const t = track('oval-largo');
    const sim = new RaceSim(t, [randomBrain()], RULES);
    const car = sim.cars[0];
    car.controller = kinematic((step) => ({ forward: step >= 60, speed: 8 }));
    for (let i = 0; i < 150; i++) sim.stepAll();
    expect(car.status).toBe('correndo');
    expect(car.cpPassed).toBe(0);
    expect(car.maxProgress).toBeLessThan(START_OFFSET + 1.5 * 8);
  });

  it('não pula checkpoints (teletransporte para frente não conta)', () => {
    const t = track('oval-largo');
    const sim = new RaceSim(t, [randomBrain()], RULES);
    const car = sim.cars[0];
    let jumped = false;
    car.controller = (c, out) => {
      if (!jumped) {
        // salta 150 m sem percorrer o caminho
        const k = Math.round((START_OFFSET + 150) / t.spacing);
        c.phys.x = t.cx[k];
        c.phys.y = t.cy[k];
        c.proj.seg = k; // mesmo informando o segmento, o progresso fica limitado
        jumped = true;
      }
      c.phys.speed = 0;
      out[0] = 0;
      out[1] = 0;
      out[2] = 1;
    };
    sim.stepAll();
    expect(car.cpPassed).toBe(0);
    expect(car.maxProgress).toBeLessThanOrEqual(t.checkpoints[1].s - START_OFFSET + 0.5 + 1e-9);
  });

  it('andar na contramão não dá progresso', () => {
    const t = track('oval-largo');
    const sim = new RaceSim(t, [randomBrain()], RULES);
    const car = sim.cars[0];
    car.controller = kinematic(() => ({ forward: false, speed: 12 }));
    for (let i = 0; i < 200; i++) sim.stepAll();
    expect(car.maxProgress).toBe(0);
    expect(car.progress).toBeLessThan(-20);
  });

  it('encerra por falta de progresso', () => {
    const t = track('oval-largo');
    const sim = new RaceSim(t, [randomBrain()], { maxTime: 60, stallTime: 3, stallDist: 5 });
    const car = sim.cars[0];
    car.controller = (_c, out) => {
      out[0] = 0;
      out[1] = 0;
      out[2] = 1;
    };
    sim.runToEnd();
    expect(car.status).toBe('parado');
    expect(car.endTime).toBeCloseTo(3, 1);
  });

  it('encerra por tempo máximo', () => {
    const t = track('oval-largo');
    const sim = new RaceSim(t, [randomBrain()], { maxTime: 5, stallTime: 4, stallDist: 5 });
    sim.cars[0].controller = followCenter(15);
    sim.runToEnd();
    expect(sim.cars[0].status).toBe('tempo');
    expect(sim.cars[0].endTime).toBeCloseTo(5, 5);
  });

  it('carros não colidem entre si e todos são independentes', () => {
    const t = track('oval-largo');
    const b = randomBrain(5);
    const solo = new RaceSim(t, [b], RULES);
    solo.runToEnd();
    const crowd = new RaceSim(t, [b, randomBrain(6), b, randomBrain(7)], RULES);
    crowd.runToEnd();
    expect(crowd.cars[0].endTime).toBe(solo.cars[0].endTime);
    expect(crowd.cars[2].maxProgress).toBe(solo.cars[0].maxProgress);
  });
});

describe('otimização', () => {
  it('o atalho de colisão não muda nenhum resultado', async () => {
    const { Trainer } = await import('../src/core/trainer.ts');
    const { defaultExperiment } = await import('../src/core/config.ts');
    const { getBuiltinTrack } = await import('../src/core/builtinTracks.ts');
    for (const id of ['curvas-s', 'trechos-estreitos']) {
      const out: string[] = [];
      for (const always of [false, true]) {
        RaceSim.alwaysTestCollision = always;
        const cfg = defaultExperiment(id, 'atalho');
        cfg.evo = { ...cfg.evo, populationSize: 30 };
        cfg.startVariation = true;
        const tr = new Trainer(cfg, [getBuiltinTrack(id)!]);
        for (let g = 0; g < 5; g++) tr.runGeneration();
        out.push(JSON.stringify(tr.history.map((h) => [h.bestScore, h.meanScore, h.deaths])));
      }
      RaceSim.alwaysTestCollision = false;
      expect(out[0]).toBe(out[1]);
    }
  });
});
