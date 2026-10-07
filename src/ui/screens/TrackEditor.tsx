import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { audio } from '../../audio/audio.ts';
import { newId, type CustomTrackRecord } from '../../core/models.ts';
import type { Track, TrackDef, TrackPoint } from '../../core/track.ts';
import { TRACK_LIMITS, validateTrackDef, type TrackIssue } from '../../core/trackValidation.ts';
import { db } from '../../persistence/db.ts';
import { confirmDialog, fmtNum, Hint, Seg, Slider, Toggle } from '../components.tsx';
import { applyCamera, drawTrack, fitCamera, screenToWorld, THEME, type Camera } from '../render/draw.ts';
import { dataChanged, toast, useApp, setNavGuard } from '../store.ts';
import { ManualDriveModal } from './ManualDrive.tsx';
import { PilotTestModal } from './TrackPilotTest.tsx';
import {
  clampWidth,
  copyName,
  DEFAULT_POINT_WIDTH,
  findInsertIndex,
  insertPoint,
  makePoint,
  movePoint,
  NEW_TRACK_AREA,
  pointAfter,
  recordFor,
  removePoint,
  sameShape,
  setAllWidths,
  setPointWidth,
  shapeBounds,
  shapeToDef,
  type TrackShape,
} from './trackEditing.ts';
import { drawStartArrow, drawTightCurves, TrackStats, tryBuild } from './trackUi.tsx';

/**
 * Editor de pistas: o jogador marca pontos de controle da linha central
 * (em metros) e o jogo desenha uma curva suave por eles. A validação roda
 * sozinha (com um pequeno atraso) e aponta no mapa onde está cada problema.
 */

export type EditorTool = 'adicionar' | 'mover' | 'remover' | 'largada';

const TOOL_HINT: Record<EditorTool, string> = {
  adicionar: 'Clique no mapa para pôr um ponto. Perto de um trecho, o ponto entra no meio dele. Clique no primeiro ponto para fechar o circuito.',
  mover: 'Arraste um ponto para mudá-lo de lugar. Clique num ponto para escolhê-lo e ajustar a largura.',
  remover: 'Clique num ponto para removê-lo.',
  largada: 'Clique no ponto onde ficará a linha de largada e chegada. Prefira um ponto no meio de uma reta.',
};

const MAX_HISTORY = 200;
const MIN_SCALE = 0.05;
const MAX_SCALE = 30;
const GRID = 50;
/** Problemas que fazem sentido com o circuito ainda aberto. */
const OPEN_CODES = new Set(['aberto', 'poucos-pontos', 'muitos-pontos', 'ponto-invalido', 'largura', 'pontos-colados']);

// ---------- Histórico (desfazer/refazer) ----------

interface History {
  past: TrackShape[];
  present: TrackShape;
  future: TrackShape[];
  key: string | null;
  at: number;
}

type HistAction = { type: 'apply'; next: TrackShape; key?: string; now: number } | { type: 'undo' } | { type: 'redo' };

function histReducer(h: History, a: HistAction): History {
  switch (a.type) {
    case 'apply': {
      // Arrastos e ajustes seguidos do mesmo controle viram um único passo de desfazer.
      const coalesce = !!a.key && a.key === h.key && (a.key.startsWith('drag:') || a.now - h.at < 1000);
      if (coalesce) return { ...h, present: a.next, future: [], at: a.now };
      return { past: [...h.past.slice(-(MAX_HISTORY - 1)), h.present], present: a.next, future: [], key: a.key ?? null, at: a.now };
    }
    case 'undo': {
      if (!h.past.length) return h;
      return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future], key: null, at: 0 };
    }
    case 'redo': {
      if (!h.future.length) return h;
      return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1), key: null, at: 0 };
    }
  }
}

function runValidation(def: TrackDef, closed: boolean): TrackIssue[] {
  const issues = validateTrackDef(def, { closed });
  return closed ? issues : issues.filter((i) => OPEN_CODES.has(i.code));
}

// ---------- Componente ----------

export interface TrackEditorProps {
  /** Dados da pista (id, nome, versão, datas). Os pontos vêm de `shape`. */
  def: TrackDef;
  shape: TrackShape;
  /** true se a pista já existe no navegador (salvar substitui). */
  saved: boolean;
  /** Aviso mostrado no topo do painel (ex.: pista simplificada). */
  note?: string;
  /** Sai do editor. `selectId` é a pista para mostrar na lista. */
  onExit: (selectId: string | null) => void;
}

interface Meta {
  id: string;
  savedVersion: number;
  createdAt?: number;
  description?: string;
  saved: boolean;
}

type Gesture =
  | { kind: 'point'; index: number; moved: boolean; sx: number; sy: number; key: string; offX: number; offY: number }
  | { kind: 'tap'; sx: number; sy: number; lx: number; ly: number; moved: boolean }
  | { kind: 'pinch'; d0: number; scale0: number; wx: number; wy: number };

let dragCounter = 0;

