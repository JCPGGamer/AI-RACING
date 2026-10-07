import { buildGrid, closestOnSegment, type Bounds, type SegmentGrid } from './geometry.ts';
import { datan2 } from './dmath.ts';

/**
 * Pistas: definição (pontos de controle) → pista construída (amostras
 * uniformes da linha central, bordas, checkpoints, grade espacial).
 *
 * A amostra 0 fica exatamente na linha de chegada e o comprimento de arco
 * cresce no sentido de corrida. O carro nasce START_OFFSET metros depois da
 * linha, portanto só completa a volta depois de percorrer o circuito inteiro.
 */

export interface TrackPoint {
  x: number;
  y: number;
  /** largura total da pista neste ponto (m) */
  w: number;
}

export interface TrackDef {
  id: string;
  name: string;
  version: number;
  builtin?: boolean;
  description?: string;
  difficulty?: number;
  /** Pontos de controle de um circuito fechado (o último liga no primeiro). */
  points: TrackPoint[];
  /** true: curva suave (Catmull–Rom) pelos pontos; false: polilinha já densa. */
  smooth: boolean;
  /** Índice do ponto de controle onde fica a largada/chegada. */
  startIndex: number;
  /** Inverte o sentido de corrida. */
  reverse: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export interface Checkpoint {
  index: number;
  sample: number;
  s: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Tangente da pista no checkpoint (sentido de corrida) */
  tx: number;
  ty: number;
}

export interface Track {
  def: TrackDef;
  n: number;
  spacing: number;
  length: number;
  cx: Float64Array;
  cy: Float64Array;
  hw: Float64Array;
  tx: Float64Array;
  ty: Float64Array;
  nx: Float64Array;
  ny: Float64Array;
  s: Float64Array;
  /** Curvatura com sinal (1/m), suavizada */
  curv: Float64Array;
  /**
   * Meia largura "segura" perto de cada amostra: menor meia largura em ±4
   * amostras menos a folga das cordas da polilinha. Um ponto a menos que isso
   * do centro está garantidamente longe de qualquer borda.
   */
  safeHw: Float64Array;
  ax: Float64Array;
  ay: Float64Array;
  bx: Float64Array;
  by: Float64Array;
  grid: SegmentGrid;
  checkpoints: Checkpoint[];
  start: { x: number; y: number; heading: number; sample: number };
  /** Distância de corrida da posição de largada até a chegada */
  lapDistance: number;
  /** Tempo de referência (s) usado para normalizar penalidades: lapDistance / V_REF */
  refTime: number;
  bounds: Bounds;
  hash: string;
}

export const START_OFFSET = 6;
export const SAMPLE_SPACING = 2;
export const V_REF = 40;
export const CHECKPOINT_SPACING = 40;

/** Catmull–Rom centrípeta fechada. Devolve pontos densos e o índice denso de cada ponto de controle. */
function catmullRomClosed(pts: TrackPoint[]): { xs: number[]; ys: number[]; ws: number[]; ctrlIndex: number[] } {
  const n = pts.length;
  const xs: number[] = [];
  const ys: number[] = [];
  const ws: number[] = [];
  const ctrlIndex: number[] = [];
  const knot = (a: TrackPoint, b: TrackPoint) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return Math.max(1e-4, Math.sqrt(Math.sqrt(dx * dx + dy * dy)));
  };
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const t0 = 0;
    const t1 = t0 + knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    const segLen = Math.sqrt((p2.x - p1.x) * (p2.x - p1.x) + (p2.y - p1.y) * (p2.y - p1.y));
    const steps = Math.max(4, Math.ceil(segLen / 0.75));
    ctrlIndex.push(xs.length);
    for (let k = 0; k < steps; k++) {
      const u = k / steps;
      const t = t1 + (t2 - t1) * u;
      const a1x = ((t1 - t) / (t1 - t0)) * p0.x + ((t - t0) / (t1 - t0)) * p1.x;
      const a1y = ((t1 - t) / (t1 - t0)) * p0.y + ((t - t0) / (t1 - t0)) * p1.y;
      const a2x = ((t2 - t) / (t2 - t1)) * p1.x + ((t - t1) / (t2 - t1)) * p2.x;
      const a2y = ((t2 - t) / (t2 - t1)) * p1.y + ((t - t1) / (t2 - t1)) * p2.y;
      const a3x = ((t3 - t) / (t3 - t2)) * p2.x + ((t - t2) / (t3 - t2)) * p3.x;
      const a3y = ((t3 - t) / (t3 - t2)) * p2.y + ((t - t2) / (t3 - t2)) * p3.y;
      const b1x = ((t2 - t) / (t2 - t0)) * a1x + ((t - t0) / (t2 - t0)) * a2x;
      const b1y = ((t2 - t) / (t2 - t0)) * a1y + ((t - t0) / (t2 - t0)) * a2y;
      const b2x = ((t3 - t) / (t3 - t1)) * a2x + ((t - t1) / (t3 - t1)) * a3x;
      const b2y = ((t3 - t) / (t3 - t1)) * a2y + ((t - t1) / (t3 - t1)) * a3y;
      xs.push(((t2 - t) / (t2 - t1)) * b1x + ((t - t1) / (t2 - t1)) * b2x);
      ys.push(((t2 - t) / (t2 - t1)) * b1y + ((t - t1) / (t2 - t1)) * b2y);
      // largura com transição suave (smoothstep) entre pontos de controle
      const sm = u * u * (3 - 2 * u);
      ws.push(p1.w + (p2.w - p1.w) * sm);
    }
  }
  return { xs, ys, ws, ctrlIndex };
}

