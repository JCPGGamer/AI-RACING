import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { audio } from '../../audio/audio.ts';
import { ARCH_PRESETS, cloneConfig, compatibleArch, EXPERIMENT_LIMITS, sanitizeExperiment, type ExperimentConfig } from '../../core/config.ts';
import { EVO_LIMITS, freshCount, POPULATION_OPTIONS } from '../../core/evolution.ts';
import { exportJson } from '../../core/io.ts';
import { newId, type SavedConfigRecord } from '../../core/models.ts';
import { costPerStep, describeArch, paramCount } from '../../core/nn.ts';
import { presetOf, REWARD_LIMITS, REWARD_PRESETS, type RewardPresetId, type RewardWeights } from '../../core/rewards.ts';
import { describeInputs, inputCount, usesTrackInfo, type RayCount } from '../../core/sensors.ts';
import { createProject, type LabSession } from '../../lab/labSession.ts';
import { listTrackDefs } from '../../lab/tracks.ts';
import { db } from '../../persistence/db.ts';
import { downloadText, fmtNum, fmtPct, fmtTime, Hint, promptDialog, Seg, Slider, slug, Toggle, useAsync } from '../components.tsx';
import { dataChanged, navigate, setPrefs, setState, toast, useApp } from '../store.ts';
import { POPULATION_IMPACT } from './NewLab.tsx';

const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

