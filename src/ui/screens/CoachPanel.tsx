import { useEffect, useState, useSyncExternalStore } from 'react';
import { ARCH_PRESETS } from '../../core/config.ts';
import { COACH_LIMITS, defaultCoachConfig, fmtSteps, OBJECTIVE_LABEL, type CoachConfig, type CoachObjective, type RangeSpec, type StopKind } from '../../core/coach.ts';
import type { CoachRecord } from '../../core/models.ts';
import { POPULATION_OPTIONS } from '../../core/evolution.ts';
import { createCoachRecord, CoachSession, getCoach, onCoachChange } from '../../lab/coachSession.ts';
import { createProject, type LabSession } from '../../lab/labSession.ts';
import { listTrackDefs } from '../../lab/tracks.ts';
import { db } from '../../persistence/db.ts';
import { confirmDialog, Empty, fmtNum, fmtPct, Hint, Progress, Seg, Toggle, useAsync } from '../components.tsx';
import { navigate, setState, toast } from '../store.ts';

const STATUS_LABEL: Record<CoachRecord['status'], string> = { nova: 'Nova', rodando: 'Rodando', pausada: 'Pausada', concluida: 'Concluída', cancelada: 'Cancelada' };

export function CoachPanel({ lab }: { lab: LabSession }) {
  const session = useSyncExternalStore(onCoachChange, getCoach);
  const coaches = useAsync(() => db.getAll<CoachRecord>('coaches').catch(() => [] as CoachRecord[]), []);
  const [creating, setCreating] = useState(false);

  if (creating) return <CoachForm lab={lab} onDone={() => setCreating(false)} />;
  if (session) return <CoachRun session={session} onNew={() => setCreating(true)} />;

  const list = (coaches.data ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <div className="stack">
      <p className="muted">
        A treinadora é uma IA que organiza experimentos por você: testa configurações, treina uma população para cada uma, compara os pilotos pelas regras oficiais e
        escolhe o que testar em seguida.
      </p>
      <button className="btn primary" onClick={() => setCreating(true)}>
        🤖 Criar treinadora
      </button>
      {list.length === 0 ? (
        <Empty title="Nenhuma treinadora ainda" />
      ) : (
        <div className="stack">
          <h4>Suas treinadoras</h4>
          {list.map((c) => (
            <div key={c.id} className="item-card">
              <div className="spread">
                <strong>{c.name}</strong>
                <span className={`badge ${c.status === 'concluida' ? 'ok' : c.status === 'rodando' ? 'info' : ''}`}>{STATUS_LABEL[c.status]}</span>
              </div>
              <span className="muted" style={{ fontSize: '0.88em' }}>
                {OBJECTIVE_LABEL[c.config.objective]} · {c.snapshot?.candidates.length ?? 0}/{c.config.maxExperiments} experimentos
              </span>
              <div className="btn-row">
                <button
                  className="btn small"
                  onClick={() =>
                    void CoachSession.open(c.id).catch((e: Error) => {
                      toast(e.message, 'erro');
                    })
                  }
                >
                  {c.status === 'concluida' || c.status === 'cancelada' ? 'Ver resultados' : c.snapshot ? 'Abrir e retomar' : 'Abrir'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RangeEditor(props: { label: string; spec: RangeSpec; onChange: (s: RangeSpec) => void; min: number; max: number; step: number; fmt: (v: number) => string; hint?: string }) {
  const s = props.spec;
  return (
    <div className="field" style={{ borderLeft: '2px solid var(--border)', paddingLeft: 8 }}>
      <Toggle label={props.label} checked={s.vary} onChange={(v) => props.onChange({ ...s, vary: v })} hint={props.hint} />
      {s.vary && (
        <div className="row" style={{ gap: 6 }}>
          <span className="field-hint">de</span>
          <input
            type="number"
            aria-label={`${props.label}: mínimo`}
            style={{ width: 90 }}
            min={props.min}
            max={props.max}
            step={props.step}
            value={s.min}
            onChange={(e) => props.onChange({ ...s, min: Number(e.target.value) })}
          />
          <span className="field-hint">até</span>
          <input
            type="number"
            aria-label={`${props.label}: máximo`}
            style={{ width: 90 }}
            min={props.min}
            max={props.max}
            step={props.step}
            value={s.max}
            onChange={(e) => props.onChange({ ...s, max: Number(e.target.value) })}
          />
          <span className="field-hint">
            ({props.fmt(props.min)}–{props.fmt(props.max)})
          </span>
        </div>
      )}
    </div>
  );
}

function TrackPick(props: { label: string; hint: string; value: string[]; onChange: (v: string[]) => void; tracks: { id: string; name: string }[]; disabled?: (id: string) => boolean; max: number }) {
  return (
    <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="field-label">
        <span className="row" style={{ gap: 6 }}>
          {props.label} <Hint text={props.hint} />
        </span>
      </legend>
      <div className="row" style={{ gap: 4 }}>
        {props.tracks.map((t) => {
          const on = props.value.includes(t.id);
          const dis = !on && (props.disabled?.(t.id) || props.value.length >= props.max);
          return (
            <button
              key={t.id}
              type="button"
              className="btn small"
              aria-pressed={on}
              disabled={dis}
              onClick={() => props.onChange(on ? props.value.filter((x) => x !== t.id) : [...props.value, t.id])}
            >
              {t.name}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function CoachForm({ lab, onDone }: { lab: LabSession; onDone: () => void }) {
  const tracks = useAsync(() => listTrackDefs(), []);
  const [name, setName] = useState('Treinadora');
  const [cfg, setCfg] = useState<CoachConfig>(() => defaultCoachConfig(lab.view.config));
  const [busy, setBusy] = useState(false);
  const s = cfg.space;
  const setSpace = (p: Partial<CoachConfig['space']>) => setCfg({ ...cfg, space: { ...s, ...p } });
  const tl = (tracks.data ?? []).map((t) => ({ id: t.id, name: t.name }));
  const millions = cfg.totalBudget / 1e6;
  const perRun = cfg.totalBudget / cfg.maxExperiments / cfg.seeds.length;
  // estimativa grosseira: ~250 mil passos-carro por segundo num computador comum
  const estMin = cfg.totalBudget / 250_000 / 60;

  const create = async () => {
    if (!cfg.trainTracks.length || !cfg.valTracks.length) return toast('Escolha pistas de treino e de validação.', 'aviso');
    setBusy(true);
    try {
      const rec = await createCoachRecord(name, { ...cfg, name });
      await CoachSession.open(rec.id);
      onDone();
    } catch (e) {
      toast((e as Error).message, 'erro');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="spread">
        <h3 style={{ margin: 0 }}>Nova treinadora</h3>
        <button className="btn ghost small" onClick={onDone}>
          Voltar
        </button>
      </div>
      <label className="field">
        <span className="field-label">Nome</span>
        <input type="text" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="field">
        <span className="field-label">Objetivo</span>
        <select value={cfg.objective} onChange={(e) => setCfg({ ...cfg, objective: e.target.value as CoachObjective })}>
          {(Object.keys(OBJECTIVE_LABEL) as CoachObjective[]).map((o) => (
            <option key={o} value={o}>
              {OBJECTIVE_LABEL[o]}
            </option>
          ))}
        </select>
        {cfg.objective === 'tempo' && (
          <label className="field">
            <span className="field-label">
              Conclusão mínima <span className="value">{fmtPct(cfg.minCompletion)}</span>
            </span>
            <input type="range" min={0.2} max={1} step={0.05} value={cfg.minCompletion} onChange={(e) => setCfg({ ...cfg, minCompletion: Number(e.target.value) })} />
          </label>
        )}
        <span className="field-hint">
          A comparação usa sempre os critérios oficiais fixos (conclusão, depois mediana dos tempos, depois progresso). A treinadora não pode mudar esses critérios.
        </span>
      </div>
      <TrackPick
        label="Pistas de treino"
        hint="Onde as populações treinam."
        value={cfg.trainTracks}
        onChange={(v) => setCfg({ ...cfg, trainTracks: v, testTracks: cfg.testTracks.filter((t) => !v.includes(t)) })}
        tracks={tl}
        max={3}
      />
      <TrackPick
        label="Pistas de validação"
        hint="Orientam as decisões da treinadora. Para generalizar, use pistas diferentes das de treino."
        value={cfg.valTracks}
        onChange={(v) => setCfg({ ...cfg, valTracks: v, testTracks: cfg.testTracks.filter((t) => !v.includes(t)) })}
        tracks={tl}
        max={5}
      />
      <TrackPick
        label="Pistas de teste final (reservadas)"
        hint="Usadas uma única vez no fim, sem orientar decisões. Não podem ser de treino nem de validação."
        value={cfg.testTracks}
        onChange={(v) => setCfg({ ...cfg, testTracks: v })}
        tracks={tl}
        disabled={(id) => cfg.trainTracks.includes(id) || cfg.valTracks.includes(id)}
        max={5}
      />
      <div className="field">
        <span className="field-label">Largadas por pista de validação</span>
        <Seg ariaLabel="Tentativas de validação" value={cfg.valAttempts} onChange={(v) => setCfg({ ...cfg, valAttempts: v })} options={[1, 3, 5].map((n) => ({ value: n, label: String(n) }))} />
      </div>

      <h4>O que a treinadora pode variar</h4>
      <div className="field" style={{ borderLeft: '2px solid var(--border)', paddingLeft: 8 }}>
        <Toggle label="População" checked={s.population.vary} onChange={(v) => setSpace({ population: { ...s.population, vary: v } })} />
        {s.population.vary && (
          <div className="row" style={{ gap: 4 }}>
            {POPULATION_OPTIONS.map((p) => {
              const on = s.population.options.includes(p);
              return (
                <button
                  key={p}
                  className="btn small"
                  aria-pressed={on}
                  onClick={() => setSpace({ population: { ...s.population, options: on ? s.population.options.filter((x) => x !== p) : [...s.population.options, p].sort((a, b) => a - b) } })}
                >
                  {p}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="field" style={{ borderLeft: '2px solid var(--border)', paddingLeft: 8 }}>
        <Toggle label="Arquitetura da rede" checked={s.architecture.vary} onChange={(v) => setSpace({ architecture: { ...s.architecture, vary: v } })} hint="Redes de tamanhos diferentes são comparadas com o mesmo orçamento; o custo e os parâmetros ficam registrados." />
        {s.architecture.vary && (
          <div className="row" style={{ gap: 4 }}>
            {ARCH_PRESETS.map((a) => {
              const key = a.hidden.join('x');
              const on = s.architecture.options.some((o) => o.join('x') === key);
              return (
                <button
                  key={key}
                  className="btn small"
                  aria-pressed={on}
                  onClick={() =>
                    setSpace({ architecture: { ...s.architecture, options: on ? s.architecture.options.filter((o) => o.join('x') !== key) : [...s.architecture.options, a.hidden] } })
                  }
                >
                  {a.hidden.join('×')}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="field" style={{ borderLeft: '2px solid var(--border)', paddingLeft: 8 }}>
        <Toggle label="Quantidade de sensores" checked={s.rays.vary} onChange={(v) => setSpace({ rays: { ...s.rays, vary: v } })} />
      </div>
      <RangeEditor label="Chance de mutação" spec={s.mutationRate} onChange={(v) => setSpace({ mutationRate: v })} min={0.005} max={0.6} step={0.005} fmt={(v) => `${Math.round(v * 100)}%`} />
      <RangeEditor label="Intensidade de mutação" spec={s.mutationStrength} onChange={(v) => setSpace({ mutationStrength: v })} min={0.01} max={1.5} step={0.01} fmt={(v) => v.toFixed(2)} />
      <RangeEditor label="Elite" spec={s.eliteCount} onChange={(v) => setSpace({ eliteCount: v })} min={0} max={20} step={1} fmt={(v) => String(v)} />
      <RangeEditor label="Fração de pais" spec={s.selectionFraction} onChange={(v) => setSpace({ selectionFraction: v })} min={0.05} max={0.6} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} />
      <RangeEditor label="Cruzamento" spec={s.crossoverRate} onChange={(v) => setSpace({ crossoverRate: v })} min={0} max={1} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} />
      <RangeEditor label="Pilotos novos" spec={s.freshFraction} onChange={(v) => setSpace({ freshFraction: v })} min={0} max={0.3} step={0.01} fmt={(v) => `${Math.round(v * 100)}%`} />
      <div className="field" style={{ borderLeft: '2px solid var(--border)', paddingLeft: 8 }}>
        <Toggle
          label="Recompensas (só se você permitir)"
          checked={s.rewards.vary}
          onChange={(v) => setSpace({ rewards: { ...s.rewards, vary: v } })}
          hint="A treinadora multiplica os pesos ativos por um fator até o limite abaixo. A avaliação oficial não muda."
        />
        {s.rewards.vary && (
          <label className="field">
            <span className="field-label">
              Fator máximo <span className="value">×{s.rewards.factor.toFixed(1)}</span>
            </span>
            <input type="range" min={1.1} max={4} step={0.1} value={s.rewards.factor} onChange={(e) => setSpace({ rewards: { ...s.rewards, factor: Number(e.target.value) } })} />
          </label>
        )}
      </div>
      <p className="field-hint">O que não varia vem da configuração atual do laboratório ({lab.view.project.name}).</p>

      <h4>Orçamento e parada</h4>
      <label className="field">
        <span className="field-label">
          Experimentos <span className="value">{cfg.maxExperiments}</span>
        </span>
        <input
          type="range"
          min={COACH_LIMITS.maxExperiments.min}
          max={30}
          step={1}
          value={cfg.maxExperiments}
          onChange={(e) => setCfg({ ...cfg, maxExperiments: Number(e.target.value) })}
        />
      </label>
      <label className="field">
        <span className="field-label">
          <span className="row" style={{ gap: 6 }}>
            Orçamento total <Hint text="Medido em passos de simulação (um carro avançando 1/60 s). Cada experimento recebe a mesma parte: populações maiores fazem menos gerações." />
          </span>
          <span className="value">{fmtSteps(cfg.totalBudget)} passos</span>
        </span>
        <input type="range" min={4} max={300} step={2} value={millions} onChange={(e) => setCfg({ ...cfg, totalBudget: Number(e.target.value) * 1e6 })} />
        <span className="field-hint">
          {fmtSteps(perRun)} passos por experimento e semente · estimativa: ~{Math.max(1, Math.round(estMin))} min neste tipo de computador (varia muito entre aparelhos)
        </span>
      </label>
      <label className="field">
        <span className="field-label">
          <span className="row" style={{ gap: 6 }}>
            Sementes <Hint text="Cada configuração treina com as mesmas sementes, para uma comparação justa. Mais sementes = resultado mais confiável e mais demorado." />
          </span>
        </span>
        <Seg
          ariaLabel="Número de sementes"
          value={cfg.seeds.length}
          onChange={(n) => setCfg({ ...cfg, seeds: ['t1', 't2', 't3'].slice(0, n) })}
          options={[1, 2, 3].map((n) => ({ value: n, label: `${n}` }))}
        />
      </label>
      <div className="field">
        <span className="field-label">Critério de parada</span>
        <Seg
          ariaLabel="Critério de parada"
          value={cfg.stop.kind}
          onChange={(k: StopKind) => setCfg({ ...cfg, stop: { ...cfg.stop, kind: k } })}
          options={[
            { value: 'orcamento', label: 'Orçamento' },
            { value: 'alvo', label: 'Atingir alvo' },
            { value: 'estagnacao', label: 'Estagnação' },
          ]}
        />
        {cfg.stop.kind === 'alvo' && (
          <label className="field">
            <span className="field-label">
              Conclusão alvo na validação <span className="value">{fmtPct(cfg.stop.targetCompletion)}</span>
            </span>
            <input type="range" min={0.2} max={1} step={0.05} value={cfg.stop.targetCompletion} onChange={(e) => setCfg({ ...cfg, stop: { ...cfg.stop, targetCompletion: Number(e.target.value) } })} />
          </label>
        )}
        {cfg.stop.kind === 'estagnacao' && (
          <label className="field">
            <span className="field-label">
              Parar após experimentos sem melhora <span className="value">{cfg.stop.patience}</span>
            </span>
            <input type="range" min={2} max={12} step={1} value={cfg.stop.patience} onChange={(e) => setCfg({ ...cfg, stop: { ...cfg.stop, patience: Number(e.target.value) } })} />
          </label>
        )}
        <span className="field-hint">O orçamento e o número de experimentos sempre limitam a busca.</span>
      </div>
      <button className="btn primary big" disabled={busy} onClick={() => void create()}>
        Criar treinadora
      </button>
    </div>
  );
}

function CoachRun({ session, onNew }: { session: CoachSession; onNew: () => void }) {
  const v = useSyncExternalStore(
    (fn) => session.subscribe(fn),
    () => session.view,
  );
  const [live, setLive] = useState(true);
  useEffect(() => {
    session.setView(live);
  }, [live, session]);
  const p = v.progress;
  const best = v.candidates.find((c) => c.index === v.bestIndex);
  const finalTest = v.record.snapshot?.finalTest;
  const cfg = v.record.config;

  return (
    <div className="stack">
      <div className="spread">
        <h3 style={{ margin: 0 }}>{v.record.name}</h3>
        <span className={`badge ${v.finished ? 'ok' : v.running ? 'info' : ''}`}>{v.finished ? 'Concluída' : v.running ? 'Rodando' : 'Pausada'}</span>
      </div>
      <div className="muted" style={{ fontSize: '0.88em' }}>
        {OBJECTIVE_LABEL[cfg.objective]}
        {cfg.objective === 'tempo' ? ` (mín. ${fmtPct(cfg.minCompletion)})` : ''} · treino: {cfg.trainTracks.join(', ')} · validação: {cfg.valTracks.join(', ')}
        {cfg.testTracks.length ? ` · teste: ${cfg.testTracks.join(', ')}` : ''}
      </div>
      {v.error && <div className="callout err">{v.error}</div>}
      {p && (
        <div className="stack" style={{ gap: 6 }}>
          <div className="spread field-hint">
            <span>
              {v.finished
                ? `${v.candidates.length} experimentos concluídos`
                : `Experimento ${Math.min(p.experiment, p.total)} de ${p.total}${cfg.seeds.length > 1 ? ` · semente ${p.seedIdx + 1}/${cfg.seeds.length}` : ''} · geração ${p.generation}`}
            </span>
            <span>
              {fmtSteps(p.budgetUsed)} / {fmtSteps(p.budget)} passos
            </span>
          </div>
          <Progress value={p.budgetUsed / p.budget} label="Orçamento usado" />
          {!v.finished && <Progress value={p.runSteps / Math.max(1, p.runBudget)} label="Experimento atual" />}
        </div>
      )}
      <div className="btn-row">
        {!v.finished && (
          <button className={`btn ${v.running ? '' : 'primary'}`} disabled={!v.ready} onClick={() => (v.running ? session.pause() : session.run())}>
            {v.running ? '⏸ Pausar' : v.record.snapshot ? '▶ Retomar' : '▶ Começar'}
          </button>
        )}
        {!v.finished && (
          <button
            className="btn danger"
            disabled={!v.ready}
            onClick={async () => {
              if (await confirmDialog('Cancelar treinadora', 'A busca termina agora e fica com o melhor resultado encontrado até aqui. Continuar?', 'Cancelar busca')) session.cancel();
            }}
          >
            Cancelar
          </button>
        )}
        <button className="btn" onClick={() => void session.saveNow()} disabled={!v.ready}>
          Salvar
        </button>
        <label className="check">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Ver treino ao vivo
        </label>
      </div>
      <div className="btn-row">
        <button className="btn small ghost" onClick={() => void session.close()}>
          Fechar
        </button>
        <button className="btn small ghost" onClick={onNew}>
          Nova treinadora
        </button>
        <button className="btn small ghost" onClick={() => navigate('resultados', 'treinadora')}>
          Histórico completo
        </button>
      </div>

      {best && (
        <section className="panel tight">
          <h4>Melhor até agora: experimento {best.index}</h4>
          <div className="kv">
            <dt>Conclusão (validação)</dt>
            <dd>{fmtPct(best.validation.completionRate)}</dd>
            <dt>Tempo mediano</dt>
            <dd>{best.timeIndex !== null ? `${best.timeIndex.toFixed(3)}× a referência` : '—'}</dd>
            <dt>Progresso médio</dt>
            <dd>{fmtPct(best.validation.meanProgress)}</dd>
            <dt>Rede</dt>
            <dd>
              {best.config.hidden.join('×')} · {best.params_count} parâmetros · custo {best.cost}
            </dd>
            <dt>População</dt>
            <dd>{best.params.population}</dd>
            <dt>Mutação</dt>
            <dd>
              {(best.params.mutationRate * 100).toFixed(1)}% × {best.params.mutationStrength.toFixed(2)}
            </dd>
          </div>
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button className="btn small primary" onClick={() => void session.saveBestPilot()}>
              💾 Salvar melhor piloto
            </button>
            <button
              className="btn small"
              onClick={async () => {
                try {
                  const pr = await createProject(`${v.record.name}: melhor configuração`, best.config);
                  setState({ currentProjectId: pr.id });
                  navigate('laboratorio', 'autoplay');
                } catch (e) {
                  toast((e as Error).message, 'erro');
                }
              }}
            >
              Usar configuração em novo laboratório
            </button>
          </div>
        </section>
      )}
      {finalTest && (
        <div className="callout ok">
          <strong>Teste final (pistas reservadas):</strong> conclusão {fmtPct(finalTest.result.completionRate)}
          {finalTest.result.medianTime !== null ? `, tempo ${finalTest.result.medianTime.toFixed(3)}× a referência` : `, progresso ${fmtPct(finalTest.result.meanProgress)}`}. Ele não influenciou as escolhas.
        </div>
      )}

      <section>
        <h4>Decisões da treinadora</h4>
        <div className="log" aria-live="polite">
          {v.messages.length === 0 && <span className="muted">As mensagens aparecem quando a busca começar.</span>}
          {[...v.messages].reverse().map((m, i) => (
            <div key={i} className={`msg ${m.kind}`}>
              {m.text}
            </div>
          ))}
        </div>
      </section>

      {v.candidates.length > 0 && (
        <section>
          <h4>Experimentos</h4>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Fase</th>
                  <th className="num">Pop.</th>
                  <th>Rede</th>
                  <th className="num">Conclusão</th>
                  <th className="num">Tempo</th>
                  <th className="num">Gerações</th>
                </tr>
              </thead>
              <tbody>
                {v.candidates.map((c) => (
                  <tr key={c.index} className={c.index === v.bestIndex ? 'highlight' : ''}>
                    <td>
                      {c.index}
                      {c.index === v.bestIndex ? ' ★' : ''}
                    </td>
                    <td>{c.phase}</td>
                    <td className="num">{c.params.population}</td>
                    <td>{c.config.hidden.join('×')}</td>
                    <td className="num">{fmtPct(c.validation.completionRate)}</td>
                    <td className="num">{c.timeIndex !== null ? fmtNum(c.timeIndex, 3) : '—'}</td>
                    <td className="num">{c.runs.map((r) => r.generations).join('+')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="field-hint">Tempo = mediana do tempo de volta dividido pelo tempo de referência de cada pista (menor é melhor).</p>
        </section>
      )}
    </div>
  );
}
