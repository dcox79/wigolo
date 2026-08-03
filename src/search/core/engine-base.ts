import type {
  SearchEngine,
  SearchEngineOptions,
  RawSearchResult,
} from '../../types.js';
import { createLogger } from '../../logger.js';
import { anySignal } from '../../util/abort.js';
import {
  getEngineBulkheadSnapshot,
  isConcurrencyLimitedError,
  resetEngineBulkheads,
} from './engine-bulkhead.js';
import { UpstreamHttpError } from '../engines/upstream-error.js';

const log = createLogger('search');

/**
 * Quality tier for an engine adapter. Reflects observed snippet quality +
 * stability of the upstream source. The tier is consumed to weight RRF
 * fusion — higher-tier engines contribute more to the fused ranking.
 *
 * Tier semantics (see also docs in src/search/core/engine-quality.ts):
 *   - 'high'   : authoritative source with structured payload (JSON/API),
 *                stable schema, rich snippets. Example: StackOverflow API,
 *                Wikipedia OpenSearch, MDN docs API.
 *   - 'medium' : scraped HTML or a structured feed where snippets are
 *                useful but can be thin or noisy. Example: Bing, DDG Lite,
 *                Brave web (description short), HN Algolia (points/comments
 *                fallback snippet), arXiv, Semantic Scholar (abstract may
 *                be missing).
 *   - 'low'    : sparse / boilerplate snippets, or a curated lookup that
 *                returns mostly metadata rather than evidence text. Example:
 *                devdocs (static slug table, no body content), lobsters
 *                (often returns "N score / N comments" rather than evidence).
 */
export type EngineQualityTier = 'high' | 'medium' | 'low';

export interface EngineEntry {
  engine: SearchEngine;
  /** Optional weight for downstream RRF/scoring. Default 1. */
  weight?: number;
  /** Whether this engine accepts date filters in options.fromDate/toDate. */
  supportsDateFilter?: boolean;
  /** Marks an engine as a low-priority secondary signal. Results that
   * were contributed only by secondary engines are demoted when their
   * lexical alignment with the query is low. Used by the code vertical
   * to admit MDN without letting it dominate database/library queries. */
  secondary?: boolean;
  /** Snippet / source-quality tier, consumed to weight RRF fusion. Every
   * registered entry MUST set a tier; a registered-engines test enforces
   * that the field is present. */
  quality?: EngineQualityTier;
  /** When true, the engine is registered but the orchestrator must skip
   * dispatch. Used when an upstream endpoint is gone or the adapter is
   * intentionally parked pending a rewrite — the slice spec calls this
   * out as a soft-disable so the adapter file isn't deleted (CEO call). */
  disabled?: boolean;
  /** When true, the engine is NOT dispatched in the primary wave — it is held
   * back and dispatched only by the orchestrator's degraded-recovery wave (see
   * orchestrator.ts) when the primary pool collapses below the health floor.
   * Used for an engine that is a per-call latency/failure tax on the happy path
   * (e.g. a source that reputation-blocks this network most of the time) but
   * still contributes an independent lexical signal when the pool is starved
   * and needs every engine it can get. Generic — no engine name is inspected
   * by the dispatch logic; the roster decides via this flag. */
  probeOnly?: boolean;
}

export interface EngineOutcome {
  engine: string;
  ok: boolean;
  results: RawSearchResult[];
  error?: string;
  latencyMs: number;
  /** True when the breaker tripped and we skipped the call. */
  skipped?: boolean;
  /** Remaining breaker cooldown in ms, set only when skipped. */
  cooldownRemainingMs?: number;
  /** True when the engine was still in flight at the pool's soft deadline
   * (or its tighter chronic budget). The per-engine signal is aborted before
   * the timed-out outcome is returned. */
  timedOut?: boolean;
  /** Stable machine-readable dispatch classification. */
  reason?:
    | 'rate_limited'
    | 'breaker_open'
    | 'concurrency_limited'
    | 'soft_deadline'
    | 'upstream_timeout'
    | 'recovery_probe';
}

