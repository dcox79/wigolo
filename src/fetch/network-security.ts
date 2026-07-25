import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { guardFetchUrl, type SsrfRejection } from '../watch/ssrf.js';

/** A DNS seam kept injectable so callers can test rebinding/private answers. */
export type DnsLookup = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

export interface NetworkGuardDecision {
  url: URL;
  /** True when this request is intentionally reaching a local/private network. */
  privateNetwork: boolean;
}

export type NetworkRequestGuard = (
  raw: string,
  fieldLabel?: string,
) => Promise<NetworkGuardDecision>;

/** A stable error type that every network tier can propagate unchanged. */
export class NetworkSecurityError extends Error {
  readonly code: string;
  readonly hint: string;

  constructor(rejection: SsrfRejection) {
    super(`${rejection.reason}. ${rejection.hint}`);
    this.name = 'NetworkSecurityError';
    this.code = rejection.code;
    this.hint = rejection.hint;
  }
}

const SENSITIVE_REQUEST_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'cookie2',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-access-token',
]);

/** True when caller-supplied headers can identify or authenticate a user. */
export function hasSensitiveRequestHeaders(headers?: Record<string, string>): boolean {
  if (!headers) return false;
  return Object.keys(headers).some((name) => SENSITIVE_REQUEST_HEADERS.has(name.toLowerCase()));
}

/**
 * Strip caller credentials and origin-bound metadata after an origin change.
 * Header names are compared case-insensitively and the input is never mutated.
 */
export function stripSensitiveHeaders(
  headers?: Record<string, string>,
): Record<string, string> | undefined {
  if (!headers) return headers;
  const out: Record<string, string> = {};
  let changed = false;
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      SENSITIVE_REQUEST_HEADERS.has(lower) ||
      lower === 'host' ||
      lower === 'origin' ||
      lower === 'referer'
    ) {
      changed = true;
      continue;
    }
    out[name] = value;
  }
  return changed ? out : headers;
}

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

export function headersForRedirect(
  headers: Record<string, string> | undefined,
  originalUrl: string,
  targetUrl: string,
): Record<string, string> | undefined {
  return sameOrigin(originalUrl, targetUrl) ? headers : stripSensitiveHeaders(headers);
}

type AddressClass = 'public' | 'private' | 'metadata';

function classifyIpv4(address: string): AddressClass {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return 'private';
  }
  const [a, b] = octets;

  // IPv4 link-local contains cloud/container metadata and credential services.
  if (a === 169 && b === 254) return 'metadata';

  // Only globally-routable unicast addresses are treated as public. Blocking
  // reserved/documentation/multicast space avoids platform-specific routes to
  // local services as well as the usual RFC1918/loopback cases.
  if (a === 0 || a === 10 || a === 127) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 192 && b === 0) return 'private';
  if (a === 192 && b === 0 && octets[2] === 2) return 'private';
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return 'private';
  if (a === 203 && b === 0 && octets[2] === 113) return 'private';
  if (a >= 224) return 'private';
  return 'public';
}

