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
   * Query rewriting is deliberately absent. AI Search only rewrites when a
   * request uses the `messages` format *and* carries conversation history — the
   * first message is always used as-is — and MCP is stateless, so every call
   * here is a single standalone query. The setting could never fire.
   */
}

export const DEFAULT_EMBEDDING_MODEL = '@cf/baai/bge-m3';
export const DEFAULT_RERANKING_MODEL = '@cf/baai/bge-reranker-base';

/**
 * Tokens per chunk. Not a tuning guess: 512 is the input ceiling of
 * `@cf/baai/bge-m3` on Workers AI, so it is the largest chunk the embedding
 * model can read without truncating, and AI Search's own default of 256 splits
 * a document that would otherwise fit whole.
 *
 * Measured on real items from this library, `documentText` produces 316-426
 * tokens (1615-2164 characters): two chunks at the default, one at 512. That is
 * what makes `CHUNKS_PER_ITEM` viable at 1, and it puts the score bands in
 * `zotero_semantic_search` back on the one-vector-per-item footing they were
 * measured on.
 *
 * Changing this re-indexes the library, and `ensure()` deliberately will not
 * apply it to an instance that already exists — see `chunkSizeMismatch`.
 */
const CHUNK_SIZE = 512;

/**
 * Percent of tokens shared between adjacent chunks. Pinned to AI Search's own
 * default rather than left implicit, because this file is where the instance is
 * configured and an upstream change of default should not move it silently. It
 * only bites for the long tail that still exceeds `CHUNK_SIZE`; the typical item
 * is a single chunk with no neighbour to overlap.
 */
const CHUNK_OVERLAP = 10;

/**
 * `max_num_results` counts chunks, not items. At `CHUNK_SIZE` an item's document
 * is normally one chunk, so one chunk buys one item and no overshoot is needed.
 *
 * "Normally" is not "always": `documentText` caps at 6000 characters, roughly
 * 1200 tokens, so an item with a very long abstract still splits in two or
 * three. Those spend more than one result slot, and a page can come back a few
 * items short of what was asked for — which is why the fold in `query` stays,
 * and why this is the constant to raise if that tail ever matters more than the
 * item ceiling does.
 */
const CHUNKS_PER_ITEM = 1;

/** `max_num_results` is rejected above 50. */
const MAX_CHUNKS = 50;

/**
 * The largest number of items a query can honestly promise. Above this the chunk
 * overshoot no longer fits under `MAX_CHUNKS`, so asking for more would quietly
 * return fewer than requested instead of failing.
 */
export const MAX_SEMANTIC_ITEMS = Math.floor(MAX_CHUNKS / CHUNKS_PER_ITEM);

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
  async ensure(): Promise<{ created: boolean; mismatch?: string }> {
    try {
      const info = await this.instance.info();
      const mismatch = chunkSizeMismatch(this.settings.instance, info);
      return mismatch ? { created: false, mismatch } : { created: false };
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
      chunk: true,
      chunk_size: CHUNK_SIZE,
      chunk_overlap: CHUNK_OVERLAP,
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
    // Clamped against the item ceiling, not the chunk one: `topK` counts items,
    // and callers overshoot it deliberately to survive their own downstream
    // filters, so the number arriving here can exceed what a page can hold.
    const wanted = Math.min(options.topK ?? 10, MAX_SEMANTIC_ITEMS);
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
          // Hybrid, not vector-only. `zotero_semantic_search` is a tool the caller
          // may pick *instead of* `zotero_search`, never alongside it, so it has to
          // carry lexical precision of its own: an exact name like "Sparse
          // VideoGen2" is something BM25 nails and distance only approximates. The
          // cost is that a BM25-only chunk has no `vector_score`; the tool reports
          // those as unscored rather than inventing a number on the wrong scale.
          retrieval_type: 'hybrid',
          // 'or', not the 'and' default. `and` requires every query term to
          // appear in the same chunk, and this tool asks its callers for "a
          // question or description" against documents that are ~400-token
          // metadata cards — so the default empties the BM25 half on exactly the
          // phrasing the tool invites, leaving hybrid retrieval to behave like
          // the vector-only search it was chosen over. A Chinese query never
          // satisfies `and` at all, since the keyword index is Porter-stemmed.
          // RRF still ranks a chunk that matched several terms above one that
          // matched a single term, so recall is widened without flattening order.
          keyword_match_mode: 'or',
          max_num_results: Math.min(wanted * CHUNKS_PER_ITEM, MAX_CHUNKS),
          // 0, not the 0.4 default: this search reports how weak its matches are
          // rather than hiding them, so the floor lives in `zotero_semantic_search`
          // and nothing is discarded on the way here.
          match_threshold: 0,
          // The default, `true`, turns a failed retrieval into an empty result
          // set. `zotero_semantic_search` reads emptiness as a statement about
          // the library — it checks whether the index is populated and tells the
          // caller to run `zotero_reindex` — so a swallowed backend failure comes
          // back as confident, wrong advice. Fail loudly and let it surface.
          return_on_failure: false,
          ...(Object.keys(filters).length > 0
            ? { filters: filters as VectorizeVectorMetadataFilter }
            : {}),
        },
        reranking: { enabled: true, match_threshold: 0 },
      },
    });

    // Chunks arrive in fused, reranked order and several may belong to one item.
    // First appearance sets an item's rank; its best vector score is reported.
    const ranked: SemanticMatch[] = [];
    const seen: Record<string, SemanticMatch> = {};
    for (const chunk of response.chunks) {
      const itemKey = itemKeyOf(chunk.item.key);
      // Only the cosine half is reported. The fused score mixes in BM25 rank and
      // is not on the same scale as the bands `zotero_semantic_search` judges
      // against, so a chunk with no `vector_score` is passed through unscored
      // rather than given the fused number.
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

/**
 * `create` is the only place `chunk_size` is set — reconfiguring an instance
 * re-indexes the entire library, which `ensure()` will not do behind your back —
 * so an instance built before `CHUNK_SIZE` was pinned still chunks at AI Search's
 * 256-token default.
 *
 * That does not fail, which is the problem. Every document splits in two, each
 * item spends two of the result slots `CHUNKS_PER_ITEM` budgets one for, and a
 * search returns roughly half the items it was asked for while looking perfectly
 * healthy. A silent halving is worth a sentence in the sync report.
 *
 * An instance whose `chunk_size` is larger is left alone: it holds fewer chunks
 * per item, not more, so nothing is oversubscribed.
 */
function chunkSizeMismatch(
  instance: string,
  info: { chunk_size?: number } | undefined,
): string | undefined {
  const actual = info?.chunk_size;
  // Absent rather than small: an older API that does not report the field says
  // nothing about how the instance is configured, and guessing either way would
  // put an invented warning in the report.
  if (actual === undefined || actual >= CHUNK_SIZE) return undefined;
  return `AI Search instance "${instance}" chunks at ${actual} tokens, but this deployment is built for ${CHUNK_SIZE}. Items split across more chunks than a search budgets result slots for, so zotero_semantic_search returns fewer items than it was asked for. Delete the instance and let the next sync rebuild it, or set chunk_size to ${CHUNK_SIZE} and re-sync — both re-index the whole library.`;
}
