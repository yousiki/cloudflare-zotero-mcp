import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ZoteroMcpContext } from '../context.js';
import { formatItemList, itemSummary } from '../core/format/items.js';
import type { ZoteroClient } from '../core/zotero/client.js';
import type { QueryParams, ZoteroItem } from '../core/zotero/types.js';
import { dedupeItems, itemSummarySchema, objectKey, textResult } from './common.js';

/**
 * Zotero accepts exactly one negated `itemType`. Repeated params are ignored
 * and `-attachment || -note` is rejected outright ("Invalid itemType '-note'"),
 * so attachments — the noisy ones, since `qmode=everything` matches their
 * indexed full text — are all we can exclude by default.
 */
const DEFAULT_ITEM_TYPE_FILTER = '-attachment';

/**
 * Vectorize is a nearest-neighbour search, not a filter: it returns the `topK`
 * closest vectors however far away they are, so a question the library simply
 * does not cover comes back as a full page of confident-looking results. Nothing
 * is dropped — a floor tuned wrong would hide real hits, and silently — but
 * every semantic hit reports its score and anything under the floor is counted
 * in `belowThreshold`, which is the difference between recall and relevance.
 *
 * Measured on a ~1000-item ML library with `@cf/baai/bge-m3`:
 *
 * | query                                    | score band     |
 * |------------------------------------------|----------------|
 * | nothing to do with the library           | 0.315 – 0.332  |
 * | adjacent field, absent from the library   | 0.498 – 0.525  |
 * | on topic, English                        | 0.552 – 0.596  |
 * | on topic, Chinese (same topic)           | 0.566 – 0.593  |
 *
 * Cross-language costs nothing — bge-m3 puts a Chinese query on the same scale
 * as its English equivalent. But the middle two bands nearly touch, so no single
 * number separates "absent" from "on topic": 0.5 catches the wholly irrelevant
 * page without flagging genuine hits, while 0.55 would also flag on-topic papers
 * and teach the reader to ignore the warning. Hence a reported score rather than
 * a filter — a flat, uniformly low spread says more than any one value does.
 */
const DEFAULT_MIN_SCORE = 0.5;

const searchInput = z.object({
  query: z
    .string()
    .optional()
    .describe('Free text. Natural-language phrasing works best in semantic mode.'),
  mode: z
    .enum(['auto', 'keyword', 'semantic'])
    .default('auto')
    .describe(
      'auto picks semantic for conceptual questions and keyword for short author/title lookups, then merges both.',
    ),
  qmode: z
    .enum(['titleCreatorYear', 'everything'])
    .optional()
    .describe('Keyword scope. "everything" also searches abstracts and indexed full text.'),
  tags: z
    .array(z.string())
    .optional()
    .describe('All must match. Use "a || b" for OR and a leading "-" to exclude.'),
  itemType: z
    .string()
    .optional()
    .describe(
      'e.g. journalArticle, book, preprint. Attachments are excluded unless you set this. Only one value, optionally negated with a leading "-".',
    ),
  collectionKey: objectKey.optional().describe('Restrict to one collection.'),
  fromYear: z
    .number()
    .int()
    .optional()
    .describe(
      'Earliest publication year, inclusive. Items whose date has no four-digit year are excluded.',
    ),
  toYear: z.number().int().optional().describe('Latest publication year, inclusive.'),
  citationKey: z.string().optional().describe('Better BibTeX citation key stored in Extra.'),
  since: z.number().int().optional().describe('Only objects modified after this library version.'),
  sort: z
    .enum([
      'dateAdded',
      'dateModified',
      'title',
      'creator',
      'date',
      'itemType',
      'publisher',
      'publicationTitle',
    ])
    .optional()
    .describe('Order of keyword results. Semantic matches always come back by similarity.'),
  direction: z.enum(['asc', 'desc']).optional(),
  includeTrashed: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(20),
  minScore: z
    .number()
    .min(0)
    .max(1)
    .default(DEFAULT_MIN_SCORE)
    .describe(
      'Advisory relevance floor for semantic matches, 0-1. Nothing is filtered: weaker matches are still returned, counted in belowThreshold and called out in note.',
    ),
});

const searchItemSchema = itemSummarySchema.extend({
  score: z
    .number()
    .optional()
    .describe(
      'Cosine similarity, for semantic matches only. Absent on keyword matches, which matched the text exactly rather than by distance.',
    ),
});

