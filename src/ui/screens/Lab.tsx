import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { audio } from '../../audio/audio.ts';
import type { ProjectRecord } from '../../core/models.ts';
import { paramCount } from '../../core/nn.ts';
import { PHYSICS } from '../../core/physics.ts';
import { inputLabels } from '../../core/sensors.ts';
import { END_REASON_LABEL } from '../../core/sim.ts';
import type { Track } from '../../core/track.ts';
import { getCoach, onCoachChange, type CoachSession } from '../../lab/coachSession.ts';
import { getLab, LabSession, onLabChange } from '../../lab/labSession.ts';
import { builtTrack, getTrackDef } from '../../lab/tracks.ts';
import { db } from '../../persistence/db.ts';
import { CAR_STRIDE, CODE_KIND, CODE_STATUS, type LiveFrame, type SelectedCarInfo } from '../../workers/protocol.ts';
import { Empty, fmtNum, fmtPct, fmtTime, Hint, Loading, Seg, Stat, Tabs, useAsync } from '../components.tsx';
import { LineChart } from '../LineChart.tsx';
import { colorForId, drawCar, drawCrashEffect, drawPath, drawSensors, type CarLook } from '../render/draw.ts';
import { navigate, openNewLab, setState, useApp } from '../store.ts';
import { TrackCanvas, type CameraMode } from '../TrackCanvas.tsx';
import { LabConfigPanel } from './LabConfigPanel.tsx';
import { CoachPanel } from './CoachPanel.tsx';

const KIND_LABEL = { elite: 'Elite (copiado sem mutação)', filho: 'Filho (com mutação)', cruzado: 'Filho de cruzamento', novo: 'Piloto novo (aleatório)' } as const;

function useLab(): LabSession | null {
  return useSyncExternalStore(onLabChange, getLab);
}
function useCoachSession(): CoachSession | null {
  return useSyncExternalStore(onCoachChange, getCoach);
}

