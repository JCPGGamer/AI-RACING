import { BUILTIN_TRACKS } from '../src/core/builtinTracks.ts';
import { buildTrack, trackSummary } from '../src/core/track.ts';
import { validateTrackDef } from '../src/core/trackValidation.ts';

for (const def of BUILTIN_TRACKS) {
  const t = buildTrack(def);
  const s = trackSummary(t);
  const issues = validateTrackDef(def);
  console.log(def.id, 'len', s.length.toFixed(1), 'w', s.minWidth.toFixed(1), '-', s.maxWidth.toFixed(1), 'minR', s.minRadius.toFixed(1), 'cps', s.checkpoints, 'bounds', Math.round(t.bounds.maxX - t.bounds.minX), 'x', Math.round(t.bounds.maxY - t.bounds.minY), 'hash', t.hash);
  for (const i of issues) console.log('   ', i.level, i.code, i.message);
}
