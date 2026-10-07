import { scoreTerms } from '../core/rewards.ts';
import type { Trainer, ChampionRecord } from '../core/trainer.ts';
import { CAR_STRIDE, KIND_CODE, STATUS_CODE, type ChampionSummary, type LiveFrame, type SelectedCarInfo } from './protocol.ts';

/** Monta um quadro resumido da geração em andamento. */
export function buildFrame(tr: Trainer, selected: number, events: LiveFrame['events'], stepsPerSec: number): LiveFrame {
  const sim = tr.sim;
  const n = sim.cars.length;
  const cars = new Float32Array(n * CAR_STRIDE);
  let leader = -1;
  let leaderProg = -Infinity;
  let anyLeader = 0;
  let anyProg = -Infinity;
  for (let i = 0; i < n; i++) {
    const c = sim.cars[i];
    const o = i * CAR_STRIDE;
    cars[o] = c.phys.x;
    cars[o + 1] = c.phys.y;
    cars[o + 2] = c.phys.heading;
    cars[o + 3] = STATUS_CODE[c.status];
    cars[o + 4] = c.phys.speed;
    cars[o + 5] = KIND_CODE[tr.population[i]?.kind ?? 'novo'];
    cars[o + 6] = tr.population[i]?.id ?? i;
    const p = c.status === 'completou' ? Infinity : c.maxProgress;
    if (c.status === 'correndo' && p > leaderProg) {
      leaderProg = p;
      leader = i;
    }
    if (p > anyProg) {
      anyProg = p;
      anyLeader = i;
    }
  }
  if (leader < 0) leader = anyLeader;
  const live = tr.liveSummary();
  return {
    gen: tr.generation,
    trackIdx: tr.trackIdx,
    trackId: sim.track.def.id,
    step: sim.step,
    time: sim.step * sim.dt,
    cars,
    alive: sim.alive,
    total: n,
    leader,
    bestProgress: live.bestProgress,
    completed: live.completed,
    bestLap: live.bestLap,
    selected: selected >= 0 && selected < n ? selectedInfo(tr, selected) : null,
    events,
    stepsPerSec,
  };
}

function selectedInfo(tr: Trainer, i: number): SelectedCarInfo {
  const sim = tr.sim;
  const c = sim.cars[i];
  const ind = tr.population[i];
  const stats = sim.statsOf(i);
  const terms = scoreTerms(stats, tr.config.rewards);
  return {
    index: i,
    id: ind?.id ?? i,
    kind: ind?.kind ?? 'novo',
    parents: ind?.parents ?? [],
    status: c.status,
    inputs: Array.from(c.input),
    outputs: Array.from(c.output),
    rays: Array.from(c.rays),
    hidden: c.net.activations().map((a) => Array.from(a)),
    speed: c.phys.speed,
    progress: c.status === 'completou' ? 1 : Math.max(0, c.maxProgress / sim.track.lapDistance),
    time: c.time,
    lapTime: Number.isFinite(c.lapTime) ? c.lapTime : null,
    terms,
    score: terms.reduce((s, t) => s + t.value, 0),
  };
}

export function championSummary(c: ChampionRecord | null): ChampionSummary | null {
  if (!c) return null;
  return { id: c.id, generation: c.generation, score: c.score, official: c.official, genome: c.genome.slice(), replay: c.replay };
}
