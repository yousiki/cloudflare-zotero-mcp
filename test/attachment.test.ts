import { describe, expect, test } from 'bun:test';
import { unzipSync } from 'fflate';
import { AttachmentError, AttachmentReader } from '../src/core/attachment/read.js';
import { AttachmentWriter } from '../src/core/attachment/write.js';
import { md5Hex } from '../src/core/http.js';
import { WebDavClient } from '../src/core/webdav/client.js';
import { zipAttachment } from '../src/core/webdav/zip.js';
import { ZoteroClient } from '../src/core/zotero/client.js';
import type { ZoteroItem } from '../src/core/zotero/types.js';
import { jsonResponse, pathOf, route, stubFetch } from './helpers.js';

const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\nfake pdf body');

function attachmentItem(overrides: Record<string, unknown> = {}): ZoteroItem {
  return {
    key: 'ATTA0001',
    version: 5,
    library: { type: 'user', id: 1, name: 'me' },
    data: {
      key: 'ATTA0001',
      version: 5,
      itemType: 'attachment',
      linkMode: 'imported_file',
      title: 'Full Text PDF',
      filename: 'paper.pdf',
      contentType: 'application/pdf',
      parentItem: 'PARE0001',
      ...overrides,
    },
  };
}

describe('AttachmentWriter.create', () => {
  test('creates the item, uploads the pair, then records md5 and mtime', async () => {
    const zotero = stubFetch([
      route('GET', '/items/new', () =>
        jsonResponse({
          itemType: 'attachment',
          linkMode: 'imported_file',
          title: '',
          filename: '',
        }),
      ),
      route('POST', '/users/1/items', () =>
        jsonResponse({ success: { '0': 'ATTA0001' }, unchanged: {}, failed: {} }),
      ),
      route('GET', '/users/1/items/ATTA0001', () => jsonResponse(attachmentItem())),
      route('PATCH', '/users/1/items/ATTA0001', () => new Response(null, { status: 204 })),
    ]);
    const dav = stubFetch([
      { match: (r) => r.method === 'PUT', respond: () => new Response(null, { status: 201 }) },
    ]);

    const writer = new AttachmentWriter(
      new ZoteroClient({ apiKey: 'k', libraryId: 1, fetch: zotero.fetch }),
      new WebDavClient({
        url: 'https://dav.example.com',
        username: 'u',
        password: 'p',
        fetch: dav.fetch,
      }),
    );

    const result = await writer.create({
      parentItemKey: 'PARE0001',
      filename: 'paper.pdf',
      data: PDF_BYTES,
      contentType: 'application/pdf',
    });

    expect(result.attachmentKey).toBe('ATTA0001');
    expect(result.md5).toBe(await md5Hex(PDF_BYTES));

    // The zip lands before the metadata does, so a failed upload never leaves
    // Zotero claiming a file exists.
    const davPaths = dav.requests.map((r) => pathOf(r.url));
    expect(davPaths).toEqual(['/zotero/ATTA0001.zip', '/zotero/ATTA0001.prop']);

    const patch = zotero.requests.find((r) => r.method === 'PATCH');
    const body = JSON.parse(patch?.body as string) as Record<string, unknown>;
    expect(body.md5).toBe(result.md5);
    expect(body.filename).toBe('paper.pdf');
    expect(typeof body.mtime).toBe('number');
    expect(patch?.headers['if-unmodified-since-version']).toBe('5');
  });

  test('refuses to write without WebDAV configured', async () => {
    const zotero = stubFetch([]);
    const writer = new AttachmentWriter(
      new ZoteroClient({ apiKey: 'k', libraryId: 1, fetch: zotero.fetch }),
      null,
    );
    await expect(writer.create({ filename: 'a.pdf', data: PDF_BYTES })).rejects.toBeInstanceOf(
      AttachmentError,
    );
  });
});

describe('AttachmentWriter.rename', () => {
  test('rewrites the archive so the entry carries the new filename', async () => {
    const zotero = stubFetch([
      route('GET', '/users/1/items/ATTA0001', () =>
        jsonResponse(attachmentItem({ md5: 'stale', mtime: 1 })),
      ),
      route('PATCH', '/users/1/items/ATTA0001', () => new Response(null, { status: 204 })),
    ]);
    let uploaded: Uint8Array | undefined;
    const dav = stubFetch([
      {
        match: (r) => r.method === 'PUT' && r.url.endsWith('.zip'),
        respond: (r) => {
          uploaded = r.binaryBody;
          return new Response(null, { status: 201 });
        },
      },
      { match: (r) => r.method === 'PUT', respond: () => new Response(null, { status: 201 }) },
    ]);

    const writer = new AttachmentWriter(
      new ZoteroClient({ apiKey: 'k', libraryId: 1, fetch: zotero.fetch }),
      new WebDavClient({
        url: 'https://dav.example.com',
        username: 'u',
        password: 'p',
        fetch: dav.fetch,
      }),
    );

    const result = await writer.rename('ATTA0001', 'Vaswani - 2017 - Attention.pdf', PDF_BYTES);

    expect(result.filename).toBe('Vaswani - 2017 - Attention.pdf');
    // The renamed file must be the zip entry name, not just the item metadata.
    expect(Object.keys(unzipSync(uploaded as Uint8Array))).toEqual([
      'Vaswani - 2017 - Attention.pdf',
    ]);
    const patch = zotero.requests.find((r) => r.method === 'PATCH');
    const body = JSON.parse(patch?.body as string) as Record<string, unknown>;
    expect(body.filename).toBe('Vaswani - 2017 - Attention.pdf');
    expect(body.title).toBe('Vaswani - 2017 - Attention.pdf');
    expect(body.md5).toBe(await md5Hex(PDF_BYTES));
  });

  test('is a no-op when the name already matches', async () => {
    const zotero = stubFetch([
      route('GET', '/users/1/items/ATTA0001', () => jsonResponse(attachmentItem({ md5: 'abc' }))),
    ]);
    const dav = stubFetch([]);
    const writer = new AttachmentWriter(
      new ZoteroClient({ apiKey: 'k', libraryId: 1, fetch: zotero.fetch }),
      new WebDavClient({
        url: 'https://dav.example.com',
        username: 'u',
        password: 'p',
        fetch: dav.fetch,
      }),
    );

    await writer.rename('ATTA0001', 'paper.pdf', PDF_BYTES);

    expect(dav.requests).toHaveLength(0);
  });
});

