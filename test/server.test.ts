import { beforeAll, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { SCOPE_READ, SCOPE_WRITE, type ZoteroMcpContext } from '../src/context.js';
import { AttachmentReader } from '../src/core/attachment/read.js';
import { AttachmentWriter } from '../src/core/attachment/write.js';
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

interface StubSemanticIndex extends SemanticIndex {
  /** Options every `query` call received, for asserting what was pushed down. */
  calls: SemanticQueryOptions[];
}

/** A semantic index that answers with fixed matches, scores included. */
function stubSemantic(matches: Array<{ itemKey: string; score: number }>): StubSemanticIndex {
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
    expect(byName.get('zotero_delete_items')?.annotations?.destructiveHint).toBe(true);
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

    await scoped.callTool({ name: 'zotero_search', arguments: { query: 'rlhf', mode: 'keyword' } });
    // Zotero rejects multiple negations, so exactly one value must be sent.
    expect(lastItemsQuery(context).getAll('itemType')).toEqual(['-attachment']);

    await scoped.callTool({
      name: 'zotero_search',
      arguments: { query: 'rlhf', mode: 'keyword', itemType: 'note' },
    });
    expect(lastItemsQuery(context).getAll('itemType')).toEqual(['note']);
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
    minScore?: number;
    belowThreshold?: number;
    note?: string;
  }

  async function search(
    matches: Array<{ itemKey: string; score: number }>,
    args: Record<string, unknown>,
  ): Promise<{ structured: ScoredResult; text: string }> {
    const client = await connect(testContext([SCOPE_READ], stubSemantic(matches)));
    const result = await client.callTool({
      name: 'zotero_search',
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
    const { structured, text } = await search(
      [
        { itemKey: 'AAAA1111', score: 0.81 },
        { itemKey: 'CCCC3333', score: 0.22 },
      ],
      { mode: 'semantic' },
    );

    expect(structured.items.map((item) => item.score)).toEqual([0.81, 0.22]);
    expect(structured.minScore).toBe(0.5);
    expect(structured.belowThreshold).toBe(1);
    expect(structured.note).toContain('0.220');
    expect(text).toContain('score: 0.220');
  });

  test('stays quiet when every match clears the floor', async () => {
    const { structured } = await search([{ itemKey: 'AAAA1111', score: 0.77 }], {
      mode: 'semantic',
    });
    expect(structured.belowThreshold).toBe(0);
    expect(structured.note).toBeUndefined();
  });

  test('honours a caller-supplied floor', async () => {
    const { structured } = await search([{ itemKey: 'AAAA1111', score: 0.62 }], {
      mode: 'semantic',
      minScore: 0.7,
    });
    expect(structured.minScore).toBe(0.7);
    expect(structured.belowThreshold).toBe(1);
  });

  test('leaves keyword matches unscored in auto mode', async () => {
    // A missing score means "matched the text", not "scored zero" — conflating
    // the two would make every keyword hit look irrelevant.
    const { structured } = await search([{ itemKey: 'CCCC3333', score: 0.31 }], { mode: 'auto' });
    const byKey = new Map(structured.items.map((item) => [item.key, item.score]));

    expect(byKey.get('CCCC3333')).toBe(0.31);
    expect(byKey.has('AAAA1111')).toBe(true);
    expect(byKey.get('AAAA1111')).toBeUndefined();
    expect(structured.belowThreshold).toBe(1);
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
      name: 'zotero_search',
      arguments: { query: 'what makes a transformer work so well', mode: 'semantic', ...args },
    });
    expect(result.isError).toBeFalsy();
    return {
      structured: result.structuredContent as FilteredResult,
      index,
      itemsQuery: () => lastItemsQuery(context),
    };
  }

  test('sends the same server-side filters keyword search sends', async () => {
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

  test('asks for distance only in semantic mode, and hybrid in auto', async () => {
    const { index } = await search([{ itemKey: 'AAAA1111', score: 0.8 }], {});
    // A caller that asked for similarity must not be handed an unscored keyword
    // hit, which hybrid retrieval can produce.
    expect(index.calls[0]?.retrieval).toBe('vector');

    const auto = await search([{ itemKey: 'AAAA1111', score: 0.8 }], { mode: 'auto' });
    expect(auto.index.calls[0]?.retrieval).toBe('hybrid');
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

  test('auto mode cannot return a hit its keyword half would exclude', async () => {
    // The bug this guards: semantic recall used to ignore every filter, so the
    // merged result set half-obeyed the caller's constraints.
    const { structured } = await search([{ itemKey: 'AAAA1111', score: 0.9 }], {
      mode: 'auto',
      collectionKey: 'COLL0001',
    });

    expect(structured.items.map((item) => item.key)).toEqual(['DDDD4444']);
  });

  test('points at zotero_reindex when the index is empty', async () => {
    const { structured } = await search([], {});
    expect(structured.note).toContain('zotero_reindex');
    expect(structured.note).not.toContain('/admin/reindex');
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
