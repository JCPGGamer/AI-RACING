import { useSyncExternalStore } from 'react';
import { audio } from '../../audio/audio.ts';
import type { LocalSubmission } from '../../core/models.ts';
import type { Submission } from '../../online/api.ts';
import { api, clearSession, getOnline } from '../../online/session.ts';
import { db } from '../../persistence/db.ts';
import { fmtTime } from '../components.tsx';
import { dataChanged, toast } from '../store.ts';
import { categoryLabel, statusLabel, trackLabel } from './rankingShared.tsx';

/**
 * Acompanha os envios do jogador ao ranking.
 *
 * - Busca a lista no servidor e, enquanto houver envio "Aguardando" ou
 *   "Validando", atualiza sozinha a cada 4 segundos.
 * - Continua rodando mesmo fora da tela de ranking: o jogador pode voltar a
 *   treinar e recebe o aviso (som + mensagem) quando o servidor terminar.
 * - Guarda uma cópia local (IndexedDB, loja "submissions") para a tela de
 *   Resultados. É só um espelho: quem decide o resultado é o servidor.
 */

export const POLL_MS = 4000;
const RETRY_MS = 10_000;

const PENDING = new Set(['aguardando', 'validando']);

export function isPendingStatus(s: string): boolean {
  return PENDING.has(s);
}

export interface SubmissionsState {
  /** Conta dona da lista (null = ninguém conectado) */
  userId: number | null;
  /** null enquanto ainda não carregou */
  list: Submission[] | null;
  loading: boolean;
  error: string | null;
  offline: boolean;
  /** true enquanto há envios na fila e a lista se atualiza sozinha */
  polling: boolean;
  updatedAt: number;
}

const EMPTY: SubmissionsState = { userId: null, list: null, loading: false, error: null, offline: false, polling: false, updatedAt: 0 };

let state: SubmissionsState = EMPTY;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function set(p: Partial<SubmissionsState>): void {
  state = { ...state, ...p };
  emit();
}

export function useSubmissions(): SubmissionsState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );
}

export function getSubmissionsState(): SubmissionsState {
  return state;
}

/** Último estado conhecido de cada envio (para perceber quando termina). */
const knownStatus = new Map<number, string>();
/** Assinatura do que já foi copiado para o armazenamento local. */
const mirroredSig = new Map<number, string>();
/** Piloto da garagem que originou cada envio (o servidor não sabe disso). */
const pilotIdByServerId = new Map<number, string>();
/** Envios feitos agora há pouco que o servidor ainda não listou. */
const justSent = new Set<number>();

let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> | null = null;
let inflightGen = -1;
/** Muda a cada troca de conta: respostas antigas são ignoradas. */
let generation = 0;
let mirrorChain: Promise<void> = Promise.resolve();

function stopTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Esquece tudo (ao sair da conta ou trocar de conta). A cópia local fica. */
export function resetSubmissions(): void {
  generation++;
  stopTimer();
  knownStatus.clear();
  mirroredSig.clear();
  pilotIdByServerId.clear();
  justSent.clear();
  state = EMPTY;
  emit();
}

function schedule(ms: number): void {
  stopTimer();
  const pending = state.userId !== null && !!state.list?.some((s) => isPendingStatus(s.status));
  if (pending) {
    const gen = generation;
    timer = setTimeout(() => {
      timer = null;
      if (gen === generation) void refreshSubmissions();
    }, ms);
  }
  if (state.polling !== pending) set({ polling: pending });
}

