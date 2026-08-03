import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawSearchResult, SearchEngine } from '../../../src/types.js';
import {
  getLiveEngineStateSnapshot,
  resetBreakers,
  runEnginesParallel,
  wrapWithRetryAndBreaker,
} from '../../../src/search/core/engine-base.js';
import {
  getEngineBulkheadSnapshot,
  isConcurrencyLimitedError,
  withEngineBulkhead,
} from '../../../src/search/core/engine-bulkhead.js';
import { MarginaliaEngine } from '../../../src/search/engines/marginalia.js';
import {
  UpstreamHttpError,
  upstreamHttpErrorFromResponse,
} from '../../../src/search/engines/upstream-error.js';
import { DEFAULT_BACKOFF_MS, MAX_BACKOFF_MS } from '../../../src/fetch/politeness.js';

function result(engine: string): RawSearchResult {
  return {
    title: engine,
    url: `https://example.test/${engine}`,
    snippet: '',
    relevance_score: 1,
    engine,
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe('structured upstream HTTP errors', () => {
  beforeEach(() => resetBreakers());
  afterEach(() => {
    vi.restoreAllMocks();
    resetBreakers();
  });

  it('preserves status, engine, Retry-After, and retryability on 429', () => {
    const err = upstreamHttpErrorFromResponse(
      'marginalia',
      new Response('', { status: 429, headers: { 'Retry-After': '2' } }),
      Date.now(),
      () => 0,
    );

    expect(err).toBeInstanceOf(UpstreamHttpError);
    expect(err).toMatchObject({
      status: 429,
      engine: 'marginalia',
      retryAfterMs: 2_000,
      retryable: true,
    });
  });

  it('uses the shared safe default and clamp when Retry-After is absent or absurd', () => {
    const absent = upstreamHttpErrorFromResponse(
      'marginalia',
      new Response('', { status: 429 }),
      Date.now(),
      () => 0,
    );
    const absurd = upstreamHttpErrorFromResponse(
      'marginalia',
      new Response('', { status: 429, headers: { 'Retry-After': '99999' } }),
      Date.now(),
      () => 0,
    );

    expect(absent.retryAfterMs).toBe(DEFAULT_BACKOFF_MS);
    expect(absurd.retryAfterMs).toBe(MAX_BACKOFF_MS);
  });

  it('classifies ordinary 4xx as non-retryable and selected 5xx as retryable', () => {
    const notFound = upstreamHttpErrorFromResponse(
      'bing',
      new Response('', { status: 404 }),
    );
    const unavailable = upstreamHttpErrorFromResponse(
      'bing',
      new Response('', { status: 503 }),
    );

    expect(notFound.retryable).toBe(false);
    expect(unavailable.retryable).toBe(true);
  });

  it('does not expose upstream error text through live diagnostics state', async () => {
    const secretText = 'https://user:token@example.test/private?q=request-text';
    const wrapped = wrapWithRetryAndBreaker(
      {
        name: 'diagnostic-redaction',
        search: async () => { throw new Error(secretText); },
      },
      { retryAttempts: 1, failureThreshold: 1 },
    );
    await expect(wrapped.search('sensitive query')).rejects.toThrow(secretText);

    const row = getLiveEngineStateSnapshot().find((entry) => entry.engine === 'diagnostic-redaction');
    expect(row).toBeDefined();
    expect(JSON.stringify(row)).not.toContain(secretText);
    expect(row).not.toHaveProperty('lastError');
  });
});

describe('status-aware retry behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetBreakers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetBreakers();
  });

  it('does not retry an ordinary 4xx response', async () => {
    const search = vi.fn(async (): Promise<RawSearchResult[]> => {
      throw new UpstreamHttpError({
        engine: 'ordinary-4xx',
        status: 404,
        retryable: false,
      });
    });
    const wrapped = wrapWithRetryAndBreaker(
      { name: 'ordinary-4xx', search },
      { retryAttempts: 4, failureThreshold: 10 },
    );

    await expect(wrapped.search('q')).rejects.toMatchObject({ status: 404 });
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('retries a selected 5xx once after the normal network backoff', async () => {
    const search = vi.fn()
      .mockRejectedValueOnce(new UpstreamHttpError({
        engine: 'retry-503',
        status: 503,
        retryable: true,
      }))
      .mockResolvedValueOnce([result('retry-503')]);
    const wrapped = wrapWithRetryAndBreaker(
      { name: 'retry-503', search },
      { retryAttempts: 2, failureThreshold: 10 },
    );

    const pending = wrapped.search('q');
    await flushMicrotasks();
    expect(search).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toEqual([result('retry-503')]);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('honors Retry-After on 429 and never rotates a quota fingerprint', async () => {
    const search = vi.fn()
      .mockRejectedValueOnce(new UpstreamHttpError({
        engine: 'retry-429',
        status: 429,
        retryAfterMs: 2_000,
        retryable: true,
      }))
      .mockResolvedValueOnce([result('retry-429')]);
    const onRetry = vi.fn();
    const engine: SearchEngine & { onRetry: typeof onRetry } = {
      name: 'retry-429',
      search,
      onRetry,
    };
    const wrapped = wrapWithRetryAndBreaker(engine, {
      retryAttempts: 2,
      failureThreshold: 10,
    });

    const pending = wrapped.search('q');
    await flushMicrotasks();
    expect(search).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(search).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual([result('retry-429')]);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('permits at most one fingerprint-rotated 403 retry', async () => {
    const search = vi.fn(async (): Promise<RawSearchResult[]> => {
      throw new UpstreamHttpError({
        engine: 'retry-403',
        status: 403,
        retryable: true,
      });
    });
    const onRetry = vi.fn();
    const wrapped = wrapWithRetryAndBreaker(
      { name: 'retry-403', search, onRetry },
      { retryAttempts: 5, failureThreshold: 10 },
    );

    const pending = wrapped.search('q').catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    await pending;
    expect(search).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('process-wide engine bulkheads', () => {
  beforeEach(() => resetBreakers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetBreakers();
  });

  async function verifyLimit(engine: string, limit: number): Promise<void> {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const started: number[] = [];
    const total = limit + 1;

    const tasks = Array.from({ length: total }, (_, index) =>
      withEngineBulkhead(engine, undefined, async () => {
        active += 1;
        peak = Math.max(peak, active);
        started.push(index);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
      }),
    );

    await vi.waitFor(() => expect(started).toHaveLength(limit));
    expect(peak).toBe(limit);
    releases.shift()!();
    await vi.waitFor(() => expect(started).toHaveLength(total));
    for (const release of releases.splice(0)) release();
    await Promise.all(tasks);
    expect(peak).toBe(limit);
  }

  it('enforces Mojeek=1, Bing HTML=2, and DuckDuckGo HTML=2 process-wide', async () => {
    await verifyLimit('mojeek', 1);
    await verifyLimit('bing', 2);
    await verifyLimit('duckduckgo', 2);
  });

  it('enforces Marginalia=1 and its two-second gate between actual starts', async () => {
    vi.useFakeTimers();
    const releases: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    let started = 0;
    const operation = () => withEngineBulkhead('marginalia', undefined, async () => {
      active += 1;
      peak = Math.max(peak, active);
      started += 1;
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
    });

    const first = operation();
    const second = operation();
    await flushMicrotasks();
    expect(started).toBe(1);
    releases.shift()!();
    await flushMicrotasks();
    expect(started).toBe(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(started).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toBe(2);
    expect(peak).toBe(1);
    releases.shift()!();
    await Promise.all([first, second]);
  });

  it('cancels a queued waiter without leaking queue or capacity', async () => {
    let releaseFirst!: () => void;
    const first = withEngineBulkhead('mojeek', undefined, async () => {
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
    });
    await flushMicrotasks();

    const controller = new AbortController();
    const reason = new DOMException('caller cancelled', 'AbortError');
    const second = withEngineBulkhead('mojeek', controller.signal, async () => {});
    await flushMicrotasks();
    expect(getEngineBulkheadSnapshot().find((s) => s.engine === 'mojeek')).toMatchObject({
      inFlight: 1,
      queued: 1,
    });

    controller.abort(reason);
    await expect(second).rejects.toBe(reason);
    expect(isConcurrencyLimitedError(reason)).toBe(true);
    expect(getEngineBulkheadSnapshot().find((s) => s.engine === 'mojeek')).toMatchObject({
      inFlight: 1,
      queued: 0,
    });

    releaseFirst();
    await first;
    expect(getEngineBulkheadSnapshot().find((s) => s.engine === 'mojeek')?.inFlight).toBe(0);
  });

  it('records the first 429 before releasing capacity and gates the next adapter call', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', {
        status: 429,
        headers: { 'Retry-After': '2' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const engine = new MarginaliaEngine();
    await expect(engine.search('first')).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 2_000,
    });
    const live = getLiveEngineStateSnapshot().find((s) => s.engine === 'marginalia');
    expect(live?.nextAllowedAt).toBeGreaterThan(Date.now());

    const second = engine.search('second');
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('real soft-deadline cancellation and outcome reasons', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetBreakers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetBreakers();
  });

  it('aborts the adapter fetch when the pool soft deadline wins', async () => {
    let fetchSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      fetchSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        fetchSignal?.addEventListener('abort', () => reject(fetchSignal?.reason), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const pending = runEnginesParallel(
      [{ engine: new MarginaliaEngine() }],
      'hung',
      {},
      { softDeadlineMs: 100 },
    );
    await flushMicrotasks();
    expect(fetchSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    const [outcome] = await pending;

    expect(fetchSignal?.aborted).toBe(true);
    expect(outcome).toMatchObject({
      ok: false,
      timedOut: true,
      reason: 'soft_deadline',
    });
  });

  it('marks the one degraded recovery wave explicitly', async () => {
    const [outcome] = await runEnginesParallel(
      [{ engine: { name: 'probe', search: async () => [result('probe')] } }],
      'q',
      {},
      { recoveryProbe: true },
    );
    expect(outcome).toMatchObject({ ok: true, reason: 'recovery_probe' });
  });
});