export function TrackEditor(props: TrackEditorProps) {
  const prefs = useApp((s) => s.prefs);
  const [hist, dispatch] = useReducer(histReducer, undefined, () => ({ past: [], present: props.shape, future: [], key: null, at: 0 }));
  const shape = hist.present;
  const [name, setName] = useState(props.def.name);
  const [meta, setMeta] = useState<Meta>({
    id: props.def.id,
    savedVersion: props.saved ? props.def.version : 0,
    createdAt: props.def.createdAt,
    description: props.def.description,
    saved: props.saved,
  });
  const [savedSnap, setSavedSnap] = useState<{ shape: TrackShape; name: string } | null>(props.saved ? { shape: props.shape, name: props.def.name } : null);
  const [tool, setTool] = useState<EditorTool>(props.shape.points.length ? 'mover' : 'adicionar');
  const [selectedRaw, setSelected] = useState<number | null>(null);
  const [validation, setValidation] = useState<{ shape: TrackShape; issues: TrackIssue[] } | null>(null);
  const [highlight, setHighlight] = useState<{ x: number; y: number; level: TrackIssue['level'] } | null>(null);
  const [saveErrors, setSaveErrors] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [modal, setModal] = useState<null | { kind: 'dirigir' | 'piloto'; def: TrackDef; track: Track }>(null);
  const [allWidth, setAllWidth] = useState(() => {
    const pts = props.shape.points;
    if (!pts.length) return DEFAULT_POINT_WIDTH;
    return Math.round((pts.reduce((a, p) => a + p.w, 0) / pts.length) * 2) / 2;
  });

  const n = shape.points.length;
  const selected = selectedRaw !== null && selectedRaw < n ? selectedRaw : null;

  // Definição usada para construir/validar (o nome não muda a geometria).
  const geomDef = useMemo(
    () => shapeToDef({ id: meta.id, name: 'pista', version: Math.max(1, meta.savedVersion), createdAt: meta.createdAt, description: meta.description }, shape),
    [shape, meta.id, meta.savedVersion, meta.createdAt, meta.description],
  );
  const built = useMemo(() => (shape.closed && n >= TRACK_LIMITS.minPoints ? tryBuild(geomDef, false) : null), [geomDef, shape.closed, n]);

  // Validação com atraso de 250 ms (não trava enquanto o jogador arrasta).
  useEffect(() => {
    const t = setTimeout(() => setValidation({ shape, issues: runValidation(geomDef, shape.closed) }), 250);
    return () => clearTimeout(t);
  }, [shape, geomDef]);
  const fresh = validation?.shape === shape;
  const issues = validation?.issues ?? [];
  const errorCount = issues.filter((i) => i.level === 'erro').length;
  const warnCount = issues.length - errorCount;

  const dirty = savedSnap ? !sameShape(savedSnap.shape, shape) || savedSnap.name !== name.trim() : n > 0;

  // ---------- refs para o canvas ----------
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const camRef = useRef<Camera>({ x: 0, y: 0, scale: 1 });
  const sizeRef = useRef({ w: 0, h: 0 });
  const fittedRef = useRef(false);
  const rafRef = useRef(0);
  const shapeRef = useRef(shape);
  shapeRef.current = shape;
  const hoverRef = useRef<{ x: number; y: number } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  const viewRef = useRef<EditorView>({ shape, built, issues, selected, tool, highlight, hover: null, dragging: false });
  viewRef.current = { shape, built, issues, selected, tool, highlight, hover: hoverRef.current, dragging: false };

  const drawNow = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const { w, h } = sizeRef.current;
    if (w < 2 || h < 2) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    drawEditor(ctx, { ...viewRef.current, hover: hoverRef.current, dragging: gesture.current !== null }, camRef.current, w, h, dpr);
  }, []);

  const requestDraw = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      drawNow();
    });
  }, [drawNow]);

  const fit = useCallback(() => {
    const { w, h } = sizeRef.current;
    if (w < 2 || h < 2) return;
    const s = shapeRef.current;
    let b = shapeBounds(s) ?? { ...NEW_TRACK_AREA };
    // área mínima para não dar zoom exagerado com poucos pontos
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const hw = Math.max(90, (b.maxX - b.minX) / 2);
    const hh = Math.max(60, (b.maxY - b.minY) / 2);
    b = { minX: cx - hw, maxX: cx + hw, minY: cy - hh, maxY: cy + hh };
    camRef.current = fitCamera(b, w, h, 36);
    requestDraw();
  }, [requestDraw]);

  const zoomAt = useCallback(
    (sx: number, sy: number, f: number) => {
      const cam = camRef.current;
      const { w, h } = sizeRef.current;
      const before = screenToWorld(cam, w, h, sx, sy);
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, cam.scale * f));
      camRef.current = { x: before.x - (sx - w / 2) / scale, y: before.y - (sy - h / 2) / scale, scale };
      requestDraw();
    },
    [requestDraw],
  );

  // Tamanho do palco, roda do mouse (sem rolar a página) e limpeza.
  useEffect(() => {
    const stage = stageRef.current!;
    const c = canvasRef.current!;
    const ro = new ResizeObserver(() => {
      sizeRef.current = { w: stage.clientWidth, h: stage.clientHeight };
      if (!fittedRef.current && sizeRef.current.w > 2 && sizeRef.current.h > 2) {
        fittedRef.current = true;
        fit();
      }
      drawNow();
    });
    ro.observe(stage);
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = c.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      ro.disconnect();
      c.removeEventListener('wheel', onWheel);
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [drawNow, fit, zoomAt]);

  // Redesenha depois de cada mudança de estado.
  useEffect(() => {
    requestDraw();
  });

  // ---------- edição ----------
  const apply = useCallback((next: TrackShape, key?: string) => {
    shapeRef.current = next;
    dispatch({ type: 'apply', next, key, now: performance.now() });
    setHighlight(null);
    setSaveErrors(null);
  }, []);

  const undo = useCallback(() => {
    dispatch({ type: 'undo' });
    setHighlight(null);
  }, []);
  const redo = useCallback(() => {
    dispatch({ type: 'redo' });
    setHighlight(null);
  }, []);

  const newPointWidth = () => {
    const pts = shapeRef.current.points;
    if (selected !== null && pts[selected]) return pts[selected].w;
    if (pts.length) return pts[pts.length - 1].w;
    return allWidth;
  };

  const addPointAt = (x: number, y: number) => {
    const s = shapeRef.current;
    if (s.points.length >= TRACK_LIMITS.maxPoints) {
      toast(`A pista já tem o máximo de ${TRACK_LIMITS.maxPoints} pontos.`, 'aviso');
      return;
    }
    const scale = camRef.current.scale;
    const idx = findInsertIndex(s, x, y, 14 / scale);
    const at = idx >= 0 ? idx : s.points.length;
    apply(insertPoint(s, at, makePoint(x, y, newPointWidth())));
    setSelected(at);
  };

  const removeAt = (index: number) => {
    const s = shapeRef.current;
    if (index < 0 || index >= s.points.length) return;
    apply(removePoint(s, index));
    setSelected(null);
  };

  const setStart = (index: number) => {
    const s = shapeRef.current;
    if (index < 0 || index >= s.points.length || s.startIndex === index) return;
    apply({ ...s, startIndex: index });
    toast(`A largada agora fica no ponto ${index + 1}.`, 'info', 2500);
  };

  const closeCircuit = (v: boolean) => {
    const s = shapeRef.current;
    if (v && s.points.length < 3) return;
    apply({ ...s, closed: v });
  };

  // ---------- ponteiro (mouse, caneta e toque) ----------
  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const toWorld = (p: { x: number; y: number }) => screenToWorld(camRef.current, sizeRef.current.w, sizeRef.current.h, p.x, p.y);
  const hitTest = (sx: number, sy: number, radius: number): number => {
    const cam = camRef.current;
    const { w, h } = sizeRef.current;
    const pts = shapeRef.current.points;
    let best = -1;
    let bestD = radius * radius;
    for (let i = 0; i < pts.length; i++) {
      const px = (pts[i].x - cam.x) * cam.scale + w / 2;
      const py = (pts[i].y - cam.y) * cam.scale + h / 2;
      const d = (px - sx) * (px - sx) + (py - sy) * (py - sy);
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };
  const hitRadius = (e: ReactPointerEvent) => (e.pointerType === 'touch' ? 22 : 13);

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const c = canvasRef.current!;
    c.focus({ preventScroll: true });
    try {
      c.setPointerCapture(e.pointerId);
    } catch {
      /* ponteiro já liberado */
    }
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 2) {
      // Pinça: zoom e deslocamento com dois dedos.
      const [a, b] = [...pointers.current.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const wm = toWorld(mid);
      gesture.current = { kind: 'pinch', d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), scale0: camRef.current.scale, wx: wm.x, wy: wm.y };
      return;
    }
    if (pointers.current.size > 2) return;
    if (e.pointerType === 'mouse' && e.button !== 0) {
      gesture.current = { kind: 'tap', sx: p.x, sy: p.y, lx: p.x, ly: p.y, moved: true };
      return;
    }
    const hit = hitTest(p.x, p.y, hitRadius(e));
    if (hit >= 0 && (tool === 'mover' || tool === 'adicionar')) {
      setSelected(hit);
      const pt = shapeRef.current.points[hit];
      const wp = toWorld(p);
      gesture.current = { kind: 'point', index: hit, moved: false, sx: p.x, sy: p.y, key: `drag:${++dragCounter}`, offX: pt.x - wp.x, offY: pt.y - wp.y };
    } else {
      gesture.current = { kind: 'tap', sx: p.x, sy: p.y, lx: p.x, ly: p.y, moved: false };
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const p = local(e);
    if (e.pointerType !== 'touch') {
      hoverRef.current = toWorld(p);
      requestDraw();
    }
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pinch') {
      if (pointers.current.size < 2) return;
      const [a, b] = [...pointers.current.values()];
      const d = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, (g.scale0 * d) / g.d0));
      const { w, h } = sizeRef.current;
      camRef.current = { x: g.wx - (mid.x - w / 2) / scale, y: g.wy - (mid.y - h / 2) / scale, scale };
      requestDraw();
      return;
    }
    if (g.kind === 'point') {
      if (!g.moved && Math.hypot(p.x - g.sx, p.y - g.sy) < 3) return;
      g.moved = true;
      const wp = toWorld(p);
      const s = shapeRef.current;
      if (g.index < s.points.length) apply(movePoint(s, g.index, wp.x + g.offX, wp.y + g.offY), g.key);
      return;
    }
    if (!g.moved && Math.hypot(p.x - g.sx, p.y - g.sy) > 5) g.moved = true;
    if (g.moved) {
      const cam = camRef.current;
      camRef.current = { ...cam, x: cam.x - (p.x - g.lx) / cam.scale, y: cam.y - (p.y - g.ly) / cam.scale };
      g.lx = p.x;
      g.ly = p.y;
      requestDraw();
    }
  };

  const endPointer = (e: ReactPointerEvent<HTMLCanvasElement>, act: boolean) => {
    const g = gesture.current;
    const had = pointers.current.delete(e.pointerId);
    if (!had) return;
    if (g?.kind === 'pinch') {
      if (pointers.current.size === 1) {
        const [rest] = [...pointers.current.values()];
        gesture.current = { kind: 'tap', sx: rest.x, sy: rest.y, lx: rest.x, ly: rest.y, moved: true };
      } else if (pointers.current.size === 0) {
        gesture.current = null;
      }
      return;
    }
    if (pointers.current.size === 0) gesture.current = null;
    if (!act || !g) {
      requestDraw();
      return;
    }
    const p = local(e);
    if (g.kind === 'point' && !g.moved) {
      // Clique num ponto: no modo Adicionar, clicar no primeiro ponto fecha o circuito.
      const s = shapeRef.current;
      if (tool === 'adicionar' && g.index === 0 && !s.closed && s.points.length >= 3) {
        closeCircuit(true);
        toast('Circuito fechado!', 'sucesso', 2500);
      }
    } else if (g.kind === 'tap' && !g.moved) {
      const hit = hitTest(p.x, p.y, hitRadius(e));
      const wp = toWorld(p);
      if (tool === 'adicionar') addPointAt(wp.x, wp.y);
      else if (tool === 'remover') {
        if (hit >= 0) removeAt(hit);
      } else if (tool === 'largada') {
        if (hit >= 0) setStart(hit);
      } else if (tool === 'mover' && hit < 0) setSelected(null);
    }
    requestDraw();
  };

  // ---------- teclado ----------
  const onCanvasKey = (e: ReactKeyboardEvent<HTMLCanvasElement>) => {
    const { w, h } = sizeRef.current;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const dir = arrows[e.key];
    if (dir) {
      e.preventDefault();
      const s = shapeRef.current;
      if (selected !== null && s.points[selected]) {
        const step = e.shiftKey ? 10 : 1;
        const pt = s.points[selected];
        apply(movePoint(s, selected, pt.x + dir[0] * step, pt.y + dir[1] * step), `nudge:${selected}`);
      } else {
        const cam = camRef.current;
        camRef.current = { ...cam, x: cam.x + (dir[0] * 60) / cam.scale, y: cam.y + (dir[1] * 60) / cam.scale };
        requestDraw();
      }
      return;
    }
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomAt(w / 2, h / 2, 1.25);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      zoomAt(w / 2, h / 2, 1 / 1.25);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected !== null) {
      e.preventDefault();
      removeAt(selected);
    } else if (e.key === '.' && n) {
      e.preventDefault();
      setSelected(selected === null ? 0 : (selected + 1) % n);
    } else if (e.key === ',' && n) {
      e.preventDefault();
      setSelected(selected === null ? n - 1 : (selected - 1 + n) % n);
    } else if (e.key === 'Escape' && selected !== null) {
      e.preventDefault();
      setSelected(null);
    }
  };

  // Atalhos globais: Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range'))) return;
      if (document.querySelector('.modal-backdrop')) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  // Aviso do navegador ao fechar a aba com alterações não salvas.
  useEffect(() => {
    if (!dirty) return;
    const onBefore = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBefore);
    // Também avisa ao trocar de área pelo menu do jogo.
    setNavGuard(() => 'A pista tem alterações não salvas. Se sair agora, elas serão perdidas.');
    return () => {
      window.removeEventListener('beforeunload', onBefore);
      setNavGuard(null);
    };
  }, [dirty]);

  // ---------- problemas ----------
  const focusIssue = (it: TrackIssue) => {
    audio.click();
    if (!it.at) return;
    const { w, h } = sizeRef.current;
    const cam = camRef.current;
    camRef.current = { x: it.at.x, y: it.at.y, scale: Math.min(MAX_SCALE, Math.max(cam.scale, Math.min(w, h) / 160)) };
    setHighlight({ x: it.at.x, y: it.at.y, level: it.level });
    const r = stageRef.current?.getBoundingClientRect();
    if (r && (r.top < 0 || r.bottom > window.innerHeight)) stageRef.current?.scrollIntoView({ block: 'center', behavior: prefs.reduceMotion ? 'auto' : 'smooth' });
    requestDraw();
  };

  // ---------- salvar ----------
  const currentDef = (): TrackDef => shapeToDef({ id: meta.id, name: name.trim() || 'Pista sem nome', version: Math.max(1, meta.savedVersion), createdAt: meta.createdAt, description: meta.description }, shapeRef.current);

  const save = async (asCopy: boolean) => {
    const s = shapeRef.current;
    const nm = (name.trim() || 'Pista sem nome').slice(0, 60);
    const now = Date.now();
    const def = asCopy
      ? shapeToDef({ id: newId('pista'), name: copyName(nm), version: 1, description: meta.description, createdAt: now, updatedAt: now }, s)
      : shapeToDef({ id: meta.id, name: nm, version: meta.savedVersion + 1, description: meta.description, createdAt: meta.createdAt ?? now, updatedAt: now }, s);
    const found = runValidation(def, s.closed);
    setValidation({ shape: s, issues: found });
    const errs = found.filter((i) => i.level === 'erro');
    if (errs.length) {
      setSaveErrors(errs.map((i) => i.message));
      audio.error();
      toast('Ainda não dá para salvar: corrija os erros indicados no painel.', 'erro');
      return;
    }
    setSaveErrors(null);
    setSaving(true);
    try {
      await db.put<CustomTrackRecord>('tracks', recordFor(def));
      dataChanged();
      setMeta({ id: def.id, savedVersion: def.version, createdAt: def.createdAt, description: def.description, saved: true });
      setName(def.name);
      setSavedSnap({ shape: s, name: def.name });
      audio.approved();
      toast(asCopy ? `Cópia salva como "${def.name}". Agora você está editando a cópia.` : `Pista "${def.name}" salva (versão ${def.version}).`, 'sucesso');
    } catch (e) {
      audio.error();
      toast((e as Error).message, 'erro', 7000);
    } finally {
      setSaving(false);
    }
  };

  const exit = async () => {
    audio.click();
    if (dirty) {
      const ok = await confirmDialog('Sair do editor?', 'Há alterações que ainda não foram salvas. Se sair agora, elas serão perdidas.', 'Sair sem salvar');
      if (!ok) return;
    }
    props.onExit(meta.saved ? meta.id : null);
  };

  const openTest = (kind: 'dirigir' | 'piloto') => {
    audio.click();
    const def = currentDef();
    const track = tryBuild(def, false);
    if (!track) {
      toast('Feche o circuito e corrija a geometria antes de testar.', 'aviso');
      return;
    }
    setModal({ kind, def, track });
  };

  // ---------- interface ----------
  const sel = selected !== null ? shape.points[selected] : null;
  const canTest = !!built;
  const cursor = tool === 'adicionar' ? 'crosshair' : tool === 'mover' ? 'grab' : 'pointer';

  return (
    <div className="page-wide" style={{ height: 'auto' }}>
      <div className="spread" style={{ marginBottom: 10 }}>
        <div className="row">
          <button className="btn ghost" onClick={() => void exit()}>
            ← Voltar às pistas
          </button>
          <h2 style={{ margin: 0 }}>Editor de pistas</h2>
          {!meta.saved ? <span className="badge warn">Ainda não salva</span> : dirty ? <span className="badge warn">Alterações não salvas</span> : <span className="badge ok">Salva</span>}
        </div>
        <div className="btn-row">
          <button className="btn" onClick={undo} disabled={!hist.past.length} title="Desfazer (Ctrl+Z)">
            ↶ Desfazer
          </button>
          <button className="btn" onClick={redo} disabled={!hist.future.length} title="Refazer (Ctrl+Y)">
            ↷ Refazer
          </button>
          <button className="btn primary" onClick={() => void save(false)} disabled={saving}>
            💾 Salvar
          </button>
        </div>
      </div>
      <div className="editor">
        <div className="lab-stage" ref={stageRef}>
          <canvas
            ref={canvasRef}
            className="stage-canvas"
            tabIndex={0}
            role="application"
            aria-roledescription="editor de pista"
            aria-label="Mapa do editor. Com o mapa em foco: setas movem o ponto escolhido (Shift move 10 metros) ou a vista; vírgula e ponto trocam de ponto; + e − mudam o zoom; Delete remove o ponto."
            style={{ cursor }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={(e) => endPointer(e, true)}
            onPointerCancel={(e) => endPointer(e, false)}
            onPointerLeave={(e) => {
              if (e.pointerType !== 'touch') {
                hoverRef.current = null;
                requestDraw();
              }
            }}
            onKeyDown={onCanvasKey}
            onContextMenu={(e) => e.preventDefault()}
          />
          <div className="hud">
            <span className="chip">
              {n} {n === 1 ? 'ponto' : 'pontos'}
            </span>
            <span className="chip">{shape.closed ? 'Circuito fechado' : 'Circuito aberto'}</span>
            {built && <span className="chip">{fmtNum(built.length, 0)} m</span>}
            {shape.reverse && <span className="chip">Sentido invertido</span>}
          </div>
          <div className="stage-tools">
            <button className="btn small icon" aria-label="Aproximar" title="Aproximar" onClick={() => zoomAt(sizeRef.current.w / 2, sizeRef.current.h / 2, 1.3)}>
              ＋
            </button>
            <button className="btn small icon" aria-label="Afastar" title="Afastar" onClick={() => zoomAt(sizeRef.current.w / 2, sizeRef.current.h / 2, 1 / 1.3)}>
              －
            </button>
            <button className="btn small" onClick={fit} title="Mostrar a pista inteira">
              Enquadrar
            </button>
          </div>
          <div className="legend">
            <span>Grade: quadrados de {GRID} m</span>
            <span>Arraste o fundo para mover a vista · roda do mouse ou pinça: zoom</span>
          </div>
        </div>

        <aside className="panel" style={{ overflow: 'auto', minHeight: 0 }} aria-label="Ferramentas do editor">
          <div className="stack">
            {props.note && <div className="callout">{props.note}</div>}
            <label className="field">
              <span className="field-label">Nome da pista</span>
              <input type="text" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Circuito da Praia" />
            </label>

            <div className="field">
              <span className="field-label">
                <span className="row" style={{ gap: 6 }}>
                  Ferramenta
                  <Hint text="Escolha o que um clique no mapa faz. Em qualquer ferramenta, arrastar o fundo move a vista." />
                </span>
              </span>
              <Seg
                ariaLabel="Ferramenta do editor"
                value={tool}
                onChange={setTool}
                options={[
                  { value: 'adicionar', label: '＋ Adicionar', title: 'Adicionar pontos' },
                  { value: 'mover', label: '✥ Mover', title: 'Arrastar pontos' },
                  { value: 'remover', label: '✕ Remover', title: 'Remover pontos' },
                  { value: 'largada', label: '🏁 Largada', title: 'Escolher o ponto da largada' },
                ]}
              />
              <span className="field-hint">{TOOL_HINT[tool]}</span>
            </div>

            <Toggle
              label="Fechar circuito"
              checked={shape.closed}
              disabled={n < 3}
              onChange={closeCircuit}
              description={n < 3 ? 'Coloque pelo menos 3 pontos para poder fechar.' : 'Liga o último ponto ao primeiro. A pista só pode ser salva fechada e com 4 pontos ou mais.'}
            />
            <Toggle label="Inverter sentido" checked={shape.reverse} disabled={n < 2} onChange={(v) => apply({ ...shapeRef.current, reverse: v })} description="Os carros correm no sentido contrário." />

            <div className="panel tight" style={{ background: 'var(--panel-2)' }}>
              {sel && selected !== null ? (
                <div className="stack">
                  <div className="spread">
                    <strong>
                      Ponto {selected + 1} de {n}
                    </strong>
                    {selected === shape.startIndex && <span className="badge info">🏁 Largada</span>}
                  </div>
                  <div className="btn-row">
                    <button className="btn small" onClick={() => setSelected((selected - 1 + n) % n)} aria-label="Ponto anterior">
                      ◀ Anterior
                    </button>
                    <button className="btn small" onClick={() => setSelected((selected + 1) % n)} aria-label="Próximo ponto">
                      Próximo ▶
                    </button>
                  </div>
                  <Slider
                    label="Largura deste ponto"
                    value={sel.w}
                    min={TRACK_LIMITS.minWidth}
                    max={TRACK_LIMITS.maxWidth}
                    step={0.5}
                    format={(v) => `${fmtNum(v, 1)} m`}
                    onChange={(v) => apply(setPointWidth(shapeRef.current, selected, v), `w:${selected}`)}
                  />
                  <div className="btn-row">
                    <button
                      className="btn small"
                      disabled={n >= TRACK_LIMITS.maxPoints}
                      onClick={() => {
                        const r = pointAfter(shapeRef.current, selected);
                        if (!r) return;
                        apply(insertPoint(shapeRef.current, r.at, r.p));
                        setSelected(r.at);
                      }}
                    >
                      ＋ Ponto depois
                    </button>
                    <button className="btn small" disabled={selected === shape.startIndex} onClick={() => setStart(selected)}>
                      🏁 Usar como largada
                    </button>
                    <button className="btn small danger" onClick={() => removeAt(selected)}>
                      Remover
                    </button>
                  </div>
                  <span className="field-hint">
                    Posição: x {fmtNum(sel.x, 1)} m, y {fmtNum(sel.y, 1)} m. Com o mapa em foco, as setas movem o ponto (Shift = 10 m).
                  </span>
                </div>
              ) : (
                <div className="stack">
                  <span className="muted">Nenhum ponto escolhido. Clique num ponto do mapa para ajustar a largura dele.</span>
                  {n > 0 && (
                    <button className="btn small" onClick={() => setSelected(0)}>
                      Escolher o primeiro ponto
                    </button>
                  )}
                </div>
              )}
            </div>

            <Slider
              label="Largura de todos os pontos"
              value={allWidth}
              min={TRACK_LIMITS.minWidth}
              max={TRACK_LIMITS.maxWidth}
              step={0.5}
              format={(v) => `${fmtNum(v, 1)} m`}
              hint="Muda a largura da pista inteira de uma vez. Pontos novos também usam essa largura quando nenhum ponto está escolhido."
              onChange={(v) => {
                const w = clampWidth(v);
                setAllWidth(w);
                if (shapeRef.current.points.length) apply(setAllWidths(shapeRef.current, w), 'wall');
              }}
            />

            <div className="divider" />
            <div className="panel-title" style={{ marginBottom: 0 }}>
              <h3>Verificação</h3>
              {!fresh ? (
                <span className="badge">Verificando…</span>
              ) : errorCount ? (
                <span className="badge err">
                  {errorCount} {errorCount === 1 ? 'erro' : 'erros'}
                </span>
              ) : warnCount ? (
                <span className="badge warn">
                  {warnCount} {warnCount === 1 ? 'aviso' : 'avisos'}
                </span>
              ) : (
                <span className="badge ok">Tudo certo</span>
              )}
            </div>
            {!shape.closed && n >= 3 && <span className="field-hint">Feche o circuito para a verificação completa (curvas, cruzamentos e comprimento).</span>}
            {issues.length > 0 && (
              <div className="stack" style={{ gap: 6 }} aria-live="polite">
                {issues.map((it, i) => (
                  <button
                    key={`${it.code}-${i}`}
                    type="button"
                    className={`issue${it.level === 'erro' ? ' erro' : ''}`}
                    style={{ width: '100%', textAlign: 'left', borderTop: 0, borderRight: 0, borderBottom: 0, cursor: it.at ? 'pointer' : 'default' }}
                    onClick={() => focusIssue(it)}
                  >
                    <strong>
                      {it.level === 'erro' ? '⛔ Erro: ' : '⚠ Aviso: '}
                      {it.message}
                    </strong>
                    <span className="muted" style={{ display: 'block' }}>
                      {it.fix}
                    </span>
                    {it.at && (
                      <span className="faint" style={{ display: 'block', fontSize: '0.85em' }}>
                        Clique para ver no mapa.
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
            {built && (
              <span className="field-hint">
                No mapa, trechos <span style={{ color: 'var(--warn)' }}>amarelos</span> são curvas que exigem frear bastante e trechos{' '}
                <span style={{ color: 'var(--err)' }}>vermelhos</span> são fechados demais.
              </span>
            )}
            <div className="callout warn">
              A validação confere a geometria, mas não garante que a pista seja fácil de dirigir. Use 'Testar dirigindo' ou treine um piloto para conferir.
            </div>
            {built && <TrackStats track={built} />}

            {saveErrors && (
              <div className="callout err" role="alert">
                <strong>Ainda não dá para salvar.</strong> Corrija:
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {saveErrors.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="divider" />
            <div className="btn-row">
              <button className="btn primary" onClick={() => void save(false)} disabled={saving}>
                💾 Salvar
              </button>
              <button className="btn" onClick={() => void save(true)} disabled={saving} title="Salva as alterações como uma pista nova e continua editando a cópia">
                Salvar como cópia
              </button>
            </div>
            <div className="btn-row">
              <button className="btn" onClick={() => openTest('dirigir')} disabled={!canTest} title={canTest ? 'Dirija você mesmo nesta pista' : 'Feche o circuito para testar'}>
                🎮 Testar dirigindo
              </button>
              <button className="btn" onClick={() => openTest('piloto')} disabled={!canTest} title={canTest ? 'Veja um piloto da Garagem correr aqui' : 'Feche o circuito para testar'}>
                🧠 Testar com um piloto
              </button>
            </div>
            {!canTest && <span className="field-hint">Os testes ficam disponíveis quando o circuito estiver fechado e com pelo menos 4 pontos.</span>}
            <div className="btn-row">
              <button
                className="btn small ghost"
                disabled={!n}
                onClick={() => {
                  apply({ points: [], closed: false, startIndex: 0, reverse: shapeRef.current.reverse });
                  setSelected(null);
                  setTool('adicionar');
                  toast('Pontos apagados. Use "Desfazer" se quiser voltar.', 'info', 3000);
                }}
              >
                🗑 Apagar todos os pontos
              </button>
            </div>
            <p className="field-hint" style={{ margin: 0 }}>
              Atalhos: <span className="kbd">Ctrl</span>+<span className="kbd">Z</span> desfaz, <span className="kbd">Ctrl</span>+<span className="kbd">Y</span> refaz.
            </p>
          </div>
        </aside>
      </div>
      {modal?.kind === 'dirigir' && <ManualDriveModal track={modal.track} onClose={() => setModal(null)} />}
      {modal?.kind === 'piloto' && <PilotTestModal def={modal.def} track={modal.track} onClose={() => setModal(null)} />}
    </div>
  );
}

// ---------- Desenho ----------

interface EditorView {
  shape: TrackShape;
  built: Track | null;
  issues: TrackIssue[];
  selected: number | null;
  tool: EditorTool;
  highlight: { x: number; y: number; level: TrackIssue['level'] } | null;
  hover: { x: number; y: number } | null;
  dragging: boolean;
}

/** Curva suave de pré-visualização (Catmull–Rom centrípeta), aberta ou fechada. */
function previewCurve(pts: TrackPoint[], closed: boolean): TrackPoint[] {
  const n = pts.length;
  if (n < 2) return pts.slice();
  const get = (i: number): TrackPoint => {
    if (closed) return pts[((i % n) + n) % n];
    if (i < 0) return { x: 2 * pts[0].x - pts[1].x, y: 2 * pts[0].y - pts[1].y, w: pts[0].w };
    if (i >= n) return { x: 2 * pts[n - 1].x - pts[n - 2].x, y: 2 * pts[n - 1].y - pts[n - 2].y, w: pts[n - 1].w };
    return pts[i];
  };
  const knot = (a: TrackPoint, b: TrackPoint) => Math.max(1e-4, Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)));
  const out: TrackPoint[] = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1);
    const p1 = get(i);
    const p2 = get(i + 1);
    const p3 = get(i + 2);
    const t1 = knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    const steps = Math.min(60, Math.max(2, Math.ceil(Math.hypot(p2.x - p1.x, p2.y - p1.y) / 3)));
    for (let k = 0; k < steps; k++) {
      const u = k / steps;
      const t = t1 + (t2 - t1) * u;
      const a1x = ((t1 - t) / t1) * p0.x + (t / t1) * p1.x;
      const a1y = ((t1 - t) / t1) * p0.y + (t / t1) * p1.y;
      const a2x = ((t2 - t) / (t2 - t1)) * p1.x + ((t - t1) / (t2 - t1)) * p2.x;
      const a2y = ((t2 - t) / (t2 - t1)) * p1.y + ((t - t1) / (t2 - t1)) * p2.y;
      const a3x = ((t3 - t) / (t3 - t2)) * p2.x + ((t - t2) / (t3 - t2)) * p3.x;
      const a3y = ((t3 - t) / (t3 - t2)) * p2.y + ((t - t2) / (t3 - t2)) * p3.y;
      const b1x = ((t2 - t) / t2) * a1x + (t / t2) * a2x;
      const b1y = ((t2 - t) / t2) * a1y + (t / t2) * a2y;
      const b2x = ((t3 - t) / (t3 - t1)) * a2x + ((t - t1) / (t3 - t1)) * a3x;
      const b2y = ((t3 - t) / (t3 - t1)) * a2y + ((t - t1) / (t3 - t1)) * a3y;
      const sm = u * u * (3 - 2 * u);
      out.push({
        x: ((t2 - t) / (t2 - t1)) * b1x + ((t - t1) / (t2 - t1)) * b2x,
        y: ((t2 - t) / (t2 - t1)) * b1y + ((t - t1) / (t2 - t1)) * b2y,
        w: p1.w + (p2.w - p1.w) * sm,
      });
    }
  }
  if (!closed) out.push(pts[n - 1]);
  return out;
}

function drawGrid(ctx: CanvasRenderingContext2D, cam: Camera, w: number, h: number): void {
  const x0 = cam.x - w / 2 / cam.scale;
  const x1 = cam.x + w / 2 / cam.scale;
  const y0 = cam.y - h / 2 / cam.scale;
  const y1 = cam.y + h / 2 / cam.scale;
  const lw = 1 / cam.scale;
  const drawLines = (step: number, color: string) => {
    if (step * cam.scale < 6) return;
    ctx.beginPath();
    for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
    }
    for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.stroke();
  };
  drawLines(GRID, 'rgba(255,255,255,0.045)');
  drawLines(GRID * 5, 'rgba(255,255,255,0.09)');
}

function drawEditor(ctx: CanvasRenderingContext2D, v: EditorView, cam: Camera, w: number, h: number, dpr: number): void {
  const { shape, built } = v;
  const pts = shape.points;
  const n = pts.length;
  const scale = cam.scale;

  // 1) Fundo + pista construída (ou só a grama).
  if (built) {
    drawTrack(ctx, built, cam, w, h, dpr);
  } else {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = THEME.grass;
    ctx.fillRect(0, 0, w, h);
    applyCamera(ctx, cam, w, h, dpr);
  }
  drawGrid(ctx, cam, w, h);

  if (built) {
    drawTightCurves(ctx, built, scale);
    drawStartArrow(ctx, built, scale);
  } else if (n >= 2) {
    // 2) Faixa translúcida com a largura (pré-visualização da pista).
    const curve = previewCurve(pts, shape.closed && n >= 3);
    const groups = new Map<number, Path2D>();
    const segCount = shape.closed && n >= 3 ? curve.length : curve.length - 1;
    for (let i = 0; i < segCount; i++) {
      const a = curve[i];
      const b = curve[(i + 1) % curve.length];
      const key = Math.round((a.w + b.w) / 2);
      let p = groups.get(key);
      if (!p) {
        p = new Path2D();
        groups.set(key, p);
      }
      p.moveTo(a.x, a.y);
      p.lineTo(b.x, b.y);
    }
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(120, 132, 148, 0.4)';
    for (const [width, p] of groups) {
      ctx.lineWidth = width;
      ctx.stroke(p);
    }
    const center = new Path2D();
    curve.forEach((p, i) => (i === 0 ? center.moveTo(p.x, p.y) : center.lineTo(p.x, p.y)));
    if (shape.closed && n >= 3) center.closePath();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = Math.max(0.2, 1.5 / scale);
    ctx.setLineDash([6 / scale, 5 / scale]);
    ctx.stroke(center);
    ctx.setLineDash([]);
    ctx.restore();
  }

  // 3) Polígono de controle (linha fina ligando os pontos).
  if (n >= 2) {
    ctx.save();
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    if (shape.closed) ctx.closePath();
    ctx.strokeStyle = 'rgba(77, 171, 247, 0.55)';
    ctx.lineWidth = 1 / scale;
    ctx.setLineDash([4 / scale, 4 / scale]);
    ctx.stroke();
    ctx.restore();
  }

  // Daqui em diante, desenho em pixels da tela.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const sx = (x: number) => (x - cam.x) * scale + w / 2;
  const sy = (y: number) => (y - cam.y) * scale + h / 2;

  // 4) Seta do sentido quando a pista ainda não está construída.
  if (!built && n >= 2) {
    const si = Math.min(n - 1, shape.startIndex);
    const a = pts[si];
    let b: TrackPoint;
    let sign = shape.reverse ? -1 : 1;
    if (shape.closed) b = pts[(si + sign + n) % n];
    else if (si + sign >= 0 && si + sign < n) b = pts[si + sign];
    else {
      sign = -sign;
      b = pts[si + sign];
      // ponta solta: a seta aponta para fora da linha
      b = { x: 2 * a.x - b.x, y: 2 * a.y - b.y, w: a.w };
    }
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    drawArrowScreen(ctx, sx(a.x), sy(a.y), dx / l, dy / l, 34, '#ffd43b');
  }

  // 5) Pré-visualização da ferramenta sob o mouse.
  const hover = v.hover;
  let hoverHit = -1;
  if (hover && !v.dragging) {
    const hx = sx(hover.x);
    const hy = sy(hover.y);
    let best = 13 * 13;
    for (let i = 0; i < n; i++) {
      const d = (sx(pts[i].x) - hx) ** 2 + (sy(pts[i].y) - hy) ** 2;
      if (d <= best) {
        best = d;
        hoverHit = i;
      }
    }
    if (v.tool === 'adicionar' && hoverHit < 0) {
      ctx.save();
      ctx.strokeStyle = 'rgba(77, 171, 247, 0.85)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      const idx = findInsertIndex(shape, hover.x, hover.y, 14 / scale);
      ctx.beginPath();
      if (idx >= 0) {
        const a = pts[idx - 1];
        const b = pts[idx % n];
        ctx.moveTo(sx(a.x), sy(a.y));
        ctx.lineTo(hx, hy);
        ctx.lineTo(sx(b.x), sy(b.y));
      } else if (n >= 1) {
        const last = pts[n - 1];
        ctx.moveTo(sx(last.x), sy(last.y));
        ctx.lineTo(hx, hy);
        if (shape.closed && n >= 3) ctx.lineTo(sx(pts[0].x), sy(pts[0].y));
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(77, 171, 247, 0.5)';
      ctx.beginPath();
      ctx.arc(hx, hy, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // 6) Pontos de controle.
  const showNumbers = n <= 80 || scale > 1.2;
  ctx.save();
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < n; i++) {
    const x = sx(pts[i].x);
    const y = sy(pts[i].y);
    if (x < -30 || y < -30 || x > w + 30 || y > h + 30) continue;
    const isStart = i === shape.startIndex;
    const isSel = i === v.selected;
    const isHover = i === hoverHit;
    if (isSel) {
      ctx.strokeStyle = '#4dabf7';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, 12, 0, Math.PI * 2);
      ctx.stroke();
    }
    const r = isStart ? 8 : isSel || isHover ? 7 : 5.5;
    ctx.fillStyle = isStart ? '#ffd43b' : isHover && v.tool === 'remover' ? '#ff6b6b' : '#e9eef4';
    ctx.strokeStyle = '#0a0e13';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (isStart) {
      ctx.fillStyle = '#0a0e13';
      ctx.textAlign = 'center';
      ctx.fillText('L', x, y + 0.5);
    }
    if (isHover && v.tool === 'remover') {
      ctx.strokeStyle = '#ff6b6b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x - 12, y - 12);
      ctx.lineTo(x + 12, y + 12);
      ctx.moveTo(x - 12, y + 12);
      ctx.lineTo(x + 12, y - 12);
      ctx.stroke();
    }
    if (isHover && v.tool === 'adicionar' && i === 0 && !shape.closed && n >= 3) {
      label(ctx, 'Clique para fechar o circuito', x + 14, y - 16);
    } else if (isHover && v.tool === 'largada' && !isStart) {
      label(ctx, 'Largada aqui', x + 14, y - 16);
    }
    if (showNumbers) {
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(233, 238, 244, 0.75)';
      ctx.fillText(String(i + 1), x + 9, y - 9);
    }
  }
  ctx.restore();

  // 7) Marcas dos problemas encontrados pela validação.
  for (const it of v.issues) {
    if (!it.at) continue;
    const x = sx(it.at.x);
    const y = sy(it.at.y);
    const color = it.level === 'erro' ? '#ff6b6b' : '#fcc419';
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(x, y, 15, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x + 13, y - 13, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0a0e13';
    ctx.font = '800 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('!', x + 13, y - 12.5);
    ctx.restore();
  }

  // 8) Destaque do problema clicado na lista.
  if (v.highlight) {
    const x = sx(v.highlight.x);
    const y = sy(v.highlight.y);
    ctx.save();
    ctx.strokeStyle = v.highlight.level === 'erro' ? '#ff6b6b' : '#fcc419';
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.arc(x, y, 30, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x - 44, y);
    ctx.lineTo(x - 34, y);
    ctx.moveTo(x + 34, y);
    ctx.lineTo(x + 44, y);
    ctx.moveTo(x, y - 44);
    ctx.lineTo(x, y - 34);
    ctx.moveTo(x, y + 34);
    ctx.lineTo(x, y + 44);
    ctx.stroke();
    ctx.restore();
  }

  // 9) Dica quando ainda não há pontos.
  if (n === 0) {
    ctx.save();
    ctx.font = '600 15px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(233, 238, 244, 0.8)';
    ctx.fillText(v.tool === 'adicionar' ? 'Clique no mapa para colocar o primeiro ponto da pista' : 'Escolha a ferramenta "Adicionar" e clique no mapa', w / 2, h / 2);
    ctx.restore();
  }
}

function drawArrowScreen(ctx: CanvasRenderingContext2D, x: number, y: number, dx: number, dy: number, len: number, color: string): void {
  const ex = x + dx * len;
  const ey = y + dy * len;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x + dx * 10, y + dy * 10);
  ctx.lineTo(ex - dx * 6, ey - dy * 6);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ex - dx * 10 - dy * 6, ey - dy * 10 + dx * 6);
  ctx.lineTo(ex - dx * 10 + dy * 6, ey - dy * 10 - dx * 6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.save();
  ctx.font = '600 12px system-ui, sans-serif';
  const tw = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(10, 14, 19, 0.88)';
  ctx.fillRect(x - 4, y - 10, tw + 8, 20);
  ctx.fillStyle = '#e9eef4';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
  ctx.restore();
}
