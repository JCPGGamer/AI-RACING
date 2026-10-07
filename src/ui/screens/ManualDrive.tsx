import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { audio } from '../../audio/audio.ts';
import { paramCount, type Brain } from '../../core/nn.ts';
import { PHYSICS } from '../../core/physics.ts';
import { DEFAULT_INPUTS } from '../../core/sensors.ts';
import { END_REASON_LABEL, RaceSim, type EndReason, type RunRules } from '../../core/sim.ts';
import type { Track } from '../../core/track.ts';
import { fmtNum, fmtTime, Modal, Seg } from '../components.tsx';
import { drawCar, drawCrashEffect, drawPath } from '../render/draw.ts';
import { useApp } from '../store.ts';
import { TrackCanvas, type CameraMode } from '../TrackCanvas.tsx';
import { drawStartArrow } from './trackUi.tsx';

/**
 * Teste manual de dirigibilidade: o jogador dirige o carro com o teclado
 * (ou botões na tela) usando exatamente a mesma física e colisão dos pilotos.
 * A simulação avança em passos fixos (PHYSICS.dt); a taxa de quadros só
 * decide quantos passos rodar em cada quadro.
 */

const RULES: RunRules = { maxTime: 600, stallTime: 600, stallDist: 1 };
const MAX_STEPS_PER_FRAME = 10;
const CAR_COLOR = '#ffd43b';
const TRAIL_MAX = 600;

/** Cérebro só para satisfazer a simulação: o controle vem do teclado. */
function dummyBrain(): Brain {
  const hidden = [4];
  return { inputs: { ...DEFAULT_INPUTS }, hidden, genome: new Float64Array(paramCount(DEFAULT_INPUTS, hidden)) };
}

interface Controls {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

type ControlKey = keyof Controls;

const KEY_MAP: Record<string, ControlKey> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  KeyW: 'up',
  KeyS: 'down',
  KeyA: 'left',
  KeyD: 'right',
};

interface Hud {
  speed: number;
  time: number;
  progress: number;
  cps: number;
  status: EndReason;
  lapTime: number | null;
  started: boolean;
}

export function ManualDriveModal(props: { track: Track; onClose: () => void }) {
  return (
    <Modal title={`Testar dirigindo — ${props.track.def.name}`} onClose={props.onClose} wide>
      <ManualDrive track={props.track} />
    </Modal>
  );
}

