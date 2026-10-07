import { sanitizeCoachConfig, type CoachConfig } from './coach.ts';
import { EXPERIMENT_LIMITS, sanitizeExperiment } from './config.ts';
import { base64ToFloat32, base64ToGenome, float32ToBase64, genomeToBase64, paramCount, type Brain } from './nn.ts';
import type { CoachRecord, PilotRecord, ProjectRecord, ReplayRecord, SavedConfigRecord } from './models.ts';
import { FRAME_STRIDE, type Replay } from './replay.ts';
import { normalizeInputs } from './sensors.ts';
import type { TrackDef } from './track.ts';
import type { TrainerSnapshot } from './trainer.ts';
import type { MultiResult } from './evaluation.ts';
import { hasErrors, TRACK_LIMITS, validateTrackDef } from './trackValidation.ts';

/**
 * Importação e exportação em JSON versionado.
 * Vetores numéricos viram base64 ({"$f64": "..."} / {"$f32": "..."}).
 * Toda importação é validada: estrutura, tamanho, dimensões da rede,
 * quantidade de pesos, números finitos, versão e integridade da pista.
 * Nada importado é executado como código.
 */

export const EXPORT_FORMAT = 'evorace';
export const EXPORT_VERSION = 1;
export const MAX_IMPORT_BYTES = 40 * 1024 * 1024;
const MAX_ABS_WEIGHT = 10000;

export type ExportKind = 'piloto' | 'pista' | 'configuracao' | 'treinadora' | 'projeto' | 'replay';

export const KIND_LABEL: Record<ExportKind, string> = {
  piloto: 'Piloto',
  pista: 'Pista',
  configuracao: 'Configuração',
  treinadora: 'Treinadora',
  projeto: 'Laboratório',
  replay: 'Replay',
};

export interface ExportFile {
  formato: typeof EXPORT_FORMAT;
  tipo: ExportKind;
  versao: number;
  exportadoEm: string;
  dados: unknown;
}

export function replacer(_k: string, v: unknown): unknown {
  if (v instanceof Float64Array) return { $f64: genomeToBase64(v) };
  if (v instanceof Float32Array) return { $f32: float32ToBase64(v) };
  if (typeof v === 'number' && !Number.isFinite(v)) return { $num: String(v) };
  return v;
}

export function reviver(_k: string, v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (typeof o.$f64 === 'string' && Object.keys(o).length === 1) return base64ToGenome(o.$f64);
    if (typeof o.$f32 === 'string' && Object.keys(o).length === 1) return base64ToFloat32(o.$f32);
    if (typeof o.$num === 'string' && Object.keys(o).length === 1) {
      if (o.$num === 'NaN') return NaN;
      if (o.$num === 'Infinity') return Infinity;
      if (o.$num === '-Infinity') return -Infinity;
    }
  }
  return v;
}

export function exportJson(tipo: ExportKind, dados: unknown): string {
  const file: ExportFile = { formato: EXPORT_FORMAT, tipo, versao: EXPORT_VERSION, exportadoEm: new Date().toISOString(), dados };
  return JSON.stringify(file, replacer);
}

export class ImportError extends Error {}

function fail(msg: string): never {
  throw new ImportError(msg);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown, max: number, fallback?: string): string {
  if (typeof v === 'string' && v.trim()) return v.trim().slice(0, max);
  if (fallback !== undefined) return fallback;
  return fail('Texto obrigatório ausente.');
}

