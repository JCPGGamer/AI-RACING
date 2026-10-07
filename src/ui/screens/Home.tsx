import { useEffect, useRef } from 'react';
import { getBuiltinTrack } from '../../core/builtinTracks.ts';
import { defaultExperiment, type ExperimentConfig } from '../../core/config.ts';
import { REWARD_PRESETS } from '../../core/rewards.ts';
import type { CoachRecord, LocalSubmission, PilotRecord, ProjectRecord } from '../../core/models.ts';
import { buildTrack, pointAtS } from '../../core/track.ts';
import { audio } from '../../audio/audio.ts';
import { createProject } from '../../lab/labSession.ts';
import { db } from '../../persistence/db.ts';
import { useOnline } from '../../online/session.ts';
import { fmtDate, fmtPct, fmtTime, useAsync } from '../components.tsx';
import { colorForId, drawCar, drawTrack, fitCamera, applyCamera } from '../render/draw.ts';
import { navigate, openModal, openNewLab, setState, toast } from '../store.ts';

interface Example {
  id: string;
  title: string;
  text: string;
  make: () => ExperimentConfig;
}

const EXAMPLES: Example[] = [
  {
    id: 'primeira-volta',
    title: 'Primeira volta',
    text: 'Oval largo, 50 carros, recompensa para completar. Em poucas gerações alguém fecha a volta.',
    make: () => defaultExperiment('oval-largo', 'exemplo-primeira-volta'),
  },
  {
    id: 'sensores-puros',
    title: 'Só sensores',
    text: 'Curvas em S sem informações da pista: o piloto decide só com raios, velocidade e direção anterior. Vale para a categoria "Sensores".',
    make: () => {
      const c = defaultExperiment('curvas-s', 'exemplo-sensores');
      c.inputs = { ...c.inputs, trackAngle: false };
      return c;
    },
  },
  {
    id: 'velocista',
    title: 'Velocista',
    text: 'Recompensa "Buscar velocidade" com 100 carros: cada segundo conta. Bom para baixar o tempo no oval.',
    make: () => {
      const c = defaultExperiment('oval-largo', 'exemplo-velocista');
      c.rewards = { ...REWARD_PRESETS.velocidade.weights };
      c.rewardPreset = 'velocidade';
      c.evo = { ...c.evo, populationSize: 100 };
      return c;
    },
  },
  {
    id: 'generalista',
    title: 'Generalista',
    text: 'Treina em duas pistas ao mesmo tempo e com largada variada, para dirigir bem em circuitos novos.',
    make: () => {
      const c = defaultExperiment('oval-largo', 'exemplo-generalista');
      c.trackIds = ['oval-largo', 'curvas-s'];
      c.startVariation = true;
      return c;
    },
  },
  {
    id: 'grampos',
    title: 'Desafio dos grampos',
    text: 'Retas longas e curvas de 180°. 13 sensores e 100 carros para aprender a frear na hora certa.',
    make: () => {
      const c = defaultExperiment('retas-grampos', 'exemplo-grampos');
      c.inputs = { ...c.inputs, rays: 13 };
      c.evo = { ...c.evo, populationSize: 100 };
      return c;
    },
  },
];

function HeroArt() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current!;
    const draw = () => {
      const w = c.clientWidth;
      const h = c.clientHeight;
      const dpr = Math.min(2, devicePixelRatio || 1);
      c.width = w * dpr;
      c.height = h * dpr;
      const ctx = c.getContext('2d')!;
      const t = buildTrack(getBuiltinTrack('circuito-misto')!);
      const cam = fitCamera(t.bounds, w, h, 14);
      drawTrack(ctx, t, cam, w, h, dpr);
      applyCamera(ctx, cam, w, h, dpr);
      // Grid de largada (ilustração estática: ninguém está dirigindo aqui)
      for (let i = 0; i < 8; i++) {
        const p = pointAtS(t, 6 - Math.floor(i / 2) * 7);
        const side = i % 2 === 0 ? 1 : -1;
        const nx = -p.ty;
        const ny = p.tx;
        drawCar(ctx, p.x + nx * side * 2.6, p.y + ny * side * 2.6, Math.atan2(p.ty, p.tx), colorForId(i * 7 + 3), 'normal', cam.scale);
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  }, []);
  return <canvas ref={ref} className="hero-canvas" role="img" aria-label="Ilustração: carros no grid de largada do Circuito Misto" />;
}