export function LabScreen() {
  const projectId = useApp((s) => s.currentProjectId);
  const screenArg = useApp((s) => s.screenArg);
  const session = useLab();
  const [error, setError] = useState<string | null>(null);
  const projects = useAsync(() => db.getAll<ProjectRecord>('projects').catch(() => [] as ProjectRecord[]), []);

  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    setError(null);
    LabSession.open(projectId).then(
      (s) => {
        if (!alive) return;
        void db.kvSet('lastProjectId', projectId).catch(() => undefined);
        if (screenArg === 'autoplay') {
          setState({ screenArg: null });
          const start = () => (s.view.ready ? s.play(1) : setTimeout(start, 100));
          start();
        }
      },
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  if (!projectId) {
    const list = (projects.data ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
    return (
      <div className="page">
        <Empty icon="🧪" title="Nenhum laboratório aberto">
          <p>Crie um laboratório para começar a treinar uma população de pilotos.</p>
          <div className="btn-row" style={{ justifyContent: 'center' }}>
            <button className="btn primary big" onClick={() => openNewLab()}>
              Novo laboratório
            </button>
          </div>
          {list.length > 0 && (
            <div className="stack" style={{ marginTop: 16, alignItems: 'center' }}>
              <span>Ou continue um existente:</span>
              {list.slice(0, 5).map((p) => (
                <button key={p.id} className="btn" onClick={() => setState({ currentProjectId: p.id })}>
                  {p.name} · geração {p.generation}
                </button>
              ))}
            </div>
          )}
        </Empty>
      </div>
    );
  }
  if (error) {
    return (
      <div className="page">
        <div className="callout err">
          <strong>Não foi possível abrir o laboratório.</strong> {error}
        </div>
        <div className="btn-row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => setState({ currentProjectId: null })}>
            Voltar
          </button>
        </div>
      </div>
    );
  }
  if (!session || session.view.project.id !== projectId) return <Loading text="Abrindo laboratório…" />;
  return <LabView session={session} />;
}

function LabView({ session }: { session: LabSession }) {
  const view = useSyncExternalStore(
    (fn) => session.subscribe(fn),
    () => session.view,
  );
  const prefs = useApp((s) => s.prefs);
  const coach = useCoachSession();
  const [sideTab, setSideTab] = useState<'piloto' | 'treinadora'>('piloto');
  const [camMode, setCamMode] = useState<CameraMode>('geral');
  const [selected, setSelected] = useState(-1);
  const [showGhost, setShowGhost] = useState(false);
  const [showSensors, setShowSensors] = useState(!prefs.hideSensors);
  const selectedRef = useRef(-1);
  selectedRef.current = selected;
  const trail = useRef<{ pts: Float32Array; n: number; gen: number; car: number }>({ pts: new Float32Array(1200), n: 0, gen: -1, car: -1 });
  const [selInfo, setSelInfo] = useState<SelectedCarInfo | null>(null);
  const coachView = sideTab === 'treinadora' && coach?.view.running;

  useEffect(() => {
    coach?.setView(!!coachView);
  }, [coach, coachView]);

  const frameSource = (): LiveFrame | null => (coachView ? coach?.frame ?? null : session.frame);
  const coachTrackId = coachView ? coach?.frame?.trackId : null;
  const [coachDefs, setCoachDefs] = useState<Record<string, Track>>({});
  const trackDef = coachTrackId ? coachDefs[coachTrackId]?.def ?? null : view.trackDefs[Math.min(session.frame?.trackIdx ?? 0, view.trackDefs.length - 1)];
  const track: Track | null = useMemo(() => {
    if (coachTrackId) {
      if (coachDefs[coachTrackId]) return coachDefs[coachTrackId];
      return null;
    }
    return trackDef ? builtTrack(trackDef) : null;
  }, [trackDef, coachTrackId, coachDefs]);

  useEffect(() => {
    if (!coachTrackId || coachDefs[coachTrackId]) return;
    void getTrackDef(coachTrackId).then((d) => {
      if (d) setCoachDefs((m) => ({ ...m, [coachTrackId]: builtTrack(d) }));
    });
  }, [coachTrackId, coachDefs]);

  // Inspetor do carro selecionado: atualiza a ~6 Hz
  useEffect(() => {
    const t = setInterval(() => {
      const f = session.frame;
      setSelInfo(f?.selected ?? null);
    }, 160);
    return () => clearInterval(t);
  }, [session]);

  useEffect(() => {
    session.select(selected);
  }, [selected, session]);

  // Motor do carro acompanhado (selecionado ou líder no modo seguir)
  useEffect(() => {
    const t = setInterval(() => {
      const f = frameSource();
      const running = coachView ? false : view.running;
      if (!f || !running || prefs.muted) {
        audio.setEngine(false, 0, 0);
        return;
      }
      const idx = selected >= 0 ? selected : camMode === 'seguir' ? f.leader : -1;
      if (idx < 0 || idx * CAR_STRIDE >= f.cars.length) {
        audio.setEngine(false, 0, 0);
        return;
      }
      const alive = f.cars[idx * CAR_STRIDE + 3] === 0;
      const speed = f.cars[idx * CAR_STRIDE + 4];
      const thr = f.selected && f.selected.index === idx ? f.selected.outputs[1] : 0.6;
      audio.setEngine(alive, speed / PHYSICS.speedNorm, thr);
    }, 80);
    return () => {
      clearInterval(t);
      audio.setEngine(false, 0, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.running, selected, camMode, coachView, prefs.muted]);

  // Atalhos de teclado
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return;
      const speeds: Record<string, number | 'max'> = { '1': 1, '2': 2, '3': 5, '4': 10, '5': 'max' };
      if (e.key === ' ') {
        e.preventDefault();
        if (view.running) session.pause();
        else session.play(view.speed);
      } else if (speeds[e.key] !== undefined) session.play(speeds[e.key]);
      else if (e.key.toLowerCase() === 'n' && !view.running) session.step();
      else if (e.key.toLowerCase() === 'g') session.finishGeneration();
      else if (e.key === 'Escape') setSelected(-1);
      else if (e.key.toLowerCase() === 'l' && session.frame && session.frame.leader >= 0) setSelected(session.frame.leader);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session, view.running, view.speed]);

  const last = view.history[view.history.length - 1];
  const bestOfficialTime = view.bestOfficial?.official?.bestTime ?? null;
  const histBestLap = view.history.reduce<number | null>((m, h) => (h.bestLapTime !== null && (m === null || h.bestLapTime < m) ? h.bestLapTime : m), null);
  const frame = session.frame;
  const speedLabel = view.speed === 'max' ? 'máx' : `${view.speed}×`;

  const series = useMemo(() => {
    const h = view.history;
    return {
      score: [
        { label: 'Melhor', color: '#4dabf7', values: h.map((x) => x.bestScore) },
        { label: 'Média', color: '#b197fc', values: h.map((x) => x.meanScore) },
        { label: 'Mediana', color: '#868e96', values: h.map((x) => x.medianScore), dashed: true },
      ],
      progress: [
        { label: 'Melhor progresso', color: '#51cf66', values: h.map((x) => x.bestProgress * 100) },
        { label: 'Conclusão', color: '#fcc419', values: h.map((x) => x.completionRate * 100) },
      ],
      markers: view.changes.map((c) => ({ x: c.gen, label: c.changes.join('; ') })),
    };
  }, [view.history, view.changes]);

  const onDraw = ({ ctx, cam, now }: { ctx: CanvasRenderingContext2D; cam: { scale: number }; now: number }) => {
    const f = frameSource();
    if (!f) return;
    const n = f.cars.length / CAR_STRIDE;
    // fantasma do campeão oficial
    if (showGhost && !coachView && view.bestOfficial?.replay && view.bestOfficial.replay.meta.trackId === f.trackId) {
      const rep = view.bestOfficial.replay;
      const fr = rep.frames;
      const idx = Math.min(fr.length / 7 - 1, Math.floor(f.time / rep.meta.frameDt));
      if (idx >= 0) drawCar(ctx, fr[idx * 7], fr[idx * 7 + 1], fr[idx * 7 + 2], '#ffffff', 'fantasma', cam.scale);
    }
    // rastro do selecionado
    const tr = trail.current;
    const sel = coachView ? -1 : selectedRef.current;
    if (sel >= 0 && sel < n) {
      if (tr.gen !== f.gen || tr.car !== sel || f.step < 2) {
        tr.n = 0;
        tr.gen = f.gen;
        tr.car = sel;
      }
      const x = f.cars[sel * CAR_STRIDE];
      const y = f.cars[sel * CAR_STRIDE + 1];
      const k = tr.n - 1;
      if (tr.n === 0 || Math.abs(tr.pts[k * 2] - x) + Math.abs(tr.pts[k * 2 + 1] - y) > 1.5) {
        if (tr.n >= tr.pts.length / 2) {
          tr.pts.copyWithin(0, 2);
          tr.n--;
        }
        tr.pts[tr.n * 2] = x;
        tr.pts[tr.n * 2 + 1] = y;
        tr.n++;
      }
      drawPath(ctx, tr.pts, 'rgba(255,255,255,0.55)', cam.scale, 1.4, tr.n);
    }
    // mortos primeiro, vivos por cima
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        const o = i * CAR_STRIDE;
        const st = CODE_STATUS[f.cars[o + 3]];
        const alive = st === 'correndo';
        if ((pass === 0) === alive) continue;
        const kind = CODE_KIND[f.cars[o + 5]];
        const look: CarLook = st === 'batida' ? 'morto' : st === 'completou' ? 'concluido' : st === 'correndo' ? 'normal' : 'parado';
        const color = colorForId(f.cars[o + 6]);
        drawCar(ctx, f.cars[o], f.cars[o + 1], f.cars[o + 2], color, look, cam.scale, {
          selected: i === sel,
          elite: kind === 'elite',
          fresh: kind === 'novo',
          steer: i === sel && f.selected ? f.selected.outputs[0] : 0,
        });
      }
    }
    if (sel >= 0 && f.selected && f.selected.index === sel && showSensors && !prefs.hideSensors && f.selected.status === 'correndo') {
      const o = sel * CAR_STRIDE;
      drawSensors(ctx, f.cars[o], f.cars[o + 1], f.cars[o + 2], f.selected.rays, view.config.inputs.rays, cam.scale);
    }
    if (!prefs.hideEffects && !coachView) {
      const fx = session.effects;
      for (let i = fx.length - 1; i >= 0; i--) {
        const age = (now - fx[i].t) / 1000;
        if (age > 0.6) fx.splice(i, 1);
        else drawCrashEffect(ctx, fx[i].x, fx[i].y, age, cam.scale, prefs.reduceMotion);
      }
    }
  };

  const pickCar = (x: number, y: number) => {
    const f = frameSource();
    if (!f || coachView) return;
    let best = -1;
    let bd = 64;
    for (let i = 0; i < f.cars.length / CAR_STRIDE; i++) {
      const dx = f.cars[i * CAR_STRIDE] - x;
      const dy = f.cars[i * CAR_STRIDE + 1] - y;
      const d = dx * dx + dy * dy;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    audio.click();
    setSelected(best);
  };

  return (
    <div className="page-wide">
      <div className="lab">
        <div className="lab-stage">
          <TrackCanvas
            track={track}
            animate
            cameraMode={camMode}
            followTarget={() => {
              const f = frameSource();
              if (!f) return null;
              const i = selectedRef.current >= 0 && !coachView ? selectedRef.current : f.leader;
              if (i < 0) return null;
              return { x: f.cars[i * CAR_STRIDE], y: f.cars[i * CAR_STRIDE + 1] };
            }}
            onDraw={onDraw}
            onClickWorld={pickCar}
            showCheckpoints={prefs.showCheckpoints}
            ariaLabel={`Pista ${trackDef?.name ?? ''} com a população de pilotos`}
          >
            <div className="hud">
              <span className="chip">{coachView ? 'Treinadora ao vivo' : view.project.name}</span>
              <span className="chip">Geração {coachView ? coach?.frame?.gen ?? '—' : view.generation}</span>
              <span className="chip">
                Vivos {(coachView ? coach?.frame?.alive : frame?.alive) ?? 0}/{(coachView ? coach?.frame?.total : frame?.total) ?? 0}
              </span>
              <span className="chip">{fmtNum((coachView ? coach?.frame?.time : frame?.time) ?? 0, 1)} s</span>
              {trackDef && <span className="chip">{trackDef.name}</span>}
            </div>
            <div className="stage-tools">
              <Seg
                ariaLabel="Câmera"
                value={camMode}
                onChange={setCamMode}
                options={[
                  { value: 'geral', label: 'Visão geral', title: 'Mostra a pista inteira' },
                  { value: 'seguir', label: 'Seguir', title: 'Segue o carro selecionado ou o líder' },
                ]}
              />
              <button className="btn small" aria-pressed={showSensors} onClick={() => setShowSensors(!showSensors)} title="Mostrar sensores do carro selecionado">
                Sensores
              </button>
              <button className="btn small" aria-pressed={showGhost} onClick={() => setShowGhost(!showGhost)} title="Fantasma do campeão oficial (melhor volta)">
                Fantasma
              </button>
              {!coachView && (
                <button
                  className="btn small"
                  title="Seleciona o carro que está mais à frente (tecla L)"
                  onClick={() => {
                    const f = session.frame;
                    if (f && f.leader >= 0) setSelected(f.leader);
                  }}
                >
                  Inspecionar líder
                </button>
              )}
            </div>
            <div className="legend" aria-hidden>
              <span>▬ listra dourada: elite</span>
              <span>┅ contorno tracejado: novo</span>
              <span>✕ cinza: bateu</span>
              <span>▢ verde: completou</span>
              <span>Clique num carro para inspecionar · arraste para mover · Ctrl + roda para zoom · duplo clique centraliza</span>
            </div>
            {selected >= 0 && selInfo && !coachView && <CarInspector info={selInfo} session={session} onClose={() => setSelected(-1)} />}
          </TrackCanvas>
        </div>

        <aside className="lab-side" aria-label="Configurações">
          <div style={{ padding: '10px 14px 0' }}>
            <Tabs
              tabs={[
                { id: 'piloto', label: '🧠 Piloto' },
                { id: 'treinadora', label: '🤖 Treinadora' },
              ]}
              value={sideTab}
              onChange={setSideTab}
            />
          </div>
          <div className="lab-side-body">{sideTab === 'piloto' ? <LabConfigPanel session={session} /> : <CoachPanel lab={session} />}</div>
        </aside>

        <section className="lab-bottom" aria-label="Controles e estatísticas">
          <div className="panel tight">
            <div className="controls">
              <button
                className={`btn ${view.running ? '' : 'primary'} big`}
                disabled={!view.ready}
                onClick={() => (view.running ? session.pause() : session.play(view.speed))}
                title="Espaço"
              >
                {view.running ? '⏸ Pausar' : '▶ Treinar'}
              </button>
              <Seg
                ariaLabel="Velocidade da simulação"
                value={view.speed}
                onChange={(v) => session.play(v)}
                options={[
                  { value: 1, label: '1×', title: 'Velocidade normal (tecla 1)' },
                  { value: 2, label: '2×', title: 'Tecla 2' },
                  { value: 5, label: '5×', title: 'Tecla 3' },
                  { value: 10, label: '10×', title: 'Tecla 4' },
                  { value: 'max' as const, label: 'Máx', title: 'O máximo que o aparelho aguentar (tecla 5). A física continua com passo fixo de 1/60 s.' },
                ]}
              />
              <button className="btn" disabled={view.running || !view.ready} onClick={() => session.step()} title="Avança um passo de 1/60 s (tecla N)">
                ⏭ Passo
              </button>
              <button className="btn" disabled={!view.ready} onClick={() => session.finishGeneration()} title="Roda até o fim da geração e pausa (tecla G)">
                ⏩ Fim da geração
              </button>
              <Hint text="Acelerar não muda a física: cada passo continua valendo 1/60 s. Só rodamos mais passos por segundo real. Atalhos: espaço (treinar/pausar), 1–5 (velocidade), N (passo), G (fim da geração), L (inspecionar líder), Esc (fechar inspeção)." />
              <span className="muted" style={{ marginLeft: 'auto' }}>
                {frame && view.running ? `${Math.round(frame.stepsPerSec).toLocaleString('pt-BR')} passos/s` : ''}
                {view.saveError ? <span className="badge err" style={{ marginLeft: 8 }}>Erro ao salvar</span> : view.lastSavedAt ? <span className="faint" style={{ marginLeft: 8 }}>Salvo automaticamente</span> : null}
              </span>
            </div>
          </div>
          <div className="stats-row">
            <Stat label="Geração" value={view.generation} sub={`${paramCount(view.config.inputs, view.config.hidden)} parâmetros`} />
            <Stat label="Carros vivos" value={`${frame?.alive ?? 0} / ${frame?.total ?? view.config.evo.populationSize}`} />
            <Stat label="Melhor progresso" value={fmtPct(frame?.bestProgress ?? 0)} sub="nesta geração" />
            <Stat label="Melhor tempo válido" value={fmtTime(bestOfficialTime ?? histBestLap)} sub={bestOfficialTime !== null ? 'campeão oficial (local)' : 'no treino'} />
            <Stat label="Taxa de conclusão" value={last ? fmtPct(last.completionRate) : '—'} sub="última geração" />
            <Stat label="Pontuação de treino" value={last ? fmtNum(last.bestScore, 1) : '—'} sub={last ? `média ${fmtNum(last.meanScore, 1)}` : 'melhor da geração'} />
            <Stat
              label="Estado"
              value={view.pendingConfig ? 'Mudança agendada' : !view.ready ? 'Preparando' : view.running ? 'Treinando' : 'Pausado'}
              sub={view.pendingConfig ? 'entra na próxima geração' : view.running ? `velocidade ${speedLabel}` : `${paramCount(view.config.inputs, view.config.hidden)} parâmetros`}
            />
          </div>
          {view.history.length > 0 ? (
            <div className="grid cols-2">
              <div className="panel tight">
                <h4>Pontuação de treino por geração</h4>
                <LineChart series={series.score} markers={series.markers} xStart={view.history[0]?.gen ?? 1} ariaLabel="Gráfico da pontuação de treino por geração" height={170} />
              </div>
              <div className="panel tight">
                <h4>Progresso e conclusão (%)</h4>
                <LineChart
                  series={series.progress}
                  markers={series.markers}
                  xStart={view.history[0]?.gen ?? 1}
                  yMin={0}
                  yMax={100}
                  yFormat={(v) => `${Math.round(v)}%`}
                  ariaLabel="Gráfico do melhor progresso e taxa de conclusão por geração"
                  height={170}
                />
              </div>
            </div>
          ) : (
            <div className="callout">
              Clique em <strong>▶ Treinar</strong>. No começo os carros dirigem mal: os cérebros são aleatórios. Ao fim de cada geração, os que avançaram mais viram pais da próxima.
            </div>
          )}
          {view.lastResults.length > 0 && <GenerationTable session={session} />}
        </section>
      </div>
    </div>
  );
}

function GenerationTable({ session }: { session: LabSession }) {
  const view = session.view;
  const [open, setOpen] = useState(false);
  return (
    <div className="panel tight">
      <div className="spread">
        <h4 style={{ margin: 0 }}>Classificação da última geração ({view.history[view.history.length - 1]?.gen})</h4>
        <div className="btn-row">
          <button className="btn small" onClick={() => navigate('resultados')}>
            Ver resultados completos
          </button>
          <button className="btn small" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Esconder' : 'Mostrar'}
          </button>
        </div>
      </div>
      {open && (
        <div className="table-wrap" style={{ maxHeight: 260, marginTop: 8 }}>
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Piloto</th>
                <th>Tipo</th>
                <th className="num">Pontuação</th>
                <th className="num">Progresso</th>
                <th className="num">Volta</th>
                <th>Fim</th>
              </tr>
            </thead>
            <tbody>
              {view.lastResults.slice(0, 20).map((r, i) => (
                <tr key={r.id}>
                  <td>{i + 1}</td>
                  <td>#{r.id}</td>
                  <td>{r.kind}</td>
                  <td className="num">{fmtNum(r.score, 1)}</td>
                  <td className="num">{fmtPct(r.progress)}</td>
                  <td className="num">{fmtTime(r.lapTime)}</td>
                  <td>{END_REASON_LABEL[r.reason]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function IoBar({ label, value, signed, title }: { label: string; value: number; signed?: boolean; title?: string }) {
  const v = Math.max(signed ? -1 : 0, Math.min(1, value));
  const style = signed ? { left: v < 0 ? `${50 + v * 50}%` : '50%', width: `${Math.abs(v) * 50}%` } : { left: 0, width: `${v * 100}%` };
  return (
    <div className="io-row" title={title}>
      <span className="lbl">{label}</span>
      <div className={`bar${signed ? ' center' : ''}`}>
        <div style={{ ...style, background: signed ? (v < 0 ? '#74c0fc' : '#ff8787') : '#4dabf7' }} />
      </div>
      <span className="v">{value.toFixed(2)}</span>
    </div>
  );
}

function CarInspector({ info, session, onClose }: { info: SelectedCarInfo; session: LabSession; onClose: () => void }) {
  const labels = inputLabels(session.view.config.inputs);
  const brakeOn = info.outputs[2] > PHYSICS.brakeThreshold;
  return (
    <div className="inspector" role="region" aria-label="Carro selecionado">
      <div className="spread">
        <strong>
          <span className="swatch" style={{ background: colorForId(info.id), marginRight: 6 }} />
          Piloto #{info.id}
        </strong>
        <button className="btn ghost small icon" aria-label="Fechar inspeção" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="muted" style={{ marginBottom: 6 }}>
        {KIND_LABEL[info.kind]}
        {info.parents.length > 0 && info.kind !== 'elite' ? ` · pais: ${info.parents.map((p) => `#${p}`).join(', ')}` : ''}
      </div>
      <div className="row" style={{ gap: 6, marginBottom: 8 }}>
        <span className={`badge ${info.status === 'correndo' ? 'info' : info.status === 'completou' ? 'ok' : 'err'}`}>{END_REASON_LABEL[info.status]}</span>
        <span className="badge">{Math.round(info.speed * 3.6)} km/h</span>
        <span className="badge">{fmtPct(info.progress)} da volta</span>
        {info.lapTime !== null && <span className="badge ok">{fmtTime(info.lapTime)}</span>}
      </div>
      <h4>Entradas (o que o carro percebe)</h4>
      {info.inputs.map((v, i) => (
        <IoBar key={i} label={labels[i]?.short ?? `E${i}`} value={v} signed={labels[i]?.range === '-1..1'} title={`${labels[i]?.label} — ${labels[i]?.group === 'pista' ? 'informação da pista' : 'sensor físico'}`} />
      ))}
      <h4 style={{ marginTop: 8 }}>Saídas (o que a rede decide)</h4>
      <IoBar label="Direção" value={info.outputs[0]} signed title="−1 esquerda, +1 direita" />
      <IoBar label="Acelerador" value={brakeOn ? 0 : info.outputs[1]} title="0 a 1. Ignorado quando o freio passa de 50%." />
      <IoBar label="Freio" value={info.outputs[2]} title="Atua acima de 50% e tem prioridade sobre o acelerador." />
      {brakeOn && <div className="field-hint">Freio acima de 50%: o acelerador é ignorado (freio tem prioridade).</div>}
      <h4 style={{ marginTop: 8 }}>Pontuação de treino até agora: {fmtNum(info.score, 1)}</h4>
      {info.terms
        .filter((t) => Math.abs(t.value) > 0.005)
        .map((t) => (
          <div key={t.key} className="spread" style={{ fontSize: '0.9em' }}>
            <span className="muted">{t.label}</span>
            <span className="mono">{t.value >= 0 ? '+' : ''}{t.value.toFixed(1)}</span>
          </div>
        ))}
    </div>
  );
}
