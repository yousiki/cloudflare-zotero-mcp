import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ZoteroMcpContext } from '../context.js';
import { formatItemList, itemSummary } from '../core/format/items.js';
import { MAX_SEMANTIC_ITEMS } from '../core/search/aisearch.js';
import type { ZoteroClient } from '../core/zotero/client.js';
import type { QueryParams, ZoteroItem } from '../core/zotero/types.js';
import { itemSummarySchema, objectKey, textResult } from './common.js';

/**
 * Zotero accepts exactly one negated `itemType`. Repeated params are ignored
 * and `-attachment || -note` is rejected outright ("Invalid itemType '-note'"),
 * so attachments — the noisy ones, since `qmode=everything` matches their
 * indexed full text — are all we can exclude by default.
 *
 * Note what that costs. A full-text hit *is* the attachment as far as Zotero is
 * concerned, so excluding attachments discards it rather than resolving it to the
 * paper it belongs to. A phrase that appears only inside a PDF therefore returns
 * nothing here, even though `itemType: 'attachment'` finds it. Promoting those
 * hits through `data.parentItem` would be the fix; nothing does that today.
 */
const DEFAULT_ITEM_TYPE_FILTER = '-attachment';

/**
 * Semantic retrieval ranks candidates by distance rather than filtering by it, so
 * the presence of results says nothing about relevance: a query the library does
 * not cover still gets back its nearest documents. Low-scoring candidates are
 * therefore kept and reported rather than dropped — `minScore` is advisory, every
 * hit that has a distance carries it, and the ones under the floor are counted in
 * `belowThreshold` and called out in `note`. A floor that filtered would hide real
 * hits, and hide that it did.
 *
 * The tool can still come back empty — an unfilled index, filters that discard
 * every candidate, or matches Zotero no longer has — and each of those says
 * something specific, so they are reported in `note` rather than smoothed over.
 * What never happens is retrieval running out of neighbours to offer.
 *
 * The score judged here is the cosine half of the match, never the fused hybrid
 * score: AI Search combines BM25 rank with vector distance, and the result is not
 * on the scale these bands were measured on.
 *
 * Measured on a ~1000 - item ML library with `@cf/baai/bge-m3`:
 *
 * | query | score band |
 * | ------------------------------------------| ----------------|
 * | nothing to do with the library | 0.315 – 0.332 |
 * | adjacent field, absent from the library | 0.498 – 0.525 |
 * | on topic, English | 0.552 – 0.596 |
 * | on topic, Chinese(same topic) | 0.566 – 0.593 |
 *
 * Cross - language costs nothing — bge - m3 puts a Chinese query on the same scale
 * as its English equivalent.But the middle two bands nearly touch, so no single
 * number separates "absent" from "on topic": 0.5 catches the wholly irrelevant
 * page without flagging genuine hits, while 0.55 would also flag on - topic papers
 * and teach the reader to ignore the warning.Hence a reported score rather than
 * a filter — a flat, uniformly low spread says more than any one value does.
 *
 * The bands were measured against a single vector per item, which is what the
 * index is configured to produce: chunking at bge-m3's 512-token ceiling leaves a
 * measured item's document whole. The long tail that still splits matches on its
 * closest passage instead of its average, moving those scores up rather than
 * down — one more reason the floor reports instead of filtering.
 */
const DEFAULT_MIN_SCORE = 0.5;

/**
 * How many extra candidates to ask for when a filter is applied after the
 * search. Both tools filter downstream of their own limit, so without this a
 * single tag can turn 20 requested results into two.
 */
const FILTER_OVERSHOOT = 3;

/**
 * Zotero cannot search Extra. `qmode=everything` is `titleCreatorYear` plus
 * attachment full text, and neither half reads that field — so `q` can never
 * find a citation key, and a lookup that sent one would come back empty no
 * matter which item carries the key.
 *
 * Matching therefore happens here, over items the API hands back, which means
 * paging the library instead of asking it a question. Hence a ceiling. A lookup
 * that reaches it has not searched everything, so it says so rather than
 * reporting a miss it cannot vouch for: at 100 items per request this is 20
 * subrequests, and a library larger than this needs a filter to stay inside a
 * Worker's budget.
 */
const CITATION_KEY_SCAN_LIMIT = 2000;

/* -------------------------------------------------------------------------- */
/* Shared input                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Narrowing that behaves identically in both tools. `itemType`, `includeTrashed`
 * and `limit` are deliberately *not* here: each means something different, or
 * nothing at all, on the semantic side.
 */
