import { PHYSICS } from '../../core/physics.ts';
import { RAY_ANGLES_DEG, RAY_RANGE, type RayCount } from '../../core/sensors.ts';
import type { Bounds } from '../../core/geometry.ts';
import { Rng } from '../../core/rng.ts';
import type { Track } from '../../core/track.ts';

/**
 * Desenho 2D em vista superior. Tudo é desenhado em coordenadas do mundo
 * (metros) com uma transformação de câmera, então os carros têm exatamente
 * o tamanho usado pela colisão (4,6 m × 1,9 m).
 */

export interface Camera {
  x: number;
  y: number;
  /** pixels por metro */
  scale: number;
}

export function fitCamera(b: Bounds, w: number, h: number, pad = 24): Camera {
  const bw = Math.max(1, b.maxX - b.minX);
  const bh = Math.max(1, b.maxY - b.minY);
  const scale = Math.max(0.05, Math.min((w - pad * 2) / bw, (h - pad * 2) / bh));
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, scale };
}

export function applyCamera(ctx: CanvasRenderingContext2D, cam: Camera, w: number, h: number, dpr: number): void {
  ctx.setTransform(cam.scale * dpr, 0, 0, cam.scale * dpr, (w / 2 - cam.x * cam.scale) * dpr, (h / 2 - cam.y * cam.scale) * dpr);
}

export function screenToWorld(cam: Camera, w: number, h: number, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - w / 2) / cam.scale + cam.x, y: (sy - h / 2) / cam.scale + cam.y };
}

export const THEME = {
  grass: '#16241c',
  grassStripe: '#18291f',
  asphalt: '#3a3f47',
  asphaltEdge: '#454b55',
  border: '#f1f3f5',
  curbRed: '#e03131',
  curbWhite: '#f8f9fa',
  tree: '#1e3a28',
  treeDark: '#173022',
  checkpoint: 'rgba(255,255,255,0.18)',
};

export interface TrackPaths {
  asphalt: Path2D;
  borderA: Path2D;
  borderB: Path2D;
  curbRed: Path2D;
  curbWhite: Path2D;
  checkpoints: Path2D;
  scenery: Path2D;
  sceneryDark: Path2D;
  startCells: Path2D[];
  centerline: Path2D;
}

const pathCache = new WeakMap<Track, TrackPaths>();