/** Reamostra uma polilinha fechada com espaçamento uniforme. */
function resampleClosed(
  xs: number[],
  ys: number[],
  ws: number[],
  spacingTarget: number,
): { X: Float64Array; Y: Float64Array; W: Float64Array; cum: number[]; total: number; spacing: number } {
  const m = xs.length;
  const cum: number[] = new Array(m + 1);
  cum[0] = 0;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    const dx = xs[j] - xs[i];
    const dy = ys[j] - ys[i];
    cum[i + 1] = cum[i] + Math.sqrt(dx * dx + dy * dy);
  }
  const total = cum[m];
  const N = Math.max(16, Math.round(total / spacingTarget));
  const spacing = total / N;
  const X = new Float64Array(N);
  const Y = new Float64Array(N);
  const W = new Float64Array(N);
  let seg = 0;
  for (let k = 0; k < N; k++) {
    const target = k * spacing;
    while (seg < m - 1 && cum[seg + 1] < target) seg++;
    const segLen = cum[seg + 1] - cum[seg];
    const u = segLen > 1e-12 ? (target - cum[seg]) / segLen : 0;
    const j = (seg + 1) % m;
    X[k] = xs[seg] + (xs[j] - xs[seg]) * u;
    Y[k] = ys[seg] + (ys[j] - ys[seg]) * u;
    W[k] = ws[seg] + (ws[j] - ws[seg]) * u;
  }
  return { X, Y, W, cum, total, spacing };
}

function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export class TrackBuildError extends Error {}

