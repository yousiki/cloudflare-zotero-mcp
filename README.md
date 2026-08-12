# cloudflare-zotero-mcp

A remote [Model Context Protocol](https://modelcontextprotocol.io) server for Zotero, built for
people who sync **metadata through a Zotero account and files through their own WebDAV server**.

Deploy it once to Cloudflare Workers and every device and agent you use — Claude Code, Claude
Desktop, Cursor, anything that speaks MCP — can read and write the same library over HTTPS.

## What it does

- **Full read/write, including files.** Search, read and edit items, collections, tags, notes and
  annotations, *and* download, upload, replace, rename and delete the PDFs themselves.
- **WebDAV-native.** Zotero's Web API can only upload files for Zotero File Storage subscribers.
  This server instead writes the `{key}.zip` / `{key}.prop` pair to your WebDAV server the way
  Zotero Desktop does, then records the resulting `md5`/`mtime` on the item.
- **Reads PDFs.** Whole-document reads come from Zotero's own full-text index when it has one
  (free, instant); page ranges and outlines are extracted from the real file.
- **Semantic search.** Cloudflare AI Search: hybrid BM25 + vector retrieval over
  `@cf/baai/bge-m3` embeddings, RRF-fused and reranked, kept in step with the library by a
  cron-driven incremental sync.
- **Imports references.** Resolve a DOI, arXiv id or ISBN to full metadata and attach an
  open-access PDF in one call.
- **MCP 2026-07-28.** Stateless Streamable HTTP, OAuth 2.1 with Client ID Metadata Documents,
  structured tool output, cache hints.

## Requirements

- A **Workers Paid** plan. PDF parsing needs real CPU time, which the free plan's 10 ms budget
  cannot provide.
- A Zotero account with an API key, and a WebDAV server that Zotero Desktop already syncs to.
- AI Search is in **open beta** and free within its limits; the Workers AI embedding and reranking
  calls it makes are billed separately.

## Deploy

```bash
git clone https://github.com/yousiki/cloudflare-zotero-mcp && cd cloudflare-zotero-mcp
bun install

# 1. Secrets
bun x wrangler secret put ZOTERO_API_KEY      # zotero.org/settings/keys, read+write
bun x wrangler secret put WEBDAV_URL          # the URL you gave Zotero; "/zotero" is appended
bun x wrangler secret put WEBDAV_USERNAME
bun x wrangler secret put WEBDAV_PASSWORD
bun x wrangler secret put AUTH_PASSWORD       # gates the OAuth login page — make it long

# 2. Ship. ZOTERO_MCP_DOMAIN is the hostname the server answers on: any hostname
#    in a zone on this Cloudflare account. The Custom Domain and its certificate
#    are created for you. The two KV namespaces and the AI Search namespace are
#    created on this first deploy; the KV ids are written back into wrangler.jsonc.
export ZOTERO_MCP_DOMAIN=zotero-mcp.example.com
bun run deploy

# 3. Build the semantic index (the cron job would get there eventually).
#    One call submits a batch, so this script loops until the library is covered.
bun run scripts/get-token.ts "https://$ZOTERO_MCP_DOMAIN" --out .token
bun run scripts/reindex.ts "https://$ZOTERO_MCP_DOMAIN/mcp" "$(cat .token)" --full
```

**One stable origin.** The OAuth issuer and the RFC 8707 token audience are both derived from the
hostname a request arrived on, so a token is only valid for the origin it was minted against — which
is why `workers_dev` and preview URLs are off, and why the hostname is a deploy-time parameter
rather than a value in `wrangler.jsonc` (wrangler does not expand environment variables there).
Prefer not to own a domain for this? Set `"workers_dev": true` in `wrangler.jsonc`, ship with
`bun x wrangler deploy`, and use `https://zotero-mcp.<subdomain>.workers.dev` as the origin
throughout. Enable exactly one of the two.

If your account already has namespaces named `zotero-mcp-OAUTH_KV` or `zotero-mcp-CACHE_KV`,
provisioning fails with error 10014; add the existing `id`s to `wrangler.jsonc` instead.

**Nothing is created by hand.** The `zotero-mcp` AI Search namespace is created by wrangler on
deploy, and the instance named by `AI_SEARCH_INSTANCE` is created by the first sync from the
configuration in `src/core/search/aisearch.ts`: hybrid retrieval with RRF fusion, the embedding
model, the reranker, chunking, and the two custom metadata fields are declared in code rather than
clicked into the dashboard. That code only ever *creates* an instance, never updates one, because
changing `custom_metadata` or the embedding model re-indexes the whole library — which is not
something a cron run should do behind your back. Changing either therefore means deleting the
instance, so the next sync recreates it from the new configuration.

`ZOTERO_LIBRARY_ID` is optional — the server asks Zotero which library the key belongs to. Set it
(plus `ZOTERO_LIBRARY_TYPE=group`) only for a group library. Note that **Zotero does not support
WebDAV file sync for group libraries**, so file operations only work on your personal library.

Optional vars in `wrangler.jsonc`, with the values it ships with: `CONTACT_EMAIL` (unset —
polite-pool access to CrossRef and OpenAlex), `AI_SEARCH_INSTANCE` (`zotero-items`),
`EMBEDDING_MODEL` (`@cf/baai/bge-m3`), `RERANKING_MODEL` (`@cf/baai/bge-reranker-base`),
`AI_SEARCH_REWRITE_QUERY` (`false` — rewriting spends an extra LLM call to rephrase a query that an
MCP client already phrased on purpose), `SYNC_BATCH_LIMIT` (`100` items per sync run),
`AUTH_USERNAME`.

### Deploy releases with GitHub Actions

The [CD workflow](.github/workflows/cd.yml) deploys the exact tag whenever a GitHub Release is
published. Add these repository or `production` environment secrets under **Settings → Secrets and
variables → Actions**:

| GitHub secret | Value |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account ID that owns the Worker and domain |
| `CLOUDFLARE_API_TOKEN` | A scoped Cloudflare API token used by Wrangler |
| `ZOTERO_MCP_DOMAIN` | Bare hostname, for example `zotero-mcp.example.com` |
| `ZOTERO_API_KEY` | Zotero API key with read/write access |
| `WEBDAV_URL` | WebDAV root configured in Zotero; `/zotero` is appended |
| `WEBDAV_USERNAME` | WebDAV username |
| `WEBDAV_PASSWORD` | WebDAV password |
| `AUTH_PASSWORD` | Long password protecting the OAuth authorization page |

Create the API token from Cloudflare's **Edit Cloudflare Workers** template and restrict its account
and zone resources to this deployment. The token must be able to edit Workers scripts, create the
two KV namespaces and the AI Search namespace on the first deployment, and attach the Worker to the
custom domain. No search resource has to be created ahead of time: the namespace comes from the
deploy and the instance from the first sync.

Publishing a release runs the normal format, lint, type and test checks before deployment. The five
runtime secrets are then uploaded with the Worker as one version; they are never written to the
repository or printed in the job log. GitHub's `production` environment is optional, but creating it
lets you add required reviewers or deployment protection rules.

## Connect a client

The server is a normal OAuth-protected MCP endpoint at `https://<your-domain>/mcp`.

```bash
claude mcp add --transport http zotero https://zotero-mcp.example.com/mcp
```

Your client opens the login page, you type the `AUTH_PASSWORD`, choose whether to grant
`zotero:write`, and it stores the token. For clients that only take a static header, mint a token
with `bun run scripts/get-token.ts <origin> --out .token` and send it as
`Authorization: Bearer <token>`. That script needs a TTY to prompt; in CI or an agent harness, set
`ZOTERO_MCP_PASSWORD` or pipe the password in on stdin.

## Tools

| Tool | What it does |
|---|---|
| `zotero_search` | Text, tag, type, collection, citation-key and semantic search |
| `zotero_get_item` | Full metadata, optionally with children and BibTeX/CSL-JSON |
| `zotero_create_items` | Create items from the server's own type templates |
| `zotero_update_item` | Patch fields, creators, tags and collection membership |
| `zotero_delete_items` | Trash (default) or permanently delete |
| `zotero_list_collections` | Collection tree, name search, or a collection's items |
| `zotero_manage_collections` | Create, rename, delete; add/remove items |
| `zotero_list_tags` | Tags with item counts |
| `zotero_notes` | List, search, create, update, trash notes |
| `zotero_annotations` | List annotations; create highlights anchored to quoted text |
| `zotero_read_attachment` | PDF text, page ranges, outline, or file status |
| `zotero_put_attachment` | Upload or replace a file from a URL or base64 |
| `zotero_delete_attachment` | Delete the attachment item and its WebDAV files |
| `zotero_rename_attachments` | Rename via Zotero's filename template (dry run by default) |
| `zotero_import_reference` | DOI / arXiv / ISBN → item, with an open-access PDF |
| `zotero_find_duplicates` | Find and merge duplicates |
| `zotero_reindex` | Submit changed items to the semantic index (asynchronous) |

Resources: `zotero://item/{key}`, `zotero://attachment/{key}` (raw file),
`zotero://collections`, `zotero://recent`. Prompt: `literature-review`.

### Indexing is asynchronous

The sync uploads one document per item, named `<itemKey>.md`. `upload` is an upsert on that name, so
a changed item replaces its own document instead of accumulating copies — and it returns as soon as
the document is queued. `complete: true` from `zotero_reindex` therefore means every change was
*submitted*, not that it is searchable: `submitted` counts the documents AI Search accepted this
run, `backlog` the ones it is still processing (`null` if AI Search could not be asked — not the same
as zero), `failed` the ones it could not index, and
`remaining` the changed items left for the next run. The cron trigger runs the same sync every six
hours, 100 items at a time; each item is one upload and every upload is a subrequest, so anything
over the batch resumes on the next run instead of blowing the limit.

Deletions go the other way round. `items.delete` takes AI Search's own opaque item id rather than
the document name, so the ids are resolved by paginating the instance's item list. Zotero's
`/deleted` feed reports attachments, notes and annotations too — none of which were ever uploaded —
so a key with no document is the normal case and not an error. A scan that cannot finish throws
instead: the library cursor advances on the strength of the delete returning, so reporting success
here would leave documents behind for good.

### Reading semantic scores

Retrieval depends on the mode. `mode: auto` runs hybrid: AI Search searches with BM25 and vectors
over the same documents and fuses the two rankings with RRF. `mode: semantic` restricts it to vector
distance, because that mode's contract is that its results are scored and hybrid can return a pure
keyword hit with no distance at all. Both rerank with `@cf/baai/bge-reranker-base`, and both search
chunked documents, so a long abstract matches on its closest passage rather than on its average.

Nearest-neighbour search cannot come up empty: it returns the `limit` closest documents whatever the
query, so asking about something the library does not cover still yields a full, confident-looking
page. Every match that has a distance therefore carries a `score`, and `zotero_search` reports how
many fell below `minScore` (0.5 by default) in `belowThreshold`, with a note saying so. Nothing is
filtered out — a floor set too high would hide real hits without a trace, which is also why the
backend's own `match_threshold` is pinned to 0 rather than left at its default of 0.4.

The reported `score` is the cosine half of the match (`scoring_details.vector_score`), never the
fused hybrid score: the bands below were measured on cosine, and a value mixing in BM25 rank is not
on that scale. A document that matched on keywords alone reports no score at all, exactly like a
keyword hit from Zotero.

On a ~1000-item ML library, unrelated queries score around 0.32 and on-topic ones 0.55–0.60, in
either English or Chinese. The band between is genuinely ambiguous, so read the spread rather than
any single value: scores that are all low *and* nearly identical mean the index had nothing to offer.

Filters apply to semantic matches too — `tags`, `itemType`, `collectionKey`, `since` and the
`fromYear`/`toYear` bounds constrain both halves of `auto`, so a result never slips through on
similarity alone. Only `itemtype` and `year` are pushed down into the search itself: AI Search
allows five custom metadata fields per instance, has no array type, and re-indexes the library when
that schema changes, so tags, collection membership, negated item types and `since` are enforced by
the Zotero `itemKey` lookup that fetches the matched items anyway. Matches discarded that way are
reported in `note`. `sort` orders keyword results only; semantic matches keep the fused, reranked
order they came back in, with an item ranked by the first of its chunks to appear.

`mode: auto` runs a Zotero keyword search alongside AI Search and merges the two, but the merge is a
concatenation rather than a fusion: semantic results come first, and the list is cut to `limit`.
Because the semantic half is already capped at `limit`, a keyword-only match reaches you *only* when
the semantic half returned fewer than `limit` items — an empty or small index, or filters that
discarded candidates. Otherwise the keyword half is truncated away entirely.

That makes its two apparent benefits conditional. Zotero is authoritative about the library right now
while the index lags a cron cycle, so a just-added item is found by the keyword half — and then
dropped if semantic already filled the page. `sort` orders only the keyword half, so in `auto` it is
usually ordering rows that never survive; use `mode: keyword` when ordering matters.

It does *not* add PDF full-text recall, despite `qmode=everything` searching Zotero's full-text
index. Zotero answers such a hit with the attachment rather than the paper, and attachments are
excluded by default, so a phrase that appears only in a PDF body returns nothing — pass
`itemType: "attachment"` to find it, then look up its `parentItem` yourself. This is long-standing
behaviour, not something the AI Search migration changed.

## How WebDAV writes work

Zotero's `POST /items/<key>/file` upload flow is exclusive to Zotero File Storage. For WebDAV
libraries the API instead lets you write `md5` and `mtime` directly, so an upload is:

1. Create the attachment item — that allocates the key the WebDAV filenames are built from.
2. `PUT {key}.zip` (the file, deflated) and `PUT {key}.prop` (`<mtime>` + `<hash>`) to WebDAV.
3. `PATCH` the item with `filename`, `md5` and `mtime`.

The order matters: if step 2 fails, the item is simply left without a hash, which Zotero reads as
"not uploaded yet" rather than as a broken attachment. Reads go the other way and skip the
bookkeeping entries (`.zotero-ft-cache`, `.zotero-ft-info`) that Zotero packs into the archive.

**Uploads appear in Zotero Desktop only after it syncs.** Nothing is wrong if a file does not show
up immediately.

## Development

```bash
bun test                      # unit + protocol tests, no network
bun run typecheck
bun run lint                  # Biome lint rules
bun run format:check          # verify formatting without changing files
bun run format               # format files with Biome
cp .dev.vars.example .dev.vars && bun run dev

# End-to-end against the running server (add --write to exercise uploads)
bun run scripts/get-token.ts http://localhost:8787 --out .token
bun run scripts/e2e.ts http://localhost:8787/mcp "$(cat .token)" --write
```

AI Search has no local emulation, so semantic search degrades to keyword search under
`wrangler dev`. Add `"remote": true` to the `ai_search_namespaces` binding to work against the real
instance instead.

The decisive check for anything touching files is still Zotero Desktop: sync it and confirm the
item, the file and the filename all landed.

See [AGENTS.md](AGENTS.md) for the architecture and how to add a tool, and
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Security

`AUTH_PASSWORD` is the only thing between the public internet and full read/write access to
your library, so make it long and random. [SECURITY.md](SECURITY.md) covers the trust model,
how to report a vulnerability, and the limits of the login throttling.

## License

[MIT](LICENSE) © yousiki (Siqi Yang)
