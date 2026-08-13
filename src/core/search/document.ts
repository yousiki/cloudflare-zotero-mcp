import type { ZoteroItem, ZoteroItemData } from '../zotero/types.js';

/** Item types that are never worth indexing on their own. */
const SKIPPED_TYPES: Record<string, true> = {
  attachment: true,
  annotation: true,
  note: true,
};

export function isIndexable(item: ZoteroItem): boolean {
  return !SKIPPED_TYPES[String(item.data.itemType)] && !item.data.deleted;
}

/**
 * The text that gets indexed. Abstracts dominate the signal, but title, venue
 * and tags matter for short queries, so everything goes in one passage and the
 * backend decides where to split it.
 */
export function documentText(data: ZoteroItemData): string {
  const creators = (data.creators ?? [])
    .map((creator) => creator.lastName ?? creator.name ?? '')
    .filter(Boolean)
    .slice(0, 8)
    .join(', ');
  const tags = (data.tags ?? []).map((tag) => tag.tag).join(', ');

  return [
    data.title ?? '',
    creators,
    String(data.date ?? '').match(/\d{4}/)?.[0] ?? '',
    data.publicationTitle ?? data.bookTitle ?? data.proceedingsTitle ?? data.publisher ?? '',
    tags,
    String(data.abstractNote ?? '').slice(0, 4000),
  ]
    .filter((part) => String(part).trim().length > 0)
    .join('\n')
    .slice(0, 6000);
}

/**
 * Only what the search backend can push down. AI Search allows five custom
 * metadata fields per instance and has no array type, so tags and collection
 * membership cannot live here — they are enforced by the Zotero lookup that
 * fetches the matched items anyway.
 *
 * Field names are stored lowercase and matched case-insensitively, so the keys
 * here are lowercase to match the filters built against them.
 *
 * Every value is a string, including `year`. The upload API takes
 * `Record<string, string>` and parses a `number` field to float on its side; a
 * real number goes out as `invalid_metadata_format` and the upload is rejected,
 * which shows up as an instance that exists and indexes nothing at all.
 */
export function documentMetadata(item: ZoteroItem): Record<string, string> {
  return {
    itemtype: String(item.data.itemType ?? ''),
    year: String(Number(String(item.data.date ?? '').match(/\d{4}/)?.[0] ?? 0)),
  };
}

/**
 * Documents are keyed by Zotero item key. `upload` is an upsert on this name,
 * so a changed item overwrites its own document instead of accumulating copies.
 * The `.md` suffix is what makes AI Search treat the payload as text.
 */
export function documentName(itemKey: string): string {
  return `${itemKey}.md`;
}

export function itemKeyOf(documentName: string): string {
  return documentName.replace(/\.md$/, '');
}
