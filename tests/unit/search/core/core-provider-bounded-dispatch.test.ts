import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawSearchResult } from '../../../../src/types.js';
import { resetConfig } from '../../../../src/config.js';

const runV1Search = vi.fn();
vi.mock('../../../../src/search/core/orchestrator.js', () => ({ runV1Search }));
vi.mock('../../../../src/search/content-fetch.js', () => ({ fetchContentForResults: vi.fn(async () => {}) }));

const { CoreSearchProvider } = await import('../../../../src/search/core/core-provider.js');

function dispatch(query: string) {
  const result: RawSearchResult = {
    title: query,
    url: `https://example.com/${encodeURIComponent(query)}`,
    snippet: query,
    relevance_score: 1,
    engine: 'mock',
  };
  return { results: [result], enginesUsed: ['mock'], outcomes: [], degraded: false };
}

describe('CoreSearchProvider bounded query dispatch', () => {
  const originalMax = process.env.WIGOLO_MULTI_QUERY_MAX;
  const originalConcurrency = process.env.WIGOLO_MULTI_QUERY_CONCURRENCY;

  beforeEach(() => {
    runV1Search.mockReset();
    process.env.WIGOLO_MULTI_QUERY_MAX = '5';
    process.env.WIGOLO_MULTI_QUERY_CONCURRENCY = '2';
    resetConfig();
  });

  afterEach(() => {
    if (originalMax === undefined) delete process.env.WIGOLO_MULTI_QUERY_MAX;
    else process.env.WIGOLO_MULTI_QUERY_MAX = originalMax;
    if (originalConcurrency === undefined) delete process.env.WIGOLO_MULTI_QUERY_CONCURRENCY;
    else process.env.WIGOLO_MULTI_QUERY_CONCURRENCY = originalConcurrency;
    resetConfig();
  });

  it('never runs more than two of five query variants concurrently', async () => {
    let active = 0;
    let peak = 0;
    runV1Search.mockImplementation(async ({ query }: { query: string }) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return dispatch(query);
    });

    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: ['q1', 'q2', 'q3', 'q4', 'q5'], force_refresh: true, search_depth: 'fast' },
      { router: undefined } as never,
    );

    expect(out.ok).toBe(true);
    expect(runV1Search).toHaveBeenCalledTimes(5);
    expect(peak).toBe(2);
  });

  it('caps the final post-rewrite dispatch list at the configured maximum', async () => {
    runV1Search.mockImplementation(async ({ query }: { query: string }) => dispatch(query));
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'], force_refresh: true, search_depth: 'fast' },
      { router: undefined } as never,
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(runV1Search).toHaveBeenCalledTimes(5);
    expect(out.data.queries_executed).toEqual(['q1', 'q2', 'q3', 'q4', 'q5']);
  });

  it('applies the cap after an automatic variant is generated', async () => {
    process.env.WIGOLO_MULTI_QUERY_MAX = '1';
    resetConfig();
    runV1Search.mockImplementation(async ({ query }: { query: string }) => dispatch(query));

    const provider = new CoreSearchProvider();
    const original = 'how do I fix ERR_MODULE_NOT_FOUND in node';
    const out = await provider.search(
      { query: original, force_refresh: true, search_depth: 'fast' },
      { router: undefined } as never,
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(runV1Search).toHaveBeenCalledOnce();
    expect(runV1Search.mock.calls[0]?.[0]).toMatchObject({ query: original });
    expect(out.data.queries_executed).toEqual([original]);
  });

  it('starts no queued variants after request cancellation', async () => {
    process.env.WIGOLO_MULTI_QUERY_CONCURRENCY = '1';
    resetConfig();
    const controller = new AbortController();
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });

    runV1Search.mockImplementation(async ({ query }: { query: string }) => {
      firstStarted();
      await release;
      return dispatch(query);
    });

    const provider = new CoreSearchProvider();
    const pending = provider.search(
      { query: ['q1', 'q2', 'q3'], force_refresh: true, search_depth: 'fast' },
      { router: undefined, signal: controller.signal } as never,
    );
    await started;
    controller.abort();
    releaseFirst();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(runV1Search).toHaveBeenCalledTimes(1);
  });

  it('aborts active siblings and starts no queued variants after a worker failure', async () => {
    let secondStarted!: () => void;
    const secondIsActive = new Promise<void>((resolve) => { secondStarted = resolve; });
    let siblingSignal: AbortSignal | undefined;
    runV1Search.mockImplementation(async (input: { query: string; signal: AbortSignal }) => {
      if (input.query === 'q1') {
        await secondIsActive;
        throw new Error('unexpected variant failure');
      }
      if (input.query === 'q2') {
        siblingSignal = input.signal;
        secondStarted();
        return new Promise((_resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
        });
      }
      return dispatch(input.query);
    });

    const provider = new CoreSearchProvider();
    await expect(provider.search(
      { query: ['q1', 'q2', 'q3', 'q4'], force_refresh: true, search_depth: 'fast' },
      { router: undefined } as never,
    )).rejects.toThrow('unexpected variant failure');

    expect(runV1Search).toHaveBeenCalledTimes(2);
    expect(siblingSignal?.aborted).toBe(true);
  });

  it('shares one recovery-wave budget across all variants in a top-level request', async () => {
    let recoveryWaves = 0;
    runV1Search.mockImplementation(async (input: { query: string; recoveryBudget: { claimed: boolean } }) => {
      if (!input.recoveryBudget.claimed) {
        input.recoveryBudget.claimed = true;
        recoveryWaves++;
      }
      return dispatch(input.query);
    });

    const provider = new CoreSearchProvider();
    await provider.search(
      { query: ['q1', 'q2', 'q3', 'q4', 'q5'], force_refresh: true, search_depth: 'fast' },
      { router: undefined } as never,
    );

    expect(recoveryWaves).toBe(1);
  });
});