export function ManualDrive({ track }: { track: Track }) {
  const prefs = useApp((s) => s.prefs);
  const simRef = useRef<RaceSim | null>(null);
  const keys = useRef<Controls>({ up: false, down: false, left: false, right: false });
  const touch = useRef<Controls>({ up: false, down: false, left: false, right: false });
  const startedRef = useRef(false);
  const pausedRef = useRef(false);
  const trail = useRef<{ pts: number[]; n: number }>({ pts: [], n: 0 });
  const crashAt = useRef<number | null>(null);
  const [cam, setCam] = useState<CameraMode>('seguir');
  const [paused, setPaused] = useState(false);
  const [best, setBest] = useState<number | null>(null);
  const [runId, setRunId] = useState(0);
  const [hud, setHud] = useState<Hud>({ speed: 0, time: 0, progress: 0, cps: 0, status: 'correndo', lapTime: null, started: false });

  const makeSim = () => {
    const sim = new RaceSim(track, [dummyBrain()], RULES);
    sim.cars[0].controller = (_car, out) => {
      const k = keys.current;
      const t = touch.current;
      const left = k.left || t.left;
      const right = k.right || t.right;
      // direção positiva vira no sentido horário da tela (para a direita)
      out[0] = (right ? 1 : 0) - (left ? 1 : 0);
      out[1] = k.up || t.up ? 1 : 0;
      out[2] = k.down || t.down ? 1 : 0;
    };
    simRef.current = sim;
    startedRef.current = false;
    trail.current = { pts: [sim.cars[0].phys.x, sim.cars[0].phys.y], n: 1 };
    crashAt.current = null;
    return sim;
  };
  if (!simRef.current || simRef.current.track !== track) makeSim();

  const restart = () => {
    audio.click();
    makeSim();
    pausedRef.current = false;
    setPaused(false);
    setRunId((r) => r + 1);
  };
  const restartRef = useRef(restart);
  restartRef.current = restart;

  // Teclado: setas ou WASD; R recomeça.
  useEffect(() => {
    const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') && (t as HTMLInputElement).type !== 'range';
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const k = KEY_MAP[e.code] ?? KEY_MAP[e.key];
      if (k) {
        keys.current[k] = true;
        e.preventDefault();
        return;
      }
      if ((e.key === 'r' || e.key === 'R') && !e.repeat) {
        e.preventDefault();
        restartRef.current();
      }
    };
    const up = (e: KeyboardEvent) => {
      const k = KEY_MAP[e.code] ?? KEY_MAP[e.key];
      if (k) keys.current[k] = false;
    };
    const clear = () => {
      keys.current = { up: false, down: false, left: false, right: false };
      touch.current = { up: false, down: false, left: false, right: false };
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
    };
  }, []);

  // Laço de simulação com passo fixo e acumulador.
  useEffect(() => {
    let raf = 0;
    let last = 0;
    let acc = 0;
    let engineOn = false;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const elapsed = last ? Math.min(0.25, (now - last) / 1000) : 0;
      last = now;
      const sim = simRef.current;
      if (!sim) return;
      const car = sim.cars[0];
      const k = keys.current;
      const t = touch.current;
      if (!startedRef.current && (k.up || k.down || k.left || k.right || t.up || t.down || t.left || t.right)) {
        startedRef.current = true;
        audio.start();
      }
      const running = startedRef.current && !pausedRef.current && car.alive;
      if (running) {
        acc += elapsed;
        let steps = 0;
        while (acc >= PHYSICS.dt && steps < MAX_STEPS_PER_FRAME && car.alive) {
          sim.stepAll();
          acc -= PHYSICS.dt;
          steps++;
          for (const ev of sim.events) {
            if (ev.type === 'batida') {
              audio.crash();
              crashAt.current = performance.now();
            } else if (ev.type === 'volta') {
              audio.lap();
            }
          }
          if (car.steps % 3 === 0) {
            const tr = trail.current;
            if (tr.n >= TRAIL_MAX) {
              tr.pts.splice(0, 2);
              tr.n--;
            }
            tr.pts.push(car.phys.x, car.phys.y);
            tr.n++;
          }
        }
        // Atraso grande (aba lenta): descarta em vez de acelerar o tempo.
        if (steps >= MAX_STEPS_PER_FRAME) acc = 0;
      } else {
        acc = 0;
      }
      const active = running && car.alive;
      if (active) {
        audio.setEngine(true, car.phys.speed / PHYSICS.speedNorm, car.phys.throttle);
        engineOn = true;
      } else if (engineOn) {
        audio.setEngine(false, 0, 0);
        engineOn = false;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      audio.setEngine(false, 0, 0);
    };
  }, [track]);

  // Painel (10 vezes por segundo, sem redesenhar a tela inteira a cada passo).
  useEffect(() => {
    const read = () => {
      const sim = simRef.current;
      if (!sim) return;
      const car = sim.cars[0];
      const completed = car.status === 'completou';
      const next: Hud = {
        speed: car.phys.speed * 3.6,
        time: car.time,
        progress: completed ? 1 : Math.max(0, Math.min(1, car.maxProgress / sim.track.lapDistance)),
        cps: car.cpPassed,
        status: car.status,
        lapTime: completed ? car.lapTime : null,
        started: startedRef.current,
      };
      setHud((h) =>
        h.speed === next.speed && h.time === next.time && h.status === next.status && h.cps === next.cps && h.started === next.started && h.progress === next.progress ? h : next,
      );
      if (completed) setBest((b) => (b === null || car.lapTime < b ? car.lapTime : b));
    };
    read();
    const id = setInterval(read, 100);
    return () => clearInterval(id);
  }, [runId, track]);

  const setTouch = (k: ControlKey, v: boolean) => {
    touch.current[k] = v;
  };

  const ended = hud.status !== 'correndo';
  const cpTotal = track.checkpoints.length;

  return (
    <div className="stack">
      <div className="callout">
        Ferramenta de teste: dirija você mesmo para ver se a pista é possível de percorrer. Use <span className="kbd">↑</span>/<span className="kbd">W</span> para acelerar,{' '}
        <span className="kbd">↓</span>/<span className="kbd">S</span> para frear e <span className="kbd">←</span> <span className="kbd">→</span> ou <span className="kbd">A</span>{' '}
        <span className="kbd">D</span> para virar. <span className="kbd">R</span> recomeça. A física e as batidas são as mesmas dos pilotos.
      </div>
      <div className="lab-stage" style={{ height: 'min(62vh, 560px)' }}>
        <TrackCanvas
          track={track}
          animate
          cameraMode={cam}
          followScale={6}
          followTarget={() => {
            const car = simRef.current?.cars[0];
            return car ? { x: car.phys.x, y: car.phys.y } : null;
          }}
          showCheckpoints={prefs.showCheckpoints}
          ariaLabel="Pista do teste manual com o seu carro"
          onDraw={({ ctx, cam: c, now }) => {
            const sim = simRef.current;
            if (!sim) return;
            drawStartArrow(ctx, sim.track, c.scale);
            const car = sim.cars[0];
            const tr = trail.current;
            if (tr.n >= 2) drawPath(ctx, tr.pts, 'rgba(255, 212, 59, 0.45)', c.scale, 1.4, tr.n);
            const P = car.phys;
            const look = car.status === 'batida' ? 'morto' : car.status === 'completou' ? 'concluido' : car.status === 'correndo' ? 'normal' : 'parado';
            drawCar(ctx, P.x, P.y, P.heading, CAR_COLOR, look, c.scale, { steer: P.steer / PHYSICS.maxSteer });
            if (car.status === 'batida' && crashAt.current !== null && !prefs.hideEffects && Number.isFinite(car.crashX)) {
              drawCrashEffect(ctx, car.crashX, car.crashY, (now - crashAt.current) / 1000, c.scale, prefs.reduceMotion);
            }
          }}
        >
          <div className="hud" aria-live="off">
            <span className="chip">{fmtNum(hud.speed, 0)} km/h</span>
            <span className="chip">⏱ {fmtTime(hud.time)}</span>
            <span className="chip">Progresso {Math.round(hud.progress * 100)}%</span>
            <span className="chip">
              Checkpoints {Math.min(hud.cps, cpTotal)}/{cpTotal}
            </span>
            {best !== null && <span className="chip">Melhor volta: {fmtTime(best)}</span>}
          </div>
          {!hud.started && !ended && <CenterNote>Pressione ↑ (ou W) ou toque em ▲ para largar</CenterNote>}
          {paused && !ended && <CenterNote>Pausado</CenterNote>}
          {ended && (
            <div style={endBox} role="status">
              <strong style={{ fontSize: '1.15em', display: 'block', marginBottom: 4 }}>
                {hud.status === 'completou' ? '🏁 ' : hud.status === 'batida' ? '💥 ' : ''}
                {END_REASON_LABEL[hud.status]}
              </strong>
              {hud.status === 'completou' ? (
                <div>Tempo da volta: {fmtTime(hud.lapTime)}</div>
              ) : (
                <div>
                  Progresso: {Math.round(hud.progress * 100)}% em {fmtTime(hud.time)}
                </div>
              )}
              <button className="btn primary" style={{ marginTop: 10 }} onClick={restart}>
                ↻ Recomeçar
              </button>
            </div>
          )}
          <TouchPad onChange={setTouch} />
        </TrackCanvas>
      </div>
      <div className="controls">
        <button className="btn primary" onClick={restart}>
          ↻ Recomeçar
        </button>
        <button
          className="btn"
          disabled={ended || !hud.started}
          aria-pressed={paused}
          onClick={() => {
            audio.click();
            pausedRef.current = !pausedRef.current;
            setPaused(pausedRef.current);
          }}
        >
          {paused ? '▶ Continuar' : '⏸ Pausar'}
        </button>
        <Seg
          ariaLabel="Câmera"
          value={cam}
          onChange={setCam}
          options={[
            { value: 'seguir', label: 'Seguir o carro' },
            { value: 'geral', label: 'Visão geral' },
          ]}
        />
        <span className="muted" style={{ fontSize: '0.88em' }}>
          Sem limite de tempo prático (10 min). Encostar na borda encerra a tentativa.
        </span>
      </div>
    </div>
  );
}

