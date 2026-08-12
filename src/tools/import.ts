import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { assertWritable, type ZoteroMcpContext } from '../context.js';
import { buildRenamedFilename } from '../core/attachment/rename.js';
import { formatItemList } from '../core/format/items.js';
import { detectIdentifier } from '../core/sources/identifiers.js';
import { type ResolvedReference, resolveReference } from '../core/sources/metadata.js';
import type { ZoteroItem } from '../core/zotero/types.js';
import { assertNoFailures, objectKey, summarizeWrite, tagSchema, textResult } from './common.js';

const MAX_PDF_BYTES = 40 * 1024 * 1024;

export function registerImportTools(server: McpServer, context: ZoteroMcpContext): void {
  server.registerTool(
    'zotero_import_reference',
    {
      title: 'Import a reference by DOI, arXiv id or ISBN',
      description:
        'Resolve an identifier to full metadata (CrossRef, arXiv or Open Library), create the item, and optionally attach an openly available PDF to WebDAV. Checks for an existing copy first.',
      inputSchema: z.object({
        identifier: z.string().describe('A DOI, arXiv id, ISBN, doi.org URL or arxiv.org URL.'),
        collections: z.array(objectKey).optional(),
        tags: z.array(tagSchema).optional(),
        attachPdf: z
          .boolean()
          .default(true)
          .describe('Download and attach an open-access PDF when one is found.'),
        pdfUrl: z.url().optional().describe('Explicit PDF URL, overriding automatic discovery.'),
        allowDuplicate: z
          .boolean()
          .default(false)
          .describe('Import even when a matching item already exists.'),
      }),
      outputSchema: z.object({
        itemKey: z.string().optional(),
        existingKeys: z.array(z.string()),
        attachmentKey: z.string().nullable(),
        source: z.string(),
        title: z.string(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ identifier, collections, tags, attachPdf, pdfUrl, allowDuplicate }) => {
      assertWritable(context);

      const detected = detectIdentifier(identifier);
      if (!detected) {
        throw new Error(
          `"${identifier}" does not look like a DOI, arXiv id or ISBN. Create the item manually with zotero_create_items if it has no identifier.`,
        );
      }

      const reference = await resolveReference(detected, { contactEmail: context.contactEmail });
      const existing = await findExisting(context, reference);

      if (existing.length > 0 && !allowDuplicate) {
        return textResult(
          [
            `${reference.title}`,
            '',
            `This is already in the library (${detected.kind}: ${detected.value}):`,
            formatItemList(existing),
            '',
            'Pass allowDuplicate=true to import anyway.',
          ].join('\n'),
          {
            existingKeys: existing.map((item) => item.key),
            attachmentKey: null,
            source: reference.source,
            title: reference.title,
          },
        );
      }

      const template = await context.zotero.getTemplate(reference.itemType);
      const payload: Record<string, unknown> = {
        ...template,
        itemType: reference.itemType,
        title: reference.title,
        creators: reference.creators,
        tags: tags ?? [],
        collections: collections ?? [],
      };
      for (const [field, value] of Object.entries(reference.fields)) {
        if (field in template || field === 'extra') payload[field] = value;
      }

      const response = await context.zotero.writeObjects('items', [payload]);
      const summary = summarizeWrite(response, [{ label: reference.title }]);
      assertNoFailures(summary.failures, 'creating the imported item');
      const itemKey = summary.created[0] as string;

      const lines = [
        `Imported "${reference.title}" as ${itemKey} (${reference.itemType}, via ${reference.source})`,
      ];

      let attachmentKey: string | null = null;
      const candidatePdf = pdfUrl ?? reference.pdfUrl;
      if (attachPdf && candidatePdf) {
        try {
          attachmentKey = await attachPdfFrom(context, itemKey, candidatePdf);
          lines.push(`Attached PDF from ${candidatePdf} as ${attachmentKey}`);
        } catch (error) {
          lines.push(
            `Could not attach the PDF from ${candidatePdf}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      } else if (attachPdf) {
        lines.push('No open-access PDF was found. Supply pdfUrl if you have one.');
      }

      return textResult(lines.join('\n'), {
        itemKey,
        existingKeys: existing.map((item) => item.key),
        attachmentKey,
        source: reference.source,
        title: reference.title,
      });
    },
  );
}

async function findExisting(
  context: ZoteroMcpContext,
  reference: ResolvedReference,
): Promise<ZoteroItem[]> {
  const needle = reference.fields.DOI ?? reference.fields.ISBN ?? reference.fields.archiveID;
  if (!needle) return [];
  const page = await context.zotero.getItems({ q: needle, qmode: 'everything' }, 10);
  const normalized = needle.toLowerCase();
  return page.items.filter((item) =>
    [item.data.DOI, item.data.ISBN, item.data.archiveID, item.data.extra]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(normalized)),
  );
}

async function attachPdfFrom(
  context: ZoteroMcpContext,
  parentItemKey: string,
  url: string,
): Promise<string> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'zotero-mcp (+https://github.com/yousiki/zotero-mcp)' },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`the server returned ${response.status}`);

  const contentType = (response.headers.get('Content-Type') ?? '').split(';')[0]?.trim() ?? '';
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_PDF_BYTES) {
    throw new Error(`the file is ${buffer.byteLength} bytes, over the ${MAX_PDF_BYTES} byte limit`);
  }
  const data = new Uint8Array(buffer);

  // Landing pages masquerade as downloads often enough to be worth checking.
  const looksLikePdf = data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46;
  if (!looksLikePdf) {
    throw new Error(`the response was ${contentType || 'not a PDF'} rather than a PDF`);
  }

  // Name it through the same template the rename tool uses, reading the parent
  // back for Zotero's own `creatorSummary`. Hand-rolling the name here produced
  // files that `zotero_rename_attachments` then wanted to rename immediately:
  // no "et al.", no character sanitising, and a byte cap that could eat ".pdf".
  const parent = await context.zotero.getItem(parentItemKey);
  const result = await context.writer.create({
    parentItemKey,
    filename: buildRenamedFilename(parent.data, 'attachment.pdf', undefined, {
      creatorSummary: parent.meta?.creatorSummary,
    }),
    contentType: 'application/pdf',
    data,
    title: 'Full Text PDF',
    url,
  });
  return result.attachmentKey;
}
