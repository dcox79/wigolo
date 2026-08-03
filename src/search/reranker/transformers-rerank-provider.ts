import { join } from 'node:path';
import {
  AutoTokenizer,
  AutoModelForSequenceClassification,
  env,
} from '@huggingface/transformers';
import type {
  RerankProvider,
  RerankCandidate,
  RerankResult,
} from '../../providers/rerank-provider.js';
import { createLogger } from '../../logger.js';
import { getConfig } from '../../config.js';
import {
  IdleModelRuntime,
  type ModelRuntimeSnapshot,
} from '../../providers/model-runtime.js';

const log = createLogger('reranker');
const DEFAULT_RERANKER_IDLE_TIMEOUT_MS = 300_000;

// Cross-encoder reranker via Transformers.js.
//
// The high-level `pipeline('text-classification', ...)` API does not pass
// `text_pair`, so it can't drive a cross-encoder properly. We therefore
// load the tokenizer + sequence-classification model directly: feed
// (query, document) pairs to the tokenizer and read raw logits from the
// model. ms-marco-MiniLM-L-6-v2 is a single-output regressor (num_labels=1)
// where higher logit = more relevant, so the logit is used as the rerank
// score with no further transform.
type Tokenizer = Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
type Model = Awaited<ReturnType<typeof AutoModelForSequenceClassification.from_pretrained>>;

interface LogitsTensor {
  data: ArrayLike<number>;
  dims: number[];
}

interface LoadedReranker {
  tokenizer: Tokenizer;
  model: Model;
}

export interface TransformersRerankProviderOptions {
  idleTimeoutMs?: number;
  /** Injection seam for lifecycle tests. */
  load?: () => Promise<LoadedReranker>;
}

// Recognize the noisy huggingface fetch failure signature and replace it
// with an actionable instruction. Transformers.js parses a config that
// failed to download, then dereferences `tokenizer_class` on undefined.
function wrapLoadError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  const looksLikeMissingModel =
    /tokenizer_class|tokenizer_config|preprocessor_config|fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ENETUNREACH/i.test(
      message,
    );
  if (looksLikeMissingModel) {
    return new Error(
      `Reranker model not downloaded — run \`wigolo warmup\` (cause: ${message})`,
    );
  }
  return new Error(`Failed to load reranker model: ${message}`);
}

export class TransformersRerankProvider implements RerankProvider {
  private readonly runtime: IdleModelRuntime<LoadedReranker>;
  readonly modelId: string;

  constructor(options: TransformersRerankProviderOptions = {}) {
    this.modelId = 'Xenova/ms-marco-MiniLM-L-6-v2';
    const configuredTimeout = getConfig().rerankerIdleTimeoutMs;
    const idleTimeoutMs = options.idleTimeoutMs
      ?? (Number.isFinite(configuredTimeout)
        ? configuredTimeout
        : DEFAULT_RERANKER_IDLE_TIMEOUT_MS);
    this.runtime = new IdleModelRuntime({
      name: 'reranker',
      modelId: this.modelId,
      idleTimeoutMs,
      load: options.load ?? (() => this.loadModel()),
      dispose: async ({ model }) => {
        const disposable = model as unknown as { dispose?: () => Promise<unknown> };
        if (typeof disposable.dispose === 'function') await disposable.dispose();
      },
    });
  }

  async warmup(): Promise<void> {
    await this.runtime.warmup();
  }

  private loadModel(): Promise<LoadedReranker> {
    log.info('Loading rerank model', { modelId: this.modelId });
    const cacheDir = join(getConfig().dataDir, 'transformers');
    // Direct the library at a writable cache under the wigolo data dir so
    // models don't end up in a user home cache the daemon can't manage.
    env.cacheDir = cacheDir;

    return Promise.all([
      AutoTokenizer.from_pretrained(this.modelId),
      AutoModelForSequenceClassification.from_pretrained(this.modelId),
    ])
      .then(([tokenizer, model]) => {
        return { tokenizer, model };
      })
      .catch((err: unknown) => {
        throw wrapLoadError(err);
      });
  }

  async rerank(
    query: string,
    candidates: RerankCandidate[],
    topK = candidates.length,
  ): Promise<RerankResult[]> {
    if (candidates.length === 0) return [];

    return this.runtime.withResource(async ({ tokenizer, model }) => {
      // Build batch: query repeated against each document.
      const queries = candidates.map(() => query);
      const docs = candidates.map((c) => c.text);

      const inputs = tokenizer(queries, {
        text_pair: docs,
        padding: true,
        truncation: true,
      });

      const outputs = (await model(inputs)) as { logits: LogitsTensor };
      const logits = outputs.logits;
      // logits shape is [batch, 1] for single-label regression rerankers.
      // For multi-label heads (rare for rerankers) we still take the first
      // value as the relevance score.
      const stride = logits.dims.length >= 2 ? logits.dims[1] : 1;
      const data = logits.data;

      const scored: RerankResult[] = candidates.map((c, i) => ({
        id: c.id,
        score: Number(data[i * stride]),
      }));

      return scored.sort((a, b) => b.score - a.score).slice(0, topK);
    });
  }

  // Release the underlying ONNX session before process exit. Without this,
  // the runtime's worker threads race during C++ destructor teardown and
  // surface as `mutex lock failed: Invalid argument` on macOS.
  async dispose(): Promise<void> {
    await this.runtime.dispose();
  }

  getRuntimeState(): ModelRuntimeSnapshot {
    return this.runtime.snapshot();
  }
}
