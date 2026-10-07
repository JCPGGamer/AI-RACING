import { useEffect, useRef, useState } from 'react';

export interface Series {
  label: string;
  color: string;
  values: (number | null)[];
  dashed?: boolean;
}

/**
 * Gráfico de linhas simples em canvas (sem dependências).
 * Mostra valores ao passar o mouse e marcas verticais (mudanças de configuração).
 */
export function LineChart(props: {
  series: Series[];
  xStart?: number;
  height?: number;
  yFormat?: (v: number) => string;
  yMin?: number;
  yMax?: number;
  markers?: { x: number; label: string }[];
  ariaLabel: string;
  xLabel?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [size, setSize] = useState({ w: 600, h: props.height ?? 180 });
  const xStart = props.xStart ?? 1;
  const n = Math.max(0, ...props.series.map((s) => s.values.length));
  const fmt = props.yFormat ?? ((v: number) => v.toFixed(1));

  useEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight || props.height || 180 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [props.height]);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    const padL = 52;
    const padR = 10;
    const padT = 10;
    const padB = 24;
    const W = size.w - padL - padR;
    const H = size.h - padT - padB;
    let lo = props.yMin ?? Infinity;
    let hi = props.yMax ?? -Infinity;
    for (const s of props.series)
      for (const v of s.values) {
        if (v === null || !Number.isFinite(v)) continue;
        if (props.yMin === undefined) lo = Math.min(lo, v);
        if (props.yMax === undefined) hi = Math.max(hi, v);
      }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = 0;
      hi = 1;
    }
    if (hi - lo < 1e-9) {
      hi += 1;
      lo -= 1;
    }
    const span = hi - lo;
    if (props.yMin === undefined) lo -= span * 0.05;
    if (props.yMax === undefined) hi += span * 0.05;
    const xOf = (i: number) => padL + (n <= 1 ? W / 2 : (i / (n - 1)) * W);
    const yOf = (v: number) => padT + H - ((v - lo) / (hi - lo)) * H;
    const cs = getComputedStyle(document.documentElement);
    const grid = cs.getPropertyValue('--border').trim() || '#253244';
    const muted = cs.getPropertyValue('--faint').trim() || '#6c7a8b';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = muted;
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    for (let k = 0; k <= 4; k++) {
      const v = lo + ((hi - lo) * k) / 4;
      const y = yOf(v);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + W, y);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(fmt(v), padL - 6, y + 4);
    }
    ctx.textAlign = 'center';
    const ticks = Math.min(6, n);
    for (let k = 0; k < ticks; k++) {
      const i = ticks <= 1 ? 0 : Math.round((k / (ticks - 1)) * (n - 1));
      ctx.fillText(String(i + xStart), xOf(i), size.h - 6);
    }
    if (props.markers) {
      ctx.strokeStyle = 'rgba(177,151,252,0.6)';
      ctx.setLineDash([3, 3]);
      for (const m of props.markers) {
        const i = m.x - xStart;
        if (i < 0 || i >= n) continue;
        ctx.beginPath();
        ctx.moveTo(xOf(i), padT);
        ctx.lineTo(xOf(i), padT + H);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    for (const s of props.series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.setLineDash(s.dashed ? [5, 4] : []);
      ctx.beginPath();
      let started = false;
      // reduz pontos quando há muitas gerações
      const stride = Math.max(1, Math.floor(s.values.length / (W * 1.5)));
      for (let i = 0; i < s.values.length; i += stride) {
        const v = s.values[i];
        if (v === null || !Number.isFinite(v)) {
          started = false;
          continue;
        }
        if (!started) {
          ctx.moveTo(xOf(i), yOf(v));
          started = true;
        } else ctx.lineTo(xOf(i), yOf(v));
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (hover !== null && hover < n) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.moveTo(xOf(hover), padT);
      ctx.lineTo(xOf(hover), padT + H);
      ctx.stroke();
      for (const s of props.series) {
        const v = s.values[hover];
        if (v === null || v === undefined || !Number.isFinite(v)) continue;
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(xOf(hover), yOf(v), 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [props.series, props.markers, size, hover, n, xStart, props.yMin, props.yMax, fmt]);

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left - 52;
    const W = r.width - 62;
    if (n < 1) return;
    const i = Math.round((x / Math.max(1, W)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  return (
    <div className="chart-box" style={{ height: props.height ?? 180 }}>
      <canvas ref={ref} role="img" aria-label={props.ariaLabel} onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      <div className="row" style={{ position: 'absolute', top: 4, right: 10, gap: 12, fontSize: 12, pointerEvents: 'none' }}>
        {props.series.map((s) => (
          <span key={s.label} className="row" style={{ gap: 5 }}>
            <span style={{ width: 14, height: 0, borderTop: `2px ${s.dashed ? 'dashed' : 'solid'} ${s.color}`, display: 'inline-block' }} />
            <span className="muted">
              {s.label}
              {hover !== null && s.values[hover] !== null && s.values[hover] !== undefined && Number.isFinite(s.values[hover] as number) ? `: ${fmt(s.values[hover] as number)}` : ''}
            </span>
          </span>
        ))}
        {hover !== null && <span className="faint">{props.xLabel ?? 'Geração'} {hover + xStart}</span>}
      </div>
    </div>
  );
}
