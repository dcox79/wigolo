/**
 * Default SecretStore — keychain-preferred, file-fallback implementation
 * used by the propagation pipeline.
 *
 * Resolution:
 *   1. OS keychain (via the SP4 keychain wrapper). When available, secrets
 *      live there and never touch the disk.
 *   2. AES-256-GCM encrypted file fallback at `<dataDir>/keys/<key>.enc` with
 *      mode 0o600 inside a 0o700 directory. Existing plaintext files from
 *      older releases are migrated on first read.
 *
 * The keychain account name is `wigolo-tui-<key>` and the user is `tui` so
 * stored entries don't collide with the per-provider entries managed by
 * `src/security/key-store.ts`.
 */

import { join } from 'node:path';
import { readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  keychainAvailable,
  keychainSet,
  keychainGet,
  keychainDelete,
  WIGOLO_SERVICE,
} from '../../../security/keychain.js';
import type { SecretStore } from './propagation.js';
import { decryptFromFile, encryptToFile } from '../../../security/key-crypto.js';

const KEYCHAIN_USER = 'tui';
export interface DefaultSecretStoreOpts {
  dataDir: string;
}

function keychainAccount(key: string): string {
  return `${WIGOLO_SERVICE}-tui-${key}`;
}

function filePath(dataDir: string, key: string): string {
  // Keys are short ASCII identifiers (settings paths like `llmApiKey`). We
  // do not sanitize aggressively because the schema is the only producer;
  // callers passing path separators would already be a bug upstream.
  return join(dataDir, 'keys', `${key}.enc`);
}

function legacyPlaintextPath(dataDir: string, key: string): string {
  return join(dataDir, 'keys', key);
}

export function defaultSecretStore(opts: DefaultSecretStoreOpts): SecretStore {
  return {
    async set(key, value) {
      // Prefer keychain. If it claims available but throws on write (sandboxed
      // OS keychain, etc.), fall through to the file tier rather than failing
      // the whole save.
      if (keychainAvailable()) {
        try {
          keychainSet(keychainAccount(key), KEYCHAIN_USER, value);
          return { location: 'keychain' };
        } catch {
          // fall through
        }
      }
      await encryptToFile(value, opts.dataDir, filePath(opts.dataDir, key));
      const legacyPath = legacyPlaintextPath(opts.dataDir, key);
      if (existsSync(legacyPath)) {
        try { await unlink(legacyPath); } catch { /* best-effort migration cleanup */ }
      }
      return { location: 'file' };
    },

    async get(key) {
      if (keychainAvailable()) {
        const v = keychainGet(keychainAccount(key), KEYCHAIN_USER);
        if (v !== null && v.length > 0) return v;
      }
      const path = filePath(opts.dataDir, key);
      if (existsSync(path)) {
        try {
          return await decryptFromFile(opts.dataDir, path);
        } catch {
          return null;
        }
      }

      // One-time migration from the pre-hardening plaintext fallback.
      const legacyPath = legacyPlaintextPath(opts.dataDir, key);
      if (!existsSync(legacyPath)) return null;
      try {
        const value = await readFile(legacyPath, 'utf-8');
        await encryptToFile(value, opts.dataDir, path);
        await unlink(legacyPath);
        return value;
      } catch {
        return null;
      }
    },

    async remove(key) {
      if (keychainAvailable()) {
        try {
          keychainDelete(keychainAccount(key), KEYCHAIN_USER);
        } catch {
          // Best-effort: keychain delete is non-fatal.
        }
      }
      const path = filePath(opts.dataDir, key);
      if (existsSync(path)) {
        try { await unlink(path); } catch { /* ignore */ }
      }
      const legacyPath = legacyPlaintextPath(opts.dataDir, key);
      if (existsSync(legacyPath)) {
        try { await unlink(legacyPath); } catch { /* ignore */ }
      }
    },
  };
}