export function Home() {
  const online = useOnline();
  const data = useAsync(async () => {
    const safe = async <T,>(p: Promise<T[]>) => p.catch(() => [] as T[]);
    const [projects, pilots, coaches, champs, subs] = await Promise.all([
      safe(db.getAll<ProjectRecord>('projects')),
      safe(db.getAll<PilotRecord>('pilots')),
      safe(db.getAll<CoachRecord>('coaches')),
      safe(db.getAll<{ id: string }>('championships')),
      safe(db.getAll<LocalSubmission>('submissions')),
    ]);
    projects.sort((a, b) => b.updatedAt - a.updatedAt);
    return { projects, pilots, coaches, champs, subs };
  }, []);

  const d = data.data;
  const steps = [
    { label: 'Criar um piloto', done: !!d?.projects.length },
    { label: 'Treinar uma população', done: !!d?.projects.some((p) => p.generation > 2) },
    { label: 'Completar uma pista', done: !!d?.projects.some((p) => p.bestCompletion > 0) },
    {
      label: 'Melhorar tempo e consistência',
      done: !!d?.pilots.some((p) => p.evaluations.some((e) => e.attempts >= 3 && e.result.completionRate >= 1)),
    },
    {
      label: 'Testar em pistas desconhecidas',
      done: !!d?.pilots.some((p) => p.evaluations.some((e) => !(p.origin.trackIds ?? []).includes(e.trackId) && e.result.completionRate > 0)),
    },
    { label: 'Criar uma treinadora', done: !!d?.coaches.some((c) => c.status === 'concluida') },
    { label: 'Campeonato local', done: !!d?.champs.length },
    { label: 'Disputar o ranking', done: !!d?.subs.some((s) => s.status === 'aprovado') },
  ];

  const startExample = async (ex: Example) => {
    audio.click();
    try {
      const p = await createProject(`Exemplo: ${ex.title}`, ex.make());
      setState({ currentProjectId: p.id });
      navigate('laboratorio', 'autoplay');
    } catch (e) {
      toast((e as Error).message, 'erro');
    }
  };

  const last = d?.projects[0];

  return (
    <div className="page">
      <section className="hero">
        <div>
          <h1>Crie cérebros que aprendem a pilotar.</h1>
          <p className="lead">
            No EvoRace você monta redes neurais, solta dezenas de carrinhos na pista e deixa a evolução escolher os melhores. Geração após geração, eles avançam mais,
            completam voltas e ficam mais rápidos — de verdade.
          </p>
          <div className="btn-row" style={{ marginTop: 16 }}>
            <button className="btn primary big" onClick={() => openNewLab()}>
              🧪 Novo laboratório
            </button>
            {last && (
              <button
                className="btn big"
                onClick={() => {
                  setState({ currentProjectId: last.id });
                  navigate('laboratorio');
                }}
              >
                ▶ Continuar “{last.name}”
              </button>
            )}
          </div>
          <div className="row" style={{ marginTop: 14 }}>
            <span className={`badge ${online.status === 'online' ? 'online' : 'err'}`}>{online.status === 'online' ? 'Ranking online disponível' : online.status === 'offline' ? 'Ranking online indisponível' : 'Verificando ranking…'}</span>
            <span className="badge local">Treino 100% local, funciona sem internet</span>
          </div>
        </div>
        <HeroArt />
      </section>

      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-title">
          <h3>Seu caminho</h3>
          <span className="muted">{steps.filter((s) => s.done).length} de {steps.length}</span>
        </div>
        <ol className="path-steps">
          {steps.map((s) => (
            <li key={s.label} className={s.done ? 'done' : ''}>
              {s.label}
              {s.done && <span className="sr-only"> (concluído)</span>}
            </li>
          ))}
        </ol>
      </section>

      <section className="cards" style={{ marginBottom: 20 }}>
        <button className="action-card" onClick={() => openNewLab()}>
          <span className="ico" aria-hidden>🧪</span>
          <span>
            <strong>Novo laboratório</strong>
            <span>Escolha a pista e comece a treinar em poucos cliques.</span>
          </span>
        </button>
        <button className="action-card" onClick={() => navigate('garagem')}>
          <span className="ico" aria-hidden>🧠</span>
          <span>
            <strong>Continuar</strong>
            <span>Laboratórios, pilotos, treinadoras e linhagens salvos.</span>
          </span>
        </button>
        <button className="action-card" onClick={() => navigate('ranking')}>
          <span className="ico" aria-hidden>🌐</span>
          <span>
            <strong>Ranking público</strong>
            <span>Melhores tempos validados pelo servidor, para todos verem.</span>
          </span>
        </button>
        <button className="action-card" onClick={() => openModal('tutorial')}>
          <span className="ico" aria-hidden>🎓</span>
          <span>
            <strong>Tutorial</strong>
            <span>Sete passos curtos: sensores, rede, evolução e ranking.</span>
          </span>
        </button>
        <button className="action-card" onClick={() => openModal('configuracoes')}>
          <span className="ico" aria-hidden>⚙</span>
          <span>
            <strong>Configurações</strong>
            <span>Som, acessibilidade e modo de baixo consumo.</span>
          </span>
        </button>
        <button className="action-card" onClick={() => navigate('pistas')}>
          <span className="ico" aria-hidden>🛣️</span>
          <span>
            <strong>Pistas e editor</strong>
            <span>Cinco circuitos prontos e um editor para criar os seus.</span>
          </span>
        </button>
      </section>

      <h2>Exemplos prontos</h2>
      <p className="muted">Experimentos configurados para ver a evolução acontecer. Cada um cria um laboratório novo.</p>
      <section className="cards" style={{ marginBottom: 24 }}>
        {EXAMPLES.map((ex) => (
          <div key={ex.id} className="item-card">
            <strong>{ex.title}</strong>
            <span className="muted" style={{ fontSize: '0.9em', flex: 1 }}>
              {ex.text}
            </span>
            <button className="btn primary" onClick={() => void startExample(ex)}>
              ▶ Começar
            </button>
          </div>
        ))}
      </section>

      {!!d?.projects.length && (
        <>
          <h2>Laboratórios recentes</h2>
          <div className="table-wrap panel tight">
            <table className="table">
              <thead>
                <tr>
                  <th>Nome</th>
                  <th className="num">Geração</th>
                  <th className="num">Conclusão (oficial local)</th>
                  <th className="num">Melhor volta</th>
                  <th>Atualizado</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {d.projects.slice(0, 6).map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td className="num">{p.generation}</td>
                    <td className="num">{fmtPct(p.bestCompletion)}</td>
                    <td className="num">{fmtTime(p.bestLapTime)}</td>
                    <td>{fmtDate(p.updatedAt)}</td>
                    <td>
                      <button
                        className="btn small"
                        onClick={() => {
                          setState({ currentProjectId: p.id });
                          navigate('laboratorio');
                        }}
                      >
                        Abrir
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
