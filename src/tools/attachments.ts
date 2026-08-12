import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { assertWritable, type ZoteroMcpContext } from '../context.js';
import { guessContentType } from '../core/attachment/read.js';
import { DEFAULT_RENAME_TEMPLATE } from '../core/attachment/rename.js';
import { truncate } from '../core/format/items.js';
import { base64Decode } from '../core/http.js';
import type { ZoteroItem } from '../core/zotero/types.js';
import { objectKey, tagSchema, textResult } from './common.js';

/** Refuse to pull absurd files into a 128 MB isolate. */
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

export function registerAttachmentTools(server: McpServer, context: ZoteroMcpContext): void {
  registerRead(server, context);
  registerPut(server, context);
  registerDelete(server, context);
  registerRename(server, context);
}

/* -------------------------------------------------------------------------- */

function registerRead(server: McpServer, context: ZoteroMcpContext): void {
  server.registerTool(
    'zotero_read_attachment',
    {
      title: 'Read an attachment',
      description:
        "Read the text of a PDF (or text) attachment. Accepts a parent item key and picks its PDF automatically. Whole-document reads use Zotero's own full-text index when available; page ranges always read the file from WebDAV.",
      inputSchema: z.object({
        itemKey: objectKey.describe('Parent item or attachment key.'),
        mode: z.enum(['text', 'outline', 'info']).default('text'),
        fromPage: z.number().int().min(1).optional(),
        toPage: z.number().int().min(1).optional(),
        maxPages: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(60)
          .describe('Ceiling on pages read in one call.'),
        forceFile: z
          .boolean()
          .default(false)
          .describe("Bypass Zotero's index and re-extract from the file."),
        writeBackIndex: z
          .boolean()
          .default(false)
          .describe("Upload the extracted text to Zotero's full-text index for other clients."),
      }),
      outputSchema: z.object({
        attachmentKey: z.string(),
        source: z.string().optional(),
        totalPages: z.number().nullable().optional(),
        pages: z.array(z.number()).optional().describe('Pages actually read, 1-indexed.'),
        truncated: z.boolean().optional(),
        text: z.string().optional(),
        outline: z.array(z.looseObject({ title: z.string() })).optional(),
        file: z
          .looseObject({ filename: z.string().nullable() })
          .optional()
          .describe('Stored-file details, for mode "info".'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ itemKey, mode, fromPage, toPage, maxPages, forceFile, writeBackIndex }) => {
      if (mode === 'outline') {
        const { attachmentKey, outline } = await context.reader.readOutline(itemKey);
        const text =
          outline.length > 0
            ? outline
                .map(
                  (entry) =>
                    `${'  '.repeat(entry.level)}- ${entry.title}${entry.page ? ` (p.${entry.page})` : ''}`,
                )
                .join('\n')
            : '_This PDF has no embedded outline._';
        return textResult(text, { attachmentKey, outline });
      }

      if (mode === 'info') {
        const attachment = await context.reader.resolveAttachment(itemKey);
        const data = attachment.data;
        const lines = [
          `- attachment: ${attachment.key}`,
          `- filename: ${data.filename ?? '(none)'}`,
          `- contentType: ${data.contentType ?? '(unknown)'}`,
          `- linkMode: ${data.linkMode ?? '(unknown)'}`,
          `- md5: ${data.md5 ?? '(not uploaded yet)'}`,
          `- mtime: ${data.mtime ?? '(none)'}`,
        ];
        const onWebDav = context.webdav ? await context.webdav.exists(attachment.key) : null;
        if (onWebDav !== null) lines.push(`- on WebDAV: ${onWebDav ? 'yes' : 'no'}`);

        // Everything interesting about this mode lives in `file`: hosts render
        // structuredContent and never show the lines above.
        return textResult(lines.join('\n'), {
          attachmentKey: attachment.key,
          source: 'metadata',
          totalPages: null,
          file: {
            filename: (data.filename as string | undefined) ?? null,
            contentType: (data.contentType as string | undefined) ?? null,
            linkMode: (data.linkMode as string | undefined) ?? null,
            md5: (data.md5 as string | undefined) ?? null,
            mtime: (data.mtime as number | undefined) ?? null,
            title: (data.title as string | undefined) ?? null,
            parentItem: typeof data.parentItem === 'string' ? data.parentItem : null,
            onWebDav,
          },
        });
      }

      const result = await context.reader.readText(itemKey, {
        fromPage,
        toPage,
        maxPages,
        forceFile,
        writeBackIndex,
      });

      const header = [
        `Attachment ${result.attachmentKey} · source: ${
          result.source === 'zotero-index' ? "Zotero's full-text index" : 'WebDAV file'
        }`,
        result.totalPages ? `pages: ${result.totalPages}` : '',
        result.pages?.length
          ? `read: ${result.pages[0]}–${result.pages[result.pages.length - 1]}`
          : '',
        result.truncated ? 'TRUNCATED — call again with fromPage to continue' : '',
      ]
        .filter(Boolean)
        .join(' · ');

      return textResult(`${header}\n\n${result.text}`, {
        attachmentKey: result.attachmentKey,
        source: result.source,
        totalPages: result.totalPages ?? null,
        // Without this the caller cannot tell which slice of a truncated
        // document it just read, and the header saying so is text-only.
        ...(result.pages?.length ? { pages: result.pages } : {}),
        truncated: result.truncated ?? false,
        text: result.text,
      });
    },
  );
}

/* -------------------------------------------------------------------------- */

function registerPut(server: McpServer, context: ZoteroMcpContext): void {
  server.registerTool(
    'zotero_put_attachment',
    {
      title: 'Upload or replace an attachment',
      description:
        'Store a file on WebDAV and register it with Zotero. Provide either sourceUrl (downloaded server-side) or base64Data. Set replaceAttachmentKey to swap the file behind an existing attachment.',
      inputSchema: z.object({
        parentItemKey: objectKey
          .optional()
          .describe('Item to attach to. Omit for a standalone attachment.'),
        replaceAttachmentKey: objectKey
          .optional()
          .describe("Replace this attachment's file instead of creating a new one."),
        sourceUrl: z.url().optional().describe('Public URL of the file to fetch.'),
        base64Data: z.string().optional().describe('File contents, base64 encoded.'),
        filename: z.string().optional().describe('Defaults to the URL basename.'),
        contentType: z.string().optional(),
        title: z.string().optional(),
        tags: z.array(tagSchema).optional(),
        collections: z.array(objectKey).optional(),
      }),
      outputSchema: z.object({
        attachmentKey: z.string(),
        filename: z.string(),
        bytes: z.number(),
        md5: z.string(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => {
      assertWritable(context);
      const { data, filename } = await resolveUpload(input);

      const result = input.replaceAttachmentKey
        ? await context.writer.replace(input.replaceAttachmentKey, data, input.filename ?? filename)
        : await context.writer.create({
            parentItemKey: input.parentItemKey,
            filename: input.filename ?? filename,
            contentType: input.contentType ?? guessContentType(input.filename ?? filename),
            data,
            title: input.title,
            url: input.sourceUrl,
            tags: input.tags,
            collections: input.collections,
          });

      return textResult(
        [
          `${input.replaceAttachmentKey ? 'Replaced' : 'Created'} attachment ${result.attachmentKey}`,
          `- filename: ${result.filename}`,
          `- size: ${result.bytes} bytes`,
          `- md5: ${result.md5}`,
          '',
          'The file is on WebDAV now. Zotero Desktop will pick it up on its next sync.',
        ].join('\n'),
        {
          attachmentKey: result.attachmentKey,
          filename: result.filename,
          bytes: result.bytes,
          md5: result.md5,
        },
      );
    },
  );
}

async function resolveUpload(input: {
  sourceUrl?: string;
  base64Data?: string;
  filename?: string;
}): Promise<{ data: Uint8Array; filename: string }> {
  if (input.sourceUrl && input.base64Data) {
    throw new Error('Provide either sourceUrl or base64Data, not both.');
  }

  if (input.base64Data) {
    let data: Uint8Array;
    try {
      data = base64Decode(input.base64Data.replace(/^data:[^;]+;base64,/, ''));
    } catch {
      throw new Error('base64Data is not valid base64.');
    }
    if (data.length > MAX_UPLOAD_BYTES) {
      throw new Error(`File is ${data.length} bytes, over the ${MAX_UPLOAD_BYTES} byte limit.`);
    }
    return { data, filename: input.filename ?? 'attachment.pdf' };
  }

  if (!input.sourceUrl) throw new Error('Provide sourceUrl or base64Data.');

  const response = await fetch(input.sourceUrl, {
    headers: { 'User-Agent': 'zotero-mcp (+https://github.com/yousiki/zotero-mcp)' },
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(`Downloading ${input.sourceUrl} failed with ${response.status}.`);
  }

  const declared = Number(response.headers.get('Content-Length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    throw new Error(`Remote file is ${declared} bytes, over the ${MAX_UPLOAD_BYTES} byte limit.`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error(
      `Remote file is ${buffer.byteLength} bytes, over the ${MAX_UPLOAD_BYTES} byte limit.`,
    );
  }

  const fromUrl = decodeURIComponent(new URL(input.sourceUrl).pathname.split('/').pop() ?? '');
  return {
    data: new Uint8Array(buffer),
    filename: input.filename ?? (fromUrl.includes('.') ? fromUrl : 'attachment.pdf'),
  };
}

/* -------------------------------------------------------------------------- */

function registerDelete(server: McpServer, context: ZoteroMcpContext): void {
  server.registerTool(
    'zotero_delete_attachment',
    {
      title: 'Delete an attachment',
      description: 'Delete an attachment item and remove its file pair from WebDAV.',
      inputSchema: z.object({ attachmentKey: objectKey }),
      outputSchema: z.object({ attachmentKey: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ attachmentKey }) => {
      assertWritable(context);
      await context.writer.remove(attachmentKey);
      return textResult(`Deleted attachment ${attachmentKey} and its WebDAV files.`, {
        attachmentKey,
      });
    },
  );
}

/* -------------------------------------------------------------------------- */

function registerRename(server: McpServer, context: ZoteroMcpContext): void {
  server.registerTool(
    'zotero_rename_attachments',
    {
      title: 'Rename attachments from item metadata',
      description:
        "Rename stored attachments using Zotero's filename template. Runs as a dry run by default; set apply=true to write. Renaming rewrites the WebDAV archive, so it costs one download and one upload per file.",
      inputSchema: z.object({
        itemKeys: z.array(objectKey).max(50).optional().describe('Parent items to process.'),
        collectionKey: objectKey
          .optional()
          .describe('Process every top-level item in a collection.'),
        template: z
          .string()
          .default(DEFAULT_RENAME_TEMPLATE)
          .describe('Zotero attachment filename template.'),
        apply: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(25),
      }),
      outputSchema: z.object({
        applied: z.boolean(),
        planned: z.array(
          z.object({
            attachmentKey: z.string(),
            from: z.string(),
            to: z.string(),
            status: z.string(),
          }),
        ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ itemKeys, collectionKey, template, apply, limit }) => {
      if (apply) assertWritable(context);
      if (!itemKeys?.length && !collectionKey) {
        throw new Error('Pass itemKeys or collectionKey to choose what to rename.');
      }

      const parents = itemKeys?.length
        ? await Promise.all(itemKeys.map((key) => context.zotero.getItem(key)))
        : (await context.zotero.getCollectionItems(collectionKey as string, {}, limit, true)).items;

      const planned: Array<{ attachmentKey: string; from: string; to: string; status: string }> =
        [];

      for (const parent of parents.slice(0, limit)) {
        for (const attachment of await storedAttachments(context, parent)) {
          const current = String(attachment.data.filename ?? '');
          const proposed = await context.writer.plannedName(attachment, template);
          if (!proposed || proposed === current) {
            planned.push({
              attachmentKey: attachment.key,
              from: current,
              to: proposed ?? current,
              status: 'unchanged',
            });
            continue;
          }

          if (!apply) {
            planned.push({
              attachmentKey: attachment.key,
              from: current,
              to: proposed,
              status: 'planned',
            });
            continue;
          }

          try {
            const file = await context.reader.download(attachment);
            await context.writer.rename(attachment.key, proposed, file.data);
            planned.push({
              attachmentKey: attachment.key,
              from: current,
              to: proposed,
              status: 'renamed',
            });
          } catch (error) {
            planned.push({
              attachmentKey: attachment.key,
              from: current,
              to: proposed,
              status: `failed: ${truncate(error instanceof Error ? error.message : String(error), 200)}`,
            });
          }
        }
      }

      const lines = planned.map(
        (entry) =>
          `- ${entry.attachmentKey}: ${entry.from || '(no name)'} → ${entry.to} [${entry.status}]`,
      );
      const header = apply
        ? `Renamed ${planned.filter((entry) => entry.status === 'renamed').length} attachment(s).`
        : `Dry run over ${planned.length} attachment(s). Re-run with apply=true to write.`;

      return textResult([header, '', ...lines].join('\n'), { applied: apply, planned });
    },
  );
}

async function storedAttachments(
  context: ZoteroMcpContext,
  parent: ZoteroItem,
): Promise<ZoteroItem[]> {
  if (parent.data.itemType === 'attachment') {
    return parent.data.linkMode?.startsWith('imported') ? [parent] : [];
  }
  const children = await context.zotero.getItemChildren(parent.key);
  return children.filter(
    (child) =>
      child.data.itemType === 'attachment' && Boolean(child.data.linkMode?.startsWith('imported')),
  );
}
