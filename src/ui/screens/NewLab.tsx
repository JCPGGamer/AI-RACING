import { useEffect, useMemo, useState } from 'react';
import { ARCH_PRESETS, defaultExperiment, type ExperimentConfig } from '../../core/config.ts';
import { POPULATION_OPTIONS } from '../../core/evolution.ts';
import type { PilotRecord, SavedConfigRecord } from '../../core/models.ts';
import { costPerStep, describeArch, paramCount } from '../../core/nn.ts';
import { REWARD_PRESETS, type RewardPresetId } from '../../core/rewards.ts';
import { describeInputs, inputCount, type RayCount } from '../../core/sensors.ts';
import { audio } from '../../audio/audio.ts';
import { createProject } from '../../lab/labSession.ts';
import { listTrackDefs } from '../../lab/tracks.ts';
import { db } from '../../persistence/db.ts';
import { Hint, Modal, Seg, Toggle, useAsync } from '../components.tsx';
import { getState, navigate, setState, toast, useApp } from '../store.ts';

export const POPULATION_IMPACT: Record<number, string> = {
  20: 'Rápida em qualquer aparelho, mas explora pouco: pode demorar mais gerações.',
  50: 'Equilíbrio recomendado para começar.',
  100: 'Mais variedade por geração; cada geração demora o dobro.',
  200: 'Muita variedade; pede um computador mais forte (gerações lentas).',
};

type Origin = 'zero' | 'piloto' | 'config';

