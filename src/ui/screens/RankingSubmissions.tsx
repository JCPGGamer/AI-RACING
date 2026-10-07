import type { RankingMeta } from '../../online/api.ts';
import { useOnline } from '../../online/session.ts';
import { Empty, Loading, fmtDate, fmtTime } from '../components.tsx';
import { AccountPanel } from './RankingAccount.tsx';
import { OnlineBadge, RankingUnavailable, categoryLabel, statusBadge, statusLabel, trackLabel } from './rankingShared.tsx';
import { isPendingStatus, refreshSubmissions, useSubmissions } from './submissionWatcher.ts';

/** Estado das submissões do jogador conectado (atualiza sozinho enquanto há fila). */
export function SubmissionsPanel(props: { meta: RankingMeta | null; onGoSubmit: () => void }) {
  const online = useOnline();
  const subs = useSubmissions();

  if (!online.user) {
    return (
      <section className="panel stack" aria-label="Estado das submissões">
        <div className="panel-title">
          <h3>Estado das submissões</h3>
          <OnlineBadge />
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Entre com seu apelido para ver o estado dos pilotos que você enviou.
        </p>
        <AccountPanel embedded />
      </section>
    );
  }

  const list = subs.list;
  return (
    <section className="panel stack" aria-label="Estado das submissões">
      <div className="panel-title">
        <h3>Estado das submissões</h3>
        <div className="row">
          <OnlineBadge />
          <button type="button" className="btn small" onClick={() => void refreshSubmissions()} disabled={subs.loading}>
            {subs.loading ? <span className="spinner" aria-hidden /> : '⟳'} Atualizar
          </button>
        </div>
      </div>

      {subs.polling && (
        <p className="row muted" role="status" style={{ margin: 0 }}>
          <span className="spinner" aria-hidden /> Há envios na fila. Esta lista se atualiza sozinha a cada 4 segundos. Você pode continuar treinando: avisaremos quando
          terminar.
        </p>
      )}

      {list === null && !subs.error && <Loading text="Buscando seus envios…" />}
      {list === null &&
        subs.error &&
        (subs.offline ? (
          <RankingUnavailable message={subs.error} onRetry={() => void refreshSubmissions()} />
        ) : (
          <div className="callout err" role="alert">
            {subs.error}
          </div>
        ))}
      {list !== null && subs.error && <div className="callout warn">Não foi possível atualizar agora: {subs.error}</div>}

      {list && list.length === 0 && (
        <Empty icon="📭" title="Você ainda não enviou nenhum piloto.">
          <p>Escolha um piloto da garagem e envie para o ranking. O servidor confere a volta e calcula o tempo oficial.</p>
          <button type="button" className="btn primary" onClick={props.onGoSubmit}>
            Enviar piloto
          </button>
        </Empty>
      )}

      {list && list.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Seus envios ao ranking, do mais recente para o mais antigo</caption>
            <thead>
              <tr>
                <th scope="col">Enviado em</th>
                <th scope="col">Piloto</th>
                <th scope="col">Pista</th>
                <th scope="col">Categoria</th>
                <th scope="col">Estado</th>
                <th scope="col" className="num">
                  Tempo oficial
                </th>
                <th scope="col">Mensagem do servidor</th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id}>
                  <td>{fmtDate(s.createdAt)}</td>
                  <td>{s.pilotName}</td>
                  <td>{trackLabel(s.trackId, props.meta)}</td>
                  <td>{categoryLabel(s.categoryId, props.meta)}</td>
                  <td>
                    <span className={`badge ${statusBadge(s.status)}`}>
                      {isPendingStatus(s.status) && <span className="spinner" aria-hidden style={{ width: 10, height: 10, borderWidth: 2 }} />}
                      {statusLabel(s.status)}
                    </span>
                  </td>
                  <td className="num mono">{s.status === 'aprovado' ? fmtTime(s.officialTime) : '—'}</td>
                  <td>
                    {s.status === 'aprovado' && s.improved && <span aria-hidden>🏆 </span>}
                    {s.message ?? (isPendingStatus(s.status) ? 'Na fila de validação do servidor.' : '')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="field-hint" style={{ margin: 0 }}>
        Mostra seus 50 envios mais recentes. Uma cópia fica guardada neste navegador para a tela de Resultados, mas o resultado que vale é sempre o do servidor.
        {subs.updatedAt > 0 && ` Última atualização às ${new Date(subs.updatedAt).toLocaleTimeString('pt-BR')}.`}
      </p>
    </section>
  );
}
