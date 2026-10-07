import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { audio } from '../../audio/audio.ts';
import type { PilotRecord } from '../../core/models.ts';
import { describeArch, paramCount } from '../../core/nn.ts';
import { buildSubmission, officialTrack, type OfficialRun, type SubmissionPayload } from '../../core/official.ts';
import { CATEGORIES, checkBrainForCategory, describeRules, eligibleCategories, getCategory, OFFICIAL_TRACK_IDS, rulesKey } from '../../core/rules.ts';
import { END_REASON_LABEL } from '../../core/sim.ts';
import { officialCheck } from '../../lab/evalClient.ts';
import type { RankingMeta, Submission } from '../../online/api.ts';
import { api, clearSession, useOnline } from '../../online/session.ts';
import { db } from '../../persistence/db.ts';
import { ReplayPlayer, type ReplayEntry } from '../ReplayPlayer.tsx';
import { Empty, Loading, Seg, Stat, fmtPct, fmtTime, useAsync } from '../components.tsx';
import { navigate, toast } from '../store.ts';
import { AccountPanel } from './RankingAccount.tsx';
import { LocalBadge, OnlineBadge, RankingUnavailable, statusBadge, statusLabel, trackLabel } from './rankingShared.tsx';
import { isPendingStatus, useSubmissions, watchNewSubmission } from './submissionWatcher.ts';

/**
 * "Enviar piloto para o ranking": escolhe piloto, pista oficial e categoria,
 * confere as regras, corre a volta oficial localmente (estimativa) e só envia
 * quando o jogador apertar o botão. O tempo nunca é enviado: o servidor calcula.
 */

type CheckState = { key: string; status: 'running' } | { key: string; status: 'done'; run: OfficialRun } | { key: string; status: 'error'; error: string };

type SendState =
  | { status: 'idle' }
  | { status: 'sending' }
  | { status: 'sent'; submission: Submission }
  | { status: 'error'; kind: 'limite' | 'offline' | 'outro'; error: string };

const IDLE: SendState = { status: 'idle' };