const searchOutput = z.object({
  mode: z.string(),
  total: z.number(),
  items: z.array(searchItemSchema),
  note: z.string().optional(),
  minScore: z.number().optional().describe('The floor these results were judged against.'),
  belowThreshold: z
    .number()
    .optional()
    .describe(
      'How many returned items scored under minScore. They are the nearest vectors available, not necessarily relevant — read their titles and abstracts before relying on them.',
    ),
});

export function registerSearchTools(server: McpServer, context: ZoteroMcpContext): void {
  server.registerTool(
    'zotero_search',
    {
      title: 'Search the Zotero library',
      description:
        'Find items by text, tag, type, collection, citation key or semantic similarity. Returns one compact line per item; follow up with zotero_get_item for details.',
      inputSchema: searchInput,
      outputSchema: searchOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      const mode = resolveMode(input.mode, input.query, context.semantic !== null);
      const notes: string[] = [];

      if (input.citationKey) {
        const items = await keywordSearch(context.zotero, {
          ...input,
          query: input.citationKey,
          qmode: 'everything',
        });
        const exact = items.filter((item) =>
          new RegExp(
            `^\\s*Citation Key:\\s*${escapeRegExp(input.citationKey as string)}\\s*$`,
            'im',
          ).test(String(item.data.extra ?? '')),
        );
        return respond('citationKey', exact.length > 0 ? exact : items, notes);
      }

      if (mode === 'keyword') {
        return respond(mode, await keywordSearch(context.zotero, input), notes);
      }

      const semantic = await semanticSearch(context, input, notes);
      const scoring = { minScore: input.minScore, scores: semantic.scores };
      if (mode === 'semantic') return respond(mode, semantic.items, notes, scoring);

      // auto: semantic recall first, then keyword precision, deduplicated.
      const keywordItems = await keywordSearch(context.zotero, input);
      return respond(
        'auto',
        dedupeItems([...semantic.items, ...keywordItems]).slice(0, input.limit),
        notes,
        scoring,
      );
    },
  );
}

type SearchInput = z.infer<typeof searchInput>;

/** Similarity per item key, and the floor to judge it against. */
interface Scoring {
  minScore: number;
  scores: Map<string, number>;
}

function respond(mode: string, items: ZoteroItem[], notes: string[], scoring?: Scoring) {
  const scored = items
    .map((item) => scoring?.scores.get(item.key))
    .filter((score): score is number => score !== undefined);
  const below = scoring ? scored.filter((score) => score < scoring.minScore) : [];

  if (scoring && below.length > 0) {
    const weakest = Math.min(...below);
    notes.push(
      `${below.length} of ${items.length} result(s) scored below the ${scoring.minScore} relevance floor (weakest ${weakest.toFixed(3)}). Semantic search always returns its nearest vectors, so these may be unrelated to the query — read their titles and abstracts before relying on them.`,
    );
  }

  const body = formatItemList(items, scoring?.scores);
  const text =
    notes.length > 0 ? `${body}\n\n${notes.map((note) => `> ${note}`).join('\n')}` : body;
  return textResult(text, {
    mode,
    total: items.length,
    items: items.map((item) => {
      const score = scoring?.scores.get(item.key);
      return score === undefined ? itemSummary(item) : { ...itemSummary(item), score };
    }),
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
    ...(scoring ? { minScore: scoring.minScore, belowThreshold: below.length } : {}),
  });
}

function resolveMode(
  requested: SearchInput['mode'],
  query: string | undefined,
  semanticAvailable: boolean,
): 'keyword' | 'semantic' | 'auto' {
  if (requested === 'keyword') return 'keyword';
  if (!semanticAvailable || !query?.trim()) return 'keyword';
  if (requested === 'semantic') return 'semantic';
  // Short queries are almost always a name, a title fragment or a year — the
  // things keyword search is exact about and embeddings are vague about.
  const words = query.trim().split(/\s+/).length;
  return words >= 4 || query.includes('?') ? 'auto' : 'keyword';
}

/**
 * The filters Zotero can apply server-side, shared by both paths so that `auto`
 * cannot return a semantic hit its keyword half would have excluded. `q`,
 * `qmode`, `sort` and `direction` stay out: they describe how to *find* and
 * order keyword results, and semantic results are found and ordered by distance.
 */
function serverFilters(input: SearchInput): QueryParams {
  return {
    // Without this, `qmode=everything` surfaces the attachments whose indexed
    // full text matched, instead of the papers they belong to.
    itemType: input.itemType ?? DEFAULT_ITEM_TYPE_FILTER,
    tag: input.tags,
    since: input.since,
    includeTrashed: input.includeTrashed ? 1 : undefined,
  };
}

