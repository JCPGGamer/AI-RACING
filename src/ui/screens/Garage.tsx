import { useState, type ReactNode } from 'react';
import { OBJECTIVE_LABEL } from '../../core/coach.ts';
import { exportJson, ImportError, KIND_LABEL, parseImport, type ExportKind } from '../../core/io.ts';
import { newId, PILOT_COLORS, type CoachRecord, type CustomTrackRecord, type LineageRecord, type PilotRecord, type ProjectRecord, type ReplayRecord, type SavedConfigRecord } from '../../core/models.ts';
import { costPerStep, describeArch, paramCount } from '../../core/nn.ts';
import { eligibleCategories } from '../../core/rules.ts';
import { describeInputs, usesTrackInfo } from '../../core/sensors.ts';
import { CoachSession, getCoach } from '../../lab/coachSession.ts';
import { createProject, getLab } from '../../lab/labSession.ts';
import { builtTrack, getTrackDef } from '../../lab/tracks.ts';
import { db, type StoreName } from '../../persistence/db.ts';
import { confirmDialog, downloadText, Empty, fmtDate, fmtPct, fmtTime, Hint, Loading, Modal, pickFile, promptDialog, slug, Tabs, useAsync } from '../components.tsx';
import { ReplayPlayer } from '../ReplayPlayer.tsx';
import { dataChanged, navigate, openNewLab, setState, toast } from '../store.ts';

type Tab = 'pilotos' | 'laboratorios' | 'configuracoes' | 'treinadoras' | 'linhagens' | 'replays';

async function guard(fn: () => Promise<unknown>) {
  try {
    await fn();
    dataChanged();
  } catch (e) {
    toast((e as Error).message, 'erro', 7000);
  }
}

async function remove(store: StoreName, id: string, what: string, beforeDelete?: () => void) {
  if (!(await confirmDialog(`Excluir ${what}`, `Tem certeza? "${what}" será apagado deste navegador. Exporte antes se quiser guardar uma cópia.`))) return;
  beforeDelete?.();
  await guard(() => db.delete(store, id));
  toast('Excluído.', 'info');
}

function exportItem(kind: ExportKind, name: string, data: unknown) {
  downloadText(`${kind}-${slug(name)}.json`, exportJson(kind, data));
}

export async function importFile(): Promise<void> {
  const file = await pickFile();
  if (!file) return;
  if (file.size > 40 * 1024 * 1024) {
    toast('Arquivo grande demais (máximo 40 MB).', 'erro');
    return;
  }
  try {
    const text = await file.text();
    const r = parseImport(text);
    const now = Date.now();
    switch (r.tipo) {
      case 'piloto':
        await db.put('pilots', { ...r.data, id: newId('piloto'), createdAt: now, updatedAt: now });
        break;
      case 'pista': {
        const id = newId('pista');
        const rec: CustomTrackRecord = { id, def: { ...r.data, id, builtin: false, createdAt: now, updatedAt: now }, createdAt: now, updatedAt: now };
        await db.put('tracks', rec);
        break;
      }
      case 'configuracao':
        await db.put('configs', { ...r.data, id: newId('config') });
        break;
      case 'treinadora':
        await db.put('coaches', { ...r.data, id: newId('treinadora') });
        break;
      case 'projeto':
        await db.put('projects', { ...r.data, id: newId('lab') });
        break;
      case 'replay':
        await db.put('replays', { ...r.data, id: newId('replay') });
        break;
    }
    dataChanged();
    const warnings = 'warnings' in r ? r.warnings : [];
    toast(`${KIND_LABEL[r.tipo]} importado com sucesso.${warnings.length ? ` Avisos: ${warnings.join(' ')}` : ''}`, 'sucesso', 7000);
  } catch (e) {
    toast(e instanceof ImportError ? `Importação recusada: ${e.message}` : `Falha ao importar: ${(e as Error).message}`, 'erro', 8000);
  }
}

