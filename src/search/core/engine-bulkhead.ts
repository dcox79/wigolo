import { createLogger } from '../../logger.js';

const log = createLogger('search');

interface BulkheadConfig {
  limit: number;
  /** Minimum spacing between actual upstream dispatches. Marginalia needs
   * this in addition to a concurrency limit: retries must not bypass it. */
  minIntervalMs?: number;
}

const BULKHEAD_CONFIG = new Map<string, BulkheadConfig>([
  ['marginalia', { limit: 1, minIntervalMs: 2_000 }],
  ['mojeek', { limit: 1 }],
  ['bing', { limit: 2 }],
  ['duckduckgo', { limit: 2 }],
]);

const ENGINE_GROUP_ALIASES = new Map<string, string>([
  ['bing-news', 'bing'],
  ['bing_news', 'bing'],
  ['ddg-image', 'duckduckgo'],
]);

interface Waiter {
  signal?: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (reason: unknown) => void;
  onAbort?: () => void;
}

interface BulkheadState {
  engine: string;
  limit: number;
  minIntervalMs: number;
  inFlight: number;
  queue: Waiter[];
  nextAllowedAt: number;
  lastStartedAt: number;
  wakeTimer?: ReturnType<typeof setTimeout>;
}

export interface EngineBulkheadSnapshot {
  engine: string;
  /** Null means this engine has only a quota gate, not a concurrency cap. */
  limit: number | null;
  inFlight: number;
  queued: number;
  /** Epoch milliseconds. Zero means no upstream backoff is active. */
  nextAllowedAt: number;
}

const states = new Map<string, BulkheadState>();
const concurrencyLimitedReasons = new WeakSet<object>();

function groupFor(engine: string): string {
  const normalized = engine.toLowerCase();
  return ENGINE_GROUP_ALIASES.get(normalized) ?? normalized;
}

function stateFor(engine: string, createQuotaOnly = false): BulkheadState | undefined {
  const group = groupFor(engine);
  const existing = states.get(group);
  if (existing) return existing;
  const config = BULKHEAD_CONFIG.get(group);
  if (!config && !createQuotaOnly) return undefined;
  const state: BulkheadState = {
    engine: group,
    limit: config?.limit ?? Number.MAX_SAFE_INTEGER,
    minIntervalMs: config?.minIntervalMs ?? 0,
    inFlight: 0,
    queue: [],
    nextAllowedAt: 0,
    lastStartedAt: 0,
  };
  states.set(group, state);
  return state;
}

function markConcurrencyLimited(reason: unknown): unknown {
  if ((typeof reason === 'object' && reason !== null) || typeof reason === 'function') {
    concurrencyLimitedReasons.add(reason as object);
    return reason;
  }
  const wrapped = new DOMException(String(reason ?? 'engine queue cancelled'), 'AbortError');
  concurrencyLimitedReasons.add(wrapped);
  return wrapped;
}

/** True when an abort happened while waiting for an engine-capacity slot. */
export function isConcurrencyLimitedError(error: unknown): boolean {
  return ((typeof error === 'object' && error !== null) || typeof error === 'function')
    ? concurrencyLimitedReasons.has(error as object)
    : false;
}

function readyAt(state: BulkheadState): number {
  const spacingAt = state.lastStartedAt > 0
    ? state.lastStartedAt + state.minIntervalMs
    : 0;
  return Math.max(state.nextAllowedAt, spacingAt);
}

function detachAbort(waiter: Waiter): void {
  if (waiter.signal && waiter.onAbort) {
    waiter.signal.removeEventListener('abort', waiter.onAbort);
  }
}

function makeRelease(state: BulkheadState): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.inFlight = Math.max(0, state.inFlight - 1);
    pump(state);
  };
}

function scheduleWake(state: BulkheadState, at: number): void {
  if (state.wakeTimer) clearTimeout(state.wakeTimer);
  const delay = Math.max(0, at - Date.now());
  state.wakeTimer = setTimeout(() => {
    state.wakeTimer = undefined;
    pump(state);
  }, delay);
}