/**
 * Zotero has no year filter, so the bounds are applied here, on the same
 * first-four-digit parse `embeddingMetadata` uses — otherwise the Vectorize
 * pre-filter and this one would disagree about the same item. An unparsable
 * date is excluded rather than kept: Vectorize stores `year: 0` for it, so
 * keeping it here would make the two paths differ on exactly those items.
 */
function withinYears(item: ZoteroItem, input: SearchInput): boolean {
  if (!input.fromYear && !input.toYear) return true;
  const year = Number(String(item.data.date ?? '').match(/\d{4}/)?.[0] ?? 0);
  if (!year) return false;
  return (!input.fromYear || year >= input.fromYear) && (!input.toYear || year <= input.toYear);
}

/** True when a filter can discard candidates after the search has run. */
function isNarrowed(input: SearchInput): boolean {
  return Boolean(
    input.itemType ||
      input.tags?.length ||
      input.collectionKey ||
      input.since ||
      input.fromYear ||
      input.toYear,
  );
}

/**
 * How many extra candidates to ask for when a filter is applied after the
 * search. Both paths filter downstream of their own limit, so without this a
 * single tag can turn 20 requested results into two.
 */
const FILTER_OVERSHOOT = 3;

async function keywordSearch(zotero: ZoteroClient, input: SearchInput): Promise<ZoteroItem[]> {
  const query: QueryParams = {
    ...serverFilters(input),
    q: input.query,
    qmode:
      input.qmode ??
      (input.query && input.query.trim().split(/\s+/).length > 2 ? 'everything' : undefined),
    sort: input.sort,
    direction: input.direction,
  };

  // Only the year bounds are filtered locally, so only they need the overshoot.
  const wanted =
    input.fromYear || input.toYear ? Math.min(input.limit * FILTER_OVERSHOOT, 100) : input.limit;
  const page = input.collectionKey
    ? await zotero.getCollectionItems(input.collectionKey, query, wanted)
    : await zotero.getItems(query, wanted);
  return page.items.filter((item) => withinYears(item, input)).slice(0, input.limit);
}

async function semanticSearch(
  context: ZoteroMcpContext,
  input: SearchInput,
  notes: string[],
): Promise<{ items: ZoteroItem[]; scores: Map<string, number> }> {
  const empty = { items: [], scores: new Map<string, number>() };
  if (!context.semantic || !input.query) return empty;

  const narrowed = isNarrowed(input);
  const matches = await context.semantic.query(input.query, {
    // Everything except `itemType` and `year` is enforced after the search, so
    // ask for more candidates than the caller wants when a filter is in play.
    topK: narrowed ? input.limit * FILTER_OVERSHOOT : input.limit,
    itemType: input.itemType,
    fromYear: input.fromYear,
    toYear: input.toYear,
  });

  if (matches.length === 0) {
    const size = await context.semantic.size().catch(() => 0);
    if (size === 0) {
      notes.push(
        'The semantic index is empty. It fills on the scheduled sync, or immediately by calling zotero_reindex.',
      );
    }
    return empty;
  }

  const scores = new Map(matches.map((match) => [match.itemKey, match.score]));
  const keys = matches.map((match) => match.itemKey);
  // Vectorize can only pre-filter fields that have a metadata index, and a
  // metadata index has to exist before its vectors are written — so tags,
  // `since` and negated item types are enforced here instead, by the lookup
  // that fetches the item details anyway.
  const page = await context.zotero.getItems(
    { ...serverFilters(input), itemKey: keys.join(',') },
    keys.length,
  );
  // Preserve similarity order; the API returns items in its own order.
  const byKey = new Map(page.items.map((item) => [item.key, item]));
  const ordered = keys
    .map((key) => byKey.get(key))
    .filter((item): item is ZoteroItem => Boolean(item))
    // `collections` is direct membership, which is what `/collections/<key>/items`
    // returns without `recursive=1` — so this matches what keyword search saw,
    // without spending a second request to ask.
    .filter((item) => !input.collectionKey || item.data.collections?.includes(input.collectionKey))
    .filter((item) => withinYears(item, input));

  const dropped = keys.length - ordered.length;
  if (dropped > 0) {
    notes.push(
      narrowed
        ? `${dropped} semantic match(es) were dropped: they fall outside the active filters, or no longer exist in Zotero.`
        : `${dropped} semantic match(es) no longer exist in Zotero and were dropped.`,
    );
  }
  return { items: ordered.slice(0, input.limit), scores };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
