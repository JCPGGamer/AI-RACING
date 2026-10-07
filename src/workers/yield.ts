/**
 * Agenda `fn` para logo depois das mensagens pendentes, sem o atraso mínimo
 * (e o estrangulamento em abas ocultas) do setTimeout. Mantém pausa e
 * cancelamento responsivos porque as mensagens da interface entram na fila
 * entre uma fatia de trabalho e outra.
 */
const channel = new MessageChannel();
let queued: (() => void) | null = null;
channel.port1.onmessage = () => {
  const fn = queued;
  queued = null;
  fn?.();
};

export function soon(fn: () => void): void {
  queued = fn;
  channel.port2.postMessage(0);
}
