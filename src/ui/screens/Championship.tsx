import { useState } from 'react';
import { audio } from '../../audio/audio.ts';
import { CHAMPIONSHIP_CRITERIA, CHAMPIONSHIP_POINTS, type ChampionshipConfig, type ChampionshipResult } from '../../core/championship.ts';
import { MULTI_CRITERIA } from '../../core/evaluation.ts';
import { newId, type PilotRecord } from '../../core/models.ts';
import { describeArch } from '../../core/nn.ts';
import { OFFICIAL_STALL_DIST, OFFICIAL_STALL_TIME } from '../../core/rules.ts';
import { usesTrackInfo } from '../../core/sensors.ts';
import { cancelEval, championship } from '../../lab/evalClient.ts';
import { builtTrack, listTrackDefs } from '../../lab/tracks.ts';
import { db } from '../../persistence/db.ts';
import { confirmDialog, Empty, fmtDate, fmtPct, fmtTime, Hint, Loading, Progress, Seg, Tabs, Toggle, useAsync } from '../components.tsx';
import { ReplayPlayer } from '../ReplayPlayer.tsx';
import { dataChanged, navigate, toast } from '../store.ts';

interface ChampionshipRecord {
  id: string;
  name: string;
  date: number;
  result: ChampionshipResult;
}

