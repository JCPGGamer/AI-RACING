import type { CoachConfig, CoachSnapshot } from './coach.ts';
import type { ExperimentConfig } from './config.ts';
import type { MultiResult } from './evaluation.ts';
import type { Brain } from './nn.ts';
import type { Replay } from './replay.ts';
import type { TrackDef } from './track.ts';
import type { TrainerSnapshot } from './trainer.ts';

/** Modelos de dados salvos localmente (IndexedDB) e exportados em JSON. */

export interface PilotEvaluation {
  trackId: string;
  trackName: string;
  trackVersion: number;
  attempts: number;
  result: MultiResult;
  date: number;
}

export type PilotOriginKind = 'treino' | 'treinadora' | 'importado' | 'duplicado' | 'exemplo';

export interface PilotRecord {
  id: string;
  name: string;
  color: string;
  brain: Brain;
  origin: {
    kind: PilotOriginKind;
    projectId?: string;
    projectName?: string;
    generation?: number;
    coachId?: string;
    coachName?: string;
    experiment?: number;
    trackIds?: string[];
    champion?: 'recompensa' | 'oficial';
    parentPilotId?: string;
  };
  evaluations: PilotEvaluation[];
  /** Replay da melhor volta conhecida (opcional) */
  bestReplay?: Replay | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  config: ExperimentConfig;
  generation: number;
  bestScore: number | null;
  bestLapTime: number | null;
  bestCompletion: number;
  /** Projeto de origem quando criado como nova linhagem */
  lineage?: { fromProjectId: string; fromProjectName: string; generation: number } | null;
  /** Estado de retomada exata (população, gerador, histórico) */
  snapshot?: TrainerSnapshot | null;
}

export interface LineageRecord {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
  generation: number;
  createdAt: number;
  snapshot: TrainerSnapshot;
}

export interface SavedConfigRecord {
  id: string;
  name: string;
  config: ExperimentConfig;
  createdAt: number;
}

export type CoachStatusKind = 'nova' | 'rodando' | 'pausada' | 'concluida' | 'cancelada';

export interface CoachRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  config: CoachConfig;
  status: CoachStatusKind;
  snapshot: CoachSnapshot | null;
}

export interface ReplayRecord {
  id: string;
  name: string;
  createdAt: number;
  trackName: string;
  pilotId?: string;
  replay: Replay;
}

export interface CustomTrackRecord {
  id: string;
  def: TrackDef;
  createdAt: number;
  updatedAt: number;
}

export interface LocalSubmission {
  id: string;
  serverId: number;
  trackId: string;
  categoryId: string;
  pilotName: string;
  pilotId?: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  officialTime?: number | null;
  message?: string;
}

export const PILOT_COLORS = ['#ff4d6d', '#4dabf7', '#ffd43b', '#69db7c', '#b197fc', '#ff922b', '#3bc9db', '#f783ac', '#a9e34b', '#e599f7', '#74c0fc', '#ffa94d'];

export function newId(prefix: string): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rnd}`;
}
