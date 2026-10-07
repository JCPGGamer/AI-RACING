import { audio } from '../audio/audio.ts';
import type { CandidateResult, CoachMessage } from '../core/coach.ts';
import { sanitizeCoachConfig } from '../core/coach.ts';
import { newId, PILOT_COLORS, type CoachRecord, type PilotRecord } from '../core/models.ts';
import { db } from '../persistence/db.ts';
import { dataChanged, toast } from '../ui/store.ts';
import type { TrackDef } from '../core/track.ts';
import type { CoachIn, CoachOut, CoachProgressMsg, LiveFrame } from '../workers/protocol.ts';
import { resolveTrackDefs } from './tracks.ts';

/** Sessão da IA treinadora (worker próprio, salva o progresso para retomar depois). */

export interface CoachView {
  record: CoachRecord;
  running: boolean;
  messages: CoachMessage[];
  candidates: CandidateResult[];
  bestIndex: number;
  finished: boolean;
  progress: CoachProgressMsg | null;
  currentTrackId: string | null;
  error: string | null;
  ready: boolean;
}

let current: CoachSession | null = null;
const globalListeners = new Set<() => void>();
export function getCoach(): CoachSession | null {
  return current;
}
export function onCoachChange(fn: () => void): () => void {
  globalListeners.add(fn);
  return () => globalListeners.delete(fn);
}

export class CoachSession {
  view: CoachView;
  frame: LiveFrame | null = null;
  private worker: Worker;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSave = 0;
  private reqId = 1;
  private waiters = new Map<number, (s: CoachRecord['snapshot']) => void>();
  private disposed = false;

  private constructor(record: CoachRecord, defs: TrackDef[]) {
    this.view = {
      record,
      running: false,
      messages: record.snapshot?.messages ?? [],
      candidates: record.snapshot?.candidates ?? [],
      bestIndex: record.snapshot?.bestIndex ?? -1,
      finished: record.snapshot?.finished ?? false,
      progress: null,
      currentTrackId: null,
      error: null,
      ready: false,
    };
    this.worker = new Worker(new URL('../workers/coach.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<CoachOut>) => this.onMessage(e.data);
    this.worker.onerror = (e) => this.patch({ error: e.message, running: false }, true);
    this.post({ type: 'init', config: record.config, trackDefs: defs, snapshot: record.snapshot });
  }

  static async open(id: string): Promise<CoachSession> {
    if (current && current.view.record.id === id && !current.disposed) return current;
    const rec = await db.get<CoachRecord>('coaches', id);
    if (!rec) throw new Error('Treinadora não encontrada.');
    const ids = [...new Set([...rec.config.trainTracks, ...rec.config.valTracks, ...rec.config.testTracks])];
    const defs = rec.snapshot?.trackDefs?.length ? rec.snapshot.trackDefs : await resolveTrackDefs(ids);
    if (current) await current.close();
    current = new CoachSession(rec, defs);
    for (const l of globalListeners) l();
    return current;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  getView = (): CoachView => this.view;

  private patch(p: Partial<CoachView>, immediate = false) {
    this.view = { ...this.view, ...p };
    if (immediate) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      for (const l of this.listeners) l();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        for (const l of this.listeners) l();
      }, 250);
    }
  }

  private post(m: CoachIn) {
    this.worker.postMessage(m);
  }

  private onMessage(m: CoachOut) {
    switch (m.type) {
      case 'ready':
        this.patch({ ready: true, messages: m.messages, candidates: m.candidates, bestIndex: m.bestIndex, finished: m.finished, progress: m.progress }, true);
        break;
      case 'progress':
        if (m.frame) this.frame = m.frame;
        this.patch({ progress: m.progress, currentTrackId: m.currentTrackId, messages: m.newMessages.length ? [...this.view.messages, ...m.newMessages].slice(-300) : this.view.messages });
        if (m.newMessages.some((x) => x.kind === 'melhoria')) audio.record();
        if (performance.now() - this.lastSave > 15000) {
          this.lastSave = performance.now();
          void this.saveNow();
        }
        break;
      case 'candidates':
        this.patch({ candidates: m.candidates, bestIndex: m.bestIndex }, true);
        break;
      case 'done': {
        const status = m.stopReason.startsWith('Cancelada') ? 'cancelada' : 'concluida';
        void this.persist(m.snapshot, status);
        this.patch({ finished: true, running: false }, true);
        audio.approved();
        toast(`Treinadora: ${m.stopReason}`, 'sucesso', 6000);
        break;
      }
      case 'snapshot': {
        const w = this.waiters.get(m.reqId);
        if (w) {
          this.waiters.delete(m.reqId);
          w(m.snapshot);
        }
        break;
      }
      case 'state':
        this.patch({ running: m.running }, true);
        break;
      case 'error':
        this.patch({ error: m.message, running: false }, true);
        toast(`Treinadora: ${m.message}`, 'erro', 7000);
        break;
    }
  }

