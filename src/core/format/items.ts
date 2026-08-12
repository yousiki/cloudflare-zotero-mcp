import type { ZoteroCollection, ZoteroItem, ZoteroItemData } from '../zotero/types.js';

/**
 * The order the common fields appear in. Everything else the item carries
 * follows alphabetically — Zotero has around a hundred fields across its item
 * types, and a whitelist silently drops whichever ones it forgot: `institution`
 * on a report, `university` on a thesis, `repository` on a preprint. Listing
 * what to *hide* fails safe; listing what to show fails silently.
 */
const PREFERRED_FIELDS = [
  'itemType',
  'title',
  'date',
  'publicationTitle',
  'bookTitle',
  'proceedingsTitle',
  'publisher',
  'place',
  'volume',
  'issue',
  'pages',
  'edition',
  'series',
  'DOI',
  'ISBN',
  'ISSN',
  'url',
  'language',
  'archiveID',
  'callNumber',
  'rights',
  'dateAdded',
  'dateModified',
] as const;

/** Rendered elsewhere in the detail view, or of no use to a reader. */
const FIELDS_SHOWN_ELSEWHERE = new Set([
  'key',
  'version',
  'creators',
  'tags',
  'collections',
  'relations',
  'abstractNote',
  'extra',
  'note',
  'parentItem',
  'deleted',
]);

/** Every field the item actually has, common ones first, then the rest sorted. */
function detailFields(data: ZoteroItemData): string[] {
  const preferred = PREFERRED_FIELDS as readonly string[];
  const rest = Object.keys(data)
    .filter((field) => !preferred.includes(field) && !FIELDS_SHOWN_ELSEWHERE.has(field))
    .sort();
  return [...preferred, ...rest];
}

export function creatorSummary(data: ZoteroItemData): string {
  const creators = data.creators ?? [];
  const names = creators.map((creator) => creator.lastName?.trim() || creator.name?.trim() || '');
  const present = names.filter(Boolean);
  if (present.length === 0) return '';
  if (present.length === 1) return present[0] as string;
  if (present.length === 2) return `${present[0]} & ${present[1]}`;
  return `${present[0]} et al.`;
}

