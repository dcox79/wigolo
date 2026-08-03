import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfig } from '../../../src/config.js';

const state = {
  failLaunch: 0,
  failContext: 0,
  failNewPage: 0,
  failRoute: 0,
  launchBarrier: null as Promise<void> | null,
  contextsCreated: 0,
  pagesCreated: 0,
  activePages: 0,
  peakActivePages: 0,
};

function makePage() {
  state.pagesCreated++;
  state.activePages++;
  state.peakActivePages = Math.max(state.peakActivePages, state.activePages);
  let closed = false;
  return {
    goto: vi.fn().mockImplementation((url: string) => {
      if (url.includes('/hold')) return new Promise<never>(() => {});
      return Promise.resolve({
        status: () => 200,
        url: () => url,
        headers: () => ({ 'content-type': 'text/html' }),
      });
    }),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue({ textLen: 1200, nodes: 24 }),
    content: vi.fn().mockResolvedValue('<html><body>rendered content</body></html>'),
    screenshot: vi.fn().mockResolvedValue(Buffer.from('shot')),
    setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
    route: vi.fn().mockImplementation(async () => {
      if (state.failRoute > 0) {
        state.failRoute--;
        throw new Error('route setup failed');
      }
    }),
    on: vi.fn(),
    close: vi.fn().mockImplementation(async () => {
      if (!closed) {
        closed = true;
        state.activePages--;
      }
    }),
  };
}

