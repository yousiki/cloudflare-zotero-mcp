import type { ZoteroItem } from '../zotero/types.js';
import {
  documentMetadata,
  documentName,
  documentText,
  isIndexable,
  itemKeyOf,
} from './document.js';
import type { IndexStats, SemanticIndex, SemanticMatch, SemanticQueryOptions } from './types.js';

/**
 * Everything about the instance that this code depends on, declared here rather
 * than clicked into the dashboard. `ensure()` creates the instance from this on
 * first use; it deliberately never *updates* an existing one, because changing
 * `custom_metadata` or the embedding model triggers a full re-index of the
 * library and that is not something a cron run should do behind your back.
 */
export interface AiSearchSettings {
  /** Instance id. Must match `^[a-z0-9_]+(?:-[a-z0-9_]+)*$`. */
  instance: string;
  embeddingModel: string;
  rerankingModel: string;
  /**
   * Rewriting spends an extra LLM call to rephrase the query. The caller here
   * is already a model that phrased the query on purpose, so this is off unless
   * asked for.
   */
  rewriteQuery: boolean;
}

export const DEFAULT_EMBEDDING_MODEL = '@cf/baai/bge-m3';
export const DEFAULT_RERANKING_MODEL = '@cf/baai/bge-reranker-base';

/**
 * `max_num_results` counts chunks, not items, and one item's document can be
 * split into several. Asking for this multiple of the wanted item count keeps a
 * page of results from collapsing to a handful once chunks are folded back into
 * items.
 */
const CHUNKS_PER_ITEM = 2;

/** `max_num_results` is rejected above 50. */
const MAX_CHUNKS = 50;

/** `items.list` returns at most 50 per page. */
const LIST_PAGE = 50;

/**
 * A safety stop for the delete scan, not a budget: at 50 per page this covers a
 * 250,000-document instance. Exceeding it means the listing is not terminating,
 * which is a failure rather than a reason to leave documents behind.
 */
const MAX_LIST_PAGES = 5000;

/** Uploads in flight at once. Each one is a subrequest, so this is deliberately low. */
const UPLOAD_CONCURRENCY = 6;

export class AiSearchSemanticIndex implements SemanticIndex {
  constructor(
    private readonly namespace: AiSearchNamespace,
    private readonly settings: AiSearchSettings,
  ) {}

  get id(): string {
    return this.settings.instance;
  }

  private get instance(): AiSearchInstance {
    return this.namespace.get(this.settings.instance);
  }

