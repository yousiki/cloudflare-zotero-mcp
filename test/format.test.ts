import { describe, expect, test } from 'bun:test';
import { formatItemDetail, itemDetail } from '../src/core/format/items.js';
import type { ZoteroItem } from '../src/core/zotero/types.js';

function item(data: Record<string, unknown>): ZoteroItem {
  return {
    key: 'AAAA1111',
    version: 4,
    library: { type: 'user', id: 1, name: 'me' },
    meta: {},
    data: { key: 'AAAA1111', version: 4, ...data },
  } as ZoteroItem;
}

describe('itemDetail', () => {
  test('carries the type-specific fields, not just the common ones', () => {
    // Regression: `fields` came from a hardcoded whitelist of 23 names, so every
    // field that only exists on one item type — `institution` on a report,
    // `university` on a thesis, `repository` on a preprint — was silently
    // dropped from the structured payload the model actually reads.
    const report = itemDetail(
      item({
        itemType: 'report',
        title: 'Write path verification',
        institution: 'Test Bench',
        reportNumber: '2026-01',
        reportType: 'Technical report',
      }),
    );
    const fields = report.fields as Record<string, string>;
    expect(fields.institution).toBe('Test Bench');
    expect(fields.reportNumber).toBe('2026-01');
    expect(fields.reportType).toBe('Technical report');

    const thesis = itemDetail(
      item({ itemType: 'thesis', title: 'A Thesis', university: 'Somewhere', numPages: '210' }),
    );
    expect((thesis.fields as Record<string, string>).university).toBe('Somewhere');

    const preprint = itemDetail(
      item({ itemType: 'preprint', title: 'A Preprint', repository: 'arXiv' }),
    );
    expect((preprint.fields as Record<string, string>).repository).toBe('arXiv');
  });

  test('leaves out what the rest of the payload already says', () => {
    const detail = itemDetail(
      item({
        itemType: 'journalArticle',
        title: 'Attention Is All You Need',
        abstractNote: 'We propose the Transformer.',
        extra: 'Citation Key: vaswani2017attention',
        creators: [{ creatorType: 'author', lastName: 'Vaswani' }],
        tags: [{ tag: 'transformers' }],
        collections: ['COLL0001'],
      }),
    );
    const fields = detail.fields as Record<string, string>;

    expect(detail.abstract).toBe('We propose the Transformer.');
    expect(detail.extra).toBe('Citation Key: vaswani2017attention');
    // Objects and arrays would stringify to "[object Object]" here.
    for (const field of ['key', 'version', 'creators', 'tags', 'collections', 'abstractNote']) {
      expect(fields[field], `${field} should not be duplicated into fields`).toBeUndefined();
    }
  });

  test('orders the common fields before the type-specific ones', () => {
    const detail = itemDetail(
      item({ itemType: 'report', institution: 'Test Bench', title: 'T', date: '2026' }),
    );
    expect(Object.keys(detail.fields as Record<string, string>)).toEqual([
      'itemType',
      'title',
      'date',
      'institution',
    ]);
  });
});

describe('formatItemDetail', () => {
  test('renders the type-specific fields too', () => {
    const markdown = formatItemDetail(
      item({ itemType: 'report', title: 'Write path verification', institution: 'Test Bench' }),
    );
    expect(markdown).toContain('- institution: Test Bench');
  });
});
