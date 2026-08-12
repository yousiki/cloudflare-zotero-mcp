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
- **Semantic search.** Cloudflare Vectorize plus `@cf/baai/bge-m3` embeddings, kept in step with
  the library by a cron-driven incremental sync.
- **Imports references.** Resolve a DOI, arXiv id or ISBN to full metadata and attach an
  open-access PDF in one call.
- **MCP 2026-07-28.** Stateless Streamable HTTP, OAuth 2.1 with Client ID Metadata Documents,
  structured tool output, cache hints.

## Requirements

- A **Workers Paid** plan. PDF parsing needs real CPU time, which the free plan's 10 ms budget
  cannot provide.
- A Zotero account with an API key, and a WebDAV server that Zotero Desktop already syncs to.

## Deploy

```bash
git clone https://github.com/yousiki/cloudflare-zotero-mcp && cd cloudflare-zotero-mcp
bun install

# 1. Semantic search — the one resource wrangler cannot auto-provision
bun x wrangler vectorize create zotero-items --dimensions=1024 --metric=cosine
bun x wrangler vectorize create-metadata-index zotero-items --property-name=itemType --type=string
bun x wrangler vectorize create-metadata-index zotero-items --property-name=year --type=number

# 2. Secrets
bun x wrangler secret put ZOTERO_API_KEY      # zotero.org/settings/keys, read+write
bun x wrangler secret put WEBDAV_URL          # the URL you gave Zotero; "/zotero" is appended
bun x wrangler secret put WEBDAV_USERNAME
bun x wrangler secret put WEBDAV_PASSWORD
bun x wrangler secret put AUTH_PASSWORD       # gates the OAuth login page — make it long

# 3. Ship. ZOTERO_MCP_DOMAIN is the hostname the server answers on: any hostname
#    in a zone on this Cloudflare account. The Custom Domain and its certificate
#    are created for you. The two KV namespaces are created on this first deploy
#    and their ids are written back into wrangler.jsonc.
export ZOTERO_MCP_DOMAIN=zotero-mcp.example.com
bun run deploy

# 4. Build the semantic index (the cron job would get there eventually).
#    One call embeds a batch, so this script loops until the index has caught up.
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

`ZOTERO_LIBRARY_ID` is optional — the server asks Zotero which library the key belongs to. Set it
(plus `ZOTERO_LIBRARY_TYPE=group`) only for a group library. Note that **Zotero does not support
WebDAV file sync for group libraries**, so file operations only work on your personal library.

Optional vars in `wrangler.jsonc`: `CONTACT_EMAIL` (polite-pool access to CrossRef and OpenAlex),
`EMBEDDING_MODEL`, `SYNC_BATCH_LIMIT`, `AUTH_USERNAME`.

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
| `zotero_reindex` | Bring the semantic index in step with the library |

Resources: `zotero://item/{key}`, `zotero://attachment/{key}` (raw file),
`zotero://collections`, `zotero://recent`. Prompt: `literature-review`.

### Reading semantic scores

A vector search cannot come up empty: it returns the `limit` nearest items whatever the query, so
asking about something the library does not cover still yields a full, confident-looking page. Every
semantic match therefore carries its cosine `score`, and `zotero_search` reports how many fell below
`minScore` (0.5 by default) in `belowThreshold`, with a note saying so. Nothing is filtered out —
a floor set too high would hide real hits without a trace.

On a ~1000-item ML library, unrelated queries score around 0.32 and on-topic ones 0.55–0.60, in
either English or Chinese. The band between is genuinely ambiguous, so read the spread rather than
any single value: scores that are all low *and* nearly identical mean the index had nothing to offer.

Filters apply to semantic matches too — `tags`, `itemType`, `collectionKey`, `since` and the
`fromYear`/`toYear` bounds constrain both halves of `auto`, so a result never slips through on
similarity alone. Matches discarded that way are reported in `note`. `sort` orders keyword results
only; semantic matches always come back nearest-first.

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

`wrangler dev` warns that Vectorize has no local emulation; semantic search degrades to keyword
search locally. Add `"remote": true` to the Vectorize binding to test against the real index.

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