const sharedFilters = {
  tags: z
    .array(z.string())
    .optional()
    .describe('All must match. Use "a || b" for OR and a leading "-" to exclude.'),
  collectionKey: objectKey.optional().describe('Restrict to one collection.'),
  fromYear: z
    .number()
    .int()
    .optional()
    .describe(
      'Earliest publication year, inclusive. Items whose date has no four-digit year are excluded.',
    ),
  toYear: z.number().int().optional().describe('Latest publication year, inclusive.'),
  since: z.number().int().optional().describe('Only objects modified after this library version.'),
};

const keywordInput = z.object({
  query: z.string().optional().describe('Literal text. Matched, not interpreted.'),
  qmode: z
    .enum(['titleCreatorYear', 'everything'])
    .optional()
    .describe(
      'Keyword scope. "everything" also searches abstracts. To search inside PDF text, pass itemType:"attachment" as well — full-text matches are attachments, which are otherwise excluded.',
    ),
  citationKey: z.string().optional().describe('Better BibTeX citation key stored in Extra.'),
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
    .describe('Order of results.'),
  direction: z.enum(['asc', 'desc']).optional(),
  itemType: z
    .string()
    .optional()
    .describe(
      'e.g. journalArticle, book, preprint. Attachments are excluded unless you set this. Only one value, optionally negated with a leading "-".',
    ),
  includeTrashed: z.boolean().default(false),
  limit: z.number().int().min(1).max(100).default(20),
  ...sharedFilters,
});

