import { describe, expect, test } from 'bun:test';
import { detectIdentifier, normalizeIsbn } from '../src/core/sources/identifiers.js';
import { MetadataError, resolveReference } from '../src/core/sources/metadata.js';
import { jsonResponse, route, stubFetch } from './helpers.js';

describe('detectIdentifier', () => {
  test('recognises bare and prefixed DOIs', () => {
    expect(detectIdentifier('10.1145/3708319')).toEqual({ kind: 'doi', value: '10.1145/3708319' });
    expect(detectIdentifier('doi:10.1145/3708319')).toEqual({
      kind: 'doi',
      value: '10.1145/3708319',
    });
    expect(detectIdentifier('https://doi.org/10.1145/3708319')).toEqual({
      kind: 'doi',
      value: '10.1145/3708319',
    });
  });

  test('recognises arXiv ids in every shape', () => {
    for (const input of [
      '1706.03762',
      'arXiv:1706.03762',
      'arxiv:1706.03762v5',
      'https://arxiv.org/abs/1706.03762',
      'https://arxiv.org/pdf/1706.03762v5.pdf',
    ]) {
      expect(detectIdentifier(input), input).toEqual({ kind: 'arxiv', value: '1706.03762' });
    }
    expect(detectIdentifier('math.GT/0309136')).toEqual({
      kind: 'arxiv',
      value: 'math.GT/0309136',
    });
  });

  test('validates ISBN checksums instead of matching digit runs', () => {
    expect(detectIdentifier('978-0-13-235088-4')).toEqual({ kind: 'isbn', value: '9780132350884' });
    expect(normalizeIsbn('9780132350885')).toBeNull();
    expect(normalizeIsbn('0-306-40615-2')).toBe('0306406152');
  });

  test('falls back to url, then to nothing', () => {
    expect(detectIdentifier('https://example.com/paper')).toEqual({
      kind: 'url',
      value: 'https://example.com/paper',
    });
    expect(detectIdentifier('a paper about cats')).toBeNull();
    expect(detectIdentifier('')).toBeNull();
  });
});

describe('resolveReference', () => {
  test('maps a CrossRef work onto Zotero fields', async () => {
    const stub = stubFetch([
      route('GET', '/works/', () =>
        jsonResponse({
          message: {
            type: 'journal-article',
            title: ['A Study of Things'],
            'container-title': ['Journal of Things'],
            author: [{ given: 'Ada', family: 'Lovelace' }],
            editor: [{ given: 'Bob', family: 'Editor' }],
            issued: { 'date-parts': [[2021, 4, 2]] },
            volume: '12',
            issue: '3',
            page: '1-20',
            DOI: '10.1000/Xyz',
            abstract: '<jats:p>An abstract.</jats:p>',
          },
        }),
      ),
      route('GET', '/works/doi:', () => new Response('nope', { status: 404 })),
    ]);

    const reference = await resolveReference(
      { kind: 'doi', value: '10.1000/xyz' },
      { fetch: stub.fetch },
    );

    expect(reference.itemType).toBe('journalArticle');
    expect(reference.title).toBe('A Study of Things');
    expect(reference.fields.publicationTitle).toBe('Journal of Things');
    expect(reference.fields.date).toBe('2021-4-2');
    expect(reference.fields.DOI).toBe('10.1000/xyz');
    expect(reference.fields.abstractNote).toBe('An abstract.');
    expect(reference.creators).toEqual([
      { creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' },
      { creatorType: 'editor', firstName: 'Bob', lastName: 'Editor' },
    ]);
  });

  test('routes conference papers to proceedingsTitle', async () => {
    const stub = stubFetch([
      route('GET', '/works/', () =>
        jsonResponse({
          message: {
            type: 'proceedings-article',
            title: ['Fast Things'],
            'container-title': ['Proceedings of Things'],
            event: { name: 'ThingsConf 2022' },
          },
        }),
      ),
    ]);

    const reference = await resolveReference(
      { kind: 'doi', value: '10.1000/abc' },
      { fetch: stub.fetch },
    );

    expect(reference.itemType).toBe('conferencePaper');
    expect(reference.fields.proceedingsTitle).toBe('Proceedings of Things');
    expect(reference.fields.conferenceName).toBe('ThingsConf 2022');
  });

  test('parses the arXiv Atom feed and points at the PDF', async () => {
    const atom = `<?xml version="1.0"?><feed><entry>
      <title>Attention Is All  You Need</title>
      <summary>  We propose the Transformer.  </summary>
      <published>2017-06-12T00:00:00Z</published>
      <author><name>Ashish Vaswani</name></author>
      <author><name>Noam Shazeer</name></author>
      <category term="cs.CL"/>
    </entry></feed>`;
    const stub = stubFetch([route('GET', '/api/query', () => new Response(atom))]);

    const reference = await resolveReference(
      { kind: 'arxiv', value: '1706.03762' },
      { fetch: stub.fetch },
    );

    expect(reference.itemType).toBe('preprint');
    expect(reference.title).toBe('Attention Is All You Need');
    expect(reference.fields.abstractNote).toBe('We propose the Transformer.');
    expect(reference.fields.archiveID).toBe('arXiv:1706.03762');
    expect(reference.fields.date).toBe('2017-06-12');
    expect(reference.pdfUrl).toBe('https://arxiv.org/pdf/1706.03762');
    expect(reference.creators).toEqual([
      { creatorType: 'author', firstName: 'Ashish', lastName: 'Vaswani' },
      { creatorType: 'author', firstName: 'Noam', lastName: 'Shazeer' },
    ]);
  });

  test('reads an Open Library book', async () => {
    const stub = stubFetch([
      route('GET', '/api/books', () =>
        jsonResponse({
          'ISBN:9780132350884': {
            title: 'Clean Code',
            subtitle: 'A Handbook',
            authors: [{ name: 'Robert C. Martin' }],
            publishers: [{ name: 'Prentice Hall' }],
            publish_date: '2008',
            number_of_pages: 464,
          },
        }),
      ),
    ]);

    const reference = await resolveReference(
      { kind: 'isbn', value: '9780132350884' },
      { fetch: stub.fetch },
    );

    expect(reference.itemType).toBe('book');
    expect(reference.title).toBe('Clean Code: A Handbook');
    expect(reference.fields.publisher).toBe('Prentice Hall');
    expect(reference.fields.numPages).toBe('464');
  });

  test('reports missing records rather than inventing metadata', async () => {
    const stub = stubFetch([route('GET', '/works/', () => new Response('', { status: 404 }))]);
    await expect(
      resolveReference({ kind: 'doi', value: '10.0000/nope' }, { fetch: stub.fetch }),
    ).rejects.toBeInstanceOf(MetadataError);
  });

  test('refuses plain URLs with a usable message', async () => {
    await expect(
      resolveReference({ kind: 'url', value: 'https://example.com' }, {}),
    ).rejects.toThrow(/DOI, arXiv id or ISBN/);
  });
});