export function buildTrack(def: TrackDef): Track {
  const pts = def.points;
  if (!Array.isArray(pts) || pts.length < 4) throw new TrackBuildError('A pista precisa de pelo menos 4 pontos.');
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.w) || p.w <= 0) {
      throw new TrackBuildError('A pista tem pontos com valores inválidos.');
    }
  }
  let dense: { xs: number[]; ys: number[]; ws: number[]; ctrlIndex: number[] };
  if (def.smooth) {
    dense = catmullRomClosed(pts);
  } else {
    dense = { xs: pts.map((p) => p.x), ys: pts.map((p) => p.y), ws: pts.map((p) => p.w), ctrlIndex: pts.map((_, i) => i) };
  }
  const startCtrl = Math.min(Math.max(0, Math.floor(def.startIndex || 0)), pts.length - 1);
  const { X, Y, W, cum, spacing } = resampleClosed(dense.xs, dense.ys, dense.ws, SAMPLE_SPACING);
  const N = X.length;
  const startArc = cum[dense.ctrlIndex[startCtrl]];
  const k0 = Math.round(startArc / spacing) % N;

  // Suaviza larguras para evitar degraus nas bordas.
  const Wsm = new Float64Array(N);
  const R = 4;
  for (let i = 0; i < N; i++) {
    let acc = 0;
    for (let d = -R; d <= R; d++) acc += W[(i + d + N) % N];
    Wsm[i] = acc / (2 * R + 1);
  }

  const cx = new Float64Array(N);
  const cy = new Float64Array(N);
  const hw = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const idx = def.reverse ? (k0 - i + N) % N : (k0 + i) % N;
    cx[i] = X[idx];
    cy[i] = Y[idx];
    hw[i] = Wsm[idx] / 2;
  }
  const tx = new Float64Array(N);
  const ty = new Float64Array(N);
  const nx = new Float64Array(N);
  const ny = new Float64Array(N);
  const s = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = (i - 1 + N) % N;
    const b = (i + 1) % N;
    let dx = cx[b] - cx[a];
    let dy = cy[b] - cy[a];
    const l = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= l;
    dy /= l;
    tx[i] = dx;
    ty[i] = dy;
    nx[i] = -dy;
    ny[i] = dx;
    s[i] = i * spacing;
  }
  // Curvatura pelo círculo que passa por três pontos, suavizada.
  const rawK = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = (i - 2 + N) % N;
    const b = (i + 2) % N;
    const x1 = cx[a],
      y1 = cy[a],
      x2 = cx[i],
      y2 = cy[i],
      x3 = cx[b],
      y3 = cy[b];
    const cross = (x2 - x1) * (y3 - y2) - (y2 - y1) * (x3 - x2);
    const d12 = Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1));
    const d23 = Math.sqrt((x3 - x2) * (x3 - x2) + (y3 - y2) * (y3 - y2));
    const d13 = Math.sqrt((x3 - x1) * (x3 - x1) + (y3 - y1) * (y3 - y1));
    const den = d12 * d23 * d13;
    rawK[i] = den > 1e-9 ? (2 * cross) / den : 0;
  }
  const curv = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let acc = 0;
    for (let d = -2; d <= 2; d++) acc += rawK[(i + d + N) % N];
    curv[i] = acc / 5;
  }
  const ax = new Float64Array(N);
  const ay = new Float64Array(N);
  const bx = new Float64Array(N);
  const by = new Float64Array(N);
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let i = 0; i < N; i++) {
    ax[i] = cx[i] + nx[i] * hw[i];
    ay[i] = cy[i] + ny[i] * hw[i];
    bx[i] = cx[i] - nx[i] * hw[i];
    by[i] = cy[i] - ny[i] * hw[i];
    minX = Math.min(minX, ax[i], bx[i]);
    maxX = Math.max(maxX, ax[i], bx[i]);
    minY = Math.min(minY, ay[i], by[i]);
    maxY = Math.max(maxY, ay[i], by[i]);
  }
  const segs = new Float64Array(N * 2 * 4);
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    let o = i * 4;
    segs[o] = ax[i];
    segs[o + 1] = ay[i];
    segs[o + 2] = ax[j];
    segs[o + 3] = ay[j];
    o = (N + i) * 4;
    segs[o] = bx[i];
    segs[o + 1] = by[i];
    segs[o + 2] = bx[j];
    segs[o + 3] = by[j];
  }
  const grid = buildGrid(segs, N * 2, 8);
  const safeHw = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let m = Infinity;
    let kmax = 0;
    for (let d = -4; d <= 4; d++) {
      const q = (i + d + N) % N;
      if (hw[q] < m) m = hw[q];
      const k = Math.abs(curv[q]);
      if (k > kmax) kmax = k;
    }
    // folga das cordas: sagita do lado de fora (raio + meia largura) e da linha central, com margem
    const R = kmax > 1e-9 ? 1 / kmax : 1e9;
    const theta = spacing / Math.max(R - m, 1);
    const sag = (R + m) * (theta * theta) / 8 + spacing * spacing * kmax / 8;
    safeHw[i] = m - sag - 0.25;
  }
  const length = N * spacing;

  const cpCount = Math.min(200, Math.max(8, Math.round(length / CHECKPOINT_SPACING)));
  const checkpoints: Checkpoint[] = [];
  for (let k = 0; k < cpCount; k++) {
    const i = Math.round((k * N) / cpCount) % N;
    checkpoints.push({ index: k, sample: i, s: s[i], ax: bx[i], ay: by[i], bx: ax[i], by: ay[i], tx: tx[i], ty: ty[i] });
  }

  // Posição de largada: START_OFFSET metros depois da linha de chegada.
  const startPos = pointAtS({ n: N, spacing, cx, cy, tx, ty } as Track, START_OFFSET);
  const heading = datan2(startPos.ty, startPos.tx);

  let hashSrc = `${N}`;
  for (let i = 0; i < N; i++) hashSrc += `|${cx[i].toFixed(3)},${cy[i].toFixed(3)},${hw[i].toFixed(3)}`;

  const lapDistance = length - START_OFFSET;
  return {
    def,
    n: N,
    spacing,
    length,
    cx,
    cy,
    hw,
    tx,
    ty,
    nx,
    ny,
    s,
    curv,
    safeHw,
    ax,
    ay,
    bx,
    by,
    grid,
    checkpoints,
    start: { x: startPos.x, y: startPos.y, heading, sample: Math.floor(START_OFFSET / spacing) },
    lapDistance,
    refTime: lapDistance / V_REF,
    bounds: { minX, minY, maxX, maxY },
    hash: fnv1a(hashSrc),
  };
}

