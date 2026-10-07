import { audio } from '../audio/audio.ts';
import { cloneConfig, compatibleArch, sanitizeExperiment, type ExperimentConfig } from '../core/config.ts';
import type { PilotRecord, ProjectRecord, LineageRecord } from '../core/models.ts';
import { newId, PILOT_COLORS } from '../core/models.ts';
import type { Replay } from '../core/replay.ts';
import type { TrackDef } from '../core/track.ts';
import { Trainer, type ConfigChange, type GenStats, type IndividualResult, type TrainerSnapshot } from '../core/trainer.ts';
import { db } from '../persistence/db.ts';
import { dataChanged, getState, toast } from '../ui/store.ts';
import type { ChampionSummary, LiveFrame, TrainingIn, TrainingOut } from '../workers/protocol.ts';
import { resolveTrackDefs } from './tracks.ts';

/**
 * Sessão do laboratório: controla o worker de treino do projeto aberto,
 * guarda o último quadro (lido direto pelo canvas) e um resumo para a
 * interface React (atualizado com moderação).
 */

export interface LabView {
  project: ProjectRecord;
  config: ExperimentConfig;
  trackDefs: TrackDef[];
  running: boolean;
  speed: number | 'max';
  generation: number;
  history: GenStats[];
  changes: ConfigChange[];
  lastResults: IndividualResult[];
  bestEver: ChampionSummary | null;
  bestOfficial: ChampionSummary | null;
  bestReplay: Replay | null;
  deaths: Record<string, number[]>;
  lastSavedAt: number | null;
  saveError: string | null;
  configMessage: string | null;
  pendingConfig: ExperimentConfig | null;
  ready: boolean;
  error: string | null;
}

let current: LabSession | null = null;
const globalListeners = new Set<() => void>();

export function getLab(): LabSession | null {
  return current;
}

export function onLabChange(fn: () => void): () => void {
  globalListeners.add(fn);
  return () => globalListeners.delete(fn);
}

function notifyGlobal() {
  for (const l of globalListeners) l();
}

export class LabSession {
  view: LabView;
  frame: LiveFrame | null = null;
  /** Efeitos visuais pendentes (batidas) para o canvas consumir */
  effects: { x: number; y: number; t: number }[] = [];
  private worker: Worker;
  private listeners = new Set<() => void>();
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotWaiters = new Map<number, (s: TrainerSnapshot) => void>();
  private reqId = 1;
  private lastLapSound = 0;
  private lastGenSound = 0;
  private disposed = false;