export function LabConfigPanel({ session }: { session: LabSession }) {
  const view = useSyncExternalStore(
    (fn) => session.subscribe(fn),
    () => session.view,
  );
  const basic = useApp((s) => s.prefs.basicMode);
  const tracks = useAsync(() => listTrackDefs(), []);
  const [draft, setDraft] = useState<ExperimentConfig>(() => cloneConfig(view.config));
  const [busy, setBusy] = useState(false);

  // Quando a configuração aplicada muda (nova geração), reinicia o rascunho.
  useEffect(() => {
    setDraft(cloneConfig(view.pendingConfig ?? view.config));
  }, [view.config, view.pendingConfig]);

  const sanitized = useMemo(() => sanitizeExperiment(draft), [draft]);
  const compatible = compatibleArch(view.config, sanitized.config);
  const changed = JSON.stringify(sanitized.config) !== JSON.stringify(sanitizeExperiment(view.pendingConfig ?? view.config).config);
  const set = (p: Partial<ExperimentConfig>) => setDraft((d) => ({ ...d, ...p }));
  const setEvo = (p: Partial<ExperimentConfig['evo']>) => setDraft((d) => ({ ...d, evo: { ...d.evo, ...p } }));
  const setReward = (k: keyof RewardWeights, v: number) => setDraft((d) => ({ ...d, rewards: { ...d.rewards, [k]: v } }));
  const preset = presetOf(draft.rewards);

  const apply = async () => {
    audio.click();
    const r = await session.applyConfig(draft);
    toast(r.message, r.ok ? 'sucesso' : 'erro');
  };

  const newExperiment = async () => {
    const name = await promptDialog('Novo experimento', 'Nome do novo laboratório', `${view.project.name} (novo)`, 'Criar');
    if (!name) return;
    setBusy(true);
    try {
      const p = await createProject(name, sanitized.config);
      setState({ currentProjectId: p.id });
      navigate('laboratorio', 'autoplay');
      toast('Experimento novo criado: os pesos antigos não foram reaproveitados.', 'info');
    } catch (e) {
      toast((e as Error).message, 'erro');
    } finally {
      setBusy(false);
    }
  };

  const saveConfig = async () => {
    const name = await promptDialog('Salvar configuração', 'Nome', `Config. de ${view.project.name}`);
    if (!name) return;
    const rec: SavedConfigRecord = { id: newId('config'), name, config: sanitized.config, createdAt: Date.now() };
    await db.put('configs', rec);
    dataChanged();
    toast('Configuração salva na Garagem.', 'sucesso');
  };

  const exportProject = async () => {
    try {
      const snapshot = await session.requestSnapshot();
      downloadText(`laboratorio-${slug(view.project.name)}.json`, exportJson('projeto', { name: view.project.name, snapshot }));
    } catch (e) {
      toast((e as Error).message, 'erro');
    }
  };

  const bo = view.bestOfficial;
  const be = view.bestEver;
  const params = paramCount(sanitized.config.inputs, sanitized.config.hidden);
  const popCost = params * sanitized.config.evo.populationSize;

  return (
    <div className="stack">
      <div className="spread">
        <button
          className="btn ghost small"
          onClick={async () => {
            const n = await promptDialog('Renomear laboratório', 'Nome', view.project.name);
            if (n) await session.rename(n);
          }}
          title="Renomear"
        >
          ✎ {view.project.name}
        </button>
        <Seg
          ariaLabel="Modo de configuração"
          value={basic ? 'basico' : 'avancado'}
          onChange={(v) => setPrefs({ basicMode: v === 'basico' })}
          options={[
            { value: 'basico', label: 'Básico' },
            { value: 'avancado', label: 'Avançado' },
          ]}
        />
      </div>

      <section className="panel tight">
        <h4>Campeões</h4>
        <div className="stack" style={{ gap: 8 }}>
          <div>
            <div className="spread">
              <strong>
                Oficial <span className="badge local">local</span>
              </strong>
              <Hint text="Melhor pelas regras oficiais fixas: quem completa vence; depois menor tempo; depois maior progresso. Não depende das recompensas." />
            </div>
            <div className="muted" style={{ fontSize: '0.9em' }}>
              {bo?.official
                ? `G${bo.generation} · conclusão ${fmtPct(bo.official.completionRate)} · ${bo.official.bestTime !== null ? fmtTime(bo.official.bestTime) : `progresso ${fmtPct(bo.official.meanProgress)}`}`
                : 'Aparece ao fim da primeira geração.'}
            </div>
          </div>
          <div>
            <div className="spread">
              <strong>Por recompensa</strong>
              <Hint text="Maior pontuação de treino. Pode ser diferente do oficial: depende de como você configurou as recompensas." />
            </div>
            <div className="muted" style={{ fontSize: '0.9em' }}>{be ? `G${be.generation} · ${fmtNum(be.score, 1)} pontos` : '—'}</div>
          </div>
          <div className="btn-row">
            <button className="btn small primary" disabled={!bo} onClick={() => void session.saveChampion('oficial')}>
              💾 Salvar campeão oficial
            </button>
            <button className="btn small" disabled={!be} onClick={() => void session.saveChampion('recompensa')}>
              Salvar campeão por recompensa
            </button>
            <button className="btn small" disabled={!view.bestReplay && !bo?.replay} onClick={() => navigate('resultados', 'replays')}>
              🎬 Replay da melhor volta
            </button>
            <button className="btn small" disabled={!bo} onClick={() => navigate('resultados', 'pistas')}>
              🧭 Testar em outra pista
            </button>
            <button className="btn small" onClick={() => void session.saveLineage()} title="Guarda a população atual para criar novas linhagens depois">
              🧬 Salvar geração
            </button>
            <button className="btn small" onClick={() => void exportProject()}>
              📤 Exportar
            </button>
          </div>
        </div>
      </section>

      <section className="stack">
        <h4>Treinamento</h4>
        {basic ? (
          <label className="field">
            <span className="field-label">Pista de treino</span>
            <select value={draft.trackIds[0]} onChange={(e) => set({ trackIds: [e.target.value] })}>
              {(tracks.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="field-label">
              <span className="row" style={{ gap: 6 }}>
                Pistas de treino (até {EXPERIMENT_LIMITS.trackCount.max}) <Hint text="Com várias pistas, cada piloto corre em todas e a pontuação é a média. Ajuda a generalizar, mas cada geração demora mais." />
              </span>
            </legend>
            {(tracks.data ?? []).map((t) => {
              const on = draft.trackIds.includes(t.id);
              return (
                <label key={t.id} className="check">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!on && draft.trackIds.length >= EXPERIMENT_LIMITS.trackCount.max}
                    onChange={(e) => {
                      const ids = e.target.checked ? [...draft.trackIds, t.id] : draft.trackIds.filter((x) => x !== t.id);
                      if (ids.length) set({ trackIds: ids });
                    }}
                  />
                  {t.name}
                </label>
              );
            })}
          </fieldset>
        )}

        <div className="field">
          <span className="field-label">
            <span className="row" style={{ gap: 6 }}>
              Recompensa
              <Hint text="Diferentes combinações podem gerar comportamentos inesperados: se ficar parado custar menos que bater, os pilotos podem aprender a não sair do lugar." />
            </span>
          </span>
          <Seg
            ariaLabel="Preset de recompensa"
            value={preset}
            onChange={(id: RewardPresetId) => {
              if (id !== 'personalizado') set({ rewards: { ...REWARD_PRESETS[id].weights }, rewardPreset: id });
            }}
            options={[
              ...(Object.keys(REWARD_PRESETS) as Exclude<RewardPresetId, 'personalizado'>[]).map((k) => ({ value: k as RewardPresetId, label: REWARD_PRESETS[k].name })),
              { value: 'personalizado' as RewardPresetId, label: 'Personalizado', title: 'Ajuste os pesos no modo avançado' },
            ]}
          />
          <span className="field-hint">{preset === 'personalizado' ? 'Pesos ajustados à mão (modo avançado).' : REWARD_PRESETS[preset].description}</span>
        </div>

        <div className="field">
          <span className="field-label">População</span>
          <Seg ariaLabel="População" value={draft.evo.populationSize} onChange={(v) => setEvo({ populationSize: v })} options={POPULATION_OPTIONS.map((p) => ({ value: p, label: String(p) }))} />
          <span className="field-hint">{POPULATION_IMPACT[draft.evo.populationSize] ?? ''}</span>
        </div>
        <Slider
          label="Chance de mutar cada peso"
          value={draft.evo.mutationRate}
          min={EVO_LIMITS.mutationRate.min}
          max={EVO_LIMITS.mutationRate.max}
          step={0.005}
          format={pct}
          onChange={(v) => setEvo({ mutationRate: v })}
          hint="Probabilidade de cada peso ou viés de um filho receber ruído gaussiano."
        />
        <Slider
          label="Intensidade da mutação"
          value={draft.evo.mutationStrength}
          min={EVO_LIMITS.mutationStrength.min}
          max={EVO_LIMITS.mutationStrength.max}
          step={0.01}
          format={(v) => v.toFixed(2)}
          onChange={(v) => setEvo({ mutationStrength: v })}
          hint="Tamanho do ruído (desvio padrão) quando um peso muta. Alto demais estraga o que funcionava; baixo demais aprende devagar."
        />
        <Toggle
          label="Largada variada"
          checked={draft.startVariation}
          onChange={(v) => set({ startVariation: v })}
          hint="Cada geração sorteia uma largada um pouco deslocada. Treina pilotos mais robustos."
        />

        {!basic && (
          <>
            <div className="divider" />
            <h4>Evolução</h4>
            <Slider
              label="Elite (copiados sem mutação)"
              value={draft.evo.eliteCount}
              min={EVO_LIMITS.eliteCount.min}
              max={Math.min(EVO_LIMITS.eliteCount.max, Math.floor(draft.evo.populationSize / 3))}
              step={1}
              onChange={(v) => setEvo({ eliteCount: v })}
              hint="Os melhores passam para a próxima geração exatamente iguais. Garante que o melhor resultado não se perca."
            />
            <div className="field">
              <span className="field-label">
                <span className="row" style={{ gap: 6 }}>
                  Seleção de pais <Hint text="Truncamento: sorteia pais entre os melhores X%. Torneio: sorteia k pilotos e o melhor vira pai. Ambos usam a ordem, então pontuações negativas funcionam." />
                </span>
              </span>
              <Seg
                ariaLabel="Seleção de pais"
                value={draft.evo.selection}
                onChange={(v) => setEvo({ selection: v })}
                options={[
                  { value: 'truncamento', label: 'Melhores X%' },
                  { value: 'torneio', label: 'Torneio' },
                ]}
              />
            </div>
            {draft.evo.selection === 'truncamento' ? (
              <Slider
                label="Pais entre os melhores"
                value={draft.evo.selectionFraction}
                min={EVO_LIMITS.selectionFraction.min}
                max={EVO_LIMITS.selectionFraction.max}
                step={0.01}
                format={pct}
                onChange={(v) => setEvo({ selectionFraction: v })}
              />
            ) : (
              <Slider label="Tamanho do torneio" value={draft.evo.tournamentSize} min={EVO_LIMITS.tournamentSize.min} max={EVO_LIMITS.tournamentSize.max} step={1} onChange={(v) => setEvo({ tournamentSize: v })} />
            )}
            <Slider
              label="Cruzamento"
              value={draft.evo.crossoverRate}
              min={0}
              max={1}
              step={0.05}
              format={pct}
              onChange={(v) => setEvo({ crossoverRate: v })}
              hint="Chance de um filho misturar dois pais (cada neurônio vem inteiro de um deles). Só acontece entre redes de mesma arquitetura."
            />
            <Slider
              label="Pilotos novos por geração"
              value={draft.evo.freshFraction}
              min={EVO_LIMITS.freshFraction.min}
              max={EVO_LIMITS.freshFraction.max}
              step={0.01}
              format={(v) => `${pct(v)} (${freshCount({ ...draft.evo, freshFraction: v })} carros)`}
              onChange={(v) => setEvo({ freshFraction: v })}
              hint="Cérebros totalmente aleatórios entram a cada geração para manter variedade."
            />
            <div className="divider" />
            <h4>Tentativas</h4>
            <Slider
              label="Tempo máximo"
              value={draft.maxTime}
              min={EXPERIMENT_LIMITS.maxTime.min}
              max={EXPERIMENT_LIMITS.maxTime.max}
              step={5}
              format={(v) => `${v} s`}
              onChange={(v) => set({ maxTime: v })}
              hint="Tempo simulado máximo de cada tentativa no treino."
            />
            <Slider
              label="Limite sem progresso"
              value={draft.stallTime}
              min={EXPERIMENT_LIMITS.stallTime.min}
              max={Math.min(EXPERIMENT_LIMITS.stallTime.max, draft.maxTime - 1)}
              step={0.5}
              format={(v) => `${v} s`}
              onChange={(v) => set({ stallTime: v })}
              hint="Encerra a tentativa se o carro não avançar 5 m nesse tempo."
            />
            <div className="divider" />
            <h4>Pesos das recompensas</h4>
            <div className="callout warn" style={{ fontSize: '0.86em' }}>
              Tudo é normalizado pelo tamanho da pista e pelo tempo simulado. Pesos estranhos podem ensinar comportamentos inesperados — teste e observe!
            </div>
            {(Object.keys(REWARD_LIMITS) as (keyof RewardWeights)[]).map((k) => (
              <Slider
                key={k}
                label={REWARD_LIMITS[k].label}
                value={draft.rewards[k]}
                min={REWARD_LIMITS[k].min}
                max={REWARD_LIMITS[k].max}
                step={REWARD_LIMITS[k].step}
                format={(v) => (k === 'oscillation' ? v.toFixed(2) : String(v))}
                onChange={(v) => setReward(k, v)}
                hint={REWARD_LIMITS[k].hint}
              />
            ))}
            <div className="divider" />
            <h4>Sensores e cérebro</h4>
            <div className="callout" style={{ fontSize: '0.86em' }}>
              Mudar sensores ou arquitetura cria um <strong>experimento novo</strong>: os pesos atuais não servem para outra rede e não são reaproveitados.
            </div>
            <div className="field">
              <span className="field-label">Sensores de distância</span>
              <Seg
                ariaLabel="Sensores"
                value={draft.inputs.rays}
                onChange={(v: RayCount) => set({ inputs: { ...draft.inputs, rays: v } })}
                options={[5, 9, 13].map((r) => ({ value: r as RayCount, label: String(r) }))}
              />
            </div>
            <Toggle label="Velocidade" description="Sensor físico" checked={draft.inputs.speed} onChange={(v) => set({ inputs: { ...draft.inputs, speed: v } })} />
            <Toggle label="Direção anterior" description="Sensor físico (memória do último comando)" checked={draft.inputs.prevSteer} onChange={(v) => set({ inputs: { ...draft.inputs, prevSteer: v } })} />
            <Toggle label="Ângulo em relação à pista" description="Informação da pista (seno e cosseno)" checked={draft.inputs.trackAngle} onChange={(v) => set({ inputs: { ...draft.inputs, trackAngle: v } })} />
            <Toggle label="Deslocamento lateral" description="Informação da pista" checked={draft.inputs.lateral} onChange={(v) => set({ inputs: { ...draft.inputs, lateral: v } })} />
            <Toggle label="Pontos à frente (25 m e 60 m)" description="Informação da pista" checked={draft.inputs.lookahead} onChange={(v) => set({ inputs: { ...draft.inputs, lookahead: v } })} />
            <div className="field">
              <span className="field-label">Camadas ocultas</span>
              <div className="row">
                {draft.hidden.map((h, i) => (
                  <input
                    key={i}
                    type="number"
                    aria-label={`Neurônios da camada ${i + 1}`}
                    min={EXPERIMENT_LIMITS.neurons.min}
                    max={EXPERIMENT_LIMITS.neurons.max}
                    value={h}
                    style={{ width: 70 }}
                    onChange={(e) => {
                      const v = Math.max(EXPERIMENT_LIMITS.neurons.min, Math.min(EXPERIMENT_LIMITS.neurons.max, Math.round(Number(e.target.value) || 2)));
                      set({ hidden: draft.hidden.map((x, j) => (j === i ? v : x)) });
                    }}
                  />
                ))}
                <button className="btn small" disabled={draft.hidden.length >= EXPERIMENT_LIMITS.hiddenLayers.max} onClick={() => set({ hidden: [...draft.hidden, 8] })}>
                  + camada
                </button>
                <button className="btn small" disabled={draft.hidden.length <= 1} onClick={() => set({ hidden: draft.hidden.slice(0, -1) })}>
                  − camada
                </button>
              </div>
              <select aria-label="Arquiteturas prontas" value="" onChange={(e) => e.target.value && set({ hidden: e.target.value.split('x').map(Number) })}>
                <option value="">Escolher arquitetura pronta…</option>
                {ARCH_PRESETS.map((a) => (
                  <option key={a.label} value={a.hidden.join('x')}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>
            <label className="field">
              <span className="field-label">
                <span className="row" style={{ gap: 6 }}>
                  Semente <Hint text="Mesma semente + mesma configuração = mesmo experimento. Só vale para experimentos novos." />
                </span>
              </span>
              <input type="text" value={draft.seed} maxLength={40} onChange={(e) => set({ seed: e.target.value })} />
            </label>
          </>
        )}

        <div className="callout" style={{ fontSize: '0.88em' }}>
          {describeInputs(sanitized.config.inputs)}
          {usesTrackInfo(sanitized.config.inputs) ? ' (usa informações da pista)' : ' (só sensores físicos)'} → {describeArch(sanitized.config.inputs, sanitized.config.hidden)}
          <br />
          {inputCount(sanitized.config.inputs)} entradas · {params} parâmetros · ~{costPerStep(sanitized.config.inputs, sanitized.config.hidden)} operações por passo · {popCost.toLocaleString('pt-BR')} pesos na população
        </div>
        {sanitized.warnings.length > 0 && <div className="callout warn">{sanitized.warnings.join(' ')}</div>}
        {view.pendingConfig && <div className="callout ok">Mudança agendada: entra no início da próxima geração.</div>}

        <div className="btn-row">
          {compatible ? (
            <button className="btn primary" disabled={!changed || busy} onClick={() => void apply()}>
              Aplicar na próxima geração
            </button>
          ) : (
            <button className="btn primary" disabled={busy} onClick={() => void newExperiment()}>
              Criar experimento novo
            </button>
          )}
          <button className="btn" disabled={!changed} onClick={() => setDraft(cloneConfig(view.pendingConfig ?? view.config))}>
            Descartar
          </button>
          <button className="btn ghost" onClick={() => void saveConfig()}>
            Salvar configuração
          </button>
          {compatible && !basic && (
            <button className="btn ghost" onClick={() => void newExperiment()} title="Começa do zero com esta configuração e semente">
              Experimento novo
            </button>
          )}
        </div>
      </section>

      {view.changes.length > 0 && (
        <section>
          <h4>Histórico de mudanças</h4>
          <div className="log">
            {[...view.changes].reverse().map((c, i) => (
              <div key={i} className="msg decisao">
                <strong>Geração {c.gen}:</strong> {c.changes.join(' · ')}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