export function validateBrain(raw: unknown, where = 'cérebro'): Brain {
  if (!isObj(raw)) fail(`O ${where} está ausente ou mal formado.`);
  const inp = raw.inputs;
  if (!isObj(inp)) fail(`O ${where} não informa os sensores.`);
  if (inp.rays !== 5 && inp.rays !== 9 && inp.rays !== 13) fail(`O ${where} tem quantidade de sensores inválida.`);
  for (const k of ['speed', 'prevSteer', 'trackAngle', 'lateral', 'lookahead']) {
    if (inp[k] !== undefined && typeof inp[k] !== 'boolean') fail(`O ${where} tem a entrada "${k}" inválida.`);
  }
  const inputs = normalizeInputs(inp as never);
  const hidden = raw.hidden;
  if (!Array.isArray(hidden) || hidden.length < EXPERIMENT_LIMITS.hiddenLayers.min || hidden.length > EXPERIMENT_LIMITS.hiddenLayers.max) {
    fail(`O ${where} tem um número de camadas ocultas inválido.`);
  }
  if (!hidden.every((h) => Number.isInteger(h) && h >= 1 && h <= EXPERIMENT_LIMITS.neurons.max)) fail(`O ${where} tem camadas com tamanho inválido.`);
  const expected = paramCount(inputs, hidden as number[]);
  if (expected > EXPERIMENT_LIMITS.maxParams) fail(`O ${where} é grande demais (${expected} parâmetros).`);
  const g = raw.genome;
  if (!(g instanceof Float64Array)) fail(`O ${where} não tem pesos válidos.`);
  if (g.length !== expected) fail(`O ${where} tem ${g.length} pesos, mas a arquitetura exige ${expected}.`);
  for (let i = 0; i < g.length; i++) {
    if (!Number.isFinite(g[i]) || Math.abs(g[i]) > MAX_ABS_WEIGHT) fail(`O ${where} tem pesos com valores inválidos (infinitos ou enormes).`);
  }
  return { inputs, hidden: [...(hidden as number[])], genome: g };
}

export function validateTrack(raw: unknown): TrackDef {
  if (!isObj(raw)) fail('Pista mal formada.');
  const pts = raw.points;
  if (!Array.isArray(pts)) fail('A pista não tem pontos.');
  const smooth = raw.smooth !== false;
  const maxPts = smooth ? TRACK_LIMITS.maxPoints : TRACK_LIMITS.maxDensePoints;
  if (pts.length < TRACK_LIMITS.minPoints || pts.length > maxPts) fail(`A pista precisa ter entre ${TRACK_LIMITS.minPoints} e ${maxPts} pontos.`);
  const points = pts.map((p) => {
    if (!isObj(p) || typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.w !== 'number') fail('A pista tem pontos inválidos.');
    if (![p.x, p.y, p.w].every(Number.isFinite)) fail('A pista tem coordenadas não finitas.');
    return { x: p.x as number, y: p.y as number, w: p.w as number };
  });
  const def: TrackDef = {
    id: str(raw.id, 80, 'pista-importada'),
    name: str(raw.name, 60, 'Pista importada'),
    version: Number.isInteger(raw.version) && (raw.version as number) > 0 ? (raw.version as number) : 1,
    description: typeof raw.description === 'string' ? raw.description.slice(0, 300) : undefined,
    points,
    smooth,
    startIndex: Number.isInteger(raw.startIndex) ? Math.min(points.length - 1, Math.max(0, raw.startIndex as number)) : 0,
    reverse: raw.reverse === true,
  };
  const issues = validateTrackDef(def);
  if (hasErrors(issues)) fail(`Pista inválida: ${issues.filter((i) => i.level === 'erro').map((i) => i.message).join(' ')}`);
  return def;
}

export function validateReplay(raw: unknown): Replay {
  if (!isObj(raw) || !isObj(raw.meta)) fail('Replay mal formado.');
  const f = raw.frames;
  if (!(f instanceof Float32Array) || f.length % FRAME_STRIDE !== 0 || f.length === 0) fail('Quadros do replay inválidos.');
  if (f.length > FRAME_STRIDE * 60 * 60 * 30) fail('Replay longo demais.');
  for (let i = 0; i < f.length; i++) if (!Number.isFinite(f[i])) fail('Replay com valores inválidos.');
  const m = raw.meta;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : fail('Dados do replay inválidos.'));
  return {
    meta: {
      trackId: str(m.trackId, 80),
      trackVersion: num(m.trackVersion),
      trackHash: typeof m.trackHash === 'string' ? m.trackHash.slice(0, 16) : '',
      physicsVersion: num(m.physicsVersion),
      dt: num(m.dt),
      frameDt: Math.max(1 / 240, num(m.frameDt)),
      pilotName: typeof m.pilotName === 'string' ? m.pilotName.slice(0, 60) : undefined,
      color: typeof m.color === 'string' ? m.color.slice(0, 20) : undefined,
      completed: m.completed === true,
      time: num(m.time),
      progress: num(m.progress),
      reason: typeof m.reason === 'string' ? m.reason.slice(0, 20) : '',
      crash: isObj(m.crash) && typeof m.crash.x === 'number' && typeof m.crash.y === 'number' ? { x: m.crash.x, y: m.crash.y } : undefined,
    },
    frames: f,
  };
}