const semanticInput = z.object({
  query: z.string().describe('A question or description. Natural-language phrasing works best.'),
  minScore: z
    .number()
    .min(0)
    .max(1)
    .default(DEFAULT_MIN_SCORE)
    .describe(
      'Advisory relevance floor, 0-1. Nothing is filtered: weaker matches are still returned, counted in belowThreshold and called out in note.',
    ),
  itemType: z
    .string()
    .optional()
    .describe(
      'e.g. journalArticle, book, preprint. Only one value, optionally negated with a leading "-". Attachments, notes and annotations are never searchable here whatever you pass.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_SEMANTIC_ITEMS)
    .default(20)
    .describe(`Up to ${MAX_SEMANTIC_ITEMS}. Narrow with filters rather than asking for more.`),
  ...sharedFilters,
});

/* -------------------------------------------------------------------------- */
/* Output                                                                     */
/* -------------------------------------------------------------------------- */

const keywordOutput = z.object({
  total: z.number(),
  items: z.array(itemSummarySchema),
  note: z.string().optional(),
});

const semanticItemSchema = itemSummarySchema.extend({
  score: z
    .number()
    .optional()
    .describe(
      'How close the match is, 0-1. Occasionally absent: that means no similarity was reported for this result, not that it scored zero.',
    ),
});

const semanticOutput = z.object({
  total: z.number(),
  items: z.array(semanticItemSchema),
  note: z.string().optional(),
  minScore: z.number().describe('The floor these results were judged against.'),
  scored: z.number().describe('How many items came back with a similarity score.'),
  belowThreshold: z
    .number()
    .describe(
      'How many of the *scored* items fell under minScore. A low score means the match may be unrelated to the query — read its title and abstract before relying on it.',
    ),
  unscored: z
    .number()
    .describe(
      'How many came back without a similarity score, so minScore could not be applied to them.',
    ),
});

/* -------------------------------------------------------------------------- */

export function registerSearchTools(server: McpServer, context: ZoteroMcpContext): void {
  server.registerTool(
    'zotero_search',
    {
      title: 'Search the Zotero library by text and fields',
      description:
        'Matches literal text and fields: titles, creators, dates, abstracts, tags, item type, collection, citation key. Results can be ordered. Use it for a known author, title fragment or exact phrase, or whenever order matters. Returns nothing when nothing matches. For questions about a topic rather than a known item, use zotero_semantic_search.',
      inputSchema: keywordInput,
      outputSchema: keywordOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      const notes: string[] = [];

      if (input.citationKey) {
        return respondKeyword(await citationKeySearch(context.zotero, input, notes), notes);
      }

      return respondKeyword(await keywordSearch(context.zotero, input), notes);
    },
  );

  server.registerTool(
    'zotero_semantic_search',
    {
      title: 'Search the Zotero library by meaning',
      description:
        'Finds items by meaning, including ones that share no wording with the query. Covers titles, creators, venues, tags and abstracts — not the body text of PDFs. Ranks by closeness rather than filtering by it, so results are not evidence that any of them fit: check each score and the note. Cannot order results, and may not yet include items added in the last few hours. For exact lookups or ordering, use zotero_search.',
      inputSchema: semanticInput,
      outputSchema: semanticOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      if (!context.semantic) {
        throw new Error(
          'Semantic search is unavailable: AI Search is not bound to this deployment. Use zotero_search for text and field queries.',
        );
      }
      const notes: string[] = [];
      const { items, scores } = await semanticSearch(context, input, notes);
      return respondSemantic(items, scores, input.minScore, notes);
    },
  );
}

type KeywordInput = z.infer<typeof keywordInput>;
type SemanticInput = z.infer<typeof semanticInput>;
/**
 * What the server-side filter builder needs. `itemType` and `includeTrashed` are
 * declared per tool rather than shared, so they arrive optionally here.
 */
type Narrowing = z.infer<z.ZodObject<typeof sharedFilters>> & {
  itemType?: string;
  includeTrashed?: boolean;
};

function respondKeyword(items: ZoteroItem[], notes: string[]) {
  const body = formatItemList(items);
  const text =
    notes.length > 0 ? `${body}\n\n${notes.map((note) => `> ${note}`).join('\n')}` : body;
  return textResult(text, {
    total: items.length,
    items: items.map((item) => itemSummary(item)),
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
  });
}

function respondSemantic(
  items: ZoteroItem[],
  scores: Map<string, number>,
  minScore: number,
  notes: string[],
) {
  const present = items.map((item) => scores.get(item.key));
  const below = present.filter((score): score is number => score !== undefined && score < minScore);
  const unscored = present.filter((score) => score === undefined).length;

  if (below.length > 0) {
    const weakest = Math.min(...below);
    notes.push(
      `${below.length} of ${items.length} result(s) scored below the ${minScore} relevance floor (weakest ${weakest.toFixed(3)}). Results are ranked by closeness, not filtered by it, so these may be unrelated to the query — read their titles and abstracts before relying on them.`,
    );
  }
  if (unscored > 0) {
    // Not a gap in the data, and not a judgement about how the match was made:
    // hybrid retrieval simply does not report a distance for every result. Saying
    // so keeps `belowThreshold` from looking like it covered every row.
    notes.push(
      `${unscored} of ${items.length} result(s) came back without a similarity score, so the ${minScore} floor could not be applied to them.`,
    );
  }
  const body = formatItemList(items, scores);
  const text =
    notes.length > 0 ? `${body}\n\n${notes.map((note) => `> ${note}`).join('\n')}` : body;
  return textResult(text, {
    total: items.length,
    items: items.map((item) => {
      const score = scores.get(item.key);
      return score === undefined ? itemSummary(item) : { ...itemSummary(item), score };
    }),
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
    minScore,
    scored: present.length - unscored,
    belowThreshold: below.length,
    unscored,
  });
}

/**
 * The filters Zotero can apply server-side. Both tools send them, so narrowing a
 * semantic query cannot return something its keyword equivalent would have
 * excluded. `q`, `qmode`, `sort` and `direction` stay out: they describe how to
 * *find* and order text matches, and semantic results are found by distance.
 */
function serverFilters(input: Narrowing): QueryParams {
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
 * first-four-digit parse `documentMetadata` uses — otherwise the pushed-down
 * filter and this one would disagree about the same item. An unparsable date is
 * excluded rather than kept: the index stores `year: 0` for it, so keeping it
 * here would make the two paths differ on exactly those items.
 */
function withinYears(item: ZoteroItem, input: Narrowing): boolean {
  if (!input.fromYear && !input.toYear) return true;
  const year = Number(String(item.data.date ?? '').match(/\d{4}/)?.[0] ?? 0);
  if (!year) return false;
  return (!input.fromYear || year >= input.fromYear) && (!input.toYear || year <= input.toYear);
}

/** True when a filter can discard candidates after the search has run. */
function isNarrowed(input: Narrowing): boolean {
  return Boolean(
    input.itemType ||
      input.tags?.length ||
      input.collectionKey ||
      input.since ||
      input.fromYear ||
      input.toYear,
  );
}

async function keywordSearch(zotero: ZoteroClient, input: KeywordInput): Promise<ZoteroItem[]> {
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

/**
 * Better BibTeX writes the key on its own line in Extra, so the match is
 * anchored to a whole line. A citation key is an identifier: a substring match
 * would let `gu2023` return `gu2023mamba`, which is a different paper.
 */
function hasCitationKey(item: ZoteroItem, citationKey: string): boolean {
  return new RegExp(`^\\s*Citation Key:\\s*${escapeRegExp(citationKey)}\\s*$`, 'im').test(
    String(item.data.extra ?? ''),
  );
}

/**
 * Looks an item up by Better BibTeX citation key. Every filter the caller gave
 * still pushes down, but no `q` is sent: it cannot reach Extra, and narrowing the
 * candidates by text would only hide the item this is trying to find. Only
 * top-level items are scanned — Better BibTeX assigns keys there, and skipping
 * child items roughly halves the pages a library-wide scan has to walk.
 */
async function citationKeySearch(
  zotero: ZoteroClient,
  input: KeywordInput,
  notes: string[],
): Promise<ZoteroItem[]> {
  const citationKey = input.citationKey as string;
  const query: QueryParams = {
    ...serverFilters(input),
    sort: input.sort,
    direction: input.direction,
  };

  const page = input.collectionKey
    ? await zotero.getCollectionItems(input.collectionKey, query, CITATION_KEY_SCAN_LIMIT, true)
    : await zotero.getTopItems(query, CITATION_KEY_SCAN_LIMIT);

  const found = page.items.filter(
    (item) => hasCitationKey(item, citationKey) && withinYears(item, input),
  );

  // An exhausted scan that found nothing is a real miss; a truncated one is not,
  // and the difference decides whether the caller should try again differently.
  if (found.length === 0 && page.items.length >= CITATION_KEY_SCAN_LIMIT) {
    notes.push(
      `The scan stopped after ${CITATION_KEY_SCAN_LIMIT} items without reaching the end of the library, so citation key "${citationKey}" may still exist beyond it. Narrow the search with collectionKey, tags or itemType to cover the rest.`,
    );
  }
  return found.slice(0, input.limit);
}

async function semanticSearch(
  context: ZoteroMcpContext,
  input: SemanticInput,
  notes: string[],
): Promise<{ items: ZoteroItem[]; scores: Map<string, number> }> {
  const empty = { items: [], scores: new Map<string, number>() };
  if (!context.semantic) return empty;

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
    const indexed = await context.semantic
      .stats()
      .then((stats) => stats.vectors)
      .catch(() => 0);
    if (indexed === 0) {
      notes.push(
        // A plain `zotero_reindex` resumes from the stored cursor, and if that
        // cursor already covers the library it reports "nothing changed" and does
        // nothing. Naming `full` is the difference between advice that works and
        // advice that only looks like it should.
        'The semantic index is empty. It fills on the scheduled sync, or immediately by calling zotero_reindex — with full=true if a plain call reports that nothing changed.',
      );
    }
    return empty;
  }

  const scores = new Map<string, number>();
  for (const match of matches) {
    // Hybrid retrieval does not report a distance for every result.
    if (match.score !== undefined) scores.set(match.itemKey, match.score);
  }
  const keys = matches.map((match) => match.itemKey);
  // AI Search can only push down the metadata fields declared on the instance,
  // and it has no array type — so tags, `since` and negated item types are
  // enforced here instead, by the lookup that fetches the item details anyway.
  const page = await context.zotero.getItems(
    { ...serverFilters(input), itemKey: keys.join(',') },
    keys.length,
  );
  // Preserve retrieval order; the API returns items in its own order.
  const byKey = new Map(page.items.map((item) => [item.key, item]));
  const ordered = keys
    .map((key) => byKey.get(key))
    .filter((item): item is ZoteroItem => Boolean(item))
    // `collections` is direct membership, which is what `/collections/<key>/items`
    // returns without `recursive=1` — so this matches what zotero_search sees,
    // without spending a second request to ask.
    .filter((item) => !input.collectionKey || item.data.collections?.includes(input.collectionKey))
    .filter((item) => withinYears(item, input));

  const dropped = keys.length - ordered.length;
  if (dropped > 0) {
    notes.push(
      narrowed
        ? `${dropped} match(es) were dropped: they fall outside the active filters, or no longer exist in Zotero.`
        : `${dropped} match(es) no longer exist in Zotero and were dropped.`,
    );
  }
  return { items: ordered.slice(0, input.limit), scores };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
