import { describe, expect, test } from 'bun:test';
import { zipSync } from 'fflate';
import { WebDavClient, WebDavError } from '../src/core/webdav/client.js';
import { parseProp, renderProp } from '../src/core/webdav/prop.js';
import { AttachmentZipError, unzipAttachment, zipAttachment } from '../src/core/webdav/zip.js';
import { pathOf, route, stubFetch } from './helpers.js';

const creds = { username: 'user', password: 'pass' };

describe('prop files', () => {
  test('round-trips', () => {
    const props = { mtime: 1712345678901, hash: '5eb63bbbe01eeed093cb22bb8f5acdc3' };
    expect(parseProp(renderProp(props))).toEqual(props);
  });

  test('parses whitespace-tolerant XML from other clients', () => {
    const parsed = parseProp(
      '<properties version="1">\r\n\t<mtime> 1700000000000 </mtime>\r\n\t<hash>D41D8CD98F00B204E9800998ECF8427E</hash>\r\n</properties>',
    );
    expect(parsed).toEqual({ mtime: 1700000000000, hash: 'd41d8cd98f00b204e9800998ecf8427e' });
  });

  test('returns null for malformed content', () => {
    expect(parseProp('<properties version="1"></properties>')).toBeNull();
    expect(parseProp('not xml at all')).toBeNull();
  });
});

describe('attachment zips', () => {
  test('round-trips a single file', () => {
    const data = new TextEncoder().encode('%PDF-1.7 pretend');
    const unzipped = unzipAttachment(zipAttachment('paper.pdf', data));
    expect(unzipped.filename).toBe('paper.pdf');
    expect(unzipped.data).toEqual(data);
  });

  test('skips the desktop client full-text cache entries', () => {
    const payload = new TextEncoder().encode('real content');
    const archive = zipSync({
      '.zotero-ft-cache': new TextEncoder().encode('cached text'),
      '.zotero-ft-info': new TextEncoder().encode('version=1'),
      'Smith - 2020 - Paper.pdf': payload,
    });

    const unzipped = unzipAttachment(archive);

    expect(unzipped.filename).toBe('Smith - 2020 - Paper.pdf');
    expect(unzipped.data).toEqual(payload);
  });

  test('prefers the filename recorded on the Zotero item', () => {
    const wanted = new TextEncoder().encode('wanted');
    const archive = zipSync({
      'other.pdf': new TextEncoder().encode('other'),
      'wanted.pdf': wanted,
    });

    expect(unzipAttachment(archive, 'wanted.pdf').data).toEqual(wanted);
  });

  test('fails loudly when the archive holds only bookkeeping files', () => {
    const archive = zipSync({ '.zotero-ft-cache': new TextEncoder().encode('x') });
    expect(() => unzipAttachment(archive)).toThrow(AttachmentZipError);
  });
});

describe('WebDavClient', () => {
  test('appends /zotero to the configured root exactly once', () => {
    const a = new WebDavClient({ url: 'https://dav.example.com/dav/', ...creds });
    const b = new WebDavClient({ url: 'https://dav.example.com/dav/zotero', ...creds });
    expect(a.baseUrl).toBe('https://dav.example.com/dav/zotero');
    expect(b.baseUrl).toBe('https://dav.example.com/dav/zotero');
  });

  test('sends basic auth and writes the zip/prop pair', async () => {
    const stub = stubFetch([
      { match: (r) => r.method === 'PUT', respond: () => new Response(null, { status: 201 }) },
    ]);
    const client = new WebDavClient({
      url: 'https://dav.example.com',
      ...creds,
      fetch: stub.fetch,
    });

    await client.putZip('ABCD1234', zipAttachment('a.pdf', new Uint8Array([1, 2, 3])));
    await client.putProp('ABCD1234', { mtime: 100, hash: 'd41d8cd98f00b204e9800998ecf8427e' });

    expect(pathOf(stub.requests[0]?.url as string)).toBe('/zotero/ABCD1234.zip');
    expect(pathOf(stub.requests[1]?.url as string)).toBe('/zotero/ABCD1234.prop');
    expect(stub.requests[0]?.headers.authorization).toBe(`Basic ${btoa('user:pass')}`);
    expect(stub.requests[1]?.body).toContain('<hash>d41d8cd98f00b204e9800998ecf8427e</hash>');
  });

  test('treats a missing file as null rather than an error', async () => {
    const stub = stubFetch([
      route('GET', '/zotero/MISSING1.zip', () => new Response('nope', { status: 404 })),
    ]);
    const client = new WebDavClient({
      url: 'https://dav.example.com',
      ...creds,
      fetch: stub.fetch,
    });

    expect(await client.getZip('MISSING1')).toBeNull();
  });

  test('refuses archives past the size limit', async () => {
    const stub = stubFetch([
      route(
        'GET',
        '/zotero/BIG.zip',
        () => new Response('x', { headers: { 'Content-Length': '99999999' } }),
      ),
    ]);
    const client = new WebDavClient({
      url: 'https://dav.example.com',
      ...creds,
      fetch: stub.fetch,
      maxDownloadBytes: 1024,
    });

    await expect(client.getZip('BIG')).rejects.toBeInstanceOf(WebDavError);
  });

  test('retries transient server errors', async () => {
    let calls = 0;
    const stub = stubFetch([
      route('GET', '/zotero/FLAKY.zip', () => {
        calls++;
        return calls === 1
          ? new Response('busy', { status: 503, headers: { 'Retry-After': '0' } })
          : new Response(new Uint8Array([1, 2, 3]));
      }),
    ]);
    const client = new WebDavClient({
      url: 'https://dav.example.com',
      ...creds,
      fetch: stub.fetch,
    });

    expect(await client.getZip('FLAKY')).toEqual(new Uint8Array([1, 2, 3]));
    expect(calls).toBe(2);
  });

  test('deletes both halves of the pair and tolerates 404s', async () => {
    const stub = stubFetch([
      { match: (r) => r.method === 'DELETE', respond: () => new Response(null, { status: 404 }) },
    ]);
    const client = new WebDavClient({
      url: 'https://dav.example.com',
      ...creds,
      fetch: stub.fetch,
    });

    await client.remove('ABCD1234');

    expect(stub.requests.map((r) => pathOf(r.url))).toEqual([
      '/zotero/ABCD1234.zip',
      '/zotero/ABCD1234.prop',
    ]);
  });
});
