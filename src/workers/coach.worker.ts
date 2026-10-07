import { Coach } from '../core/coach.ts';
import { buildFrame } from './frames.ts';
import { soon } from './yield.ts';
import type { CoachIn, CoachOut, CoachProgressMsg } from './protocol.ts';

/** Worker da IA treinadora: roda experimentos em velocidade máxima, em fatias curtas. */

const ctx = self as unknown as { postMessage(m: CoachOut, t?: Transferable[]): void; onmessage: ((e: MessageEvent<CoachIn>) => void) | null };

let coach: Coach | null = null;
let running = false;
let view = false;
let sentMessages = 0;
let sentCandidates = 0;
let lastPost = 0;
let queued = false;

function progress(): CoachProgressMsg {
  return coach!.progress();
}

function postProgress(force = false) {
  if (!coach) return;
  const now = performance.now();
  if (!force && now - lastPost < (view ? 60 : 250)) return;
  lastPost = now;
  const newMessages = coach.messages.slice(sentMessages);
  sentMessages = coach.messages.length;
  const tr = coach.trainer;
  const frame = view && tr ? buildFrame(tr, -1, [], 0) : null;
  ctx.postMessage(
    { type: 'progress', progress: progress(), newMessages, frame, currentTrackId: tr ? tr.sim.track.def.id : null },
    frame ? [frame.cars.buffer] : [],
  );
  if (coach.candidates.length !== sentCandidates) {
    sentCandidates = coach.candidates.length;
    ctx.postMessage({ type: 'candidates', candidates: coach.candidates, bestIndex: coach.bestIndex });
  }
}

function loop() {
  queued = false;
  if (!coach || !running) return;
  const t0 = performance.now();
  let more = true;
  while (performance.now() - t0 < 30 && more) more = coach.advance(view ? 3000 : 20000);
  postProgress(!more);
  if (!more) {
    running = false;
    ctx.postMessage({ type: 'state', running: false });
    ctx.postMessage({ type: 'done', snapshot: coach.snapshot(), stopReason: coach.stopReason });
    return;
  }
  queued = true;
  soon(loop);
}

ctx.onmessage = (e) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'init':
        running = false;
        coach = m.snapshot ? Coach.fromSnapshot(m.snapshot) : new Coach(m.config, m.trackDefs);
        sentMessages = coach.messages.length;
        sentCandidates = coach.candidates.length;
        ctx.postMessage({ type: 'ready', messages: coach.messages, candidates: coach.candidates, bestIndex: coach.bestIndex, finished: coach.finished, progress: progress() });
        break;
      case 'run':
        if (!coach || coach.finished) return;
        running = true;
        ctx.postMessage({ type: 'state', running: true });
        if (!queued) {
          queued = true;
          soon(loop);
        }
        break;
      case 'pause':
        running = false;
        ctx.postMessage({ type: 'state', running: false });
        postProgress(true);
        break;
      case 'cancel':
        if (!coach) return;
        running = false;
        coach.cancel();
        postProgress(true);
        ctx.postMessage({ type: 'state', running: false });
        ctx.postMessage({ type: 'done', snapshot: coach.snapshot(), stopReason: coach.stopReason });
        break;
      case 'view':
        view = m.on;
        break;
      case 'snapshot':
        if (!coach) return;
        ctx.postMessage({ type: 'snapshot', reqId: m.reqId, snapshot: coach.snapshot() });
        break;
    }
  } catch (err) {
    running = false;
    ctx.postMessage({ type: 'error', message: (err as Error).message });
  }
};
