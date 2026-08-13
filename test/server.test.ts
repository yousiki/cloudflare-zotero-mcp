import { beforeAll, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { SCOPE_READ, SCOPE_WRITE, type ZoteroMcpContext } from '../src/context.js';
import { AttachmentReader } from '../src/core/attachment/read.js';
import { AttachmentWriter } from '../src/core/attachment/write.js';
import { MAX_SEMANTIC_ITEMS } from '../src/core/search/aisearch.js';
import type { SemanticIndex, SemanticQueryOptions } from '../src/core/search/types.js';
import { ZoteroClient } from '../src/core/zotero/client.js';
import { createServer } from '../src/server.js';
import { jsonResponse, route, stubFetch } from './helpers.js';

const ITEM = {
  key: 'AAAA1111',
  version: 12,
  library: { type: 'user' as const, id: 1, name: 'me' },
  meta: { numChildren: 1 },
  data: {
    key: 'AAAA1111',
    version: 12,
    itemType: 'journalArticle',
    title: 'Attention Is All You Need',
    date: '2017',
    publicationTitle: 'NeurIPS',
    DOI: '10.1000/xyz',
    abstractNote: 'We propose a new simple network architecture, the Transformer.',
    creators: [{ creatorType: 'author', firstName: 'Ashish', lastName: 'Vaswani' }],
    tags: [{ tag: 'transformers' }],
    collections: [],
  },
};

const ATTACHMENT = {
  key: 'BBBB2222',
  version: 12,
  library: { type: 'user' as const, id: 1, name: 'me' },
  meta: {},
  data: {
    key: 'BBBB2222',
    version: 12,
    itemType: 'attachment',
    parentItem: 'AAAA1111',
    title: 'Full Text PDF',
    linkMode: 'imported_file',
    filename: 'Vaswani - 2017 - Attention Is All You Need.pdf',
    contentType: 'application/pdf',
    md5: '0123456789abcdef0123456789abcdef',
    mtime: 1_700_000_000_000,
    tags: [],
    collections: [],
  },
};

/** An item with no attachment at all, for the other read-failure branch. */
const ITEM_WITHOUT_FILE = {
  ...ITEM,
  key: 'CCCC3333',
  meta: {},
  data: { ...ITEM.data, key: 'CCCC3333' },
};

/** In a collection and older, so collection and year filters have something to keep. */
const ITEM_IN_COLLECTION = {
  ...ITEM,
  key: 'DDDD4444',
  meta: {},
  data: { ...ITEM.data, key: 'DDDD4444', date: '1998', collections: ['COLL0001'] },
};

/**
 * Carries a Better BibTeX key in Extra — the only field Zotero keeps one in, and
 * one no `q` can reach.
 */
const ITEM_WITH_CITATION_KEY = {
  ...ITEM,
  key: 'EEEE5555',
  meta: {},
  data: {
    ...ITEM.data,
    key: 'EEEE5555',
    title: 'Mamba: Linear-Time Sequence Modeling with Selective State Spaces',
    date: '2023',
    extra: 'Citation Key: gu2023mamba\narXiv:2312.00752',
  },
};

interface StubSemanticIndex extends SemanticIndex {
  /** Options every `query` call received, for asserting what was pushed down. */
  calls: SemanticQueryOptions[];
}

/** A semantic index that answers with fixed matches, scores included. */
function stubSemantic(matches: Array<{ itemKey: string; score?: number }>): StubSemanticIndex {
  const calls: SemanticQueryOptions[] = [];
  return {
    id: 'test-index',
    calls,
    query: async (_text, options = {}) => {
      calls.push(options);
      return matches;
    },
    stats: async () => ({ vectors: matches.length, queued: 0, running: 0, failed: 0 }),
    ensure: async () => ({ created: false }),
    upsertItems: async () => 0,
    removeItems: async () => undefined,
  };
}

function testContext(
  scopes: string[] = [SCOPE_READ, SCOPE_WRITE],
  semantic: SemanticIndex | null = null,
): ZoteroMcpContext {
  const stub = stubFetch([
    route('GET', '/users/1/items/AAAA1111/children', () => jsonResponse([ATTACHMENT])),
    route('GET', '/users/1/items/AAAA1111', () => jsonResponse(ITEM)),
    route('GET', '/users/1/items/CCCC3333/children', () => jsonResponse([])),
    route('GET', '/users/1/items/CCCC3333', () => jsonResponse(ITEM_WITHOUT_FILE)),
    // Must precede the bare `/items` route: `route` matches by prefix.
    route('GET', '/users/1/items/top', () =>
      jsonResponse([ITEM, ITEM_WITH_CITATION_KEY], { version: 12 }),
    ),
    route('GET', '/users/1/items', (request) => {
      // Semantic search resolves its matches by key; keyword search does not.
      const wanted = new URL(request.url).searchParams.get('itemKey');
      if (!wanted) return jsonResponse([ITEM], { version: 12 });
      const keys = wanted.split(',');
      return jsonResponse(
        [ITEM, ITEM_WITHOUT_FILE, ITEM_IN_COLLECTION].filter((item) => keys.includes(item.key)),
        { version: 12 },
      );
    }),
    // Must precede the bare `/collections` route: `route` matches by prefix.
    route('GET', '/users/1/collections/COLL0001/items', () =>
      jsonResponse([ITEM_IN_COLLECTION], { version: 12 }),
    ),
    route('GET', '/users/1/collections', () =>
      jsonResponse(
        [
          {
            key: 'COLL0001',
            version: 3,
            library: { type: 'user', id: 1, name: 'me' },
            meta: { numItems: 1 },
            data: { key: 'COLL0001', version: 3, name: 'Transformers', parentCollection: false },
          },
        ],
        { version: 12 },
      ),
    ),
    route('GET', '/users/1/tags', () =>
      jsonResponse([{ tag: 'transformers', meta: { numItems: 1 } }]),
    ),
    route('PATCH', '/users/1/items/AAAA1111', () => new Response(null, { status: 204 })),
  ]);

  const zotero = new ZoteroClient({ apiKey: 'k', libraryId: 1, fetch: stub.fetch });
  const context: ZoteroMcpContext = {
    zotero,
    webdav: null,
    reader: new AttachmentReader(zotero, null),
    writer: new AttachmentWriter(zotero, null),
    semantic,
    store: { get: async () => null, put: async () => undefined },
    scopes,
  };
  requestLog.set(context, stub);
  return context;
}

/** Lets a test inspect the requests its own context produced. */
const requestLog = new WeakMap<ZoteroMcpContext, ReturnType<typeof stubFetch>>();

function lastItemsQuery(context: ZoteroMcpContext): URLSearchParams {
  const requests = requestLog.get(context)?.requests ?? [];
  const last = [...requests].reverse().find((request) => request.url.includes('/items?'));
  if (!last) throw new Error('no /items request was made');
  return new URL(last.url).searchParams;
}

/** The `/items/top` request a citation-key scan makes, which `lastItemsQuery` skips. */
function lastTopItemsQuery(context: ZoteroMcpContext): URLSearchParams {
  const requests = requestLog.get(context)?.requests ?? [];
  const last = [...requests].reverse().find((request) => request.url.includes('/items/top?'));
  if (!last) throw new Error('no /items/top request was made');
  return new URL(last.url).searchParams;
}

async function connect(context: ZoteroMcpContext): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(context);
  await server.connect(serverTransport);

  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('MCP surface', () => {
  let client: Client;

  beforeAll(async () => {
    client = await connect(testContext());
  });

  test('exposes every tool with a description and schema', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();

    expect(names).toEqual([
      'zotero_annotations',
      'zotero_create_items',
      'zotero_delete_attachment',
      'zotero_delete_items',
      'zotero_find_duplicates',
      'zotero_get_item',
      'zotero_import_reference',
      'zotero_list_collections',
      'zotero_list_tags',
      'zotero_manage_collections',
      'zotero_notes',
      'zotero_put_attachment',
      'zotero_read_attachment',
      'zotero_reindex',
      'zotero_rename_attachments',
      'zotero_search',
      'zotero_semantic_search',
      'zotero_update_item',
    ]);

    for (const tool of tools) {
      expect(tool.description, `${tool.name} needs a description`).toBeTruthy();
      expect(tool.inputSchema, `${tool.name} needs an input schema`).toBeTruthy();
    }
  });

  test('marks read-only tools as such', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get('zotero_search')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('zotero_semantic_search')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('zotero_delete_items')?.annotations?.destructiveHint).toBe(true);
  });

  test('advertises no semantic parameter the index cannot honour', async () => {
    const { tools } = await client.listTools();
    const schema = tools.find((tool) => tool.name === 'zotero_semantic_search')?.inputSchema;
    const properties = (schema?.properties ?? {}) as Record<string, { maximum?: number }>;

    // The index holds no trashed items and no attachments, notes or annotations,
    // so offering these would let a caller set something that cannot ever change
    // the result.
    expect(properties.includeTrashed).toBeUndefined();
    // Ordering and text-scope belong to zotero_search; semantic order is fixed.
    expect(properties.sort).toBeUndefined();
    expect(properties.direction).toBeUndefined();
    expect(properties.qmode).toBeUndefined();
    expect(properties.citationKey).toBeUndefined();
    // Above MAX_SEMANTIC_ITEMS the chunk overshoot no longer fits under the
    // backend's cap, so a larger limit would quietly return fewer than asked.
    expect(properties.limit?.maximum).toBe(MAX_SEMANTIC_ITEMS);

    const keyword = tools.find((tool) => tool.name === 'zotero_search')?.inputSchema;
    const keywordProperties = (keyword?.properties ?? {}) as Record<string, { maximum?: number }>;
    expect(keywordProperties.includeTrashed).toBeDefined();
    expect(keywordProperties.sort).toBeDefined();
    expect(keywordProperties.limit?.maximum).toBe(100);
  });

  test('lists resources and prompts', async () => {
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri)).toContain('zotero://collections');

    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name)).toContain('literature-review');
  });

  test('search returns formatted text and structured content', async () => {
    const result = await client.callTool({
      name: 'zotero_search',
      arguments: { query: 'attention', limit: 5 },
    });

    expect(result.isError).toBeFalsy();
    const [block] = result.content as Array<{ type: string; text: string }>;
    expect(block?.text).toContain('Attention Is All You Need');
    expect(block?.text).toContain('AAAA1111');
    const structured = result.structuredContent as { items: Array<{ key: string }> };
    expect(structured.items[0]?.key).toBe('AAAA1111');
  });

  test('keyword search excludes attachments unless asked for', async () => {
    const context = testContext();
    const scoped = await connect(context);

    await scoped.callTool({ name: 'zotero_search', arguments: { query: 'rlhf' } });
    // Zotero rejects multiple negations, so exactly one value must be sent.
    expect(lastItemsQuery(context).getAll('itemType')).toEqual(['-attachment']);

    await scoped.callTool({
      name: 'zotero_search',
      arguments: { query: 'rlhf', itemType: 'note' },
    });
    expect(lastItemsQuery(context).getAll('itemType')).toEqual(['note']);
  });

  test('citationKey finds the item whose Extra carries the key', async () => {
    const context = testContext();
    const scoped = await connect(context);

    const result = await scoped.callTool({
      name: 'zotero_search',
      arguments: { citationKey: 'gu2023mamba' },
    });

    const structured = result.structuredContent as { items: Array<{ key: string }> };
    expect(structured.items.map((item) => item.key)).toEqual(['EEEE5555']);

    // Zotero cannot search Extra, so a `q` would narrow away the very match this
    // is looking for. The other filters still have to push down.
    const query = lastTopItemsQuery(context);
    expect(query.get('q')).toBeNull();
    expect(query.get('qmode')).toBeNull();
    expect(query.getAll('itemType')).toEqual(['-attachment']);
  });

  test('citationKey returns nothing rather than unrelated items when the key is absent', async () => {
    const result = await client.callTool({
      name: 'zotero_search',
      arguments: { citationKey: 'nobody1999nothing' },
    });

    const structured = result.structuredContent as { items: unknown[]; total: number };
    expect(structured.total).toBe(0);
    expect(structured.items).toEqual([]);
  });

  test('citationKey matches a whole key, not a prefix of one', async () => {
    // `gu2023` is a different paper from `gu2023mamba`, so a substring hit is wrong.
    const result = await client.callTool({
      name: 'zotero_search',
      arguments: { citationKey: 'gu2023' },
    });

    expect((result.structuredContent as { total: number }).total).toBe(0);
  });

  test('get_item renders detail with children', async () => {
    const result = await client.callTool({
      name: 'zotero_get_item',
      arguments: { key: 'AAAA1111', includeChildren: true },
    });
    const [block] = result.content as Array<{ text: string }>;
    expect(block?.text).toContain('# Attention Is All You Need');
    expect(block?.text).toContain('- DOI: 10.1000/xyz');
  });

  test('get_item puts the full record in structuredContent, not only the text', async () => {
    // Hosts that understand structuredContent render it and drop the text block,
    // so anything only in the Markdown never reaches the model.
    const result = await client.callTool({
      name: 'zotero_get_item',
      arguments: { key: 'AAAA1111', includeChildren: true },
    });
    const structured = result.structuredContent as {
      item: {
        abstract: string | null;
        fields: Record<string, string>;
        creators: Array<{ creatorType: string; name: string }>;
      };
      children: Array<{ key: string; filename?: string | null }>;
    };

    expect(structured.item.fields.DOI).toBe('10.1000/xyz');
    expect(structured.item.abstract).toBeTruthy();
    expect(structured.item.creators[0]?.name).toContain('Vaswani');
    // Children need their file details too: a bare title cannot tell the model
    // whether there is a file to read.
    expect(structured.children.some((child) => child.filename !== undefined)).toBe(true);
  });

  test('collections render as a tree', async () => {
    const result = await client.callTool({ name: 'zotero_list_collections', arguments: {} });
    const [block] = result.content as Array<{ text: string }>;
    expect(block?.text).toContain('Transformers (key: COLL0001, 1 items)');
  });

  test('reports invalid arguments instead of throwing', async () => {
    const result = await client.callTool({
      name: 'zotero_get_item',
      arguments: { key: 'not-a-key' },
    });
    expect(result.isError).toBe(true);
  });

  test('attachment reads explain that WebDAV is unconfigured', async () => {
    const result = await client.callTool({
      name: 'zotero_read_attachment',
      arguments: { itemKey: 'AAAA1111' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('WebDAV is not configured');
  });

  test('attachment reads say so when the item has no file at all', async () => {
    const result = await client.callTool({
      name: 'zotero_read_attachment',
      arguments: { itemKey: 'CCCC3333' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('no stored file attachment');
  });
});

describe('semantic relevance', () => {
  interface ScoredResult {
    items: Array<{ key: string; score?: number }>;
    minScore: number;
    scored: number;
    belowThreshold: number;
    unscored: number;
    note?: string;
  }

  async function search(
    matches: Array<{ itemKey: string; score?: number }>,
    args: Record<string, unknown> = {},
  ): Promise<{ structured: ScoredResult; text: string }> {
    const client = await connect(testContext([SCOPE_READ], stubSemantic(matches)));
    const result = await client.callTool({
      name: 'zotero_semantic_search',
      arguments: { query: 'what makes a transformer work so well', ...args },
    });
    expect(result.isError).toBeFalsy();
    const [block] = result.content as Array<{ text: string }>;
    return { structured: result.structuredContent as ScoredResult, text: block?.text ?? '' };
  }

  test('returns weak matches rather than hiding them, and says which are weak', async () => {
    // Nearest-neighbour search returns its closest documents however far away
    // they are, so a query the library does not cover comes back looking like
    // any other result set.
    // Filtering would trade visible noise for invisible loss; flagging does not.
    const { structured, text } = await search([
      { itemKey: 'AAAA1111', score: 0.81 },
      { itemKey: 'CCCC3333', score: 0.22 },
    ]);

    expect(structured.items.map((item) => item.score)).toEqual([0.81, 0.22]);
    expect(structured.minScore).toBe(0.5);
    expect(structured.belowThreshold).toBe(1);
    expect(structured.note).toContain('0.220');
    expect(text).toContain('score: 0.220');
  });

  test('stays quiet when every match clears the floor', async () => {
    const { structured } = await search([{ itemKey: 'AAAA1111', score: 0.77 }]);
    expect(structured.belowThreshold).toBe(0);
    expect(structured.note).toBeUndefined();
  });

  test('honours a caller-supplied floor', async () => {
    const { structured } = await search([{ itemKey: 'AAAA1111', score: 0.62 }], { minScore: 0.7 });
    expect(structured.minScore).toBe(0.7);
    expect(structured.belowThreshold).toBe(1);
  });

  test('reports a result with no similarity as unscored, not as scoring zero', async () => {
    // Hybrid retrieval does not report a distance for every result. Absent means
    // "no similarity reported", not "scored zero" — conflating the two would make
    // such a hit look irrelevant, and would make belowThreshold look like it
    // covered every row. `scored` is the denominator that says otherwise.
    const { structured } = await search([
      { itemKey: 'AAAA1111' },
      { itemKey: 'CCCC3333', score: 0.22 },
    ]);
    const byKey = new Map(structured.items.map((item) => [item.key, item.score]));

    expect(byKey.get('AAAA1111')).toBeUndefined();
    expect(byKey.get('CCCC3333')).toBe(0.22);
    expect(structured.belowThreshold).toBe(1);
    expect(structured.unscored).toBe(1);
    expect(structured.scored).toBe(1);
    expect(structured.note).toContain('without a similarity score');
  });
});

describe('semantic filters', () => {
  interface FilteredResult {
    items: Array<{ key: string; score?: number }>;
    note?: string;
  }

  async function search(
    matches: Array<{ itemKey: string; score: number }>,
    args: Record<string, unknown>,
  ): Promise<{
    structured: FilteredResult;
    index: StubSemanticIndex;
    itemsQuery: () => URLSearchParams;
  }> {
    const index = stubSemantic(matches);
    const context = testContext([SCOPE_READ], index);
    const client = await connect(context);
    const result = await client.callTool({
      name: 'zotero_semantic_search',
      arguments: { query: 'what makes a transformer work so well', ...args },
    });
    expect(result.isError).toBeFalsy();
    return {
      structured: result.structuredContent as FilteredResult,
      index,
      itemsQuery: () => lastItemsQuery(context),
    };
  }

  test('sends the same server-side filters zotero_search sends', async () => {
    // AI Search can only pre-filter the metadata fields declared on the instance,
    // so these ride along on the lookup that fetches the matched items' details.
    const { itemsQuery } = await search([{ itemKey: 'AAAA1111', score: 0.8 }], {
      tags: ['transformers'],
      itemType: '-book',
      since: 40,
    });

    const query = itemsQuery();
    expect(query.get('itemKey')).toBe('AAAA1111');
    expect(query.getAll('tag')).toEqual(['transformers']);
    expect(query.getAll('itemType')).toEqual(['-book']);
    expect(query.get('since')).toBe('40');
  });

  test('drops matches outside the requested collection', async () => {
    const { structured } = await search(
      [
        { itemKey: 'AAAA1111', score: 0.81 },
        { itemKey: 'DDDD4444', score: 0.62 },
      ],
      { collectionKey: 'COLL0001' },
    );

    expect(structured.items.map((item) => item.key)).toEqual(['DDDD4444']);
    expect(structured.note).toContain('outside the active filters');
  });

  test('pushes year bounds down and enforces them on the results', async () => {
    const { structured, index } = await search(
      [
        { itemKey: 'AAAA1111', score: 0.81 },
        { itemKey: 'DDDD4444', score: 0.62 },
      ],
      { fromYear: 2000 },
    );

    expect(index.calls[0]?.fromYear).toBe(2000);
    // A stub index ignores the pre-filter, which is the point: the local check
    // still has to drop the 1998 item, or a stale vector would slip through.
    expect(structured.items.map((item) => item.key)).toEqual(['AAAA1111']);
  });

  test('over-fetches candidates only when a filter can discard them', async () => {
    const plain = await search([{ itemKey: 'AAAA1111', score: 0.8 }], { limit: 7 });
    expect(plain.index.calls[0]?.topK).toBe(7);

    const narrowed = await search([{ itemKey: 'AAAA1111', score: 0.8 }], {
      limit: 7,
      tags: ['transformers'],
    });
    expect(narrowed.index.calls[0]?.topK).toBe(21);
  });

  test('drops every match a filter excludes rather than widening the result', async () => {
    // The bug this guards: semantic recall used to ignore the filters entirely, so
    // a narrowed query came back only half-obeying the caller. With the only match
    // outside the collection, the honest answer is nothing at all.
    const { structured } = await search([{ itemKey: 'AAAA1111', score: 0.9 }], {
      collectionKey: 'COLL0001',
    });

    expect(structured.items).toEqual([]);
    expect(structured.note).toContain('outside the active filters');
  });

  test('points at zotero_reindex when the index is empty', async () => {
    const { structured } = await search([], {});
    expect(structured.note).toContain('zotero_reindex');
    expect(structured.note).not.toContain('/admin/reindex');
  });
});
describe('semantic search without a backend', () => {
  test('names zotero_search instead of failing silently', async () => {
    // `testContext` defaults `semantic` to null, which is what a deployment with
    // no AI Search binding looks like. An empty result set would read as "the
    // library has nothing", so this has to be an error the caller can act on.
    const client = await connect(testContext([SCOPE_READ]));
    const result = await client.callTool({
      name: 'zotero_semantic_search',
      arguments: { query: 'what do I have on sparse attention' },
    });

    expect(result.isError).toBe(true);
    const message = JSON.stringify(result.content);
    expect(message).toContain('zotero_search');
  });

  test('still lists the tool, so the error is reachable', async () => {
    // Hiding it would make the failure a "no such tool" mystery instead of a
    // message that says what to do next.
    const client = await connect(testContext([SCOPE_READ]));
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('zotero_semantic_search');
  });
});

describe('scopes', () => {
  test('write tools refuse a read-only token', async () => {
    const readOnly = await connect(testContext([SCOPE_READ]));
    const result = await readOnly.callTool({
      name: 'zotero_update_item',
      arguments: { keys: ['AAAA1111'], fields: { title: 'new' } },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('zotero:write');
  });

  test('write tools work with a full token', async () => {
    const writable = await connect(testContext());
    const result = await writable.callTool({
      name: 'zotero_update_item',
      arguments: { keys: ['AAAA1111'], fields: { title: 'new' } },
    });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { updated: string[] }).updated).toEqual(['AAAA1111']);
  });
});
