import { segmentsCrossProper, queryBox } from './geometry.ts';
import { buildTrack, type Track, type TrackDef } from './track.ts';

export interface TrackIssue {
  level: 'erro' | 'aviso';
  code: string;
  message: string;
  fix: string;
  at?: { x: number; y: number };
}

export const TRACK_LIMITS = Object.freeze({
  minPoints: 4,
  maxPoints: 400,
  maxDensePoints: 6000,
  minWidth: 8,
  maxWidth: 40,
  minLength: 250,
  maxLength: 8000,
  /** Raio mínimo que o carro consegue fazer em baixa velocidade (com folga). */
  minDrivableRadius: 8,
  tightRadiusWarning: 14,
  maxCoord: 5000,
});

/**
 * Valida a geometria de uma pista. A validação não garante que a pista seja
 * fácil de dirigir — só que ela é coerente. Para dirigibilidade, use o teste.
 */
export function validateTrackDef(def: TrackDef, opts: { closed?: boolean } = {}): TrackIssue[] {
  const issues: TrackIssue[] = [];
  const pts = def.points ?? [];
  if (opts.closed === false) {
    issues.push({
      level: 'erro',
      code: 'aberto',
      message: 'O circuito ainda não está fechado.',
      fix: 'Clique em "Fechar circuito" para ligar o último ponto ao primeiro.',
    });
  }
  if (pts.length < TRACK_LIMITS.minPoints) {
    issues.push({ level: 'erro', code: 'poucos-pontos', message: `A pista tem ${pts.length} pontos.`, fix: 'Adicione pelo menos 4 pontos clicando no mapa.' });
    return issues;
  }
  const maxPts = def.smooth ? TRACK_LIMITS.maxPoints : TRACK_LIMITS.maxDensePoints;
  if (pts.length > maxPts) {
    issues.push({ level: 'erro', code: 'muitos-pontos', message: `A pista tem ${pts.length} pontos (máximo ${maxPts}).`, fix: 'Remova pontos desnecessários.' });
    return issues;
  }
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.w) || Math.abs(p.x) > TRACK_LIMITS.maxCoord || Math.abs(p.y) > TRACK_LIMITS.maxCoord) {
      issues.push({ level: 'erro', code: 'ponto-invalido', message: 'Há pontos com coordenadas inválidas.', fix: 'Mova ou remova o ponto destacado.' });
      return issues;
    }
    if (p.w < TRACK_LIMITS.minWidth || p.w > TRACK_LIMITS.maxWidth) {
      issues.push({
        level: 'erro',
        code: 'largura',
        message: `Largura de ${p.w.toFixed(1)} m fora do limite (${TRACK_LIMITS.minWidth}–${TRACK_LIMITS.maxWidth} m).`,
        fix: 'Ajuste a largura do ponto destacado.',
        at: { x: p.x, y: p.y },
      });
    }
  }
  if (def.smooth) {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const d = Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
      if (d < 3) {
        issues.push({ level: 'aviso', code: 'pontos-colados', message: 'Dois pontos estão quase no mesmo lugar.', fix: 'Afaste ou remova um deles.', at: { x: a.x, y: a.y } });
      }
    }
  }
  let track: Track;
  try {
    track = buildTrack(def);
  } catch (e) {
    issues.push({ level: 'erro', code: 'construcao', message: (e as Error).message, fix: 'Revise os pontos da pista.' });
    return issues;
  }
  return issues.concat(validateBuiltTrack(track));
}

