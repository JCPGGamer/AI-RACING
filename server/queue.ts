import type { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { transaction } from './db.ts';
import { validatePayload, type ValidationOutcome } from './validate.ts';

/**
 * Fila de validação. Estados: aguardando → validando → aprovado | nao_concluiu |
 * rejeitado | erro_temporario. Este é o ÚNICO lugar que escreve tempos oficiais.
 */

export interface QueueOptions {
  /** Executa cada validação numa worker thread com tempo limite (padrão). */
  useWorker?: boolean;
  timeoutMs?: number;
  pollMs?: number;
  maxAttempts?: number;
  onResult?: (submissionId: number, status: string) => void;
}

interface SubmissionRow {
  id: number;
  user_id: number;
  track_id: string;
  category_id: string;
  rules_version: string;
  pilot_name: string;
  payload: string;
  attempts: number;
}

export class ValidationQueue {
  private readonly db: DatabaseSync;
  private readonly opts: Required<Omit<QueueOptions, 'onResult'>> & Pick<QueueOptions, 'onResult'>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(db: DatabaseSync, opts: QueueOptions = {}) {
    this.db = db;
    this.opts = { useWorker: opts.useWorker ?? true, timeoutMs: opts.timeoutMs ?? 20_000, pollMs: opts.pollMs ?? 500, maxAttempts: opts.maxAttempts ?? 2, onResult: opts.onResult };
    // Recuperação após queda: o que estava validando volta para a fila.
    db.prepare("UPDATE submissions SET status = 'aguardando', started_at = NULL WHERE status = 'validando'").run();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((e) => console.error('[validação] erro na fila', e));
    }, this.opts.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Quando true, a fila não processa nada (usado em testes e manutenção). */
  paused = false;

  /** Acorda a fila imediatamente (após um envio novo). */
  kick(): void {
    if (!this.paused) this.tick().catch((e) => console.error('[validação] erro na fila', e));
  }

  pendingCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE status IN ('aguardando', 'validando')").get() as { n: number }).n;
  }

  /** Processa a fila até esvaziar. */
  async drain(): Promise<void> {
    while (await this.processNext()) {
      /* continua */
    }
  }

  private async tick(): Promise<void> {
    if (this.busy || this.paused) return;
    this.busy = true;
    try {
      while (await this.processNext()) {
        /* esvazia a fila */
      }
    } finally {
      this.busy = false;
    }
  }

  async processNext(): Promise<boolean> {
    const row = this.db
      .prepare("SELECT id, user_id, track_id, category_id, rules_version, pilot_name, payload, attempts FROM submissions WHERE status = 'aguardando' ORDER BY created_at, id LIMIT 1")
      .get() as SubmissionRow | undefined;
    if (!row) return false;
    const claimed = this.db
      .prepare("UPDATE submissions SET status = 'validando', started_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'aguardando'")
      .run(Date.now(), row.id);
    if (claimed.changes === 0) return true;
    let outcome: ValidationOutcome | null = null;
    let error: string | null = null;
    try {
      outcome = this.opts.useWorker ? await this.runInWorker(row.payload) : validatePayload(JSON.parse(row.payload));
    } catch (e) {
      error = (e as Error).message;
    }
    try {
      if (outcome) this.store(row, outcome);
      else this.storeError(row, error ?? 'falha desconhecida');
    } catch (e) {
      // Falha ao gravar (ex.: disco cheio): devolve o envio para a fila em vez de derrubar o servidor.
      console.error('[validação] falha ao gravar resultado', e);
      try {
        this.storeError(row, `falha ao gravar: ${(e as Error).message}`);
      } catch {
        /* banco indisponível: o envio volta para a fila no próximo início */
      }
      return false;
    }
    return true;
  }

  private runInWorker(payload: string): Promise<ValidationOutcome> {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('./validator-worker.ts', import.meta.url), {
        workerData: { payload },
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        void w.terminate();
        reject(new Error('A validação passou do tempo limite.'));
      }, this.opts.timeoutMs);
      w.once('message', (m: { ok: boolean; out?: ValidationOutcome; error?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void w.terminate();
        if (m.ok && m.out) resolve(m.out);
        else reject(new Error(m.error ?? 'erro na validação'));
      });
      w.once('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      });
      w.once('exit', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`validador encerrou (código ${code})`));
      });
    });
  }

  private store(row: SubmissionRow, out: ValidationOutcome): void {
    const now = Date.now();
    transaction(this.db, () => {
      if (out.status === 'rejeitado') {
        this.db.prepare("UPDATE submissions SET status = 'rejeitado', message = ?, finished_at = ? WHERE id = ?").run(out.message, now, row.id);
        return;
      }
      if (out.status === 'nao_concluiu') {
        this.db
          .prepare("UPDATE submissions SET status = 'nao_concluiu', official_progress = ?, official_time = NULL, message = ?, finished_at = ? WHERE id = ?")
          .run(out.progress, out.message, now, row.id);
        return;
      }
      // Aprovado: atualiza o recorde só se melhorou.
      const current = this.db
        .prepare('SELECT id, time, replay_id FROM records WHERE user_id = ? AND track_id = ? AND category_id = ? AND rules_version = ?')
        .get(row.user_id, row.track_id, row.category_id, row.rules_version) as { id: number; time: number; replay_id: number | null } | undefined;
      const improved = !current || out.time < current.time;
      let message = improved ? (current ? 'Novo recorde pessoal!' : 'Primeiro recorde nesta pista e categoria!') : 'Volta válida, mas não superou seu recorde.';
      if (improved) {
        const rep = this.db
          .prepare('INSERT INTO replays (submission_id, meta, frames, created_at) VALUES (?, ?, ?, ?)')
          .run(row.id, JSON.stringify(out.replay.meta), out.replay.frames, now);
        const replayId = Number(rep.lastInsertRowid);
        if (current) {
          this.db
            .prepare('UPDATE records SET time = ?, pilot_name = ?, submission_id = ?, replay_id = ?, achieved_at = ? WHERE id = ?')
            .run(out.time, row.pilot_name, row.id, replayId, now, current.id);
          if (current.replay_id) this.db.prepare('DELETE FROM replays WHERE id = ?').run(current.replay_id);
        } else {
          this.db
            .prepare('INSERT INTO records (user_id, track_id, category_id, rules_version, time, pilot_name, submission_id, replay_id, achieved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(row.user_id, row.track_id, row.category_id, row.rules_version, out.time, row.pilot_name, row.id, replayId, now);
        }
      } else {
        message += ` (recorde atual: ${current!.time.toFixed(3)} s)`;
      }
      this.db
        .prepare("UPDATE submissions SET status = 'aprovado', official_time = ?, official_progress = 1, improved = ?, message = ?, finished_at = ? WHERE id = ?")
        .run(out.time, improved ? 1 : 0, message, now, row.id);
    });
    this.opts.onResult?.(row.id, out.status);
  }

  private storeError(row: SubmissionRow, error: string): void {
    const attempts = row.attempts + 1;
    if (attempts < this.opts.maxAttempts) {
      this.db.prepare("UPDATE submissions SET status = 'aguardando', message = ? WHERE id = ?").run(`Nova tentativa após erro: ${error}`, row.id);
      return;
    }
    this.db
      .prepare("UPDATE submissions SET status = 'erro_temporario', message = ?, finished_at = ? WHERE id = ?")
      .run(`Erro temporário na validação (${error}). Envie novamente mais tarde.`, Date.now(), row.id);
    this.opts.onResult?.(row.id, 'erro_temporario');
  }
}
