/**
 * Geometria: segmentos, interseções, raycast e grade espacial.
 *
 * As bordas da pista viram uma lista de segmentos guardada em Float64Array
 * (x1, y1, x2, y2, ...). Uma grade uniforme indexa os segmentos para que
 * sensores e colisões testem apenas os segmentos próximos.
 */

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface SegmentGrid {
  segs: Float64Array;
  segCount: number;
  cell: number;
  originX: number;
  originY: number;
  cols: number;
  rows: number;
  /** Formato CSR: itens da célula c estão em cellItems[cellStart[c] .. cellStart[c+1]) */
  cellStart: Int32Array;
  cellItems: Int32Array;
  /** Carimbo para não testar o mesmo segmento duas vezes numa consulta. */
  stamp: Int32Array;
  stampValue: number;
  /** Quando true, ignora a grade e testa todos os segmentos (usado para medir ganho). */
  bruteForce: boolean;
}

const EPS = 1e-12;

export function buildGrid(segs: Float64Array, segCount: number, cell = 16): SegmentGrid {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < segCount; i++) {
    const o = i * 4;
    for (let k = 0; k < 4; k += 2) {
      const x = segs[o + k];
      const y = segs[o + k + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (segCount === 0) {
    minX = minY = 0;
    maxX = maxY = 1;
  }
  const pad = cell;
  const originX = minX - pad;
  const originY = minY - pad;
  const cols = Math.max(1, Math.ceil((maxX - minX + 2 * pad) / cell));
  const rows = Math.max(1, Math.ceil((maxY - minY + 2 * pad) / cell));
  const counts = new Int32Array(cols * rows + 1);
  const forEachCell = (i: number, fn: (c: number) => void) => {
    const o = i * 4;
    const x1 = segs[o];
    const y1 = segs[o + 1];
    const x2 = segs[o + 2];
    const y2 = segs[o + 3];
    const c0 = Math.max(0, Math.floor((Math.min(x1, x2) - originX) / cell));
    const c1 = Math.min(cols - 1, Math.floor((Math.max(x1, x2) - originX) / cell));
    const r0 = Math.max(0, Math.floor((Math.min(y1, y2) - originY) / cell));
    const r1 = Math.min(rows - 1, Math.floor((Math.max(y1, y2) - originY) / cell));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) fn(r * cols + c);
  };
  for (let i = 0; i < segCount; i++) forEachCell(i, (c) => counts[c]++);
  const cellStart = new Int32Array(cols * rows + 1);
  let acc = 0;
  for (let c = 0; c < cols * rows; c++) {
    cellStart[c] = acc;
    acc += counts[c];
  }
  cellStart[cols * rows] = acc;
  const cellItems = new Int32Array(acc);
  const fill = new Int32Array(cols * rows);
  for (let i = 0; i < segCount; i++) {
    forEachCell(i, (c) => {
      cellItems[cellStart[c] + fill[c]++] = i;
    });
  }
  return {
    segs,
    segCount,
    cell,
    originX,
    originY,
    cols,
    rows,
    cellStart,
    cellItems,
    stamp: new Int32Array(segCount),
    stampValue: 0,
    bruteForce: false,
  };
}

function nextStamp(g: SegmentGrid): number {
  g.stampValue++;
  if (g.stampValue > 0x3fffffff) {
    g.stamp.fill(0);
    g.stampValue = 1;
  }
  return g.stampValue;
}

/** Distância do raio até o segmento i, ou Infinity. */
function raySeg(segs: Float64Array, i: number, ox: number, oy: number, dx: number, dy: number): number {
  const o = i * 4;
  const ax = segs[o];
  const ay = segs[o + 1];
  const ex = segs[o + 2] - ax;
  const ey = segs[o + 3] - ay;
  const denom = dx * ey - dy * ex;
  if (denom > -EPS && denom < EPS) return Infinity;
  const px = ax - ox;
  const py = ay - oy;
  const t = (px * ey - py * ex) / denom;
  if (t < 0) return Infinity;
  const u = (px * dy - py * dx) / denom;
  if (u < 0 || u > 1) return Infinity;
  return t;
}

/**
 * Lança um raio a partir de (ox, oy) na direção unitária (dx, dy) e devolve a
 * distância até a primeira borda, limitada a maxDist. Percorre as células da
 * grade em ordem (algoritmo de Amanatides–Woo) e para assim que o acerto
 * encontrado está antes da próxima célula.
 */
export function raycast(g: SegmentGrid, ox: number, oy: number, dx: number, dy: number, maxDist: number): number {
  let best = maxDist;
  const segs = g.segs;
  if (g.bruteForce) {
    for (let i = 0; i < g.segCount; i++) {
      const t = raySeg(segs, i, ox, oy, dx, dy);
      if (t < best) best = t;
    }
    return best;
  }
  const stamp = nextStamp(g);
  const cell = g.cell;
  const fx = (ox - g.originX) / cell;
  const fy = (oy - g.originY) / cell;
  let cx = Math.floor(fx);
  let cy = Math.floor(fy);
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const tDeltaX = stepX !== 0 ? cell / Math.abs(dx) : Infinity;
  const tDeltaY = stepY !== 0 ? cell / Math.abs(dy) : Infinity;
  let tMaxX = stepX > 0 ? (cx + 1 - fx) * tDeltaX : stepX < 0 ? (fx - cx) * tDeltaX : Infinity;
  let tMaxY = stepY > 0 ? (cy + 1 - fy) * tDeltaY : stepY < 0 ? (fy - cy) * tDeltaY : Infinity;
  const cols = g.cols;
  const rows = g.rows;
  const cellStart = g.cellStart;
  const items = g.cellItems;
  const stamps = g.stamp;
  let tCell = 0;
  // Limite de iterações por segurança
  for (let guard = 0; guard < 4096; guard++) {
    if (tCell > best) break;
    if (cx >= 0 && cy >= 0 && cx < cols && cy < rows) {
      const c = cy * cols + cx;
      const end = cellStart[c + 1];
      for (let k = cellStart[c]; k < end; k++) {
        const i = items[k];
        if (stamps[i] === stamp) continue;
        stamps[i] = stamp;
        const t = raySeg(segs, i, ox, oy, dx, dy);
        if (t < best) best = t;
      }
    } else if ((cx < 0 && stepX <= 0) || (cy < 0 && stepY <= 0) || (cx >= cols && stepX >= 0) || (cy >= rows && stepY >= 0)) {
      break; // saiu da grade e não volta
    }
    if (tMaxX < tMaxY) {
      tCell = tMaxX;
      tMaxX += tDeltaX;
      cx += stepX;
    } else {
      tCell = tMaxY;
      tMaxY += tDeltaY;
      cy += stepY;
    }
  }
  return best;
}

/**
 * Interseção entre os segmentos P1P2 e Q1Q2 (inclusive extremidades).
 * Devolve o parâmetro t ao longo de P1P2 (0..1) ou -1 se não houver.
 */
export function segSegT(
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
  q1x: number,
  q1y: number,
  q2x: number,
  q2y: number,
): number {
  const rx = p2x - p1x;
  const ry = p2y - p1y;
  const sx = q2x - q1x;
  const sy = q2y - q1y;
  const denom = rx * sy - ry * sx;
  const qpx = q1x - p1x;
  const qpy = q1y - p1y;
  if (denom > -EPS && denom < EPS) {
    // Paralelos: só tratamos sobreposição colinear como colisão em t do ponto mais próximo.
    const cross = qpx * ry - qpy * rx;
    if (cross > 1e-9 || cross < -1e-9) return -1;
    const rr = rx * rx + ry * ry;
    if (rr < EPS) return -1;
    const t0 = (qpx * rx + qpy * ry) / rr;
    const t1 = t0 + (sx * rx + sy * ry) / rr;
    const lo = Math.min(t0, t1);
    const hi = Math.max(t0, t1);
    if (hi < 0 || lo > 1) return -1;
    return Math.max(0, lo);
  }
  const t = (qpx * sy - qpy * sx) / denom;
  const u = (qpx * ry - qpy * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return -1;
  return t;
}

/**
 * Coleta índices de segmentos cujas células tocam a caixa dada.
 * Devolve quantos índices foram escritos em `out`.
 */
export function queryBox(g: SegmentGrid, minX: number, minY: number, maxX: number, maxY: number, out: Int32Array): number {
  if (g.bruteForce) {
    let n = 0;
    for (let i = 0; i < g.segCount && n < out.length; i++) out[n++] = i;
    return n;
  }
  const stamp = nextStamp(g);
  const cell = g.cell;
  const c0 = Math.max(0, Math.floor((minX - g.originX) / cell));
  const c1 = Math.min(g.cols - 1, Math.floor((maxX - g.originX) / cell));
  const r0 = Math.max(0, Math.floor((minY - g.originY) / cell));
  const r1 = Math.min(g.rows - 1, Math.floor((maxY - g.originY) / cell));
  let n = 0;
  const stamps = g.stamp;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const cc = r * g.cols + c;
      const end = g.cellStart[cc + 1];
      for (let k = g.cellStart[cc]; k < end; k++) {
        const i = g.cellItems[k];
        if (stamps[i] === stamp) continue;
        stamps[i] = stamp;
        if (n < out.length) out[n++] = i;
      }
    }
  }
  return n;
}

export interface Vec2 {
  x: number;
  y: number;
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Ponto mais próximo no segmento AB: devolve t (0..1) e a distância ao quadrado. */
export function closestOnSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number, out: { t: number; d2: number }): void {
  const ex = bx - ax;
  const ey = by - ay;
  const ll = ex * ex + ey * ey;
  let t = ll > EPS ? ((px - ax) * ex + (py - ay) * ey) / ll : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const qx = ax + ex * t - px;
  const qy = ay + ey * t - py;
  out.t = t;
  out.d2 = qx * qx + qy * qy;
}

/** Verifica se dois segmentos se cruzam propriamente (sem contar extremidades compartilhadas). */
export function segmentsCrossProper(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const o1 = orient(ax, ay, bx, by, cx, cy);
  const o2 = orient(ax, ay, bx, by, dx, dy);
  const o3 = orient(cx, cy, dx, dy, ax, ay);
  const o4 = orient(cx, cy, dx, dy, bx, by);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return v > 1e-9 ? 1 : v < -1e-9 ? -1 : 0;
}
