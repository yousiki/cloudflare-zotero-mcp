import { describe, expect, test } from 'bun:test';
import {
  buildRenamedFilename,
  DEFAULT_RENAME_TEMPLATE,
  extensionOf,
  getValidFileName,
  renderTemplate,
} from '../src/core/attachment/rename.js';
import type { ZoteroItemData } from '../src/core/zotero/types.js';

const paper: ZoteroItemData = {
  key: 'AAAA1111',
  version: 3,
  itemType: 'journalArticle',
  title: 'Attention Is All You Need',
  date: '2017-06-12',
  publicationTitle: 'NeurIPS',
  creators: [
    { creatorType: 'author', firstName: 'Ashish', lastName: 'Vaswani' },
    { creatorType: 'author', firstName: 'Noam', lastName: 'Shazeer' },
    { creatorType: 'editor', firstName: 'Some', lastName: 'Editor' },
  ],
  extra: 'Citation Key: vaswani2017attention',
};

describe('renderTemplate', () => {
  test('renders the Zotero default template', () => {
    expect(renderTemplate(DEFAULT_RENAME_TEMPLATE, paper)).toBe(
      'Vaswani and Shazeer - 2017 - Attention Is All You Need',
    );
  });

  test('firstCreator summarises the way Zotero does', () => {
    const authors = (count: number): ZoteroItemData => ({
      ...paper,
      creators: ['Vaswani', 'Shazeer', 'Parmar', 'Uszkoreit']
        .slice(0, count)
        .map((lastName) => ({ creatorType: 'author', lastName })),
    });

    expect(renderTemplate('{{ firstCreator }}', authors(1))).toBe('Vaswani');
    expect(renderTemplate('{{ firstCreator }}', authors(2))).toBe('Vaswani and Shazeer');
    expect(renderTemplate('{{ firstCreator }}', authors(3))).toBe('Vaswani et al.');
    expect(renderTemplate('{{ firstCreator }}', authors(4))).toBe('Vaswani et al.');
  });

  test('firstCreator falls back to editors, then to any creator', () => {
    const editorsOnly: ZoteroItemData = {
      ...paper,
      creators: [
        { creatorType: 'editor', lastName: 'Editor' },
        { creatorType: 'editor', lastName: 'Other' },
      ],
    };
    expect(renderTemplate('{{ firstCreator }}', editorsOnly)).toBe('Editor and Other');

    const directorOnly: ZoteroItemData = {
      ...paper,
      creators: [{ creatorType: 'director', lastName: 'Kurosawa' }],
    };
    expect(renderTemplate('{{ firstCreator }}', directorOnly)).toBe('Kurosawa');
  });

  test("prefers Zotero's own creatorSummary over recomputing it", () => {
    // Zotero knows each item type's primary creator; we only approximate it.
    expect(
      renderTemplate('{{ firstCreator }}', paper, { creatorSummary: 'Vaswani and colleagues' }),
    ).toBe('Vaswani and colleagues');
  });

  test('drops the affixes of empty variables', () => {
    const noAuthor: ZoteroItemData = { ...paper, creators: [] };
    expect(renderTemplate(DEFAULT_RENAME_TEMPLATE, noAuthor)).toBe(
      '2017 - Attention Is All You Need',
    );
  });

  test('joins creator lists and honours start/max', () => {
    expect(renderTemplate('{{ authors join=" & " }}', paper)).toBe('Vaswani & Shazeer');
    expect(renderTemplate('{{ authors start="1" }}', paper)).toBe('Shazeer');
    expect(renderTemplate('{{ editors }}', paper)).toBe('Editor');
  });

  test('truncates and applies case transforms', () => {
    expect(renderTemplate('{{ title truncate="9" }}', paper)).toBe('Attention');
    expect(renderTemplate('{{ title case="snake" }}', paper)).toBe('Attention_Is_All_You_Need');
    expect(renderTemplate('{{ title case="upper" truncate="4" }}', paper)).toBe('ATTE');
  });

  test('reads arbitrary item fields and the citation key', () => {
    expect(renderTemplate('{{ publicationTitle }}', paper)).toBe('NeurIPS');
    expect(renderTemplate('{{ citationKey }}', paper)).toBe('vaswani2017attention');
    expect(renderTemplate('{{ nonexistentField }}', paper)).toBe('');
  });

  test('extracts the year from any date format', () => {
    expect(renderTemplate('{{ year }}', { ...paper, date: 'June 2017' })).toBe('2017');
    expect(renderTemplate('{{ year }}', { ...paper, date: 'n.d.' })).toBe('');
  });

  test('strips HTML from titles', () => {
    expect(renderTemplate('{{ title }}', { ...paper, title: 'A <i>Study</i> of X' })).toBe(
      'A Study of X',
    );
  });
});

