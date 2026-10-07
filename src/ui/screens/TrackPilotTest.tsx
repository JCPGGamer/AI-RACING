import { useEffect, useRef, useState } from 'react';
import { audio } from '../../audio/audio.ts';
import type { PilotRecord } from '../../core/models.ts';
import { END_REASON_LABEL, type EndReason } from '../../core/sim.ts';
import type { Track, TrackDef } from '../../core/track.ts';
import { cancelEval, evaluateOnTracks } from '../../lab/evalClient.ts';
import { db } from '../../persistence/db.ts';
import type { EvalTrackResult } from '../../workers/protocol.ts';
import { Empty, fmtTime, Loading, Modal, Stat, useAsync } from '../components.tsx';
import { ReplayPlayer } from '../ReplayPlayer.tsx';
import { navigate } from '../store.ts';

/**
 * "Testar com um piloto": escolhe um piloto da Garagem, roda uma tentativa
 * com as regras oficiais nesta pista (no worker de avaliação) e mostra o
 * resultado com o replay.
 */
export function PilotTestModal(props: { def: TrackDef; track: Track; onClose: () => void }) {
  const pilots = useAsync(async () => {
    const all = await db.getAll<PilotRecord>('pilots');
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }, []);
  const [pilotId, setPilotId] = useState('');
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'running' }
    | { kind: 'done'; pilot: PilotRecord; result: EvalTrackResult }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  const reqId = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (reqId.current !== null) cancelEval(reqId.current);
    };
  }, []);

  const list = pilots.data ?? [];
  const chosen = list.find((p) => p.id === pilotId) ?? list[0] ?? null;

  const run = async () => {
    if (!chosen) return;
    audio.click();
    if (reqId.current !== null) cancelEval(reqId.current);
    setState({ kind: 'running' });
    const pilot = chosen;
    const req = evaluateOnTracks(pilot.brain, [props.def], 1, { pilotName: pilot.name, color: pilot.color });
    reqId.current = req.id;
    try {
      const results = await req.promise;
      if (reqId.current !== req.id) return;
      reqId.current = null;
      const result = results[0];
      if (!result) throw new Error('A avaliação não devolveu resultado.');
      setState({ kind: 'done', pilot, result });
      if (result.result.attempts[0]?.completed) audio.lap();
    } catch (e) {
      if (reqId.current !== req.id) return;
      reqId.current = null;
      setState({ kind: 'error', message: (e as Error).message === 'cancelado' ? 'Teste cancelado.' : `Não foi possível testar: ${(e as Error).message}` });
    }
  };

  return (
    <Modal title={`Testar com um piloto — ${props.def.name}`} onClose={props.onClose} wide>
      <div className="stack">
        {pilots.loading && !pilots.data && <Loading text="Carregando pilotos da Garagem…" />}
        {pilots.error && <div className="callout err">Não foi possível ler a Garagem: {pilots.error}</div>}
        {!pilots.loading && !pilots.error && list.length === 0 && (
          <Empty icon="🧠" title="Nenhum piloto na Garagem ainda">
            <p>Treine um piloto no Laboratório e salve-o na Garagem. Depois volte aqui para ver como ele se sai nesta pista.</p>
            <button
              className="btn primary"
              onClick={() => {
                props.onClose();
                navigate('laboratorio');
              }}
            >
              Ir para o Laboratório
            </button>
          </Empty>
        )}
        {list.length > 0 && (
          <>
            <p className="muted" style={{ margin: 0 }}>
              O piloto faz uma tentativa com as regras oficiais (largada parada, no centro). Pilotos treinados em outras pistas podem errar aqui: isso mostra se eles
              aprenderam a dirigir ou só decoraram o caminho.
            </p>
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <label className="field" style={{ flex: '1 1 240px' }}>
                <span className="field-label">Piloto</span>
                <select
                  value={chosen?.id ?? ''}
                  onChange={(e) => {
                    setPilotId(e.target.value);
                    if (state.kind !== 'running') setState({ kind: 'idle' });
                  }}
                >
                  {list.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {p.brain.inputs.rays} sensores, camadas [{p.brain.hidden.join(', ')}]
                    </option>
                  ))}
                </select>
              </label>
              {chosen && <span className="swatch" style={{ background: chosen.color, width: 22, height: 22, marginBottom: 9 }} aria-hidden />}
              <button className="btn primary" onClick={() => void run()} disabled={!chosen || state.kind === 'running'}>
                {state.kind === 'running' ? 'Testando…' : '▶ Testar'}
              </button>
            </div>
          </>
        )}
        {state.kind === 'running' && <Loading text="O piloto está correndo (simulação rápida em segundo plano)…" />}
        {state.kind === 'error' && <div className="callout err">{state.message}</div>}
        {state.kind === 'done' && <PilotResult track={props.track} pilot={state.pilot} result={state.result} />}
      </div>
    </Modal>
  );
}

function PilotResult({ track, pilot, result }: { track: Track; pilot: PilotRecord; result: EvalTrackResult }) {
  const a = result.result.attempts[0];
  if (!a) return <div className="callout err">Sem resultado.</div>;
  const reason = END_REASON_LABEL[a.reason as EndReason] ?? a.reason;
  return (
    <div className="stack">
      <div className={`callout ${a.completed ? 'ok' : 'warn'}`}>
        {a.completed ? (
          <>
            <strong>{pilot.name}</strong> completou a volta em <strong>{fmtTime(a.time)}</strong>.
          </>
        ) : (
          <>
            <strong>{pilot.name}</strong> não completou a volta: {reason.toLowerCase()} com {Math.round(a.progress * 100)}% do percurso.
          </>
        )}
      </div>
      <div className="stats-row">
        <Stat label="Completou?" value={a.completed ? 'Sim' : 'Não'} />
        <Stat label="Tempo" value={fmtTime(a.time)} sub={a.completed ? 'tempo da volta' : 'até parar'} />
        <Stat label="Progresso" value={`${Math.round(a.progress * 100)}%`} />
        <Stat label="Fim da tentativa" value={reason} />
      </div>
      {result.replay ? (
        <ReplayPlayer track={track} entries={[{ replay: result.replay, label: pilot.name, color: pilot.color, rays: pilot.brain.inputs.rays }]} height={380} />
      ) : (
        <div className="callout">Esta tentativa não gerou replay.</div>
      )}
    </div>
  );
}
