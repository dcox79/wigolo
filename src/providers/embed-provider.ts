/**
 * Embed provider interface.
 *
 * Stable interface for embedding implementations. The default swapped the
 * sentence-transformers Python subprocess for fastembed (Rust ONNX via
 * Node bindings); the factory now returns FastembedEmbedProvider.
 */
import { createLogger } from '../logger.js';
import { getConfig } from '../config.js';
import type { ModelRuntimeSnapshot } from './model-runtime.js';

const log = createLogger('providers');

export interface EmbedProvider {
  /** Embed a batch of strings; returns one Float32Array per input. */
  embed(texts: string[]): Promise<Float32Array[]>;
  /** Dimensionality of embeddings produced by this provider. */
  readonly dim: number;
  /** Model identifier (for cache invalidation / provenance). */
  readonly modelId: string;
  /** Optional native-resource lifecycle hooks implemented by built-ins. */
  dispose?(): Promise<void>;
  getRuntimeState?(): ModelRuntimeSnapshot;
}

let cached: Promise<EmbedProvider> | null = null;
let current: EmbedProvider | null = null;
let loading = false;
let lastError: string | null = null;

export function getEmbedProvider(): Promise<EmbedProvider> {
  if (cached) return cached;
  loading = true;
  lastError = null;
  cached = import('../embedding/fastembed-provider.js')
    .then(async m => {
      const p = new m.FastembedEmbedProvider();
      current = p;
      await p.warmup();
      loading = false;
      log.info('embed provider ready', { provider: 'embed', impl: 'fastembed', modelId: p.modelId, dim: p.dim });
      return p;
    })
    .catch(err => {
      // Clear cache on any failure (import or warmup) so the next call retries.
      cached = null;
      current = null;
      loading = false;
      lastError = err instanceof Error ? err.message : String(err);
      throw err;
    });
  return cached;
}

export function _resetEmbedProviderForTest(): void {
  if (current && typeof current.dispose === 'function') void current.dispose();
  cached = null;
  current = null;
  loading = false;
  lastError = null;
}

export async function disposeEmbedProvider(): Promise<void> {
  const provider = current;
  cached = null;
  current = null;
  loading = false;
  if (provider && typeof provider.dispose === 'function') {
    try {
      await provider.dispose();
    } catch (err) {
      log.debug('embed dispose failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export function getEmbedProviderState(): ModelRuntimeSnapshot {
  if (current && typeof current.getRuntimeState === 'function') {
    return current.getRuntimeState();
  }
  const configTimeout = getConfig().embeddingIdleTimeoutMs;
  return {
    state: loading ? 'loading' : lastError ? 'error' : 'unloaded',
    loaded: false,
    model_id: getConfig().embeddingModel,
    in_flight: 0,
    idle_timeout_ms: Number.isFinite(configTimeout) ? configTimeout : 1_800_000,
    last_used_at: null,
    unload_due_at: null,
    last_loaded_at: null,
    last_unloaded_at: null,
    load_count: 0,
    unload_count: 0,
    dispose_supported: true,
    last_error: lastError,
  };
}