export function NewLabModal({ onClose }: { onClose: () => void }) {
  const preset = useApp((s) => s.newLab);
  const tracks = useAsync(() => listTrackDefs(), []);
  const pilots = useAsync(() => db.getAll<PilotRecord>('pilots').catch(() => [] as PilotRecord[]), []);
  const configs = useAsync(() => db.getAll<SavedConfigRecord>('configs').catch(() => [] as SavedConfigRecord[]), []);
  const [name, setName] = useState(preset?.name ?? '');
  const [origin, setOrigin] = useState<Origin>(preset?.pilotId ? 'piloto' : preset?.configId ? 'config' : 'zero');
  const [pilotId, setPilotId] = useState(preset?.pilotId ?? '');
  const [configId, setConfigId] = useState(preset?.configId ?? '');
  const [cfg, setCfg] = useState<ExperimentConfig>(() => defaultExperiment(preset?.trackId ?? 'oval-largo', `semente-${Date.now() % 100000}`));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (preset?.trackId) setCfg((c) => ({ ...c, trackIds: [preset.trackId!] }));
  }, [preset?.trackId]);

  const pilot = pilots.data?.find((p) => p.id === pilotId);
  const savedCfg = configs.data?.find((c) => c.id === configId);

  // Ao escolher um piloto, sensores e arquitetura vêm dele (pesos compatíveis).
  const effective: ExperimentConfig = useMemo(() => {
    if (origin === 'piloto' && pilot) return { ...cfg, inputs: { ...pilot.brain.inputs }, hidden: [...pilot.brain.hidden] };
    if (origin === 'config' && savedCfg) return { ...savedCfg.config, seed: cfg.seed, trackIds: cfg.trackIds };
    return cfg;
  }, [origin, pilot, savedCfg, cfg]);

  const params = paramCount(effective.inputs, effective.hidden);
  const preset2 = (Object.keys(REWARD_PRESETS) as Exclude<RewardPresetId, 'personalizado'>[]).find((k) => REWARD_PRESETS[k].weights.progress === cfg.rewards.progress && REWARD_PRESETS[k].weights.time === cfg.rewards.time && REWARD_PRESETS[k].weights.collision === cfg.rewards.collision);

  const create = async () => {
    if (origin === 'piloto' && !pilot) return toast('Escolha um piloto.', 'aviso');
    if (origin === 'config' && !savedCfg) return toast('Escolha uma configuração.', 'aviso');
    setBusy(true);
    audio.click();
    try {
      const trackName = tracks.data?.find((t) => t.id === effective.trackIds[0])?.name ?? effective.trackIds[0];
      const p = await createProject(name.trim() || `${trackName} ${new Date().toLocaleDateString('pt-BR')}`, effective, {
        champion: origin === 'piloto' && pilot ? pilot.brain.genome : undefined,
      });
      setState({ currentProjectId: p.id, newLab: null });
      onClose();
      navigate('laboratorio', 'autoplay');
    } catch (e) {
      toast((e as Error).message, 'erro', 7000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Novo laboratório"
      onClose={() => {
        setState({ newLab: null });
        onClose();
      }}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary big" disabled={busy} onClick={() => void create()}>
            {busy ? 'Criando…' : '▶ Criar e começar a treinar'}
          </button>
        </>
      }
    >
      <div className="stack">
        <label className="field">
          <span className="field-label">Nome do laboratório</span>
          <input type="text" value={name} maxLength={60} placeholder="Ex.: Meu primeiro piloto" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">
            <span className="row" style={{ gap: 6 }}>
              Pista de treino <Hint text="A população treina nesta pista. Depois você pode testar o piloto em pistas que ele nunca viu." />
            </span>
          </span>
          <select value={cfg.trackIds[0]} onChange={(e) => setCfg({ ...cfg, trackIds: [e.target.value] })}>
            {(tracks.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.builtin ? ` — dificuldade ${t.difficulty}` : ' (personalizada)'}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          <span className="field-label">Ponto de partida</span>
          <Seg
            ariaLabel="Ponto de partida"
            value={origin}
            onChange={setOrigin}
            options={[
              { value: 'zero', label: 'Do zero' },
              { value: 'piloto', label: 'A partir de um piloto' },
              { value: 'config', label: 'Configuração salva' },
            ]}
          />
          <span className="field-hint">
            {origin === 'zero' && 'Todos os cérebros começam aleatórios: no início ninguém sabe dirigir.'}
            {origin === 'piloto' && 'Carrega só o cérebro do campeão escolhido e cria variações dele. Histórico e população antiga não vêm junto (para isso, use "Continuar" ou uma linhagem).'}
            {origin === 'config' && 'Usa sensores, rede, evolução e recompensas de uma configuração salva na Garagem.'}
          </span>
        </div>
        {origin === 'piloto' && (
          <select aria-label="Piloto de origem" value={pilotId} onChange={(e) => setPilotId(e.target.value)}>
            <option value="">Escolha um piloto…</option>
            {(pilots.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({describeArch(p.brain.inputs, p.brain.hidden)})
              </option>
            ))}
          </select>
        )}
        {origin === 'config' && (
          <select aria-label="Configuração salva" value={configId} onChange={(e) => setConfigId(e.target.value)}>
            <option value="">Escolha uma configuração…</option>
            {(configs.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        {origin !== 'config' && (
          <>
            <div className="field">
              <span className="field-label">
                <span className="row" style={{ gap: 6 }}>
                  Recompensa <Hint text="Define o que conta pontos no treino. Os melhores em pontos viram pais da próxima geração." />
                </span>
              </span>
              <Seg
                ariaLabel="Recompensa"
                value={preset2 ?? 'completar'}
                onChange={(id) => setCfg({ ...cfg, rewards: { ...REWARD_PRESETS[id].weights }, rewardPreset: id })}
                options={(Object.keys(REWARD_PRESETS) as Exclude<RewardPresetId, 'personalizado'>[]).map((k) => ({ value: k, label: REWARD_PRESETS[k].name }))}
              />
              <span className="field-hint">{REWARD_PRESETS[preset2 ?? 'completar'].description}</span>
            </div>
            <div className="field">
              <span className="field-label">População (carros por geração)</span>
              <Seg
                ariaLabel="População"
                value={cfg.evo.populationSize}
                onChange={(v) => setCfg({ ...cfg, evo: { ...cfg.evo, populationSize: v } })}
                options={POPULATION_OPTIONS.map((p) => ({ value: p, label: String(p) }))}
              />
              <span className="field-hint">{POPULATION_IMPACT[cfg.evo.populationSize]}</span>
            </div>
          </>
        )}
        {origin === 'zero' && (
          <div className="grid cols-2">
            <div className="field">
              <span className="field-label">
                <span className="row" style={{ gap: 6 }}>
                  Sensores de distância <Hint text="Raios que medem a distância até a borda, à frente e nas diagonais." />
                </span>
              </span>
              <Seg
                ariaLabel="Sensores"
                value={cfg.inputs.rays}
                onChange={(v: RayCount) => setCfg({ ...cfg, inputs: { ...cfg.inputs, rays: v } })}
                options={[5, 9, 13].map((r) => ({ value: r as RayCount, label: String(r) }))}
              />
            </div>
            <label className="field">
              <span className="field-label">Cérebro (camadas ocultas)</span>
              <select
                value={cfg.hidden.join('x')}
                onChange={(e) => setCfg({ ...cfg, hidden: e.target.value.split('x').map(Number) })}
              >
                {ARCH_PRESETS.map((a) => (
                  <option key={a.label} value={a.hidden.join('x')}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
            <Toggle
              label="Ângulo em relação à pista"
              checked={cfg.inputs.trackAngle}
              onChange={(v) => setCfg({ ...cfg, inputs: { ...cfg.inputs, trackAngle: v } })}
              hint="Informação fornecida pela pista. A categoria 'Sensores' do ranking não permite."
            />
            <Toggle
              label="Pontos à frente na pista"
              checked={cfg.inputs.lookahead}
              onChange={(v) => setCfg({ ...cfg, inputs: { ...cfg.inputs, lookahead: v } })}
              hint="Direção de dois pontos da linha central à frente (25 m e 60 m). Informação da pista."
            />
          </div>
        )}
        <div className="callout">
          <strong>Resumo:</strong> {describeInputs(effective.inputs)} → rede {describeArch(effective.inputs, effective.hidden)} ({inputCount(effective.inputs)} entradas,{' '}
          {params} parâmetros, ~{costPerStep(effective.inputs, effective.hidden)} operações por passo). Mais detalhes no modo avançado do laboratório.
        </div>
        {getState().prefs.basicMode && <p className="field-hint">Dica: você pode mudar mutação, elite e outros ajustes depois, sem perder o treino.</p>}
      </div>
    </Modal>
  );
}