export function yearOf(data: ZoteroItemData): string {
  return String(data.date ?? '').match(/\b(\d{4})\b/)?.[1] ?? '';
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

/** One line per item, dense enough to scan dozens without burning context. */
export function formatItemLine(item: ZoteroItem, score?: number): string {
  const data = item.data;
  const bits: string[] = [];
  const author = creatorSummary(data);
  const year = yearOf(data);
  if (author) bits.push(author);
  if (year) bits.push(year);
  bits.push(String(data.itemType ?? 'item'));
  if (data.publicationTitle) bits.push(truncate(String(data.publicationTitle), 60));

  const title = truncate(String(data.title ?? data.note ?? '(untitled)').replace(/\s+/g, ' '), 160);
  const tail: string[] = [`key: ${item.key}`];
  if (data.DOI) tail.push(`doi: ${data.DOI}`);
  if (item.meta?.numChildren) tail.push(`children: ${item.meta.numChildren}`);
  if (data.deleted) tail.push('in trash');
  if (score !== undefined) tail.push(`score: ${score.toFixed(3)}`);

  return `- **${title}** — ${bits.join(' · ')}\n  ${tail.join(' · ')}`;
}

/** `scores` annotates the lines it has an entry for and leaves the rest alone. */
export function formatItemList(items: ZoteroItem[], scores?: Map<string, number>): string {
  if (items.length === 0) return '_No matching items._';
  return items.map((item) => formatItemLine(item, scores?.get(item.key))).join('\n');
}

export function formatItemDetail(item: ZoteroItem, children: ZoteroItem[] = []): string {
  const data = item.data;
  const lines: string[] = [`# ${data.title ?? '(untitled)'}`, ''];

  lines.push(`- key: ${item.key} (version ${item.version})`);
  for (const field of detailFields(data)) {
    const value = data[field];
    if (value === undefined || value === null || value === '') continue;
    lines.push(`- ${field}: ${value}`);
  }

  const creators = data.creators ?? [];
  if (creators.length > 0) {
    lines.push('- creators:');
    for (const creator of creators) {
      const name = creator.name ?? `${creator.lastName ?? ''}, ${creator.firstName ?? ''}`;
      lines.push(`  - ${creator.creatorType}: ${name.replace(/,\s*$/, '')}`);
    }
  }

  const tags = (data.tags ?? []).map((tag) => tag.tag);
  if (tags.length > 0) lines.push(`- tags: ${tags.join(', ')}`);
  if ((data.collections ?? []).length > 0) {
    lines.push(`- collections: ${(data.collections as string[]).join(', ')}`);
  }
  if (data.extra) lines.push(`- extra: ${data.extra}`);

  if (data.abstractNote) {
    lines.push('', '## Abstract', String(data.abstractNote));
  }

  if (children.length > 0) {
    lines.push('', '## Children');
    for (const child of children) {
      lines.push(`- ${describeChild(child)}`);
    }
  }

  return lines.join('\n');
}

/**
 * The detail counterpart to `itemSummary`.
 *
 * Hosts that understand `structuredContent` render it and drop the text block,
 * so the Markdown from `formatItemDetail` cannot be the only place the abstract
 * and the bibliographic fields appear.
 */
export function itemDetail(item: ZoteroItem): Record<string, unknown> {
  const data = item.data;
  const fields: Record<string, string> = {};
  for (const field of detailFields(data)) {
    const value = data[field];
    if (value === undefined || value === null || value === '') continue;
    fields[field] = String(value);
  }

  return {
    ...itemSummary(item),
    fields,
    creators: (data.creators ?? []).map((creator) => ({
      creatorType: String(creator.creatorType ?? 'author'),
      name: creator.name ?? `${creator.firstName ?? ''} ${creator.lastName ?? ''}`.trim(),
    })),
    abstract: data.abstractNote ? String(data.abstractNote) : null,
    extra: data.extra ? String(data.extra) : null,
  };
}

/** Children carry file details that `itemSummary` has no room for. */
export function childSummary(child: ZoteroItem): Record<string, unknown> {
  const data = child.data;
  const base = itemSummary(child);
  if (data.itemType === 'attachment') {
    return {
      ...base,
      filename: data.filename ?? null,
      contentType: data.contentType ?? null,
      linkMode: data.linkMode ?? null,
      fileUploaded: Boolean(data.md5),
    };
  }
  if (data.itemType === 'note') {
    return { ...base, note: truncate(stripHtml(String(data.note ?? '')), 400) };
  }
  return base;
}

function describeChild(child: ZoteroItem): string {
  const data = child.data;
  if (data.itemType === 'note') {
    return `note ${child.key}: ${truncate(stripHtml(String(data.note ?? '')), 120)}`;
  }
  if (data.itemType === 'attachment') {
    const parts = [
      `attachment ${child.key}`,
      String(data.contentType ?? 'unknown type'),
      String(data.linkMode ?? ''),
    ];
    if (data.filename) parts.push(String(data.filename));
    parts.push(data.md5 ? 'file uploaded' : 'no file uploaded yet');
    return parts.filter(Boolean).join(' · ');
  }
  return `${data.itemType} ${child.key}: ${truncate(String(data.title ?? ''), 100)}`;
}

export function formatAnnotation(item: ZoteroItem): string {
  const data = item.data;
  const bits: string[] = [`- [${data.annotationType ?? 'annotation'}] ${item.key}`];
  if (data.annotationPageLabel) bits.push(`p.${data.annotationPageLabel}`);
  const body: string[] = [];
  if (data.annotationText) body.push(`"${truncate(String(data.annotationText), 500)}"`);
  if (data.annotationComment) body.push(`— ${truncate(String(data.annotationComment), 500)}`);
  const tags = (data.tags ?? []).map((tag) => tag.tag);
  if (tags.length) body.push(`(tags: ${tags.join(', ')})`);
  return `${bits.join(' ')}\n  ${body.join(' ') || '(no text)'}`;
}

/** Renders collections as an indented tree, parents before children. */
export function formatCollectionTree(collections: ZoteroCollection[]): string {
  const byParent = new Map<string, ZoteroCollection[]>();
  for (const collection of collections) {
    const parent = collection.data.parentCollection || 'root';
    const siblings = byParent.get(parent) ?? [];
    siblings.push(collection);
    byParent.set(parent, siblings);
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => a.data.name.localeCompare(b.data.name));
  }

  const lines: string[] = [];
  const walk = (parent: string, depth: number): void => {
    for (const collection of byParent.get(parent) ?? []) {
      const counts: string[] = [];
      if (collection.meta?.numItems) counts.push(`${collection.meta.numItems} items`);
      lines.push(
        `${'  '.repeat(depth)}- ${collection.data.name} (key: ${collection.key}${
          counts.length ? `, ${counts.join(', ')}` : ''
        })`,
      );
      walk(collection.key, depth + 1);
    }
  };
  walk('root', 0);

  // Collections whose parent was not in the result set would otherwise vanish.
  const rendered = new Set(lines.join('\n').match(/key: ([A-Z0-9]{8})/g) ?? []);
  for (const collection of collections) {
    if (!rendered.has(`key: ${collection.key}`)) {
      lines.push(`- ${collection.data.name} (key: ${collection.key})`);
    }
  }

  return lines.length > 0 ? lines.join('\n') : '_No collections._';
}

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Compact JSON payload mirrored into `structuredContent`. */
export function itemSummary(item: ZoteroItem): Record<string, unknown> {
  const data = item.data;
  return {
    key: item.key,
    version: item.version,
    itemType: data.itemType,
    title: data.title ?? null,
    creators: creatorSummary(data) || null,
    year: yearOf(data) || null,
    publication: data.publicationTitle ?? null,
    doi: data.DOI ?? null,
    tags: (data.tags ?? []).map((tag) => tag.tag),
    collections: data.collections ?? [],
    parentItem: typeof data.parentItem === 'string' ? data.parentItem : null,
    numChildren: item.meta?.numChildren ?? null,
  };
}
