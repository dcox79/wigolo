import { describe, expect, it, vi } from 'vitest';
import {
  createNetworkRequestGuard,
  headersForRedirect,
  sharedCacheRequestIsSafe,
} from '../../../src/fetch/network-security.js';

describe('shared network request guard', () => {
  it('blocks a hostname whose DNS answer is private before dispatch', async () => {
    const lookup = vi.fn(async () => [{ address: '10.23.4.5', family: 4 }]);
    const guard = createNetworkRequestGuard({
      initialUrl: 'https://public-name.example/path',
      allowPrivate: false,
      lookup,
    });

    await expect(guard('https://public-name.example/path')).rejects.toThrow(/private address/i);
    expect(lookup).toHaveBeenCalledWith('public-name.example');
  });

  it('blocks metadata DNS answers even when private networking is enabled', async () => {
    const guard = createNetworkRequestGuard({
      initialUrl: 'https://metadata-alias.example/',
      allowPrivate: true,
      lookup: async () => [{ address: '169.254.169.254', family: 4 }],
    });

    await expect(guard('https://metadata-alias.example/')).rejects.toThrow(/metadata|link-local/i);
  });

  it('does not let a public initial page redirect to literal localhost', async () => {
    const guard = createNetworkRequestGuard({
      initialUrl: 'https://public.example/',
      allowPrivate: false,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    await guard('https://public.example/');
    await expect(guard('http://127.0.0.1:8080/admin', 'redirect location'))
      .rejects.toThrow(/private address/i);
  });

  it('preserves the explicit localhost development case but marks it private', async () => {
    const guard = createNetworkRequestGuard({
      initialUrl: 'http://localhost:3000/',
      allowPrivate: false,
    });
    const result = await guard('http://127.0.0.1:3000/app.js', 'browser request');
    expect(result.privateNetwork).toBe(true);
  });
});

describe('credential redirect and cache policy', () => {
  const credentials = {
    Authorization: 'Bearer secret',
    Cookie: 'session=secret',
    'X-Api-Key': 'key',
    Accept: 'text/html',
  };

  it('keeps credentials only for the exact same origin', () => {
    expect(headersForRedirect(credentials, 'https://a.example/start', 'https://a.example/next'))
      .toMatchObject(credentials);

    const crossOrigin = headersForRedirect(
      credentials,
      'https://a.example/start',
      'https://b.example/next',
    );
    expect(crossOrigin).toEqual({ Accept: 'text/html' });

    const portChange = headersForRedirect(
      credentials,
      'https://a.example/start',
      'https://a.example:8443/next',
    );
    expect(portChange).toEqual({ Accept: 'text/html' });
  });

  it('rejects authenticated, action-driven, and private requests from shared cache use', () => {
    expect(sharedCacheRequestIsSafe({
      url: 'https://public.example/', allowPrivate: false, useAuth: true,
    })).toBe(false);
    expect(sharedCacheRequestIsSafe({
      url: 'https://public.example/', allowPrivate: false, headers: credentials,
    })).toBe(false);
    expect(sharedCacheRequestIsSafe({
      url: 'https://public.example/', allowPrivate: false, hasActions: true,
    })).toBe(false);
    expect(sharedCacheRequestIsSafe({
      url: 'http://localhost:3000/', allowPrivate: false,
    })).toBe(false);
    expect(sharedCacheRequestIsSafe({
      url: 'https://public.example/', allowPrivate: false,
    })).toBe(true);
  });
});
