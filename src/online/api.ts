import type { Category } from '../core/rules.ts';
import type { SubmissionPayload } from '../core/official.ts';

/**
 * Cliente da API do ranking. Separado do resto do jogo: se o servidor não
 * responder, o jogo continua funcionando e só as telas online mostram
 * "Ranking online indisponível".
 */

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string; offline: boolean };

export interface RankingUser {
  id: number;
  nickname: string;
}

export interface LeaderboardRow {
  position: number;
  recordId: number;
  nickname: string;
  pilotName: string;
  time: number;
  achievedAt: number;
  validated: boolean;
  hasReplay?: boolean;
}

export interface LeaderboardPage {
  track: string;
  category: string;
  version: string;
  current: boolean;
  total: number;
  page: number;
  pageSize: number;
  rows: LeaderboardRow[];
}

export interface MetaTrack {
  id: string;
  name: string;
  version: number;
  difficulty?: number;
  hash: string;
  rulesVersion: string;
  rules: { categoryId: string; items: { label: string; value: string }[] }[];
}

export interface RankingMeta {
  categories: Category[];
  tracks: MetaTrack[];
  versions: { trackId: string; categoryId: string; rulesVersion: string; count: number }[];
}

export type SubmissionStatus = 'aguardando' | 'validando' | 'aprovado' | 'nao_concluiu' | 'rejeitado' | 'erro_temporario';

export const SUBMISSION_STATUS_LABEL: Record<SubmissionStatus, string> = {
  aguardando: 'Aguardando',
  validando: 'Validando',
  aprovado: 'Aprovado',
  nao_concluiu: 'Não concluiu',
  rejeitado: 'Rejeitado por configuração inválida',
  erro_temporario: 'Erro temporário',
};

export interface Submission {
  id: number;
  trackId: string;
  categoryId: string;
  rulesVersion: string;
  pilotName: string;
  status: SubmissionStatus;
  officialTime: number | null;
  officialProgress: number | null;
  message: string | null;
  improved: boolean;
  createdAt: number;
  finishedAt: number | null;
}

export interface RecordDetail {
  recordId: number;
  nickname: string;
  pilotName: string;
  time: number;
  trackId: string;
  categoryId: string;
  rulesVersion: string;
  achievedAt: number;
  submittedAt: number;
  validatedAt: number;
  hasReplay: boolean;
  validated: boolean;
  rules: { label: string; value: string }[];
}

export interface OfficialReplayDto {
  meta: Record<string, unknown>;
  frames: string;
}

export const OFFLINE_MESSAGE = 'Ranking online indisponível. Verifique sua conexão ou tente mais tarde.';

export class RankingApi {
  private readonly base: string;
  private readonly getToken: () => string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, getToken: () => string | null, fetchImpl: typeof fetch = (...a) => fetch(...a), timeoutMs = 12000) {
    this.base = baseUrl.replace(/\/$/, '');
    this.getToken = getToken;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  private async req<T>(method: 'GET' | 'POST', path: string, body?: unknown, auth = false): Promise<ApiResult<T>> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = this.getToken();
    if (token && (auth || path.startsWith('/api/auth') || path.startsWith('/api/submissions') || path.includes('/me'))) headers.Authorization = `Bearer ${token}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal });
    } catch {
      clearTimeout(timer);
      return { ok: false, status: 0, error: OFFLINE_MESSAGE, offline: true };
    }
    clearTimeout(timer);
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      return { ok: false, status: res.status, error: res.status >= 500 || res.status === 404 ? OFFLINE_MESSAGE : 'Resposta inválida do servidor.', offline: res.status >= 500 || res.status === 404 };
    }
    if (!res.ok) {
      const err = (data as { error?: string } | null)?.error ?? `Erro ${res.status}.`;
      return { ok: false, status: res.status, error: err, offline: res.status >= 502 };
    }
    return { ok: true, data: data as T };
  }

  health() {
    return this.req<{ ok: boolean; rulesVersion: number; physicsVersion: number; queue: number }>('GET', '/api/health');
  }
  meta() {
    return this.req<RankingMeta>('GET', '/api/meta');
  }
  leaderboard(p: { track: string; category: string; version?: string; page?: number; pageSize?: number }) {
    const q = new URLSearchParams({ track: p.track, category: p.category, page: String(p.page ?? 1), pageSize: String(p.pageSize ?? 20) });
    if (p.version) q.set('version', p.version);
    return this.req<LeaderboardPage>('GET', `/api/leaderboard?${q}`);
  }
  myPosition(p: { track: string; category: string; version?: string }) {
    const q = new URLSearchParams({ track: p.track, category: p.category });
    if (p.version) q.set('version', p.version);
    return this.req<{ position: number | null; total: number; row: LeaderboardRow | null }>('GET', `/api/leaderboard/me?${q}`, undefined, true);
  }
  record(id: number) {
    return this.req<RecordDetail>('GET', `/api/records/${id}`);
  }
  replay(recordId: number) {
    return this.req<OfficialReplayDto>('GET', `/api/records/${recordId}/replay`);
  }
  register(nickname: string, password: string) {
    return this.req<{ token: string; user: RankingUser }>('POST', '/api/auth/register', { nickname, password });
  }
  login(nickname: string, password: string) {
    return this.req<{ token: string; user: RankingUser }>('POST', '/api/auth/login', { nickname, password });
  }
  logout() {
    return this.req<{ ok: boolean }>('POST', '/api/auth/logout', {}, true);
  }
  me() {
    return this.req<{ user: RankingUser }>('GET', '/api/auth/me', undefined, true);
  }
  submit(payload: SubmissionPayload) {
    return this.req<{ submission: Submission }>('POST', '/api/submissions', payload, true);
  }
  submissions() {
    return this.req<{ submissions: Submission[] }>('GET', '/api/submissions', undefined, true);
  }
  submission(id: number) {
    return this.req<{ submission: Submission }>('GET', `/api/submissions/${id}`, undefined, true);
  }
}
