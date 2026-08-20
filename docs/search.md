# Search Guide

**English** | [简体中文](search.zh-CN.md)

The server has two search tools with deliberately different behaviour. This page explains how
to choose between them, how the semantic index stays in step with the library, and how to read
semantic scores.

## Which search tool

`zotero_search` goes to the Zotero Web API. It matches literal text and fields — titles,
creators, dates, abstracts, tags, item type, collection, Better BibTeX citation key — orders
results with `sort`/`direction`, scopes text matching with `qmode`, sees the library as it is
right now, and returns nothing when nothing matches. Use it for a known author, a title
fragment, an exact phrase, or whenever order matters.

`zotero_semantic_search` goes to Cloudflare AI Search. Use it for a question about a topic
rather than a known item: it finds papers that share no wording with the query. It ranks by
closeness rather than filtering by it, so read the scores and the `note` instead of assuming
relevance. It cannot order results, and it lags the library by up to one sync — the cron runs
every six hours, so an item added minutes ago is found by `zotero_search` and not yet by this
one, until `zotero_reindex` closes the gap. Where AI Search is not bound to the deployment the
tool throws, naming `zotero_search` as the one to use instead.

Neither tool recalls the body text of a PDF, and `zotero_search` is where that surprises
people: `qmode: "everything"` does search Zotero's full-text index, but Zotero answers such a
hit with the *attachment*, and attachments are excluded unless `itemType` says otherwise — so a
phrase that appears only in a PDF body returns nothing. Pass `itemType: "attachment"` to find
it, then look up its `parentItem` yourself. This is long-standing behaviour, changed by neither
the AI Search migration nor the split into two tools.

## Indexing is asynchronous

The sync uploads one document per item, named `<itemKey>.md`. `upload` is an upsert on that
name, so a changed item replaces its own document instead of accumulating copies — and it
returns as soon as the document is queued. `complete: true` from `zotero_reindex` therefore
means every change was *submitted*, not that it is searchable: `submitted` counts the documents
AI Search accepted this run, `backlog` the ones it is still processing (`null` if AI Search
could not be asked — not the same as zero), `failed` the ones it could not index, and
`remaining` the changed items left for the next run. The cron trigger runs the same sync every
six hours, 100 items at a time; each item is one upload and every upload is a subrequest, so
anything over the batch resumes on the next run instead of blowing the limit.

Deletions go the other way round. `items.delete` takes AI Search's own opaque item id rather
than the document name, so the ids are resolved by paginating the instance's item list.
Zotero's `/deleted` feed reports attachments, notes and annotations too — none of which were
ever uploaded — so a key with no document is the normal case and not an error. A scan that
cannot finish throws instead: the library cursor advances on the strength of the delete
returning, so reporting success here would leave documents behind for good.

## Reading semantic scores

Semantic retrieval is hybrid, not vector-only: AI Search searches with BM25 and vectors over
the same documents, fuses the two rankings with RRF, and reranks with
`@cf/baai/bge-reranker-base`. Documents are chunked at 512 tokens — the input ceiling of
`@cf/baai/bge-m3` on Workers AI, and enough that a measured item's document is a single chunk,
so an item normally costs one result slot rather than two. Hybrid because a caller reaches for
this tool *instead of* `zotero_search`, never alongside it — choosing between them is a guess,
so this one has to carry lexical precision of its own. An exact name like "Sparse VideoGen2" is
something a lexical index matches directly and vector distance only approximates. That half is
why `keyword_match_mode` is `or` rather than the service default of `and`: requiring every term
of a natural-language question to appear in one chunk would empty the BM25 side on exactly the
phrasing this tool asks for, and would never match a Chinese query at all, since the keyword
index is Porter-stemmed.

The price of that is rows without a score. The reported `score` is the cosine half of the match
(`scoring_details.vector_score`), never the fused score: the bands below were measured on
cosine, and a value mixing in BM25 rank is not on that scale. Hybrid retrieval does not report
a distance for every result, so some rows arrive with no `score` at all — absent means "no
similarity was reported for this result", never zero. The output counts all three cases:
`scored` is how many rows came back with a score, `belowThreshold` how many of *those* fell
under `minScore`, and `unscored` how many had none, with a note saying how many rows the floor
could not be applied to. Read `belowThreshold` against `scored`, never against `total`.

Low-scoring candidates are kept and reported rather than dropped, because `minScore` is
advisory. Retrieval ranks by distance rather than filtering by it, so the presence of results
says nothing about relevance: a query the library does not cover still gets back its nearest
documents. The tool can still come back empty — an unfilled index, filters that discard every
candidate, or matches Zotero no longer has — and each of those is reported in `note` rather
than smoothed over.

`minScore` (0.5 by default) is an advisory floor that reports rather than discards — a floor
set too high would hide real hits without a trace, which is also why the backend's own
`match_threshold` is pinned to 0, for retrieval *and* for reranking, instead of left at its
default of 0.4.

The bands, measured on a ~1000-item ML library with `@cf/baai/bge-m3`: a query with nothing to
do with the library scores 0.315–0.332; an adjacent field the library does not actually cover,
0.498–0.525; on topic, 0.552–0.596 in English and 0.566–0.593 in Chinese, so a cross-language
query costs nothing. The middle two bands nearly touch, which is why 0.5 warns instead of
filtering: read the spread rather than any single value, because scores that are all low *and*
nearly identical mean the index had nothing to offer.

## Filters

Filters narrow semantic results too, in two places. Only `itemtype` and `year` are pushed down
into the search itself: AI Search allows five custom metadata fields per instance, has no array
type, and re-indexes the library when that schema changes. `tags`, collection membership,
negated item types and `since` are enforced afterwards, by the Zotero `itemKey` lookup that
fetches the matched items anyway — `collectionKey` against `data.collections`, which is direct
membership, exactly what `/collections/<key>/items` returns without `recursive=1`. The
`fromYear`/`toYear` bounds are re-checked there too, on the same first-four-digit date parse
the index stores, so the pushed-down filter and the local one cannot disagree about an item.
Because those checks run after the backend has applied its own limit, a filtered query asks for
`FILTER_OVERSHOOT` — three — times the candidates it needs; otherwise one tag turns 20
requested results into two. `zotero_search` does the same for its year bounds, the only filter
it applies locally. Matches the semantic tool discards on the way — filtered out, or gone from
Zotero since the index was written — are counted in its `note`.

## Limits and ordering

The two tools also differ in what they will accept. `zotero_search` takes `limit` up to 100;
`zotero_semantic_search` stops at 50, because that is where AI Search caps a query and an
item's document is normally one chunk. "Normally" is not "always": `documentText` caps at 6000
characters, roughly 1200 tokens, so an item with a very long abstract still splits in two or
three and spends more than one slot — a page can come back a few items short of what was asked
for. `includeTrashed` exists only on `zotero_search`: the index holds no trashed items, so the
flag could not change a semantic result. For the same reason `itemType` cannot reach
attachments, notes or annotations there — those are never indexed, whatever you pass.

Order is not on offer on the semantic side: results keep the fused, reranked order they came
back in, with an item ranked by the first of its chunks to appear. `sort`, `direction`, `qmode`
and `citationKey` exist only on `zotero_search`.
