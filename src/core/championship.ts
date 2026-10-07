import { compareMulti, evaluateBrain, type MultiResult } from './evaluation.ts';
import type { Brain } from './nn.ts';
import type { Replay } from './replay.ts';
import { CONSISTENCY_STARTS, officialRules } from './rules.ts';
import { usesTrackInfo } from './sensors.ts';
import { buildTrack, type TrackDef } from './track.ts';

/**
 * Campeonatos locais: vários pilotos, várias pistas, regras comuns.
 * Em cada pista a classificação usa os critérios oficiais de várias tentativas.
 * Pontos por posição: 25, 18, 15, 12, 10, 8, 6, 4, 2, 1.
 */

export const CHAMPIONSHIP_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

export const CHAMPIONSHIP_CRITERIA = [
  'Mais pontos somados nas pistas.',
  'Mais vitórias.',
  'Maior taxa de conclusão geral.',
  'Menor soma das posições.',
];

export interface ChampionshipConfig {
  name: string;
  pilotIds: string[];
  trackIds: string[];
  /** Tentativas por pista (largadas padronizadas) */
  attempts: 1 | 3 | 5;
  /** Permite pilotos que usam informações da pista */
  allowTrackInfo: boolean;
}

export interface ChampionshipEntry {
  pilotId: string;
  name: string;
  color: string;
  brain: Brain;
}

export interface TrackStanding {
  pilotId: string;
  rank: number;
  points: number;
  result: MultiResult;
}

export interface ChampionshipTrackResult {
  trackId: string;
  trackName: string;
  standings: TrackStanding[];
  replays: Record<string, Replay>;
}

export interface OverallStanding {
  pilotId: string;
  name: string;
  color: string;
  points: number;
  wins: number;
  completionRate: number;
  rankSum: number;
  rank: number;
}

export interface ChampionshipResult {
  config: ChampionshipConfig;
  date: number;
  tracks: ChampionshipTrackResult[];
  overall: OverallStanding[];
  excluded: { pilotId: string; name: string; reason: string }[];
}

export function runChampionship(
  entries: ChampionshipEntry[],
  trackDefs: TrackDef[],
  config: ChampionshipConfig,
  onProgress?: (done: number, total: number, label: string) => void,
  shouldCancel?: () => boolean,
): ChampionshipResult {
  const excluded: ChampionshipResult['excluded'] = [];
  const pilots = entries.filter((e) => {
    if (!config.allowTrackInfo && usesTrackInfo(e.brain.inputs)) {
      excluded.push({ pilotId: e.pilotId, name: e.name, reason: 'Usa informações da pista, que estas regras não permitem.' });
      return false;
    }
    return true;
  });
  const starts = CONSISTENCY_STARTS.slice(0, config.attempts);
  const total = pilots.length * trackDefs.length;
  let done = 0;
  const tracks: ChampionshipTrackResult[] = [];
  for (const def of trackDefs) {
    const track = buildTrack(def);
    const rules = officialRules(track);
    const rows: { pilotId: string; result: MultiResult }[] = [];
    const replays: Record<string, Replay> = {};
    for (const p of pilots) {
      if (shouldCancel?.()) throw new Error('cancelado');
      onProgress?.(done, total, `${p.name} em ${def.name}`);
      const out = evaluateBrain(p.brain, track, rules, starts, true);
      rows.push({ pilotId: p.pilotId, result: out.result });
      const rep = out.replays[0];
      if (rep) {
        rep.meta.pilotName = p.name;
        rep.meta.color = p.color;
        replays[p.pilotId] = rep;
      }
      done++;
    }
    rows.sort((a, b) => compareMulti(a.result, b.result));
    const standings: TrackStanding[] = [];
    rows.forEach((r, i) => {
      // empates exatos dividem a mesma posição
      const rank = i > 0 && compareMulti(r.result, rows[i - 1].result) === 0 ? standings[i - 1].rank : i + 1;
      const pts = r.result.meanProgress > 0 ? CHAMPIONSHIP_POINTS[rank - 1] ?? 0 : 0;
      standings.push({ pilotId: r.pilotId, rank, points: pts, result: r.result });
    });
    tracks.push({ trackId: def.id, trackName: def.name, standings, replays });
  }
  onProgress?.(total, total, 'Concluído');
  const overall: OverallStanding[] = pilots.map((p) => {
    let points = 0,
      wins = 0,
      rankSum = 0,
      comp = 0;
    for (const t of tracks) {
      const s = t.standings.find((x) => x.pilotId === p.pilotId)!;
      points += s.points;
      if (s.rank === 1) wins++;
      rankSum += s.rank;
      comp += s.result.completionRate;
    }
    return { pilotId: p.pilotId, name: p.name, color: p.color, points, wins, completionRate: tracks.length ? comp / tracks.length : 0, rankSum, rank: 0 };
  });
  overall.sort((a, b) => b.points - a.points || b.wins - a.wins || b.completionRate - a.completionRate || a.rankSum - b.rankSum);
  overall.forEach((o, i) => {
    const prev = overall[i - 1];
    // empate em todos os critérios divide a posição
    const tied = prev && prev.points === o.points && prev.wins === o.wins && Math.abs(prev.completionRate - o.completionRate) < 1e-9 && prev.rankSum === o.rankSum;
    o.rank = tied ? prev.rank : i + 1;
  });
  return { config, date: Date.now(), tracks, overall, excluded };
}