/** Ponto e tangente da linha central na distância s (com volta). */
export function pointAtS(t: Pick<Track, 'n' | 'spacing' | 'cx' | 'cy' | 'tx' | 'ty'>, s: number): { x: number; y: number; tx: number; ty: number; i: number } {
  const L = t.n * t.spacing;
  let ss = s % L;
  if (ss < 0) ss += L;
  const f = ss / t.spacing;
  const i = Math.floor(f) % t.n;
  const j = (i + 1) % t.n;
  const u = f - Math.floor(f);
  const x = t.cx[i] + (t.cx[j] - t.cx[i]) * u;
  const y = t.cy[i] + (t.cy[j] - t.cy[i]) * u;
  let dx = t.cx[j] - t.cx[i];
  let dy = t.cy[j] - t.cy[i];
  const l = Math.sqrt(dx * dx + dy * dy) || 1;
  dx /= l;
  dy /= l;
  return { x, y, tx: dx, ty: dy, i };
}

export interface Projection {
  /** índice do segmento (amostra i → i+1) */
  seg: number;
  /** s ao longo da pista, em [0, length) */
  s: number;
  /** deslocamento lateral com sinal (positivo para o lado A) */
  lateral: number;
  /** distância até a linha central */
  dist: number;
}

const tmpClosest = { t: 0, d2: 0 };

/**
 * Projeta o ponto na linha central procurando só perto da última posição
 * conhecida (±window amostras). Isso impede confundir trechos da pista que
 * passam perto um do outro.
 */
export function projectLocal(track: Track, x: number, y: number, hint: number, window: number, out: Projection): void {
  const N = track.n;
  let bestD2 = Infinity;
  let bestI = hint;
  let bestT = 0;
  for (let d = -window; d <= window; d++) {
    const i = (((hint + d) % N) + N) % N;
    const j = i + 1 === N ? 0 : i + 1;
    closestOnSegment(x, y, track.cx[i], track.cy[i], track.cx[j], track.cy[j], tmpClosest);
    if (tmpClosest.d2 < bestD2) {
      bestD2 = tmpClosest.d2;
      bestI = i;
      bestT = tmpClosest.t;
    }
  }
  const j = bestI + 1 === N ? 0 : bestI + 1;
  const ex = track.cx[j] - track.cx[bestI];
  const ey = track.cy[j] - track.cy[bestI];
  const px = x - track.cx[bestI];
  const py = y - track.cy[bestI];
  const el = Math.sqrt(ex * ex + ey * ey) || 1;
  out.seg = bestI;
  out.s = track.s[bestI] + bestT * track.spacing;
  out.lateral = (ex * py - ey * px) / el;
  out.dist = Math.sqrt(bestD2);
}

/** Projeção global (usada só fora do laço da simulação, ex.: editor e clique). */
export function projectGlobal(track: Track, x: number, y: number, out: Projection): void {
  let best = Infinity;
  let bi = 0;
  for (let i = 0; i < track.n; i++) {
    const dx = track.cx[i] - x;
    const dy = track.cy[i] - y;
    const d = dx * dx + dy * dy;
    if (d < best) {
      best = d;
      bi = i;
    }
  }
  projectLocal(track, x, y, bi, 3, out);
}

export function trackSummary(t: Track): { length: number; minWidth: number; maxWidth: number; minRadius: number; checkpoints: number } {
  let minW = Infinity;
  let maxW = 0;
  let maxK = 0;
  for (let i = 0; i < t.n; i++) {
    minW = Math.min(minW, t.hw[i] * 2);
    maxW = Math.max(maxW, t.hw[i] * 2);
    maxK = Math.max(maxK, Math.abs(t.curv[i]));
  }
  return { length: t.length, minWidth: minW, maxWidth: maxW, minRadius: maxK > 0 ? 1 / maxK : Infinity, checkpoints: t.checkpoints.length };
}
