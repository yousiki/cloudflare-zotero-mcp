import { describe, expect, test } from 'bun:test';
import {
  MAX_REMOTE_FILE_BYTES,
  openRemotePdf,
  RemoteFileError,
} from '../src/core/attachment/remote.js';
import { AttachmentWriter } from '../src/core/attachment/write.js';
import { md5Hex } from '../src/core/http.js';
import { Md5Hasher, md5Fallback } from '../src/core/md5.js';
import { WebDavClient } from '../src/core/webdav/client.js';
import { storedZipSize, unzipAttachment, zipStoredStream } from '../src/core/webdav/zip.js';
import { ZoteroClient } from '../src/core/zotero/client.js';
import { jsonResponse, pathOf, route, stubFetch } from './helpers.js';

const PDF = new TextEncoder().encode('%PDF-1.7\nstream of pretend pdf bytes');

describe('Md5Hasher', () => {
  test('matches the one-shot fallback across chunk sizes', () => {
    const payload = new Uint8Array(10_000);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
    const expected = md5Fallback(payload);
    for (const size of [1, 63, 64, 65, 511, 512, 1000]) {
      const hasher = new Md5Hasher();
      for (let offset = 0; offset < payload.length; offset += size) {
        hasher.update(payload.subarray(offset, offset + size));
      }
      expect(hasher.digest()).toBe(expected);
    }
  });
});

describe('stored zip stream', () => {
  test('round-trips without buffering a second copy of the file', async () => {
    const stream = zipStoredStream('paper.pdf', new Blob([PDF]).stream());
    const zipped = new Uint8Array(await new Response(stream).arrayBuffer());
    expect(zipped.byteLength).toBe(storedZipSize('paper.pdf', PDF.byteLength));
    const unzipped = unzipAttachment(zipped);
    expect(unzipped.filename).toBe('paper.pdf');
    expect(unzipped.data).toEqual(PDF);
  });
});

describe('openRemotePdf', () => {
  test('rejects a declared size over the remote cap without reading the body', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(PDF);
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchLike = async () =>
      new Response(body, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Length': String(MAX_REMOTE_FILE_BYTES + 1),
        },
      });

    await expect(
      openRemotePdf('https://arxiv.org/pdf/2609.01560', { fetch: fetchLike }),
    ).rejects.toBeInstanceOf(RemoteFileError);
    expect(cancelled).toBe(true);
  });

  test('rejects a landing page that is not a PDF', async () => {
    const html = new TextEncoder().encode('<html>login</html>');
    const fetchLike = async () => new Response(html, { headers: { 'Content-Type': 'text/html' } });
    await expect(openRemotePdf('https://example.com/paper', { fetch: fetchLike })).rejects.toThrow(
      /rather than a PDF/,
    );
  });
});

describe('AttachmentWriter.createFromStream', () => {
  test('uploads a stored zip and records the source MD5', async () => {
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
      route('GET', '/users/1/items/ATTA0001', () =>
        jsonResponse({
          key: 'ATTA0001',
          version: 5,
          library: { type: 'user', id: 1, name: 'me' },
          data: { key: 'ATTA0001', version: 5, itemType: 'attachment', filename: 'paper.pdf' },
        }),
      ),
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

    const result = await writer.createFromStream({
      parentItemKey: 'PARE0001',
      filename: 'paper.pdf',
      body: new Blob([PDF]).stream(),
      byteLength: PDF.byteLength,
      contentType: 'application/pdf',
    });

    expect(result.attachmentKey).toBe('ATTA0001');
    expect(result.md5).toBe(await md5Hex(PDF));
    expect(result.bytes).toBe(PDF.byteLength);
    expect(dav.requests[0]?.headers['content-length']).toBe(
      String(storedZipSize('paper.pdf', PDF.byteLength)),
    );
    expect(unzipAttachment(dav.requests[0]?.binaryBody as Uint8Array).data).toEqual(PDF);
    expect(pathOf(dav.requests[0]?.url as string)).toBe('/zotero/ATTA0001.zip');
  });
});

describe('WebDAV 530', () => {
  test('explains Origin DNS on a 530 PUT', async () => {
    const stub = stubFetch([
      {
        match: (r) => r.method === 'PUT',
        respond: () => new Response('error code: 530', { status: 530 }),
      },
    ]);
    const client = new WebDavClient({
      url: 'https://dav.example.com',
      username: 'u',
      password: 'p',
      fetch: stub.fetch,
    });
    await expect(client.putZip('ABCD1234', new Uint8Array([1, 2, 3]))).rejects.toThrow(
      /Origin DNS/,
    );
  });
});
