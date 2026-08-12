import { describe, expect, test } from 'bun:test';
import type { ZoteroItem } from '../src/core/zotero/types.js';
import { groupDuplicates } from '../src/tools/maintenance.js';

function item(key: string, data: Record<string, unknown>): ZoteroItem {
  return {
    key,
    version: 1,
    library: { type: 'user', id: 1, name: 'me' },
    data: { key, version: 1, itemType: 'journalArticle', ...data },
  };
}

describe('groupDuplicates', () => {
  test('groups on DOI regardless of case or trailing punctuation', () => {
    const groups = groupDuplicates([
      item('A', { DOI: '10.1000/XYZ', title: 'One' }),
      item('B', { DOI: '10.1000/xyz', title: 'One, again' }),
      item('C', { DOI: '10.1000/other', title: 'Other' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.reason).toBe('DOI');
    expect(groups[0]?.items.map((entry) => entry.key).sort()).toEqual(['A', 'B']);
  });

  test('groups on ISBN with punctuation stripped', () => {
    const groups = groupDuplicates([
      item('A', { itemType: 'book', ISBN: '978-0-13-235088-4', title: 'Clean Code' }),
      item('B', { itemType: 'book', ISBN: '9780132350884', title: 'Clean Code' }),
    ]);

    expect(groups[0]?.reason).toBe('ISBN');
  });

  test('falls back to title and year, ignoring case and punctuation', () => {
    const groups = groupDuplicates([
      item('A', { title: 'Attention Is All You Need!', date: '2017-06-12' }),
      item('B', { title: 'attention is all  you need', date: 'June 2017' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.reason).toBe('title+year');
  });

  test('does not merge same-title items from different years', () => {
    const groups = groupDuplicates([
      item('A', { title: 'Annual Report of Things', date: '2020' }),
      item('B', { title: 'Annual Report of Things', date: '2021' }),
    ]);

    expect(groups).toHaveLength(0);
  });

  test('never lets a title match override a DOI match', () => {
    // Same title, different DOIs: an erratum and the original, say.
    const groups = groupDuplicates([
      item('A', { title: 'A Study of Things', date: '2020', DOI: '10.1/a' }),
      item('B', { title: 'A Study of Things', date: '2020', DOI: '10.1/b' }),
    ]);

    expect(groups).toHaveLength(0);
  });

  test('ignores titles too short to be distinctive', () => {
    const groups = groupDuplicates([item('A', { title: 'Notes' }), item('B', { title: 'Notes' })]);
    expect(groups).toHaveLength(0);
  });
});
