import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getConfig, resetConfig } from '../../../src/config.js';
import { resetPersistedConfig } from '../../../src/persisted-config.js';

// WIGOLO_SOLVE_SURFACE_URL's only consumer is a log line addressed to a human
// (the human-solve prompt), so the sanitizer is held to log-safety rules: it
// must never print a credential, a scheme that is unsafe to paste into a
// browser, or a value that can forge a second log record.

const originalEnv = process.env;
let dir: string;

beforeEach(() => {
  process.env = { ...originalEnv };
  dir = mkdtempSync(join(tmpdir(), 'wigolo-solve-surface-'));
  process.env.WIGOLO_CONFIG_PATH = join(dir, 'config.json');
  delete process.env.WIGOLO_SOLVE_SURFACE_URL;
  resetPersistedConfig();
  resetConfig();
});

afterEach(() => {
  process.env = originalEnv;
  rmSync(dir, { recursive: true, force: true });
  resetPersistedConfig();
  resetConfig();
});

describe('config — humanSolveSurfaceUrl', () => {
  it('defaults to null, leaving the desktop-oriented prompt wording in place', () => {
    expect(getConfig().humanSolveSurfaceUrl).toBeNull();
  });

  it('accepts the documented noVNC URL', () => {
    process.env.WIGOLO_SOLVE_SURFACE_URL = 'http://127.0.0.1:6080';
    resetConfig();
    expect(getConfig().humanSolveSurfaceUrl).toBe('http://127.0.0.1:6080/');
  });

  it('accepts https and preserves a path', () => {
    process.env.WIGOLO_SOLVE_SURFACE_URL = 'https://solve.example.com/vnc.html';
    resetConfig();
    expect(getConfig().humanSolveSurfaceUrl).toBe('https://solve.example.com/vnc.html');
  });

  it('strips userinfo so a basic-auth surface never logs its password', () => {
    process.env.WIGOLO_SOLVE_SURFACE_URL = 'http://admin:hunter2@127.0.0.1:6080/';
    resetConfig();
    const got = getConfig().humanSolveSurfaceUrl;
    expect(got).toBe('http://127.0.0.1:6080/');
    expect(got).not.toContain('hunter2');
    expect(got).not.toContain('admin');
  });

  it('rejects non-http schemes rather than handing an operator something to paste', () => {
    for (const raw of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x']) {
      process.env.WIGOLO_SOLVE_SURFACE_URL = raw;
      resetConfig();
      expect(getConfig().humanSolveSurfaceUrl).toBeNull();
    }
  });

  it('rejects a value that is not a URL at all', () => {
    process.env.WIGOLO_SOLVE_SURFACE_URL = 'open the vnc thing';
    resetConfig();
    expect(getConfig().humanSolveSurfaceUrl).toBeNull();
  });

  it('never yields a value carrying control characters into a log record', () => {
    process.env.WIGOLO_SOLVE_SURFACE_URL =
      'http://127.0.0.1:6080/\n[wigolo] forged log line';
    resetConfig();
    const got = getConfig().humanSolveSurfaceUrl;
    // Either rejected outright or normalized — what matters is that nothing
    // reaching the log can start a new record.
    if (got !== null) expect(/[\x00-\x1f\x7f]/.test(got)).toBe(false);
  });

  it('reads from persisted settings when the env var is unset', () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        version: 1,
        settings: { humanSolveSurfaceUrl: 'http://127.0.0.1:7070/' },
      }),
    );
    resetPersistedConfig();
    resetConfig();
    expect(getConfig().humanSolveSurfaceUrl).toBe('http://127.0.0.1:7070/');
  });
});
