import { describe, expect, test } from 'bun:test';
import { AiSearchSemanticIndex } from '../src/core/search/aisearch.js';
import {
  documentMetadata,
  documentName,
  documentText,
  isIndexable,
} from '../src/core/search/document.js';
import { ZoteroClient } from '../src/core/zotero/client.js';
import type { ZoteroItem } from '../src/core/zotero/types.js';
import { syncSemanticIndex } from '../src/jobs/index-sync.js';
import { jsonResponse, route, stubFetch } from './helpers.js';

function item(key: string, overrides: Record<string, unknown> = {}): ZoteroItem {
  return {
    key,
    version: 3,
    library: { type: 'user', id: 1, name: 'me' },
    data: {
      key,
      version: 3,
      itemType: 'journalArticle',
      title: `Title ${key}`,
      date: '2020-05-01',
      abstractNote: 'An abstract.',
      creators: [{ creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' }],
      tags: [{ tag: 'ml' }],
      ...overrides,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Fakes                                                                       */
/* -------------------------------------------------------------------------- */

class FakeKv {
  readonly store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

interface FakeChunk {
  key: string;
  score: number;
  vectorScore?: number;
}

/**
 * Stands in for one AI Search instance. Uploads are an upsert on the document
 * name, deletes take the opaque item id, and `info` throws until the instance
 * has been created — the three behaviours the index code is built around.
 */
class FakeAiSearchInstance {
  exists = false;
  config: Record<string, unknown> | null = null;
  readonly documents = new Map<string, { id: string; text: string; metadata: unknown }>();
  readonly searchRequests: unknown[] = [];
  readonly deletedIds: string[] = [];
  /** What the next `search` call answers with. */
  chunks: FakeChunk[] = [];
  /** Pages of unrelated documents `list` will keep serving, to fake a runaway listing. */
  endlessList = false;
  /** Makes `stats` throw, as it does when the service is unreachable. */
  statsFails = false;
  private counter = 0;

  async info() {
    if (!this.exists) {
      const error = new Error('instance not found');
      error.name = 'AiSearchNotFoundError';
      throw error;
    }
    return { id: 'zotero-items' };
  }

  async search(params: { ai_search_options?: unknown }) {
    this.searchRequests.push(params);
    return {
      search_query: 'q',
      chunks: this.chunks.map((chunk, position) => ({
        id: `c${position}`,
        type: 'text',
        score: chunk.score,
        text: 'chunk text',
        item: { key: documentName(chunk.key) },
        scoring_details: chunk.vectorScore === undefined ? {} : { vector_score: chunk.vectorScore },
      })),
    };
  }

  async stats() {
    if (this.statsFails) throw new Error('stats unavailable');
    return {
      queued: 2,
      running: 1,
      error: 0,
      engine: { vectorize: { vectorsCount: this.documents.size, dimensions: 1024 } },
    };
  }

  get items() {
    return {
      upload: async (name: string, content: string, options?: { metadata?: unknown }) => {
        const existing = this.documents.get(name);
        this.counter += 1;
        const id = existing?.id ?? `id-${this.counter}`;
        this.documents.set(name, { id, text: content, metadata: options?.metadata });
        return { id, key: name, status: 'queued' };
      },
      list: async (params?: { page?: number; per_page?: number }) => {
        const page = params?.page ?? 1;
        const perPage = params?.per_page ?? 20;
        if (this.endlessList) {
          return {
            result: Array.from({ length: perPage }, (_, offset) => ({
              id: `filler-${page}-${offset}`,
              key: `FILLER${page}${offset}.md`,
              status: 'completed',
            })),
          };
        }
        const all = [...this.documents.entries()].map(([key, value]) => ({
          id: value.id,
          key,
          status: 'completed',
        }));
        return { result: all.slice((page - 1) * perPage, page * perPage) };
      },
      delete: async (id: string) => {
        this.deletedIds.push(id);
        for (const [key, value] of this.documents) {
          if (value.id === id) this.documents.delete(key);
        }
      },
    };
  }
}

class FakeAiSearchNamespace {
  readonly instance = new FakeAiSearchInstance();
  get(_name: string) {
    return this.instance;
  }
  async create(config: Record<string, unknown>) {
    this.instance.exists = true;
    this.instance.config = config;
    return this.instance;
  }
}

function fakeIndex() {
  const namespace = new FakeAiSearchNamespace();
  const index = new AiSearchSemanticIndex(namespace as unknown as AiSearchNamespace, {
    instance: 'zotero-items',
    embeddingModel: '@cf/baai/bge-m3',
    rerankingModel: '@cf/baai/bge-reranker-base',
  });
  return { namespace, backend: namespace.instance, index };
}

/** The cursor is namespaced by index id, so a different index starts fresh. */
const CURSOR_KEY = 'aisearch:sync-state:zotero-items';

function fakeDeps(routes: Parameters<typeof stubFetch>[0], instanceExists = true) {
  const store = new FakeKv();
  const { backend, index } = fakeIndex();
  // Most cases exercise a library that is already indexed; `ensure` creating the
  // instance is itself a full-resync trigger and is tested on its own.
  backend.exists = instanceExists;
  const stub = stubFetch(routes);
  return {
    store,
    backend,
    stub,
    deps: {
      zotero: new ZoteroClient({ apiKey: 'k', libraryId: 1, fetch: stub.fetch }),
      index,
      store,
    },
  };
}

/* -------------------------------------------------------------------------- */

describe('document payloads', () => {
  test('packs the fields that matter into one passage', () => {
    const text = documentText(item('AAAA1111').data);
    expect(text).toContain('Title AAAA1111');
    expect(text).toContain('Lovelace');
    expect(text).toContain('2020');
    expect(text).toContain('ml');
    expect(text).toContain('An abstract.');
  });

  test('caps the abstract', () => {
    const long = item('BBBB2222', { abstractNote: 'x'.repeat(20_000) });
    expect(documentText(long.data).length).toBeLessThanOrEqual(6000);
  });

  test('carries only the two fields the backend can push down', () => {
    // Five custom fields is the cap and a schema change re-indexes the library,
    // so anything that is not a filter has no business being here.
    expect(documentMetadata(item('AAAA1111'))).toEqual({ itemtype: 'journalArticle', year: 2020 });
  });

  test('keeps child objects and trashed items out of the index', () => {
    expect(isIndexable(item('A'))).toBe(true);
    expect(isIndexable(item('B', { itemType: 'attachment' }))).toBe(false);
    expect(isIndexable(item('C', { itemType: 'note' }))).toBe(false);
    expect(isIndexable(item('D', { deleted: 1 }))).toBe(false);
  });
});

describe('AiSearchSemanticIndex', () => {
  test('creates the instance with hybrid retrieval and reranking on first use', async () => {
    const { namespace, index } = fakeIndex();
    await index.ensure();

    expect(namespace.instance.config).toMatchObject({
      id: 'zotero-items',
      index_method: { vector: true, keyword: true },
      fusion_method: 'rrf',
      embedding_model: '@cf/baai/bge-m3',
      reranking: true,
      reranking_model: '@cf/baai/bge-reranker-base',
      // Nothing may be dropped for scoring low; the floor is advisory and lives
      // in zotero_search.
      score_threshold: 0,
    });
    expect(namespace.instance.config?.custom_metadata).toEqual([
      { field_name: 'itemtype', data_type: 'text' },
      { field_name: 'year', data_type: 'number' },
    ]);
  });

  test('leaves an existing instance alone, because reconfiguring re-indexes it', async () => {
    const { namespace, index } = fakeIndex();
    namespace.instance.exists = true;
    await index.ensure();
    expect(namespace.instance.config).toBeNull();
  });

  test('uploads one document per item, keyed so a change replaces it', async () => {
    const { backend, index } = fakeIndex();

    expect(await index.upsertItems([item('AAAA1111'), item('BBBB2222')])).toBe(2);
    expect([...backend.documents.keys()]).toEqual(['AAAA1111.md', 'BBBB2222.md']);
    const firstId = backend.documents.get('AAAA1111.md')?.id;

    await index.upsertItems([item('AAAA1111', { title: 'Renamed' })]);
    expect(backend.documents.size).toBe(2);
    expect(backend.documents.get('AAAA1111.md')?.id).toBe(firstId);
    expect(backend.documents.get('AAAA1111.md')?.text).toContain('Renamed');
  });

  test('skips items that are not indexable', async () => {
    const { backend, index } = fakeIndex();
    expect(await index.upsertItems([item('A', { itemType: 'attachment' }), item('BBBB2222')])).toBe(
      1,
    );
    expect([...backend.documents.keys()]).toEqual(['BBBB2222.md']);
  });

  test('never lets the backend drop a distant match', async () => {
    const { backend, index } = fakeIndex();
    backend.chunks = [{ key: 'AAAA1111', score: 0.2, vectorScore: 0.2 }];
    await index.query('anything');

    const [request] = backend.searchRequests as Array<{
      ai_search_options: { retrieval: { match_threshold: number; retrieval_type: string } };
    }>;
    // The service default is 0.4, which would hide weak hits instead of
    // reporting them in belowThreshold.
    expect(request?.ai_search_options.retrieval.match_threshold).toBe(0);
    expect(request?.ai_search_options.retrieval.retrieval_type).toBe('hybrid');
  });

  test('pushes down the filters the backend can enforce, and no others', async () => {
    const { backend, index } = fakeIndex();
    await index.query('anything', {
      itemType: 'preprint',
      fromYear: 2015,
      toYear: 2020,
    });
    await index.query('anything', { itemType: '-attachment' });

    const requests = backend.searchRequests as Array<{
      ai_search_options: { retrieval: { filters?: Record<string, unknown> } };
    }>;
    expect(requests[0]?.ai_search_options.retrieval.filters).toEqual({
      itemtype: { $eq: 'preprint' },
      year: { $gte: 2015, $lte: 2020 },
    });
    // A negated type has no equivalent here and is enforced by the item lookup.
    expect(requests[1]?.ai_search_options.retrieval.filters).toBeUndefined();
  });

  test('folds an item\u2019s chunks into one match, keeping fused order and the best distance', async () => {
    const { backend, index } = fakeIndex();
    backend.chunks = [
      { key: 'BBBB2222', score: 0.9, vectorScore: 0.51 },
      { key: 'AAAA1111', score: 0.8, vectorScore: 0.42 },
      { key: 'BBBB2222', score: 0.7, vectorScore: 0.66 },
    ];

    const matches = await index.query('anything');

    expect(matches.map((match) => match.itemKey)).toEqual(['BBBB2222', 'AAAA1111']);
    expect(matches[0]?.score).toBe(0.66);
    expect(matches[1]?.score).toBe(0.42);
  });

  test('returns no more items than topK asked for', async () => {
    const { backend, index } = fakeIndex();
    // The chunk overshoot asks the backend for twice the wanted item count, so
    // when every chunk belongs to a different item the fold yields twice as many
    // matches as the caller wanted — and the caller turns each one into a key in
    // a Zotero lookup.
    backend.chunks = Array.from({ length: 8 }, (_, offset) => ({
      key: `KEY0000${offset}`,
      score: 0.9 - offset * 0.01,
      vectorScore: 0.6,
    }));

    const matches = await index.query('anything', { topK: 3 });

    expect(matches.map((match) => match.itemKey)).toEqual(['KEY00000', 'KEY00001', 'KEY00002']);
  });

  test('omits score when the chunk carries no vector_score', async () => {
    const { backend, index } = fakeIndex();
    backend.chunks = [{ key: 'AAAA1111', score: 0.88 }];

    const matches = await index.query('anything');

    // 0.88 is a fused BM25/vector score, not a cosine distance, and the caller
    // judges scores against cosine bands. Absent beats wrong.
    expect(matches[0]?.score).toBeUndefined();
  });

  test('resolves document ids by listing before deleting', async () => {
    const { backend, index } = fakeIndex();
    await index.upsertItems([item('AAAA1111'), item('BBBB2222')]);
    const doomed = backend.documents.get('AAAA1111.md')?.id;

    await index.removeItems(['AAAA1111']);

    expect(backend.deletedIds).toEqual([doomed as string]);
    expect([...backend.documents.keys()]).toEqual(['BBBB2222.md']);
  });

  test('treats a key with no document as normal, not an error', async () => {
    const { backend, index } = fakeIndex();
    await index.upsertItems([item('AAAA1111')]);

    // Zotero's /deleted feed reports attachments and notes, which were never
    // uploaded. Failing here would break every sync that deletes an attachment.
    await index.removeItems(['ATTACH01', 'NOTE0001']);

    expect(backend.deletedIds).toEqual([]);
    expect(backend.documents.size).toBe(1);
  });

  test('throws rather than leaving documents behind when the listing will not end', async () => {
    const { backend, index } = fakeIndex();
    backend.endlessList = true;

    // The caller advances the library cursor once this returns, so giving up
    // quietly would strand the document forever.
    await expect(index.removeItems(['AAAA1111'])).rejects.toThrow('did not terminate');
  });
});

describe('syncSemanticIndex', () => {
  test('does nothing when AI Search is unbound', async () => {
    const { deps } = fakeDeps([]);
    const report = await syncSemanticIndex({ ...deps, index: null });
    expect(report.complete).toBe(true);
    expect(report.message).toContain('not bound');
  });

  test('submits changed items and advances the cursor', async () => {
    const { deps, store, backend } = fakeDeps([
      route('GET', '/users/1/items', (request) => {
        const url = new URL(request.url);
        if (url.searchParams.get('format') === 'versions') {
          return jsonResponse({ AAAA1111: 5, BBBB2222: 6 }, { version: 6 });
        }
        return jsonResponse([item('AAAA1111'), item('BBBB2222')], { version: 6 });
      }),
    ]);

    const report = await syncSemanticIndex(deps);

    expect(report.submitted).toBe(2);
    expect(report.complete).toBe(true);
    expect(report.toVersion).toBe(6);
    expect(backend.documents.size).toBe(2);
    expect(JSON.parse(store.store.get(CURSOR_KEY) as string).since).toBe(6);
  });

  test('reports the indexing backlog, because submitted is not searchable', async () => {
    const { deps } = fakeDeps([
      route('GET', '/users/1/items', (request) => {
        const url = new URL(request.url);
        if (url.searchParams.get('format') === 'versions') {
          return jsonResponse({ AAAA1111: 5 }, { version: 6 });
        }
        return jsonResponse([item('AAAA1111')], { version: 6 });
      }),
    ]);

    const report = await syncSemanticIndex(deps);

    // The fake reports 2 queued + 1 running. `complete` only means every change
    // was sent, so the message must not claim the index is current.
    expect(report.complete).toBe(true);
    expect(report.backlog).toBe(3);
    expect(report.message).toContain('still being indexed');
  });

  test('keeps the cursor put and queues the rest when a run is capped', async () => {
    const { deps, store } = fakeDeps([
      route('GET', '/users/1/items', (request) => {
        const url = new URL(request.url);
        if (url.searchParams.get('format') === 'versions') {
          return jsonResponse({ AAAA1111: 5, BBBB2222: 6, CCCC3333: 6 }, { version: 6 });
        }
        const keys = (url.searchParams.get('itemKey') ?? '').split(',').filter(Boolean);
        return jsonResponse(
          keys.map((key) => item(key)),
          { version: 6 },
        );
      }),
    ]);

    const first = await syncSemanticIndex({ ...deps, limit: 2 });
    expect(first.submitted).toBe(2);
    expect(first.complete).toBe(false);
    expect(first.remaining).toBe(1);
    // Cursor must not move while work is outstanding.
    expect(JSON.parse(store.store.get(CURSOR_KEY) as string).since).toBe(0);

    const second = await syncSemanticIndex({ ...deps, limit: 2 });
    expect(second.submitted).toBe(1);
    expect(second.complete).toBe(true);
    expect(JSON.parse(store.store.get(CURSOR_KEY) as string).since).toBe(6);
  });

  test('drops documents for items deleted since the last run', async () => {
    const { deps, store, backend } = fakeDeps([
      route('GET', '/users/1/deleted', () =>
        jsonResponse({ items: ['OLDD0001'], collections: [] }),
      ),
      route('GET', '/users/1/items', () => jsonResponse({}, { version: 9 })),
    ]);
    await backend.items.upload('OLDD0001.md', 'stale');
    const doomed = backend.documents.get('OLDD0001.md')?.id;
    store.store.set(CURSOR_KEY, JSON.stringify({ since: 4, target: 4, pending: [] }));

    const report = await syncSemanticIndex(deps);

    expect(report.removed).toBe(1);
    expect(backend.deletedIds).toEqual([doomed as string]);
    expect(report.complete).toBe(true);
  });

  test('resubmits everything when it had to create the index, cursor or no cursor', async () => {
    const { deps, store, backend } = fakeDeps(
      [
        route('GET', '/users/1/items', (request) => {
          const url = new URL(request.url);
          if (url.searchParams.get('format') === 'versions') {
            const since = url.searchParams.get('since');
            // An incremental run would ask from version 6 and be told nothing
            // changed; only a full run (since=0 or absent) sees the library.
            if (since && since !== '0') return jsonResponse({}, { version: 6 });
            return jsonResponse({ AAAA1111: 5, BBBB2222: 6 }, { version: 6 });
          }
          const keys = (url.searchParams.get('itemKey') ?? '').split(',').filter(Boolean);
          return jsonResponse(
            keys.map((key) => item(key)),
            { version: 6 },
          );
        }),
      ],
      false,
    );
    // The cursor says the library is fully covered, but the index it described
    // is gone. Trusting it would leave an empty index that no later incremental
    // run ever refills.
    store.store.set(CURSOR_KEY, JSON.stringify({ since: 6, target: 6, pending: [] }));

    const report = await syncSemanticIndex(deps);

    expect(backend.config).not.toBeNull();
    expect(report.submitted).toBe(2);
    expect(backend.documents.size).toBe(2);
  });

  test('gives each index its own cursor', async () => {
    const { deps, store } = fakeDeps([
      route('GET', '/users/1/items', (request) => {
        const url = new URL(request.url);
        if (url.searchParams.get('format') === 'versions') {
          return jsonResponse({ AAAA1111: 5 }, { version: 6 });
        }
        return jsonResponse([item('AAAA1111')], { version: 6 });
      }),
    ]);

    await syncSemanticIndex(deps);

    // Keyed by index id: repointing the worker at another instance must not
    // inherit a cursor describing documents that instance does not have.
    expect([...store.store.keys()]).toEqual([`aisearch:sync-state:${deps.index.id}`]);
  });

  test('reports an unreadable backlog as unknown, never as zero', async () => {
    const { deps, backend } = fakeDeps([
      route('GET', '/users/1/items', (request) => {
        const url = new URL(request.url);
        if (url.searchParams.get('format') === 'versions') {
          return jsonResponse({ AAAA1111: 5 }, { version: 6 });
        }
        return jsonResponse([item('AAAA1111')], { version: 6 });
      }),
    ]);
    backend.statsFails = true;

    const report = await syncSemanticIndex(deps);

    // Zero would tell the caller everything is searchable. It is not known to be.
    expect(report.backlog).toBeNull();
    expect(report.failed).toBeNull();
    expect(report.message).toContain('could not be read');
    // The run itself still succeeded: statistics are a progress report, not the job.
    expect(report.submitted).toBe(1);
    expect(report.complete).toBe(true);
  });
});
