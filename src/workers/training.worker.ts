import { Trainer } from '../core/trainer.ts';
import { buildFrame, championSummary } from './frames.ts';
import { soon } from './yield.ts';
import type { LiveFrame, TrainingIn, TrainingOut } from './protocol.ts';

/**
 * Worker de treinamento. A simulação usa sempre o passo fixo de 1/60 s;
 * acelerar significa executar mais passos por segundo real.
 */

const ctx = self as unknown as { postMessage(m: TrainingOut, t?: Transferable[]): void; onmessage: ((e: MessageEvent<TrainingIn>) => void) | null };

let trainer: Trainer | null = null;
let running = false;
let speed: number | 'max' = 1;
let selected = -1;
let lastTick = 0;
let carry = 0;
let finishing = false;
let lowPower = false;
let lastFrame = 0;
let lastAutosave = 0;
let stepCounter = 0;
let rateWindowStart = 0;
let stepsPerSec = 0;
let pendingEvents: LiveFrame['events'] = [];
let loopTimer: ReturnType<typeof setTimeout> | null = null;
let loopQueued = false;

function post(m: TrainingOut, t?: Transferable[]) {
  ctx.postMessage(m, t);
}

function sendFrame() {
  if (!trainer) return;
  const f = buildFrame(trainer, selected, pendingEvents, stepsPerSec);
  pendingEvents = [];
  post({ type: 'frame', frame: f }, [f.cars.buffer]);
}

function onGeneration() {
  const tr = trainer!;
  const stats = tr.history[tr.history.length - 1];
  const deaths: Record<string, number[]> = {};
  for (const [k, v] of tr.deaths) deaths[k] = v.slice(-2000);
  post({
    type: 'generation',
    msg: {
      stats,
      results: tr.lastResults.slice(0, 60),
      bestReplay: tr.lastGenBestReplay,
      bestEver: championSummary(tr.bestEver),
      bestOfficial: championSummary(tr.bestOfficial),
      deaths,
      changes: tr.changes.slice(-50),
    },
  });
  const now = performance.now();
  // Salva em limite de geração; no modo máximo, no máximo uma vez por segundo.
  if (now - lastAutosave > 1000) {
    lastAutosave = now;
    post({ type: 'autosave', snapshot: tr.snapshot() });
  }
}

/** Avança n passos, coletando eventos. Devolve true se uma geração terminou. */
function stepN(n: number, collectEvents: boolean): boolean {
  const tr = trainer!;
  let genDone = false;
  for (let i = 0; i < n; i++) {
    const before = tr.sim;
    const out = tr.advance(1);
    stepCounter++;
    if (collectEvents && before.events.length && pendingEvents.length < 40) pendingEvents.push(...before.events);
    if (out.generationDone) {
      onGeneration();
      genDone = true;
      if (finishing) break;
    }
  }
  return genDone;
}

function updateRate(now: number) {
  if (now - rateWindowStart >= 500) {
    stepsPerSec = (stepCounter * 1000) / (now - rateWindowStart);
    stepCounter = 0;
    rateWindowStart = now;
  }
}

function loop() {
  loopTimer = null;
  loopQueued = false;
  if (!trainer || (!running && !finishing)) return;
  const now = performance.now();
  if (finishing || speed === 'max') {
    // Modo máximo: trabalha ~25 ms e devolve o controle (pausa responsiva).
    const t0 = performance.now();
    let done = false;
    while (performance.now() - t0 < 25) {
      if (stepN(16, false) && finishing) {
        done = true;
        break;
      }
    }
    updateRate(performance.now());
    const fNow = performance.now();
    if (fNow - lastFrame > (lowPower ? 100 : 40) || done) {
      lastFrame = fNow;
      sendFrame();
    }
    if (done) {
      finishing = false;
      running = false;
      post({ type: 'state', running, speed });
      lastAutosave = performance.now();
      post({ type: 'autosave', snapshot: trainer!.snapshot() });
      return;
    }
    loopQueued = true;
    soon(loop);
    return;
  }
  const dt = Math.min(0.25, (now - lastTick) / 1000);
  lastTick = now;
  const due = dt * 60 * speed + carry;
  const n = Math.floor(due);
  carry = due - n;
  if (n > 0) stepN(n, true);
  updateRate(now);
  if (now - lastFrame > (lowPower ? 60 : 15)) {
    lastFrame = now;
    sendFrame();
  }
  loopTimer = setTimeout(loop, lowPower ? 30 : 12);
}

function startLoop() {
  lastTick = performance.now();
  rateWindowStart = lastTick;
  stepCounter = 0;
  carry = 0;
  if (!loopTimer && !loopQueued) {
    loopQueued = true;
    soon(loop);
  }
}

ctx.onmessage = (e) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'init': {
        running = false;
        finishing = false;
        trainer = m.snapshot ? Trainer.fromSnapshot(m.snapshot) : new Trainer(m.config, m.trackDefs);
        selected = -1;
        post({
          type: 'ready',
          generation: trainer.generation,
          history: trainer.history,
          changes: trainer.changes,
          bestEver: championSummary(trainer.bestEver),
          bestOfficial: championSummary(trainer.bestOfficial),
          bestReplay: trainer.lastGenBestReplay,
          deaths: Object.fromEntries(trainer.deaths),
          config: trainer.config,
        });
        sendFrame();
        break;
      }
      case 'play':
        if (!trainer) return;
        speed = m.speed;
        running = true;
        post({ type: 'state', running, speed });
        startLoop();
        break;
      case 'pause':
        running = false;
        finishing = false;
        stepsPerSec = 0;
        post({ type: 'state', running, speed });
        sendFrame();
        break;
      case 'step':
        if (!trainer || running) return;
        stepN(1, true);
        sendFrame();
        break;
      case 'finishGen':
        if (!trainer) return;
        finishing = true;
        post({ type: 'state', running: true, speed: 'max' });
        startLoop();
        break;
      case 'select':
        selected = m.index;
        if (!running) sendFrame();
        break;
      case 'config': {
        if (!trainer) return;
        const r = trainer.requestConfig(m.config, m.trackDefs);
        post({ type: 'configResult', ok: r.ok, message: r.ok ? (r.warnings.length ? r.warnings.join(' ') : 'As mudanças entram no início da próxima geração.') : r.error });
        break;
      }
      case 'snapshot':
        if (!trainer) return;
        post({ type: 'snapshot', reqId: m.reqId, snapshot: trainer.snapshot() });
        break;
      case 'lowPower':
        lowPower = m.on;
        break;
    }
  } catch (err) {
    post({ type: 'error', message: (err as Error).message });
  }
};