describe('getValidFileName', () => {
  test('removes characters filesystems reject', () => {
    expect(getValidFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij');
  });

  test('collapses newlines and trims leading dots', () => {
    expect(getValidFileName('...hidden\nname')).toBe('hidden name');
  });

  test('never returns an empty or dot-only name', () => {
    expect(getValidFileName('...')).toBe('_');
    expect(getValidFileName('')).toBe('_');
  });
});

describe('buildRenamedFilename', () => {
  test('keeps the original extension', () => {
    expect(buildRenamedFilename(paper, 'arXiv-1706.03762v5.pdf')).toBe(
      'Vaswani and Shazeer - 2017 - Attention Is All You Need.pdf',
    );
  });

  test('tolerates files without an extension', () => {
    expect(buildRenamedFilename(paper, 'scan')).toBe(
      'Vaswani and Shazeer - 2017 - Attention Is All You Need',
    );
  });

  test('matches the name Zotero Desktop already gave the file', () => {
    // Regression: a three-author paper must round-trip to the same name, or a
    // bulk rename rewrites every archive in the library to no effect.
    const threeAuthors: ZoteroItemData = {
      ...paper,
      title: 'DrivingDiffusion: Layout-Guided Multi-view Driving Scenarios Video Generation',
      date: '2024',
      creators: [
        { creatorType: 'author', firstName: 'Xiaofan', lastName: 'Li' },
        { creatorType: 'author', firstName: 'Yifu', lastName: 'Zhang' },
        { creatorType: 'author', firstName: 'Xiaoqing', lastName: 'Ye' },
      ],
    };
    const existing =
      'Li et al. - 2024 - DrivingDiffusion Layout-Guided Multi-view Driving Scenarios Video Generation.pdf';
    expect(buildRenamedFilename(threeAuthors, existing)).toBe(existing);
  });

  test('names a brand-new file the way a later rename would leave it', () => {
    // Regression: the import path used to hand-roll `${lastName} - ${year} -
    // ${title}.pdf`, so every freshly imported PDF came out with a name that
    // `zotero_rename_attachments` immediately wanted to change — no "et al.",
    // no character sanitising, and a byte cap that could truncate ".pdf" away.
    const manyAuthors: ZoteroItemData = {
      ...paper,
      title: `Proximal Policy Optimization: ${'Very Long Subtitle '.repeat(12)}`,
      date: '2017',
      creators: ['Schulman', 'Wolski', 'Dhariwal', 'Radford', 'Klimov'].map((lastName) => ({
        creatorType: 'author',
        lastName,
      })),
    };

    const imported = buildRenamedFilename(manyAuthors, 'attachment.pdf');
    expect(imported).toStartWith('Schulman et al. - 2017 - Proximal Policy Optimization ');
    expect(imported).toEndWith('.pdf');
    // The colon is illegal on Windows and Zotero itself drops it.
    expect(imported).not.toContain(':');
    // Whatever the file is called, renaming it again must be a no-op.
    expect(buildRenamedFilename(manyAuthors, imported)).toBe(imported);
  });

  test('extensionOf ignores things that are not extensions', () => {
    expect(extensionOf('report.final.pdf')).toBe('pdf');
    expect(extensionOf('no-extension')).toBe('');
    expect(extensionOf('trailing.')).toBe('');
    expect(extensionOf('v1.2.3-notanext')).toBe('');
  });
});
