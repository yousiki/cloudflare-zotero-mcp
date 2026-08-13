# Architecture notes

A remote MCP server for a Zotero library whose files live on WebDAV, running on Cloudflare
Workers. Read [README.md](README.md) first for what it does and how to deploy it.

## Layout

```
src/
  core/           runtime-agnostic; only fetch, WebCrypto and streams
    zotero/       Web API v3 client, types
    webdav/       WebDAV client, .prop parsing, zip packing
    attachment/   read (index → WebDAV → PDF), write (upload → record), rename templates
    pdf/          text/outline extraction and text location, via unpdf
    sources/      identifier detection, CrossRef / arXiv / Open Library / OpenAlex
    search/       the hybrid AI Search index behind zotero_semantic_search (document, aisearch, types)
    format/       Markdown rendering for tool output
  tools/          one file per tool group, each exporting registerXxxTools(server, context)
  auth/           the /authorize login page and OAuth props
  jobs/           the cron-driven AI Search sync
  server.ts       createServer(context) → McpServer with every tool, resource and prompt
  context.ts      ZoteroMcpContext and scope checks
  env.ts          bindings → clients
  index.ts        OAuthProvider wrapping createMcpHandler, plus scheduled()
```

`src/core` never imports from `src/tools` or touches Cloudflare bindings, which is why it is
testable under `bun test` with nothing but a stubbed `fetch`.

## Things that are easy to get wrong

**Statelessness.** MCP 2026-07-28 has no session. `createMcpHandler`'s factory runs per request and
`createServer` builds a fresh `McpServer` each time. Nothing may be cached on the server object.

**Write versioning.** Every write carries `If-Unmodified-Since-Version` from the object it read.
A 412 becomes `ZoteroConflictError` and is reported, never retried blindly — retrying would
silently discard whatever the other writer did.

**Batch write results.** Zotero returns per-object outcomes (`success` / `unchanged` / `failed`)
rather than failing the request. `ZoteroClient.writeObjects` re-indexes those maps across 50-object
batches so index `50` in batch two does not collide with index `0` in batch one. Use
`summarizeWrite` + `assertNoFailures` rather than assuming success.

**Attachment order.** Item first (it allocates the key), then WebDAV, then `md5`/`mtime`. See the
README section on WebDAV writes for why.

**Zip contents.** Zotero packs its full-text cache into the same archive. `unzipAttachment` drops
dot-prefixed entries and throws if nothing else is left — never return the cache as the file.

**Renaming.** The filename lives in the zip entry, so a rename rewrites and re-uploads the archive.
It is not a metadata-only operation.

**`structuredContent` is what the model reads.** Hosts that understand it render it and drop the
text block, so the Markdown from `src/core/format` is a fallback, not the primary surface. Anything
the model needs — abstracts, filenames, which pages a truncated read returned — has to be in the
structured payload. `zotero_get_item` and `mode: "info"` were both shipped with detail that existed
only in the Markdown, and neither ever reached the model.

**Scopes.** Read tools are ungated; every write tool calls `assertWritable(context)` first. Adding
a write tool without that call hands write access to read-only tokens.

**Clients that request no scope.** Claude Code omits `scope` at `/authorize`. Reading that as
read-only left every write tool unreachable, with no checkbox on the consent page to opt in, so an
absent `scope` now offers all of `ALL_SCOPES` and the operator's ticks decide. A scope the client
*did* name is still the ceiling.

**`firstCreator` is a summary, not a name.** Zotero renders "Smith", "Smith and Jones", or
"Smith et al." — matching `meta.creatorSummary`. Emitting the bare first surname made every
proposed rename differ from the name Zotero Desktop had already written, turning a no-op rename
into a full-library re-upload.

**Semantic retrieval is hybrid on purpose.** `query` asks for `retrieval_type: 'hybrid'`, not
`vector`. `zotero_semantic_search` is a tool the caller may pick *instead of* `zotero_search`, never
alongside it, and picking between two tools is a guess — so this one has to carry lexical precision of
its own: an exact name like "Sparse VideoGen2" is something BM25 nails and cosine distance only
approximates. Nothing merges the two tools' results, so neither may rely on the other to cover it.