export function ChampionshipScreen() {
  const pilots = useAsync(() => db.getAll<PilotRecord>('pilots').catch(() => [] as PilotRecord[]), []);
  const tracks = useAsync(() => listTrackDefs(), []);
  const history = useAsync(() => db.getAll<ChampionshipRecord>('championships').catch(() => [] as ChampionshipRecord[]), []);
  const [cfg, setCfg] = useState<ChampionshipConfig>({ name: 'Campeonato', pilotIds: [], trackIds: ['oval-largo', 'curvas-s'], attempts: 3, allowTrackInfo: true });
  const [running, setRunning] = useState<{ id: number; done: number; total: number; label: string } | null>(null);
  const [view, setView] = useState<ChampionshipRecord | null>(null);

  const run = async () => {
    const entries = (pilots.data ?? [])
      .filter((p) => cfg.pilotIds.includes(p.id))
      .map((p) => ({ pilotId: p.id, name: p.name, color: p.color, brain: p.brain }));
    const defs = (tracks.data ?? []).filter((t) => cfg.trackIds.includes(t.id));
    if (entries.length < 2) return toast('Escolha pelo menos dois pilotos.', 'aviso');
    if (!defs.length) return toast('Escolha pelo menos uma pista.', 'aviso');
    audio.start();
    const req = championship(entries, defs, cfg, (done, total, label) => setRunning((r) => (r ? { ...r, done, total, label } : r)));
    setRunning({ id: req.id, done: 0, total: entries.length * defs.length, label: '' });
    try {
      const result = await req.promise;
      const rec: ChampionshipRecord = { id: newId('campeonato'), name: cfg.name.trim() || 'Campeonato', date: result.date, result };
      try {
        await db.put('championships', rec);
        dataChanged();
      } catch (e) {
        toast(`Resultado não foi salvo: ${(e as Error).message}`, 'aviso');
      }
      setView(rec);
      audio.record();
    } catch (e) {
      if ((e as Error).message !== 'cancelado') toast((e as Error).message, 'erro');
    } finally {
      setRunning(null);
    }
  };

  if (view) return <ChampionshipView rec={view} onBack={() => setView(null)} />;

  const list = (pilots.data ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
  const toggle = (arr: string[], id: string, max: number) => (arr.includes(id) ? arr.filter((x) => x !== id) : arr.length >= max ? arr : [...arr, id]);

  return (
    <div className="page">
      <h1>Campeonato local</h1>
      <p className="muted">
        Coloque seus pilotos lado a lado em várias pistas, com as mesmas regras para todos. Campeonatos são locais (no seu navegador). O ranking público é outra coisa, na tela
        Ranking.
      </p>
      {pilots.loading && !pilots.data ? (
        <Loading />
      ) : list.length < 2 ? (
        <Empty icon="🏆" title="Você precisa de pelo menos dois pilotos">
          Salve campeões no Laboratório ou importe pilotos na Garagem.
          <div className="btn-row" style={{ justifyContent: 'center', marginTop: 10 }}>
            <button className="btn" onClick={() => navigate('garagem')}>
              Ir para a Garagem
            </button>
          </div>
        </Empty>
      ) : (
        <div className="grid cols-2">
          <section className="panel stack">
            <label className="field">
              <span className="field-label">Nome</span>
              <input type="text" value={cfg.name} maxLength={60} onChange={(e) => setCfg({ ...cfg, name: e.target.value })} />
            </label>
            <h4>Pilotos ({cfg.pilotIds.length}/12)</h4>
            <div className="stack" style={{ gap: 4, maxHeight: 320, overflow: 'auto' }}>
              {list.map((p) => {
                const blocked = !cfg.allowTrackInfo && usesTrackInfo(p.brain.inputs);
                return (
                  <label key={p.id} className="check" style={{ opacity: blocked ? 0.55 : 1 }}>
                    <input type="checkbox" checked={cfg.pilotIds.includes(p.id)} onChange={() => setCfg({ ...cfg, pilotIds: toggle(cfg.pilotIds, p.id, 12) })} />
                    <span>
                      <span className="swatch" style={{ background: p.color, marginRight: 6 }} />
                      <strong>{p.name}</strong>
                      <span className="field-hint" style={{ display: 'block' }}>
                        {describeArch(p.brain.inputs, p.brain.hidden)}
                        {usesTrackInfo(p.brain.inputs) ? ' · usa informações da pista' : ' · só sensores'}
                        {blocked ? ' — será excluído por estas regras' : ''}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </section>
          <section className="panel stack">
            <h4>Pistas</h4>
            <div className="row" style={{ gap: 4 }}>
              {(tracks.data ?? []).map((t) => (
                <button key={t.id} className="btn small" aria-pressed={cfg.trackIds.includes(t.id)} onClick={() => setCfg({ ...cfg, trackIds: toggle(cfg.trackIds, t.id, 8) })}>
                  {t.name}
                </button>
              ))}
            </div>
            <h4>Regras comuns</h4>
            <div className="field">
              <span className="field-label">Tentativas por pista</span>
              <Seg ariaLabel="Tentativas" value={cfg.attempts} onChange={(v) => setCfg({ ...cfg, attempts: v })} options={[1, 3, 5].map((n) => ({ value: n as 1 | 3 | 5, label: String(n) }))} />
              <span className="field-hint">Mais tentativas usam largadas padronizadas levemente diferentes e premiam a consistência.</span>
            </div>
            <Toggle
              label="Permitir informações da pista"
              checked={cfg.allowTrackInfo}
              onChange={(v) => setCfg({ ...cfg, allowTrackInfo: v })}
              hint="Desligado: só pilotos que usam apenas sensores físicos podem participar (como a categoria Sensores do ranking)."
            />
            <ul className="field-hint" style={{ margin: 0, paddingLeft: 18 }}>
              <li>Física oficial, passo fixo de 1/60 s, carros não colidem entre si.</li>
              <li>Largada parado, no centro (variações fixas quando há várias tentativas).</li>
              <li>
                Encostar na borda encerra a tentativa; sem avançar {OFFICIAL_STALL_DIST} m em {OFFICIAL_STALL_TIME} s também.
              </li>
              <li>
                Classificação por pista: {MULTI_CRITERIA.join(' ')} Pontos: {CHAMPIONSHIP_POINTS.join(', ')}.
              </li>
            </ul>
            {running ? (
              <div className="stack" style={{ gap: 6 }}>
                <Progress value={running.done / Math.max(1, running.total)} label="Progresso do campeonato" />
                <div className="spread field-hint">
                  <span>{running.label}</span>
                  <button className="btn small danger" onClick={() => cancelEval(running.id)}>
                    Cancelar
                  </button>
                </div>
              </div>
            ) : (
              <button className="btn primary big" onClick={() => void run()}>
                🏁 Executar campeonato
              </button>
            )}
          </section>
        </div>
      )}

      {(history.data ?? []).length > 0 && (
        <section style={{ marginTop: 24 }}>
          <h2>Campeonatos anteriores</h2>
          <div className="cards">
            {[...(history.data ?? [])]
              .sort((a, b) => b.date - a.date)
              .map((h) => (
                <div key={h.id} className="item-card">
                  <strong>{h.name}</strong>
                  <span className="muted" style={{ fontSize: '0.86em' }}>
                    {fmtDate(h.date)} · {h.result.overall.length} pilotos · {h.result.tracks.length} pistas · campeão: {h.result.overall[0]?.name ?? '—'}
                  </span>
                  <div className="btn-row">
                    <button className="btn small primary" onClick={() => setView(h)}>
                      Ver
                    </button>
                    <button
                      className="btn small danger"
                      onClick={async () => {
                        if (await confirmDialog('Excluir campeonato', `Excluir "${h.name}"?`)) {
                          await db.delete('championships', h.id);
                          dataChanged();
                        }
                      }}
                    >
                      Excluir
                    </button>
                  </div>
                </div>
              ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ChampionshipView({ rec, onBack }: { rec: ChampionshipRecord; onBack: () => void }) {
  const r = rec.result;
  const [tab, setTab] = useState<string>('geral');
  const tracks = useAsync(() => listTrackDefs(), []);
  const nameOf = (id: string) => r.overall.find((o) => o.pilotId === id)?.name ?? id;
  const colorOf = (id: string) => r.overall.find((o) => o.pilotId === id)?.color ?? '#4dabf7';
  const t = r.tracks.find((x) => x.trackId === tab);
  const def = tracks.data?.find((d) => d.id === tab);
  return (
    <div className="page">
      <div className="spread">
        <h1 style={{ margin: 0 }}>🏆 {rec.name}</h1>
        <button className="btn" onClick={onBack}>
          Voltar
        </button>
      </div>
      <p className="muted">
        {fmtDate(rec.date)} · {r.config.attempts} tentativa(s) por pista · {r.config.allowTrackInfo ? 'informações da pista permitidas' : 'somente sensores físicos'} ·{' '}
        <span className="badge local">resultado local</span>
      </p>
      {r.excluded.length > 0 && (
        <div className="callout warn" style={{ marginBottom: 12 }}>
          Fora do campeonato: {r.excluded.map((e) => `${e.name} (${e.reason})`).join('; ')}
        </div>
      )}
      <Tabs tabs={[{ id: 'geral', label: 'Classificação geral' }, ...r.tracks.map((x) => ({ id: x.trackId, label: x.trackName }))]} value={tab} onChange={setTab} />
      {tab === 'geral' && (
        <div className="panel tight table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Pos.</th>
                <th>Piloto</th>
                <th className="num">Pontos</th>
                <th className="num">Vitórias</th>
                <th className="num">Conclusão média</th>
                {r.tracks.map((x) => (
                  <th key={x.trackId} className="num">
                    {x.trackName}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {r.overall.map((o) => (
                <tr key={o.pilotId} className={o.rank === 1 ? 'highlight' : ''}>
                  <td>{o.rank === 1 ? '🥇' : o.rank === 2 ? '🥈' : o.rank === 3 ? '🥉' : o.rank}</td>
                  <td>
                    <span className="swatch" style={{ background: o.color, marginRight: 6 }} />
                    {o.name}
                  </td>
                  <td className="num">
                    <strong>{o.points}</strong>
                  </td>
                  <td className="num">{o.wins}</td>
                  <td className="num">{fmtPct(o.completionRate)}</td>
                  {r.tracks.map((x) => {
                    const s = x.standings.find((y) => y.pilotId === o.pilotId);
                    return (
                      <td key={x.trackId} className="num">
                        {s ? `${s.rank}º (${s.points})` : '—'}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="field-hint">
            Desempate: {CHAMPIONSHIP_CRITERIA.join(' ')} <Hint text={`Em cada pista: ${MULTI_CRITERIA.join(' ')}`} />
          </p>
        </div>
      )}
      {t && (
        <div className="stack">
          <div className="panel tight table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Pos.</th>
                  <th>Piloto</th>
                  <th className="num">Conclusão</th>
                  <th className="num">Mediana</th>
                  <th className="num">Melhor</th>
                  <th className="num">Progresso médio</th>
                  <th className="num">Pontos</th>
                </tr>
              </thead>
              <tbody>
                {t.standings.map((s) => (
                  <tr key={s.pilotId}>
                    <td>{s.rank}</td>
                    <td>
                      <span className="swatch" style={{ background: colorOf(s.pilotId), marginRight: 6 }} />
                      {nameOf(s.pilotId)}
                    </td>
                    <td className="num">{fmtPct(s.result.completionRate)}</td>
                    <td className="num">{fmtTime(s.result.medianTime)}</td>
                    <td className="num">{fmtTime(s.result.bestTime)}</td>
                    <td className="num">{fmtPct(s.result.meanProgress)}</td>
                    <td className="num">{s.points}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>Corrida (largada padrão, todos juntos)</h3>
          {def ? (
            <ReplayPlayer
              track={builtTrack(def)}
              entries={t.standings
                .filter((s) => t.replays[s.pilotId])
                .map((s) => ({ replay: t.replays[s.pilotId], label: nameOf(s.pilotId), color: colorOf(s.pilotId) }))}
            />
          ) : (
            <div className="callout warn">A pista não está mais disponível.</div>
          )}
        </div>
      )}
    </div>
  );
}
