import {
  getProcessMemorySnapshot,
  type ModelRuntimeSnapshot,
  type ProcessMemorySnapshot,
} from '../providers/model-runtime.js';
import { getEmbedProviderState } from '../providers/embed-provider.js';
import { getRerankProviderState } from '../providers/rerank-provider.js';

export interface RuntimeTelemetry {
  memory: ProcessMemorySnapshot;
  models: {
    embedding: ModelRuntimeSnapshot;
    reranker: ModelRuntimeSnapshot;
  };
}

/** Read-only daemon telemetry; contains no request data or credentials. */
export function getRuntimeTelemetry(): RuntimeTelemetry {
  return {
    memory: getProcessMemorySnapshot(),
    models: {
      embedding: getEmbedProviderState(),
      reranker: getRerankProviderState(),
    },
  };
}
