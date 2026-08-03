import type { SearchEngine, SearchEngineOptions, RawSearchResult } from '../../../types.js';
import { queryFeedStore } from './feed-store.js';

const SNIPPET_LIMIT = 200;

export class RssFeedEngine implements SearchEngine {
  name = 'rss-feed';

  async search(query: string, options: SearchEngineOptions = {}): Promise<RawSearchResult[]> {
    options.signal?.throwIfAborted();
    const items = queryFeedStore(query, {
      maxResults: options.maxResults ?? 10,
      ...(options.fromDate ? { fromDate: options.fromDate } : {}),
      ...(options.toDate ? { toDate: options.toDate } : {}),
    });
    const total = items.length;
    return items.map((it, i) => {
      options.signal?.throwIfAborted();
      const result: RawSearchResult = {
        title: it.title,
        url: it.link,
        snippet: it.summary.slice(0, SNIPPET_LIMIT),
        relevance_score: 1 - i / Math.max(total, 1),
        engine: 'rss-feed',
      };
      if (it.publishedDate) result.published_date = it.publishedDate;
      return result;
    });
  }
}
