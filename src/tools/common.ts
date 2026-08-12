import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ZoteroItem } from '../core/zotero/types.js';

/** Zotero object keys are eight uppercase alphanumerics. */
export const objectKey = z
  .string()
  .regex(/^[A-Z0-9]{8}$/, 'Zotero keys are 8 uppercase letters/digits, e.g. "RTKZQI8E"');

export const tagSchema = z.object({
  tag: z.string().min(1),
  type: z.union([z.literal(0), z.literal(1)]).optional(),
});

export const creatorSchema = z.object({
  creatorType: z.string().min(1).default('author'),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  name: z.string().optional(),
});

export function textResult(text: string, structured?: Record<string, unknown>): CallToolResult {
  return structured
    ? { content: [{ type: 'text', text }], structuredContent: structured }
    : { content: [{ type: 'text', text }] };
}

/** Shape shared by every tool that returns a list of items. */
export const itemSummarySchema = z.looseObject({
  key: z.string(),
  itemType: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
});

/**
 * Detail view. Spelled out rather than left to `looseObject` so the model can
 * see from the schema alone that the abstract and the bibliographic fields are
 * available here and it need not go looking for another tool.
 */
export const itemDetailSchema = itemSummarySchema.extend({
  fields: z
    .record(z.string(), z.string())
    .optional()
    .describe('Bibliographic fields present on the item: date, DOI, pages, url, …'),
  creators: z.array(z.object({ creatorType: z.string(), name: z.string() })).optional(),
  abstract: z.string().nullable().optional(),
  extra: z.string().nullable().optional(),
});

/**
 * Zotero reports per-object outcomes instead of failing the whole request.
 * Collapse that into something a model can act on.
 */
export function summarizeWrite(
  response: {
    success: Record<string, string>;
    unchanged: Record<string, string>;
    failed: Record<string, { code: number; message: string }>;
  },
  inputs: Array<{ label: string }>,
): { created: string[]; unchanged: string[]; failures: string[] } {
  const created = Object.values(response.success ?? {});
  const unchanged = Object.values(response.unchanged ?? {});
  const failures = Object.entries(response.failed ?? {}).map(([index, failure]) => {
    const label = inputs[Number(index)]?.label ?? `#${index}`;
    return `${label}: ${failure.code} ${failure.message}`;
  });
  return { created, unchanged, failures };
}

export function assertNoFailures(failures: string[], action: string): void {
  if (failures.length > 0) {
    throw new Error(
      `Zotero rejected ${failures.length} object(s) while ${action}:\n${failures.join('\n')}`,
    );
  }
}

/** Deduplicates items by key while preserving order. */
export function dedupeItems(items: ZoteroItem[]): ZoteroItem[] {
  const seen = new Set<string>();
  const out: ZoteroItem[] = [];
  for (const item of items) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    out.push(item);
  }
  return out;
}
