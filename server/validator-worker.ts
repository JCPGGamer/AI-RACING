import { parentPort, workerData } from 'node:worker_threads';
import { validatePayload } from './validate.ts';

/** Executa uma validação isolada numa thread (com limite de memória e tempo controlados pelo processo principal). */
try {
  const out = validatePayload(JSON.parse(workerData.payload as string));
  parentPort!.postMessage({ ok: true, out });
} catch (e) {
  parentPort!.postMessage({ ok: false, error: (e as Error).message });
}
