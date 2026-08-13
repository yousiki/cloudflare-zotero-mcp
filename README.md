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
- **Two searches.** `zotero_search` for literal text and fields, straight from the Zotero API;
  `zotero_semantic_search` for meaning, over Cloudflare AI Search — hybrid BM25 + vector retrieval
  on `@cf/baai/bge-m3` embeddings, RRF-fused and reranked, kept in step with the library by a
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
model, the reranker, the 512-token chunking, and the two custom metadata fields are declared in code
rather than clicked into the dashboard. That code only ever *creates* an instance, never updates one,
because changing `custom_metadata`, the embedding model or the chunking re-indexes the whole library —
which is not something a cron run should do behind your back. Changing any of them therefore means
deleting the instance, so the next sync recreates it from the new configuration.

Because of that, an instance created by an older version of this worker keeps its old chunking, and a
smaller `chunk_size` splits each item across more chunks than a query budgets result slots for — so
searches come back short without anything looking broken. Every sync compares the two and reports the
difference: `zotero_reindex` returns it as `warning` and the scheduled run logs it. If you see it,
delete the instance and let the next sync rebuild it.

`ZOTERO_LIBRARY_ID` is optional — the server asks Zotero which library the key belongs to. Set it
(plus `ZOTERO_LIBRARY_TYPE=group`) only for a group library. Note that **Zotero does not support
WebDAV file sync for group libraries**, so file operations only work on your personal library.

Optional vars in `wrangler.jsonc`, with the values it ships with: `CONTACT_EMAIL` (unset —
polite-pool access to CrossRef and OpenAlex), `AI_SEARCH_INSTANCE` (`zotero-items`),
`EMBEDDING_MODEL` (`@cf/baai/bge-m3`), `RERANKING_MODEL` (`@cf/baai/bge-reranker-base`),
`SYNC_BATCH_LIMIT` (`100` items per sync run),
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
| `zotero_search` | Zotero's own search: literal text and fields, tags, type, collection, citation key, ordered |
| `zotero_semantic_search` | Meaning-based search over the AI Search index, scored, cannot be ordered |
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

### Which search tool

`zotero_search` goes to the Zotero Web API. It matches literal text and fields — titles, creators,
dates, abstracts, tags, item type, collection, Better BibTeX citation key — orders results with
`sort`/`direction`, scopes text matching with `qmode`, sees the library as it is right now, and
returns nothing when nothing matches. Use it for a known author, a title fragment, an exact phrase,
or whenever order matters.

`zotero_semantic_search` goes to Cloudflare AI Search. Use it for a question about a topic rather
than a known item: it finds papers that share no wording with the query. It ranks by closeness rather
than filtering by it, so read the scores and the `note` instead of assuming relevance. It cannot order
results, and it lags the library by up to one sync — the cron runs every six hours, so an item added
minutes ago is found by `zotero_search` and not yet by this one, until `zotero_reindex` closes the
gap. Where AI Search is not bound to the deployment the tool throws, naming `zotero_search` as the
one to use instead.

Neither tool recalls the body text of a PDF, and `zotero_search` is where that surprises people:
`qmode: "everything"` does search Zotero's full-text index, but Zotero answers such a hit with the
*attachment*, and attachments are excluded unless `itemType` says otherwise — so a phrase that
appears only in a PDF body returns nothing. Pass `itemType: "attachment"` to find it, then look up
its `parentItem` yourself. This is long-standing behaviour, changed by neither the AI Search
migration nor the split into two tools.

### Reading semantic scores

Semantic retrieval is hybrid, not vector-only: AI Search searches with BM25 and vectors over the same
documents, fuses the two rankings with RRF, and reranks with `@cf/baai/bge-reranker-base`. Documents
are chunked at 512 tokens — the input ceiling of `@cf/baai/bge-m3` on Workers AI, and enough that a
measured item's document is a single chunk, so an item normally costs one result slot rather than two.
Hybrid because a caller reaches for this tool *instead of* `zotero_search`, never alongside it —
choosing between them is a guess, so this one has to carry lexical precision of its own. An exact name
like "Sparse VideoGen2" is something a lexical index matches directly and vector distance only
approximates. That half is why `keyword_match_mode` is `or` rather than the service default of `and`:
requiring every term of a natural-language question to appear in one chunk would empty the BM25 side
on exactly the phrasing this tool asks for, and would never match a Chinese query at all, since the
keyword index is Porter-stemmed.

