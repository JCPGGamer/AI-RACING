import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { BUILTIN_TRACKS } from '../../core/builtinTracks.ts';
import { CATEGORIES, OFFICIAL_TRACK_IDS, rulesKey } from '../../core/rules.ts';
import type { LeaderboardPage, LeaderboardRow, RankingMeta } from '../../online/api.ts';
import { api, checkOnline, clearSession, useOnline } from '../../online/session.ts';
import { Empty, Hint, Loading, Seg, Stat, Tabs, fmtDate, fmtTime } from '../components.tsx';
import { useApp } from '../store.ts';
import { AccountPanel } from './RankingAccount.tsx';
import { RecordModal } from './RankingRecord.tsx';
import { SubmissionsPanel } from './RankingSubmissions.tsx';
import { SubmitPanel } from './RankingSubmit.tsx';
import { OnlineBadge, RankingUnavailable, categoryLabel, plural, trackLabel, type Loadable } from './rankingShared.tsx';
import { isPendingStatus, refreshSubmissions, resetSubmissions, useSubmissions } from './submissionWatcher.ts';

/**
 * Ranking público online. Qualquer pessoa pode ver sem entrar; a conta só é
 * necessária para enviar pilotos. Nada daqui usa dados locais como ranking:
 * sem servidor, a tela mostra "Ranking online indisponível".
 *
 * Parâmetros aceitos pela tela (navigate('ranking', arg)):
 *   "enviar:<id do piloto>" abre "Enviar piloto" com o piloto escolhido;
 *   "enviar", "envios", "conta" ou "classificacao" abrem a aba indicada.
 */

const PAGE_SIZE = 20;

type TabId = 'classificacao' | 'enviar' | 'envios' | 'conta';
const TAB_IDS: TabId[] = ['classificacao', 'enviar', 'envios', 'conta'];

function parseArg(arg: string | null): { tab: TabId | null; pilotId: string | null } {
  if (!arg) return { tab: null, pilotId: null };
  if (arg.startsWith('enviar:')) return { tab: 'enviar', pilotId: arg.slice('enviar:'.length) || null };
  if ((TAB_IDS as string[]).includes(arg)) return { tab: arg as TabId, pilotId: null };
  return { tab: null, pilotId: null };
}

