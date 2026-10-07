import { dcos, dsin, deg } from './dmath.ts';
import type { TrackDef, TrackPoint } from './track.ts';

/**
 * Circuitos iniciais, descritos como uma "tartaruga" que anda em retas e arcos.
 * Duas retas marcadas como livres (comprimento null) são calculadas para que o
 * circuito feche exatamente. Raios e larguras foram escolhidos para serem
 * percorríveis pela física (ver testes de pista).
 */

type Cmd =
  | { k: 'S'; len: number | null; w?: number }
  | { k: 'L' | 'R'; r: number; a: number; w?: number };

const S = (len: number | null, w?: number): Cmd => ({ k: 'S', len, w });
const L = (r: number, a: number, w?: number): Cmd => ({ k: 'L', r, a, w });
const R = (r: number, a: number, w?: number): Cmd => ({ k: 'R', r, a, w });

const STEP = 1.5;

function walk(cmds: Cmd[], lengths: number[], w0: number, emit: boolean): { x: number; y: number; pts: TrackPoint[] } {
  let x = 0;
  let y = 0;
  let h = 0;
  let w = w0;
  const pts: TrackPoint[] = [];
  let free = 0;
  for (const c of cmds) {
    const wStart = w;
    const wEnd = c.w ?? w;
    if (c.k === 'S') {
      const len = c.len ?? lengths[free++];
      const n = Math.max(1, Math.round(len / STEP));
      const ch = dcos(h);
      const sh = dsin(h);
      for (let i = 0; i < n; i++) {
        if (emit) pts.push({ x: x + ch * (len * i) / n, y: y + sh * (len * i) / n, w: wStart + ((wEnd - wStart) * i) / n });
      }
      x += ch * len;
      y += sh * len;
    } else {
      const sign = c.k === 'L' ? 1 : -1;
      const ang = deg(c.a);
      const arcLen = c.r * ang;
      const n = Math.max(2, Math.round(arcLen / STEP));
      // centro do arco
      const cxp = x - sign * dsin(h) * c.r;
      const cyp = y + sign * dcos(h) * c.r;
      for (let i = 0; i < n; i++) {
        const hh = h + (sign * ang * i) / n;
        if (emit) {
          pts.push({
            x: cxp + sign * dsin(hh) * c.r,
            y: cyp - sign * dcos(hh) * c.r,
            w: wStart + ((wEnd - wStart) * i) / n,
          });
        }
      }
      h += sign * ang;
      x = cxp + sign * dsin(h) * c.r;
      y = cyp - sign * dcos(h) * c.r;
    }
    w = wEnd;
  }
  return { x, y, pts };
}

/** Resolve os comprimentos das duas retas livres para fechar o circuito. */
function closeTurtle(cmds: Cmd[], w0: number): TrackPoint[] {
  const freeIdx = cmds.map((c, i) => (c.k === 'S' && c.len === null ? i : -1)).filter((i) => i >= 0);
  if (freeIdx.length === 0) {
    const closed = walk(cmds, [], w0, true);
    if (Math.abs(closed.x) > 0.01 || Math.abs(closed.y) > 0.01) throw new Error('Circuito não fecha.');
    return closed.pts;
  }
  if (freeIdx.length !== 2) throw new Error('O circuito precisa de zero ou duas retas livres.');
  // Direção de cada reta livre: medimos o deslocamento com comprimento 0 e 1.
  const base = walk(cmds, [0, 0], w0, false);
  const a = walk(cmds, [1, 0], w0, false);
  const b = walk(cmds, [0, 1], w0, false);
  const ux = a.x - base.x;
  const uy = a.y - base.y;
  const vx = b.x - base.x;
  const vy = b.y - base.y;
  const det = ux * vy - uy * vx;
  if (Math.abs(det) < 1e-6) throw new Error('Retas livres paralelas.');
  const gx = -base.x;
  const gy = -base.y;
  const la = (gx * vy - gy * vx) / det;
  const lb = (ux * gy - uy * gx) / det;
  if (la < 10 || lb < 10) throw new Error(`Circuito não fecha com retas positivas (${la.toFixed(1)}, ${lb.toFixed(1)}).`);
  return walk(cmds, [la, lb], w0, true).pts;
}

