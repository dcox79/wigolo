import type { SearchEngineOptions } from '../../types.js';
import { anySignal, timeoutSignal } from '../../util/abort.js';
import { withEngineBulkhead } from '../core/engine-bulkhead.js';

/** Compose caller cancellation with the adapter timeout, then hold the shared
 * engine bulkhead slot for fetch plus response-body parsing. */
export async function withEngineRequest<T>(
  engine: string,
  options: SearchEngineOptions,
  defaultTimeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const timeout = timeoutSignal(Math.max(0, timeoutMs), `${engine} upstream timeout`);
  const combined = options.signal
    ? anySignal([options.signal, timeout.signal])
    : undefined;
  const signal = combined?.signal ?? timeout.signal;

  try {
    return await withEngineBulkhead(engine, signal, () => operation(signal));
  } finally {
    combined?.cleanup();
    timeout.cancel();
  }
}
