import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { audio } from '../../audio/audio.ts';
import { MULTI_CRITERIA, compareMulti, type MultiResult } from '../../core/evaluation.ts';
import { exportJson } from '../../core/io.ts';
import { newId, type CoachRecord, type LocalSubmission, type PilotEvaluation, type PilotRecord, type ProjectRecord, type ReplayRecord } from '../../core/models.ts';
import type { Brain } from '../../core/nn.ts';
import type { Replay } from '../../core/replay.ts';
import { CATEGORIES, checkBrainForCategory, OFFICIAL_TRACK_IDS } from '../../core/rules.ts';
import type { TrackDef } from '../../core/track.ts';
import type { GenStats } from '../../core/trainer.ts';
import { evaluateOnTracks } from '../../lab/evalClient.ts';
import { getLab, onLabChange } from '../../lab/labSession.ts';
import { builtTrack, listTrackDefs } from '../../lab/tracks.ts';
import { db } from '../../persistence/db.ts';
import { SUBMISSION_STATUS_LABEL, type SubmissionStatus } from '../../online/api.ts';
import type { EvalTrackResult } from '../../workers/protocol.ts';
import { downloadText, Empty, fmtDate, fmtNum, fmtPct, fmtTime, Hint, Loading, Progress, promptDialog, Seg, slug, Stat, Tabs, useAsync } from '../components.tsx';
import { LineChart } from '../LineChart.tsx';
import { ReplayPlayer, type ReplayEntry } from '../ReplayPlayer.tsx';
import { drawDeaths } from '../render/draw.ts';
import { dataChanged, navigate, toast, useApp } from '../store.ts';
import { TrackCanvas } from '../TrackCanvas.tsx';

type Tab = 'evolucao' | 'replays' | 'mortes' | 'pistas' | 'comparar' | 'treinadora' | 'ranking';

interface ProjectData {
  project: ProjectRecord;
  history: GenStats[];
  changes: { gen: number; changes: string[] }[];
  deaths: Record<string, number[]>;
  bestOfficial: { genome: Float64Array; generation: number; official: MultiResult | null; replay: Replay | null } | null;
  bestEver: { genome: Float64Array; generation: number; score: number; replay: Replay | null } | null;
  lastReplay: Replay | null;
  trackDefs: TrackDef[];
}

function useProjectData(projectId: string | null): { data: ProjectData | null; loading: boolean } {
  const lab = useSyncExternalStore(onLabChange, getLab);
  const live = useSyncExternalStore(
    (fn) => (lab ? lab.subscribe(fn) : () => undefined),
    () => lab?.view ?? null,
  );
  const stored = useAsync(async () => (projectId ? (await db.get<ProjectRecord>('projects', projectId)) ?? null : null), [projectId]);
  return useMemo(() => {
    if (live && lab && live.project.id === projectId) {
      return {
        loading: false,
        data: {
          project: live.project,
          history: live.history,
          changes: live.changes,
          deaths: live.deaths,
          bestOfficial: live.bestOfficial,
          bestEver: live.bestEver,
          lastReplay: live.bestReplay,
          trackDefs: live.trackDefs,
        },
      };
    }
    const p = stored.data;
    if (!p) return { data: null, loading: stored.loading };
    const s = p.snapshot;
    return {
      loading: false,
      data: {
        project: p,
        history: s?.history ?? [],
        changes: s?.changes ?? [],
        deaths: s?.deaths ?? {},
        bestOfficial: s?.bestOfficial ?? null,
        bestEver: s?.bestEver ?? null,
        lastReplay: s?.lastGenBestReplay ?? null,
        trackDefs: s?.trackDefs ?? [],
      },
    };
  }, [live, lab, projectId, stored.data, stored.loading]);
}

