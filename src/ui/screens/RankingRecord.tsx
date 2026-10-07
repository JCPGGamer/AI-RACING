import { Fragment, useEffect, useMemo, useState } from 'react';
import { base64ToFloat32 } from '../../core/nn.ts';
import { officialTrack } from '../../core/official.ts';
import type { Replay } from '../../core/replay.ts';
import { rulesKey } from '../../core/rules.ts';
import type { RankingMeta, RecordDetail } from '../../online/api.ts';
import { api } from '../../online/session.ts';
import { ReplayPlayer, type ReplayEntry } from '../ReplayPlayer.tsx';
import { Loading, Modal, fmtDate, fmtTime } from '../components.tsx';
import { OnlineBadge, RankingUnavailable, categoryLabel, trackLabel, type Loadable } from './rankingShared.tsx';

/** Detalhes de um recorde do ranking, com as regras usadas e o replay oficial. */
export function RecordModal(props: { recordId: number; meta: RankingMeta | null; onClose: () => void }) {
  const [detail, setDetail] = useState<Loadable<RecordDetail>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  const [replay, setReplay] = useState<Loadable<Replay> | null>(null);

  useEffect(() => {
    let alive = true;
    setDetail({ status: 'loading' });
    setReplay(null);
    void api.record(props.recordId).then((r) => {
      if (!alive) return;
      setDetail(r.ok ? { status: 'ok', data: r.data } : { status: 'error', error: r.status === 404 ? 'Este recorde não existe mais.' : r.error, offline: r.offline });
    });
    return () => {
      alive = false;
    };
  }, [props.recordId, nonce]);

  const loadReplay = async () => {
    setReplay({ status: 'loading' });
    const r = await api.replay(props.recordId);
    if (!r.ok) {
      setReplay({ status: 'error', error: r.status === 404 ? 'O replay oficial deste recorde não está disponível.' : r.error, offline: r.offline && r.status !== 404 });
      return;
    }
    try {
      const frames = base64ToFloat32(r.data.frames);
      setReplay({ status: 'ok', data: { meta: r.data.meta as unknown as Replay['meta'], frames } });
    } catch {
      setReplay({ status: 'error', error: 'O replay recebido está com defeito e não pode ser exibido.', offline: false });
    }
  };

  const d = detail.status === 'ok' ? detail.data : null;
  const track = d ? officialTrack(d.trackId) : null;
  const currentVersion = d ? (props.meta?.tracks.find((t) => t.id === d.trackId)?.rulesVersion ?? (track ? rulesKey(track.def) : null)) : null;
  const historical = !!d && currentVersion !== null && d.rulesVersion !== currentVersion;

  const entries = useMemo<ReplayEntry[]>(() => {
    if (!d || replay?.status !== 'ok') return [];
    const color = typeof replay.data.meta.color === 'string' && replay.data.meta.color ? replay.data.meta.color : '#ffd43b';
    return [{ replay: replay.data, label: `${d.nickname} · ${d.pilotName}`, color }];
  }, [d, replay]);

  return (
    <Modal
      title={d ? `Recorde de ${d.nickname}` : 'Detalhes do recorde'}
      onClose={props.onClose}
      wide={replay?.status === 'ok'}
      footer={
        <button type="button" className="btn" onClick={props.onClose}>
          Fechar
        </button>
      }
    >
      {detail.status === 'loading' && <Loading text="Buscando o recorde…" />}
      {detail.status === 'error' &&
        (detail.offline ? (
          <RankingUnavailable message={detail.error} onRetry={() => setNonce((n) => n + 1)} />
        ) : (
          <div className="callout err" role="alert">
            {detail.error}
          </div>
        ))}
      {d && (
        <div className="stack">
          <div className="row">
            <OnlineBadge />
            {d.validated && <span className="badge ok">✔ Validado pelo servidor</span>}
            {historical && <span className="badge warn">Recorde antigo (histórico)</span>}
          </div>
          <dl className="kv">
            <dt>Apelido</dt>
            <dd>{d.nickname}</dd>
            <dt>Piloto</dt>
            <dd>{d.pilotName}</dd>
            <dt>Tempo oficial</dt>
            <dd className="mono">
              <strong>{fmtTime(d.time)}</strong>
            </dd>
            <dt>Pista</dt>
            <dd>{trackLabel(d.trackId, props.meta)}</dd>
            <dt>Categoria</dt>
            <dd>{categoryLabel(d.categoryId, props.meta)}</dd>
            <dt>Versão das regras</dt>
            <dd className="mono">
              {d.rulesVersion} {historical ? '(histórico)' : '(atual)'}
            </dd>
            <dt>Recorde feito em</dt>
            <dd>{fmtDate(d.achievedAt)}</dd>
            <dt>Enviado em</dt>
            <dd>{fmtDate(d.submittedAt)}</dd>
            <dt>Validado em</dt>
            <dd>{fmtDate(d.validatedAt)}</dd>
          </dl>
          <p className="field-hint" style={{ margin: 0 }}>
            O tempo foi calculado pelo servidor, que correu a volta de novo com as regras oficiais. Tempos medidos no computador do jogador não contam.
          </p>

          <section className="panel tight" aria-label="Regras usadas">
            <h4>Regras oficiais da categoria</h4>
            {historical && (
              <p className="field-hint">Este recorde é de uma versão anterior. A lista abaixo mostra as regras como estão hoje; a versão do recorde é {d.rulesVersion}.</p>
            )}
            {d.rules.length ? (
              <dl className="kv">
                {d.rules.map((r) => (
                  <Fragment key={r.label}>
                    <dt>{r.label}</dt>
                    <dd>{r.value}</dd>
                  </Fragment>
                ))}
              </dl>
            ) : (
              <p className="muted">O servidor não informou as regras deste recorde.</p>
            )}
          </section>

          <section className="stack" aria-label="Replay oficial">
            {replay === null && (
              <div className="row">
                <button type="button" className="btn primary" onClick={() => void loadReplay()} disabled={!d.hasReplay}>
                  ▶ Assistir replay oficial
                </button>
                {!d.hasReplay && <span className="muted">Este recorde não tem replay guardado.</span>}
              </div>
            )}
            {replay?.status === 'loading' && <Loading text="Baixando o replay oficial…" />}
            {replay?.status === 'error' &&
              (replay.offline ? (
                <RankingUnavailable message={replay.error} onRetry={() => void loadReplay()} />
              ) : (
                <div className="callout err" role="alert">
                  {replay.error}{' '}
                  <button type="button" className="btn small" onClick={() => void loadReplay()}>
                    Tentar de novo
                  </button>
                </div>
              ))}
            {replay?.status === 'ok' &&
              (track ? (
                <>
                  <div className="row">
                    <h4 style={{ margin: 0 }}>Replay oficial</h4>
                    <OnlineBadge />
                  </div>
                  <ReplayPlayer track={track} entries={entries} height={380} />
                </>
              ) : (
                <div className="callout warn">A pista deste recorde não existe nesta versão do jogo, então o replay não pode ser desenhado.</div>
              ))}
          </section>
        </div>
      )}
    </Modal>
  );
}