function ipv6ToBigInt(address: string): bigint | null {
  let value = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const dotted = value.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) {
    const octets = dotted.split('.').map(Number);
    if (octets.length !== 4 || octets.some((n) => n < 0 || n > 255)) return null;
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    value = `${value.slice(0, value.length - dotted.length)}${high}:${low}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.reduce((acc, group) => (acc << 16n) | BigInt(`0x${group}`), 0n);
}

function inIpv6Cidr(value: bigint, prefix: bigint, bits: number): boolean {
  const shift = 128n - BigInt(bits);
  return (value >> shift) === (prefix >> shift);
}

function classifyIpv6(address: string): AddressClass {
  const value = ipv6ToBigInt(address);
  if (value === null) return 'private';

  // IPv4-mapped and deprecated IPv4-compatible forms inherit IPv4 policy.
  const mappedPrefix = 0xffffn << 32n;
  if ((value >> 32n) === 0xffffn || (value >> 32n) === 0n) {
    const v4 = Number(value & 0xffff_ffffn);
    return classifyIpv4(`${(v4 >>> 24) & 255}.${(v4 >>> 16) & 255}.${(v4 >>> 8) & 255}.${v4 & 255}`);
  }

  const linkLocal = 0xfe80n << 112n;
  if (inIpv6Cidr(value, linkLocal, 10)) return 'metadata';
  // AWS documents fd00:ec2::254 as its IPv6 instance-metadata endpoint.
  const awsMetadata = ipv6ToBigInt('fd00:ec2::254');
  if (awsMetadata !== null && value === awsMetadata) return 'metadata';

  if (inIpv6Cidr(value, 0xfcn << 120n, 7)) return 'private'; // ULA
  if (inIpv6Cidr(value, 0xffn << 120n, 8)) return 'private'; // multicast
  const documentation = ipv6ToBigInt('2001:db8::');
  if (documentation !== null && inIpv6Cidr(value, documentation, 32)) return 'private';
  return 'public';
}

export function classifyNetworkAddress(address: string): AddressClass {
  const family = isIP(address.replace(/^\[|\]$/g, ''));
  if (family === 4) return classifyIpv4(address);
  if (family === 6) return classifyIpv6(address);
  return 'private';
}

function explicitLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === 'localhost.localdomain' || host.endsWith('.localhost')) return true;
  if (/^127\./.test(host)) return true;
  return host === '::1' || host === '0:0:0:0:0:0:0:1';
}

export function isExplicitPrivateUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname;
    if (explicitLoopbackHostname(host)) return true;
    return isIP(host.replace(/^\[|\]$/g, '')) !== 0 && classifyNetworkAddress(host) !== 'public';
  } catch {
    return true;
  }
}

function rejection(
  code: SsrfRejection['code'],
  reason: string,
  hint: string,
): never {
  throw new NetworkSecurityError({ ok: false, code, reason, hint });
}

const defaultLookup: DnsLookup = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map(({ address, family }) => ({ address, family }));
};

/**
 * Build the per-fetch guard used by every HTTP, TLS, and browser request.
 *
 * The initial URL is checked before routing. Every redirect/subresource is then
 * checked with the same closure, including DNS answers. Literal localhost is
 * available for the documented local-development case only when the *initial*
 * fetch itself was local; a public page cannot redirect to or embed localhost.
 */
export function createNetworkRequestGuard(options: {
  initialUrl: string;
  allowPrivate: boolean;
  lookup?: DnsLookup;
}): NetworkRequestGuard {
  let initial: URL;
  try {
    initial = new URL(options.initialUrl);
  } catch {
    // The returned guard will produce the normal structured invalid-url error.
    initial = new URL('http://invalid.invalid/');
  }
  const initialLoopbackHost = explicitLoopbackHostname(initial.hostname)
    ? initial.hostname.toLowerCase()
    : null;
  const resolve = options.lookup ?? defaultLookup;
  const dnsCache = new Map<string, Promise<Array<{ address: string; family: number }>>>();

  return async (raw, fieldLabel = 'url') => {
    const syntactic = guardFetchUrl(raw, fieldLabel, { allowPrivate: options.allowPrivate });
    if (!syntactic.ok) throw new NetworkSecurityError(syntactic);
    const parsed = syntactic.url;
    const hostname = parsed.hostname.toLowerCase();
    const normalizedHost = hostname.replace(/^\[|\]$/g, '');
    const localDevAllowed = initialLoopbackHost !== null && explicitLoopbackHostname(hostname);

    if (parsed.username || parsed.password) {
      rejection(
        'ssrf_invalid_url',
        `${fieldLabel} must not contain URL-embedded credentials`,
        'Pass credentials through the explicit authentication options instead.',
      );
    }

    let addresses: Array<{ address: string; family: number }>;
    const literalFamily = isIP(normalizedHost);
    if (literalFamily !== 0) {
      addresses = [{ address: normalizedHost, family: literalFamily }];
    } else if (explicitLoopbackHostname(hostname)) {
      addresses = [{ address: '127.0.0.1', family: 4 }];
    } else {
      let pending = dnsCache.get(hostname);
      if (!pending) {
        pending = resolve(hostname);
        dnsCache.set(hostname, pending);
      }
      try {
        addresses = await pending;
      } catch {
        // Resolution failures are not converted into an SSRF false positive.
        // The actual network tier will fail too; successful DNS answers are
        // always classified before the request is allowed to proceed.
        return { url: parsed, privateNetwork: false };
      }
    }

    let privateNetwork = false;
    for (const answer of addresses) {
      const kind = classifyNetworkAddress(answer.address);
      if (kind === 'metadata') {
        rejection(
          'ssrf_metadata',
          `${fieldLabel} resolves to a link-local or metadata address (${answer.address})`,
          'Cloud/container metadata and link-local addresses are always blocked.',
        );
      }
      if (kind === 'private') {
        privateNetwork = true;
        if (!options.allowPrivate && !localDevAllowed) {
          rejection(
            'ssrf_private_target',
            `${fieldLabel} resolves to a private address (${answer.address})`,
            'Private addresses are blocked by default. Enable WIGOLO_FETCH_ALLOW_PRIVATE only in an isolated environment.',
          );
        }
      }
    }

    return { url: parsed, privateNetwork };
  };
}

/** Conservative pre-network cache policy for the ordinary URL-only cache. */
export function sharedCacheRequestIsSafe(options: {
  url: string;
  allowPrivate: boolean;
  useAuth?: boolean;
  headers?: Record<string, string>;
  hasActions?: boolean;
}): boolean {
  if (options.allowPrivate) return false;
  if (options.useAuth || options.hasActions || hasSensitiveRequestHeaders(options.headers)) return false;
  return !isExplicitPrivateUrl(options.url);
}