/** Caminhos vetoriais da pista (calculados uma vez por pista). */
export function trackPaths(t: Track): TrackPaths {
  const cached = pathCache.get(t);
  if (cached) return cached;
  const N = t.n;
  const asphalt = new Path2D();
  const borderA = new Path2D();
  const borderB = new Path2D();
  const centerline = new Path2D();
  for (let i = 0; i <= N; i++) {
    const k = i % N;
    if (i === 0) {
      borderA.moveTo(t.ax[k], t.ay[k]);
      borderB.moveTo(t.bx[k], t.by[k]);
      centerline.moveTo(t.cx[k], t.cy[k]);
    } else {
      borderA.lineTo(t.ax[k], t.ay[k]);
      borderB.lineTo(t.bx[k], t.by[k]);
      centerline.lineTo(t.cx[k], t.cy[k]);
    }
  }
  asphalt.addPath(borderA);
  asphalt.addPath(borderB);

  // Zebras nas curvas mais fechadas (dos dois lados), em blocos alternados.
  const curbRed = new Path2D();
  const curbWhite = new Path2D();
  const CW = 1.1;
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    const k = Math.max(Math.abs(t.curv[i]), Math.abs(t.curv[j]));
    if (k < 1 / 75) continue;
    const target = Math.floor((t.s[i] / 2.4) % 2) === 0 ? curbRed : curbWhite;
    for (const side of [1, -1]) {
      const ex1 = t.cx[i] + t.nx[i] * t.hw[i] * side;
      const ey1 = t.cy[i] + t.ny[i] * t.hw[i] * side;
      const ex2 = t.cx[j] + t.nx[j] * t.hw[j] * side;
      const ey2 = t.cy[j] + t.ny[j] * t.hw[j] * side;
      const ix1 = t.cx[i] + t.nx[i] * (t.hw[i] - CW) * side;
      const iy1 = t.cy[i] + t.ny[i] * (t.hw[i] - CW) * side;
      const ix2 = t.cx[j] + t.nx[j] * (t.hw[j] - CW) * side;
      const iy2 = t.cy[j] + t.ny[j] * (t.hw[j] - CW) * side;
      target.moveTo(ex1, ey1);
      target.lineTo(ex2, ey2);
      target.lineTo(ix2, iy2);
      target.lineTo(ix1, iy1);
      target.closePath();
    }
  }

  const checkpoints = new Path2D();
  for (const cp of t.checkpoints) {
    if (cp.index === 0) continue;
    checkpoints.moveTo(cp.ax, cp.ay);
    checkpoints.lineTo(cp.bx, cp.by);
  }

  // Linha de chegada quadriculada.
  const startCells: Path2D[] = [new Path2D(), new Path2D()];
  const cp0 = t.checkpoints[0];
  const tx = t.tx[0];
  const ty = t.ty[0];
  const wx = cp0.bx - cp0.ax;
  const wy = cp0.by - cp0.ay;
  const width = Math.sqrt(wx * wx + wy * wy);
  const cells = Math.max(4, Math.round(width / 1.2));
  const cs = width / cells;
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < cells; c++) {
      const p = startCells[(r + c) % 2];
      const ox = cp0.ax + (wx / width) * cs * c + tx * cs * (r - 1);
      const oy = cp0.ay + (wy / width) * cs * c + ty * cs * (r - 1);
      p.moveTo(ox, oy);
      p.lineTo(ox + (wx / width) * cs, oy + (wy / width) * cs);
      p.lineTo(ox + (wx / width) * cs + tx * cs, oy + (wy / width) * cs + ty * cs);
      p.lineTo(ox + tx * cs, oy + ty * cs);
      p.closePath();
    }
  }

  // Cenário discreto: arbustos fora da pista (posições fixas por pista).
  const scenery = new Path2D();
  const sceneryDark = new Path2D();
  const rng = new Rng(`cenario:${t.def.id}:${t.hash}`);
  const b = t.bounds;
  const margin = 40;
  let placed = 0;
  for (let tries = 0; tries < 900 && placed < 70; tries++) {
    const x = b.minX - margin + rng.next() * (b.maxX - b.minX + margin * 2);
    const y = b.minY - margin + rng.next() * (b.maxY - b.minY + margin * 2);
    let ok = true;
    for (let i = 0; i < N; i += 3) {
      const dx = t.cx[i] - x;
      const dy = t.cy[i] - y;
      const lim = t.hw[i] + 9;
      if (dx * dx + dy * dy < lim * lim) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const r = 2 + rng.next() * 3.5;
    const p = rng.next() < 0.5 ? scenery : sceneryDark;
    p.moveTo(x + r, y);
    p.arc(x, y, r, 0, Math.PI * 2);
    placed++;
  }
  const paths = { asphalt, borderA, borderB, curbRed, curbWhite, checkpoints, scenery, sceneryDark, startCells, centerline };
  pathCache.set(t, paths);
  return paths;
}

export interface TrackDrawOptions {
  showCheckpoints?: boolean;
  showCenterline?: boolean;
  dimmed?: boolean;
}

/** Desenha fundo + pista. A transformação da câmera deve estar aplicada. */
export function drawTrack(ctx: CanvasRenderingContext2D, t: Track, cam: Camera, w: number, h: number, dpr: number, opts: TrackDrawOptions = {}): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = THEME.grass;
  ctx.fillRect(0, 0, w, h);
  applyCamera(ctx, cam, w, h, dpr);
  const p = trackPaths(t);
  ctx.fillStyle = THEME.treeDark;
  ctx.fill(p.sceneryDark);
  ctx.fillStyle = THEME.tree;
  ctx.fill(p.scenery);
  // faixa de grama mais clara junto à pista (acostamento)
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#1d3326';
  ctx.lineWidth = 5;
  ctx.stroke(p.borderA);
  ctx.stroke(p.borderB);
  ctx.fillStyle = THEME.asphalt;
  ctx.fill(p.asphalt, 'evenodd');
  ctx.fillStyle = THEME.curbRed;
  ctx.fill(p.curbRed);
  ctx.fillStyle = THEME.curbWhite;
  ctx.fill(p.curbWhite);
  ctx.strokeStyle = THEME.border;
  ctx.lineWidth = Math.max(0.35, 1.2 / cam.scale);
  ctx.stroke(p.borderA);
  ctx.stroke(p.borderB);
  ctx.fillStyle = '#f8f9fa';
  ctx.fill(p.startCells[0]);
  ctx.fillStyle = '#212529';
  ctx.fill(p.startCells[1]);
  if (opts.showCheckpoints) {
    ctx.strokeStyle = THEME.checkpoint;
    ctx.lineWidth = Math.max(0.2, 1 / cam.scale);
    ctx.setLineDash([1.2, 1.2]);
    ctx.stroke(p.checkpoints);
    ctx.setLineDash([]);
  }
  if (opts.showCenterline) {
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = Math.max(0.2, 1 / cam.scale);
    ctx.setLineDash([3, 3]);
    ctx.stroke(p.centerline);
    ctx.setLineDash([]);
  }
  if (opts.dimmed) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = 'rgba(10,14,20,0.35)';
    ctx.fillRect(0, 0, w, h);
    applyCamera(ctx, cam, w, h, dpr);
  }
}

