import { useState } from 'react';
import { audio } from '../../audio/audio.ts';
import { benchmark } from '../../lab/evalClient.ts';
import { getLab } from '../../lab/labSession.ts';
import { getCoach } from '../../lab/coachSession.ts';
import { API_BASE, checkOnline, useOnline } from '../../online/session.ts';
import { db } from '../../persistence/db.ts';
import { confirmDialog, Modal, Slider, Toggle, useAsync } from '../components.tsx';
import { dataChanged, setPrefs, setState, toast, useApp } from '../store.ts';

function suggestion(steps60: number): string {
  // steps60 = gerações-passo por segundo com 50 carros
  if (steps60 < 600) return 'Aparelho modesto: use população 20 ou 50, velocidade até 5× e ative o modo de baixo consumo.';
  if (steps60 < 2000) return 'Bom desempenho: população 50 ou 100 funciona bem; o modo máximo acelera bastante.';
  return 'Ótimo desempenho: populações de 100 ou 200 e a treinadora com orçamentos maiores são viáveis.';
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const prefs = useApp((s) => s.prefs);
  const online = useOnline();
  const storage = useAsync(() => db.estimate(), []);
  const [bench, setBench] = useState<{ pop: number; car: number; steps: number }[] | null>(null);
  const [benching, setBenching] = useState(false);

  const runBench = async () => {
    setBenching(true);
    const out: { pop: number; car: number; steps: number }[] = [];
    try {
      for (const pop of [20, 50, 100, 200]) {
        const r = await benchmark(pop, 1200).promise;
        out.push({ pop, car: r.carStepsPerSec, steps: r.stepsPerSec });
        setBench([...out]);
      }
    } catch (e) {
      toast((e as Error).message, 'erro');
    } finally {
      setBenching(false);
    }
  };

  const vol = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <Modal title="Configurações" onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Fechar</button>}>
      <div className="stack">
        <section className="stack">
          <h3>Som e música</h3>
          <Toggle label="Silenciar tudo" checked={prefs.muted} onChange={(v) => setPrefs({ muted: v })} />
          <Slider label="Música" value={prefs.musicVolume} min={0} max={1} step={0.05} format={vol} onChange={(v) => setPrefs({ musicVolume: v })} limits={false} />
          <Slider
            label="Efeitos"
            value={prefs.sfxVolume}
            min={0}
            max={1}
            step={0.05}
            format={vol}
            onChange={(v) => {
              setPrefs({ sfxVolume: v });
              audio.click();
            }}
            limits={false}
          />
          <Slider label="Motor (carro acompanhado)" value={prefs.engineVolume} min={0} max={1} step={0.05} format={vol} onChange={(v) => setPrefs({ engineVolume: v })} limits={false} />
          <p className="field-hint">O som só começa depois do seu primeiro clique ou tecla. O motor toca apenas para o carro selecionado (ou o líder, no modo seguir) e some ao pausar.</p>
        </section>
        <div className="divider" />
        <section className="stack">
          <h3>Acessibilidade e visual</h3>
          <Toggle label="Reduzir movimento" description="Sem animações de interface e efeitos de batida estáticos." checked={prefs.reduceMotion} onChange={(v) => setPrefs({ reduceMotion: v })} />
          <Toggle label="Fonte mais legível" checked={prefs.legibleFont} onChange={(v) => setPrefs({ legibleFont: v })} />
          <Toggle label="Texto maior" checked={prefs.largeText} onChange={(v) => setPrefs({ largeText: v })} />
          <Toggle label="Alto contraste" checked={prefs.highContrast} onChange={(v) => setPrefs({ highContrast: v })} />
          <Toggle label="Esconder sensores" checked={prefs.hideSensors} onChange={(v) => setPrefs({ hideSensors: v })} />
          <Toggle label="Esconder efeitos visuais" checked={prefs.hideEffects} onChange={(v) => setPrefs({ hideEffects: v })} />
          <Toggle label="Mostrar checkpoints na pista" checked={prefs.showCheckpoints} onChange={(v) => setPrefs({ showCheckpoints: v })} />
          <Toggle label="Modo básico nas configurações" description="Mostra poucos controles, com explicações simples." checked={prefs.basicMode} onChange={(v) => setPrefs({ basicMode: v })} />
        </section>
        <div className="divider" />
        <section className="stack">
          <h3>Desempenho</h3>
          <Toggle
            label="Modo de baixo consumo"
            description="Desenha a ~30 quadros por segundo e envia menos atualizações do treino. A simulação continua exata."
            checked={prefs.lowPower}
            onChange={(v) => {
              setPrefs({ lowPower: v });
              getLab()?.setLowPower(v);
            }}
          />
          <div className="row">
            <button className="btn" disabled={benching} onClick={() => void runBench()}>
              {benching ? 'Medindo…' : 'Medir desempenho deste aparelho'}
            </button>
            <span className="field-hint">Roda um treino real por alguns segundos com 20, 50, 100 e 200 carros.</span>
          </div>
          {bench && (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th className="num">População</th>
                    <th className="num">Passos-carro/s</th>
                    <th className="num">Passos de simulação/s</th>
                    <th className="num">Equivale a</th>
                  </tr>
                </thead>
                <tbody>
                  {bench.map((b) => (
                    <tr key={b.pop}>
                      <td className="num">{b.pop}</td>
                      <td className="num">{Math.round(b.car).toLocaleString('pt-BR')}</td>
                      <td className="num">{Math.round(b.steps).toLocaleString('pt-BR')}</td>
                      <td className="num">{(b.steps / 60).toFixed(0)}× tempo real</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {bench.find((b) => b.pop === 50) && <div className="callout" style={{ marginTop: 8 }}>{suggestion(bench.find((b) => b.pop === 50)!.steps)}</div>}
            </div>
          )}
        </section>
        <div className="divider" />
        <section className="stack">
          <h3>Ranking online</h3>
          <p className="muted" style={{ margin: 0 }}>
            Servidor: <span className="mono">{API_BASE || `${location.origin} (mesma origem)`}</span> — estado:{' '}
            <strong>{online.status === 'online' ? 'disponível' : online.status === 'offline' ? 'Ranking online indisponível' : 'verificando'}</strong>
          </p>
          <div>
            <button className="btn small" onClick={() => void checkOnline()}>
              Verificar agora
            </button>
          </div>
        </section>
        <div className="divider" />
        <section className="stack">
          <h3>Dados locais</h3>
          <p className="muted" style={{ margin: 0 }}>
            {storage.data ? `Usando ${(storage.data.usage / 1048576).toFixed(1)} MB de ${(storage.data.quota / 1048576).toFixed(0)} MB disponíveis neste navegador.` : 'Uso de armazenamento indisponível.'}
          </p>
          <div className="row">
            <button
              className="btn danger"
              onClick={async () => {
                if (!(await confirmDialog('Apagar tudo', 'Apaga laboratórios, pilotos, treinadoras, pistas, replays e linhagens deste navegador. Não dá para desfazer. Exporte antes o que quiser guardar.', 'Apagar tudo'))) return;
                getLab()?.dispose();
                getCoach()?.dispose();
                try {
                  await db.clearAll();
                  setState({ currentProjectId: null });
                  dataChanged();
                  toast('Dados locais apagados.', 'info');
                } catch (e) {
                  toast((e as Error).message, 'erro');
                }
              }}
            >
              Apagar todos os dados locais
            </button>
            <button className="btn" onClick={() => setPrefs({ tutorialSeen: false })}>
              Mostrar tutorial de novo
            </button>
          </div>
        </section>
      </div>
    </Modal>
  );
}