The price of that is rows without a score. The reported `score` is the cosine half of the match
(`scoring_details.vector_score`), never the fused score: the bands below were measured on cosine, and
a value mixing in BM25 rank is not on that scale. Hybrid retrieval does not report a distance for
every result, so some rows arrive with no `score` at all — absent means "no similarity was reported
for this result", never zero. The output counts all three cases: `scored` is how many rows
came back with a score, `belowThreshold` how many of *those* fell under `minScore`, and `unscored`
how many had none, with a note saying how many rows the floor could not be applied to. Read
`belowThreshold` against `scored`, never against `total`.

Low-scoring candidates are kept and reported rather than dropped, because `minScore` is advisory.
Retrieval ranks by distance rather than filtering by it, so the presence of results says nothing about
relevance: a query the library does not cover still gets back its nearest documents. The tool can
still come back empty — an unfilled index, filters that discard every candidate, or matches Zotero no
longer has — and each of those is reported in `note` rather than smoothed over.

`minScore` (0.5 by default) is an advisory floor that reports rather
than discards — a floor set too high would hide real hits without a trace, which is also why the
backend's own `match_threshold` is pinned to 0, for retrieval *and* for reranking, instead of left at
its default of 0.4.

The bands, measured on a ~1000-item ML library with `@cf/baai/bge-m3`: a query with nothing to do
with the library scores 0.315–0.332; an adjacent field the library does not actually cover,
0.498–0.525; on topic, 0.552–0.596 in English and 0.566–0.593 in Chinese, so a cross-language query
costs nothing. The middle two bands nearly touch, which is why 0.5 warns instead of filtering: read
the spread rather than any single value, because scores that are all low *and* nearly identical mean
the index had nothing to offer.

Filters narrow semantic results too, in two places. Only `itemtype` and `year` are pushed down into
the search itself: AI Search allows five custom metadata fields per instance, has no array type, and
re-indexes the library when that schema changes. `tags`, collection membership, negated item types
and `since` are enforced afterwards, by the Zotero `itemKey` lookup that fetches the matched items
anyway — `collectionKey` against `data.collections`, which is direct membership, exactly what
`/collections/<key>/items` returns without `recursive=1`. The `fromYear`/`toYear` bounds are
re-checked there too, on the same first-four-digit date parse the index stores, so the pushed-down
filter and the local one cannot disagree about an item. Because those checks run after the backend
has applied its own limit, a filtered query asks for `FILTER_OVERSHOOT` — three — times the
candidates it needs; otherwise one tag turns 20 requested results into two. `zotero_search` does the
same for its year bounds, the only filter it applies locally. Matches the semantic tool discards on
the way — filtered out, or gone from Zotero since the index was written — are counted in its `note`.

The two tools also differ in what they will accept. `zotero_search` takes `limit` up to 100;
`zotero_semantic_search` stops at 50, because that is where AI Search caps a query and an item's
document is normally one chunk. "Normally" is not "always": `documentText` caps at 6000 characters,
roughly 1200 tokens, so an item with a very long abstract still splits in two or three and spends more
than one slot — a page can come back a few items short of what was asked for. `includeTrashed` exists only on
`zotero_search`: the index holds no trashed items, so the flag could not change a semantic result.
For the same reason `itemType` cannot reach attachments, notes or annotations there — those are never
indexed, whatever you pass.

Order is not on offer on the semantic side: results keep the fused, reranked order they came back in,
with an item ranked by the first of its chunks to appear. `sort`, `direction`, `qmode` and
`citationKey` exist only on `zotero_search`.

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

AI Search has no local emulation, so `zotero_semantic_search` does not work under `wrangler dev`: it
errors rather than quietly answering with something else. Add `"remote": true` to the
`ai_search_namespaces` binding to work against the real instance instead, or use `zotero_search`,
which only needs the Zotero API.

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
