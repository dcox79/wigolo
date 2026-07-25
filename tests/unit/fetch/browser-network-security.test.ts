import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfig } from '../../../src/config.js';

type RouteHandler = (route: any) => Promise<void>;
let routeHandler: RouteHandler | undefined;
const continued: Array<{ url: string; headers: Record<string, string> }> = [];
const frame = {};

function makeRoute(url: string, headers: Record<string, string>) {
  return {
    request: () => ({
      url: () => url,
      headers: () => headers,
      isNavigationRequest: () => true,
      frame: () => frame,
    }),
    continue: vi.fn(async (options?: { headers?: Record<string, string> }) => {
      continued.push({ url, headers: options?.headers ?? headers });
    }),
    abort: vi.fn(async () => {}),
  };
}

function makePage() {
  return {
    route: vi.fn(async (_pattern: string, handler: RouteHandler) => { routeHandler = handler; }),
    mainFrame: () => frame,
    goto: vi.fn(async () => {
      await routeHandler?.(makeRoute('https://origin.example/start', { 'user-agent': 'browser' }));
      // Browser-managed destination cookie should survive. Caller-provided
      // origin credentials must not be injected onto this request.
      await routeHandler?.(makeRoute('https://other.example/landing', {
        'user-agent': 'browser',
        cookie: 'idp-destination-cookie=ok',
      }));
      return {
        status: () => 200,
        url: () => 'https://other.example/landing',
        headers: () => ({ 'content-type': 'text/html' }),
      };
    }),
    waitForLoadState: vi.fn(async () => {}),
    waitForFunction: vi.fn(async () => {}),
    evaluate: vi.fn(async () => ({ textLen: 1000, nodes: 20 })),
    content: vi.fn(async () => `<html><body>${'content '.repeat(100)}</body></html>`),
    screenshot: vi.fn(async () => Buffer.from('shot')),
    setExtraHTTPHeaders: vi.fn(async () => {}),
    on: vi.fn(),
    context: () => ({ cookies: vi.fn(async () => []) }),
    close: vi.fn(async () => {}),
  };
}

vi.mock('playwright', () => {
  const browser = {
    newContext: vi.fn(async () => ({
      newPage: vi.fn(async () => makePage()),
      close: vi.fn(async () => {}),
      cookies: vi.fn(async () => []),
    })),
    close: vi.fn(async () => {}),
  };
  const launcher = { launch: vi.fn(async () => browser), connectOverCDP: vi.fn() };
  return { chromium: launcher, firefox: launcher, webkit: launcher };
});

import { MultiBrowserPool } from '../../../src/fetch/browser-pool.js';

describe('browser redirect network security', () => {
  beforeEach(() => {
    routeHandler = undefined;
    continued.length = 0;
    resetConfig();
  });

  afterEach(() => resetConfig());

  it('guards each request and withholds caller credentials after an origin change', async () => {
    const requestGuard = vi.fn(async () => ({
      url: new URL('https://origin.example/'),
      privateNetwork: false,
    }));
    const pool = new MultiBrowserPool();

    await pool.fetchWithBrowser('https://origin.example/start', {
      requestGuard,
      headers: {
        Authorization: 'Bearer secret',
        Cookie: 'source-session=secret',
        'X-Api-Key': 'secret',
        Accept: 'text/html',
      },
    });

    expect(requestGuard).toHaveBeenCalledWith('https://origin.example/start', 'browser request');
    expect(requestGuard).toHaveBeenCalledWith('https://other.example/landing', 'browser request');

    const origin = continued.find((entry) => entry.url.includes('origin.example'))!;
    expect(origin.headers.Authorization).toBe('Bearer secret');
    expect(origin.headers.Cookie).toBe('source-session=secret');

    const redirected = continued.find((entry) => entry.url.includes('other.example'))!;
    expect(redirected.headers.Authorization).toBeUndefined();
    expect(redirected.headers['X-Api-Key']).toBeUndefined();
    expect(redirected.headers.Cookie).toBeUndefined();
    expect(redirected.headers.cookie).toBe('idp-destination-cookie=ok');
    expect(redirected.headers.Accept).toBe('text/html');

    await pool.shutdown();
  });
});
