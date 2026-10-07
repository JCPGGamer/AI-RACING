import { getBuiltinTrack } from './builtinTracks.ts';
import { attemptFromSim, replayFromSim, type AttemptResult } from './evaluation.ts';
import { base64ToGenome, genomeToBase64, paramCount, type Brain } from './nn.ts';
import type { Replay } from './replay.ts';
import { checkBrainForCategory, getCategory, OFFICIAL_START, OFFICIAL_TRACK_IDS, officialRules, rulesKey } from './rules.ts';
import { normalizeInputs, type InputConfig } from './sensors.ts';
import { RaceSim } from './sim.ts';
import { buildTrack, type Track } from './track.ts';

/**
 * Avaliação oficial usada pelo servidor do ranking (e pelo jogo para conferir
 * se um piloto é elegível antes de enviar). Mesmo núcleo, mesmas regras.
 */

const trackCache = new Map<string, Track>();
export function officialTrack(id: string): Track | null {
  if (!OFFICIAL_TRACK_IDS.includes(id)) return null;
  let t = trackCache.get(id);
  if (!t) {
    const def = getBuiltinTrack(id);
    if (!def) return null;
    t = buildTrack(def);
    trackCache.set(id, t);
  }
  return t;
}

export interface SubmissionBrain {
  inputs: InputConfig;
  hidden: number[];
  genome: string;
}

export interface SubmissionPayload {
  trackId: string;
  categoryId: string;
  pilotName: string;
  /** Versão das regras que o cliente acredita estar usando */
  rulesVersion: string;
  /** Hash da pista no cliente (detecta jogo desatualizado) */
  trackHash: string;
  brain: SubmissionBrain;
}

export const SUBMISSION_LIMITS = {
  maxGenomeChars: 220_000,
  maxPilotName: 40,
  maxAbsWeight: 1000,
};

export type ParsedSubmission =
  | { ok: true; brain: Brain; track: Track; categoryId: string; pilotName: string; rulesVersion: string }
  | { ok: false; error: string };

/** Valida formato, dimensões e valores. Nunca executa código vindo do jogador: só números. */
export function parseSubmission(raw: unknown): ParsedSubmission {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Envio vazio ou em formato inválido.' };
  const p = raw as Partial<SubmissionPayload>;
  if (typeof p.trackId !== 'string') return { ok: false, error: 'Pista não informada.' };
  const track = officialTrack(p.trackId);
  if (!track) return { ok: false, error: 'Pista não faz parte do ranking oficial.' };
  if (typeof p.categoryId !== 'string') return { ok: false, error: 'Categoria não informada.' };
  const cat = getCategory(p.categoryId);
  if (!cat) return { ok: false, error: 'Categoria desconhecida.' };
  const expectedRules = rulesKey(track.def);
  if (p.rulesVersion !== expectedRules) {
    return { ok: false, error: `Versão das regras diferente (jogo: ${String(p.rulesVersion)}, servidor: ${expectedRules}). Atualize o jogo.` };
  }
  if (typeof p.trackHash === 'string' && p.trackHash !== track.hash) {
    return { ok: false, error: 'A pista do seu jogo é diferente da oficial. Atualize o jogo.' };
  }
  const pilotName = typeof p.pilotName === 'string' ? p.pilotName.trim().slice(0, SUBMISSION_LIMITS.maxPilotName) : '';
  if (!pilotName) return { ok: false, error: 'Dê um nome ao piloto.' };
  const b = p.brain;
  if (!b || typeof b !== 'object') return { ok: false, error: 'Cérebro do piloto ausente.' };
  if (!b.inputs || typeof b.inputs !== 'object') return { ok: false, error: 'Configuração de sensores ausente.' };
  const rawInputs = b.inputs as unknown as Record<string, unknown>;
  for (const k of ['speed', 'prevSteer', 'trackAngle', 'lateral', 'lookahead']) {
    if (typeof rawInputs[k] !== 'boolean') return { ok: false, error: `Entrada "${k}" inválida.` };
  }
  if (rawInputs.rays !== 5 && rawInputs.rays !== 9 && rawInputs.rays !== 13) return { ok: false, error: 'Quantidade de sensores inválida.' };
  const inputs = normalizeInputs(b.inputs);
  if (!Array.isArray(b.hidden) || b.hidden.length > 8 || !b.hidden.every((h) => Number.isInteger(h) && h >= 1 && h <= 256)) {
    return { ok: false, error: 'Camadas ocultas inválidas.' };
  }
  const hidden = b.hidden.slice();
  const problems = checkBrainForCategory({ inputs, hidden }, cat);
  if (problems.length) return { ok: false, error: problems.join(' ') };
  if (typeof b.genome !== 'string' || b.genome.length > SUBMISSION_LIMITS.maxGenomeChars) return { ok: false, error: 'Pesos ausentes ou grandes demais.' };
  let genome: Float64Array;
  try {
    genome = base64ToGenome(b.genome);
  } catch {
    return { ok: false, error: 'Pesos em formato inválido.' };
  }
  const expected = paramCount(inputs, hidden);
  if (genome.length !== expected) return { ok: false, error: `Esperados ${expected} pesos, recebidos ${genome.length}.` };
  for (let i = 0; i < genome.length; i++) {
    const v = genome[i];
    if (!Number.isFinite(v) || Math.abs(v) > SUBMISSION_LIMITS.maxAbsWeight) return { ok: false, error: 'Há pesos com valores inválidos (infinitos ou enormes).' };
  }
  return { ok: true, brain: { inputs, hidden, genome }, track, categoryId: cat.id, pilotName, rulesVersion: expectedRules };
}

export interface OfficialRun {
  result: AttemptResult;
  replay: Replay;
  steps: number;
}

/** Executa a tentativa oficial (largada padrão, regras fixas, tempo simulado). */
export function runOfficial(brain: Brain, track: Track, pilotName?: string): OfficialRun {
  const rules = officialRules(track);
  const sim = new RaceSim(track, [brain], rules, OFFICIAL_START, true);
  const maxSteps = Math.ceil(rules.maxTime / sim.dt) + 10;
  sim.runToEnd(maxSteps);
  const result = attemptFromSim(sim, 0);
  const replay = replayFromSim(sim, 0, { pilotName })!;
  return { result, replay, steps: sim.step };
}

/** Monta o envio a partir de um cérebro (o tempo nunca é enviado: o servidor calcula). */
export function buildSubmission(brain: Brain, trackId: string, categoryId: string, pilotName: string): SubmissionPayload {
  const track = officialTrack(trackId);
  if (!track) throw new Error('Pista fora do ranking oficial.');
  return {
    trackId,
    categoryId,
    pilotName: pilotName.trim().slice(0, SUBMISSION_LIMITS.maxPilotName),
    rulesVersion: rulesKey(track.def),
    trackHash: track.hash,
    brain: { inputs: { ...brain.inputs }, hidden: [...brain.hidden], genome: genomeToBase64(brain.genome) },
  };
}
