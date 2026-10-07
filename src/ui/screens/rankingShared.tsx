import { useState } from 'react';
import { getBuiltinTrack } from '../../core/builtinTracks.ts';
import { getCategory } from '../../core/rules.ts';
import { OFFLINE_MESSAGE, SUBMISSION_STATUS_LABEL, type RankingMeta, type SubmissionStatus } from '../../online/api.ts';
import { checkOnline } from '../../online/session.ts';

/** Pequenas peças compartilhadas pelas partes da tela de ranking online. */

export type Loadable<T> = { status: 'loading' } | { status: 'ok'; data: T } | { status: 'error'; error: string; offline: boolean };

export function trackLabel(id: string, meta?: RankingMeta | null): string {
  return meta?.tracks.find((t) => t.id === id)?.name ?? getBuiltinTrack(id)?.name ?? id;
}

export function categoryLabel(id: string, meta?: RankingMeta | null): string {
  return meta?.categories.find((c) => c.id === id)?.name ?? getCategory(id)?.name ?? id;
}

export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`;
}

export const STATUS_BADGE: Record<SubmissionStatus, string> = {
  aguardando: 'info',
  validando: 'info',
  aprovado: 'ok',
  nao_concluiu: 'warn',
  rejeitado: 'err',
  erro_temporario: 'warn',
};

export function statusLabel(s: string): string {
  return SUBMISSION_STATUS_LABEL[s as SubmissionStatus] ?? s;
}

export function statusBadge(s: string): string {
  return STATUS_BADGE[s as SubmissionStatus] ?? '';
}

export function OnlineBadge() {
  return (
    <span className="badge online" title="Dados do servidor do ranking, validados com as regras oficiais">
      🌐 Online / oficial
    </span>
  );
}

export function LocalBadge() {
  return (
    <span className="badge local" title="Calculado neste computador. Não conta para o ranking.">
      💻 Local
    </span>
  );
}

/**
 * Aviso de falha de conexão. Nunca mostra dados locais no lugar do ranking:
 * só explica e oferece "Tentar novamente".
 */
export function RankingUnavailable(props: { message?: string | null; onRetry?: () => void; title?: string }) {
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    try {
      await checkOnline();
    } finally {
      setBusy(false);
    }
    props.onRetry?.();
  };
  return (
    <div className="callout err stack" role="alert">
      <h3 style={{ margin: 0 }}>{props.title ?? 'Ranking online indisponível'}</h3>
      <p style={{ margin: 0 }}>{props.message || OFFLINE_MESSAGE}</p>
      <p className="field-hint" style={{ margin: 0 }}>
        O resto do jogo continua funcionando: você pode treinar, testar e salvar pilotos normalmente.
      </p>
      <div>
        <button type="button" className="btn primary" onClick={() => void retry()} disabled={busy}>
          {busy ? (
            <>
              <span className="spinner" aria-hidden /> Tentando…
            </>
          ) : (
            '⟳ Tentar novamente'
          )}
        </button>
      </div>
    </div>
  );
}