/** Options for {@link runEnginesParallel} that bound how long the pool waits. */
export interface RunEnginesOptions {
  /** Overall soft deadline in ms. Once elapsed, engines still in flight are
   * recorded as `timedOut` outcomes and no longer awaited. Undefined =
   * legacy Promise.all behaviour (wait for the slowest engine). */
  softDeadlineMs?: number;
  /** Tighter per-engine soft deadline applied ONLY to engines whose session
   * trip count is at/above the chronic threshold. Lets the pool stop paying a
   * chronically-failing engine's straggler cost every call while a healthy or
   * transiently-slow-once engine keeps the full pool deadline. Generic and
   * data-driven — keyed on observed session trips, never an engine name. */
  chronicSoftDeadlineMs?: number;
  /** Marks this dispatch as the single degraded-recovery probe wave. */
  recoveryProbe?: boolean;
}

export interface BreakerConfig {
  /** Fail count to trip. Default 3. */
  failureThreshold?: number;
  /** Cooldown after tripping, ms. Default 60_000. */
  cooldownMs?: number;
  /** In-call retry attempts before the breaker records a failure. Default 2
   * (one retry). The inter-attempt backoff grows exponentially from the base
   * so a rate-limited engine is not hammered. */
  retryAttempts?: number;
  /** Minimum inter-request interval (ms) for a rate-limit-prone engine. A call
   * arriving within this window of the previous dispatch is SKIPPED (throws
   * {@link ThrottledError}) rather than waiting — waiting would poison the
   * pool's soft deadlines and serialize multi-query fan-out. When omitted (and
   * no name-registered default exists) the engine is never throttled.
   * A per-engine default can be pre-registered via
   * {@link registerEngineMinInterval}; the explicit option wins over it. */
  minIntervalMs?: number;
}

/**
 * An engine that opts into the retry loop's rotation hook. The base
 * `SearchEngine` contract is unchanged — this optional method lets an
 * HTML-scraping adapter react to a retryable error (e.g. rotate its browser
 * fingerprint on a 403) before the next attempt. The retry loop calls it
 * only between attempts, never after the final one.
 */
export interface RetryableEngine extends SearchEngine {
  onRetry?(attempt: number, lastError: unknown): void;
}

interface BreakerState {
  failures: number;
  /** Epoch ms until which the breaker is open. 0 = closed. */
  tripUntil: number;
  /** Half-open probe in flight — concurrent callers are rejected as open. */
  probing: boolean;
  /** Epoch ms when the in-flight probe started — drives stuck-probe reclaim. */
  probeStartedAt: number;
  /** Consecutive opens without an intervening success — drives backoff. */
  trips: number;
  /** Cumulative trips over the process/session that do NOT reset on a
   * recovery. A single trip is transient; a high count marks an engine as
   * chronically unhealthy so the pool can give it a tighter wait budget. */
  sessionTrips: number;
  /** Epoch ms of the last dispatch admitted past the throttle gate. Drives the
   * per-engine minimum inter-request interval. 0 = never dispatched. */
  lastDispatchAt: number;
  /** Last engine error, surfaced via getBreakerSnapshot() for doctor. */
  lastError?: string;
}

const DEFAULT_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60_000;
/** Exponential-backoff ceiling for HARD (403/5xx/other) failures. A persistent
 * block backs off geometrically but never darkens an engine longer than this —
 * 3 minutes is a real backoff yet short enough that a caller can wait it out
 * and the pool recovers within a session (was 600s / 10 min). */
const MAX_COOLDOWN_MS = 180_000;
/** Backoff ceiling for a REPEATED rate-limit (429) block. A 429 means the
 * engine is UP and throttling this caller; it must recover fast and never climb
 * the hard-failure exponential ladder. Capped well below MAX_COOLDOWN_MS so a
 * momentarily over-driven engine returns within a burst, not minutes later. */
const RATE_LIMIT_MAX_COOLDOWN_MS = 30_000;
/** Session trips at/above this count mark an engine as chronically unhealthy.
 * The pool then applies the tighter `chronicSoftDeadlineMs` budget to it so a
 * repeatedly-failing engine stops draining wall-clock every call. A trip
 * happens at most once per cooldown window, so this many trips means the
 * engine has failed across several distinct recovery attempts — not a one-off
 * blip. Generic + data-driven; no engine name is special-cased. */
export const CHRONIC_TRIP_THRESHOLD = 3;
/** Base in-call retry backoff; grows exponentially per attempt (100ms, 300ms,
 * 900ms, …) so a rate-limited engine is not hammered on retry. */
