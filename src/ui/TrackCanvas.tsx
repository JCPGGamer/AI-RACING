import { useEffect, useRef, type ReactNode } from 'react';
import type { Track } from '../core/track.ts';
import { drawTrack, fitCamera, screenToWorld, type Camera } from './render/draw.ts';
import { getState } from './store.ts';

export interface DrawInfo {
  ctx: CanvasRenderingContext2D;
  cam: Camera;
  w: number;
  h: number;
  dpr: number;
  now: number;
}

export type CameraMode = 'geral' | 'seguir';

/**
 * Palco com a pista e uma câmera 2D. Roda requestAnimationFrame só quando
 * `animate` é true (no modo de baixo consumo limita a ~30 quadros/s).
 * A simulação não depende desta taxa de quadros.
 */
export function TrackCanvas(props: {
  track: Track | null;
  animate?: boolean;
  cameraMode?: CameraMode;
  followTarget?: () => { x: number; y: number } | null;
  followScale?: number;
  onDraw?: (info: DrawInfo) => void;
  onClickWorld?: (x: number, y: number, e: React.PointerEvent) => void;
  onPointerWorld?: (kind: 'down' | 'move' | 'up', x: number, y: number, e: React.PointerEvent) => boolean | void;
  showCheckpoints?: boolean;
  showCenterline?: boolean;
  dimmed?: boolean;
  children?: ReactNode;
  ariaLabel: string;
  className?: string;
  /** Muda para forçar redesenho em telas estáticas */
  redrawKey?: unknown;
  /** Desativa arrastar para mover a câmera (ex.: editor usa o arrasto) */
  noPan?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const camRef = useRef<Camera>({ x: 0, y: 0, scale: 1 });
  const manual = useRef<{ dx: number; dy: number; zoom: number }>({ dx: 0, dy: 0, zoom: 1 });
  const sizeRef = useRef({ w: 300, h: 200 });
  const drag = useRef<{ x: number; y: number; moved: boolean; id: number; consumed: boolean } | null>(null);
  const drawNowRef = useRef<() => void>(() => {});

  useEffect(() => {
    manual.current = { dx: 0, dy: 0, zoom: 1 };
    drawNowRef.current();
  }, [props.track, props.cameraMode]);

  useEffect(() => {
    const c = ref.current!;
    const parent = c.parentElement!;
    let raf = 0;
    let last = 0;
    const computeCam = (): Camera => {
      const p = propsRef.current;
      const { w, h } = sizeRef.current;
      if (!p.track) return { x: 0, y: 0, scale: 1 };
      const fit = fitCamera(p.track.bounds, w, h, 18);
      let cam = fit;
      if (p.cameraMode === 'seguir') {
        const t = p.followTarget?.();
        const scale = (p.followScale ?? 7) * Math.min(1.4, Math.max(0.6, Math.min(w, h) / 500));
        if (t) cam = { x: t.x, y: t.y, scale: Math.max(scale, fit.scale) };
      }
      const m = manual.current;
      return { x: cam.x + m.dx, y: cam.y + m.dy, scale: cam.scale * m.zoom };
    };
    const draw = (now: number) => {
      const p = propsRef.current;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      const { w, h } = sizeRef.current;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      const cam = computeCam();
      camRef.current = cam;
      if (!p.track) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = '#0f141b';
        ctx.fillRect(0, 0, w, h);
        p.onDraw?.({ ctx, cam, w, h, dpr, now });
        return;
      }
      drawTrack(ctx, p.track, cam, w, h, dpr, { showCheckpoints: p.showCheckpoints, showCenterline: p.showCenterline, dimmed: p.dimmed });
      p.onDraw?.({ ctx, cam, w, h, dpr, now });
    };
    drawNowRef.current = () => draw(performance.now());
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const low = getState().prefs.lowPower;
      if (low && now - last < 32) return;
      last = now;
      if (propsRef.current.animate) draw(now);
    };
    // Zoom com Ctrl + roda (ou gesto de pinça no touchpad). Sem Ctrl, a página rola normalmente.
    const onWheel = (e: WheelEvent) => {
      if (!propsRef.current.track || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const cam = camRef.current;
      const sx = e.clientX - r.left - sizeRef.current.w / 2;
      const sy = e.clientY - r.top - sizeRef.current.h / 2;
      const before = { x: cam.x + sx / cam.scale, y: cam.y + sy / cam.scale };
      const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const z = Math.min(30, Math.max(0.3, manual.current.zoom * f));
      const applied = z / manual.current.zoom;
      manual.current.zoom = z;
      const newScale = cam.scale * applied;
      // mantém o ponto sob o mouse no mesmo lugar
      manual.current.dx += before.x - (cam.x + sx / newScale);
      manual.current.dy += before.y - (cam.y + sy / newScale);
      draw(performance.now());
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    const ro = new ResizeObserver(() => {
      sizeRef.current = { w: parent.clientWidth, h: parent.clientHeight };
      draw(performance.now());
    });
    ro.observe(parent);
    sizeRef.current = { w: parent.clientWidth, h: parent.clientHeight };
    raf = requestAnimationFrame(tick);
    draw(performance.now());
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      c.removeEventListener('wheel', onWheel);
    };
  }, []);

  useEffect(() => {
    if (!props.animate) drawNowRef.current();
  });

  const toWorld = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return screenToWorld(camRef.current, sizeRef.current.w, sizeRef.current.h, e.clientX - r.left, e.clientY - r.top);
  };

  return (
    <>
      <canvas
        ref={ref}
        className={props.className ?? 'stage-canvas'}
        role="img"
        aria-label={props.ariaLabel}
        onPointerDown={(e) => {
          const w = toWorld(e);
          const consumed = props.onPointerWorld?.('down', w.x, w.y, e) === true;
          drag.current = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId, consumed };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const w = toWorld(e);
          props.onPointerWorld?.('move', w.x, w.y, e);
          const d = drag.current;
          if (!d || d.id !== e.pointerId) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
          if (d.moved && !d.consumed && !props.noPan) {
            manual.current.dx -= dx / camRef.current.scale;
            manual.current.dy -= dy / camRef.current.scale;
            d.x = e.clientX;
            d.y = e.clientY;
            drawNowRef.current();
          }
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          const w = toWorld(e);
          props.onPointerWorld?.('up', w.x, w.y, e);
          if (d && !d.moved && !d.consumed) props.onClickWorld?.(w.x, w.y, e);
        }}
        onDoubleClick={() => {
          manual.current = { dx: 0, dy: 0, zoom: 1 };
          drawNowRef.current();
        }}
      />
      {props.children}
    </>
  );
}
