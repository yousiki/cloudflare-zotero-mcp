import { describe, expect, test } from 'bun:test';
import {
  embeddingMetadata,
  embeddingText,
  isIndexable,
  VectorizeSemanticIndex,
} from '../src/core/search/semantic.js';
import { ZoteroClient } from '../src/core/zotero/client.js';
import type { ZoteroItem } from '../src/core/zotero/types.js';
import { syncVectorIndex } from '../src/jobs/vectorize-sync.js';
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

class FakeVectorize {
  readonly vectors = new Map<string, { values: number[]; metadata?: Record<string, unknown> }>();
  readonly deleted: string[] = [];
  readonly deleteBatchSizes: number[] = [];

  async upsert(
    vectors: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>,
  ) {
    for (const vector of vectors) this.vectors.set(vector.id, vector);
    return { mutationId: 'm' };
  }
  async deleteByIds(ids: string[]) {
    // The real service rejects more than 100 ids with error 40007.
    if (ids.length > 100)
      throw new Error(`too many ids in payload; max id count is 100, got ${ids.length}`);
    this.deleteBatchSizes.push(ids.length);
    this.deleted.push(...ids);
    for (const id of ids) this.vectors.delete(id);
    return { mutationId: 'm' };
  }
  async describe() {
    return { vectorCount: this.vectors.size, dimensions: 1024 };
  }
  async query(_vector: number[], options?: { topK?: number }) {
    const matches = [...this.vectors.entries()]
      .slice(0, options?.topK ?? 10)
      .map(([id, vector], index) => ({ id, score: 1 - index * 0.1, metadata: vector.metadata }));
    return { matches, count: matches.length };
  }
}

/** Deterministic pseudo-embeddings: enough to exercise batching and shapes. */
const fakeEmbedder = {
  dimensions: 3,
  embed: async (texts: string[]) => texts.map((text) => [text.length, 1, 0]),
};

function fakeDeps(routes: Parameters<typeof stubFetch>[0]) {
  const store = new FakeKv();
  const vectorize = new FakeVectorize();
  const stub = stubFetch(routes);
  return {
    store,
    vectorize,
    stub,
    deps: {
      zotero: new ZoteroClient({ apiKey: 'k', libraryId: 1, fetch: stub.fetch }),
      index: new VectorizeSemanticIndex(vectorize as unknown as Vectorize, fakeEmbedder),
      store,
    },
  };
}

/* -------------------------------------------------------------------------- */

describe('embedding payloads', () => {
  test('packs the fields that matter into one passage', () => {
    const text = embeddingText(item('AAAA1111').data);
    expect(text).toContain('Title AAAA1111');
    expect(text).toContain('Lovelace');
    expect(text).toContain('2020');
    expect(text).toContain('ml');
    expect(text).toContain('An abstract.');
  });

  test('caps the abstract so metadata stays well under the 10 KiB limit', () => {
    const long = item('BBBB2222', { abstractNote: 'x'.repeat(20_000) });
    expect(embeddingText(long.data).length).toBeLessThanOrEqual(6000);
    expect(JSON.stringify(embeddingMetadata(long)).length).toBeLessThan(10 * 1024);
  });

  test('keeps child objects and trashed items out of the index', () => {
    expect(isIndexable(item('A'))).toBe(true);
    expect(isIndexable(item('B', { itemType: 'attachment' }))).toBe(false);
    expect(isIndexable(item('C', { itemType: 'note' }))).toBe(false);
    expect(isIndexable(item('D', { deleted: 1 }))).toBe(false);
  });
});

describe('VectorizeSemanticIndex', () => {
  test('round-trips items through upsert and query', async () => {
    const index = new FakeVectorize();
    const semantic = new VectorizeSemanticIndex(index as unknown as Vectorize, {
      dimensions: 3,
      embed: async (texts) => texts.map((text) => [text.length, 1, 0]),
    });

    const written = await semantic.upsertItems([item('AAAA1111'), item('BBBB2222')]);
    expect(written).toBe(2);
    expect(await semantic.size()).toBe(2);

    const matches = await semantic.query('anything', { topK: 1 });
    expect(matches[0]?.itemKey).toBe('AAAA1111');
    expect(matches[0]?.title).toBe('Title AAAA1111');
  });

  test('splits deletes into chunks Vectorize will accept', async () => {
    const index = new FakeVectorize();
    const semantic = new VectorizeSemanticIndex(index as unknown as Vectorize, fakeEmbedder);

    const keys = Array.from({ length: 128 }, (_, i) => `KEY${String(i).padStart(5, '0')}`);
    await semantic.removeItems(keys);

    expect(index.deleteBatchSizes).toEqual([100, 28]);
    expect(index.deleted).toHaveLength(128);
  });
});

describe('syncVectorIndex', () => {
  test('does nothing when Vectorize is unbound', async () => {
    const { deps } = fakeDeps([]);
    const report = await syncVectorIndex({ ...deps, index: null });
    expect(report.complete).toBe(true);
    expect(report.message).toContain('not bound');
  });

  test('indexes changed items and advances the cursor', async () => {
    const { deps, store, vectorize } = fakeDeps([
      route('GET', '/users/1/items', (request) => {
        const url = new URL(request.url);
        if (url.searchParams.get('format') === 'versions') {
          return jsonResponse({ AAAA1111: 5, BBBB2222: 6 }, { version: 6 });
        }
        return jsonResponse([item('AAAA1111'), item('BBBB2222')], { version: 6 });
      }),
    ]);

    const report = await syncVectorIndex(deps);

    expect(report.indexed).toBe(2);
    expect(report.complete).toBe(true);
    expect(report.toVersion).toBe(6);
    expect(vectorize.vectors.size).toBe(2);
    expect(JSON.parse(store.store.get('vectorize:sync-state') as string).since).toBe(6);
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

    const first = await syncVectorIndex({ ...deps, limit: 2 });
    expect(first.indexed).toBe(2);
    expect(first.complete).toBe(false);
    expect(first.remaining).toBe(1);
    // Cursor must not move while work is outstanding.
    expect(JSON.parse(store.store.get('vectorize:sync-state') as string).since).toBe(0);

    const second = await syncVectorIndex({ ...deps, limit: 2 });
    expect(second.indexed).toBe(1);
    expect(second.complete).toBe(true);
    expect(JSON.parse(store.store.get('vectorize:sync-state') as string).since).toBe(6);
  });

  test('drops vectors for items deleted since the last run', async () => {
    const { deps, store, vectorize } = fakeDeps([
      route('GET', '/users/1/deleted', () =>
        jsonResponse({ items: ['OLDD0001'], collections: [] }),
      ),
      route('GET', '/users/1/items', () => jsonResponse({}, { version: 9 })),
    ]);
    store.store.set('vectorize:sync-state', JSON.stringify({ since: 4, target: 4, pending: [] }));

    const report = await syncVectorIndex(deps);

    expect(report.removed).toBe(1);
    expect(vectorize.deleted).toEqual(['OLDD0001']);
    expect(report.complete).toBe(true);
  });
});