describe('AttachmentReader', () => {
  function reader(zoteroRoutes: Parameters<typeof stubFetch>[0], zipped?: Uint8Array) {
    const zotero = stubFetch(zoteroRoutes);
    const dav = stubFetch([
      route('GET', '/zotero/ATTA0001.zip', () =>
        zipped
          ? new Response(zipped as unknown as BodyInit)
          : new Response('missing', { status: 404 }),
      ),
    ]);
    const client = new ZoteroClient({ apiKey: 'k', libraryId: 1, fetch: zotero.fetch });
    return {
      zotero,
      reader: new AttachmentReader(
        client,
        new WebDavClient({
          url: 'https://dav.example.com',
          username: 'u',
          password: 'p',
          fetch: dav.fetch,
        }),
      ),
    };
  }

  test('downloads and unpacks the file, flagging hash drift', async () => {
    const zipped = zipAttachment('paper.pdf', PDF_BYTES);
    const { reader: subject } = reader(
      [
        route('GET', '/users/1/items/ATTA0001', () =>
          jsonResponse(attachmentItem({ md5: 'wrong' })),
        ),
      ],
      zipped,
    );

    const file = await subject.download('ATTA0001');

    expect(file.data).toEqual(PDF_BYTES);
    expect(file.filename).toBe('paper.pdf');
    expect(file.hashMismatch).toBe(true);
  });

  test('explains what to do when the file is not on WebDAV yet', async () => {
    const { reader: subject } = reader([
      route('GET', '/users/1/items/ATTA0001', () => jsonResponse(attachmentItem())),
    ]);

    const error = await subject.download('ATTA0001').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AttachmentError);
    expect((error as Error).message).toContain('Sync Zotero Desktop');
  });

  test('prefers the PDF child when handed a parent item key', async () => {
    const parent: ZoteroItem = {
      key: 'PARE0001',
      version: 2,
      library: { type: 'user', id: 1, name: 'me' },
      data: { key: 'PARE0001', version: 2, itemType: 'journalArticle', title: 'Paper' },
    };
    const children = [
      attachmentItem({ key: 'ATTB0002', contentType: 'text/html', filename: 'snapshot.html' }),
      attachmentItem(),
    ];
    children[0] = { ...(children[0] as ZoteroItem), key: 'ATTB0002' };

    const { reader: subject } = reader([
      route('GET', '/users/1/items/PARE0001/children', () => jsonResponse(children)),
      route('GET', '/users/1/items/PARE0001', () => jsonResponse(parent)),
    ]);

    const attachment = await subject.resolveAttachment('PARE0001');
    expect(attachment.key).toBe('ATTA0001');
  });

  test("reads whole documents from Zotero's index without touching WebDAV", async () => {
    const { reader: subject, zotero } = reader([
      route('GET', '/users/1/items/ATTA0001/fulltext', () =>
        jsonResponse({ content: 'indexed text', indexedPages: 3, totalPages: 3 }),
      ),
      route('GET', '/users/1/items/ATTA0001', () => jsonResponse(attachmentItem())),
    ]);

    const result = await subject.readText('ATTA0001');

    expect(result.source).toBe('zotero-index');
    expect(result.text).toBe('indexed text');
    expect(zotero.requests.some((r) => r.url.includes('/fulltext'))).toBe(true);
  });

  test('falls back to the file when a page range is requested', async () => {
    const zipped = zipAttachment('notes.txt', new TextEncoder().encode('plain body'));
    const { reader: subject } = reader(
      [
        route('GET', '/users/1/items/ATTA0001', () =>
          jsonResponse(attachmentItem({ contentType: 'text/plain', filename: 'notes.txt' })),
        ),
      ],
      zipped,
    );

    const result = await subject.readText('ATTA0001', { forceFile: true });

    expect(result.source).toBe('webdav');
    expect(result.text).toBe('plain body');
  });
});

describe('zipAttachment', () => {
  test('produces an archive Zotero Desktop can open', () => {
    const entries = unzipSync(zipAttachment('paper.pdf', PDF_BYTES));
    expect(Object.keys(entries)).toEqual(['paper.pdf']);
    expect(Array.from(entries['paper.pdf'] as Uint8Array)).toEqual(Array.from(PDF_BYTES));
  });
});
