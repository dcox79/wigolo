import type {
  SearchInput,
  SearchOutput,
  SearchEngine,
  ProgressCallback,
  StageResult,
} from '../types.js';
import type { SmartRouter } from '../fetch/router.js';
import type { BackendStatus } from '../server/backend-status.js';
import type { SamplingCapableServer } from '../search/sampling.js';
import { getSearchProvider } from '../providers/search-provider.js';

/**
 * Thin handler — validates wiring args and delegates to the selected search
 * provider (core by default, searxng opt-in via WIGOLO_SEARCH=searxng, hybrid
 * via WIGOLO_SEARCH=hybrid).
 *
 * Core orchestration lives in `src/search/core/`; the legacy SearXNG
 * orchestrator lives in `src/search/legacy/`.
 */
export async function handleSearch(
  input: SearchInput,
  engines: SearchEngine[],
  router: SmartRouter,
  backendStatus?: BackendStatus,
  samplingServer?: SamplingCapableServer,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<StageResult<SearchOutput>> {
  const provider = await getSearchProvider();
  return provider.search(input, {
    engines,
    router,
    backendStatus,
    samplingServer,
    onProgress,
    signal,
  });
}