const RETRY_BACKOFF_BASE_MS = 100;
const DEFAULT_RETRY_ATTEMPTS = 2;
const MAX_RETRY_BACKOFF_MS = 5_000;
const MAX_LAST_ERROR_LEN = 300;
/** A 429 / rate-limit block is TRANSIENT — the engine is up but throttling
 * this caller for a short window. It must recover FAST so a burst that
 * momentarily over-drives one engine doesn't lose it for a full minute. A 403
 * (reputational / forbidden) block is PERSISTENT and keeps the full cooldown.
 * The class is read from the error text — keyed on error class, never on an
 * engine name. Kept well above a single burst's inter-call gap so a genuinely
 * rate-limited engine still gets breathing room. */
const TRANSIENT_COOLDOWN_MS = 5_000;

/** Marginalia's minimum inter-request interval. It rate-limits (429) aggressively
 * under a burst; spacing calls at least this far apart keeps it in the pool
 * instead of tripping its breaker. Generic mechanism — the value is registered
 * against the engine name, not special-cased in the dispatch logic. */
export const MARGINALIA_MIN_INTERVAL_MS = 2_000;

/** Name-keyed default minimum inter-request intervals. A vertical registers a
 * rate-limit-prone engine here so every wrapped instance picks it up without
 * each call site threading `minIntervalMs`. NOT cleared by resetBreakers —
 * it is static config, not per-run state. */
const engineMinIntervals = new Map<string, number>();

/** Register a default minimum inter-request interval for an engine by name.
 * Idempotent. An explicit `minIntervalMs` on wrapWithRetryAndBreaker wins. */
export function registerEngineMinInterval(name: string, ms: number): void {
  engineMinIntervals.set(name, ms);
}

export type FailureClass = 'rate-limit' | 'forbidden' | 'other';

/** Classify an engine failure by its error text. `rate-limit` (429 / "rate
 * limit" / "too many requests") is transient; `forbidden` (403 / "forbidden")
 * is a reputational block; everything else is `other`. Pure + engine-agnostic. */
export function classifyFailure(err: unknown): FailureClass {
  if (err instanceof UpstreamHttpError) {
    if (err.status === 429) return 'rate-limit';
    if (err.status === 403) return 'forbidden';
    return 'other';
  }
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/\b429\b/.test(message) || /rate.?limit|too many requests/.test(message)) {
    return 'rate-limit';
  }
  if (/\b403\b/.test(message) || /forbidden/.test(message)) return 'forbidden';
  return 'other';
}

/** Class-scaled cooldown: a transient (rate-limit) failure recovers on the
 * short window; a forbidden / other failure keeps the caller-supplied
 * cooldown. Never exceeds the base cooldown, so this can only SHORTEN a
 * cooldown, never extend it beyond what the caller configured. */
function cooldownForFailure(cls: FailureClass, baseCooldownMs: number): number {
  if (cls === 'rate-limit') return Math.min(TRANSIENT_COOLDOWN_MS, baseCooldownMs);
  return baseCooldownMs;
}

/** Upstream error bodies can echo hostile content into Error.message —
 * strip control chars (terminal escapes) and cap length before the string
 * reaches doctor output / telemetry. */
function sanitizeErrorMessage(message: string): string {
  return message.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, MAX_LAST_ERROR_LEN);
}

const breakers = new Map<string, BreakerState>();

function getState(name: string): BreakerState {
  let s = breakers.get(name);
  if (!s) {
    s = {
      failures: 0,
      tripUntil: 0,
      probing: false,
      probeStartedAt: 0,
      trips: 0,
      sessionTrips: 0,
      lastDispatchAt: 0,
    };
    breakers.set(name, s);
  }
  return s;
}

function recordFailure(
  name: string,
  threshold: number,
  cooldownMs: number,
  failureClass: FailureClass,
): void {
  const state = getState(name);
  state.failures += 1;
  if (state.failures >= threshold && state.tripUntil === 0) {
    const effectiveCooldown = cooldownForFailure(failureClass, cooldownMs);
    state.tripUntil = Date.now() + effectiveCooldown;
    // A rate-limit (429) block is transient: the engine is up and throttling.
    // It opens on the short window but must NOT feed the exponential-backoff
    // (`trips`) or chronic-health (`sessionTrips`) counters — otherwise a burst
    // that momentarily over-drives one engine would back it off toward the hard
    // cap and mark it permanently chronic. Hard failures keep the ladder.
    if (failureClass !== 'rate-limit') {
      state.trips = 1;
      state.sessionTrips += 1;
    }
    log.warn('breaker tripped', {
      engine: name,
      failures: state.failures,
      cooldownMs: effectiveCooldown,
      failureClass,
      sessionTrips: state.sessionTrips,
    });
  }
}

