import { describe, expect, test } from 'bun:test';
import { ZoteroApiError, ZoteroClient, ZoteroConflictError } from '../src/core/zotero/client.js';
import { jsonResponse, pathOf, route, stubFetch } from './helpers.js';

const KEY = 'test-api-key';

describe('ZoteroClient', () => {
  test('resolves the library id from the API key once', async () => {
    const stub = stubFetch([
      route('GET', '/keys/current', () => jsonResponse({ userID: 12345, username: 'me' })),
      route('GET', '/users/12345/items', () => jsonResponse([], { version: 7 })),
    ]);
    const client = new ZoteroClient({ apiKey: KEY, fetch: stub.fetch });

    await client.getItems();
    await client.getItems();

    const keyLookups = stub.requests.filter((r) => pathOf(r.url).startsWith('/keys/current'));
    expect(keyLookups).toHaveLength(1);
    expect(stub.requests[0]?.headers['zotero-api-key']).toBe(KEY);
    expect(stub.requests[0]?.headers['zotero-api-version']).toBe('3');
  });

  test('paginates until the page comes back short', async () => {
    const page = (size: number) =>
      Array.from({ length: size }, (_, i) => ({ key: `K${i}`, version: 1, data: {} }));
    const stub = stubFetch([
      route('GET', '/users/1/items', (request) => {
        const start = Number(new URL(request.url).searchParams.get('start') ?? 0);
        return jsonResponse(start === 0 ? page(100) : page(20), { version: 42 });
      }),
    ]);
    const client = new ZoteroClient({ apiKey: KEY, libraryId: 1, fetch: stub.fetch });

    const result = await client.getItems({}, 250);

    expect(result.items).toHaveLength(120);
    expect(result.lastModifiedVersion).toBe(42);
    expect(stub.requests).toHaveLength(2);
    expect(new URL(stub.requests[1]?.url as string).searchParams.get('start')).toBe('100');
  });

  test('never requests more than the caller asked for', async () => {
    const stub = stubFetch([
      route('GET', '/users/1/items', () =>
        jsonResponse(Array.from({ length: 10 }, (_, i) => ({ key: `K${i}` }))),
      ),
    ]);
    const client = new ZoteroClient({ apiKey: KEY, libraryId: 1, fetch: stub.fetch });

    await client.getItems({}, 10);

    expect(new URL(stub.requests[0]?.url as string).searchParams.get('limit')).toBe('10');
  });

  test('retries 429 responses using Retry-After', async () => {
    let calls = 0;
    const stub = stubFetch([
      route('GET', '/users/1/items', () => {
        calls++;
        if (calls === 1) {
          return new Response('slow down', { status: 429, headers: { 'Retry-After': '0' } });
        }
        return jsonResponse([{ key: 'AAA' }]);
      }),
    ]);
    const client = new ZoteroClient({ apiKey: KEY, libraryId: 1, fetch: stub.fetch });

    const result = await client.getItems();

    expect(calls).toBe(2);
    expect(result.items).toHaveLength(1);
  });

  test('turns 412 into a conflict error', async () => {
    const stub = stubFetch([
      route(
        'PATCH',
        '/users/1/items/ABCD1234',
        () => new Response('version mismatch', { status: 412 }),
      ),
    ]);
    const client = new ZoteroClient({ apiKey: KEY, libraryId: 1, fetch: stub.fetch });

    await expect(client.patchItem('ABCD1234', { title: 'x' }, 3)).rejects.toBeInstanceOf(
      ZoteroConflictError,
    );
  });

  test('locks a delete against the item, not the library', async () => {
    // Regression: deletes went through the multi-key endpoint, which can only be
    // locked against the library version. Any other write to the library — even
    // our own previous delete — made the next one a 412.
    const stub = stubFetch([
      route('DELETE', '/users/1/items/ABCD1234', () => new Response(null, { status: 204 })),
    ]);
    const client = new ZoteroClient({ apiKey: KEY, libraryId: 1, fetch: stub.fetch });

    await client.deleteItem('ABCD1234', 7);

    const [request] = stub.requests;
    expect(request?.url).toEndWith('/users/1/items/ABCD1234');
    expect(request?.headers['if-unmodified-since-version']).toBe('7');
  });

  test('surfaces other failures with status and body', async () => {
    const stub = stubFetch([
      route('GET', '/users/1/items/NOPE', () => new Response('Not found', { status: 404 })),
    ]);
    const client = new ZoteroClient({ apiKey: KEY, libraryId: 1, fetch: stub.fetch });

    const error = await client.getItem('NOPE').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ZoteroApiError);
    expect((error as ZoteroApiError).status).toBe(404);
  });

  test('sends the optimistic-lock header on patches', async () => {
    const stub = stubFetch([
      route('PATCH', '/users/1/items/ABCD1234', () => new Response(null, { status: 204 })),
    ]);
    const client = new ZoteroClient({ apiKey: KEY, libraryId: 1, fetch: stub.fetch });

    await client.patchItem('ABCD1234', { title: 'new' }, 17);

    expect(stub.requests[0]?.headers['if-unmodified-since-version']).toBe('17');
  });

  test('splits writes into batches of 50 and re-indexes the results', async () => {
    const stub = stubFetch([
      route('POST', '/users/1/items', (request) => {
        const batch = JSON.parse(request.body as string) as unknown[];
        const success: Record<string, string> = {};
        batch.forEach((_, index) => {
          success[String(index)] = `KEY${index}`;
        });
        return jsonResponse({ success, unchanged: {}, failed: {} });
      }),
    ]);
    const client = new ZoteroClient({ apiKey: KEY, libraryId: 1, fetch: stub.fetch });

    const objects = Array.from({ length: 60 }, (_, i) => ({ itemType: 'book', title: `T${i}` }));
    const result = await client.writeObjects('items', objects);

    expect(stub.requests).toHaveLength(2);
    expect(Object.keys(result.success)).toHaveLength(60);
    // Second batch results must not collide with the first batch's indexes.
    expect(result.success['50']).toBe('KEY0');
    expect(stub.requests[0]?.headers['zotero-write-token']).toMatch(/^[0-9a-f]{32}$/);
  });

  test('returns null when an attachment has no indexed full text', async () => {
    const stub = stubFetch([
      route('GET', '/users/1/items/AAA/fulltext', () => new Response('Not found', { status: 404 })),
    ]);
    const client = new ZoteroClient({ apiKey: KEY, libraryId: 1, fetch: stub.fetch });

    expect(await client.getFulltext('AAA')).toBeNull();
  });

  test('encodes repeated query params for AND semantics', async () => {
    const stub = stubFetch([route('GET', '/users/1/items', () => jsonResponse([]))]);
    const client = new ZoteroClient({ apiKey: KEY, libraryId: 1, fetch: stub.fetch });

    await client.getItems({ tag: ['alpha', 'beta'], q: 'quantum' });

    const url = new URL(stub.requests[0]?.url as string);
    expect(url.searchParams.getAll('tag')).toEqual(['alpha', 'beta']);
    expect(url.searchParams.get('q')).toBe('quantum');
  });
});
