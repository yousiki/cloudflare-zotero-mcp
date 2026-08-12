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
    search/       semantic index over Vectorize
    format/       Markdown rendering for tool output
  tools/          one file per tool group, each exporting registerXxxTools(server, context)
  auth/           the /authorize login page and OAuth props
  jobs/           the cron-driven Vectorize sync
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

**Semantic search cannot fail to find things.** Vectorize returns the nearest `topK` vectors no
matter how far away they are, so `zotero_search` reports each match's `score` and counts the ones
under `minScore` in `belowThreshold` — it never drops them. `DEFAULT_MIN_SCORE` in
`src/tools/search.ts` carries the measured score bands behind that number.

**Both search paths must obey the same filters.** `auto` merges semantic recall with keyword
precision, so a filter that only one path enforces produces a result set that half-obeys the caller.
Vectorize can pre-filter only fields that have a metadata index, and a metadata index has to exist
*before* its vectors are written — adding one means re-embedding the library — so `itemType` and
`year` are pushed down and everything else (`tags`, `since`, negated types) rides on the `itemKey`
lookup that fetches the matched items anyway. `collectionKey` and the year bounds are checked in
`search.ts`: `data.collections` is direct membership, which is what `/collections/<key>/items`
returns without `recursive=1`, and Zotero has no year filter at all. Because those checks run after
`topK`, a filtered query asks for `FILTER_OVERSHOOT×` the candidates — otherwise one tag turns 20
requested results into two. `sort` is deliberately keyword-only: semantic results are ordered by
distance, and re-sorting them by `dateAdded` would throw that away.

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

**Vectorize batch caps.** 100 ids per `deleteByIds`, 1000 vectors per `upsert`. Exceeding the
delete cap fails the whole sync with error 40007.

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
  the semantic index has caught up.
- `scripts/deploy.ts` wraps `wrangler deploy` only to supply `--domain` from `ZOTERO_MCP_DOMAIN`,
  because wrangler does not expand environment variables in `wrangler.jsonc` and the public
  hostname must not be hard-coded there. It refuses to deploy without one.
- Anything touching files is only really verified by syncing Zotero Desktop afterwards.