const endBox: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: '50%',
  transform: 'translate(-50%, -50%)',
  background: 'rgba(12, 17, 23, 0.94)',
  border: '1px solid var(--border-strong)',
  borderRadius: 12,
  padding: '14px 18px',
  textAlign: 'center',
  minWidth: 220,
  maxWidth: 'calc(100% - 24px)',
};

function CenterNote({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: '50%',
        top: 52,
        transform: 'translateX(-50%)',
        background: 'rgba(10, 14, 19, 0.85)',
        border: '1px solid var(--border)',
        borderRadius: 999,
        padding: '6px 14px',
        fontWeight: 700,
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </div>
  );
}

/** Botões na tela para toque (também funcionam com o mouse). */
function TouchPad({ onChange }: { onChange: (k: ControlKey, v: boolean) => void }) {
  const pad = (k: ControlKey, label: string, aria: string) => (
    <button
      type="button"
      className="btn"
      aria-label={aria}
      tabIndex={-1}
      style={padBtn}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        onChange(k, true);
      }}
      onPointerUp={() => onChange(k, false)}
      onPointerCancel={() => onChange(k, false)}
      onLostPointerCapture={() => onChange(k, false)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {label}
    </button>
  );
  return (
    <>
      <div style={{ ...padGroup, left: 10 }}>
        {pad('left', '◀', 'Virar para a esquerda')}
        {pad('right', '▶', 'Virar para a direita')}
      </div>
      <div style={{ ...padGroup, right: 10 }}>
        {pad('down', '▼', 'Frear')}
        {pad('up', '▲', 'Acelerar')}
      </div>
    </>
  );
}

const padGroup: CSSProperties = {
  position: 'absolute',
  bottom: 10,
  display: 'flex',
  gap: 8,
  touchAction: 'none',
  userSelect: 'none',
};

const padBtn: CSSProperties = {
  width: 58,
  height: 58,
  padding: 0,
  fontSize: 22,
  borderRadius: 14,
  background: 'rgba(16, 22, 30, 0.72)',
  touchAction: 'none',
  userSelect: 'none',
  WebkitUserSelect: 'none',
};