/** Reopen after a failed (or stuck) probe. Hard failures back off
 * exponentially and feed the trip counters, capped at {@link MAX_COOLDOWN_MS}.
 * A rate-limit failure stays on a flat short window (capped at
 * {@link RATE_LIMIT_MAX_COOLDOWN_MS}) and never touches `trips`/`sessionTrips`,
 * so a repeatedly-throttled engine is never mistaken for a chronically-broken
 * one. Stuck-probe reclaim is treated as a hard failure (class unknown). */
function reopenWithBackoff(
  state: BreakerState,
  cooldownMs: number,
  failureClass: FailureClass,
): number {
  if (failureClass === 'rate-limit') {
    const backoffMs = Math.min(
      cooldownForFailure('rate-limit', cooldownMs),
      RATE_LIMIT_MAX_COOLDOWN_MS,
    );
    state.tripUntil = Date.now() + backoffMs;
    state.probing = false;
    return backoffMs;
  }
  state.trips += 1;
  state.sessionTrips += 1;
  const backoffMs = Math.min(cooldownMs * 2 ** (state.trips - 1), MAX_COOLDOWN_MS);
  state.tripUntil = Date.now() + backoffMs;
  state.probing = false;
  return backoffMs;
}

function recordSuccess(name: string): void {
  const state = getState(name);
  state.failures = 0;
  state.tripUntil = 0;
  state.probing = false;
  state.trips = 0;
  // A successful half-open recovery clears the chronic counter too: an engine
  // that trips, recovers, and behaves is no longer chronically unhealthy. This
  // makes chronic status ESCAPABLE — otherwise a single bad burst would pin the
  // engine to the tighter chronic budget for the life of the process.
  state.sessionTrips = 0;
  delete state.lastError;
}

/** Clear ALL breaker state (failures, cooldowns, trips, sessionTrips). Public:
 * doctor `--fix` and the daemon admin reset route call this to un-stick an
 * engine pool that collapsed under a burst. Also the reset used by tests. */
export function resetBreakers(): void {
  breakers.clear();
  resetEngineBulkheads();
}

/** Delegating alias kept for the many test files that import it. Renaming
 * would be pure churn (and would collide with parallel work), so the public
 * name is `resetBreakers` and this stays a reference to the same function. */
export const _resetBreakersForTest = resetBreakers;

/**
 * Cumulative breaker trips for an engine over the life of this process.
 * Unlike the per-cooldown `trips` counter, this does NOT reset when the
 * engine recovers — so a flaky engine that trips, recovers, and trips again
 * is recognised as chronically unhealthy. Pure read; 0 for an engine that
 * has never tripped (or never dispatched). */
export function getEngineSessionTrips(name: string): number {
  return breakers.get(name)?.sessionTrips ?? 0;
}

/** True when an engine has tripped enough times this session to be treated as
 * chronically unhealthy (see {@link CHRONIC_TRIP_THRESHOLD}). */
export function isEngineChronicallyUnhealthy(name: string): boolean {
  return getEngineSessionTrips(name) >= CHRONIC_TRIP_THRESHOLD;
}

export type BreakerSnapshotState = 'closed' | 'open' | 'half-open';

export interface BreakerSnapshotEntry {
  engine: string;
  state: BreakerSnapshotState;
  failures: number;
  cooldownRemainingMs: number;
  lastError?: string;
}

export interface LiveEngineStateEntry {
  engine: string;
  breaker: BreakerSnapshotState;
  failures: number;
  cooldownRemainingMs: number;
  /** Null for engines without a configured bulkhead. */
  limit: number | null;
  inFlight: number;
  queued: number;
  /** Epoch milliseconds. Zero means no upstream quota window is active. */
  nextAllowedAt: number;
}

/**
 * Point-in-time view of every breaker that has seen at least one call.
 * `half-open` = cooldown elapsed but the breaker has not closed yet (probe
 * pending or in flight). Pure read — never mutates breaker state.
 */
export function getBreakerSnapshot(): BreakerSnapshotEntry[] {
  const now = Date.now();
  return [...breakers.entries()].map(([engine, s]) => {
    const state: BreakerSnapshotState =
      s.tripUntil === 0 ? 'closed' : now < s.tripUntil ? 'open' : 'half-open';
    return {
      engine,
      state,
      failures: s.failures,
      cooldownRemainingMs: state === 'open' ? s.tripUntil - now : 0,
      ...(s.lastError ? { lastError: s.lastError } : {}),
    };
  });
}

