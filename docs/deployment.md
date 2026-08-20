# Deployment Guide

**English** | [简体中文](deployment.zh-CN.md)

Everything beyond the quick start in the [README](../README.md): how the origin, the KV
namespaces and the AI Search instance come into being, what is configurable, and how
releases deploy from GitHub Actions.

## One stable origin

The OAuth issuer and the RFC 8707 token audience are both derived from the hostname a request
arrived on, so a token is only valid for the origin it was minted against — which is why
`workers_dev` and preview URLs are off, and why the hostname is a deploy-time parameter
(`ZOTERO_MCP_DOMAIN`) rather than a value in `wrangler.jsonc` (wrangler does not expand
environment variables there).

Prefer not to own a domain? Set `"workers_dev": true` in `wrangler.jsonc`, ship with
`bun x wrangler deploy`, and use `https://zotero-mcp.<subdomain>.workers.dev` as the origin
throughout. Enable exactly one of the two.

## Provisioning

The two KV namespaces and the AI Search namespace are created on the first deploy; the KV ids
are written back into `wrangler.jsonc`. If your account already has namespaces named
`zotero-mcp-OAUTH_KV` or `zotero-mcp-CACHE_KV`, provisioning fails with error 10014; add the
existing `id`s to `wrangler.jsonc` instead.

**Nothing is created by hand.** The `zotero-mcp` AI Search namespace is created by wrangler on
deploy, and the instance named by `AI_SEARCH_INSTANCE` is created by the first sync from the
configuration in `src/core/search/aisearch.ts`: hybrid retrieval with RRF fusion, the embedding
model, the reranker, the 512-token chunking, and the two custom metadata fields are declared in
code rather than clicked into the dashboard. That code only ever *creates* an instance, never
updates one, because changing `custom_metadata`, the embedding model or the chunking re-indexes
the whole library — which is not something a cron run should do behind your back. Changing any
of them therefore means deleting the instance, so the next sync recreates it from the new
configuration.

Because of that, an instance created by an older version of this worker keeps its old chunking,
and a smaller `chunk_size` splits each item across more chunks than a query budgets result slots
for — so searches come back short without anything looking broken. Every sync compares the two
and reports the difference: `zotero_reindex` returns it as `warning` and the scheduled run logs
it. If you see it, delete the instance and let the next sync rebuild it.

## Library selection

`ZOTERO_LIBRARY_ID` is optional — the server asks Zotero which library the key belongs to. Set
it (plus `ZOTERO_LIBRARY_TYPE=group`) only for a group library. Note that **Zotero does not
support WebDAV file sync for group libraries**, so file operations only work on your personal
library.

## Optional variables

Set in `wrangler.jsonc`, with the values it ships with:

| Variable | Default | Purpose |
|---|---|---|
| `CONTACT_EMAIL` | unset | Polite-pool access to CrossRef and OpenAlex |
| `AI_SEARCH_INSTANCE` | `zotero-items` | Name of the AI Search instance |
| `EMBEDDING_MODEL` | `@cf/baai/bge-m3` | Workers AI embedding model |
| `RERANKING_MODEL` | `@cf/baai/bge-reranker-base` | Workers AI reranking model |
| `SYNC_BATCH_LIMIT` | `100` | Items per semantic-index sync run |
| `AUTH_USERNAME` | unset | Optional username for the OAuth login page |

## Deploy releases with GitHub Actions

The [CD workflow](../.github/workflows/cd.yml) deploys the exact tag whenever a GitHub Release
is published. Add these repository or `production` environment secrets under **Settings →
Secrets and variables → Actions**:

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

Create the API token from Cloudflare's **Edit Cloudflare Workers** template and restrict its
account and zone resources to this deployment. The token must be able to edit Workers scripts,
create the two KV namespaces and the AI Search namespace on the first deployment, and attach
the Worker to the custom domain. No search resource has to be created ahead of time: the
namespace comes from the deploy and the instance from the first sync.

Publishing a release runs the normal format, lint, type and test checks before deployment. The
five runtime secrets are then uploaded with the Worker as one version; they are never written
to the repository or printed in the job log. GitHub's `production` environment is optional, but
creating it lets you add required reviewers or deployment protection rules.

## Static tokens for headless clients

Your MCP client normally opens the login page, you type the `AUTH_PASSWORD`, choose whether to
grant `zotero:write`, and it stores the token. For clients that only take a static header, mint
a token with `bun run scripts/get-token.ts <origin> --out .token` and send it as
`Authorization: Bearer <token>`. That script needs a TTY to prompt; in CI or an agent harness,
set `ZOTERO_MCP_PASSWORD` or pipe the password in on stdin.

## How WebDAV writes work

Zotero's `POST /items/<key>/file` upload flow is exclusive to Zotero File Storage. For WebDAV
libraries the API instead lets you write `md5` and `mtime` directly, so an upload is:

1. Create the attachment item — that allocates the key the WebDAV filenames are built from.
2. `PUT {key}.zip` (the file, deflated) and `PUT {key}.prop` (`<mtime>` + `<hash>`) to WebDAV.
3. `PATCH` the item with `filename`, `md5` and `mtime`.

The order matters: if step 2 fails, the item is simply left without a hash, which Zotero reads
as "not uploaded yet" rather than as a broken attachment. Reads go the other way and skip the
bookkeeping entries (`.zotero-ft-cache`, `.zotero-ft-info`) that Zotero packs into the archive.

**Uploads appear in Zotero Desktop only after it syncs.** Nothing is wrong if a file does not
show up immediately.
