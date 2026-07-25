import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfig } from '../../../src/config.js';
import { SmartRouter, type HttpClient } from '../../../src/fetch/router.js';

describe('SmartRouter central network guard', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.WIGOLO_FETCH_ALLOW_PRIVATE;
    resetConfig();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
  });

  it.each([undefined, 'stealth' as const])(
    'blocks private DNS before any %s-mode fetcher runs',
    async (mode) => {
      const httpFetcher = vi.fn(async (url: string) => ({ url, html: 'body', text: 'body' }));
      const playwrightFetcher = vi.fn(async () => ({
        html: 'body', text: 'body', completeness: { level: 'complete' as const },
      }));
      const router = new SmartRouter({
        httpFetcher,
        playwrightFetcher,
        dnsLookup: async () => [{ address: '10.0.0.9', family: 4 }],
      });

      await expect(router.fetch('https://rebinding.example/', mode ? { mode } : {}))
        .rejects.toThrow(/private address/i);
      expect(httpFetcher).not.toHaveBeenCalled();
      expect(playwrightFetcher).not.toHaveBeenCalled();
    },
  );

  it('passes the per-hop guard into the real HTTP-client boundary', async () => {
    const httpClient: HttpClient = {
      fetch: vi.fn(async (url, options) => {
        expect(options?.requestGuard).toBeTypeOf('function');
        await options?.requestGuard?.('http://127.0.0.1:9000/admin', 'redirect location');
        throw new Error('unreachable');
      }),
    };
    const router = new SmartRouter({
      httpClient,
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    });

    await expect(router.fetch('https://public.example/', { renderJs: 'never' }))
      .rejects.toThrow(/private address/i);
  });

  it('marks authenticated and explicit-local responses as non-cacheable', async () => {
    const makeRouter = () => new SmartRouter({
      httpClient: {
        fetch: vi.fn(async (url) => ({
          url,
          finalUrl: url,
          html: '<html><body>private</body></html>',
          contentType: 'text/html',
          statusCode: 200,
          headers: {},
        })),
      },
      browserPool: {
        fetchWithBrowser: vi.fn(async (url) => ({
          url,
          finalUrl: url,
          html: '<html><body>private</body></html>',
          contentType: 'text/html',
          statusCode: 200,
          method: 'browser',
          headers: {},
        })),
      },
      pdfProbe: async () => false,
      browserAcquirer: { ensureBrowser: async () => 'ready' } as any,
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
    });

    const auth = await makeRouter().fetch('https://public.example/', {
      renderJs: 'always',
      useAuth: true,
    });
    expect(auth.cacheable).toBe(false);

    const local = await makeRouter().fetch('http://127.0.0.1:3000/', { renderJs: 'never' });
    expect(local.cacheable).toBe(false);
  });
});
