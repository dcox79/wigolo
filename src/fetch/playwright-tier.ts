import { chromium, type Browser, type BrowserContext } from 'playwright';
import { existsSync } from 'node:fs';
import { createLogger } from '../logger.js';
import { abortRejection } from '../util/abort.js';
import { settlePage, POST_GOTO_CAP_MS } from './settle.js';
import type { ContentCompleteness } from '../types.js';
import { type NetworkRequestGuard } from './network-security.js';
import { acquireGlobalBrowserCapacity } from './browser-capacity.js';

const log = createLogger('playwright-tier');

export interface InstallStatus {
  installed: boolean;
  hint?: string;
}

export async function detectPlaywrightInstall(): Promise<InstallStatus> {
  try {
    const exec = chromium.executablePath();
    if (exec && existsSync(exec)) return { installed: true };
    return { installed: false, hint: 'npx playwright install chromium' };
  } catch {
    return { installed: false, hint: 'npx playwright install chromium' };
  }
}

export function shouldEscalate(body: string): boolean {
  if (!body) return true;
  if (body.length < 500) return true;
  if (/enable javascript/i.test(body)) return true;
  return false;
}

let _browser: Browser | null = null;
let _ctx: BrowserContext | null = null;
let _launching: Promise<{ browser: Browser; context: BrowserContext }> | null = null;
let _closing: Promise<void> | null = null;
let _generation = 0;

async function getDaemonBrowserWithinCapacity(): Promise<{ browser: Browser; context: BrowserContext }> {
  await _closing;
  if (_browser && _ctx) return { browser: _browser, context: _ctx };
  if (_launching) return _launching;

  const generation = _generation;
  let launchedBrowser: Browser | null = null;
  let launchedContext: BrowserContext | null = null;
  let launchPromise!: Promise<{ browser: Browser; context: BrowserContext }>;
  launchPromise = (async () => {
    try {
      const status = await detectPlaywrightInstall();
      if (!status.installed) {
        const err = new Error('playwright_not_installed') as Error & { hint?: string };
        err.hint = status.hint;
        throw err;
      }
      launchedBrowser = await chromium.launch({ headless: true });
      launchedContext = await launchedBrowser.newContext();
      if (generation !== _generation) {
        throw new DOMException('daemon browser closed during launch', 'AbortError');
      }
      _browser = launchedBrowser;
      _ctx = launchedContext;
      log.info('Playwright daemon browser launched');
      return { browser: launchedBrowser, context: launchedContext };
    } catch (err) {
      if (launchedContext && launchedContext !== _ctx) {
        await launchedContext.close().catch(() => {});
      }
      if (launchedBrowser && launchedBrowser !== _browser) {
        await launchedBrowser.close().catch(() => {});
      }
      throw err;
    } finally {
      if (_launching === launchPromise) _launching = null;
    }
  })();
  _launching = launchPromise;
  return launchPromise;
}

export async function getDaemonBrowser(
  signal?: AbortSignal,
): Promise<{ browser: Browser; context: BrowserContext }> {
  const releaseCapacity = await acquireGlobalBrowserCapacity(signal);
  try {
    return await getDaemonBrowserWithinCapacity();
  } finally {
    releaseCapacity();
  }
}

export async function closeDaemonBrowser(): Promise<void> {
  if (_closing) return _closing;
  let closingPromise!: Promise<void>;
  closingPromise = (async () => {
    _generation++;
    await _launching?.catch(() => undefined);
    const context = _ctx;
    const browser = _browser;
    _ctx = null;
    _browser = null;
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  })();
  _closing = closingPromise;
  try {
    await closingPromise;
  } finally {
    if (_closing === closingPromise) _closing = null;
  }
}

export async function fetchWithPlaywright(url: string, opts: {
  timeoutMs?: number;
  signal?: AbortSignal;
  requestGuard?: NetworkRequestGuard;
} = {}): Promise<{ html: string; text: string; completeness: ContentCompleteness }> {
  // Bail out immediately if the caller's budget is already exhausted.
  if (opts.signal?.aborted) throw opts.signal.reason;

  const releaseCapacity = await acquireGlobalBrowserCapacity(opts.signal);
  let page: import('playwright').Page | null = null;
  let onAbort: (() => void) | undefined;
  try {
    const { context } = await getDaemonBrowserWithinCapacity();
    if (opts.signal?.aborted) throw opts.signal.reason;
    page = await context.newPage();
    let blockedNavigationError: unknown;

    // The legacy stealth helper also needs the per-request browser gate. Without
    // this route, its redirects/subresources would bypass SmartRouter's initial
    // URL check.
    if (opts.requestGuard) {
      await page.route('**/*', async (route) => {
        const request = route.request();
        try {
          await opts.requestGuard?.(request.url(), 'browser request');
          await route.continue();
        } catch (err) {
          if (request.isNavigationRequest() && request.frame() === page!.mainFrame()) {
            blockedNavigationError = err;
          }
          await route.abort('blockedbyclient').catch(() => {});
        }
      });
    }

    // When the caller's signal fires, close THIS page so the in-flight
    // navigation is cancelled. The shared daemon context is never closed here.
    onAbort = () => { page?.close().catch(() => {}); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const overall = opts.timeoutMs ?? 30000;
    // Race the navigation against the caller's abort signal.
    // abortRejection never settles when no signal is given (safe loser in race).
    try {
      await Promise.race([
        page.goto(url, { waitUntil: 'load', timeout: overall }),
        abortRejection(opts.signal),
      ]);
    } catch (err) {
      if (blockedNavigationError) throw blockedNavigationError;
      throw err;
    }
    // A fast load can win its race while the budget is already exhausted —
    // bail before entering the post-goto waits so a never-idling SPA can't
    // hold the slot past the budget.
    if (opts.signal?.aborted) throw opts.signal.reason;
    const settle = await settlePage(page, { budgetMs: Math.min(overall, POST_GOTO_CAP_MS), signal: opts.signal, url });
    if (opts.signal?.aborted) throw opts.signal.reason;
    const html = await page.content();
    const text = await page.evaluate(() => document.body?.innerText ?? '');
    return { html, text, completeness: settle.completeness };
  } finally {
    if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
    // Close the page; tolerate already-closed (double-close is safe).
    await page?.close().catch(() => {});
    releaseCapacity();
  }
}
