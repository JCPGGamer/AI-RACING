import { float32ToBase64 } from '../src/core/nn.ts';
import { parseSubmission, runOfficial } from '../src/core/official.ts';
import { END_REASON_LABEL } from '../src/core/sim.ts';

/** Resultado da validação oficial de um envio (sem acesso ao banco). */
export type ValidationOutcome =
  | { status: 'rejeitado'; message: string }
  | { status: 'nao_concluiu'; progress: number; time: number; message: string }
  | { status: 'aprovado'; time: number; steps: number; replay: { meta: unknown; frames: string } };

/**
 * Valida o formato e executa a tentativa oficial com o mesmo núcleo do jogo.
 * O tempo é sempre o tempo simulado — nunca o tempo de processamento.
 */
export function validatePayload(payload: unknown): ValidationOutcome {
  const parsed = parseSubmission(payload);
  if (!parsed.ok) return { status: 'rejeitado', message: parsed.error };
  const run = runOfficial(parsed.brain, parsed.track, parsed.pilotName);
  if (!run.result.completed) {
    return {
      status: 'nao_concluiu',
      progress: run.result.progress,
      time: run.result.time,
      message: `${END_REASON_LABEL[run.result.reason]} com ${(run.result.progress * 100).toFixed(1)}% da volta.`,
    };
  }
  return {
    status: 'aprovado',
    time: run.result.time,
    steps: run.steps,
    replay: { meta: run.replay.meta, frames: float32ToBase64(run.replay.frames) },
  };
}