**Retrieval never runs out of neighbours; the tool can still be empty.** Retrieval ranks candidates by
distance rather than filtering by it, so the presence of results says nothing about relevance — a
query the library does not cover still gets back its nearest documents. Low-scoring candidates are
therefore kept and reported rather than dropped: `query` passes `match_threshold: 0` — for retrieval
*and* for reranking, whose default is 0.4 — and `zotero_semantic_search` reports each match's `score`
and counts the ones under `minScore` in `belowThreshold`. A floor that filtered would hide real hits,
and hide that it did. `DEFAULT_MIN_SCORE` (0.5) in `src/tools/search.ts` carries the measured score
bands behind that number.

Do not turn that into "semantic search cannot come back empty". It can, three ways: an unfilled
index, filters that discard every candidate — `test/server.test.ts` asserts exactly that, expecting
`items: []` — or keys Zotero no longer has. Each says something different, so each gets its own
`note`. Collapsing them into "no results" throws away the only signal that distinguishes "nothing
matches" from "nothing is indexed yet".

**The reported score is the cosine half, and it is optional.** `scoring_details.vector_score`, never
the fused hybrid score: fusion mixes BM25 rank into the number, and the bands behind
`DEFAULT_MIN_SCORE` were measured on cosine, so judging a fused score against them would flag
on-topic papers and wave through irrelevant ones. Hybrid retrieval does not report a distance for
every chunk — hence `SemanticMatch.score` is optional and `semanticSearch` leaves that key out
of the score map instead of storing a zero, which would read as the worst match in the page. An absent
`score` means no similarity was reported for that row, not that it scored zero.

**`scored` is the denominator that keeps `belowThreshold` honest.** `belowThreshold` counts only the
*scored* rows under `minScore`, so reading it against `total` understates how much of the page the
floor actually judged. `respondSemantic` therefore reports `scored`, `belowThreshold` and `unscored`
separately and pushes a note saying how many rows the floor could not be applied to. Drop the note or
fold `unscored` into `belowThreshold` and the output starts making a claim about rows nobody scored.

**Upload metadata values are strings, even the numeric ones.** `items.upload` takes
`Record<string, string>`; a field declared `data_type: 'number'` is parsed to float on AI Search's
side. `documentMetadata` therefore stringifies `year`. Sending it as a real number fails the upload
with `invalid_metadata_format` — and because `ensure()` still succeeds, the result is an instance that
exists, reports a healthy status, and indexes nothing at all. `wrangler ai-search stats` showing every
column at 0 after a sync run is the symptom. The local `AiSearchUploadItemOptions` type says
`Record<string, unknown>`, which is looser than the API, so TypeScript will not catch this.

**A parameter the index cannot honour must not be advertised.** `sharedFilters` deliberately carries
only what behaves identically in both tools. `includeTrashed` is keyword-only because `isIndexable`
drops trashed items, so the flag could never change a semantic result; `itemType` needs a different
description on each side because `SKIPPED_TYPES` means attachments, notes and annotations are never
searchable semantically whatever the caller passes; and `limit` caps at `MAX_SEMANTIC_ITEMS`, derived
as `MAX_CHUNKS / CHUNKS_PER_ITEM`, because above that the chunks a page can hold no longer cover the
items it promises and a larger `limit` silently returns fewer rows than requested. Sharing
those three fields for tidiness is how the schema ends up promising three things it cannot do — and
the tests that exercise behaviour will all still pass, because the lie is in the advertisement.

**Both tools must send the same `serverFilters`.** A filter that one tool enforces and the other
ignores makes the choice between them change which items come back, for a reason the caller never
asked about. `q`, `qmode`, `sort` and `direction` stay out of `serverFilters`: they describe how to
*find* and order text matches, and semantic results are found by distance. An instance may declare
five custom metadata fields, has no array type, and changing that schema forces a full re-index — so
only `itemtype` and `year` are declared and pushed down, and everything else (`tags`, `since`, negated
item types) rides on the `itemKey` lookup that fetches the matched items anyway. `collectionKey` and
the year bounds are checked in `search.ts`: `data.collections` is direct membership, which is what
`/collections/<key>/items` returns without `recursive=1`, and Zotero has no year filter at all. That
local year check has to use the same first-four-digit parse `documentMetadata` uses, or the
pushed-down filter and the local one disagree about the same item.