function makeTurtleTrack(meta: Omit<TrackDef, 'points' | 'smooth' | 'startIndex' | 'reverse' | 'builtin'>, cmds: Cmd[], w0: number, startAtMeters: number): TrackDef {
  const pts = closeTurtle(cmds, w0);
  // Centraliza na origem para facilitar a visualização.
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const ox = Math.round((minX + maxX) / 2);
  const oy = Math.round((minY + maxY) / 2);
  const points = pts.map((p) => ({ x: p.x - ox, y: -(p.y - oy), w: p.w })); // y invertido: tela cresce para baixo
  return {
    ...meta,
    builtin: true,
    points,
    smooth: false,
    startIndex: Math.round(startAtMeters / STEP),
    reverse: false,
  };
}

export const BUILTIN_TRACKS: TrackDef[] = [
  makeTurtleTrack(
    {
      id: 'oval-largo',
      name: 'Oval Largo',
      version: 1,
      difficulty: 1,
      description: 'Duas retas e duas curvas largas. Ótimo para o primeiro treino.',
    },
    [S(300), L(80, 180), S(300), L(80, 180)],
    18,
    120,
  ),
  makeTurtleTrack(
    {
      id: 'curvas-s',
      name: 'Curvas em S',
      version: 1,
      difficulty: 2,
      description: 'Esses encadeados exigem trocar de direção sem perder o ritmo.',
    },
    [
      S(null),
      L(45, 90),
      S(80),
      L(45, 90),
      S(40),
      R(35, 60),
      L(35, 120),
      R(35, 60),
      S(40),
      L(35, 60),
      R(35, 120),
      L(35, 60),
      S(40),
      L(45, 90),
      S(null),
      L(45, 90),
    ],
    16,
    60,
  ),
  makeTurtleTrack(
    {
      id: 'trechos-estreitos',
      name: 'Trechos Estreitos',
      version: 1,
      difficulty: 3,
      description: 'A largura muda bastante. Chicanes estreitas punem qualquer exagero.',
    },
    [
      S(null, 14),
      L(30, 90),
      S(60, 8.5),
      R(20, 40),
      L(20, 80),
      R(20, 40),
      S(50, 12),
      L(25, 90),
      S(150),
      L(22, 60),
      S(30),
      R(22, 60),
      S(80, 8.5),
      L(30, 90),
      S(null, 8.5),
      L(30, 90, 14),
    ],
    14,
    40,
  ),
  makeTurtleTrack(
    {
      id: 'retas-grampos',
      name: 'Retas e Grampos',
      version: 1,
      difficulty: 4,
      description: 'Retas longas terminam em grampos fechados. Frear na hora certa é tudo.',
    },
    [S(null), L(18, 90), S(null), L(17, 180), S(80), R(17, 180), S(80), L(18, 90), S(400), L(18, 90), S(130), L(18, 90)],
    16,
    60,
  ),
  makeTurtleTrack(
    {
      id: 'circuito-misto',
      name: 'Circuito Misto',
      version: 1,
      difficulty: 5,
      description: 'Um pouco de tudo: curvas rápidas, grampo, chicane e trechos estreitos.',
    },
    [
      S(null),
      R(60, 45),
      L(60, 45),
      S(120),
      L(15, 120),
      S(100),
      R(40, 60),
      L(50, 120),
      S(80, 9.5),
      L(18, 45),
      R(18, 90),
      L(18, 45),
      S(60, 13),
      L(35, 90),
      S(null),
      L(22, 90),
    ],
    14,
    40,
  ),
];

export function getBuiltinTrack(id: string): TrackDef | undefined {
  return BUILTIN_TRACKS.find((t) => t.id === id);
}
