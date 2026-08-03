import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfig } from '../../../src/config.js';
import type { SearchContext } from '../../../src/providers/search-provider.js';
import { runSearxngSearch } from '../../../src/search/legacy/searxng-orchestrator.js';
import type { SearchEngine } from '../../../src/types.js';

function longDecomposableQuery(parts = 7): string {
  return Array.from(
    { length: parts },
    (_, index) => `segment ${index} ${'bounded search phrase '.repeat(3)}`.trim(),
  ).join('. ');
}

function context(engines: SearchEngine[], signal?: AbortSignal): SearchContext {
  return {
    engines,
    router: undefined as never,
    signal,
  };
}

describe('legacy SearXNG string-query dispatch', () => {
  const originalMax = process.env.WIGOLO_MULTI_QUERY_MAX;
  const originalConcurrency = process.env.WIGOLO_MULTI_QUERY_CONCURRENCY;

  beforeEach(() => {
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

  it('caps decomposed variants at five and never exceeds concurrency two', async () => {
    let active = 0;
    let peak = 0;
    const search = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return [];
    });
    const engines: SearchEngine[] = [
      { name: 'searxng', search },
      { name: 'secondary', search },
    ];

    const out = await runSearxngSearch(
      { query: longDecomposableQuery(), force_refresh: true, include_content: false },
      context(engines),
    );

    expect(out.ok).toBe(false);
    expect(search).toHaveBeenCalledTimes(10); // five capped variants x two engines
    expect(peak).toBe(2);
  });

  it('aborts the active call and starts no later decomposed variant', async () => {
    process.env.WIGOLO_MULTI_QUERY_CONCURRENCY = '1';
    resetConfig();
    const controller = new AbortController();
    const reason = new DOMException('caller cancelled', 'AbortError');
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const search = vi.fn(async (_query: string, options = {}) => {
      const signal = (options as { signal?: AbortSignal }).signal;
      started();
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });

    const pending = runSearxngSearch(
      { query: longDecomposableQuery(4), force_refresh: true, include_content: false },
      context([{ name: 'searxng', search }], controller.signal),
    );
    await firstStarted;
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(search).toHaveBeenCalledTimes(1);
  });
});
