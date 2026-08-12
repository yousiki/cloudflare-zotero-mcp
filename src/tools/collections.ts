import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { assertWritable, type ZoteroMcpContext } from '../context.js';
import { formatCollectionTree, formatItemList, itemSummary } from '../core/format/items.js';
import {
  assertNoFailures,
  itemSummarySchema,
  objectKey,
  summarizeWrite,
  textResult,
} from './common.js';

export function registerCollectionTools(server: McpServer, context: ZoteroMcpContext): void {
  server.registerTool(
    'zotero_list_collections',
    {
      title: 'Browse collections',
      description:
        'List the collection tree, search collections by name, or list the items inside one collection.',
      inputSchema: z.object({
        collectionKey: objectKey
          .optional()
          .describe('When set, lists the items in this collection.'),
        query: z
          .string()
          .optional()
          .describe('Case-insensitive substring filter on collection names.'),
        topOnly: z
          .boolean()
          .default(false)
          .describe('For item listings, exclude child items such as attachments and notes.'),
        limit: z.number().int().min(1).max(100).default(50),
      }),
      outputSchema: z.object({
        collections: z.array(z.looseObject({ key: z.string(), name: z.string() })).optional(),
        items: z.array(itemSummarySchema).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ collectionKey, query, topOnly, limit }) => {
      if (collectionKey) {
        const collection = await context.zotero.getCollection(collectionKey);
        const page = await context.zotero.getCollectionItems(collectionKey, {}, limit, topOnly);
        return textResult(`# ${collection.data.name}\n\n${formatItemList(page.items)}`, {
          items: page.items.map(itemSummary),
        });
      }

      const page = await context.zotero.getCollections({}, 500);
      const needle = query?.toLowerCase();
      const matching = needle
        ? page.items.filter((collection) => collection.data.name.toLowerCase().includes(needle))
        : page.items;

      const text = needle
        ? matching.length > 0
          ? matching
              .map(
                (collection) =>
                  `- ${collection.data.name} (key: ${collection.key}${
                    collection.data.parentCollection
                      ? `, parent: ${collection.data.parentCollection}`
                      : ''
                  })`,
              )
              .join('\n')
          : `_No collection name contains "${query}"._`
        : formatCollectionTree(matching);

      return textResult(text, {
        collections: matching.map((collection) => ({
          key: collection.key,
          name: collection.data.name,
          parentCollection: collection.data.parentCollection || null,
          numItems: collection.meta?.numItems ?? null,
        })),
      });
    },
  );

  server.registerTool(
    'zotero_manage_collections',
    {
      title: 'Create, rename, delete collections and move items',
      description:
        'Collection maintenance. Deleting a collection does not delete the items inside it, but does delete its subcollections.',
      inputSchema: z.object({
        action: z.enum(['create', 'rename', 'delete', 'addItems', 'removeItems']),
        name: z.string().optional().describe('Required for create and rename.'),
        parentCollection: objectKey.optional().describe('Parent for create.'),
        collectionKey: objectKey
          .optional()
          .describe('Target for rename, delete, addItems, removeItems.'),
        itemKeys: z.array(objectKey).max(50).optional(),
      }),
      outputSchema: z.object({
        action: z.string(),
        collectionKey: z.string().optional(),
        affected: z.array(z.string()).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ action, name, parentCollection, collectionKey, itemKeys }) => {
      assertWritable(context);

      switch (action) {
        case 'create': {
          if (!name) throw new Error('create needs a name.');
          const payload: Record<string, unknown> = { name };
          if (parentCollection) payload.parentCollection = parentCollection;
          const response = await context.zotero.writeObjects('collections', [payload]);
          const summary = summarizeWrite(response, [{ label: name }]);
          assertNoFailures(summary.failures, 'creating the collection');
          const key = summary.created[0] as string;
          return textResult(`Created collection "${name}" (key: ${key})`, {
            action,
            collectionKey: key,
          });
        }

        case 'rename': {
          if (!collectionKey || !name) throw new Error('rename needs collectionKey and name.');
          const collection = await context.zotero.getCollection(collectionKey);
          await context.zotero.patchCollection(collectionKey, { name }, collection.version);
          return textResult(`Renamed ${collectionKey} to "${name}"`, { action, collectionKey });
        }

        case 'delete': {
          if (!collectionKey) throw new Error('delete needs collectionKey.');
          const collection = await context.zotero.getCollection(collectionKey);
          await context.zotero.deleteCollection(collectionKey, collection.version);
          return textResult(
            `Deleted collection "${collection.data.name}" (${collectionKey}). Items it held remain in the library.`,
            { action, collectionKey },
          );
        }

        case 'addItems':
        case 'removeItems': {
          if (!collectionKey || !itemKeys?.length) {
            throw new Error(`${action} needs collectionKey and itemKeys.`);
          }
          const payloads: Array<Record<string, unknown>> = [];
          for (const key of itemKeys) {
            const item = await context.zotero.getItem(key);
            const current = item.data.collections ?? [];
            const next =
              action === 'addItems'
                ? current.includes(collectionKey)
                  ? current
                  : [...current, collectionKey]
                : current.filter((entry) => entry !== collectionKey);
            payloads.push({ key, version: item.version, collections: next });
          }
          const response = await context.zotero.writeObjects('items', payloads);
          const summary = summarizeWrite(
            response,
            itemKeys.map((key) => ({ label: key })),
          );
          assertNoFailures(summary.failures, `${action} on ${collectionKey}`);
          return textResult(
            `${action === 'addItems' ? 'Added' : 'Removed'} ${itemKeys.length} item(s) ${
              action === 'addItems' ? 'to' : 'from'
            } ${collectionKey}`,
            { action, collectionKey, affected: itemKeys },
          );
        }
      }
    },
  );

  server.registerTool(
    'zotero_list_tags',
    {
      title: 'List tags',
      description:
        'All tags in the library, optionally filtered, with item counts where available.',
      inputSchema: z.object({
        query: z.string().optional().describe('Substring filter, matched server-side.'),
        limit: z.number().int().min(1).max(500).default(200),
      }),
      outputSchema: z.object({ tags: z.array(z.string()) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const page = await context.zotero.getTags(
        query ? { q: query, qmode: 'contains' } : {},
        limit,
      );
      const names = page.items.map((entry) => entry.tag);
      const text =
        names.length === 0
          ? '_No tags._'
          : page.items
              .map((entry) =>
                entry.meta?.numItems ? `- ${entry.tag} (${entry.meta.numItems})` : `- ${entry.tag}`,
              )
              .join('\n');
      return textResult(text, { tags: names });
    },
  );
}
