import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('fetch');

export interface BrowserCapacityState {
  limit: number;
  inFlight: number;
  queued: number;
  peakInFlight: number;
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('browser work aborted', 'AbortError');
}

/**
 * Process-wide browser-work bulkhead.
 *
 * A lease represents one active browser-backed request, regardless of whether
 * it uses a pooled context, a dedicated hardened browser, CDP, or the legacy
 * daemon Playwright helper. Keeping the gate in its own module makes every
 * browser entry point share the same MAX_BROWSERS budget.
 */
class BrowserCapacityGate {
  private inFlight = 0;
  private peakInFlight = 0;
  private readonly waiters: Waiter[] = [];

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));

    const limit = this.limit();
    if (this.waiters.length === 0 && this.inFlight < limit) {
      return Promise.resolve(this.grant());
    }

    log.debug('browser work queued behind global capacity gate', {
      reason: 'concurrency_limited',
      limit,
      inFlight: this.inFlight,
      queued: this.waiters.length + 1,
    });

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          reject(abortReason(signal));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
      // A runtime limit increase should take effect without waiting for an
      // unrelated release.
      this.drain();
    });
  }

  state(): BrowserCapacityState {
    return {
      limit: this.limit(),
      inFlight: this.inFlight,
      queued: this.waiters.length,
      peakInFlight: this.peakInFlight,
    };
  }

  private limit(): number {
    return Math.max(1, getConfig().maxBrowsers);
  }

  private grant(): () => void {
    this.inFlight++;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.drain();
    };
  }

  private drain(): void {
    while (this.waiters.length > 0 && this.inFlight < this.limit()) {
      const waiter = this.waiters.shift()!;
      if (waiter.onAbort && waiter.signal) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      if (waiter.signal?.aborted) {
        waiter.reject(abortReason(waiter.signal));
        continue;
      }
      waiter.resolve(this.grant());
    }
  }
}

const globalBrowserCapacity = new BrowserCapacityGate();

export function acquireGlobalBrowserCapacity(signal?: AbortSignal): Promise<() => void> {
  return globalBrowserCapacity.acquire(signal);
}

/** Read-only state used by health/diagnostics and focused regression tests. */
export function getGlobalBrowserCapacityState(): BrowserCapacityState {
  return globalBrowserCapacity.state();
}
