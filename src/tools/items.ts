import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { assertWritable, type ZoteroMcpContext } from '../context.js';
import { childSummary, formatItemDetail, itemDetail } from '../core/format/items.js';
import type { ZoteroItemData, ZoteroTag } from '../core/zotero/types.js';
import {
  assertNoFailures,
  creatorSchema,
  itemDetailSchema,
  itemSummarySchema,
  objectKey,
  summarizeWrite,
  tagSchema,
  textResult,
} from './common.js';

export function registerItemTools(server: McpServer, context: ZoteroMcpContext): void {
  registerGetItem(server, context);
  registerCreateItems(server, context);
  registerUpdateItem(server, context);
  registerDeleteItems(server, context);
}

/* -------------------------------------------------------------------------- */

function registerGetItem(server: McpServer, context: ZoteroMcpContext): void {
  server.registerTool(
    'zotero_get_item',
    {
      title: 'Read one item',
      description:
        'Full metadata for an item, optionally with its children (attachments and notes) and an export format such as BibTeX.',
      inputSchema: z.object({
        key: objectKey,
        includeChildren: z.boolean().default(false),
        exportFormat: z
          .enum(['bibtex', 'biblatex', 'csljson', 'ris', 'bib'])
          .optional()
          .describe('"bib" renders a formatted bibliography entry using `style`.'),
        style: z.string().optional().describe('CSL style name for exportFormat "bib".'),
      }),
      outputSchema: z.object({
        item: itemDetailSchema,
        children: z.array(itemSummarySchema).optional(),
        export: z.string().optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ key, includeChildren, exportFormat, style }) => {
      const item = await context.zotero.getItem(key);
      const children = includeChildren ? await context.zotero.getItemChildren(key) : [];

      let exported: string | undefined;
      if (exportFormat) {
        exported = await context.zotero.exportItems([key], exportFormat, style);
      }

      const text = [
        formatItemDetail(item, children),
        exported ? `\n## ${exportFormat}\n\n\`\`\`\n${exported.trim()}\n\`\`\`` : '',
      ]
        .filter(Boolean)
        .join('\n');

      return textResult(text, {
        item: itemDetail(item),
        ...(includeChildren ? { children: children.map(childSummary) } : {}),
        ...(exported ? { export: exported } : {}),
      });
    },
  );
}

/* -------------------------------------------------------------------------- */

const newItemSchema = z.object({
  itemType: z.string().describe('e.g. journalArticle, book, bookSection, preprint, report'),
  title: z.string().optional(),
  creators: z.array(creatorSchema).optional(),
  tags: z.array(tagSchema).optional(),
  collections: z.array(objectKey).optional(),
  parentItem: objectKey.optional().describe('Set to attach this item as a child.'),
  fields: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe('Any other Zotero field: date, DOI, abstractNote, publicationTitle, extra, …'),
});

function registerCreateItems(server: McpServer, context: ZoteroMcpContext): void {
  server.registerTool(
    'zotero_create_items',
    {
      title: 'Create items',
      description:
        'Create one or more Zotero items. Each item starts from the server template for its type, so only the fields you set are populated.',
      inputSchema: z.object({ items: z.array(newItemSchema).min(1).max(50) }),
      outputSchema: z.object({
        created: z.array(z.string()),
        unchanged: z.array(z.string()),
        failed: z.array(z.string()),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ items }) => {
      assertWritable(context);

      const templates = new Map<string, ZoteroItemData>();
      const payloads: Array<Record<string, unknown>> = [];

      for (const input of items) {
        if (!templates.has(input.itemType)) {
          templates.set(input.itemType, await context.zotero.getTemplate(input.itemType));
        }
        const template = templates.get(input.itemType) as ZoteroItemData;
        const payload: Record<string, unknown> = { ...template, itemType: input.itemType };
        if (input.title !== undefined) payload.title = input.title;
        if (input.creators) payload.creators = input.creators;
        if (input.tags) payload.tags = input.tags;
        if (input.collections) payload.collections = input.collections;
        if (input.parentItem) payload.parentItem = input.parentItem;
        for (const [field, value] of Object.entries(input.fields ?? {})) payload[field] = value;
        payloads.push(payload);
      }

      const response = await context.zotero.writeObjects('items', payloads);
      const summary = summarizeWrite(
        response,
        items.map((item) => ({ label: item.title ?? item.itemType })),
      );

      const lines = [
        `Created ${summary.created.length} item(s): ${summary.created.join(', ') || '(none)'}`,
      ];
      if (summary.failures.length > 0) lines.push('', 'Failures:', ...summary.failures);

      return textResult(lines.join('\n'), {
        created: summary.created,
        unchanged: summary.unchanged,
        failed: summary.failures,
      });
    },
  );
}

/* -------------------------------------------------------------------------- */

function registerUpdateItem(server: McpServer, context: ZoteroMcpContext): void {
  server.registerTool(
    'zotero_update_item',
    {
      title: 'Update items',
      description:
        'Patch fields, tags, creators or collection membership on one or more items. Tag and collection edits are incremental unless you use the set* variants.',
      inputSchema: z.object({
        keys: z.array(objectKey).min(1).max(50),
        fields: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .optional()
          .describe('Field values to set. null clears a field.'),
        creators: z.array(creatorSchema).optional().describe('Replaces the whole creators list.'),
        addTags: z.array(z.string()).optional(),
        removeTags: z.array(z.string()).optional(),
        setTags: z.array(z.string()).optional().describe('Replaces every tag on the item.'),
        addCollections: z.array(objectKey).optional(),
        removeCollections: z.array(objectKey).optional(),
        setCollections: z.array(objectKey).optional(),
      }),
      outputSchema: z.object({
        updated: z.array(z.string()),
        skipped: z.array(z.string()),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      assertWritable(context);
      if (input.setTags && (input.addTags || input.removeTags)) {
        throw new Error(
          'setTags replaces every tag, so it cannot be combined with addTags/removeTags.',
        );
      }
      if (input.setCollections && (input.addCollections || input.removeCollections)) {
        throw new Error(
          'setCollections replaces membership, so it cannot be combined with addCollections/removeCollections.',
        );
      }

      const updated: string[] = [];
      const skipped: string[] = [];

      for (const key of input.keys) {
        const item = await context.zotero.getItem(key);
        const patch: Record<string, unknown> = {};

        for (const [field, value] of Object.entries(input.fields ?? {})) {
          patch[field] = value === null ? '' : value;
        }
        if (input.creators) patch.creators = input.creators;

        const tags = nextTags(item.data.tags ?? [], input);
        if (tags) patch.tags = tags;

        const collections = nextCollections(item.data.collections ?? [], input);
        if (collections) patch.collections = collections;

        if (Object.keys(patch).length === 0) {
          skipped.push(`${key} (nothing to change)`);
          continue;
        }

        await context.zotero.patchItem(key, patch, item.version);
        updated.push(key);
      }

      const lines = [`Updated ${updated.length} item(s): ${updated.join(', ') || '(none)'}`];
      if (skipped.length > 0) lines.push(`Skipped: ${skipped.join(', ')}`);
      return textResult(lines.join('\n'), { updated, skipped });
    },
  );
}

interface TagEdits {
  addTags?: string[];
  removeTags?: string[];
  setTags?: string[];
}

function nextTags(current: ZoteroTag[], edits: TagEdits): ZoteroTag[] | null {
  if (edits.setTags) return edits.setTags.map((tag) => ({ tag }));
  if (!edits.addTags && !edits.removeTags) return null;

  const removals = new Set(edits.removeTags ?? []);
  const kept = current.filter((entry) => !removals.has(entry.tag));
  const existing = new Set(kept.map((entry) => entry.tag));
  for (const tag of edits.addTags ?? []) {
    if (!existing.has(tag)) {
      kept.push({ tag });
      existing.add(tag);
    }
  }
  return kept;
}

interface CollectionEdits {
  addCollections?: string[];
  removeCollections?: string[];
  setCollections?: string[];
}

function nextCollections(current: string[], edits: CollectionEdits): string[] | null {
  if (edits.setCollections) return edits.setCollections;
  if (!edits.addCollections && !edits.removeCollections) return null;

  const removals = new Set(edits.removeCollections ?? []);
  const next = current.filter((key) => !removals.has(key));
  for (const key of edits.addCollections ?? []) {
    if (!next.includes(key)) next.push(key);
  }
  return next;
}

/* -------------------------------------------------------------------------- */

function registerDeleteItems(server: McpServer, context: ZoteroMcpContext): void {
  server.registerTool(
    'zotero_delete_items',
    {
      title: 'Delete items',
      description:
        'Move items to the Zotero trash (recoverable), or delete them permanently with permanent=true.',
      inputSchema: z.object({
        keys: z.array(objectKey).min(1).max(50),
        permanent: z
          .boolean()
          .default(false)
          .describe('true bypasses the trash and cannot be undone.'),
      }),
      outputSchema: z.object({ deleted: z.array(z.string()), permanent: z.boolean() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ keys, permanent }) => {
      assertWritable(context);

      if (permanent) {
        // One request per key, each locked against that key's own version. The
        // batch endpoint locks against the library version instead, so a single
        // unrelated write anywhere in the library — including the previous key
        // in this very loop — would 412 the rest.
        const deleted: string[] = [];
        for (const key of keys) {
          const item = await context.zotero.getItem(key);
          await context.zotero.deleteItem(key, item.version).catch((error) => {
            throw new Error(
              `Deleted ${deleted.length} of ${keys.length} item(s) before ${key} failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
          deleted.push(key);
        }
        return textResult(`Permanently deleted ${deleted.length} item(s): ${deleted.join(', ')}`, {
          deleted,
          permanent: true,
        });
      }

      const payloads: Array<Record<string, unknown>> = [];
      for (const key of keys) {
        const item = await context.zotero.getItem(key);
        payloads.push({ key, version: item.version, deleted: 1 });
      }
      const response = await context.zotero.writeObjects('items', payloads);
      const summary = summarizeWrite(
        response,
        keys.map((key) => ({ label: key })),
      );
      assertNoFailures(summary.failures, 'moving items to the trash');

      return textResult(`Moved ${keys.length} item(s) to the trash: ${keys.join(', ')}`, {
        deleted: keys,
        permanent: false,
      });
    },
  );
}
