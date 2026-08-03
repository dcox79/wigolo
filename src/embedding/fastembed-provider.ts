import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
// Type-only: the runtime module is dynamic-imported inside getModel() so the
// native ONNX runtime is NOT mapped into the process at boot (D2 idle-footprint
// contract) — a static import loads the native binding the moment any file in
// the boot chain touches this module.
import type { FlagEmbedding } from 'fastembed';
import type { EmbedProvider } from '../providers/embed-provider.js';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import {
  IdleModelRuntime,
  type ModelRuntimeSnapshot,
} from '../providers/model-runtime.js';

const log = createLogger('embedding');
const requireFromHere = createRequire(import.meta.url);
const DEFAULT_EMBEDDING_IDLE_TIMEOUT_MS = 1_800_000;

export const FASTEMBED_MODEL_ID = 'BGE-small-en-v1.5';

type TarCompatModule = Record<string, unknown> & {
  default?: unknown;
  x?: unknown;
};

/**
 * fastembed@2.1.0 imports tar as a CommonJS-style default, but the first tar
 * release containing the current extraction fixes (7.5.19+) exposes named
 * exports only. Load fastembed's CommonJS entry after supplying that legacy
 * default shape so it can call the patched tar.x implementation.
 *
 * Remove this adapter when fastembed ships native tar 7 support.
 */
export function loadFastembedWithPatchedTar(): typeof import('fastembed') {
  const tarModule = requireFromHere('tar') as TarCompatModule;
  if (typeof tarModule.x !== 'function') {
    throw new Error('The installed tar package does not expose the required x() extractor');
  }
  if (tarModule.default === undefined) {
    tarModule.default = tarModule;
  }
  return requireFromHere('fastembed') as typeof import('fastembed');
}

/**
 * Ensure the fastembed model cache dir (and any missing parents) exists, then
 * return it. fastembed's own `retrieveModel` does a NON-recursive
 * `mkdirSync(cacheDir)`, so on a fresh machine where `${dataDir}` (e.g.
 * `~/.wigolo`) does not exist yet the download throws
 * `ENOENT: mkdir '...\.wigolo\fastembed'` (seen on Windows). Pre-creating the
 * dir recursively makes fastembed's own `existsSync` check pass and skips its
 * broken mkdir.
 */
export function ensureFastembedCacheDir(dataDir: string): string {
  const cacheDir = join(dataDir, 'fastembed');
  mkdirSync(cacheDir, { recursive: true });
  return cacheDir;
}

/**
 * Remove the fastembed cache dir and recreate it empty — used to clear a
 * partial/corrupt model download (a leftover `.tar.gz` that fastembed will not
 * re-fetch) before retrying.
 */
export function resetFastembedCacheDir(dataDir: string): string {
  rmSync(join(dataDir, 'fastembed'), { recursive: true, force: true });
  return ensureFastembedCacheDir(dataDir);
}

/**
 * True when an error looks like a truncated/corrupt model archive — the field
 * `TAR_BAD_ARCHIVE: Unrecognized archive format` and its decompress cousins.
 * These recover by wiping the partial file and re-downloading; unrelated errors
 * (e.g. a missing native tokenizer binary) do NOT, so they must not match.
 */
export function isCorruptArchiveError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /TAR_BAD_ARCHIVE|Unrecognized archive format|unexpected end of (file|data)|incorrect header check|invalid (tar|gzip)|zlib/i.test(
    msg,
  );
}

/**
 * Run a model init; on a corrupt-archive failure ONLY, reset the cache and try
 * exactly once more. Any other error propagates immediately (a re-download would
 * not fix it). Pure over its injected `init`/`resetCache`, so the retry is tested
 * without touching the network or the native runtime.
 */
export async function initModelWithArchiveRetry<T>(
  init: () => Promise<T>,
  resetCache: () => void,
): Promise<T> {
  try {
    return await init();
  } catch (err) {
    if (!isCorruptArchiveError(err)) throw err;
    resetCache();
    return await init();
  }
}

type ReleasableFastembedModel = {
  // fastembed does not expose disposal in its public type, but its current
  // implementation stores the public onnxruntime InferenceSession here.
  session?: { release?: () => Promise<void> };
};

export interface FastembedEmbedProviderOptions {
  idleTimeoutMs?: number;
  /** Injection seam for lifecycle tests; production uses FlagEmbedding.init. */
  loadModel?: () => Promise<FlagEmbedding>;
}

/**
 * Native ONNX embedding provider using fastembed-rs Node bindings.
 *
 * Model: BGE-small-en-v1.5 (384-dim). First call to `warmup()` downloads
 * the ONNX model to `${dataDir}/fastembed`. Subsequent runs reuse the cache.
 * Replaces the legacy sentence-transformers Python subprocess.
 */
export class FastembedEmbedProvider implements EmbedProvider {
  private readonly runtime: IdleModelRuntime<FlagEmbedding>;
  readonly modelId: string;
  readonly dim: number;

  constructor(options: FastembedEmbedProviderOptions = {}) {
    this.modelId = FASTEMBED_MODEL_ID;
    this.dim = 384;
    const configuredTimeout = getConfig().embeddingIdleTimeoutMs;
    const idleTimeoutMs = options.idleTimeoutMs
      ?? (Number.isFinite(configuredTimeout)
        ? configuredTimeout
        : DEFAULT_EMBEDDING_IDLE_TIMEOUT_MS);

    this.runtime = new IdleModelRuntime({
      name: 'embedding',
      modelId: this.modelId,
      idleTimeoutMs,
      load: options.loadModel ?? (() => this.loadModel()),
      dispose: async (model) => {
        // fastembed@2.1 has no public dispose method. Its internal session is an
        // onnxruntime InferenceSession, whose documented release() frees the
        // native graph/arena. Keep the access guarded for forward compatibility;
        // dropping the final model reference still allows GC on other versions.
        const session = (model as unknown as ReleasableFastembedModel).session;
        if (typeof session?.release === 'function') await session.release();
      },
    });
  }

  async warmup(): Promise<void> {
    await this.runtime.warmup();
  }

  private loadModel(): Promise<FlagEmbedding> {
    log.info('Loading embedding model', { modelId: this.modelId });
    const dataDir = getConfig().dataDir;
    const cacheDir = ensureFastembedCacheDir(dataDir);
    return Promise.resolve()
      .then(() => loadFastembedWithPatchedTar())
      .then(({ FlagEmbedding, EmbeddingModel }) =>
        initModelWithArchiveRetry(
          () => FlagEmbedding.init({ model: EmbeddingModel.BGESmallENV15, cacheDir }),
          () => resetFastembedCacheDir(dataDir),
        ),
      )
      .then(m => {
        log.info('Embedding model ready', { modelId: this.modelId, dim: this.dim });
        return m;
      });
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    return this.runtime.withResource(async (model) => {
      const out: Float32Array[] = [];
      for await (const batch of model.embed(texts, texts.length)) {
        for (const vec of batch) {
          out.push(Float32Array.from(vec));
        }
      }
      return out;
    });
  }

  getRuntimeState(): ModelRuntimeSnapshot {
    return this.runtime.snapshot();
  }

  async dispose(): Promise<void> {
    await this.runtime.dispose();
  }
}