export function SubmitPanel(props: { preselectPilotId: string | null; meta: RankingMeta | null; active: boolean; onGoSubmissions: () => void }) {
  const online = useOnline();
  const subs = useSubmissions();
  const pilotsQ = useAsync(() => db.getAll<PilotRecord>('pilots'), []);
  const pilots = useMemo(() => (pilotsQ.data ?? []).slice().sort((a, b) => b.updatedAt - a.updatedAt), [pilotsQ.data]);

  const [pilotId, setPilotId] = useState('');
  const [trackId, setTrackId] = useState(OFFICIAL_TRACK_IDS[0] ?? '');
  const [categoryId, setCategoryId] = useState(CATEGORIES[0].id);
  const [missingPreselect, setMissingPreselect] = useState(false);
  const appliedPreselect = useRef<string | null>(null);
  const [check, setCheck] = useState<CheckState | null>(null);
  const [showLocalReplay, setShowLocalReplay] = useState(false);
  const [send, setSend] = useState<{ key: string; s: SendState }>({ key: '', s: IDLE });

  const choosePilot = (p: PilotRecord) => {
    setPilotId(p.id);
    const t = p.origin.trackIds?.find((id) => OFFICIAL_TRACK_IDS.includes(id));
    if (t) setTrackId(t);
    const elig = eligibleCategories(p.brain);
    if (elig.length) setCategoryId(elig[0].id);
  };

  // Escolha inicial: piloto pedido por outra tela (ranking/enviar:<id>) ou o mais recente.
  useEffect(() => {
    if (!pilotsQ.data) return;
    const pre = props.preselectPilotId;
    if (pre && appliedPreselect.current !== pre) {
      appliedPreselect.current = pre;
      const p = pilots.find((x) => x.id === pre);
      if (p) {
        setMissingPreselect(false);
        choosePilot(p);
        return;
      }
      setMissingPreselect(true);
    }
    if (pilots.length && !pilots.some((p) => p.id === pilotId)) choosePilot(pilots[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pilots, props.preselectPilotId]);

  const pilot = pilots.find((p) => p.id === pilotId) ?? null;
  const category = getCategory(categoryId) ?? CATEGORIES[0];
  const track = officialTrack(trackId);
  const problems = pilot ? checkBrainForCategory(pilot.brain, category) : [];
  const otherEligible = pilot ? eligibleCategories(pilot.brain).filter((c) => c.id !== category.id) : [];
  const rules = track ? describeRules(track, category) : [];
  const metaTrack = props.meta?.tracks.find((t) => t.id === trackId) ?? null;
  const localVersion = track ? rulesKey(track.def) : '';
  const outdated = !!(metaTrack && track && (metaTrack.rulesVersion !== localVersion || metaTrack.hash !== track.hash));

  // Conferência local: a mesma volta oficial do servidor, calculada no worker.
  const checkKey = pilot && track ? `${pilot.id}|${pilot.updatedAt}|${trackId}` : '';
  const runCheck = () => {
    if (!pilot || !track) return;
    const key = checkKey;
    setCheck({ key, status: 'running' });
    setShowLocalReplay(false);
    officialCheck(pilot.brain, trackId, pilot.name).promise.then(
      (run) => setCheck((c) => (c && c.key === key ? { key, status: 'done', run } : c)),
      (e: Error) => setCheck((c) => (c && c.key === key ? { key, status: 'error', error: e.message || 'Falha na conferência.' } : c)),
    );
  };
  useEffect(() => {
    if (checkKey && check?.key !== checkKey) runCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkKey]);
  const cur = check && check.key === checkKey ? check : null;
  const run = cur?.status === 'done' ? cur.run : null;

  const localEntries = useMemo<ReplayEntry[]>(
    () => (run && pilot ? [{ replay: run.replay, label: `${pilot.name} (local)`, color: pilot.color, rays: pilot.brain.inputs.rays }] : []),
    [run, pilot],
  );

  const sendKey = `${checkKey}|${category.id}`;
  const sendState: SendState = send.key === sendKey ? send.s : IDLE;
  const sending = sendState.status === 'sending';
  const sentLive = sendState.status === 'sent' ? (subs.list?.find((s) => s.id === sendState.submission.id) ?? sendState.submission) : null;

  let blockReason: string | null = null;
  if (!pilot) blockReason = 'Escolha um piloto.';
  else if (problems.length) blockReason = `O piloto não cumpre as regras da categoria ${category.name}.`;
  else if (outdated) blockReason = 'Seu jogo está desatualizado em relação ao servidor.';
  else if (!cur || cur.status === 'running') blockReason = 'Aguarde a conferência local terminar.';
  else if (cur.status === 'error') blockReason = 'A conferência local falhou. Tente conferir de novo.';
  else if (!cur.run.result.completed) blockReason = 'O piloto precisa completar a volta para ser enviado.';
  else if (!online.user) blockReason = 'Entre com seu apelido para enviar.';
  else if (online.status === 'offline') blockReason = 'O ranking online está indisponível.';
  else if (sending) blockReason = 'Enviando…';
  else if (sentLive && isPendingStatus(sentLive.status)) blockReason = 'Este envio ainda está na fila do servidor.';
  const canSend = blockReason === null;

  const doSend = async () => {
    if (!pilot || !canSend) return;
    const key = sendKey;
    const pid = pilot.id;
    let payload: SubmissionPayload;
    try {
      payload = buildSubmission(pilot.brain, trackId, category.id, pilot.name);
    } catch (e) {
      setSend({ key, s: { status: 'error', kind: 'outro', error: (e as Error).message } });
      return;
    }
    audio.click();
    setSend({ key, s: { status: 'sending' } });
    const r = await api.submit(payload);
    if (r.ok) {
      const sub = r.data.submission;
      watchNewSubmission(sub, pid);
      if (sub.status === 'rejeitado') {
        audio.error();
        toast(`Envio recusado: ${sub.message ?? 'configuração inválida.'}`, 'erro', 8000);
      } else {
        toast('Piloto enviado! O servidor vai conferir a volta. Você pode continuar treinando enquanto isso.', 'sucesso', 6000);
      }
      setSend({ key, s: { status: 'sent', submission: sub } });
      return;
    }
    audio.error();
    if (r.status === 401) {
      clearSession();
      setSend({ key, s: IDLE });
      toast('Sua sessão terminou. Entre de novo com seu apelido para enviar.', 'aviso', 7000);
      return;
    }
    setSend({ key, s: { status: 'error', kind: r.status === 429 ? 'limite' : r.offline ? 'offline' : 'outro', error: r.error } });
  };

  if (pilotsQ.data === undefined) {
    if (pilotsQ.error)
      return (
        <div className="callout err" role="alert">
          Não foi possível abrir a garagem: {pilotsQ.error}
        </div>
      );
    return <Loading text="Abrindo a garagem…" />;
  }

  if (!pilots.length) {
    return (
      <Empty icon="🧠" title="Sua garagem está vazia.">
        <p>Treine um piloto no Laboratório e salve-o na Garagem. Depois volte aqui para enviá-lo ao ranking.</p>
        <button type="button" className="btn primary" onClick={() => navigate('laboratorio')}>
          Ir para o Laboratório
        </button>
      </Empty>
    );
  }

  return (
    <div className="grid cols-2" style={{ alignItems: 'start' }}>
      <section className="panel stack" aria-label="Escolher piloto, pista e categoria">
        <div className="panel-title">
          <h3>1. Escolha piloto, pista e categoria</h3>
        </div>
        {missingPreselect && <div className="callout warn">O piloto escolhido em outra tela não está mais na garagem. Escolha outro abaixo.</div>}
        <label className="field">
          <span className="field-label">Piloto da garagem</span>
          <select
            value={pilotId}
            disabled={sending}
            onChange={(e) => {
              const p = pilots.find((x) => x.id === e.target.value);
              if (p) choosePilot(p);
            }}
          >
            {pilots.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {pilot && (
          <div className="row" style={{ gap: 8 }}>
            <span className="swatch" style={{ background: pilot.color }} aria-hidden />
            <span className="muted">
              Rede {describeArch(pilot.brain.inputs, pilot.brain.hidden)} · {pilot.brain.inputs.rays} sensores · {paramCount(pilot.brain.inputs, pilot.brain.hidden)} parâmetros
            </span>
          </div>
        )}
        <label className="field">
          <span className="field-label">Pista oficial</span>
          <select value={trackId} disabled={sending} onChange={(e) => setTrackId(e.target.value)}>
            {OFFICIAL_TRACK_IDS.map((id) => (
              <option key={id} value={id}>
                {trackLabel(id, props.meta)}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          <span className="field-label">Categoria</span>
          <Seg<string>
            ariaLabel="Categoria"
            value={category.id}
            onChange={setCategoryId}
            disabled={sending}
            options={CATEGORIES.map((c) => ({ value: c.id, label: c.name, title: c.description }))}
          />
          <span className="field-hint">{category.description}</span>
        </div>

        {pilot &&
          (problems.length ? (
            <div className="callout err" role="alert">
              <strong>Este piloto não pode competir na categoria {category.name}:</strong>
              <ul style={{ margin: '6px 0', paddingLeft: 20 }}>
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              {otherEligible.length ? (
                <span>Ele pode competir em: {otherEligible.map((c) => c.name).join(', ')}.</span>
              ) : (
                <span>Treine um piloto com sensores e rede permitidos nesta categoria.</span>
              )}
            </div>
          ) : (
            <div className="callout ok">✔ Este piloto cumpre as regras da categoria {category.name}.</div>
          ))}

        {track && (
          <div className="stack" style={{ gap: 6 }}>
            <h4 style={{ margin: 0 }}>Regras oficiais desta categoria</h4>
            <dl className="kv">
              {rules.map((r) => (
                <Fragment key={r.label}>
                  <dt>{r.label}</dt>
                  <dd>{r.value}</dd>
                </Fragment>
              ))}
            </dl>
          </div>
        )}
      </section>

      <div className="stack">
        <section className="panel stack" aria-label="Conferência local">
          <div className="panel-title">
            <h3>2. Conferência local</h3>
            <LocalBadge />
          </div>
          <p className="field-hint" style={{ margin: 0 }}>
            Antes de enviar, o jogo corre a volta oficial aqui no seu computador, com as mesmas regras do servidor. Assim você sabe se o envio seria aceito.
          </p>
          {(!cur || cur.status === 'running') && <Loading text="Conferindo a volta oficial no seu computador…" />}
          {cur?.status === 'error' && (
            <div className="callout err" role="alert">
              Não foi possível conferir a volta: {cur.error}
            </div>
          )}
          {run &&
            (run.result.completed ? (
              <>
                <div className="stats-row">
                  <Stat label="Tempo local (não oficial)" value={fmtTime(run.result.time)} sub="Estimativa feita neste computador" />
                </div>
                <div className="callout ok">
                  ✔ O piloto completou a volta localmente. O tempo oficial é calculado pelo servidor: deve dar o mesmo, mas só vale o resultado do servidor.
                </div>
              </>
            ) : (
              <div className="callout err" role="alert">
                <strong>
                  Este piloto não completou a volta localmente ({END_REASON_LABEL[run.result.reason]}, progresso {fmtPct(run.result.progress, 1)}).
                </strong>
                <p style={{ margin: '6px 0 0' }}>
                  O servidor faz a mesma conta, então recusaria o envio como "Não concluiu". Treine mais um pouco ou escolha outro piloto.
                </p>
              </div>
            ))}
          {cur && cur.status !== 'running' && (
            <div className="btn-row">
              {run && (
                <button type="button" className="btn small" aria-expanded={showLocalReplay} onClick={() => setShowLocalReplay((v) => !v)}>
                  {showLocalReplay ? 'Esconder volta local' : '▶ Ver volta local'}
                </button>
              )}
              <button type="button" className="btn small ghost" onClick={runCheck}>
                ⟳ Conferir de novo
              </button>
            </div>
          )}
          {showLocalReplay && run && track && props.active && <ReplayPlayer track={track} entries={localEntries} height={300} />}
        </section>

        <section className="panel stack" aria-label="Enviar para o ranking">
          <div className="panel-title">
            <h3>3. Enviar para o ranking</h3>
            <OnlineBadge />
          </div>
          {outdated && metaTrack && (
            <div className="callout warn" role="alert">
              Seu jogo usa uma versão diferente da pista ou das regras (jogo: {localVersion}, servidor: {metaTrack.rulesVersion}). Recarregue a página para atualizar
              antes de enviar; senão o servidor recusaria o envio.
            </div>
          )}
          {!online.user ? (
            <>
              <p className="muted" style={{ margin: 0 }}>
                Para enviar, entre com seu apelido. Treinar não precisa de conta.
              </p>
              <AccountPanel embedded />
            </>
          ) : online.status === 'offline' ? (
            <RankingUnavailable message={online.message} />
          ) : (
            <>
              <p className="muted" style={{ margin: 0 }}>
                Conectado como <strong>{online.user.nickname}</strong>. Só o cérebro do piloto é enviado: o servidor corre a volta de novo e calcula o tempo oficial.
              </p>
              {sendState.status === 'error' &&
                (sendState.kind === 'offline' ? (
                  <RankingUnavailable message={sendState.error} />
                ) : sendState.kind === 'limite' ? (
                  <div className="callout warn" role="alert">
                    <strong>O servidor segurou este envio por causa dos limites.</strong> {sendState.error} Os limites evitam filas enormes e valem para todos.
                    Espere um pouco e tente de novo.
                  </div>
                ) : (
                  <div className="callout err" role="alert">
                    Não foi possível enviar: {sendState.error}
                  </div>
                ))}
              {sentLive && (
                <div className={`callout ${sentLive.status === 'aprovado' ? 'ok' : sentLive.status === 'rejeitado' || sentLive.status === 'nao_concluiu' ? 'err' : ''}`} role="status">
                  <div className="row">
                    <strong>Envio nº {sentLive.id}</strong>
                    <span className={`badge ${statusBadge(sentLive.status)}`}>{statusLabel(sentLive.status)}</span>
                    {sentLive.status === 'aprovado' && <span className="mono">Tempo oficial: {fmtTime(sentLive.officialTime)}</span>}
                  </div>
                  {sentLive.message && <p style={{ margin: '6px 0 0' }}>{sentLive.message}</p>}
                  {isPendingStatus(sentLive.status) && (
                    <p style={{ margin: '6px 0 0' }}>O servidor está conferindo. Você pode continuar treinando: avisaremos quando terminar.</p>
                  )}
                  <button type="button" className="btn small" style={{ marginTop: 8 }} onClick={props.onGoSubmissions}>
                    Ver meus envios
                  </button>
                </div>
              )}
              <div className="btn-row">
                <button type="button" className="btn primary big" disabled={!canSend} onClick={() => void doSend()}>
                  {sending ? (
                    <>
                      <span className="spinner" aria-hidden /> Enviando…
                    </>
                  ) : sentLive ? (
                    'Enviar de novo'
                  ) : (
                    'Enviar para o ranking'
                  )}
                </button>
              </div>
              {!canSend && !sending && blockReason && <p className="field-hint" style={{ margin: 0 }}>{blockReason}</p>}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
