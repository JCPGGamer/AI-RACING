import { useEffect, useMemo, useRef, useState } from 'react';
import { dsincos } from '../core/dmath.ts';
import { raycast } from '../core/geometry.ts';
import { replayDuration, replayPath, sampleReplay, type Replay, type ReplaySample } from '../core/replay.ts';
import { RAY_ANGLES_DEG, RAY_RANGE, type RayCount } from '../core/sensors.ts';
import type { Track } from '../core/track.ts';
import { audio } from '../audio/audio.ts';
import { Seg } from './components.tsx';
import { fmtTime } from './components.tsx';
import { drawCar, drawCrashEffect, drawPath, drawSensors } from './render/draw.ts';
import { TrackCanvas, type CameraMode } from './TrackCanvas.tsx';
import { useApp } from './store.ts';

export interface ReplayEntry {
  replay: Replay;
  label: string;
  color: string;
  /** desenha semitransparente (piloto antigo / comparação) */
  ghost?: boolean;
  /** quantidade de sensores do piloto (permite recalcular os raios pela pose) */
  rays?: RayCount;
}

/**
 * Player de replays: um ou vários carros ao mesmo tempo (fantasmas),
 * com controle de velocidade, linha do tempo, trajetória e sensores.
 */
export function ReplayPlayer(props: { track: Track; entries: ReplayEntry[]; autoPlay?: boolean; height?: number | string }) {
  const prefs = useApp((s) => s.prefs);
  const [playing, setPlaying] = useState(props.autoPlay ?? true);
  const [speed, setSpeed] = useState(1);
  const [t, setT] = useState(0);
  const [showPath, setShowPath] = useState(true);
  const [showSensors, setShowSensors] = useState(!prefs.hideSensors);
  const [cam, setCam] = useState<CameraMode>('geral');
  const tRef = useRef(0);
  const lastNow = useRef(0);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const duration = useMemo(() => Math.max(0.1, ...props.entries.map((e) => replayDuration(e.replay))), [props.entries]);
  const paths = useMemo(() => props.entries.map((e) => replayPath(e.replay, 2)), [props.entries]);
  const sample = useRef<ReplaySample>({ x: 0, y: 0, heading: 0, speed: 0, steer: 0, throttle: 0, brake: 0, ended: false });
  const mismatch = props.entries.some((e) => e.replay.meta.trackId === props.track.def.id && e.replay.meta.trackHash && e.replay.meta.trackHash !== props.track.hash);

  useEffect(() => {
    tRef.current = 0;
    setT(0);
  }, [props.entries]);

  useEffect(() => {
    let id = 0;
    const ui = setInterval(() => setT(tRef.current), 100);
    const tick = (now: number) => {
      id = requestAnimationFrame(tick);
      const dt = lastNow.current ? Math.min(0.1, (now - lastNow.current) / 1000) : 0;
      lastNow.current = now;
      if (playingRef.current) {
        tRef.current = Math.min(duration, tRef.current + dt * speedRef.current);
        if (tRef.current >= duration) setPlaying(false);
      }
    };
    id = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(id);
      clearInterval(ui);
      lastNow.current = 0;
    };
  }, [duration]);

  const lead = props.entries[0];
  return (
    <div className="stack">
      {mismatch && <div className="callout warn">Este replay foi gravado numa versão diferente da pista. A reprodução pode não bater com o traçado atual.</div>}
      <div className="lab-stage" style={{ height: props.height ?? 420 }}>
        <TrackCanvas
          track={props.track}
          animate
          cameraMode={cam}
          followScale={7}
          followTarget={() => {
            if (!lead) return null;
            sampleReplay(lead.replay, tRef.current, sample.current);
            return { x: sample.current.x, y: sample.current.y };
          }}
          ariaLabel="Replay da corrida"
          onDraw={({ ctx, cam: c, now }) => {
            props.entries.forEach((e, i) => {
              if (showPath) drawPath(ctx, paths[i], e.color + (e.ghost ? '66' : 'bb'), c.scale, 1.6);
            });
            props.entries.forEach((e, i) => {
              const s = sample.current;
              sampleReplay(e.replay, tRef.current, s);
              const finished = tRef.current >= replayDuration(e.replay);
              const crashed = finished && e.replay.meta.reason === 'batida';
              if (i === 0 && showSensors && e.rays && !crashed) {
                const rays = computeRays(props.track, s.x, s.y, s.heading, e.rays);
                drawSensors(ctx, s.x, s.y, s.heading, rays, e.rays, c.scale);
              }
              drawCar(ctx, s.x, s.y, s.heading, e.color, crashed ? 'morto' : e.ghost ? 'fantasma' : finished && e.replay.meta.completed ? 'concluido' : 'normal', c.scale, {
                steer: s.steer,
                selected: i === 0 && props.entries.length > 1,
              });
              if (crashed && e.replay.meta.crash && !prefs.hideEffects) {
                const age = tRef.current - replayDuration(e.replay);
                drawCrashEffect(ctx, e.replay.meta.crash.x, e.replay.meta.crash.y, age / Math.max(0.25, speedRef.current), c.scale, prefs.reduceMotion);
              }
            });
            void now;
          }}
        >
          <div className="hud">
            <span className="chip">{fmtTime(t)}</span>
            {props.entries.map((e) => (
              <span key={e.label} className="chip" style={{ borderColor: e.color }}>
                <span className="swatch" style={{ background: e.color, marginRight: 6 }} />
                {e.label}: {e.replay.meta.completed ? fmtTime(e.replay.meta.time) : `${Math.round(e.replay.meta.progress * 100)}% (${e.replay.meta.reason})`}
              </span>
            ))}
          </div>
        </TrackCanvas>
      </div>
      <div className="controls">
        <button
          className="btn primary"
          onClick={() => {
            audio.click();
            if (!playing && tRef.current >= duration) tRef.current = 0;
            setPlaying(!playing);
          }}
        >
          {playing ? '⏸ Pausar' : '▶ Reproduzir'}
        </button>
        <button
          className="btn"
          onClick={() => {
            tRef.current = 0;
            setT(0);
          }}
        >
          ⏮ Início
        </button>
        <Seg
          ariaLabel="Velocidade do replay"
          value={speed}
          onChange={setSpeed}
          options={[
            { value: 0.25, label: '¼×' },
            { value: 0.5, label: '½×' },
            { value: 1, label: '1×' },
            { value: 2, label: '2×' },
            { value: 4, label: '4×' },
          ]}
        />
        <Seg
          ariaLabel="Câmera"
          value={cam}
          onChange={setCam}
          options={[
            { value: 'geral', label: 'Visão geral' },
            { value: 'seguir', label: 'Seguir' },
          ]}
        />
        <label className="check">
          <input type="checkbox" checked={showPath} onChange={(e) => setShowPath(e.target.checked)} /> Trajetória
        </label>
        {lead?.rays && (
          <label className="check">
            <input type="checkbox" checked={showSensors} onChange={(e) => setShowSensors(e.target.checked)} /> Sensores
          </label>
        )}
      </div>
      <input
        type="range"
        aria-label="Linha do tempo do replay"
        min={0}
        max={duration}
        step={0.01}
        value={Math.min(t, duration)}
        onChange={(e) => {
          tRef.current = Number(e.target.value);
          setT(tRef.current);
        }}
      />
    </div>
  );
}

const scTmp = { s: 0, c: 0 };
/** Recalcula os sensores a partir da pose (mesma geometria da pista). */
export function computeRays(track: Track, x: number, y: number, heading: number, count: RayCount): number[] {
  const out: number[] = [];
  for (const a of RAY_ANGLES_DEG[count]) {
    dsincos(heading + (a * Math.PI) / 180, scTmp);
    out.push(raycast(track.grid, x, y, scTmp.c, scTmp.s, RAY_RANGE));
  }
  return out;
}
