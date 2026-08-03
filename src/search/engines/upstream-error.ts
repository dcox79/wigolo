import {
  clampBackoffMs,
  DEFAULT_BACKOFF_MS,
  parseRetryAfter,
} from '../../fetch/politeness.js';
import { recordEngineRateLimit } from '../core/engine-bulkhead.js';

const RETRYABLE_5XX = new Set([500, 502, 503, 504]);
const ENGINE_LABELS: Record<string, string> = {
  arxiv: 'arXiv',
  bing: 'Bing',
  bing_news: 'Bing News',
  brave: 'Brave',
  'brave-image': 'Brave image',
  'crates-io': 'crates.io',
  'ddg-image': 'DDG image',
  duckduckgo: 'DDG',
  'github-code': 'GitHub code',
  'hn-algolia': 'HN Algolia',
  lobsters: 'Lobsters',
  marginalia: 'Marginalia',
  mdn: 'MDN',
  mojeek: 'Mojeek',
  searxng: 'SearXNG',
  'semantic-scholar': 'Semantic Scholar',
  stackoverflow: 'StackOverflow',
  wikipedia: 'Wikipedia',
};

export interface UpstreamHttpErrorInit {
  status: number;
  engine: string;
  retryAfterMs?: number;
  retryable: boolean;
}

/** Typed adapter error used by retry, breaker, and telemetry decisions. */
export class UpstreamHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;
  readonly engine: string;
  readonly retryable: boolean;

  constructor(init: UpstreamHttpErrorInit) {
    const label = ENGINE_LABELS[init.engine] ?? init.engine;
    super(
      init.engine === 'github-code' && init.status === 403
        ? `${label} rate-limited (${init.status})`
        : `${label} returned ${init.status}`,
    );
    this.name = 'UpstreamHttpError';
    this.status = init.status;
    this.retryAfterMs = init.retryAfterMs;
    this.engine = init.engine;
    this.retryable = init.retryable;
  }
}

export function isRetryableUpstreamStatus(status: number): boolean {
  return status === 429 || status === 403 || RETRYABLE_5XX.has(status);
}

/** Build an error directly from a Response. Retry-After uses the same parser,
 * default, and clamp as fetch politeness. A small positive jitter prevents a
 * queued herd from all waking on the same millisecond. */
export function upstreamHttpErrorFromResponse(
  engine: string,
  response: Response,
  nowMs = Date.now(),
  random = Math.random,
): UpstreamHttpError {
  // Some plugin/test fetch shims expose the minimum Response surface and omit
  // Headers. Treat that exactly like an absent Retry-After header.
  const headers = (response as Response & { headers?: Headers }).headers;
  const parsed = parseRetryAfter(headers?.get('retry-after') ?? undefined, nowMs);
  let retryAfterMs: number | undefined;

  if (response.status === 429) {
    const base = clampBackoffMs(parsed ?? DEFAULT_BACKOFF_MS);
    const jitter = Math.floor(base * 0.1 * Math.max(0, Math.min(1, random())));
    retryAfterMs = clampBackoffMs(base + jitter);
    // This happens synchronously while the adapter still owns its slot. A
    // queued call therefore observes the quota window before capacity release.
    recordEngineRateLimit(engine, retryAfterMs, nowMs);
  } else if (parsed !== null) {
    retryAfterMs = clampBackoffMs(parsed);
  }

  return new UpstreamHttpError({
    status: response.status,
    engine,
    retryAfterMs,
    retryable: isRetryableUpstreamStatus(response.status),
  });
}

export function assertUpstreamOk(engine: string, response: Response): void {
  if (!response.ok) throw upstreamHttpErrorFromResponse(engine, response);
}