export type CarLook = 'normal' | 'morto' | 'concluido' | 'parado' | 'fantasma';

const darkCache = new Map<string, string>();
function shade(hex: string, f: number): string {
  const key = `${hex}|${f}`;
  let v = darkCache.get(key);
  if (!v) {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.round(((n >> 16) & 255) * f);
    const g = Math.round(((n >> 8) & 255) * f);
    const b = Math.round((n & 255) * f);
    v = `rgb(${Math.min(255, r)},${Math.min(255, g)},${Math.min(255, b)})`;
    darkCache.set(key, v);
  }
  return v;
}

const HL = PHYSICS.carLength / 2;
const HWID = PHYSICS.carWidth / 2;

/**
 * Monoposto em vista superior, dentro do retângulo de colisão:
 * pneus aparentes, asa dianteira, asa traseira, cockpit e corpo estreito.
 */
export function drawCar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  heading: number,
  color: string,
  look: CarLook,
  scale: number,
  opts: { selected?: boolean; elite?: boolean; fresh?: boolean; steer?: number } = {},
): void {
  const px = PHYSICS.carLength * scale;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(heading);
  const dead = look === 'morto';
  const body = dead ? '#5c636a' : look === 'parado' ? shade(color, 0.55) : color;
  ctx.globalAlpha = look === 'fantasma' ? 0.45 : dead ? 0.75 : 1;
  if (px < 7) {
    // Nível de detalhe baixo: silhueta simples, ainda orientada.
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(HL, 0);
    ctx.lineTo(-HL, HWID);
    ctx.lineTo(-HL, -HWID);
    ctx.closePath();
    ctx.fill();
    if (opts.elite && !dead) {
      ctx.strokeStyle = '#ffd43b';
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }
  } else {
    const tire = '#0d0f12';
    // pneus traseiros e dianteiros
    ctx.fillStyle = tire;
    ctx.fillRect(-2.2, 0.55, 0.85, 0.4);
    ctx.fillRect(-2.2, -0.95, 0.85, 0.4);
    const st = (opts.steer ?? 0) * 0.35;
    for (const side of [1, -1]) {
      ctx.save();
      ctx.translate(1.38, side * 0.73);
      ctx.rotate(st);
      ctx.fillRect(-0.35, -0.17, 0.7, 0.34);
      ctx.restore();
    }
    // asa traseira
    ctx.fillStyle = shade(body.startsWith('#') ? body : '#5c636a', 0.6);
    ctx.fillRect(-HL, -0.78, 0.38, 1.56);
    // corpo: nariz fino, laterais (sidepods) e cobertura do motor
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(2.05, -0.13);
    ctx.lineTo(2.05, 0.13);
    ctx.lineTo(0.9, 0.27);
    ctx.lineTo(0.45, 0.56);
    ctx.lineTo(-1.25, 0.56);
    ctx.lineTo(-1.95, 0.22);
    ctx.lineTo(-1.95, -0.22);
    ctx.lineTo(-1.25, -0.56);
    ctx.lineTo(0.45, -0.56);
    ctx.lineTo(0.9, -0.27);
    ctx.closePath();
    ctx.fill();
    // asa dianteira
    ctx.fillStyle = shade(body.startsWith('#') ? body : '#5c636a', 0.75);
    ctx.fillRect(1.98, -HWID, 0.32, PHYSICS.carWidth);
    // cockpit e capacete
    ctx.fillStyle = '#101317';
    ctx.beginPath();
    ctx.ellipse(0.05, 0, 0.42, 0.25, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = dead ? '#adb5bd' : '#f8f9fa';
    ctx.beginPath();
    ctx.arc(0.0, 0, 0.16, 0, Math.PI * 2);
    ctx.fill();
    if (opts.elite && !dead) {
      // marca da elite (não depende só de cor: listra no capô)
      ctx.fillStyle = '#ffd43b';
      ctx.fillRect(0.6, -0.08, 1.2, 0.16);
    }
    if (opts.fresh && !dead) {
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 0.12;
      ctx.setLineDash([0.3, 0.25]);
      ctx.strokeRect(-HL, -HWID, PHYSICS.carLength, PHYSICS.carWidth);
      ctx.setLineDash([]);
    }
  }
  if (dead) {
    // X sobre o carro batido (indicador que não depende só da cor)
    ctx.strokeStyle = '#ff8787';
    ctx.lineWidth = Math.max(0.25, 1.4 / scale);
    ctx.beginPath();
    ctx.moveTo(-1, -0.9);
    ctx.lineTo(1, 0.9);
    ctx.moveTo(-1, 0.9);
    ctx.lineTo(1, -0.9);
    ctx.stroke();
  }
  if (look === 'concluido') {
    ctx.strokeStyle = '#8ce99a';
    ctx.lineWidth = Math.max(0.2, 1.2 / scale);
    ctx.strokeRect(-HL - 0.3, -HWID - 0.3, PHYSICS.carLength + 0.6, PHYSICS.carWidth + 0.6);
  }
  ctx.restore();
  if (opts.selected) {
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(0.25, 1.5 / scale);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(4.2, 10 / scale), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

/** Raios dos sensores do carro selecionado. */
export function drawSensors(ctx: CanvasRenderingContext2D, x: number, y: number, heading: number, rays: number[], count: RayCount, scale: number): void {
  const angles = RAY_ANGLES_DEG[count];
  ctx.save();
  ctx.lineWidth = Math.max(0.15, 1 / scale);
  for (let i = 0; i < angles.length && i < rays.length; i++) {
    const a = heading + (angles[i] * Math.PI) / 180;
    const d = rays[i];
    const hx = x + Math.cos(a) * d;
    const hy = y + Math.sin(a) * d;
    const near = 1 - Math.min(1, d / 40);
    const col = `hsl(${Math.round(130 - near * 130)}, 85%, 60%)`;
    ctx.strokeStyle = col;
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    if (d < RAY_RANGE - 0.01) {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(hx, hy, Math.max(0.4, 2.5 / scale), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

export function drawPath(ctx: CanvasRenderingContext2D, pts: Float32Array | number[], color: string, scale: number, width = 1.6, count?: number): void {
  const n = (count ?? pts.length / 2) | 0;
  if (n < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(0.2, width / scale);
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 1; i < n; i++) ctx.lineTo(pts[i * 2], pts[i * 2 + 1]);
  ctx.stroke();
  ctx.restore();
}

/** Mapa de mortes: pontos translúcidos que se acumulam onde há mais batidas. */
export function drawDeaths(ctx: CanvasRenderingContext2D, pts: number[], scale: number): void {
  ctx.save();
  const r = Math.max(1.2, 4 / scale);
  ctx.fillStyle = 'rgba(255, 70, 70, 0.22)';
  for (let i = 0; i + 1 < pts.length; i += 2) {
    ctx.beginPath();
    ctx.arc(pts[i], pts[i + 1], r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Efeito curto de batida (anel que se expande e some; sem flash). */
export function drawCrashEffect(ctx: CanvasRenderingContext2D, x: number, y: number, age: number, scale: number, reduceMotion: boolean): void {
  const life = 0.5;
  if (age > life) return;
  const k = age / life;
  ctx.save();
  ctx.strokeStyle = `rgba(255, 146, 43, ${0.8 * (1 - k)})`;
  ctx.lineWidth = Math.max(0.2, 2 / scale);
  ctx.beginPath();
  ctx.arc(x, y, reduceMotion ? 3 : 1.5 + k * 5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** Cor estável para cada indivíduo (pelo identificador). */
export function colorForId(id: number): string {
  const hue = (id * 137.508) % 360;
  return hslToHex(hue, 0.72, 0.6);
}

function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