**`FILTER_OVERSHOOT` is still needed.** Both tools filter downstream of their own limit: AI Search
applies `max_num_results` before `search.ts` looks at tags, collection membership or years, and Zotero
applies its page size before the local year check. A narrowed query therefore asks for
`FILTER_OVERSHOOT` (3) times the candidates the caller wanted, otherwise one tag turns 20 requested
results into two. `keywordSearch` overshoots only for the year bounds, because that is the only filter
it applies locally.

**`sort` exists only on `zotero_search`.** Semantic matches come back in fused, reranked order, with
an item ranked by the first of its chunks to appear; re-sorting them by `dateAdded` throws that
ranking away. `semanticInput` therefore has no `sort`, `direction`, `qmode` or `citationKey`, and
ordering is one of the reasons to reach for `zotero_search` instead — which is also the tool
`zotero_semantic_search` names when it throws because AI Search is not bound to the deployment.

**PDF-body recall works on neither tool.** It is tempting to credit `zotero_search` with it, since
`qmode=everything` does reach the full text of attached PDFs. Measured against the real library, it
does not help: Zotero answers a full-text hit with the *attachment*, and `DEFAULT_ITEM_TYPE_FILTER`
then drops it, so a phrase appearing only in a PDF body returns nothing. The same phrase with
`itemType: 'attachment'` finds it. Nothing promotes that attachment to its parent, though
`data.parentItem` is right there — so the `qmode` description in `keywordInput` says to pass
`itemType: 'attachment'` rather than promising full-text search outright. This predates both the split
into two tools and the AI Search migration: the same filter and the same wrong rationale were on
`main`.

**Deletes lock per item.** `DELETE /items?itemKey=a,b` can only carry the *library* version in
`If-Unmodified-Since-Version`, so any concurrent write — Zotero Desktop syncing, another agent, the
previous key in the same loop — 412s it. `deleteItem` uses `DELETE /items/<key>` with that item's
own version instead, and callers loop.

**Field lists must be deny-lists.** Zotero has around a hundred fields across its item types, and
`format/items.ts` used to render a whitelist of 23. Every type-specific field — `institution` on a
report, `university` on a thesis, `repository` on a preprint — was dropped from both the Markdown
and `structuredContent`, with nothing to show it had happened.

**One protected resource.** `/mcp` is the only API route. Tokens are audience-bound to it via RFC
8707, so a second API route (an admin endpoint, say) would reject the same token with
"Token audience does not match resource server". Operational actions belong in tools —
`zotero_reindex` is what that mistake turned into.

**Zotero's `itemType` filter takes one value.** Repeated params are ignored and
`-attachment || -note` is a 400. Only a single optionally-negated type works, which is why
`serverFilters` defaults to `-attachment` for both search tools and nothing more.

**Indexing is asynchronous.** `items.upload` queues a document and returns; nothing is searchable at
that point. `SyncReport.submitted` counts what the backend accepted and `complete` means every
change was *submitted*, so a run reporting `complete` with a `backlog` of 900 is normal rather than a
contradiction. `backlog` — `queued + running` from `stats()` — is the only honest progress signal;
telling the caller "the index is current" on the strength of `complete` is a claim this code cannot
make, and it will be believed. When `stats()` itself fails, `backlog` and `failed` come back `null`,
never `0`: the run still succeeded, but "I could not ask" must not read as "nothing pending".

**Deletes need AI Search's item id.** `items.delete` takes the instance's own opaque id, not the
document key, so `removeItems` resolves ids by paginating `items.list` at 50 per page. Zotero's
`/deleted` feed reports attachments, notes and annotations too, none of which were ever uploaded, so
a key with no document is the normal case and must not fail the sync. An unfinished scan is the
opposite: the caller advances the library cursor as soon as `removeItems` returns, so a scan that
gave up early would strand those documents permanently, with nothing left to point at them. Hence
`MAX_LIST_PAGES` throws instead of breaking out.

