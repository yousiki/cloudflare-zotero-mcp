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
    search/       hybrid search over Cloudflare AI Search (document, aisearch, types)
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

**Semantic search cannot fail to find things.** Retrieval returns the closest documents however far
away they are, so a question the library does not cover comes back as a full page of
confident-looking results. `query` therefore passes `match_threshold: 0` — for retrieval *and* for
reranking, whose default is 0.4 — and `zotero_search` reports each match's `score` and counts the
ones under `minScore` in `belowThreshold` rather than dropping them. A floor tuned wrong hides real
hits, and hides that it did. `DEFAULT_MIN_SCORE` in `src/tools/search.ts` carries the measured score
bands behind that number.

**The reported score is the cosine half.** `scoring_details.vector_score`, never the fused hybrid
score: fusion mixes BM25 rank into the number, and the bands behind `DEFAULT_MIN_SCORE` were
measured on cosine, so judging a fused score against them would flag on-topic papers and wave
through irrelevant ones. A document that matched on keywords alone has no distance to report, like a
Zotero keyword hit — hence `SemanticMatch.score` is optional and `semanticSearch` leaves those keys
out of the score map instead of storing a zero, which would read as the worst match in the page.

**Both search paths must obey the same filters.** `auto` merges AI Search recall with keyword
precision, so a filter that only one path enforces produces a result set that half-obeys the caller.
An instance may declare five custom metadata fields, has no array type, and changing that schema
forces a full re-index — so only `itemtype` and `year` are declared and pushed down, and everything
else (`tags`, `since`, negated item types) rides on the `itemKey` lookup that fetches the matched
items anyway. `collectionKey` and the year bounds are checked in `search.ts`: `data.collections` is
direct membership, which is what `/collections/<key>/items` returns without `recursive=1`, and
Zotero has no year filter at all. That local year check has to use the same first-four-digit parse
`documentMetadata` uses, or the pushed-down filter and the local one disagree about the same item.
Because those checks run after the backend has already applied its own `max_num_results`, a filtered
query asks for `FILTER_OVERSHOOT×` the candidates — otherwise one tag turns 20 requested results
into two. `sort` is deliberately keyword-only: matches come back in fused, reranked order, and
re-sorting them by `dateAdded` throws that ranking away.

**`auto`'s keyword leg only surfaces when the semantic leg under-fills.** The merge is not a fusion:
`semanticSearch` already returns `ordered.slice(0, limit)`, and `auto` then does
`dedupeItems([...semantic, ...keyword]).slice(0, limit)`. Semantic items come first, so a keyword-only
hit reaches the caller *only* when the post-filter semantic count is below `limit` — empty or small
index, or filters that discarded candidates. Otherwise the second leg costs a Zotero request and
contributes nothing. One measured 20-result `auto` query on a populated library came back with 20
scored rows, i.e. zero keyword rows; that is one query, but the truncation condition is structural,
and "semantic search cannot fail to find things" above is exactly what makes the page fill.

So the leg's freshness argument — Zotero is current, the index lags a cron cycle — is best-effort at
best: an item added minutes ago is found by the Zotero half and then truncated away if semantic
already filled the page. `sort` is in the same position: it orders only the keyword half, which in
`auto` is usually the truncated half, so passing `sort` there is close to inert. Neither is a reason
to keep or drop the leg as it stands; the merge itself is what needs deciding.

It is tempting to justify the leg by `qmode=everything` reaching the full text of attached PDFs.
Measured against the real library, it does not: Zotero answers a full-text hit with the *attachment*,
and `DEFAULT_ITEM_TYPE_FILTER` then drops it, so a phrase appearing only in a PDF body returns
nothing. The same phrase with `itemType: 'attachment'` finds it. Nothing promotes that attachment to
its parent, though `data.parentItem` is right there. PDF-body recall is therefore not a capability
this server has, and the `qmode` description in `searchInput` overpromises. This predates the AI
Search migration — the same filter and the same wrong rationale were on `main`.

**`mode` picks the retrieval type.** `semantic` asks AI Search for `vector`, `auto` for `hybrid`.
Handing `semantic` the hybrid retriever lets a pure BM25 match through, and that match has no
`vector_score` — so the one mode whose contract is "these results are scored, judge them against
`minScore`" would return unscored rows, and `belowThreshold` would quietly stop describing the result
set. The retrieval type travels in `SemanticQueryOptions.retrieval`, not in the adapter.

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
keyword search defaults to `-attachment` and nothing more.

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
depends on — hybrid retrieval, RRF fusion, chunking, reranking, `score_threshold: 0`, the two
metadata fields — which is why a fresh deploy needs no dashboard step. `ensure()` creates a missing
instance and deliberately never updates an existing one: changing `custom_metadata` or the embedding
model re-indexes the whole library, and a cron run must not start that behind the operator's back.
Editing those settings is a migration, not a config change.

**A new instance invalidates the cursor.** `ensure()` returns `{ created }` and `syncSemanticIndex`
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