export function GarageScreen() {
  const [tab, setTab] = useState<Tab>('pilotos');
  return (
    <div className="page">
      <div className="spread" style={{ marginBottom: 10 }}>
        <div>
          <h1 style={{ margin: 0 }}>Garagem de IAs</h1>
          <p className="muted" style={{ margin: 0 }}>
            Tudo fica salvo neste navegador. Exporte em JSON para guardar ou compartilhar.
          </p>
        </div>
        <div className="btn-row">
          <button className="btn" onClick={() => void importFile()}>
            📥 Importar arquivo
          </button>
          <button className="btn primary" onClick={() => openNewLab()}>
            🧪 Novo laboratório
          </button>
        </div>
      </div>
      <Tabs
        tabs={[
          { id: 'pilotos', label: 'Pilotos' },
          { id: 'laboratorios', label: 'Laboratórios' },
          { id: 'configuracoes', label: 'Configurações' },
          { id: 'treinadoras', label: 'Treinadoras' },
          { id: 'linhagens', label: 'Linhagens' },
          { id: 'replays', label: 'Replays' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'pilotos' && <Pilots />}
      {tab === 'laboratorios' && <Projects />}
      {tab === 'configuracoes' && <Configs />}
      {tab === 'treinadoras' && <Coaches />}
      {tab === 'linhagens' && <Lineages />}
      {tab === 'replays' && <Replays />}
    </div>
  );
}

function CardActions({ children }: { children: ReactNode }) {
  return <div className="btn-row">{children}</div>;
}

function Pilots() {
  const pilots = useAsync(() => db.getAll<PilotRecord>('pilots'), []);
  const [sel, setSel] = useState<string | null>(null);
  const [watch, setWatch] = useState<PilotRecord | null>(null);
  if (pilots.loading && !pilots.data) return <Loading />;
  if (pilots.error) return <div className="callout err">{pilots.error}</div>;
  const list = (pilots.data ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
  if (!list.length)
    return (
      <Empty icon="🧠" title="Nenhum piloto salvo">
        No Laboratório, use "Salvar campeão oficial" depois de algumas gerações. Ou importe um piloto.
      </Empty>
    );
  const p = list.find((x) => x.id === sel);
  return (
    <div className="grid" style={{ gridTemplateColumns: p ? 'minmax(0,1fr) minmax(0,1.2fr)' : '1fr' }}>
      <div className="cards" style={{ alignContent: 'start' }}>
        {list.map((x) => (
          <div key={x.id} className={`item-card${x.id === sel ? ' selected' : ''}`}>
            <div className="spread">
              <strong className="row" style={{ gap: 6 }}>
                <span className="swatch" style={{ background: x.color }} />
                {x.name}
              </strong>
              <span className="badge">{x.origin.kind}</span>
            </div>
            <span className="muted" style={{ fontSize: '0.86em' }}>
              {describeArch(x.brain.inputs, x.brain.hidden)} · {paramCount(x.brain.inputs, x.brain.hidden)} parâmetros
            </span>
            <CardActions>
              <button className="btn small primary" onClick={() => setSel(x.id === sel ? null : x.id)}>
                {x.id === sel ? 'Fechar' : 'Detalhes'}
              </button>
              <button className="btn small" onClick={() => openNewLab({ pilotId: x.id })} title="Começa outro experimento a partir deste cérebro">
                Treinar a partir dele
              </button>
            </CardActions>
          </div>
        ))}
      </div>
      {p && (
        <div className="panel stack" style={{ alignSelf: 'start' }}>
          <div className="spread">
            <h2 style={{ margin: 0 }}>{p.name}</h2>
            <input
              type="color"
              aria-label="Cor do piloto"
              value={p.color}
              onChange={(e) => void guard(() => db.put('pilots', { ...p, color: e.target.value, updatedAt: Date.now() }))}
            />
          </div>
          <dl className="kv">
            <dt>Arquitetura</dt>
            <dd>{describeArch(p.brain.inputs, p.brain.hidden)}</dd>
            <dt>Parâmetros</dt>
            <dd>
              {paramCount(p.brain.inputs, p.brain.hidden)} (~{costPerStep(p.brain.inputs, p.brain.hidden)} operações por passo)
            </dd>
            <dt>Entradas</dt>
            <dd>
              {describeInputs(p.brain.inputs)} {usesTrackInfo(p.brain.inputs) ? <span className="badge warn">usa informações da pista</span> : <span className="badge ok">só sensores físicos</span>}
            </dd>
            <dt>Origem</dt>
            <dd>
              {p.origin.kind === 'treino' && `Laboratório "${p.origin.projectName}", geração ${p.origin.generation} (campeão ${p.origin.champion === 'oficial' ? 'oficial' : 'por recompensa'})`}
              {p.origin.kind === 'treinadora' && `Treinadora "${p.origin.coachName}", experimento ${p.origin.experiment}`}
              {p.origin.kind === 'importado' && 'Importado de arquivo'}
              {p.origin.kind === 'duplicado' && 'Cópia de outro piloto'}
              {p.origin.kind === 'exemplo' && 'Exemplo'}
            </dd>
            <dt>Treinou em</dt>
            <dd>{(p.origin.trackIds ?? []).join(', ') || '—'}</dd>
            <dt>Categorias do ranking</dt>
            <dd>{eligibleCategories(p.brain).map((c) => c.name).join(', ') || 'nenhuma'}</dd>
            <dt>Criado</dt>
            <dd>{fmtDate(p.createdAt)}</dd>
          </dl>
          <h4>
            Avaliações <span className="badge local">locais</span>
          </h4>
          {p.evaluations.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Pista</th>
                    <th className="num">Tentativas</th>
                    <th className="num">Conclusão</th>
                    <th className="num">Mediana</th>
                    <th className="num">Progresso</th>
                    <th>Data</th>
                  </tr>
                </thead>
                <tbody>
                  {p.evaluations.map((e, i) => (
                    <tr key={i}>
                      <td>{e.trackName}</td>
                      <td className="num">{e.attempts}</td>
                      <td className="num">{fmtPct(e.result.completionRate)}</td>
                      <td className="num">{fmtTime(e.result.medianTime)}</td>
                      <td className="num">{fmtPct(e.result.meanProgress)}</td>
                      <td>{fmtDate(e.date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">Sem avaliações. Use Resultados → Outras pistas.</p>
          )}
          <div className="btn-row">
            <button className="btn small" disabled={!p.bestReplay} onClick={() => setWatch(p)}>
              🎬 Ver melhor volta
            </button>
            <button className="btn small" onClick={() => navigate('resultados', 'pistas')}>
              🧭 Testar em pistas
            </button>
            <button className="btn small primary" onClick={() => navigate('ranking', `enviar:${p.id}`)}>
              🌐 Enviar ao ranking
            </button>
          </div>
          <div className="btn-row">
            <button
              className="btn small"
              onClick={async () => {
                const n = await promptDialog('Renomear piloto', 'Nome', p.name);
                if (n) await guard(() => db.put('pilots', { ...p, name: n, updatedAt: Date.now() }));
              }}
            >
              Renomear
            </button>
            <button
              className="btn small"
              onClick={() =>
                void guard(async () => {
                  const all = await db.getAll<PilotRecord>('pilots');
                  const now = Date.now();
                  await db.put('pilots', {
                    ...p,
                    id: newId('piloto'),
                    name: `${p.name} (cópia)`,
                    color: PILOT_COLORS[all.length % PILOT_COLORS.length],
                    brain: { ...p.brain, genome: p.brain.genome.slice() },
                    origin: { ...p.origin, kind: 'duplicado', parentPilotId: p.id },
                    createdAt: now,
                    updatedAt: now,
                  });
                })
              }
            >
              Duplicar
            </button>
            <button className="btn small" onClick={() => exportItem('piloto', p.name, p)}>
              Exportar
            </button>
            <button
              className="btn small danger"
              onClick={async () => {
                await remove('pilots', p.id, p.name);
                setSel(null);
              }}
            >
              Excluir
            </button>
          </div>
        </div>
      )}
      {watch?.bestReplay && <WatchReplayModal title={watch.name} replay={watch.bestReplay} color={watch.color} rays={watch.brain.inputs.rays} onClose={() => setWatch(null)} />}
    </div>
  );
}

function WatchReplayModal(props: { title: string; replay: NonNullable<PilotRecord['bestReplay']>; color: string; rays?: 5 | 9 | 13; onClose: () => void }) {
  const def = useAsync(() => getTrackDef(props.replay.meta.trackId), [props.replay.meta.trackId]);
  return (
    <Modal title={`Replay: ${props.title}`} onClose={props.onClose} wide>
      {def.loading ? (
        <Loading />
      ) : def.data ? (
        <ReplayPlayer track={builtTrack(def.data)} entries={[{ replay: props.replay, label: props.title, color: props.color, rays: props.rays }]} />
      ) : (
        <div className="callout warn">A pista deste replay não existe mais neste navegador.</div>
      )}
    </Modal>
  );
}

function Projects() {
  const projects = useAsync(() => db.getAll<ProjectRecord>('projects'), []);
  if (projects.loading && !projects.data) return <Loading />;
  const list = (projects.data ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
  if (!list.length) return <Empty icon="🧪" title="Nenhum laboratório">Crie um laboratório para começar.</Empty>;
  return (
    <div className="cards">
      {list.map((p) => (
        <div key={p.id} className="item-card">
          <strong>{p.name}</strong>
          <span className="muted" style={{ fontSize: '0.86em' }}>
            Geração {p.generation} · conclusão {fmtPct(p.bestCompletion)} · melhor volta {fmtTime(p.bestLapTime)}
            <br />
            {describeArch(p.config.inputs, p.config.hidden)} · pop. {p.config.evo.populationSize} · pistas: {p.config.trackIds.join(', ')}
            {p.lineage ? (
              <>
                <br />
                Linhagem de "{p.lineage.fromProjectName}" (geração {p.lineage.generation})
              </>
            ) : null}
            <br />
            Atualizado {fmtDate(p.updatedAt)}
          </span>
          <CardActions>
            <button
              className="btn small primary"
              onClick={() => {
                setState({ currentProjectId: p.id });
                navigate('laboratorio');
              }}
            >
              Continuar
            </button>
            <button
              className="btn small"
              onClick={async () => {
                const n = await promptDialog('Renomear laboratório', 'Nome', p.name);
                if (!n) return;
                const lab = getLab();
                if (lab && lab.view.project.id === p.id) await lab.rename(n);
                else await guard(() => db.put('projects', { ...p, name: n, updatedAt: Date.now() }));
              }}
            >
              Renomear
            </button>
            <button
              className="btn small"
              title="Cria uma cópia independente com a mesma população e histórico"
              onClick={() =>
                void guard(async () => {
                  const now = Date.now();
                  await db.put('projects', { ...p, id: newId('lab'), name: `${p.name} (cópia)`, createdAt: now, updatedAt: now });
                })
              }
            >
              Duplicar
            </button>
            <button className="btn small" onClick={() => exportItem('projeto', p.name, { name: p.name, snapshot: p.snapshot })} disabled={!p.snapshot}>
              Exportar
            </button>
            <button
              className="btn small danger"
              onClick={() =>
                void remove('projects', p.id, p.name, () => {
                  const lab = getLab();
                  if (lab && lab.view.project.id === p.id) lab.dispose();
                  setState((s) => (s.currentProjectId === p.id ? { currentProjectId: null } : {}));
                })
              }
            >
              Excluir
            </button>
          </CardActions>
        </div>
      ))}
    </div>
  );
}

function Configs() {
  const configs = useAsync(() => db.getAll<SavedConfigRecord>('configs'), []);
  const list = (configs.data ?? []).sort((a, b) => b.createdAt - a.createdAt);
  if (configs.loading && !configs.data) return <Loading />;
  if (!list.length) return <Empty icon="⚙" title="Nenhuma configuração salva">No Laboratório, use "Salvar configuração".</Empty>;
  return (
    <div className="cards">
      {list.map((c) => (
        <div key={c.id} className="item-card">
          <strong>{c.name}</strong>
          <span className="muted" style={{ fontSize: '0.86em' }}>
            {describeInputs(c.config.inputs)} → {describeArch(c.config.inputs, c.config.hidden)}
            <br />
            População {c.config.evo.populationSize} · mutação {(c.config.evo.mutationRate * 100).toFixed(1)}% × {c.config.evo.mutationStrength} · elite {c.config.evo.eliteCount}
            <br />
            Recompensa: {c.config.rewardPreset}
          </span>
          <CardActions>
            <button className="btn small primary" onClick={() => openNewLab({ configId: c.id })}>
              Usar em novo laboratório
            </button>
            <button
              className="btn small"
              onClick={async () => {
                const n = await promptDialog('Renomear configuração', 'Nome', c.name);
                if (n) await guard(() => db.put('configs', { ...c, name: n }));
              }}
            >
              Renomear
            </button>
            <button className="btn small" onClick={() => void guard(() => db.put('configs', { ...c, id: newId('config'), name: `${c.name} (cópia)`, createdAt: Date.now() }))}>
              Duplicar
            </button>
            <button className="btn small" onClick={() => exportItem('configuracao', c.name, { name: c.name, config: c.config })}>
              Exportar
            </button>
            <button className="btn small danger" onClick={() => void remove('configs', c.id, c.name)}>
              Excluir
            </button>
          </CardActions>
        </div>
      ))}
    </div>
  );
}

function Coaches() {
  const coaches = useAsync(() => db.getAll<CoachRecord>('coaches'), []);
  const list = (coaches.data ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
  if (coaches.loading && !coaches.data) return <Loading />;
  if (!list.length) return <Empty icon="🤖" title="Nenhuma treinadora">Crie uma na aba "Treinadora" do Laboratório.</Empty>;
  return (
    <div className="cards">
      {list.map((c) => (
        <div key={c.id} className="item-card">
          <div className="spread">
            <strong>{c.name}</strong>
            <span className="badge">{c.status}</span>
          </div>
          <span className="muted" style={{ fontSize: '0.86em' }}>
            {OBJECTIVE_LABEL[c.config.objective]} · {c.snapshot?.candidates.length ?? 0}/{c.config.maxExperiments} experimentos · orçamento {(c.config.totalBudget / 1e6).toFixed(0)} mi passos
          </span>
          <CardActions>
            <button
              className="btn small primary"
              onClick={async () => {
                try {
                  await CoachSession.open(c.id);
                  navigate('laboratorio');
                  toast('Treinadora aberta na aba "Treinadora" do Laboratório.', 'info');
                } catch (e) {
                  toast((e as Error).message, 'erro');
                }
              }}
            >
              Abrir
            </button>
            <button
              className="btn small"
              onClick={async () => {
                const n = await promptDialog('Renomear treinadora', 'Nome', c.name);
                if (n) await guard(() => db.put('coaches', { ...c, name: n, updatedAt: Date.now() }));
              }}
            >
              Renomear
            </button>
            <button
              className="btn small"
              title="Copia a configuração; o progresso começa do zero"
              onClick={() => void guard(() => db.put('coaches', { ...c, id: newId('treinadora'), name: `${c.name} (cópia)`, status: 'nova', snapshot: null, createdAt: Date.now(), updatedAt: Date.now() }))}
            >
              Duplicar
            </button>
            <button className="btn small" onClick={() => exportItem('treinadora', c.name, { name: c.name, config: c.config })}>
              Exportar
            </button>
            <button
              className="btn small danger"
              onClick={() =>
                void remove('coaches', c.id, c.name, () => {
                  const open = getCoach();
                  if (open && open.view.record.id === c.id) open.dispose();
                })
              }
            >
              Excluir
            </button>
          </CardActions>
        </div>
      ))}
    </div>
  );
}

function Lineages() {
  const lineages = useAsync(() => db.getAll<LineageRecord>('lineages'), []);
  const list = (lineages.data ?? []).sort((a, b) => b.createdAt - a.createdAt);
  if (lineages.loading && !lineages.data) return <Loading />;
  if (!list.length)
    return (
      <Empty icon="🧬" title="Nenhuma linhagem salva">
        No Laboratório, use "Salvar geração" para guardar uma população inteira e depois criar novas linhagens a partir dela.
      </Empty>
    );
  return (
    <div className="stack">
      <div className="callout">
        <strong>Retomar como nova linhagem</strong> copia a população inteira, o histórico e o estado do gerador aleatório: continua exatamente daquela geração.{' '}
        <strong>Só o campeão</strong> começa um experimento novo usando apenas o melhor cérebro. <Hint text="Retomada exata = mesmo resultado que teria acontecido sem interrupção." />
      </div>
      <div className="cards">
        {list.map((l) => (
          <div key={l.id} className="item-card">
            <strong>{l.name}</strong>
            <span className="muted" style={{ fontSize: '0.86em' }}>
              De "{l.projectName}", geração {l.generation} · {l.snapshot.population.length} indivíduos · {fmtDate(l.createdAt)}
            </span>
            <CardActions>
              <button
                className="btn small primary"
                onClick={() =>
                  void guard(async () => {
                    const p = await createProject(`${l.projectName} — linhagem G${l.generation}`, l.snapshot.config, {
                      snapshot: structuredClone(l.snapshot),
                      lineage: { fromProjectId: l.projectId, fromProjectName: l.projectName, generation: l.generation },
                    });
                    setState({ currentProjectId: p.id });
                    navigate('laboratorio');
                  })
                }
              >
                Retomar como nova linhagem
              </button>
              <button
                className="btn small"
                disabled={!l.snapshot.bestOfficial && !l.snapshot.bestEver}
                onClick={() =>
                  void guard(async () => {
                    const champ = l.snapshot.bestOfficial ?? l.snapshot.bestEver!;
                    const p = await createProject(`${l.projectName} — campeão G${champ.generation}`, l.snapshot.config, { champion: champ.genome });
                    setState({ currentProjectId: p.id });
                    navigate('laboratorio');
                  })
                }
              >
                Só o campeão
              </button>
              <button className="btn small" onClick={() => exportItem('projeto', l.name, { name: l.name, snapshot: l.snapshot })}>
                Exportar
              </button>
              <button className="btn small danger" onClick={() => void remove('lineages', l.id, l.name)}>
                Excluir
              </button>
            </CardActions>
          </div>
        ))}
      </div>
    </div>
  );
}

function Replays() {
  const replays = useAsync(() => db.getAll<ReplayRecord>('replays'), []);
  const [watch, setWatch] = useState<ReplayRecord | null>(null);
  const list = (replays.data ?? []).sort((a, b) => b.createdAt - a.createdAt);
  if (replays.loading && !replays.data) return <Loading />;
  if (!list.length) return <Empty icon="🎬" title="Nenhum replay salvo">Em Resultados → Replays, use "Salvar replay".</Empty>;
  return (
    <div className="cards">
      {list.map((r) => (
        <div key={r.id} className="item-card">
          <strong>{r.name}</strong>
          <span className="muted" style={{ fontSize: '0.86em' }}>
            {r.trackName} · {r.replay.meta.completed ? fmtTime(r.replay.meta.time) : `${Math.round(r.replay.meta.progress * 100)}% (${r.replay.meta.reason})`} · física v{r.replay.meta.physicsVersion} · {fmtDate(r.createdAt)}
          </span>
          <CardActions>
            <button className="btn small primary" onClick={() => setWatch(r)}>
              Assistir
            </button>
            <button
              className="btn small"
              onClick={async () => {
                const n = await promptDialog('Renomear replay', 'Nome', r.name);
                if (n) await guard(() => db.put('replays', { ...r, name: n }));
              }}
            >
              Renomear
            </button>
            <button className="btn small" onClick={() => exportItem('replay', r.name, { name: r.name, trackName: r.trackName, replay: r.replay })}>
              Exportar
            </button>
            <button className="btn small danger" onClick={() => void remove('replays', r.id, r.name)}>
              Excluir
            </button>
          </CardActions>
        </div>
      ))}
      {watch && <WatchReplayModal title={watch.name} replay={watch.replay} color={watch.replay.meta.color ?? '#4dabf7'} onClose={() => setWatch(null)} />}
    </div>
  );
}