export function validateBuiltTrack(track: Track): TrackIssue[] {
  const issues: TrackIssue[] = [];
  const N = track.n;
  if (track.length < TRACK_LIMITS.minLength) {
    issues.push({ level: 'erro', code: 'curta', message: `Pista curta demais (${track.length.toFixed(0)} m; mínimo ${TRACK_LIMITS.minLength} m).`, fix: 'Afaste os pontos ou adicione novos trechos.' });
  }
  if (track.length > TRACK_LIMITS.maxLength) {
    issues.push({ level: 'erro', code: 'longa', message: `Pista longa demais (${track.length.toFixed(0)} m; máximo ${TRACK_LIMITS.maxLength} m).`, fix: 'Reduza o tamanho do circuito.' });
  }

  // Curvas: borda interna dobrada, curva impossível e curva muito fechada.
  let worstFold = -1;
  let worstImpossible = -1;
  let worstTight = -1;
  for (let i = 0; i < N; i++) {
    const k = Math.abs(track.curv[i]);
    if (k <= 0) continue;
    const r = 1 / k;
    if (r < track.hw[i] * 1.08) {
      if (worstFold < 0 || k > Math.abs(track.curv[worstFold])) worstFold = i;
    } else if (r < TRACK_LIMITS.minDrivableRadius) {
      if (worstImpossible < 0 || k > Math.abs(track.curv[worstImpossible])) worstImpossible = i;
    } else if (r < TRACK_LIMITS.tightRadiusWarning) {
      if (worstTight < 0 || k > Math.abs(track.curv[worstTight])) worstTight = i;
    }
  }
  if (worstFold >= 0) {
    issues.push({
      level: 'erro',
      code: 'borda-dobrada',
      message: `Curva com raio de ${(1 / Math.abs(track.curv[worstFold])).toFixed(1)} m é fechada demais para a largura: a borda interna se dobra.`,
      fix: 'Abra a curva (afaste os pontos) ou diminua a largura nesse trecho.',
      at: { x: track.cx[worstFold], y: track.cy[worstFold] },
    });
  }
  if (worstImpossible >= 0) {
    issues.push({
      level: 'erro',
      code: 'curva-impossivel',
      message: `Curva com raio de ${(1 / Math.abs(track.curv[worstImpossible])).toFixed(1)} m: mais fechada do que o carro consegue virar.`,
      fix: `Deixe o raio maior que ${TRACK_LIMITS.minDrivableRadius} m afastando os pontos da curva.`,
      at: { x: track.cx[worstImpossible], y: track.cy[worstImpossible] },
    });
  }
  if (worstTight >= 0) {
    issues.push({
      level: 'aviso',
      code: 'curva-fechada',
      message: `Curva muito fechada (raio ${(1 / Math.abs(track.curv[worstTight])).toFixed(1)} m). Os pilotos vão precisar frear bastante.`,
      fix: 'Pode manter, mas teste a pista. Para facilitar, abra a curva.',
      at: { x: track.cx[worstTight], y: track.cy[worstTight] },
    });
  }

  // Bordas que se cruzam (trechos sobrepostos ou laço).
  const g = track.grid;
  const segs = g.segs;
  const cand = new Int32Array(4096);
  let crossAt: { x: number; y: number } | null = null;
  outer: for (let i = 0; i < g.segCount; i++) {
    const o = i * 4;
    const x1 = segs[o],
      y1 = segs[o + 1],
      x2 = segs[o + 2],
      y2 = segs[o + 3];
    const n = queryBox(g, Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2), cand);
    for (let k = 0; k < n; k++) {
      const j = cand[k];
      if (j <= i) continue;
      // ignora vizinhos na mesma borda
      const sameSide = i < N === j < N;
      if (sameSide) {
        const di = Math.abs((i % N) - (j % N));
        if (di <= 1 || di >= N - 1) continue;
      }
      const p = j * 4;
      if (segmentsCrossProper(x1, y1, x2, y2, segs[p], segs[p + 1], segs[p + 2], segs[p + 3])) {
        crossAt = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
        break outer;
      }
    }
  }
  if (crossAt) {
    issues.push({
      level: 'erro',
      code: 'cruzamento',
      message: 'As bordas se cruzam: dois trechos da pista se encostam ou se sobrepõem.',
      fix: 'Afaste os trechos destacados ou reduza a largura. Cruzamentos não são permitidos nesta versão.',
      at: crossAt,
    });
  } else {
    // Trechos distantes no percurso, mas próximos no mapa (pista encostando em si mesma).
    let closeAt: { x: number; y: number } | null = null;
    const step = 2;
    for (let i = 0; i < N && !closeAt; i += step) {
      for (let j = i + step; j < N; j += step) {
        const ds = Math.min(j - i, N - (j - i)) * track.spacing;
        const need = track.hw[i] + track.hw[j] + 3;
        if (ds < need * 2.2) continue;
        const dx = track.cx[i] - track.cx[j];
        const dy = track.cy[i] - track.cy[j];
        if (dx * dx + dy * dy < need * need) {
          closeAt = { x: (track.cx[i] + track.cx[j]) / 2, y: (track.cy[i] + track.cy[j]) / 2 };
          break;
        }
      }
    }
    if (closeAt) {
      issues.push({
        level: 'erro',
        code: 'trechos-proximos',
        message: 'Dois trechos da pista estão encostados.',
        fix: 'Deixe pelo menos 3 m de grama entre trechos diferentes.',
        at: closeAt,
      });
    }
  }

  // Largada: deve estar num trecho com pouca curva.
  let startK = 0;
  const win = Math.ceil(20 / track.spacing);
  for (let d = -win; d <= win; d++) startK = Math.max(startK, Math.abs(track.curv[(d + N) % N]));
  if (startK > 1 / 35) {
    issues.push({
      level: 'aviso',
      code: 'largada-curva',
      message: 'A largada fica dentro de uma curva.',
      fix: 'Escolha como largada um ponto numa reta.',
      at: { x: track.cx[0], y: track.cy[0] },
    });
  }
  return issues;
}

export function hasErrors(issues: TrackIssue[]): boolean {
  return issues.some((i) => i.level === 'erro');
}