export function RankingScreen() {
  const online = useOnline();
  const screenArg = useApp((s) => s.screenArg);
  const parsed = useMemo(() => parseArg(screenArg), [screenArg]);
  const [tab, setTab] = useState<TabId>(parsed.tab ?? 'classificacao');
  useEffect(() => {
    if (parsed.tab) setTab(parsed.tab);
  }, [parsed]);
  // As abas só montam na primeira visita e depois ficam guardadas (mantêm escolhas).
  const [visited, setVisited] = useState<ReadonlySet<TabId>>(() => new Set([tab]));
  useEffect(() => {
    setVisited((v) => (v.has(tab) ? v : new Set([...v, tab])));
  }, [tab]);

  const [meta, setMeta] = useState<Loadable<RankingMeta>>({ status: 'loading' });
  const [metaNonce, setMetaNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    setMeta((m) => (m.status === 'ok' ? m : { status: 'loading' }));
    void api.meta().then((r) => {
      if (!alive) return;
      // Em falha, mantém a última lista de pistas/versões vinda do servidor (só serve para os filtros).
      setMeta((m) => (r.ok ? { status: 'ok', data: r.data } : m.status === 'ok' ? m : { status: 'error', error: r.error, offline: r.offline }));
    });
    return () => {
      alive = false;
    };
  }, [metaNonce]);
  const metaData = meta.status === 'ok' ? meta.data : null;

  // Envios do jogador: começa a acompanhar ao entrar, esquece ao sair.
  const userId = online.user?.id ?? null;
  useEffect(() => {
    if (userId !== null) void refreshSubmissions();
    else resetSubmissions();
  }, [userId]);
  const subs = useSubmissions();
  const pendingCount = subs.list?.filter((s) => isPendingStatus(s.status)).length ?? 0;

  return (
    <div className="page stack" style={{ gap: 16 }}>
      <header className="spread" style={{ alignItems: 'flex-start' }}>
        <div>
          <div className="row" style={{ gap: 12, marginBottom: '0.5em' }}>
            <h1 style={{ margin: 0 }}>Ranking online</h1>
            <OnlineBadge />
          </div>
          <p className="muted" style={{ margin: 0, maxWidth: '70ch' }}>
            Tempos oficiais de jogadores do mundo todo. Cada volta é corrida de novo pelo servidor, com as mesmas regras para todos. Tempos medidos no seu
            computador nunca entram aqui.
          </p>
        </div>
        <div className="row">
          <span className={`badge ${online.status === 'online' ? 'online' : online.status === 'offline' ? 'err' : ''}`} role="status">
            {online.status === 'online' ? '● Servidor conectado' : online.status === 'offline' ? '○ Servidor indisponível' : '… Conectando'}
          </span>
          {online.user ? (
            <button type="button" className="btn small ghost" onClick={() => setTab('conta')} title="Sua conta">
              👤 {online.user.nickname}
            </button>
          ) : (
            <button type="button" className="btn small" onClick={() => setTab('conta')}>
              Entrar ou criar conta
            </button>
          )}
        </div>
      </header>

      <div>
        <Tabs<TabId>
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'classificacao', label: '🏆 Classificação' },
            { id: 'enviar', label: '📤 Enviar piloto' },
            {
              id: 'envios',
              label: (
                <>
                  📋 Meus envios
                  {pendingCount > 0 && (
                    <span className="badge info" style={{ marginLeft: 6 }} aria-label={`${pendingCount} na fila`}>
                      {pendingCount}
                    </span>
                  )}
                </>
              ),
            },
            { id: 'conta', label: online.user ? '👤 Conta' : '👤 Entrar' },
          ]}
        />

        <div role="tabpanel" aria-label="Classificação" hidden={tab !== 'classificacao'}>
          {(tab === 'classificacao' || visited.has('classificacao')) && (
            <Leaderboard meta={meta} onMetaReload={() => setMetaNonce((n) => n + 1)} onGoAccount={() => setTab('conta')} onGoSubmit={() => setTab('enviar')} />
          )}
        </div>
        <div role="tabpanel" aria-label="Enviar piloto para o ranking" hidden={tab !== 'enviar'}>
          {(tab === 'enviar' || visited.has('enviar')) && (
            <SubmitPanel preselectPilotId={parsed.pilotId} meta={metaData} active={tab === 'enviar'} onGoSubmissions={() => setTab('envios')} />
          )}
        </div>
        <div role="tabpanel" aria-label="Estado das submissões" hidden={tab !== 'envios'}>
          {tab === 'envios' && <SubmissionsPanel meta={metaData} onGoSubmit={() => setTab('enviar')} />}
        </div>
        <div role="tabpanel" aria-label="Acesso à identidade do jogador" hidden={tab !== 'conta'}>
          {tab === 'conta' && <AccountTab />}
        </div>
      </div>
    </div>
  );
}

function AccountTab() {
  return (
    <div className="grid cols-2" style={{ alignItems: 'start' }}>
      <AccountPanel />
      <section className="panel stack" aria-label="Como funciona a conta">
        <h3 style={{ margin: 0 }}>Para que serve a conta?</h3>
        <ul style={{ margin: 0, paddingLeft: 20 }} className="stack">
          <li>Treinar, testar, comparar e salvar pilotos funciona sem conta e sem internet.</li>
          <li>A conta serve só para enviar pilotos ao ranking online e acompanhar seus envios.</li>
          <li>Ver o ranking não precisa de conta.</li>
          <li>Seu apelido aparece no ranking. Não pedimos e-mail nem dados pessoais.</li>
          <li>A senha é usada só para entrar. Ela não fica guardada neste navegador; fica salvo apenas um código de sessão, apagado quando você sai.</li>
        </ul>
      </section>
    </div>
  );
}

const MEDALS = ['🥇', '🥈', '🥉'];

interface MyPosition {
  position: number | null;
  total: number;
  row: LeaderboardRow | null;
}

