import { useEffect, useRef } from 'react';
import { buildTrack, trackSummary, type Track, type TrackDef } from '../../core/track.ts';
import { TRACK_LIMITS } from '../../core/trackValidation.ts';
import { builtTrack } from '../../lab/tracks.ts';
import { fmtNum, Stat } from '../components.tsx';
import { drawTrack, fitCamera } from '../render/draw.ts';

/** Peças visuais compartilhadas pela lista de pistas, editor e testes. */

/** Constrói a pista sem lançar erro (null se a geometria for inválida). */
export function tryBuild(def: TrackDef, cached = true): Track | null {
  try {
    return cached ? builtTrack(def) : buildTrack(def);
  } catch {
    return null;
  }
}

/** Miniatura estática da pista (canvas com a mesma arte do jogo). */
export function TrackThumb({ track, label }: { track: Track | null; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const draw = () => {
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (w < 2 || h < 2) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      const ctx = c.getContext('2d');
      if (!ctx) return;
      if (!track) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = '#0f141b';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#9aa8b8';
        ctx.font = '13px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Pista inválida', w / 2, h / 2);
        return;
      }
      const cam = fitCamera(track.bounds, w, h, 8);
      drawTrack(ctx, track, cam, w, h, dpr);
      drawStartArrow(ctx, track, cam.scale);
    };
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    draw();
    return () => ro.disconnect();
  }, [track]);
  return <canvas ref={ref} className="thumb" role="img" aria-label={label} />;
}

/**
 * Seta do sentido de corrida logo depois da linha de chegada.
 * A transformação da câmera já deve estar aplicada (coordenadas em metros).
 */
export function drawStartArrow(ctx: CanvasRenderingContext2D, track: Track, scale: number, color = '#ffd43b'): void {
  const x = track.cx[0];
  const y = track.cy[0];
  const tx = track.tx[0];
  const ty = track.ty[0];
  // tamanho em metros, mas com mínimo visível na tela
  const len = Math.max(track.hw[0] * 1.3, 26 / scale);
  const head = Math.max(track.hw[0] * 0.45, 9 / scale);
  const x0 = x + tx * len * 0.15;
  const y0 = y + ty * len * 0.15;
  const x1 = x + tx * len;
  const y1 = y + ty * len;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(0.6, 3 / scale);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1 - tx * head * 0.6, y1 - ty * head * 0.6);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - tx * head - ty * head * 0.6, y1 - ty * head + tx * head * 0.6);
  ctx.lineTo(x1 - tx * head + ty * head * 0.6, y1 - ty * head - tx * head * 0.6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * Destaca trechos de curva muito fechada sobre a pista:
 * vermelho = mais fechada do que o carro consegue (ou borda dobrada),
 * amarelo = curva que exige frear bastante.
 */
export function drawTightCurves(ctx: CanvasRenderingContext2D, track: Track, scale: number): void {
  const N = track.n;
  const level = (i: number): 0 | 1 | 2 => {
    const k = Math.abs(track.curv[i]);
    if (k <= 0) return 0;
    const r = 1 / k;
    if (r < track.hw[i] * 1.08 || r < TRACK_LIMITS.minDrivableRadius) return 2;
    if (r < TRACK_LIMITS.tightRadiusWarning) return 1;
    return 0;
  };
  const red = new Path2D();
  const yellow = new Path2D();
  let any = false;
  for (let i = 0; i < N; i++) {
    const lv = level(i);
    if (!lv) continue;
    any = true;
    const j = (i + 1) % N;
    const p = lv === 2 ? red : yellow;
    p.moveTo(track.cx[i], track.cy[i]);
    p.lineTo(track.cx[j], track.cy[j]);
  }
  if (!any) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(2.5, 7 / scale);
  ctx.strokeStyle = 'rgba(252, 196, 25, 0.55)';
  ctx.stroke(yellow);
  ctx.strokeStyle = 'rgba(255, 82, 82, 0.7)';
  ctx.stroke(red);
  ctx.restore();
}

export function difficultyText(d: number | undefined): string {
  if (!d) return '';
  const v = Math.max(1, Math.min(5, Math.round(d)));
  return '★'.repeat(v) + '☆'.repeat(5 - v);
}

export function DifficultyBadge({ value }: { value: number | undefined }) {
  if (!value) return null;
  const v = Math.max(1, Math.min(5, Math.round(value)));
  const kind = v <= 2 ? 'ok' : v === 3 ? 'info' : 'warn';
  return (
    <span className={`badge ${kind}`} title={`Dificuldade ${v} de 5`} aria-label={`Dificuldade ${v} de 5`}>
      <span aria-hidden>{difficultyText(v)}</span>
    </span>
  );
}

export function fmtMeters(v: number, d = 0): string {
  return Number.isFinite(v) ? `${fmtNum(v, d)} m` : '—';
}

/** Linha curta com os números principais da pista (para os cartões). */
export function summaryLine(track: Track | null): string {
  if (!track) return 'Não foi possível montar esta pista.';
  const s = trackSummary(track);
  return `${fmtMeters(s.length)} · largura ${fmtNum(s.minWidth, 0)}–${fmtNum(s.maxWidth, 0)} m · raio mín. ${fmtMeters(s.minRadius)} · ${s.checkpoints} checkpoints`;
}

/** Quadro de estatísticas da pista. */
export function TrackStats({ track }: { track: Track }) {
  const s = trackSummary(track);
  return (
    <div className="stats-row">
      <Stat label="Comprimento" value={fmtMeters(s.length)} />
      <Stat label="Largura" value={`${fmtNum(s.minWidth, 1)}–${fmtNum(s.maxWidth, 1)} m`} sub="mínima – máxima" />
      <Stat
        label="Curva mais fechada"
        value={fmtMeters(s.minRadius, 1)}
        sub={s.minRadius < TRACK_LIMITS.tightRadiusWarning ? 'raio pequeno: exige frear' : 'raio mínimo'}
        title="Raio da curva mais fechada. Quanto menor, mais o carro precisa frear."
      />
      <Stat label="Checkpoints" value={s.checkpoints} sub="marcas de progresso" />
    </div>
  );
}
