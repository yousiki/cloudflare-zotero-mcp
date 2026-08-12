import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { assertWritable, type ZoteroMcpContext } from '../context.js';
import { formatAnnotation, stripHtml, truncate } from '../core/format/items.js';
import { locateText, pagePoint } from '../core/pdf/locate.js';
import type { ZoteroItem } from '../core/zotero/types.js';
import { assertNoFailures, objectKey, summarizeWrite, tagSchema, textResult } from './common.js';

export function registerNoteTools(server: McpServer, context: ZoteroMcpContext): void {
  registerNotes(server, context);
  registerAnnotations(server, context);
}

/* -------------------------------------------------------------------------- */

function registerNotes(server: McpServer, context: ZoteroMcpContext): void {
  server.registerTool(
    'zotero_notes',
    {
      title: 'Read and write notes',
      description:
        'List, search, create, update or trash Zotero notes. Note bodies are HTML; simple markup (p, strong, em, ul/li, a) is preserved.',
      inputSchema: z.object({
        action: z.enum(['list', 'search', 'create', 'update', 'delete']).default('list'),
        itemKey: objectKey
          .optional()
          .describe('Parent item for list/create, or the note itself for update/delete.'),
        query: z.string().optional().describe('Full-text query for action "search".'),
        note: z.string().optional().describe('Note body for create/update. Plain text or HTML.'),
        title: z.string().optional().describe('Rendered as a leading heading on create.'),
        append: z.boolean().default(false).describe('For update: append instead of replacing.'),
        tags: z.array(tagSchema).optional(),
        raw: z.boolean().default(false).describe('For list: return the original HTML.'),
        limit: z.number().int().min(1).max(100).default(25),
      }),
      outputSchema: z.object({
        action: z.string(),
        notes: z
          .array(z.looseObject({ key: z.string(), parentItem: z.string().nullable() }))
          .optional(),
        noteKey: z.string().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ action, itemKey, query, note, title, append, tags, raw, limit }) => {
      switch (action) {
        case 'list': {
          const notes = itemKey
            ? (await context.zotero.getItemChildren(itemKey)).filter(
                (child) => child.data.itemType === 'note',
              )
            : (await context.zotero.getItems({ itemType: 'note' }, limit)).items;
          return textResult(renderNotes(notes, raw), {
            action,
            notes: notes.map(noteSummary),
          });
        }

        case 'search': {
          if (!query) throw new Error('search needs a query.');
          const page = await context.zotero.getItems(
            { q: query, qmode: 'everything', itemType: 'note' },
            limit,
          );
          return textResult(renderNotes(page.items, raw), {
            action,
            notes: page.items.map(noteSummary),
          });
        }

        case 'create': {
          assertWritable(context);
          if (!note) throw new Error('create needs a note body.');
          const body = title ? `<h1>${escapeHtml(title)}</h1>\n${toHtml(note)}` : toHtml(note);
          const payload: Record<string, unknown> = {
            itemType: 'note',
            note: body,
            tags: tags ?? [],
          };
          if (itemKey) payload.parentItem = itemKey;

          const response = await context.zotero.writeObjects('items', [payload]);
          const summary = summarizeWrite(response, [{ label: title ?? 'note' }]);
          assertNoFailures(summary.failures, 'creating the note');
          const key = summary.created[0] as string;
          return textResult(`Created note ${key}${itemKey ? ` on item ${itemKey}` : ''}`, {
            action,
            noteKey: key,
          });
        }

        case 'update': {
          assertWritable(context);
          if (!itemKey || !note) throw new Error('update needs itemKey (the note) and note.');
          const existing = await context.zotero.getItem(itemKey);
          if (existing.data.itemType !== 'note') {
            throw new Error(`Item ${itemKey} is not a note.`);
          }
          const body = append
            ? `${String(existing.data.note ?? '')}\n${toHtml(note)}`
            : toHtml(note);
          const patch: Record<string, unknown> = { note: body };
          if (tags) patch.tags = tags;
          await context.zotero.patchItem(itemKey, patch, existing.version);
          return textResult(`Updated note ${itemKey}`, { action, noteKey: itemKey });
        }

        case 'delete': {
          assertWritable(context);
          if (!itemKey) throw new Error('delete needs itemKey (the note).');
          const existing = await context.zotero.getItem(itemKey);
          if (existing.data.itemType !== 'note') {
            throw new Error(`Item ${itemKey} is not a note. Use zotero_delete_items instead.`);
          }
          await context.zotero.patchItem(itemKey, { deleted: 1 }, existing.version);
          return textResult(`Moved note ${itemKey} to the trash`, { action, noteKey: itemKey });
        }
      }
    },
  );
}

function renderNotes(notes: ZoteroItem[], raw: boolean): string {
  if (notes.length === 0) return '_No notes._';
  return notes
    .map((note) => {
      const body = String(note.data.note ?? '');
      const parent =
        typeof note.data.parentItem === 'string'
          ? ` (on ${note.data.parentItem})`
          : ' (standalone)';
      return `### ${note.key}${parent}\n${raw ? body : truncate(stripHtml(body), 1200)}`;
    })
    .join('\n\n');
}

function noteSummary(note: ZoteroItem): Record<string, unknown> {
  return {
    key: note.key,
    parentItem: typeof note.data.parentItem === 'string' ? note.data.parentItem : null,
    preview: truncate(stripHtml(String(note.data.note ?? '')), 200),
  };
}

/** Wraps bare text in a paragraph; leaves anything already marked up alone. */
function toHtml(value: string): string {
  return /<[a-z][\s\S]*>/i.test(value)
    ? value
    : value
        .split(/\n{2,}/)
        .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br/>')}</p>`)
        .join('\n');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* -------------------------------------------------------------------------- */

function registerAnnotations(server: McpServer, context: ZoteroMcpContext): void {
  server.registerTool(
    'zotero_annotations',
    {
      title: 'Read and create PDF annotations',
      description:
        'List annotations on an item, or create a highlight/note annotation on a PDF attachment. Highlights are anchored by quoting text that appears on the page, so read the page first and copy the wording exactly.',
      inputSchema: z.object({
        action: z.enum(['list', 'create']).default('list'),
        itemKey: objectKey.describe('Parent item or attachment key.'),
        type: z.enum(['highlight', 'note']).default('highlight'),
        page: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('1-indexed PDF page. Required when creating.'),
        text: z.string().optional().describe('Exact text to highlight, for type "highlight".'),
        comment: z.string().optional(),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .default('#ffd400'),
        tags: z.array(tagSchema).optional(),
        limit: z.number().int().min(1).max(200).default(100),
      }),
      outputSchema: z.object({
        action: z.string(),
        attachmentKey: z.string().optional(),
        annotations: z.array(z.looseObject({ key: z.string() })).optional(),
        annotationKey: z.string().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ action, itemKey, type, page, text, comment, color, tags, limit }) => {
      if (action === 'list') {
        const annotations = await listAnnotations(context, itemKey, limit);
        return textResult(
          annotations.length > 0
            ? annotations.map(formatAnnotation).join('\n')
            : '_No annotations._',
          {
            action,
            annotations: annotations.map((annotation) => ({
              key: annotation.key,
              type: annotation.data.annotationType ?? null,
              page: annotation.data.annotationPageLabel ?? null,
              text: annotation.data.annotationText ?? null,
              comment: annotation.data.annotationComment ?? null,
            })),
          },
        );
      }

      assertWritable(context);
      if (!page) throw new Error('create needs a page number.');
      if (type === 'highlight' && !text)
        throw new Error('A highlight needs the text to anchor to.');

      const attachment = await context.reader.resolveAttachment(itemKey);
      if (attachment.data.contentType !== 'application/pdf') {
        throw new Error(
          `Attachment ${attachment.key} is not a PDF, so it cannot carry annotations.`,
        );
      }

      const file = await context.reader.download(attachment);
      const geometry =
        type === 'highlight'
          ? await locateText(file.data, page, text as string)
          : await pagePoint(file.data, page);

      const payload: Record<string, unknown> = {
        itemType: 'annotation',
        parentItem: attachment.key,
        annotationType: type,
        annotationColor: color,
        annotationPageLabel: String(page),
        annotationSortIndex: geometry.sortIndex,
        annotationPosition: JSON.stringify({
          pageIndex: geometry.pageIndex,
          rects: geometry.rects,
        }),
        tags: tags ?? [],
      };
      if ('matchedText' in geometry) payload.annotationText = geometry.matchedText;
      if (comment) payload.annotationComment = comment;

      const response = await context.zotero.writeObjects('items', [payload]);
      const summary = summarizeWrite(response, [{ label: `${type} on page ${page}` }]);
      assertNoFailures(summary.failures, 'creating the annotation');
      const key = summary.created[0] as string;

      return textResult(`Created ${type} annotation ${key} on page ${page} of ${attachment.key}`, {
        action,
        attachmentKey: attachment.key,
        annotationKey: key,
      });
    },
  );
}

async function listAnnotations(
  context: ZoteroMcpContext,
  itemKey: string,
  limit: number,
): Promise<ZoteroItem[]> {
  const item = await context.zotero.getItem(itemKey);
  const attachmentKeys =
    item.data.itemType === 'attachment'
      ? [item.key]
      : (await context.zotero.getItemChildren(itemKey))
          .filter((child) => child.data.itemType === 'attachment')
          .map((child) => child.key);

  const annotations: ZoteroItem[] = [];
  for (const key of attachmentKeys) {
    const children = await context.zotero.getItemChildren(key, { itemType: 'annotation' });
    annotations.push(...children.filter((child) => child.data.itemType === 'annotation'));
    if (annotations.length >= limit) break;
  }
  return annotations.slice(0, limit);
}