**Instance config lives in code.** `AiSearchSettings` and `ensure()` hold everything this code
depends on — hybrid retrieval, RRF fusion, `CHUNK_SIZE`/`CHUNK_OVERLAP`, reranking,
`score_threshold: 0`, the two metadata fields — which is why a fresh deploy needs no dashboard step.
`ensure()` creates a missing instance and deliberately never updates an existing one: changing
`custom_metadata`, the embedding model or the chunking re-indexes the whole library, and a cron run
must not start that behind the operator's back. Editing those settings is a migration, not a config
change.

**Which means a stale instance has to be reported, not corrected.** `CHUNK_SIZE` is 512 because that
is bge-m3's input ceiling on Workers AI, and `CHUNKS_PER_ITEM` is 1 *because* of it — a measured
item's document fits in one chunk. An instance created before that was pinned still chunks at the
service default of 256, which does not fail: every document splits in two, each item spends two of
the slots a query budgets one for, and searches quietly return about half the items requested. So
`ensure()` compares and returns `mismatch`, `syncSemanticIndex` carries it as `warning`, and both the
cron log and `zotero_reindex` surface it. A silent halving is the failure mode worth spending a
field on.

**A new instance invalidates the cursor.** `ensure()` returns `created` and `syncSemanticIndex`
treats `created` exactly like `full: true`, because a just-created instance is empty however far
along the stored cursor is. Without that, deleting the instance — or pointing `AI_SEARCH_INSTANCE` at
a new one — while the cursor sits at the newest library version gives every later run `pending: []`
and "nothing changed", so the index stays empty until somebody thinks to pass `full`. For the same
reason the cursor key is `aisearch:sync-state:<instance>` rather than one global key: two instances
must not share a claim about what has been written.

**One upload per item is one subrequest.** There is no batched write: each item costs its own
`upload` call, so a run's subrequest budget is spent per changed item. That is why `SYNC_BATCH_LIMIT`
is 100 rather than the batched-embedding era's 400, and why `UPLOAD_CONCURRENCY` is 6. Raising either
buys a faster catch-up and pays with runs that die on the subrequest limit; the leftovers resume next
run only because `since` advances after `pending` drains, never before.

## Adding a tool

1. Put it in the matching `src/tools/*.ts`, or add a file and register it in `src/server.ts`.
2. Give it a zod `inputSchema`, a zod `outputSchema`, and `annotations`
   (`readOnlyHint` / `destructiveHint`) — hosts use those to decide what to auto-approve.
3. Return `textResult(markdown, structured)`. The Markdown is what the model reads; the structured
   object is validated against `outputSchema`.
4. Throw plain `Error`s with actionable messages. The SDK turns them into `isError` results, so the
   model sees the message and can correct itself.
5. Add the tool name to the catalogue assertion in `test/server.test.ts`, and the table in
   `README.md`.

## Testing

- `test/*.test.ts` run under `bun test` with a stubbed `fetch` (`test/helpers.ts`). No network.
- `test/server.test.ts` drives the real MCP client over `InMemoryTransport`, so schema and
  serialization problems surface there rather than in production.
- `scripts/e2e.ts` exercises a running server through Streamable HTTP; `--write` runs the full
  create → upload → read → rename → delete cycle against the real library.
- `scripts/get-token.ts` mints a bearer token; `scripts/reindex.ts` loops `zotero_reindex` until
  every change has been submitted, then keeps polling until `backlog` reaches 0 and exits non-zero if
  it cannot, because "submitted" is not the thing the operator asked for.
- `scripts/deploy.ts` wraps `wrangler deploy` only to supply `--domain` from `ZOTERO_MCP_DOMAIN`,
  because wrangler does not expand environment variables in `wrangler.jsonc` and the public
  hostname must not be hard-coded there. It refuses to deploy without one.
- Anything touching files is only really verified by syncing Zotero Desktop afterwards.