function pump(state: BulkheadState): void {
  if (state.queue.length === 0 || state.inFlight >= state.limit) return;

  const availableAt = readyAt(state);
  if (Date.now() < availableAt) {
    scheduleWake(state, availableAt);
    return;
  }

  while (state.inFlight < state.limit && state.queue.length > 0) {
    const waiter = state.queue.shift()!;
    detachAbort(waiter);
    if (waiter.signal?.aborted) {
      waiter.reject(markConcurrencyLimited(waiter.signal.reason));
      continue;
    }
    state.inFlight += 1;
    state.lastStartedAt = Date.now();
    waiter.resolve(makeRelease(state));

    // Enforce spacing between starts even when the capacity limit is > 1.
    if (state.minIntervalMs > 0) {
      if (state.queue.length > 0 && state.inFlight < state.limit) {
        scheduleWake(state, readyAt(state));
      }
      break;
    }
  }
}

async function acquire(engine: string, signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) throw signal.reason;
  const state = stateFor(engine, true);
  if (!state) return () => {};

  if (state.queue.length === 0 && state.inFlight < state.limit && Date.now() >= readyAt(state)) {
    state.inFlight += 1;
    state.lastStartedAt = Date.now();
    return makeRelease(state);
  }

  log.debug('engine concurrency limited', {
    engine: state.engine,
    inFlight: state.inFlight,
    limit: state.limit,
    queued: state.queue.length + 1,
  });

  return new Promise<() => void>((resolve, reject) => {
    const waiter: Waiter = { signal, resolve, reject };
    if (signal) {
      waiter.onAbort = () => {
        const index = state.queue.indexOf(waiter);
        if (index >= 0) state.queue.splice(index, 1);
        detachAbort(waiter);
        if (state.queue.length === 0 && state.wakeTimer) {
          clearTimeout(state.wakeTimer);
          state.wakeTimer = undefined;
        }
        reject(markConcurrencyLimited(signal.reason));
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    }
    state.queue.push(waiter);
    pump(state);
  });
}

/** Run one upstream call behind the process-wide capacity gate for its engine. */
export async function withEngineBulkhead<T>(
  engine: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await acquire(engine, signal);
  try {
    signal?.throwIfAborted();
    return await operation();
  } finally {
    release();
  }
}

/** Record an upstream quota window before releasing the active slot. Queued
 * callers cannot slip through: pump() observes nextAllowedAt synchronously. */
export function recordEngineRateLimit(
  engine: string,
  retryAfterMs: number,
  nowMs = Date.now(),
): void {
  const state = stateFor(engine, true);
  if (!state) return;
  state.nextAllowedAt = Math.max(state.nextAllowedAt, nowMs + Math.max(0, retryAfterMs));
  if (state.queue.length > 0) scheduleWake(state, readyAt(state));
  log.warn('engine rate limited', {
    engine: state.engine,
    retryAfterMs,
    nextAllowedAt: state.nextAllowedAt,
  });
}

export function getEngineBulkheadSnapshot(): EngineBulkheadSnapshot[] {
  const engines = new Set([...BULKHEAD_CONFIG.keys(), ...states.keys()]);
  return [...engines].sort().map((engine) => {
    const state = states.get(engine);
    const config = BULKHEAD_CONFIG.get(engine);
    return {
      engine,
      limit: config?.limit ?? null,
      inFlight: state?.inFlight ?? 0,
      queued: state?.queue.length ?? 0,
      nextAllowedAt: state && state.nextAllowedAt > Date.now() ? state.nextAllowedAt : 0,
    };
  });
}

/** Test-only reset. Rejects queued calls so a test cannot leak promises. */
export function resetEngineBulkheads(): void {
  for (const state of states.values()) {
    if (state.wakeTimer) clearTimeout(state.wakeTimer);
    for (const waiter of state.queue.splice(0)) {
      detachAbort(waiter);
      waiter.reject(new DOMException('engine bulkhead reset', 'AbortError'));
    }
  }
  states.clear();
}

export const resetEngineBulkheadsForTest = resetEngineBulkheads;