function validateRng(v: unknown): [number, number, number, number] {
  if (!Array.isArray(v) || v.length !== 4 || !v.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffffffff)) fail('Estado do gerador aleatório inválido.');
  return v as [number, number, number, number];
}

export function validateTrainerSnapshot(raw: unknown): TrainerSnapshot {
  if (!isObj(raw) || raw.format !== 'evorace-trainer') fail('Dados de treino ausentes.');
  if (raw.version !== 1) fail('Versão do treino incompatível.');
  const { config, warnings } = sanitizeExperiment(raw.config as never);
  void warnings;
  if (!Array.isArray(raw.trackDefs) || raw.trackDefs.length !== config.trackIds.length) fail('Pistas do treino ausentes.');
  const trackDefs = raw.trackDefs.map((t) => validateTrack(t));
  if (!Array.isArray(raw.population) || raw.population.length < 2 || raw.population.length > 400) fail('População inválida.');
  const expected = paramCount(config.inputs, config.hidden);
  const population = raw.population.map((p) => {
    if (!isObj(p)) fail('Indivíduo inválido.');
    const b = validateBrain({ inputs: config.inputs, hidden: config.hidden, genome: p.genome }, 'indivíduo');
    if (b.genome.length !== expected) fail('Indivíduo com tamanho errado.');
    return {
      id: Number.isInteger(p.id) ? (p.id as number) : 0,
      genome: b.genome,
      kind: (['elite', 'filho', 'cruzado', 'novo'].includes(p.kind as string) ? p.kind : 'novo') as 'elite',
      parents: Array.isArray(p.parents) ? (p.parents as unknown[]).filter((x) => Number.isInteger(x)).map(Number) : [],
    };
  });
  const champion = (c: unknown) => {
    if (!isObj(c)) return null;
    const b = validateBrain({ inputs: config.inputs, hidden: config.hidden, genome: c.genome }, 'campeão');
    return {
      id: Number(c.id) || 0,
      generation: Number(c.generation) || 0,
      genome: b.genome,
      score: Number.isFinite(c.score) ? (c.score as number) : 0,
      official: validateMulti(c.official),
      replay: isObj(c.replay) ? safe(() => validateReplay(c.replay)) : null,
    };
  };
  const deaths: Record<string, number[]> = {};
  if (isObj(raw.deaths)) {
    for (const [k, v] of Object.entries(raw.deaths)) if (Array.isArray(v)) deaths[k.slice(0, 80)] = v.filter((x) => Number.isFinite(x)).slice(0, 20000);
  }
  return {
    format: 'evorace-trainer',
    version: 1,
    config,
    trackDefs,
    generation: Math.max(1, Number(raw.generation) || 1),
    nextId: Math.max(population.length + 1, Number(raw.nextId) || 1),
    rng: validateRng(raw.rng),
    population,
    history: validateHistory(raw.history),
    changes: Array.isArray(raw.changes) ? (raw.changes.filter(isObj).slice(-500) as never) : [],
    bestEver: champion(raw.bestEver),
    bestOfficial: champion(raw.bestOfficial),
    lastGenBestReplay: isObj(raw.lastGenBestReplay) ? safe(() => validateReplay(raw.lastGenBestReplay)) : null,
    carStepsTotal: Number(raw.carStepsTotal) || 0,
    deaths,
    pending: null,
  };
}

/** Valida um resultado de avaliação importado; devolve null se estiver incoerente. */
function validateMulti(v: unknown): MultiResult | null {
  if (!isObj(v) || !Array.isArray(v.attempts) || v.attempts.length > 50) return null;
  const inRange = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
  const timeOrNull = (x: unknown) => x === null || (typeof x === 'number' && Number.isFinite(x) && x >= 0);
  if (!inRange(v.completionRate) || !inRange(v.meanProgress) || !timeOrNull(v.medianTime) || !timeOrNull(v.bestTime)) return null;
  if (typeof v.meanTimeAtProgress !== 'number' || !Number.isFinite(v.meanTimeAtProgress)) return null;
  for (const a of v.attempts) {
    if (!isObj(a) || typeof a.completed !== 'boolean' || typeof a.time !== 'number' || !Number.isFinite(a.time) || !inRange(a.progress)) return null;
  }
  return v as unknown as MultiResult;
}

