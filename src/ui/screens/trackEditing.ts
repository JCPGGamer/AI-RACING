import { newId, type CustomTrackRecord } from '../../core/models.ts';
import { closestOnSegment } from '../../core/geometry.ts';
import type { TrackDef, TrackPoint } from '../../core/track.ts';
import { TRACK_LIMITS } from '../../core/trackValidation.ts';

/**
 * Lógica pura do editor de pistas (sem React e sem DOM): simplificação de
 * pistas densas, criação de cópias, inserção/remoção de pontos e o registro
 * salvo no navegador.
 */

/** Largura padrão de um ponto novo (m). */
export const DEFAULT_POINT_WIDTH = 16;

/** Área vazia sugerida para uma pista nova (m). */
export const NEW_TRACK_AREA = { minX: -300, minY: -200, maxX: 300, maxY: 200 };

/** Forma editável da pista (o que entra no histórico de desfazer/refazer). */
export interface TrackShape {
  points: TrackPoint[];
  closed: boolean;
  startIndex: number;
  reverse: boolean;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

function clampCoord(v: number): number {
  const m = TRACK_LIMITS.maxCoord;
  return v > m ? m : v < -m ? -m : v;
}

export function clampWidth(w: number): number {
  return Math.min(TRACK_LIMITS.maxWidth, Math.max(TRACK_LIMITS.minWidth, w));
}

/** Ponto arredondado a 0,1 m e dentro dos limites do mapa. */
export function makePoint(x: number, y: number, w: number): TrackPoint {
  return { x: round1(clampCoord(x)), y: round1(clampCoord(y)), w: round1(clampWidth(w)) };
}

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
}

/**
 * Converte uma polilinha densa (pistas prontas usam um ponto a cada 1,5 m)
 * em poucos pontos de controle para a curva suave do editor:
 * um ponto a cada ~35 m nas retas, mais pontos nas curvas fechadas e sempre
 * um ponto onde uma curva começa ou termina. A largada vira o ponto 0.
 */
export function simplifyTrackPoints(def: TrackDef, opts: { maxSpacing?: number; minSpacing?: number; maxTurn?: number } = {}): TrackShape {
  const maxSpacing = opts.maxSpacing ?? 35;
  const minSpacing = opts.minSpacing ?? 6;
  const maxTurn = opts.maxTurn ?? 0.35;
  const src = def.points;
  const n = src.length;
  if (n < 4) {
    return { points: src.map((p) => makePoint(p.x, p.y, p.w)), closed: n >= 3, startIndex: 0, reverse: def.reverse };
  }
  const s0 = Math.min(n - 1, Math.max(0, Math.floor(def.startIndex || 0)));
  const ordered = [...src.slice(s0), ...src.slice(0, s0)];
  const heading = (a: TrackPoint, b: TrackPoint) => Math.atan2(b.y - a.y, b.x - a.x);
  const out: TrackPoint[] = [ordered[0]];
  let acc = 0;
  let turn = 0;
  let prevStraight = angleDiff(heading(ordered[0], ordered[1]), heading(ordered[n - 1], ordered[0])) < 2e-3;
  for (let i = 1; i < n; i++) {
    const a = ordered[i - 1];
    const b = ordered[i];
    const c = ordered[(i + 1) % n];
    acc += Math.hypot(b.x - a.x, b.y - a.y);
    const local = angleDiff(heading(b, c), heading(a, b));
    turn += local;
    const straight = local < 2e-3;
    const transition = straight !== prevStraight;
    prevStraight = straight;
    if (acc >= maxSpacing || (turn >= maxTurn && acc >= minSpacing) || (transition && acc >= minSpacing * 0.6)) {
      out.push(b);
      acc = 0;
      turn = 0;
    }
  }
  // O último ponto não pode ficar colado no primeiro (o circuito fecha sozinho).
  while (out.length > 4 && Math.hypot(out[out.length - 1].x - out[0].x, out[out.length - 1].y - out[0].y) < minSpacing) out.pop();
  return { points: out.map((p) => makePoint(p.x, p.y, p.w)), closed: true, startIndex: 0, reverse: def.reverse };
}

/** Forma editável de uma pista existente (simplifica se ela for densa). */
export function shapeFromDef(def: TrackDef): { shape: TrackShape; simplified: boolean } {
  if (def.smooth && def.points.length <= TRACK_LIMITS.maxPoints) {
    return {
      shape: {
        points: def.points.map((p) => ({ x: p.x, y: p.y, w: p.w })),
        closed: true,
        startIndex: Math.min(def.points.length - 1, Math.max(0, Math.floor(def.startIndex || 0))),
        reverse: def.reverse,
      },
      simplified: false,
    };
  }
  return { shape: simplifyTrackPoints(def), simplified: true };
}

export function emptyShape(): TrackShape {
  return { points: [], closed: false, startIndex: 0, reverse: false };
}

/** Definição completa a partir da forma editável. */
export function shapeToDef(base: Pick<TrackDef, 'id' | 'name' | 'version' | 'description' | 'createdAt' | 'updatedAt'>, shape: TrackShape): TrackDef {
  const n = shape.points.length;
  return {
    id: base.id,
    name: base.name,
    version: base.version,
    builtin: false,
    description: base.description,
    points: shape.points,
    smooth: true,
    startIndex: n ? Math.min(n - 1, Math.max(0, shape.startIndex)) : 0,
    reverse: shape.reverse,
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
  };
}

