import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { assertWritable, type ZoteroMcpContext } from '../context.js';
import { yearOf } from '../core/format/items.js';
import { normalizeDoi } from '../core/sources/identifiers.js';
import type { ZoteroItem } from '../core/zotero/types.js';
import { syncSemanticIndex } from '../jobs/index-sync.js';
import { objectKey, textResult } from './common.js';

/** Child types that follow an item when duplicates are merged. */
const CHILD_TYPES = new Set(['attachment', 'note']);

export function registerMaintenanceTools(server: McpServer, context: ZoteroMcpContext): void {
  server.registerTool(
    'zotero_reindex',
    {
      title: 'Rebuild the semantic search index',
      description:
        'Bring the index behind zotero_semantic_search in step with the library. Runs incrementally; pass full=true to re-submit everything. A scheduled job does this every six hours, so this is for the first run or after a reset. Indexing is asynchronous: complete=true means every change was submitted, and backlog is what is still being processed.',
      inputSchema: z.object({
        full: z
          .boolean()
          .default(false)
          .describe('Ignore the cursor and re-submit the whole library.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe('Cap on items submitted in this call. Anything left over is queued.'),
      }),
      outputSchema: z.object({
        submitted: z.number().describe('Items sent to the index in this run.'),
        removed: z.number(),
        remaining: z.number().describe('Changed items left for the next run.'),
        backlog: z
          .number()
          .nullable()
          .describe(
            'Items accepted but not yet searchable. Null means this could not be determined — not the same as zero.',
          ),
        failed: z.number().nullable().describe('Items the index rejected. Null when unknown.'),
        complete: z.boolean().describe('Every change submitted — not the same as indexed.'),
        warning: z
          .string()
          .nullable()
          .describe(
            'A configuration problem this run could not fix, or null. A sync can finish cleanly and still be writing into a misconfigured index.',
          ),
        message: z.string(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ full, limit }) => {
      assertWritable(context);
      const report = await syncSemanticIndex({
        zotero: context.zotero,
        index: context.semantic,
        store: context.store,
        full,
        limit,
      });
      return textResult(
        [
          report.message,
          `- submitted: ${report.submitted}`,
          `- removed: ${report.removed}`,
          `- still queued locally: ${report.remaining}`,
          `- indexing backlog: ${report.backlog ?? 'unknown'}`,
          report.failed === null || report.failed > 0
            ? `- failed to index: ${report.failed ?? 'unknown'}`
            : '',
          report.complete ? '' : '- call again to continue',
          report.warning ? `\n> ${report.warning}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        {
          submitted: report.submitted,
          removed: report.removed,
          remaining: report.remaining,
          backlog: report.backlog,
          failed: report.failed,
          complete: report.complete,
          warning: report.warning,
          message: report.message,
        },
      );
    },
  );

  server.registerTool(
    'zotero_find_duplicates',
    {
      title: 'Find and merge duplicate items',
      description:
        'Group items that share a DOI, ISBN or title+year. With merge=true the richest copy is kept, children and collections move onto it, and the others go to the trash.',
      inputSchema: z.object({
        collectionKey: objectKey.optional().describe('Restrict the scan to one collection.'),
        itemType: z.string().optional().describe('Restrict the scan to one item type.'),
        scanLimit: z
          .number()
          .int()
          .min(10)
          .max(2000)
          .default(500)
          .describe('How many items to examine.'),
        merge: z.boolean().default(false),
        mergeKeys: z
          .array(objectKey)
          .max(20)
          .optional()
          .describe('Merge only these keys, treating the first as the item to keep.'),
      }),
      outputSchema: z.object({
        scanned: z.number(),
        groups: z.array(
          z.object({
            reason: z.string(),
            keys: z.array(z.string()),
            titles: z.array(z.string()),
            merged: z.boolean(),
          }),
        ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ collectionKey, itemType, scanLimit, merge, mergeKeys }) => {
      if (merge) assertWritable(context);

      if (mergeKeys?.length) {
        const items = await Promise.all(mergeKeys.map((key) => context.zotero.getItem(key)));
        const [master, ...duplicates] = items as [ZoteroItem, ...ZoteroItem[]];
        await mergeGroup(context, master, duplicates);
        return textResult(
          `Merged ${duplicates.length} item(s) into ${master.key}: ${duplicates
            .map((item) => item.key)
            .join(', ')}`,
          {
            scanned: items.length,
            groups: [
              {
                reason: 'explicit',
                keys: mergeKeys,
                titles: items.map((item) => String(item.data.title ?? '')),
                merged: true,
              },
            ],
          },
        );
      }

      const page = collectionKey
        ? await context.zotero.getCollectionItems(collectionKey, { itemType }, scanLimit, true)
        : await context.zotero.getTopItems({ itemType }, scanLimit);

      const candidates = page.items.filter(
        (item) => !CHILD_TYPES.has(String(item.data.itemType)) && !item.data.deleted,
      );
      const groups = groupDuplicates(candidates);

      const report: Array<{ reason: string; keys: string[]; titles: string[]; merged: boolean }> =
        [];
      for (const group of groups) {
        const ordered = [...group.items].sort(byRichness);
        const [master, ...duplicates] = ordered as [ZoteroItem, ...ZoteroItem[]];
        if (merge) await mergeGroup(context, master, duplicates);
        report.push({
          reason: group.reason,
          keys: ordered.map((item) => item.key),
          titles: ordered.map((item) => String(item.data.title ?? '')),
          merged: merge,
        });
      }

      const lines =
        report.length === 0
          ? [`Scanned ${candidates.length} items; no duplicates found.`]
          : [
              `Scanned ${candidates.length} items and found ${report.length} duplicate group(s)${
                merge ? ', all merged' : ''
              }.`,
              '',
              ...report.map((group) => {
                const [keep, ...rest] = group.keys;
                return [
                  `- match on ${group.reason}: ${group.titles[0]}`,
                  `  keep: ${keep}`,
                  `  ${merge ? 'trashed' : 'duplicates'}: ${rest.join(', ')}`,
                ].join('\n');
              }),
              '',
              merge ? '' : 'Re-run with merge=true to apply, or pass mergeKeys to merge one group.',
            ];

      return textResult(lines.filter(Boolean).join('\n'), {
        scanned: candidates.length,
        groups: report,
      });
    },
  );
}

interface DuplicateGroup {
  reason: string;
  items: ZoteroItem[];
}

export function groupDuplicates(items: ZoteroItem[]): DuplicateGroup[] {
  const buckets = new Map<string, { reason: string; items: ZoteroItem[] }>();

  for (const item of items) {
    for (const [reason, value] of fingerprints(item)) {
      const bucketKey = `${reason}:${value}`;
      const bucket = buckets.get(bucketKey) ?? { reason, items: [] };
      bucket.items.push(item);
      buckets.set(bucketKey, bucket);
      // One fingerprint is enough; DOI beats title, so stop at the strongest.
      break;
    }
  }

  return [...buckets.values()].filter((bucket) => bucket.items.length > 1);
}

/** Strongest signal first, so a DOI match never degrades into a title match. */
function fingerprints(item: ZoteroItem): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const doi = item.data.DOI ? normalizeDoi(String(item.data.DOI)) : '';
  if (doi) out.push(['DOI', doi]);

  const isbn = String(item.data.ISBN ?? '').replace(/[\s-]/g, '');
  if (isbn) out.push(['ISBN', isbn]);

  const title = normalizeTitle(String(item.data.title ?? ''));
  if (title.length >= 12) out.push(['title+year', `${title}|${yearOf(item.data)}`]);

  return out;
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The copy with the most filled fields and children is the one worth keeping. */
function byRichness(a: ZoteroItem, b: ZoteroItem): number {
  const score = (item: ZoteroItem): number =>
    Object.values(item.data).filter(
      (value) => value !== '' && value !== null && value !== undefined,
    ).length +
    (item.meta?.numChildren ?? 0) * 3;
  const difference = score(b) - score(a);
  if (difference !== 0) return difference;
  // Tie-break on age so the result is stable across runs.
  return String(a.data.dateAdded ?? '').localeCompare(String(b.data.dateAdded ?? ''));
}

async function mergeGroup(
  context: ZoteroMcpContext,
  master: ZoteroItem,
  duplicates: ZoteroItem[],
): Promise<void> {
  if (duplicates.length === 0) return;

  const libraryId = await context.zotero.resolveLibraryId();
  const tags = new Map((master.data.tags ?? []).map((tag) => [tag.tag, tag]));
  const collections = new Set(master.data.collections ?? []);
  const replaces = new Set(toArray(master.data.relations?.['dc:replaces']));

  for (const duplicate of duplicates) {
    for (const tag of duplicate.data.tags ?? []) tags.set(tag.tag, tag);
    for (const collection of duplicate.data.collections ?? []) collections.add(collection);
    replaces.add(`http://zotero.org/users/${libraryId}/items/${duplicate.key}`);

    // Re-parent children one at a time: each needs its own version guard.
    for (const child of await context.zotero.getItemChildren(duplicate.key)) {
      if (!CHILD_TYPES.has(String(child.data.itemType))) continue;
      await context.zotero.patchItem(child.key, { parentItem: master.key }, child.version);
    }
  }

  await context.zotero.patchItem(
    master.key,
    {
      tags: [...tags.values()],
      collections: [...collections],
      relations: { ...(master.data.relations ?? {}), 'dc:replaces': [...replaces] },
    },
    master.version,
  );

  for (const duplicate of duplicates) {
    const fresh = await context.zotero.getItem(duplicate.key);
    await context.zotero.patchItem(duplicate.key, { deleted: 1 }, fresh.version);
  }
}

function toArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}