/** Read-only process-wide breaker + admission snapshot for authenticated
 * health/diagnostics surfaces. Calling it never creates or mutates state. */
export function getLiveEngineStateSnapshot(): LiveEngineStateEntry[] {
  const breakerByName = new Map(getBreakerSnapshot().map((entry) => [entry.engine, entry]));
  const bulkheadByName = new Map(
    getEngineBulkheadSnapshot().map((entry) => [entry.engine, entry]),
  );
  const names = new Set([...breakerByName.keys(), ...bulkheadByName.keys()]);

  return [...names].sort().map((engine) => {
    const breaker = breakerByName.get(engine);
    const bulkhead = bulkheadByName.get(engine);
    return {
      engine,
      breaker: breaker?.state ?? 'closed',
      failures: breaker?.failures ?? 0,
      cooldownRemainingMs: breaker?.cooldownRemainingMs ?? 0,
      limit: bulkhead?.limit ?? null,
      inFlight: bulkhead?.inFlight ?? 0,
      queued: bulkhead?.queued ?? 0,
      nextAllowedAt: bulkhead?.nextAllowedAt ?? 0,
    };
  });
}

export class BreakerOpenError extends Error {
  readonly cooldownRemainingMs: number;

  constructor(name: string, cooldownRemainingMs: number) {
    super(`breaker open for engine ${name}`);
    this.name = 'BreakerOpenError';
    this.cooldownRemainingMs = cooldownRemainingMs;
  }
}

/**
 * Thrown when a call arrives inside an engine's minimum inter-request interval.
 * The engine is SKIPPED (not waited on) to avoid poisoning pool deadlines and
 * serializing multi-query fan-out. Subclasses BreakerOpenError so the existing
 * pool catch maps it to a `skipped: true` outcome with no forwarding change;
 * `cooldownRemainingMs` carries the time until the engine is dispatchable again.
 */
export class ThrottledError extends BreakerOpenError {
  constructor(name: string, cooldownRemainingMs: number) {
    super(name, cooldownRemainingMs);
    this.name = 'ThrottledError';
    this.message = `throttled: engine ${name} called within its minimum interval`;
  }
}

