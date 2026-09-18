import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { extractSessionMeasures } from '../measures/extract.ts';
import type { ExtractionDependencies, SessionMeasure, MeasureMessage, LocalResolution } from '../measures/extract.ts';

type Request = { call: number; method: 'readMessages' | 'resolveLocally' | 'store'; identifiers?: string[]; measure?: SessionMeasure };

/** Scoring has no database/config imports in its thread. SQL and decryption stay
 * asynchronous on the attempt's private connection; synchronous scoring cannot
 * hold up another session's extraction or the deletion event loop. */
export function extractInThread(id: string, deps: ExtractionDependencies, signal: AbortSignal): Promise<SessionMeasure> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Measurement cancelled')); return; }
    const worker = new Worker(new URL(import.meta.url), { workerData: { id } });
    let settled = false;
    let failure: unknown;
    const finish = (error?: unknown, measure?: SessionMeasure) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      void worker.terminate();
      if (error) reject(error); else resolve(measure!);
    };
    const cancel = () => finish(new Error('Measurement cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    worker.once('error', error => finish(error));
    worker.once('exit', () => finish(new Error('Measurement thread exited')));
    worker.on('message', async (message: Request | { done: true; measure?: SessionMeasure }) => {
      if (settled) return;
      if ('done' in message) {
        finish(message.measure ? undefined : failure ?? new Error('Measurement failed'), message.measure);
        return;
      }
      try {
        const result = message.method === 'readMessages' ? await deps.readMessages(id)
          : message.method === 'resolveLocally' ? await deps.resolveLocally(message.identifiers!)
            : await deps.store(id, message.measure!);
        if (!settled) worker.postMessage({ call: message.call, result });
      } catch (error) {
        failure = error;
        if (!settled) worker.postMessage({ call: message.call, failed: true });
      }
    });
  });
}

if (!isMainThread && parentPort) {
  const port = parentPort;
  let next = 0;
  const calls = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
  const call = <T>(request: Omit<Request, 'call'>): Promise<T> => new Promise((resolve, reject) => {
    const number = ++next;
    calls.set(number, { resolve: result => resolve(result as T), reject });
    port.postMessage({ ...request, call: number });
  });
  port.on('message', (reply: { call: number; result: unknown; failed?: boolean }) => {
    const pending = calls.get(reply.call);
    if (!pending) return;
    calls.delete(reply.call);
    if (reply.failed) pending.reject(new Error('Measurement dependency failed'));
    else pending.resolve(reply.result);
  });
  void extractSessionMeasures(workerData.id, {
    readMessages: () => call<MeasureMessage[]>({ method: 'readMessages' }),
    resolveLocally: identifiers => call<LocalResolution>({ method: 'resolveLocally', identifiers }),
    store: (_id, measure) => call<void>({ method: 'store', measure }),
  }).then(measure => port.postMessage({ done: true, measure }), () => port.postMessage({ done: true }));
}