/** Busca a lista de envios agora (e agenda a próxima busca se houver fila). */
export function refreshSubmissions(): Promise<void> {
  const user = getOnline().user;
  if (!user) {
    if (state.userId !== null || state.list !== null) resetSubmissions();
    return Promise.resolve();
  }
  if (state.userId !== user.id) {
    resetSubmissions();
    set({ userId: user.id });
  }
  if (inflight && inflightGen === generation) return inflight;
  stopTimer();
  const gen = generation;
  set({ loading: true });
  const p = (async () => {
    const r = await api.submissions();
    if (gen !== generation) return;
    if (!r.ok) {
      if (r.status === 401) {
        clearSession();
        resetSubmissions();
        set({ error: 'Sua sessão terminou. Entre de novo para ver seus envios.' });
        return;
      }
      set({ loading: false, error: r.error, offline: r.offline });
      schedule(RETRY_MS);
      return;
    }
    const list = r.data.submissions.slice();
    // Um envio recém-feito pode não vir numa resposta que já estava a caminho: mantém até aparecer.
    for (const id of [...justSent]) {
      if (list.some((s) => s.id === id)) justSent.delete(id);
      else {
        const local = state.list?.find((s) => s.id === id);
        if (local) list.unshift(local);
        else justSent.delete(id);
      }
    }
    for (const s of list) {
      const prev = knownStatus.get(s.id);
      if (prev !== undefined && isPendingStatus(prev) && !isPendingStatus(s.status)) announce(s);
      knownStatus.set(s.id, s.status);
    }
    set({ list, loading: false, error: null, offline: false, updatedAt: Date.now() });
    mirror(list);
    schedule(POLL_MS);
  })().finally(() => {
    if (inflight === p) inflight = null;
  });
  inflight = p;
  inflightGen = gen;
  return p;
}

/** Registra um envio recém-feito e começa a acompanhá-lo. */
export function watchNewSubmission(sub: Submission, pilotId?: string): void {
  const user = getOnline().user;
  if (!user) return;
  if (state.userId !== user.id) {
    resetSubmissions();
    set({ userId: user.id });
  }
  if (pilotId) pilotIdByServerId.set(sub.id, pilotId);
  knownStatus.set(sub.id, sub.status);
  justSent.add(sub.id);
  const list = [sub, ...(state.list ?? []).filter((s) => s.id !== sub.id)];
  set({ list });
  mirror([sub]);
  schedule(POLL_MS);
}

function announce(s: Submission): void {
  const where = `${trackLabel(s.trackId)} · ${categoryLabel(s.categoryId)}`;
  if (s.status === 'aprovado') {
    if (s.improved) audio.approved();
    else audio.lap();
    toast(
      `✔ "${s.pilotName}" foi aprovado em ${where}. Tempo oficial: ${fmtTime(s.officialTime)}. ${
        s.improved ? 'Seu recorde no ranking melhorou!' : 'Não superou seu melhor tempo anterior no ranking.'
      }`,
      'sucesso',
      9000,
    );
    return;
  }
  audio.error();
  toast(`"${s.pilotName}" (${where}): ${statusLabel(s.status)}.${s.message ? ` ${s.message}` : ''}`, s.status === 'erro_temporario' ? 'aviso' : 'erro', 9000);
}

function signature(s: Submission): string {
  return [s.status, s.officialTime ?? '', s.message ?? '', s.finishedAt ?? '', pilotIdByServerId.get(s.id) ?? ''].join('|');
}

/** Copia os envios para o armazenamento local (só o que mudou). */
function mirror(list: Submission[]): void {
  const items = list.filter((s) => mirroredSig.get(s.id) !== signature(s));
  if (!items.length) return;
  mirrorChain = mirrorChain
    .then(async () => {
      let changed = false;
      for (const s of items) {
        const sig = signature(s);
        if (mirroredSig.get(s.id) === sig) continue;
        const id = `sub-${s.id}`;
        const prev = await db.get<LocalSubmission>('submissions', id);
        const rec: LocalSubmission = {
          id,
          serverId: s.id,
          trackId: s.trackId,
          categoryId: s.categoryId,
          pilotName: s.pilotName,
          pilotId: pilotIdByServerId.get(s.id) ?? prev?.pilotId,
          status: s.status,
          createdAt: s.createdAt,
          updatedAt: s.finishedAt ?? s.createdAt,
          officialTime: s.officialTime,
          message: s.message ?? undefined,
        };
        const same =
          prev &&
          prev.status === rec.status &&
          (prev.officialTime ?? null) === (rec.officialTime ?? null) &&
          (prev.message ?? '') === (rec.message ?? '') &&
          prev.pilotId === rec.pilotId &&
          prev.updatedAt === rec.updatedAt;
        if (!same) {
          await db.put('submissions', rec);
          changed = true;
        }
        mirroredSig.set(s.id, sig);
      }
      if (changed) dataChanged();
    })
    .catch(() => {
      /* sem armazenamento local: a cópia é opcional, o ranking segue no servidor */
    });
}