  private constructor(project: ProjectRecord, trackDefs: TrackDef[]) {
    this.view = {
      project,
      config: project.snapshot?.config ?? project.config,
      trackDefs,
      running: false,
      speed: 1,
      generation: project.generation,
      history: project.snapshot?.history ?? [],
      changes: project.snapshot?.changes ?? [],
      lastResults: [],
      bestEver: null,
      bestOfficial: null,
      bestReplay: null,
      deaths: {},
      lastSavedAt: project.updatedAt,
      saveError: null,
      configMessage: null,
      pendingConfig: null,
      ready: false,
      error: null,
    };
    this.worker = new Worker(new URL('../workers/training.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<TrainingOut>) => this.onMessage(e.data);
    this.worker.onerror = (e) => this.patch({ error: `Erro no treino: ${e.message}` }, true);
    this.post({ type: 'init', config: project.config, trackDefs, snapshot: project.snapshot ?? null });
    this.post({ type: 'lowPower', on: getState().prefs.lowPower });
    document.addEventListener('visibilitychange', this.onHide);
    window.addEventListener('pagehide', this.onPageHide);
  }

  private onPageHide = () => {
    void this.saveNow();
  };

  static async open(projectId: string): Promise<LabSession> {
    if (current && current.view.project.id === projectId && !current.disposed) return current;
    const project = await db.get<ProjectRecord>('projects', projectId);
    if (!project) throw new Error('Laboratório não encontrado.');
    const ids = project.snapshot?.config.trackIds ?? project.config.trackIds;
    let defs: TrackDef[];
    if (project.snapshot?.trackDefs?.length) defs = project.snapshot.trackDefs;
    else defs = await resolveTrackDefs(ids);
    if (current) await current.close();
    current = new LabSession(project, defs);
    notifyGlobal();
    return current;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getView = (): LabView => this.view;

  private patch(p: Partial<LabView>, immediate = false) {
    this.view = { ...this.view, ...p };
    if (immediate) {
      if (this.notifyTimer) clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
      for (const l of this.listeners) l();
      return;
    }
    if (!this.notifyTimer) {
      this.notifyTimer = setTimeout(() => {
        this.notifyTimer = null;
        for (const l of this.listeners) l();
      }, 200);
    }
  }

  private post(m: TrainingIn) {
    this.worker.postMessage(m);
  }

  private onMessage(m: TrainingOut) {
    switch (m.type) {
      case 'ready':
        this.patch(
          {
            ready: true,
            generation: m.generation,
            history: m.history,
            changes: m.changes,
            bestEver: m.bestEver,
            bestOfficial: m.bestOfficial,
            bestReplay: m.bestReplay,
            deaths: m.deaths,
            config: m.config,
          },
          true,
        );
        break;
      case 'frame': {
        this.frame = m.frame;
        const prefs = getState().prefs;
        for (const ev of m.frame.events) {
          if (ev.type === 'batida') {
            audio.crash();
            if (!prefs.hideEffects && this.effects.length < 30) this.effects.push({ x: ev.x, y: ev.y, t: performance.now() });
          } else if (ev.type === 'volta' && performance.now() - this.lastLapSound > 400) {
            this.lastLapSound = performance.now();
            audio.lap();
          }
        }
        this.patch({ generation: m.frame.gen });
        break;
      }
      case 'generation': {
        const s = m.msg.stats;
        const history = [...this.view.history, s].slice(-3000);
        this.patch(
          {
            history,
            lastResults: m.msg.results,
            bestEver: m.msg.bestEver,
            bestOfficial: m.msg.bestOfficial,
            bestReplay: m.msg.bestReplay,
            deaths: m.msg.deaths,
            changes: m.msg.changes,
            generation: s.gen + 1,
            pendingConfig: null,
          },
          true,
        );
        const now = performance.now();
        if (s.newOfficialRecord && m.msg.bestOfficial?.official?.completionRate) {
          if (now - this.lastGenSound > 800) audio.record();
          this.lastGenSound = now;
        } else if (now - this.lastGenSound > 1500) {
          this.lastGenSound = now;
          audio.genEnd();
        }
        break;
      }
      case 'autosave':
        void this.persist(m.snapshot);
        break;
      case 'snapshot': {
        const w = this.snapshotWaiters.get(m.reqId);
        if (w) {
          this.snapshotWaiters.delete(m.reqId);
          w(m.snapshot);
        }
        break;
      }
      case 'configResult':
        this.patch({ configMessage: m.message, pendingConfig: m.ok ? this.view.pendingConfig : null }, true);
        if (!m.ok) toast(m.message, 'erro');
        break;
      case 'state':
        this.patch({ running: m.running, speed: m.speed }, true);
        if (!m.running) audio.setEngine(false, 0, 0);
        break;
      case 'error':
        this.patch({ error: m.message }, true);
        toast(m.message, 'erro', 7000);
        break;
    }
  }

  private onHide = () => {
    if (document.visibilityState === 'hidden') void this.saveNow();
  };

  play(speed: number | 'max') {
    if (!this.view.running) audio.start();
    this.post({ type: 'play', speed });
  }

  pause() {
    this.post({ type: 'pause' });
    void this.saveNow();
  }

  step() {
    this.post({ type: 'step' });
  }

  finishGeneration() {
    this.post({ type: 'finishGen' });
  }

  select(index: number) {
    this.post({ type: 'select', index });
  }

  setLowPower(on: boolean) {
    this.post({ type: 'lowPower', on });
  }

  /** Mudança compatível: entra no limite da próxima geração e fica registrada no histórico. */
  async applyConfig(next: ExperimentConfig): Promise<{ ok: boolean; message: string }> {
    const s = sanitizeExperiment(next);
    if (!compatibleArch(this.view.config, s.config)) {
      return { ok: false, message: 'Sensores ou arquitetura mudaram: crie um experimento novo para não reaproveitar pesos incompatíveis.' };
    }
    let defs: TrackDef[] | undefined;
    if (s.config.trackIds.join(',') !== this.view.config.trackIds.join(',')) {
      try {
        defs = await resolveTrackDefs(s.config.trackIds);
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    }
    this.patch({ pendingConfig: s.config, configMessage: null }, true);
    this.post({ type: 'config', config: s.config, trackDefs: defs });
    return { ok: true, message: s.warnings.join(' ') || 'As mudanças entram no início da próxima geração.' };
  }

  requestSnapshot(): Promise<TrainerSnapshot> {
    const reqId = this.reqId++;
    return new Promise((resolve, reject) => {
      this.snapshotWaiters.set(reqId, resolve);
      setTimeout(() => {
        if (this.snapshotWaiters.delete(reqId)) reject(new Error('O treino não respondeu a tempo.'));
      }, 10000);
      this.post({ type: 'snapshot', reqId });
    });
  }

  async saveNow(): Promise<void> {
    if (this.disposed || !this.view.ready) return;
    try {
      await this.persist(await this.requestSnapshot());
    } catch (e) {
      this.patch({ saveError: (e as Error).message }, true);
    }
  }

  private async persist(snapshot: TrainerSnapshot): Promise<void> {
    const p = this.view.project;
    const official = snapshot.bestOfficial?.official;
    const updated: ProjectRecord = {
      ...p,
      config: snapshot.config,
      generation: snapshot.generation,
      bestScore: snapshot.bestEver?.score ?? null,
      bestLapTime: official?.bestTime ?? null,
      bestCompletion: official?.completionRate ?? 0,
      updatedAt: Date.now(),
      snapshot,
    };
    try {
      await db.put('projects', updated);
      this.patch({ project: updated, lastSavedAt: updated.updatedAt, saveError: null });
    } catch (e) {
      const msg = (e as Error).message;
      if (this.view.saveError !== msg) toast(msg, 'erro', 8000);
      this.patch({ saveError: msg }, true);
    }
  }

  async rename(name: string): Promise<void> {
    const project = { ...this.view.project, name: name.trim().slice(0, 60) || this.view.project.name };
    this.patch({ project }, true);
    await db.put('projects', { ...project, updatedAt: Date.now() });
    dataChanged();
  }

  /** Salva o campeão (oficial ou por recompensa) na garagem. */
  async saveChampion(kind: 'oficial' | 'recompensa', name?: string): Promise<PilotRecord | null> {
    const c = kind === 'oficial' ? this.view.bestOfficial : this.view.bestEver;
    if (!c) {
      toast('Ainda não há campeão: termine pelo menos uma geração.', 'aviso');
      return null;
    }
    const cfg = this.view.config;
    const existing = await db.getAll<PilotRecord>('pilots');
    const now = Date.now();
    const pilot: PilotRecord = {
      id: newId('piloto'),
      name: (name ?? `${this.view.project.name} · G${c.generation}`).slice(0, 60),
      color: PILOT_COLORS[existing.length % PILOT_COLORS.length],
      brain: { inputs: { ...cfg.inputs }, hidden: [...cfg.hidden], genome: c.genome.slice() },
      origin: {
        kind: 'treino',
        projectId: this.view.project.id,
        projectName: this.view.project.name,
        generation: c.generation,
        trackIds: [...cfg.trackIds],
        champion: kind,
      },
      evaluations: c.official
        ? [
            {
              trackId: cfg.trackIds[0],
              trackName: this.view.trackDefs[0]?.name ?? cfg.trackIds[0],
              trackVersion: this.view.trackDefs[0]?.version ?? 1,
              attempts: c.official.attempts.length,
              result: c.official,
              date: now,
            },
          ]
        : [],
      bestReplay: c.replay,
      createdAt: now,
      updatedAt: now,
    };
    await db.put('pilots', pilot);
    dataChanged();
    toast(`"${pilot.name}" foi salvo na Garagem.`, 'sucesso');
    return pilot;
  }

  /** Guarda a geração atual para criar novas linhagens depois. */
  async saveLineage(name?: string): Promise<void> {
    const snapshot = await this.requestSnapshot();
    const rec: LineageRecord = {
      id: newId('linhagem'),
      name: (name ?? `${this.view.project.name} · geração ${snapshot.generation}`).slice(0, 80),
      projectId: this.view.project.id,
      projectName: this.view.project.name,
      generation: snapshot.generation,
      createdAt: Date.now(),
      snapshot,
    };
    await db.put('lineages', rec);
    dataChanged();
    toast('Geração salva em Linhagens (Garagem).', 'sucesso');
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    await this.saveNow();
    this.dispose();
  }

  dispose() {
    this.disposed = true;
    document.removeEventListener('visibilitychange', this.onHide);
    window.removeEventListener('pagehide', this.onPageHide);
    this.worker.terminate();
    audio.setEngine(false, 0, 0);
    if (current === this) {
      current = null;
      notifyGlobal();
    }
  }
}

/** Cria e salva um laboratório novo. Com `champion`, a população nasce do cérebro escolhido. */
export async function createProject(
  name: string,
  config: ExperimentConfig,
  opts: { champion?: Float64Array; lineage?: ProjectRecord['lineage']; snapshot?: TrainerSnapshot } = {},
): Promise<ProjectRecord> {
  const cfg = sanitizeExperiment(cloneConfig(config)).config;
  let snapshot: TrainerSnapshot;
  if (opts.snapshot) snapshot = opts.snapshot;
  else {
    const defs = await resolveTrackDefs(cfg.trackIds);
    snapshot = opts.champion ? Trainer.fromChampion(cfg, defs, opts.champion).snapshot() : new Trainer(cfg, defs).snapshot();
  }
  const now = Date.now();
  const project: ProjectRecord = {
    id: newId('lab'),
    name: name.trim().slice(0, 60) || 'Laboratório',
    createdAt: now,
    updatedAt: now,
    config: snapshot.config,
    generation: snapshot.generation,
    bestScore: snapshot.bestEver?.score ?? null,
    bestLapTime: snapshot.bestOfficial?.official?.bestTime ?? null,
    bestCompletion: snapshot.bestOfficial?.official?.completionRate ?? 0,
    lineage: opts.lineage ?? null,
    snapshot,
  };
  await db.put('projects', project);
  await db.kvSet('lastProjectId', project.id);
  dataChanged();
  return project;
}