function makeContext() {
  state.contextsCreated++;
  return {
    newPage: vi.fn().mockImplementation(async () => {
      if (state.failNewPage > 0) {
        state.failNewPage--;
        throw new Error('newPage failed');
      }
      return makePage();
    }),
    addInitScript: vi.fn().mockResolvedValue(undefined),
    addCookies: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeBrowser() {
  return {
    newContext: vi.fn().mockImplementation(async () => {
      if (state.failContext > 0) {
        state.failContext--;
        throw new Error('newContext failed');
      }
      return makeContext();
    }),
    contexts: vi.fn().mockReturnValue([]),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

vi.mock('playwright', () => {
  const launch = vi.fn().mockImplementation(async () => {
    await state.launchBarrier;
    if (state.failLaunch > 0) {
      state.failLaunch--;
      throw new Error('launch failed');
    }
    return makeBrowser();
  });
  const stub = {
    launch,
    executablePath: () => '/fake/chromium',
    connectOverCDP: vi.fn().mockImplementation(async () => makeBrowser()),
  };
  return { chromium: stub, firefox: stub, webkit: stub };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: () => true };
});

import { chromium } from 'playwright';
import { BrowserPool, MultiBrowserPool } from '../../../src/fetch/browser-pool.js';
import {
  closeDaemonBrowser,
  fetchWithPlaywright,
} from '../../../src/fetch/playwright-tier.js';
import { getGlobalBrowserCapacityState } from '../../../src/fetch/browser-capacity.js';

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

describe('process-wide browser capacity', () => {
  const originalEnv = process.env;

  beforeEach(async () => {
    await closeDaemonBrowser().catch(() => undefined);
    process.env = { ...originalEnv, MAX_BROWSERS: '1' };
    resetConfig();
    state.failLaunch = 0;
    state.failContext = 0;
    state.failNewPage = 0;
    state.failRoute = 0;
    state.launchBarrier = null;
    state.contextsCreated = 0;
    state.pagesCreated = 0;
    state.activePages = 0;
    state.peakActivePages = 0;
    vi.mocked(chromium.launch).mockClear();
  });

  afterEach(async () => {
    await closeDaemonBrowser().catch(() => undefined);
    process.env = originalEnv;
    resetConfig();
  });

  it('enforces one global peak across pooled, dedicated stealth, and daemon paths', async () => {
    const pool = new MultiBrowserPool({ browserTypes: ['chromium', 'firefox'] });
    const pooledAbort = new AbortController();
    const stealthAbort = new AbortController();
    const daemonAbort = new AbortController();

    const pooled = pool.fetchWithBrowser('https://example.com/hold-pooled', {
      browserType: 'chromium',
      signal: pooledAbort.signal,
    });
    await waitFor(() => state.pagesCreated === 1, 'pooled page');

    const stealth = pool.fetchWithBrowser('https://example.com/hold-stealth', {
      browserType: 'firefox',
      stealth: true,
      signal: stealthAbort.signal,
    });
    const daemon = fetchWithPlaywright('https://example.com/hold-daemon', {
      signal: daemonAbort.signal,
    });
    await waitFor(() => getGlobalBrowserCapacityState().queued === 2, 'two browser waiters');

    expect(state.pagesCreated).toBe(1);
    expect(getGlobalBrowserCapacityState()).toMatchObject({ limit: 1, inFlight: 1, queued: 2 });

    pooledAbort.abort(new DOMException('done', 'AbortError'));
    await expect(pooled).rejects.toBeTruthy();
    await waitFor(() => state.pagesCreated === 2, 'stealth page after pooled release');
    expect(state.peakActivePages).toBe(1);

    stealthAbort.abort(new DOMException('done', 'AbortError'));
    await expect(stealth).rejects.toBeTruthy();
    await waitFor(() => state.pagesCreated === 3, 'daemon page after stealth release');
    expect(state.peakActivePages).toBe(1);

    daemonAbort.abort(new DOMException('done', 'AbortError'));
    await expect(daemon).rejects.toBeTruthy();
    expect(getGlobalBrowserCapacityState()).toMatchObject({ inFlight: 0, queued: 0 });
    expect(state.peakActivePages).toBe(1);
    await pool.shutdown();
  });

  it('removes an aborted waiter without starting browser work', async () => {
    const pool = new MultiBrowserPool();
    const activeAbort = new AbortController();
    const queuedAbort = new AbortController();

    const active = pool.fetchWithBrowser('https://example.com/hold-active', {
      signal: activeAbort.signal,
    });
    await waitFor(() => state.pagesCreated === 1, 'active browser page');

    const queued = fetchWithPlaywright('https://example.com/hold-queued', {
      signal: queuedAbort.signal,
    });
    await waitFor(() => getGlobalBrowserCapacityState().queued === 1, 'queued daemon request');
    queuedAbort.abort(new DOMException('cancel queued work', 'AbortError'));

    await expect(queued).rejects.toBeTruthy();
    expect(getGlobalBrowserCapacityState()).toMatchObject({ inFlight: 1, queued: 0 });
    expect(state.pagesCreated).toBe(1);

    activeAbort.abort(new DOMException('done', 'AbortError'));
    await expect(active).rejects.toBeTruthy();
    await pool.shutdown();
  });

  it('keeps prewarm and separate pool instances behind the same gate', async () => {
    const activePool = new MultiBrowserPool();
    const warmingPool = new MultiBrowserPool();
    const controller = new AbortController();
    const active = activePool.fetchWithBrowser('https://example.com/hold-active', {
      signal: controller.signal,
    });
    await waitFor(() => state.pagesCreated === 1, 'active pool page');

    const warming = warmingPool.warm();
    await waitFor(() => getGlobalBrowserCapacityState().queued === 1, 'queued prewarm');
    expect(chromium.launch).toHaveBeenCalledTimes(1);

    controller.abort(new DOMException('done', 'AbortError'));
    await expect(active).rejects.toBeTruthy();
    await warming;
    expect(chromium.launch).toHaveBeenCalledTimes(2);
    await activePool.shutdown();
    await warmingPool.shutdown();
  });

  it('cancels a queued direct BrowserPool.acquire waiter', async () => {
    const pool = new BrowserPool();
    const first = await pool.acquire();
    const controller = new AbortController();
    const queued = pool.acquire(controller.signal);
    await waitFor(() => getGlobalBrowserCapacityState().queued === 1, 'queued direct acquire');

    controller.abort(new DOMException('cancel queued acquire', 'AbortError'));
    await expect(queued).rejects.toBeTruthy();
    expect(getGlobalBrowserCapacityState()).toMatchObject({ inFlight: 1, queued: 0 });

    pool.release(first);
    expect(getGlobalBrowserCapacityState().inFlight).toBe(0);
    await pool.shutdown();
  });

  it('releases checked-out direct acquire leases during shutdown', async () => {
    process.env.MAX_BROWSERS = '2';
    resetConfig();
    const pool = new BrowserPool();
    await Promise.all([pool.acquire(), pool.acquire()]);
    expect(getGlobalBrowserCapacityState().inFlight).toBe(2);

    await pool.shutdown();
    expect(getGlobalBrowserCapacityState()).toMatchObject({ inFlight: 0, queued: 0 });
  });

  it('single-flights concurrent pooled and daemon launches', async () => {
    process.env.MAX_BROWSERS = '2';
    resetConfig();
    let releaseLaunch!: () => void;
    state.launchBarrier = new Promise<void>((resolve) => { releaseLaunch = resolve; });

    const pool = new MultiBrowserPool();
    const first = pool.fetchWithBrowser('https://example.com/one');
    const second = pool.fetchWithBrowser('https://example.com/two');
    await waitFor(() => vi.mocked(chromium.launch).mock.calls.length === 1, 'single pooled launch');
    expect(chromium.launch).toHaveBeenCalledTimes(1);
    releaseLaunch();
    await Promise.all([first, second]);
    await pool.shutdown();

    await closeDaemonBrowser();
    vi.mocked(chromium.launch).mockClear();
    state.contextsCreated = 0;
    state.launchBarrier = null;
    await Promise.all([
      fetchWithPlaywright('https://example.com/daemon-one'),
      fetchWithPlaywright('https://example.com/daemon-two'),
    ]);
    expect(chromium.launch).toHaveBeenCalledTimes(1);
    expect(state.contextsCreated).toBe(1);
  });

  it('rolls back pool and global capacity after launch or newContext failure', async () => {
    const launchPool = new MultiBrowserPool();
    state.failLaunch = 1;
    await expect(launchPool.fetchWithBrowser('https://example.com/launch-fail')).rejects.toThrow('launch failed');
    expect(launchPool.getStats()[0].activeCount).toBe(0);
    expect(getGlobalBrowserCapacityState().inFlight).toBe(0);
    await launchPool.fetchWithBrowser('https://example.com/launch-retry');
    await launchPool.shutdown();

    const contextPool = new MultiBrowserPool();
    state.failContext = 1;
    await expect(contextPool.fetchWithBrowser('https://example.com/context-fail')).rejects.toThrow('newContext failed');
    expect(contextPool.getStats()[0].activeCount).toBe(0);
    expect(getGlobalBrowserCapacityState().inFlight).toBe(0);
    await contextPool.fetchWithBrowser('https://example.com/context-retry');
    await contextPool.shutdown();
  });

  it('releases local and global slots when newPage setup fails', async () => {
    const pool = new MultiBrowserPool();
    state.failNewPage = 1;

    await expect(pool.fetchWithBrowser('https://example.com/page-fail')).rejects.toThrow('newPage failed');
    expect(getGlobalBrowserCapacityState()).toMatchObject({ inFlight: 0, queued: 0 });
    expect(pool.getStats()[0]).toMatchObject({ activeCount: 0, pooledCount: 0 });

    await expect(pool.fetchWithBrowser('https://example.com/page-retry')).resolves.toMatchObject({
      method: 'browser',
    });
    await pool.shutdown();

    state.failNewPage = 1;
    await expect(fetchWithPlaywright('https://example.com/daemon-page-fail')).rejects.toThrow('newPage failed');
    expect(getGlobalBrowserCapacityState()).toMatchObject({ inFlight: 0, queued: 0 });
    await expect(fetchWithPlaywright('https://example.com/daemon-page-retry')).resolves.toMatchObject({
      html: expect.stringContaining('rendered content'),
    });
  });

  it('cleans up page, context lease, and global capacity when route setup fails', async () => {
    const pool = new MultiBrowserPool();
    state.failRoute = 1;

    await expect(pool.fetchWithBrowser('https://example.com/route-fail', {
      headers: { 'x-test': 'value' },
    })).rejects.toThrow('route setup failed');

    expect(state.activePages).toBe(0);
    expect(getGlobalBrowserCapacityState()).toMatchObject({ inFlight: 0, queued: 0 });
    expect(pool.getStats()[0]).toMatchObject({ activeCount: 1, pooledCount: 1 });
    await expect(pool.fetchWithBrowser('https://example.com/route-retry')).resolves.toMatchObject({
      method: 'browser',
    });
    await pool.shutdown();
  });
});
