import type { CandidateResult, CoachConfig, CoachMessage, CoachSnapshot } from '../core/coach.ts';
import type { ExperimentConfig } from '../core/config.ts';
import type { MultiResult } from '../core/evaluation.ts';
import type { IndividualKind } from '../core/evolution.ts';
import type { Brain } from '../core/nn.ts';
import type { Replay } from '../core/replay.ts';
import type { ScoreTerm } from '../core/rewards.ts';
import type { EndReason } from '../core/sim.ts';
import type { TrackDef } from '../core/track.ts';
import type { ConfigChange, GenStats, IndividualResult, TrainerSnapshot } from '../core/trainer.ts';
import type { ChampionshipConfig, ChampionshipEntry, ChampionshipResult } from '../core/championship.ts';
import type { OfficialRun } from '../core/official.ts';

/** Quadro resumido enviado do worker para a interface (sem objetos grandes). */
export const CAR_STRIDE = 7; // x, y, heading, status, speed, kind, id
export const STATUS_CODE: Record<EndReason, number> = { correndo: 0, batida: 1, completou: 2, tempo: 3, parado: 4 };
export const CODE_STATUS: EndReason[] = ['correndo', 'batida', 'completou', 'tempo', 'parado'];
export const KIND_CODE: Record<IndividualKind, number> = { elite: 0, filho: 1, cruzado: 2, novo: 3 };
export const CODE_KIND: IndividualKind[] = ['elite', 'filho', 'cruzado', 'novo'];

export interface SelectedCarInfo {
  index: number;
  id: number;
  kind: IndividualKind;
  parents: number[];
  status: EndReason;
  inputs: number[];
  outputs: number[];
  rays: number[];
  hidden: number[][];
  speed: number;
  progress: number;
  time: number;
  lapTime: number | null;
  terms: ScoreTerm[];
  score: number;
}

export interface LiveFrame {
  gen: number;
  trackIdx: number;
  trackId: string;
  step: number;
  time: number;
  cars: Float32Array;
  alive: number;
  total: number;
  leader: number;
  bestProgress: number;
  completed: number;
  bestLap: number | null;
  selected: SelectedCarInfo | null;
  events: { type: 'batida' | 'volta'; x: number; y: number; car: number }[];
  /** passos de simulação por segundo real (medido) */
  stepsPerSec: number;
}

export interface ChampionSummary {
  id: number;
  generation: number;
  score: number;
  official: MultiResult | null;
  genome: Float64Array;
  replay: Replay | null;
}

export interface GenerationMsg {
  stats: GenStats;
  results: IndividualResult[];
  bestReplay: Replay | null;
  bestEver: ChampionSummary | null;
  bestOfficial: ChampionSummary | null;
  deaths: Record<string, number[]>;
  changes: ConfigChange[];
}

export type TrainingIn =
  | { type: 'init'; config: ExperimentConfig; trackDefs: TrackDef[]; snapshot?: TrainerSnapshot | null }
  | { type: 'play'; speed: number | 'max' }
  | { type: 'pause' }
  | { type: 'step' }
  | { type: 'finishGen' }
  | { type: 'select'; index: number }
  | { type: 'config'; config: ExperimentConfig; trackDefs?: TrackDef[] }
  | { type: 'snapshot'; reqId: number }
  | { type: 'lowPower'; on: boolean };

export type TrainingOut =
  | { type: 'ready'; generation: number; history: GenStats[]; changes: ConfigChange[]; bestEver: ChampionSummary | null; bestOfficial: ChampionSummary | null; bestReplay: Replay | null; deaths: Record<string, number[]>; config: ExperimentConfig }
  | { type: 'frame'; frame: LiveFrame }
  | { type: 'generation'; msg: GenerationMsg }
  | { type: 'autosave'; snapshot: TrainerSnapshot }
  | { type: 'snapshot'; reqId: number; snapshot: TrainerSnapshot }
  | { type: 'configResult'; ok: boolean; message: string }
  | { type: 'state'; running: boolean; speed: number | 'max' }
  | { type: 'error'; message: string };

export interface CoachProgressMsg {
  experiment: number;
  total: number;
  budgetUsed: number;
  budget: number;
  runSteps: number;
  runBudget: number;
  generation: number;
  seedIdx: number;
}

export type CoachIn =
  | { type: 'init'; config: CoachConfig; trackDefs: TrackDef[]; snapshot?: CoachSnapshot | null }
  | { type: 'run' }
  | { type: 'pause' }
  | { type: 'cancel' }
  | { type: 'view'; on: boolean }
  | { type: 'snapshot'; reqId: number };

export type CoachOut =
  | { type: 'ready'; messages: CoachMessage[]; candidates: CandidateResult[]; bestIndex: number; finished: boolean; progress: CoachProgressMsg }
  | { type: 'progress'; progress: CoachProgressMsg; newMessages: CoachMessage[]; frame: LiveFrame | null; currentTrackId: string | null }
  | { type: 'candidates'; candidates: CandidateResult[]; bestIndex: number }
  | { type: 'done'; snapshot: CoachSnapshot; stopReason: string }
  | { type: 'snapshot'; reqId: number; snapshot: CoachSnapshot }
  | { type: 'state'; running: boolean }
  | { type: 'error'; message: string };

export interface EvalTrackResult {
  trackId: string;
  trackName: string;
  result: MultiResult;
  replay: Replay | null;
}

export type EvalIn =
  | { type: 'evaluate'; id: number; brain: Brain; trackDefs: TrackDef[]; attempts: number; pilotName?: string; color?: string }
  | { type: 'official'; id: number; brain: Brain; trackId: string; pilotName?: string }
  | { type: 'championship'; id: number; entries: ChampionshipEntry[]; trackDefs: TrackDef[]; config: ChampionshipConfig }
  | { type: 'benchmark'; id: number; population: number; ms: number }
  | { type: 'cancel'; id: number };

export type EvalOut =
  | { type: 'progress'; id: number; done: number; total: number; label: string }
  | { type: 'evaluated'; id: number; results: EvalTrackResult[] }
  | { type: 'official'; id: number; run: OfficialRun | null; error?: string }
  | { type: 'championship'; id: number; result: ChampionshipResult }
  | { type: 'benchmark'; id: number; carStepsPerSec: number; stepsPerSec: number }
  | { type: 'error'; id: number; message: string };