function validateHistory(v: unknown): TrainerSnapshot['history'] {
  if (!Array.isArray(v)) return [];
  const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  return v
    .filter((h) => isObj(h) && num(h.gen) && num(h.bestScore) && num(h.meanScore) && num(h.bestProgress) && num(h.completionRate) && isObj(h.deaths))
    .slice(-3000) as unknown as TrainerSnapshot['history'];
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

export type ImportResult =
  | { tipo: 'piloto'; data: PilotRecord }
  | { tipo: 'pista'; data: TrackDef }
  | { tipo: 'configuracao'; data: SavedConfigRecord; warnings: string[] }
  | { tipo: 'treinadora'; data: CoachRecord; warnings: string[] }
  | { tipo: 'projeto'; data: ProjectRecord }
  | { tipo: 'replay'; data: ReplayRecord };

/** Lê e valida um arquivo exportado. Lança ImportError com mensagem clara. */
export function parseImport(text: string): ImportResult {
  if (typeof text !== 'string') fail('Arquivo ilegível.');
  if (text.length > MAX_IMPORT_BYTES) fail('Arquivo grande demais (máximo 40 MB).');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text, reviver);
  } catch (e) {
    if (e instanceof Error && /base64|tamanho|inválid/i.test(e.message)) fail(`Dados numéricos corrompidos: ${e.message}`);
    fail('O arquivo não é um JSON válido.');
  }
  if (!isObj(parsed) || parsed.formato !== EXPORT_FORMAT) fail('Este arquivo não é do EvoRace.');
  if (parsed.versao !== EXPORT_VERSION) fail(`Versão ${String(parsed.versao)} não suportada (esperada ${EXPORT_VERSION}).`);
  const d = parsed.dados;
  if (!isObj(d)) fail('O arquivo não tem dados.');
  const now = Date.now();
  switch (parsed.tipo) {
    case 'piloto': {
      const brain = validateBrain(d.brain);
      const evaluations = Array.isArray(d.evaluations)
        ? (d.evaluations
            .filter((e) => isObj(e) && typeof e.trackId === 'string' && validateMulti(e.result))
            .slice(0, 100) as never)
        : [];
      return {
        tipo: 'piloto',
        data: {
          id: '',
          name: str(d.name, 60, 'Piloto importado'),
          color: typeof d.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(d.color) ? d.color : '#4dabf7',
          brain,
          origin: { kind: 'importado' },
          evaluations,
          bestReplay: isObj(d.bestReplay) ? safe(() => validateReplay(d.bestReplay)) : null,
          createdAt: now,
          updatedAt: now,
        },
      };
    }
    case 'pista':
      return { tipo: 'pista', data: { ...validateTrack(d.def ?? d), builtin: false } };
    case 'configuracao': {
      const s = sanitizeExperiment((d.config ?? d) as never);
      return { tipo: 'configuracao', data: { id: '', name: str(d.name, 60, 'Configuração importada'), config: s.config, createdAt: now }, warnings: s.warnings };
    }
    case 'treinadora': {
      if (!isObj(d.config)) fail('Treinadora sem configuração.');
      const s = sanitizeCoachConfig(d.config as unknown as CoachConfig);
      return {
        tipo: 'treinadora',
        data: { id: '', name: str(d.name, 60, 'Treinadora importada'), createdAt: now, updatedAt: now, config: s.config, status: 'nova', snapshot: null },
        warnings: [...s.warnings, ...(d.snapshot ? ['O progresso da treinadora não é importado; ela recomeça do início.'] : [])],
      };
    }
    case 'projeto': {
      const snapshot = validateTrainerSnapshot(d.snapshot);
      return {
        tipo: 'projeto',
        data: {
          id: '',
          name: str(d.name, 60, 'Laboratório importado'),
          createdAt: now,
          updatedAt: now,
          config: snapshot.config,
          generation: snapshot.generation,
          bestScore: snapshot.bestEver?.score ?? null,
          bestLapTime: snapshot.bestOfficial?.official?.bestTime ?? null,
          bestCompletion: snapshot.bestOfficial?.official?.completionRate ?? 0,
          lineage: null,
          snapshot,
        },
      };
    }
    case 'replay': {
      const replay = validateReplay(d.replay ?? d);
      return { tipo: 'replay', data: { id: '', name: str(d.name, 80, 'Replay importado'), createdAt: now, trackName: str(d.trackName, 60, replay.meta.trackId), replay } };
    }
    default:
      return fail('Tipo de arquivo desconhecido.');
  }
}