function Leaderboard(props: { meta: Loadable<RankingMeta>; onMetaReload: () => void; onGoAccount: () => void; onGoSubmit: () => void }) {
  const online = useOnline();
  const metaData = props.meta.status === 'ok' ? props.meta.data : null;

  const tracks = useMemo(
    () =>
      metaData
        ? metaData.tracks.map((t) => ({ id: t.id, name: t.name, difficulty: t.difficulty, rulesVersion: t.rulesVersion }))
        : BUILTIN_TRACKS.filter((d) => OFFICIAL_TRACK_IDS.includes(d.id)).map((d) => ({ id: d.id, name: d.name, difficulty: d.difficulty, rulesVersion: rulesKey(d) })),
    [metaData],
  );
  const categories = metaData?.categories ?? CATEGORIES;

  const [trackId, setTrackId] = useState(OFFICIAL_TRACK_IDS[0] ?? '');
  const [categoryId, setCategoryId] = useState(CATEGORIES[0].id);
  const [version, setVersion] = useState('');
  const [page, setPage] = useState(1);
  const [nonce, setNonce] = useState(0);
  const [board, setBoard] = useState<Loadable<LeaderboardPage>>({ status: 'loading' });
  const [mine, setMine] = useState<Loadable<MyPosition> | null>(null);
  const [openRecord, setOpenRecord] = useState<number | null>(null);

  const track = tracks.find((t) => t.id === trackId) ?? tracks[0];
  const category = categories.find((c) => c.id === categoryId) ?? categories[0];
  const currentVersion = track?.rulesVersion ?? '';
  const historical = useMemo(
    () =>
      (metaData?.versions ?? [])
        .filter((v) => v.trackId === trackId && v.categoryId === categoryId && v.rulesVersion !== currentVersion)
        .sort((a, b) => b.rulesVersion.localeCompare(a.rulesVersion, 'en', { numeric: true })),
    [metaData, trackId, categoryId, currentVersion],
  );
  const effVersion = version && historical.some((v) => v.rulesVersion === version) ? version : '';

  useEffect(() => {
    if (!trackId || !categoryId) return;
    let alive = true;
    setBoard({ status: 'loading' });
    void api.leaderboard({ track: trackId, category: categoryId, version: effVersion || undefined, page, pageSize: PAGE_SIZE }).then((r) => {
      if (!alive) return;
      if (!r.ok) {
        setBoard({ status: 'error', error: r.error, offline: r.offline });
        if (r.offline) void checkOnline(); // atualiza o aviso de conexão do topo
        return;
      }
      const pages = Math.max(1, Math.ceil(r.data.total / PAGE_SIZE));
      if (page > pages) {
        setPage(pages); // a lista encolheu: vai para a última página que existe
        return;
      }
      setBoard({ status: 'ok', data: r.data });
    });
    return () => {
      alive = false;
    };
  }, [trackId, categoryId, effVersion, page, nonce]);

  const userId = online.user?.id ?? null;
  useEffect(() => {
    if (userId === null) {
      setMine(null);
      return;
    }
    let alive = true;
    setMine({ status: 'loading' });
    void api.myPosition({ track: trackId, category: categoryId, version: effVersion || undefined }).then((r) => {
      if (!alive) return;
      if (r.ok) {
        setMine({ status: 'ok', data: r.data });
        return;
      }
      if (r.status === 401) clearSession();
      setMine({ status: 'error', error: r.status === 401 ? 'Sua sessão terminou. Entre de novo para ver sua posição.' : r.error, offline: r.offline });
    });
    return () => {
      alive = false;
    };
  }, [userId, trackId, categoryId, effVersion, nonce]);

  const reloadAll = () => {
    setNonce((n) => n + 1);
    props.onMetaReload();
  };

  const myRecordId = mine?.status === 'ok' ? (mine.data.row?.recordId ?? null) : null;
  const isMine = (r: LeaderboardRow) => (online.user !== null && r.nickname === online.user.nickname) || r.recordId === myRecordId;

  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, id: number) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpenRecord(id);
    }
  };

  const data = board.status === 'ok' ? board.data : null;
  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const viewingHistorical = data ? !data.current : effVersion !== '';

  return (
    <div className="stack" style={{ gap: 14 }}>
      <section className="panel" aria-label="Filtros do ranking">
        <div className="grid cols-3">
          <label className="field">
            <span className="field-label">Pista</span>
            <select
              value={trackId}
              onChange={(e) => {
                setTrackId(e.target.value);
                setVersion('');
                setPage(1);
              }}
            >
              {tracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.difficulty ? ` — dificuldade ${t.difficulty}` : ''}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span className="field-label">
              <span className="row" style={{ gap: 6 }}>
                Categoria
                <Hint text="Cada categoria tem regras próprias de sensores e tamanho da rede. Pilotos só competem com quem segue as mesmas regras." />
              </span>
            </span>
            <Seg<string>
              ariaLabel="Categoria"
              value={category?.id ?? categoryId}
              onChange={(v) => {
                setCategoryId(v);
                setVersion('');
                setPage(1);
              }}
              options={categories.map((c) => ({ value: c.id, label: c.name, title: c.description }))}
            />
            {category && <span className="field-hint">{category.description}</span>}
          </div>
          <label className="field">
            <span className="field-label">
              <span className="row" style={{ gap: 6 }}>
                Versão das regras
                <Hint text="Quando a física, a pista ou as regras mudam, começa um ranking novo. Os recordes antigos ficam guardados nas versões marcadas como histórico." />
              </span>
            </span>
            <select
              value={effVersion}
              onChange={(e) => {
                setVersion(e.target.value);
                setPage(1);
              }}
            >
              <option value="">{currentVersion ? `${currentVersion} (atual)` : 'Atual'}</option>
              {historical.length > 0 && (
                <optgroup label="Recordes antigos">
                  {historical.map((v) => (
                    <option key={v.rulesVersion} value={v.rulesVersion}>
                      {v.rulesVersion} — histórico ({plural(v.count, 'recorde', 'recordes')})
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <span className="field-hint">
              {!metaData
                ? props.meta.status === 'loading'
                  ? 'Buscando versões antigas…'
                  : 'Não foi possível consultar as versões antigas agora.'
                : historical.length
                  ? `Há ${plural(historical.length, 'versão antiga', 'versões antigas')} com recordes guardados.`
                  : 'Ainda não há recordes antigos desta pista e categoria.'}
            </span>
          </label>
        </div>
      </section>

      {viewingHistorical && (
        <div className="callout warn" role="note">
          <strong>Recordes antigos (histórico).</strong> Você está vendo a versão {data?.version ?? effVersion}. Estes tempos foram feitos com regras, física ou pista de
          uma versão anterior. Eles continuam guardados, mas não se misturam com o ranking atual e não recebem envios novos.
        </div>
      )}

      <MyPositionPanel
        mine={mine}
        loggedIn={online.user !== null}
        onGoAccount={props.onGoAccount}
        onGoSubmit={props.onGoSubmit}
        onShowInList={(position) => setPage(Math.max(1, Math.ceil(position / PAGE_SIZE)))}
        onOpenRecord={setOpenRecord}
      />

      <section className="panel stack" aria-label="Classificação">
        <div className="panel-title">
          <h3>
            {track?.name ?? trackLabel(trackId, metaData)} · {category?.name ?? categoryLabel(categoryId, metaData)}
          </h3>
          <div className="row">
            <OnlineBadge />
            <button type="button" className="btn small" onClick={reloadAll} disabled={board.status === 'loading'}>
              ⟳ Atualizar
            </button>
          </div>
        </div>
        <p className="field-hint" style={{ margin: 0 }}>
          Cada jogador aparece uma vez, com o seu melhor tempo validado nesta pista e categoria. Empates ficam com quem fez o tempo primeiro. Clique numa linha
          (ou use Enter) para ver os detalhes e o replay oficial.
        </p>

        {board.status === 'loading' && <Loading text="Carregando o ranking…" />}
        {board.status === 'error' &&
          (board.offline ? (
            <RankingUnavailable message={board.error} onRetry={reloadAll} />
          ) : (
            <RankingUnavailable title="Não foi possível carregar o ranking" message={board.error} onRetry={reloadAll} />
          ))}
        {data && data.rows.length === 0 && (
          <Empty icon="🏁" title="Ninguém completou esta pista nesta categoria ainda. Seja o primeiro!">
            {data.current && (
              <button type="button" className="btn primary" onClick={props.onGoSubmit}>
                Enviar um piloto
              </button>
            )}
          </Empty>
        )}
        {data && data.rows.length > 0 && (
          <>
            <div className="table-wrap">
              <table className="table">
                <caption className="sr-only">
                  Ranking de {trackLabel(data.track, metaData)}, categoria {categoryLabel(data.category, metaData)}, versão {data.version}
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className="num">
                      Posição
                    </th>
                    <th scope="col">Apelido</th>
                    <th scope="col">Piloto</th>
                    <th scope="col" className="num">
                      Melhor tempo
                    </th>
                    <th scope="col">Pista</th>
                    <th scope="col">Categoria</th>
                    <th scope="col">Data</th>
                    <th scope="col">Validado</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => {
                    const mineRow = isMine(r);
                    return (
                      <tr
                        key={r.recordId}
                        className={`clickable${mineRow ? ' highlight' : ''}`}
                        tabIndex={0}
                        aria-label={`${r.position}º lugar: ${r.nickname}, piloto ${r.pilotName}, ${fmtTime(r.time)}${mineRow ? ' (você)' : ''}. Abrir detalhes.`}
                        onClick={() => setOpenRecord(r.recordId)}
                        onKeyDown={(e) => onRowKey(e, r.recordId)}
                      >
                        <td className="num">
                          <strong>{r.position}º</strong> {r.position <= 3 && <span aria-hidden>{MEDALS[r.position - 1]}</span>}
                        </td>
                        <td>
                          {r.nickname}
                          {mineRow && (
                            <span className="badge info" style={{ marginLeft: 6 }}>
                              você
                            </span>
                          )}
                        </td>
                        <td>{r.pilotName}</td>
                        <td className="num mono">
                          <strong>{fmtTime(r.time)}</strong>
                        </td>
                        <td>{trackLabel(data.track, metaData)}</td>
                        <td>{categoryLabel(data.category, metaData)}</td>
                        <td>{fmtDate(r.achievedAt)}</td>
                        <td>{r.validated && <span className="badge ok">✔ Validado pelo servidor</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <nav className="spread" aria-label="Páginas do ranking">
              <span className="muted" aria-live="polite">
                Página {data.page} de {pages} · {plural(data.total, 'jogador', 'jogadores')}
              </span>
              <div className="btn-row">
                <button type="button" className="btn small" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                  ← Anterior
                </button>
                <button type="button" className="btn small" disabled={page >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))}>
                  Próxima →
                </button>
              </div>
            </nav>
          </>
        )}
      </section>

      {openRecord !== null && <RecordModal recordId={openRecord} meta={metaData} onClose={() => setOpenRecord(null)} />}
    </div>
  );
}

function MyPositionPanel(props: {
  mine: Loadable<MyPosition> | null;
  loggedIn: boolean;
  onGoAccount: () => void;
  onGoSubmit: () => void;
  onShowInList: (position: number) => void;
  onOpenRecord: (recordId: number) => void;
}) {
  const { mine } = props;
  return (
    <section className="panel tight" aria-label="Minha posição">
      <div className="panel-title" style={{ marginBottom: 6 }}>
        <h3>Minha posição</h3>
      </div>
      {!props.loggedIn && (
        <div className="spread">
          <span className="muted">Entre com seu apelido para ver sua posição nesta pista e categoria.</span>
          <button type="button" className="btn small" onClick={props.onGoAccount}>
            Entrar
          </button>
        </div>
      )}
      {props.loggedIn && (mine === null || mine.status === 'loading') && <Loading text="Buscando sua posição…" />}
      {props.loggedIn && mine?.status === 'error' && <p className="muted" style={{ margin: 0 }}>{mine.error}</p>}
      {props.loggedIn && mine?.status === 'ok' && mine.data.position === null && (
        <div className="spread">
          <span className="muted">Você ainda não tem tempo nesta pista/categoria.</span>
          <button type="button" className="btn small" onClick={props.onGoSubmit}>
            Enviar um piloto
          </button>
        </div>
      )}
      {props.loggedIn && mine?.status === 'ok' && mine.data.position !== null && mine.data.row && (
        <div className="spread">
          <div className="stats-row" style={{ flex: 1, minWidth: 240 }}>
            <Stat label="Sua posição" value={`${mine.data.position}º`} sub={`de ${plural(mine.data.total, 'jogador', 'jogadores')}`} />
            <Stat label="Seu melhor tempo" value={fmtTime(mine.data.row.time)} sub="oficial" />
            <Stat label="Piloto" value={mine.data.row.pilotName} sub={fmtDate(mine.data.row.achievedAt)} />
          </div>
          <div className="btn-row">
            <button type="button" className="btn small" onClick={() => props.onShowInList(mine.data.position ?? 1)}>
              Ver na lista
            </button>
            <button type="button" className="btn small ghost" onClick={() => mine.data.row && props.onOpenRecord(mine.data.row.recordId)}>
              Detalhes
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