  /**
   * Creates the instance if it is missing, so a fresh deploy needs no dashboard
   * step. Called from the sync job only — the read path must not create state.
   *
   * The return value matters: a freshly created instance holds nothing, so the
   * caller must ignore any stored cursor and resubmit the library. Without that,
   * deleting the instance while the cursor sits at the newest library version
   * leaves an empty index that no incremental run ever refills.
   */
  async ensure(): Promise<{ created: boolean }> {
    try {
      await this.instance.info();
      return { created: false };
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    await this.namespace.create({
      id: this.settings.instance,
      // Hybrid: the vector half answers the conceptual queries, the keyword half
      // the exact ones. Both are fused by AI Search, which is the point of using
      // it instead of a bare vector index.
      index_method: { vector: true, keyword: true },
      fusion_method: 'rrf',
      embedding_model: this.settings.embeddingModel,
      reranking: true,
      reranking_model: this.settings.rerankingModel,
      rewrite_query: this.settings.rewriteQuery,
      chunk: true,
      // Nothing is dropped for being far away; see `match_threshold` in `query`.
      score_threshold: 0,
      // Five fields is the cap and there is no array type, so only what can
      // actually be pushed down lives here. See `documentMetadata`.
      custom_metadata: [
        { field_name: 'itemtype', data_type: 'text' },
        { field_name: 'year', data_type: 'number' },
      ],
    });
    return { created: true };
  }

  async query(text: string, options: SemanticQueryOptions = {}): Promise<SemanticMatch[]> {
    const wanted = Math.min(options.topK ?? 10, MAX_CHUNKS);
    const filters: Record<string, unknown> = {};
    // A negated type is a Zotero spelling that has no equivalent here, and it is
    // enforced by the item lookup instead.
    if (options.itemType && !options.itemType.startsWith('-')) {
      filters.itemtype = { $eq: options.itemType };
    }
    if (options.fromYear || options.toYear) {
      filters.year = {
        ...(options.fromYear ? { $gte: options.fromYear } : {}),
        ...(options.toYear ? { $lte: options.toYear } : {}),
      };
    }

    const response = await this.instance.search({
      query: text,
      ai_search_options: {
        retrieval: {
          retrieval_type: options.retrieval ?? 'hybrid',
          max_num_results: Math.min(wanted * CHUNKS_PER_ITEM, MAX_CHUNKS),
          // 0, not the 0.4 default: this search reports how weak its matches are
          // rather than hiding them, so the floor lives in `zotero_search` and
          // nothing is discarded on the way here.
          match_threshold: 0,
          ...(Object.keys(filters).length > 0
            ? { filters: filters as VectorizeVectorMetadataFilter }
            : {}),
        },
        reranking: { enabled: true, match_threshold: 0 },
        query_rewrite: { enabled: this.settings.rewriteQuery },
      },
    });

    // Chunks arrive in fused, reranked order and several may belong to one item.
    // First appearance sets an item's rank; its best vector score is reported.
    const ranked: SemanticMatch[] = [];
    const seen: Record<string, SemanticMatch> = {};
    for (const chunk of response.chunks) {
      const itemKey = itemKeyOf(chunk.item.key);
      // Only the cosine half is reported. The fused score mixes in BM25 rank and
      // is not on the same scale as the bands `zotero_search` judges against, and
      // a chunk that matched on keywords alone has no distance to report — just
      // like a keyword hit from Zotero, which carries no score either.
      const score = chunk.scoring_details?.vector_score;
      const existing = seen[itemKey];
      if (existing) {
        if (score !== undefined && (existing.score === undefined || score > existing.score)) {
          existing.score = score;
        }
        continue;
      }
      const match: SemanticMatch = { itemKey, score };
      seen[itemKey] = match;
      ranked.push(match);
    }
    // `topK` is a count of items, and the chunk overshoot above means more items
    // than that can survive the fold. Handing the extras back would make the
    // caller's Zotero lookup wider than it asked for.
    return ranked.slice(0, wanted);
  }

  async stats(): Promise<IndexStats> {
    const stats = await this.instance.stats();
    return {
      vectors: stats.engine?.vectorize?.vectorsCount ?? 0,
      queued: (stats.queued ?? 0) + (stats.outdated ?? 0),
      running: stats.running ?? 0,
      failed: stats.error ?? 0,
    };
  }

  /**
   * Uploads one document per item. `upload` is an upsert on the document name,
   * so a changed item replaces its own document, and it returns as soon as the
   * document is queued — indexing finishes afterwards, which is why the sync
   * report talks about submitted items and reads `stats()` for the backlog.
   */
  async upsertItems(items: ZoteroItem[]): Promise<number> {
    const indexable = items.filter(isIndexable);
    let written = 0;
    for (let offset = 0; offset < indexable.length; offset += UPLOAD_CONCURRENCY) {
      const batch = indexable.slice(offset, offset + UPLOAD_CONCURRENCY);
      await Promise.all(
        batch.map(async (item) => {
          await this.instance.items.upload(documentName(item.key), documentText(item.data), {
            metadata: documentMetadata(item),
          });
          written += 1;
        }),
      );
    }
    return written;
  }

  /**
   * Deletes the documents belonging to `keys`. `items.delete` takes AI Search's
   * own item id, not the document key, so the ids are resolved by listing.
   *
   * Zotero's `/deleted` feed reports every deleted object — attachments, notes
   * and annotations included — and none of those were ever uploaded, so a key
   * with no document is the normal case and not an error. What *would* be an
   * error is giving up mid-scan and reporting success: the caller advances the
   * library cursor on the strength of this returning, so an unfinished scan
   * throws instead.
   */
  async removeItems(keys: string[]): Promise<void> {
    if (keys.length === 0) return;

    const wanted: Record<string, true> = {};
    for (const key of keys) wanted[documentName(key)] = true;
    let outstanding = keys.length;
    const ids: string[] = [];

    for (let page = 1; outstanding > 0; page += 1) {
      if (page > MAX_LIST_PAGES) {
        throw new Error(
          `AI Search: listing ${this.settings.instance} did not terminate within ${MAX_LIST_PAGES} pages, so ${outstanding} deleted item(s) could not be removed.`,
        );
      }
      const listed = await this.instance.items.list({
        page,
        per_page: LIST_PAGE,
        source: 'builtin',
      });
      for (const entry of listed.result) {
        if (!wanted[entry.key]) continue;
        delete wanted[entry.key];
        outstanding -= 1;
        ids.push(entry.id);
      }
      // A short page is the end of the list: every key still outstanding simply
      // has no document, which is expected for objects that are never indexed.
      if (listed.result.length < LIST_PAGE) break;
    }

    for (const id of ids) {
      await this.instance.items.delete(id);
    }
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && /not.?found/i.test(`${error.name} ${error.message}`);
}