/** Nova pista vazia (ainda não salva). */
export function newTrackDef(name = 'Minha pista'): TrackDef {
  return { id: newId('pista'), name, version: 0, builtin: false, points: [], smooth: true, startIndex: 0, reverse: false };
}

/** Cópia exata (mesmos pontos), com outro identificador. */
export function duplicateDef(def: TrackDef, name: string): TrackDef {
  const now = Date.now();
  return {
    id: newId('pista'),
    name: name.slice(0, 60),
    version: 1,
    builtin: false,
    description: def.description,
    points: def.points.map((p) => ({ x: p.x, y: p.y, w: p.w })),
    smooth: def.smooth,
    startIndex: def.startIndex,
    reverse: def.reverse,
    createdAt: now,
    updatedAt: now,
  };
}

export function recordFor(def: TrackDef): CustomTrackRecord {
  const now = Date.now();
  return { id: def.id, def, createdAt: def.createdAt ?? now, updatedAt: def.updatedAt ?? now };
}

export function copyName(name: string): string {
  const base = name.replace(/ \(cópia( \d+)?\)$/, '');
  return `${base} (cópia)`.slice(0, 60);
}

/** Índice do ponto onde um ponto novo deve entrar, ou -1 se nenhum trecho estiver perto. */
export function findInsertIndex(shape: TrackShape, x: number, y: number, minDist: number): number {
  const pts = shape.points;
  const n = pts.length;
  if (n < 2) return -1;
  const tmp = { t: 0, d2: 0 };
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    let j = i + 1;
    if (j === n) {
      if (!shape.closed || n < 3) continue;
      j = 0;
    }
    const a = pts[i];
    const b = pts[j];
    closestOnSegment(x, y, a.x, a.y, b.x, b.y, tmp);
    const d = Math.sqrt(tmp.d2);
    const lim = Math.max(minDist, (a.w + b.w) / 4);
    // não conta cliques praticamente em cima das pontas (ali é o próprio ponto)
    if (d <= lim && tmp.t > 0.02 && tmp.t < 0.98 && d < bestD) {
      bestD = d;
      best = i + 1;
    }
  }
  return best;
}

export function insertPoint(shape: TrackShape, index: number, p: TrackPoint): TrackShape {
  const points = [...shape.points.slice(0, index), p, ...shape.points.slice(index)];
  const startIndex = shape.points.length === 0 ? 0 : index <= shape.startIndex ? shape.startIndex + 1 : shape.startIndex;
  return { ...shape, points, startIndex };
}

export function removePoint(shape: TrackShape, index: number): TrackShape {
  const points = shape.points.filter((_, i) => i !== index);
  let startIndex = shape.startIndex;
  if (index < startIndex) startIndex--;
  startIndex = Math.max(0, Math.min(points.length - 1, startIndex));
  return { ...shape, points, startIndex: points.length ? startIndex : 0, closed: points.length >= 3 ? shape.closed : false };
}

export function movePoint(shape: TrackShape, index: number, x: number, y: number): TrackShape {
  const points = shape.points.slice();
  points[index] = makePoint(x, y, points[index].w);
  return { ...shape, points };
}

export function setPointWidth(shape: TrackShape, index: number, w: number): TrackShape {
  const points = shape.points.slice();
  points[index] = { ...points[index], w: round1(clampWidth(w)) };
  return { ...shape, points };
}

export function setAllWidths(shape: TrackShape, w: number): TrackShape {
  const ww = round1(clampWidth(w));
  return { ...shape, points: shape.points.map((p) => ({ ...p, w: ww })) };
}

/** Ponto novo no meio do trecho entre `index` e o seguinte (ou depois do último, se aberto). */
export function pointAfter(shape: TrackShape, index: number): { at: number; p: TrackPoint } | null {
  const pts = shape.points;
  const n = pts.length;
  if (n === 0) return null;
  const a = pts[index];
  if (index === n - 1 && !shape.closed) {
    const prev = n >= 2 ? pts[n - 2] : null;
    const dx = prev ? a.x - prev.x : 40;
    const dy = prev ? a.y - prev.y : 0;
    const l = Math.hypot(dx, dy) || 1;
    return { at: n, p: makePoint(a.x + (dx / l) * 40, a.y + (dy / l) * 40, a.w) };
  }
  const b = pts[(index + 1) % n];
  return { at: index + 1, p: makePoint((a.x + b.x) / 2, (a.y + b.y) / 2, (a.w + b.w) / 2) };
}

export function shapeBounds(shape: TrackShape): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!shape.points.length) return null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of shape.points) {
    minX = Math.min(minX, p.x - p.w);
    maxX = Math.max(maxX, p.x + p.w);
    minY = Math.min(minY, p.y - p.w);
    maxY = Math.max(maxY, p.y + p.w);
  }
  return { minX, minY, maxX, maxY };
}

export function sameShape(a: TrackShape, b: TrackShape): boolean {
  if (a.closed !== b.closed || a.startIndex !== b.startIndex || a.reverse !== b.reverse || a.points.length !== b.points.length) return false;
  for (let i = 0; i < a.points.length; i++) {
    const p = a.points[i];
    const q = b.points[i];
    if (p.x !== q.x || p.y !== q.y || p.w !== q.w) return false;
  }
  return true;
}