function isCallerCancellation(error: unknown, signal?: AbortSignal): boolean {
  if (!signal?.aborted) return false;
  return error === signal.reason ||
    (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'));
}

function isRetryableFailure(error: unknown): boolean {
  if (error instanceof UpstreamHttpError) return error.retryable;
  if (error instanceof SyntaxError) return false;
  if (error instanceof Error) {
    if (error.name === 'AbortError') return false;
    if (error.name === 'TimeoutError') return true;
    // Backward-compatible guard for third-party adapters that have not yet
    // adopted UpstreamHttpError: never retry an ordinary textual 4xx.
    const status = error.message.match(/\b(4\d\d)\b/)?.[1];
    if (status && status !== '403' && status !== '429') return false;
  }
  // Fetch implementations surface network failures as TypeError or Error
  // with platform-specific messages/codes. Unknown non-HTTP adapter errors
  // retain the historical single retry for plugin compatibility.
  return true;
}

function retryDelayMs(
  error: unknown,
  attempt: number,
  minIntervalRemainingMs: number,
): number {
  const normalBackoff = Math.min(
    RETRY_BACKOFF_BASE_MS * 3 ** (attempt - 1),
    MAX_RETRY_BACKOFF_MS,
  );
  const upstreamBackoff = error instanceof UpstreamHttpError && error.status === 429
    ? (error.retryAfterMs ?? normalBackoff)
    : normalBackoff;
  return Math.max(upstreamBackoff, minIntervalRemainingMs);
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function wrapWithRetryAndBreaker(
  engine: SearchEngine,
  cfg?: BreakerConfig,
): SearchEngine {
  const threshold = cfg?.failureThreshold ?? DEFAULT_THRESHOLD;
  const cooldownMs = cfg?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const retryAttempts = Math.max(1, cfg?.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS);
  const minIntervalMs = cfg?.minIntervalMs ?? engineMinIntervals.get(engine.name) ?? 0;
  const onRetry = (engine as RetryableEngine).onRetry?.bind(engine);

  return {
    name: engine.name,
    async search(query: string, options?: SearchEngineOptions): Promise<RawSearchResult[]> {
      const state = getState(engine.name);

      // Throttle gate: a call arriving within the engine's minimum interval is
      // SKIPPED, not delayed. Checked before the breaker so a throttled call
      // never touches breaker state. The last-dispatch clock advances only for
      // admitted calls, so a run of throttled calls can't starve the engine.
      if (minIntervalMs > 0 && state.lastDispatchAt > 0) {
        const sinceLast = Date.now() - state.lastDispatchAt;
        if (sinceLast < minIntervalMs) {
          throw new ThrottledError(engine.name, minIntervalMs - sinceLast);
        }
      }
      state.lastDispatchAt = Date.now();

      let probe = false;
      if (state.tripUntil > 0) {
        const now = Date.now();
        if (now < state.tripUntil) {
          throw new BreakerOpenError(engine.name, state.tripUntil - now);
        }
        if (state.probing) {
          if (now - state.probeStartedAt >= cooldownMs) {
            // Stuck probe: in flight longer than a full cooldown window —
            // treat it as failed so a never-settling engine can't hold the
            // breaker half-open forever. Reopen with backoff; a later
            // caller re-probes once the new cooldown elapses. A hung engine is
            // not a rate-limit signal, so this takes the hard-failure ladder.
            const backoffMs = reopenWithBackoff(state, cooldownMs, 'other');
            log.warn('breaker reclaimed stuck probe', {
              engine: engine.name,
              trips: state.trips,
              cooldownMs: backoffMs,
            });
            throw new BreakerOpenError(engine.name, backoffMs);
          }
          // Half-open admits exactly ONE probe — everyone else stays skipped
          // until the in-flight probe settles.
          throw new BreakerOpenError(engine.name, 0);
        }
        probe = true;
        state.probing = true;
        state.probeStartedAt = now;
        log.info('breaker half-open probe', { engine: engine.name });
      }

      let lastErr: unknown;
      let fingerprint403Retried = false;
      for (let attempt = 1; attempt <= retryAttempts; attempt++) {
        try {
          const results = await engine.search(query, options);
          recordSuccess(engine.name);
          return results;
        } catch (err) {
          lastErr = err;
          if (isCallerCancellation(err, options?.signal)) break;
          if (attempt >= retryAttempts || !isRetryableFailure(err)) break;

          const is403 = err instanceof UpstreamHttpError
            ? err.status === 403
            : err instanceof Error && /\b403\b|forbidden/i.test(err.message);
          if (is403) {
            // A reputational 403 may get exactly one fresh browser
            // fingerprint. A quota 429 never enters this branch and therefore
            // never rotates user agents.
            if (!onRetry || fingerprint403Retried) break;
            fingerprint403Retried = true;
            onRetry(attempt, err);
          }

          const minIntervalRemainingMs = minIntervalMs > 0
            ? Math.max(0, minIntervalMs - (Date.now() - state.lastDispatchAt))
            : 0;
          const backoffMs = retryDelayMs(err, attempt, minIntervalRemainingMs);
          try {
            await abortableDelay(backoffMs, options?.signal);
          } catch (abortError) {
            lastErr = abortError;
            break;
          }
          // Advance the throttle clock for the actual retry dispatch. This
          // closes the old loophole where attempt two bypassed the 2s gate.
          state.lastDispatchAt = Date.now();
        }
      }

      if (isCallerCancellation(lastErr, options?.signal)) {
        if (probe) {
          state.probing = false;
          state.probeStartedAt = 0;
        }
        throw lastErr;
      }

      state.lastError = sanitizeErrorMessage(
        lastErr instanceof Error ? lastErr.message : String(lastErr),
      );
      if (probe) {
        // Failed probe — reopen. Hard failures back off exponentially (capped
        // at MAX_COOLDOWN_MS); a rate-limit stays on the short window.
        const backoffMs = reopenWithBackoff(state, cooldownMs, classifyFailure(lastErr));
        log.warn('breaker reopened after failed probe', {
          engine: engine.name,
          trips: state.trips,
          cooldownMs: backoffMs,
        });
      } else {
        recordFailure(engine.name, threshold, cooldownMs, classifyFailure(lastErr));
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    },
  };
}

/** Unique sentinel so a soft-deadline win is distinguishable from a real
 * engine result — a plain value could collide with an engine's payload. */
const SOFT_DEADLINE = Symbol('soft-deadline');

function failureReason(
  error: unknown,
  recoveryProbe: boolean,
): EngineOutcome['reason'] | undefined {
  if (error instanceof ThrottledError) return 'rate_limited';
  if (error instanceof BreakerOpenError) return 'breaker_open';
  if (isConcurrencyLimitedError(error)) return 'concurrency_limited';
  if (error instanceof UpstreamHttpError) {
    if (error.status === 429) return 'rate_limited';
    if (error.status === 504) return 'upstream_timeout';
  }
  if (error instanceof Error && error.name === 'TimeoutError') return 'upstream_timeout';
  return recoveryProbe ? 'recovery_probe' : undefined;
}

export async function runEnginesParallel(
  entries: EngineEntry[],
  query: string,
  options?: SearchEngineOptions,
  runOptions?: RunEnginesOptions,
): Promise<EngineOutcome[]> {
  const softDeadlineMs = runOptions?.softDeadlineMs;
  const chronicSoftDeadlineMs = runOptions?.chronicSoftDeadlineMs;
  const recoveryProbe = runOptions?.recoveryProbe ?? false;

  const promises = entries.map((entry): Promise<EngineOutcome> => {
    const name = entry.engine.name;
    const start = Date.now();
    const deadlineController = softDeadlineMs && softDeadlineMs > 0
      ? new AbortController()
      : undefined;
    const combined = deadlineController && options?.signal
      ? anySignal([options.signal, deadlineController.signal])
      : undefined;
    const engineSignal = combined?.signal ?? deadlineController?.signal ?? options?.signal;
    const engineOptions = engineSignal === options?.signal
      ? options
      : { ...options, signal: engineSignal };
    const settled = Promise.resolve()
      .then(() => entry.engine.search(query, engineOptions))
      .then(
        (results): EngineOutcome => ({
          engine: name,
          ok: true,
          results,
          latencyMs: Date.now() - start,
          ...(recoveryProbe ? { reason: 'recovery_probe' as const } : {}),
        }),
        (err): EngineOutcome => {
          const message = err instanceof Error ? err.message : String(err);
          const reason = failureReason(err, recoveryProbe);
          return {
            engine: name,
            ok: false,
            results: [],
            error: message,
            latencyMs: Date.now() - start,
            ...(reason ? { reason } : {}),
            ...(err instanceof BreakerOpenError
              ? { skipped: true, cooldownRemainingMs: err.cooldownRemainingMs }
              : {}),
          };
        },
      );
    void settled.finally(() => combined?.cleanup());

    // No soft deadline (or a zero/negative one): legacy behaviour — await the
    // engine directly so we wait for the slowest.
    if (!softDeadlineMs || softDeadlineMs <= 0) return settled;

    // A chronically-unhealthy engine gets the tighter budget; everyone else
    // gets the full pool deadline. Data-driven — no engine name is inspected.
    const budget =
      chronicSoftDeadlineMs !== undefined && isEngineChronicallyUnhealthy(name)
        ? Math.min(chronicSoftDeadlineMs, softDeadlineMs)
        : softDeadlineMs;

    // The adapter receives the deadline signal, so a deadline win cancels the
    // underlying request. `settled` maps rejection to an EngineOutcome and
    // therefore cannot become unhandled while the race resolves.

    let deadlineTimer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<typeof SOFT_DEADLINE>((resolve) => {
      deadlineTimer = setTimeout(() => {
        deadlineController?.abort(
          new DOMException(
            `soft-deadline timeout after ${budget}ms`,
            'TimeoutError',
          ),
        );
        resolve(SOFT_DEADLINE);
      }, budget);
    });

    return Promise.race([settled, deadline]).then((r): EngineOutcome => {
      // Clear the deadline timer when the engine wins the race so a fast pool
      // doesn't leave dangling timers keeping the event loop (and a short-
      // lived CLI process) alive to the budget.
      clearTimeout(deadlineTimer);
      return r === SOFT_DEADLINE
        ? {
            engine: name,
            ok: false,
            results: [],
            error: 'soft-deadline timeout: engine did not respond within the pool budget',
            // latencyMs here is the pool's observed WAIT (≈ the budget), not
            // the engine's true response time — cancellation was requested
            // here and adapter cleanup may still be unwinding.
            latencyMs: Date.now() - start,
            timedOut: true,
            reason: 'soft_deadline',
          }
        : (r as EngineOutcome);
    });
  });

  return Promise.all(promises);
}
