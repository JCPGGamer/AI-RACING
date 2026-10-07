import { describe, expect, it } from 'vitest';
import { getBuiltinTrack } from '../src/core/builtinTracks.ts';
import { defaultExperiment } from '../src/core/config.ts';
import { exportJson, ImportError, parseImport } from '../src/core/io.ts';
import { genomeToBase64, paramCount, randomGenome } from '../src/core/nn.ts';
import { Rng } from '../src/core/rng.ts';
import { DEFAULT_INPUTS } from '../src/core/sensors.ts';
import { Trainer } from '../src/core/trainer.ts';

const brain = () => ({ inputs: { ...DEFAULT_INPUTS }, hidden: [16, 16], genome: randomGenome(DEFAULT_INPUTS, [16, 16], new Rng(9)) });

function pilotFile(over: Record<string, unknown> = {}): string {
  return exportJson('piloto', { name: 'Teste', color: '#ff0000', brain: brain(), evaluations: [], ...over });
}

describe('importação e exportação', () => {
  it('piloto vai e volta sem perder nenhum peso', () => {
    const b = brain();
    const r = parseImport(exportJson('piloto', { name: 'Ida e volta', color: '#00ff00', brain: b, evaluations: [] }));
    expect(r.tipo).toBe('piloto');
    if (r.tipo === 'piloto') {
      expect(Array.from(r.data.brain.genome)).toEqual(Array.from(b.genome));
      expect(r.data.name).toBe('Ida e volta');
    }
  });

  it('pista personalizada e configuração são aceitas', () => {
    const def = { ...getBuiltinTrack('curvas-s')!, id: 'copia', builtin: false };
    expect(parseImport(exportJson('pista', { def })).tipo).toBe('pista');
    const c = parseImport(exportJson('configuracao', { name: 'c', config: defaultExperiment() }));
    expect(c.tipo).toBe('configuracao');
  });

  const rejects = (text: string, re: RegExp) => {
    try {
      parseImport(text);
    } catch (e) {
      expect(e).toBeInstanceOf(ImportError);
      expect((e as Error).message).toMatch(re);
      return;
    }
    throw new Error('deveria rejeitar');
  };

  it('rejeita arquivos que não são do jogo, JSON quebrado e versões futuras', () => {
    rejects('{"hello": 1}', /não é do EvoRace/);
    rejects('{ quebrado', /JSON válido/);
    rejects(JSON.stringify({ formato: 'evorace', tipo: 'piloto', versao: 99, dados: {} }), /Versão 99/);
    rejects(JSON.stringify({ formato: 'evorace', tipo: 'desconhecido', versao: 1, dados: {} }), /desconhecido/);
  });

  it('rejeita dimensões de rede e quantidade de pesos erradas', () => {
    const b = brain();
    rejects(pilotFile({ brain: { ...b, genome: b.genome.slice(0, 100) } }), /exige 547/);
    rejects(pilotFile({ brain: { ...b, hidden: [16, 16, 16, 16, 16] } }), /camadas/);
    rejects(pilotFile({ brain: { ...b, hidden: [999] } }), /tamanho inválido/);
    rejects(pilotFile({ brain: { ...b, inputs: { ...b.inputs, rays: 7 } } }), /sensores/);
  });

  it('rejeita valores não finitos ou enormes', () => {
    const b = brain();
    const g = b.genome.slice();
    g[10] = NaN;
    rejects(pilotFile({ brain: { ...b, genome: g } }), /inválidos/);
    const g2 = b.genome.slice();
    g2[3] = 1e9;
    rejects(pilotFile({ brain: { ...b, genome: g2 } }), /inválidos/);
  });

  it('rejeita base64 corrompido', () => {
    const text = pilotFile().replace(/"\$f64":"[^"]{10}/, '"$f64":"@@@@@@@@@@');
    rejects(text, /corrompidos|inválid/);
  });

  it('rejeita pistas que se cruzam', () => {
    const def = {
      id: 'x',
      name: 'Laço',
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
    rejects(exportJson('pista', { def }), /Pista inválida/);
  });

  it('rejeita arquivo grande demais', () => {
    rejects('x'.repeat(40 * 1024 * 1024 + 10), /grande demais/);
  });

  it('projeto com estado de retomada é validado (gerador e população)', () => {
    const tr = new Trainer({ ...defaultExperiment('oval-largo', 'io'), evo: { ...defaultExperiment().evo, populationSize: 20 } }, [getBuiltinTrack('oval-largo')!]);
    const snap = tr.snapshot();
    expect(parseImport(exportJson('projeto', { name: 'p', snapshot: snap })).tipo).toBe('projeto');
    rejects(exportJson('projeto', { name: 'p', snapshot: { ...snap, rng: [1, 2, 3] } }), /gerador/);
    const badPop = snap.population.map((p, i) => (i === 3 ? { ...p, genome: p.genome.slice(0, 5) } : p));
    rejects(exportJson('projeto', { name: 'p', snapshot: { ...snap, population: badPop } }), /indivíduo/);
  });

  it('o envio ao ranking só carrega números (sem código)', () => {
    const b = brain();
    const encoded = genomeToBase64(b.genome);
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(paramCount(b.inputs, b.hidden) * 8).toBe(Math.floor((encoded.length * 3) / 4) - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0));
  });
});
