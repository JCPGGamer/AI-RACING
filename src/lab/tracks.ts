import { BUILTIN_TRACKS } from '../core/builtinTracks.ts';
import type { CustomTrackRecord } from '../core/models.ts';
import { buildTrack, type Track, type TrackDef } from '../core/track.ts';
import { db } from '../persistence/db.ts';

/** Pistas prontas + pistas personalizadas (salvas no navegador). */

const builtCache = new Map<string, { def: TrackDef; track: Track }>();

export async function listTrackDefs(): Promise<TrackDef[]> {
  let custom: CustomTrackRecord[] = [];
  try {
    custom = await db.getAll<CustomTrackRecord>('tracks');
  } catch {
    /* sem armazenamento: só as prontas */
  }
  custom.sort((a, b) => b.updatedAt - a.updatedAt);
  return [...BUILTIN_TRACKS, ...custom.map((c) => c.def)];
}

export async function getTrackDef(id: string): Promise<TrackDef | undefined> {
  const b = BUILTIN_TRACKS.find((t) => t.id === id);
  if (b) return b;
  try {
    const r = await db.get<CustomTrackRecord>('tracks', id);
    return r?.def;
  } catch {
    return undefined;
  }
}

export async function resolveTrackDefs(ids: string[]): Promise<TrackDef[]> {
  const out: TrackDef[] = [];
  for (const id of ids) {
    const d = await getTrackDef(id);
    if (!d) throw new Error(`A pista "${id}" não foi encontrada. Ela pode ter sido excluída.`);
    out.push(d);
  }
  return out;
}

/** Pista construída com cache (a geometria estática é calculada uma vez). */
export function builtTrack(def: TrackDef): Track {
  const key = `${def.id}@${def.version}@${def.updatedAt ?? 0}`;
  const c = builtCache.get(key);
  if (c && c.def === def) return c.track;
  const track = buildTrack(def);
  builtCache.set(key, { def, track });
  if (builtCache.size > 30) builtCache.delete(builtCache.keys().next().value!);
  return track;
}