  run() {
    if (this.view.finished) return;
    audio.start();
    this.post({ type: 'run' });
    void this.setStatus('rodando');
  }

  pause() {
    this.post({ type: 'pause' });
    void this.saveNow('pausada');
  }

  cancel() {
    this.post({ type: 'cancel' });
  }

  setView(on: boolean) {
    this.post({ type: 'view', on });
  }

  private async setStatus(status: CoachRecord['status']) {
    const rec = { ...this.view.record, status, updatedAt: Date.now() };
    this.patch({ record: rec }, true);
    await db.put('coaches', rec);
    dataChanged();
  }

  async saveNow(status?: CoachRecord['status']): Promise<void> {
    if (this.disposed || !this.view.ready) return;
    const reqId = this.reqId++;
    const snap = await new Promise<CoachRecord['snapshot']>((resolve) => {
      this.waiters.set(reqId, resolve);
      this.post({ type: 'snapshot', reqId });
      setTimeout(() => {
        if (this.waiters.delete(reqId)) resolve(null);
      }, 10000);
    });
    if (snap) await this.persist(snap, status ?? (this.view.running ? 'rodando' : this.view.record.status === 'rodando' ? 'pausada' : this.view.record.status));
  }

  private async persist(snapshot: NonNullable<CoachRecord['snapshot']>, status: CoachRecord['status']) {
    const rec: CoachRecord = { ...this.view.record, snapshot, status, updatedAt: Date.now() };
    try {
      await db.put('coaches', rec);
      this.patch({ record: rec }, true);
      dataChanged();
    } catch (e) {
      toast((e as Error).message, 'erro', 8000);
    }
  }

  /** Salva o melhor piloto encontrado pela treinadora na garagem. */
  async saveBestPilot(): Promise<PilotRecord | null> {
    const best = this.view.candidates.find((c) => c.index === this.view.bestIndex);
    if (!best) {
      toast('A treinadora ainda não terminou nenhum experimento.', 'aviso');
      return null;
    }
    const existing = await db.getAll<PilotRecord>('pilots');
    const now = Date.now();
    const pilot: PilotRecord = {
      id: newId('piloto'),
      name: `${this.view.record.name} · exp. ${best.index}`,
      color: PILOT_COLORS[existing.length % PILOT_COLORS.length],
      brain: { inputs: { ...best.config.inputs }, hidden: [...best.config.hidden], genome: best.bestGenome.slice() },
      origin: { kind: 'treinadora', coachId: this.view.record.id, coachName: this.view.record.name, experiment: best.index, trackIds: [...best.config.trackIds] },
      evaluations: best.byTrack.map((b) => ({ trackId: b.trackId, trackName: b.trackId, trackVersion: 1, attempts: b.result.attempts.length, result: b.result, date: now })),
      bestReplay: null,
      createdAt: now,
      updatedAt: now,
    };
    await db.put('pilots', pilot);
    dataChanged();
    toast(`"${pilot.name}" salvo na Garagem.`, 'sucesso');
    return pilot;
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    if (this.view.running) await this.saveNow('pausada');
    this.dispose();
  }

  dispose() {
    this.disposed = true;
    this.worker.terminate();
    if (current === this) {
      current = null;
      for (const l of globalListeners) l();
    }
  }
}

export async function createCoachRecord(name: string, config: CoachRecord['config']): Promise<CoachRecord> {
  const { config: cfg, warnings } = sanitizeCoachConfig(config);
  const now = Date.now();
  const rec: CoachRecord = { id: newId('treinadora'), name: name.trim().slice(0, 60) || 'Treinadora', createdAt: now, updatedAt: now, config: { ...cfg, name }, status: 'nova', snapshot: null };
  await db.put('coaches', rec);
  dataChanged();
  if (warnings.length) toast(warnings.join(' '), 'aviso', 7000);
  return rec;
}