export function ResultsScreen() {
  const arg = useApp((s) => s.screenArg);
  const currentId = useApp((s) => s.currentProjectId);
  const projects = useAsync(() => db.getAll<ProjectRecord>('projects').catch(() => [] as ProjectRecord[]), []);
  const [projectId, setProjectId] = useState<string | null>(currentId);
  const [tab, setTab] = useState<Tab>((['evolucao', 'replays', 'mortes', 'pistas', 'comparar', 'treinadora', 'ranking'] as Tab[]).includes(arg as Tab) ? (arg as Tab) : 'evolucao');
  useEffect(() => {
    if (!projectId && projects.data?.length) setProjectId([...projects.data].sort((a, b) => b.updatedAt - a.updatedAt)[0].id);
  }, [projects.data, projectId]);
  const { data, loading } = useProjectData(projectId);

  return (
    <div className="page">
      <div className="spread" style={{ marginBottom: 8 }}>
        <h1 style={{ margin: 0 }}>Resultados e comparação</h1>
        <div className="row">
          <span className="badge local">Local = calculado no seu navegador</span>
          <span className="badge online">Oficial online = validado pelo servidor</span>
        </div>
      </div>
      {(projects.data?.length ?? 0) > 0 && (
        <label className="field" style={{ maxWidth: 420, marginBottom: 12 }}>
          <span className="field-label">Laboratório</span>
          <select value={projectId ?? ''} onChange={(e) => setProjectId(e.target.value)}>
            {[...(projects.data ?? [])]
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} (geração {p.generation})
                </option>
              ))}
          </select>
        </label>
      )}
      <Tabs
        tabs={[
          { id: 'evolucao', label: 'Evolução' },
          { id: 'replays', label: 'Replays' },
          { id: 'mortes', label: 'Mapa de mortes' },
          { id: 'pistas', label: 'Outras pistas' },
          { id: 'comparar', label: 'Comparar pilotos' },
          { id: 'treinadora', label: 'Treinadora' },
          { id: 'ranking', label: 'Enviar ao ranking' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {loading && <Loading />}
      {!loading && !data && ['evolucao', 'replays', 'mortes'].includes(tab) && (
        <Empty icon="📈" title="Nenhum laboratório ainda">
          Treine uma população no Laboratório para ver a evolução aqui.
        </Empty>
      )}
      {tab === 'evolucao' && data && <Evolution data={data} />}
      {tab === 'replays' && data && <Replays data={data} />}
      {tab === 'mortes' && data && <DeathMap data={data} />}
      {tab === 'pistas' && <OtherTracks data={data} />}
      {tab === 'comparar' && <Compare data={data} />}
      {tab === 'treinadora' && <CoachHistory />}
      {tab === 'ranking' && <RankingSend data={data} />}
    </div>
  );
}

function Evolution({ data }: { data: ProjectData }) {
  const h = data.history;
  if (!h.length) return <Empty icon="⏳" title="Ainda sem gerações concluídas">Comece o treino no Laboratório.</Empty>;
  const markers = data.changes.map((c) => ({ x: c.gen, label: c.changes.join('; ') }));
  const firstComplete = h.find((x) => x.completionRate > 0);
  const lastS = h[h.length - 1];
  return (
    <div className="stack">
      <div className="stats-row">
        <Stat label="Gerações" value={h.length} />
        <Stat label="1ª volta completa" value={firstComplete ? `G${firstComplete.gen}` : '—'} />
        <Stat label="Melhor volta (treino)" value={fmtTime(h.reduce<number | null>((m, x) => (x.bestLapTime !== null && (m === null || x.bestLapTime < m) ? x.bestLapTime : m), null))} />
        <Stat label="Campeão oficial" value={data.bestOfficial?.official ? fmtTime(data.bestOfficial.official.bestTime) : '—'} sub={data.bestOfficial ? `geração ${data.bestOfficial.generation}` : ''} />
        <Stat label="Conclusão (última)" value={fmtPct(lastS.completionRate)} />
        <Stat label="Passos simulados" value={(h.reduce((s, x) => s + x.carSteps, 0) / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mi'} />
      </div>
      <div className="panel">
        <h3>Pontuação de treino</h3>
        <LineChart
          height={220}
          xStart={h[0].gen}
          markers={markers}
          ariaLabel="Pontuação de treino por geração"
          series={[
            { label: 'Melhor', color: '#4dabf7', values: h.map((x) => x.bestScore) },
            { label: 'Média', color: '#b197fc', values: h.map((x) => x.meanScore) },
            { label: 'Mediana', color: '#868e96', values: h.map((x) => x.medianScore), dashed: true },
          ]}
        />
      </div>
      <div className="grid cols-2">
        <div className="panel">
          <h3>Progresso e conclusão</h3>
          <LineChart
            height={200}
            xStart={h[0].gen}
            markers={markers}
            yMin={0}
            yMax={100}
            yFormat={(v) => `${Math.round(v)}%`}
            ariaLabel="Melhor progresso e taxa de conclusão por geração"
            series={[
              { label: 'Melhor progresso', color: '#51cf66', values: h.map((x) => x.bestProgress * 100) },
              { label: 'Conclusão', color: '#fcc419', values: h.map((x) => x.completionRate * 100) },
            ]}
          />
        </div>
        <div className="panel">
          <h3>Tempo de volta (s)</h3>
          <LineChart
            height={200}
            xStart={h[0].gen}
            markers={markers}
            yFormat={(v) => v.toFixed(1)}
            ariaLabel="Melhor tempo de volta por geração"
            series={[
              { label: 'Melhor do treino', color: '#ff8787', values: h.map((x) => x.bestLapTime) },
              { label: 'Oficial (melhores avaliados)', color: '#ffd43b', values: h.map((x) => x.official?.bestTime ?? null), dashed: true },
            ]}
          />
        </div>
      </div>
      <div className="panel">
        <h3>Como terminaram as tentativas</h3>
        <LineChart
          height={180}
          xStart={h[0].gen}
          ariaLabel="Motivos de encerramento por geração"
          series={[
            { label: 'Bateram', color: '#ff6b6b', values: h.map((x) => x.deaths.batida) },
            { label: 'Sem progresso', color: '#868e96', values: h.map((x) => x.deaths.parado) },
            { label: 'Tempo', color: '#fcc419', values: h.map((x) => x.deaths.tempo) },
            { label: 'Completaram', color: '#51cf66', values: h.map((x) => x.deaths.completou) },
          ]}
        />
      </div>
      {data.changes.length > 0 && (
        <div className="panel">
          <h3>Mudanças de configuração</h3>
          <div className="log">
            {data.changes.map((c, i) => (
              <div className="msg decisao" key={i}>
                <strong>Geração {c.gen}:</strong> {c.changes.join(' · ')}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Replays({ data }: { data: ProjectData }) {
  const saved = useAsync(() => db.getAll<ReplayRecord>('replays').catch(() => [] as ReplayRecord[]), []);
  const tracks = useAsync(() => listTrackDefs(), []);
  const rays = data.project.config.inputs.rays;
  const options: { id: string; label: string; replay: Replay; rays?: typeof rays }[] = [];
  if (data.bestOfficial?.replay) options.push({ id: 'oficial', label: `Melhor volta — campeão oficial (G${data.bestOfficial.generation})`, replay: data.bestOfficial.replay, rays });
  if (data.lastReplay) options.push({ id: 'ultima', label: 'Melhor da última geração', replay: data.lastReplay, rays });
  if (data.bestEver?.replay) options.push({ id: 'recompensa', label: `Campeão por recompensa (G${data.bestEver.generation})`, replay: data.bestEver.replay, rays });
  for (const r of saved.data ?? []) options.push({ id: r.id, label: `Salvo: ${r.name}`, replay: r.replay });
  const [mainId, setMainId] = useState('oficial');
  const [ghostId, setGhostId] = useState('');
  const main = options.find((o) => o.id === mainId) ?? options[0];
  const ghost = options.find((o) => o.id === ghostId && o.id !== main?.id);
  const def = tracks.data?.find((t) => t.id === main?.replay.meta.trackId);
  if (!options.length) return <Empty icon="🎬" title="Nenhum replay ainda">Os replays da melhor volta aparecem ao fim de cada geração.</Empty>;
  const entries: ReplayEntry[] = main ? [{ replay: main.replay, label: main.replay.meta.pilotName ?? 'Piloto', color: '#4dabf7', rays: main.rays }] : [];
  if (ghost && ghost.replay.meta.trackId === main?.replay.meta.trackId) entries.push({ replay: ghost.replay, label: `Fantasma: ${ghost.replay.meta.pilotName ?? ghost.label}`, color: '#ffd43b', ghost: true });

  const saveReplay = async () => {
    if (!main) return;
    const name = await promptDialog('Salvar replay', 'Nome do replay', `${data.project.name} · ${main.label}`);
    if (!name) return;
    const rec: ReplayRecord = { id: newId('replay'), name, createdAt: Date.now(), trackName: def?.name ?? main.replay.meta.trackId, replay: main.replay };
    try {
      await db.put('replays', rec);
      dataChanged();
      toast('Replay salvo.', 'sucesso');
    } catch (e) {
      toast((e as Error).message, 'erro');
    }
  };

  return (
    <div className="stack">
      <div className="grid cols-2">
        <label className="field">
          <span className="field-label">Replay</span>
          <select value={main?.id} onChange={(e) => setMainId(e.target.value)}>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">
            <span className="row" style={{ gap: 6 }}>
              Comparar com (fantasma) <Hint text="Mostra outro piloto ao mesmo tempo, semitransparente. Os dois precisam ser da mesma pista." />
            </span>
          </span>
          <select value={ghostId} onChange={(e) => setGhostId(e.target.value)}>
            <option value="">Nenhum</option>
            {options
              .filter((o) => o.id !== main?.id && o.replay.meta.trackId === main?.replay.meta.trackId)
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
          </select>
        </label>
      </div>
      {def ? <ReplayPlayer track={builtTrack(def)} entries={entries} /> : <div className="callout warn">A pista deste replay não está disponível.</div>}
      <div className="btn-row">
        <button className="btn" onClick={() => void saveReplay()}>
          💾 Salvar replay
        </button>
        {main && (
          <button className="btn" onClick={() => downloadText(`replay-${slug(main.label)}.json`, exportJson('replay', { name: main.label, trackName: def?.name, replay: main.replay }))}>
            📤 Exportar replay
          </button>
        )}
        <span className="badge local">Replay local (gravado no seu navegador)</span>
      </div>
    </div>
  );
}

function DeathMap({ data }: { data: ProjectData }) {
  const ids = Object.keys(data.deaths).filter((k) => data.deaths[k].length);
  const [trackId, setTrackId] = useState(ids[0] ?? data.project.config.trackIds[0]);
  const def = data.trackDefs.find((d) => d.id === trackId);
  const pts = data.deaths[trackId] ?? [];
  if (!def) return <Empty icon="🗺️" title="Sem dados de batidas ainda" />;
  return (
    <div className="stack">
      {ids.length > 1 && (
        <Seg ariaLabel="Pista do mapa" value={trackId} onChange={setTrackId} options={ids.map((id) => ({ value: id, label: data.trackDefs.find((d) => d.id === id)?.name ?? id }))} />
      )}
      <p className="muted">
        Cada ponto vermelho é uma batida nas últimas gerações ({(pts.length / 2).toLocaleString('pt-BR')} batidas registradas). Manchas fortes mostram as curvas que mais derrubam pilotos.
      </p>
      <div className="lab-stage" style={{ height: 480 }}>
        <TrackCanvas track={builtTrack(def)} ariaLabel="Mapa de mortes na pista" redrawKey={pts.length} onDraw={({ ctx, cam }) => drawDeaths(ctx, pts, cam.scale)} />
      </div>
    </div>
  );
}

interface PilotChoice {
  id: string;
  name: string;
  color: string;
  brain: Brain;
  record?: PilotRecord;
  originTracks: string[];
}

function usePilotChoices(data: ProjectData | null): { choices: PilotChoice[]; loading: boolean } {
  const pilots = useAsync(() => db.getAll<PilotRecord>('pilots').catch(() => [] as PilotRecord[]), []);
  const choices: PilotChoice[] = [];
  if (data?.bestOfficial) {
    choices.push({
      id: 'lab-oficial',
      name: `Campeão oficial de "${data.project.name}" (não salvo)`,
      color: '#4dabf7',
      brain: { inputs: data.project.config.inputs, hidden: data.project.config.hidden, genome: data.bestOfficial.genome },
      originTracks: data.project.config.trackIds,
    });
  }
  for (const p of (pilots.data ?? []).sort((a, b) => b.updatedAt - a.updatedAt)) {
    choices.push({ id: p.id, name: p.name, color: p.color, brain: p.brain, record: p, originTracks: p.origin.trackIds ?? [] });
  }
  return { choices, loading: pilots.loading };
}

function ResultCells({ r }: { r: MultiResult }) {
  return (
    <>
      <td className="num">{fmtPct(r.completionRate)}</td>
      <td className="num">{fmtTime(r.medianTime)}</td>
      <td className="num">{fmtTime(r.bestTime)}</td>
      <td className="num">{fmtPct(r.meanProgress)}</td>
    </>
  );
}

function OtherTracks({ data }: { data: ProjectData | null }) {
  const { choices } = usePilotChoices(data);
  const tracks = useAsync(() => listTrackDefs(), []);
  const [pilotId, setPilotId] = useState('');
  const [attempts, setAttempts] = useState(3);
  const [running, setRunning] = useState<{ done: number; total: number; label: string } | null>(null);
  const [results, setResults] = useState<EvalTrackResult[] | null>(null);
  const [replay, setReplay] = useState<EvalTrackResult | null>(null);
  const pilot = choices.find((c) => c.id === pilotId) ?? choices[0];

  const run = async () => {
    if (!pilot || !tracks.data) return;
    setResults(null);
    setReplay(null);
    setRunning({ done: 0, total: tracks.data.length, label: '' });
    try {
      const { promise } = evaluateOnTracks(pilot.brain, tracks.data, attempts, {
        pilotName: pilot.name,
        color: pilot.color,
        onProgress: (done, total, label) => setRunning({ done, total, label }),
      });
      const res = await promise;
      setResults(res);
      audio.genEnd();
      if (pilot.record) {
        const now = Date.now();
        const evals: PilotEvaluation[] = res.map((r) => ({
          trackId: r.trackId,
          trackName: r.trackName,
          trackVersion: tracks.data!.find((t) => t.id === r.trackId)?.version ?? 1,
          attempts,
          result: r.result,
          date: now,
        }));
        const kept = pilot.record.evaluations.filter((e) => !evals.some((n) => n.trackId === e.trackId));
        await db.put('pilots', { ...pilot.record, evaluations: [...kept, ...evals], updatedAt: now });
        dataChanged();
      }
    } catch (e) {
      toast((e as Error).message, 'erro');
    } finally {
      setRunning(null);
    }
  };

  if (!choices.length) return <Empty icon="🧭" title="Nenhum piloto para testar">Salve um campeão no Laboratório (botão "Salvar campeão oficial").</Empty>;
  return (
    <div className="stack">
      <p className="muted">Teste um piloto em todas as pistas, inclusive nas que ele nunca viu. Cada pista roda com as largadas padronizadas e as regras oficiais.</p>
      <div className="grid cols-3">
        <label className="field">
          <span className="field-label">Piloto</span>
          <select value={pilot?.id} onChange={(e) => setPilotId(e.target.value)}>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          <span className="field-label">Tentativas por pista</span>
          <Seg ariaLabel="Tentativas" value={attempts} onChange={setAttempts} options={[1, 3, 5].map((n) => ({ value: n, label: String(n) }))} />
        </div>
        <div className="field" style={{ justifyContent: 'flex-end' }}>
          <button className="btn primary" disabled={!!running} onClick={() => void run()}>
            {running ? 'Avaliando…' : 'Avaliar em todas as pistas'}
          </button>
        </div>
      </div>
      {running && (
        <div className="stack" style={{ gap: 4 }}>
          <Progress value={running.done / Math.max(1, running.total)} label="Progresso da avaliação" />
          <span className="field-hint">{running.label}</span>
        </div>
      )}
      {results && (
        <div className="panel tight table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Pista</th>
                <th>Conhecida?</th>
                <th className="num">Conclusão</th>
                <th className="num">Mediana</th>
                <th className="num">Melhor</th>
                <th className="num">Progresso médio</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.trackId}>
                  <td>{r.trackName}</td>
                  <td>{pilot?.originTracks.includes(r.trackId) ? <span className="badge">treinou aqui</span> : <span className="badge info">nova</span>}</td>
                  <ResultCells r={r.result} />
                  <td>
                    <button className="btn small" disabled={!r.replay} onClick={() => setReplay(r)}>
                      Replay
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="field-hint">
            Resultados <span className="badge local">locais</span>. {pilot?.record ? 'Salvos nas avaliações do piloto (Garagem).' : 'Salve o campeão para guardar as avaliações.'}
          </p>
        </div>
      )}
      {replay?.replay && tracks.data && (
        <ReplayPlayer
          track={builtTrack(tracks.data.find((t) => t.id === replay.trackId)!)}
          entries={[{ replay: replay.replay, label: pilot?.name ?? 'Piloto', color: pilot?.color ?? '#4dabf7', rays: pilot?.brain.inputs.rays }]}
        />
      )}
    </div>
  );
}

function Compare({ data }: { data: ProjectData | null }) {
  const { choices } = usePilotChoices(data);
  const tracks = useAsync(() => listTrackDefs(), []);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [trackId, setTrackId] = useState('oval-largo');
  const [attempts, setAttempts] = useState(3);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ a: EvalTrackResult; b: EvalTrackResult; pa: PilotChoice; pb: PilotChoice } | null>(null);
  const pa = choices.find((c) => c.id === a) ?? choices[0];
  const pb = choices.find((c) => c.id === b) ?? choices[1];
  const def = tracks.data?.find((t) => t.id === trackId);

  const run = async () => {
    if (!pa || !pb || !def) return;
    setBusy(true);
    setRes(null);
    try {
      const [ra, rb] = await Promise.all([
        evaluateOnTracks(pa.brain, [def], attempts, { pilotName: pa.name, color: pa.color }).promise,
        evaluateOnTracks(pb.brain, [def], attempts, { pilotName: pb.name, color: pb.color }).promise,
      ]);
      setRes({ a: ra[0], b: rb[0], pa, pb });
    } catch (e) {
      toast((e as Error).message, 'erro');
    } finally {
      setBusy(false);
    }
  };

  if (choices.length < 2) return <Empty icon="⚖️" title="Precisa de dois pilotos">Salve pelo menos dois pilotos na Garagem para comparar.</Empty>;
  const cmp = res ? compareMulti(res.a.result, res.b.result) : 0;
  return (
    <div className="stack">
      <div className="grid cols-4">
        <label className="field">
          <span className="field-label">Piloto A</span>
          <select value={pa?.id} onChange={(e) => setA(e.target.value)}>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Piloto B</span>
          <select value={pb?.id} onChange={(e) => setB(e.target.value)}>
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Pista</span>
          <select value={trackId} onChange={(e) => setTrackId(e.target.value)}>
            {(tracks.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          <span className="field-label">Tentativas</span>
          <Seg ariaLabel="Tentativas" value={attempts} onChange={setAttempts} options={[1, 3, 5].map((n) => ({ value: n, label: String(n) }))} />
        </div>
      </div>
      <div className="btn-row">
        <button className="btn primary" disabled={busy || pa?.id === pb?.id} onClick={() => void run()}>
          {busy ? 'Comparando…' : 'Comparar'}
        </button>
        <Hint text={`Critérios oficiais, nesta ordem: ${MULTI_CRITERIA.join(' ')}`} />
      </div>
      {res && (
        <>
          <div className="panel tight table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Piloto</th>
                  <th className="num">Conclusão</th>
                  <th className="num">Mediana</th>
                  <th className="num">Melhor</th>
                  <th className="num">Progresso médio</th>
                </tr>
              </thead>
              <tbody>
                <tr className={cmp < 0 ? 'highlight' : ''}>
                  <td>
                    <span className="swatch" style={{ background: res.pa.color, marginRight: 6 }} />
                    {res.pa.name} {cmp < 0 && '🏆'}
                  </td>
                  <ResultCells r={res.a.result} />
                </tr>
                <tr className={cmp > 0 ? 'highlight' : ''}>
                  <td>
                    <span className="swatch" style={{ background: res.pb.color, marginRight: 6 }} />
                    {res.pb.name} {cmp > 0 && '🏆'}
                  </td>
                  <ResultCells r={res.b.result} />
                </tr>
              </tbody>
            </table>
            <p className="field-hint">{cmp === 0 ? 'Empate pelos critérios oficiais.' : `Vencedor pelos critérios oficiais (local): ${cmp < 0 ? res.pa.name : res.pb.name}.`}</p>
          </div>
          {def && res.a.replay && res.b.replay && (
            <ReplayPlayer
              track={builtTrack(def)}
              entries={[
                { replay: res.a.replay, label: res.pa.name, color: res.pa.color, rays: res.pa.brain.inputs.rays },
                { replay: res.b.replay, label: res.pb.name, color: res.pb.color, ghost: true },
              ]}
            />
          )}
        </>
      )}
    </div>
  );
}

function CoachHistory() {
  const coaches = useAsync(() => db.getAll<CoachRecord>('coaches').catch(() => [] as CoachRecord[]), []);
  const [id, setId] = useState('');
  const list = (coaches.data ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
  const c = list.find((x) => x.id === id) ?? list[0];
  if (!list.length) return <Empty icon="🤖" title="Nenhuma treinadora executada">Crie uma na aba "Treinadora" do Laboratório.</Empty>;
  const s = c?.snapshot;
  return (
    <div className="stack">
      <label className="field" style={{ maxWidth: 420 }}>
        <span className="field-label">Treinadora</span>
        <select value={c?.id} onChange={(e) => setId(e.target.value)}>
          {list.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name} ({x.status})
            </option>
          ))}
        </select>
      </label>
      {!s ? (
        <p className="muted">Esta treinadora ainda não rodou.</p>
      ) : (
        <>
          <div className="stats-row">
            <Stat label="Experimentos" value={`${s.candidates.length}/${c.config.maxExperiments}`} />
            <Stat label="Passos de treino" value={`${(s.budgetUsed / 1e6).toFixed(1)} mi`} />
            <Stat label="Passos de validação" value={`${(s.valStepsUsed / 1e6).toFixed(2)} mi`} />
            <Stat label="Melhor" value={s.bestIndex > 0 ? `nº ${s.bestIndex}` : '—'} />
            <Stat label="Teste final" value={s.finalTest ? fmtPct(s.finalTest.result.completionRate) : '—'} sub={s.finalTest ? 'conclusão nas pistas reservadas' : ''} />
          </div>
          <div className="panel tight table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Fase</th>
                  <th className="num">Pop.</th>
                  <th>Rede</th>
                  <th className="num">Parâm.</th>
                  <th className="num">Custo/passo</th>
                  <th className="num">Mutação</th>
                  <th className="num">Elite</th>
                  <th className="num">Conclusão</th>
                  <th className="num">Tempo (×ref.)</th>
                  <th className="num">Gerações</th>
                  <th className="num">Passos</th>
                </tr>
              </thead>
              <tbody>
                {s.candidates.map((x) => (
                  <tr key={x.index} className={x.index === s.bestIndex ? 'highlight' : ''}>
                    <td>
                      {x.index}
                      {x.parent ? ` ← ${x.parent}` : ''}
                    </td>
                    <td>{x.phase}</td>
                    <td className="num">{x.params.population}</td>
                    <td>{x.params.hidden.join('×')}</td>
                    <td className="num">{x.params_count}</td>
                    <td className="num">{x.cost}</td>
                    <td className="num">
                      {(x.params.mutationRate * 100).toFixed(1)}% × {x.params.mutationStrength.toFixed(2)}
                    </td>
                    <td className="num">{x.params.eliteCount}</td>
                    <td className="num">{fmtPct(x.validation.completionRate)}</td>
                    <td className="num">{x.timeIndex !== null ? fmtNum(x.timeIndex, 3) : '—'}</td>
                    <td className="num">{x.runs.map((r) => r.generations).join('+')}</td>
                    <td className="num">{(x.carSteps / 1e6).toFixed(2)} mi</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel">
            <h3>Decisões explicadas</h3>
            <div className="log" style={{ maxHeight: 360 }}>
              {s.messages.map((m, i) => (
                <div key={i} className={`msg ${m.kind}`}>
                  {m.text}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function RankingSend({ data }: { data: ProjectData | null }) {
  const pilots = useAsync(() => db.getAll<PilotRecord>('pilots').catch(() => [] as PilotRecord[]), []);
  const subs = useAsync(() => db.getAll<LocalSubmission>('submissions').catch(() => [] as LocalSubmission[]), []);
  void data;
  const list = (pilots.data ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <div className="stack">
      <div className="callout">
        Para disputar o <strong>ranking público</strong>, o servidor roda o seu piloto de novo com as regras oficiais e calcula o tempo. Tempos locais servem só de estimativa.
        Salve o piloto na Garagem e envie pela tela Ranking.
      </div>
      {!list.length ? (
        <Empty icon="💾" title="Nenhum piloto salvo">Use "Salvar campeão oficial" no Laboratório.</Empty>
      ) : (
        <div className="panel tight table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Piloto</th>
                {CATEGORIES.map((c) => (
                  <th key={c.id}>Categoria {c.name}</th>
                ))}
                <th>Pistas oficiais completadas (local)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((p) => {
                const done = p.evaluations.filter((e) => OFFICIAL_TRACK_IDS.includes(e.trackId) && e.result.completionRate > 0).map((e) => e.trackName);
                return (
                  <tr key={p.id}>
                    <td>
                      <span className="swatch" style={{ background: p.color, marginRight: 6 }} />
                      {p.name}
                    </td>
                    {CATEGORIES.map((c) => {
                      const probs = checkBrainForCategory(p.brain, c);
                      return <td key={c.id}>{probs.length ? <span className="badge err" title={probs.join(' ')}>Não elegível</span> : <span className="badge ok">Elegível</span>}</td>;
                    })}
                    <td>{done.length ? done.join(', ') : <span className="faint">avalie em "Outras pistas"</span>}</td>
                    <td>
                      <button className="btn small primary" onClick={() => navigate('ranking', `enviar:${p.id}`)}>
                        Enviar ao ranking
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <h3>
        Envios <span className="badge online">oficial online</span>
      </h3>
      {(subs.data ?? []).length === 0 ? (
        <p className="muted">Nenhum envio ainda.</p>
      ) : (
        <div className="panel tight table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Data</th>
                <th>Piloto</th>
                <th>Pista</th>
                <th>Categoria</th>
                <th>Estado</th>
                <th className="num">Tempo oficial</th>
              </tr>
            </thead>
            <tbody>
              {[...(subs.data ?? [])]
                .sort((x, y) => y.createdAt - x.createdAt)
                .map((s) => (
                  <tr key={s.id}>
                    <td>{fmtDate(s.createdAt)}</td>
                    <td>{s.pilotName}</td>
                    <td>{s.trackId}</td>
                    <td>{s.categoryId}</td>
                    <td>{SUBMISSION_STATUS_LABEL[s.status as SubmissionStatus] ?? s.status}</td>
                    <td className="num">{fmtTime(s.officialTime ?? null)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
