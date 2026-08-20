# cloudflare-zotero-mcp

[![CI](https://github.com/yousiki/cloudflare-zotero-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/yousiki/cloudflare-zotero-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-2026--07--28-8A2BE2)](https://modelcontextprotocol.io)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)

**English** | [简体中文](README.zh-CN.md)

A remote [Model Context Protocol](https://modelcontextprotocol.io) server for Zotero, built for
people who sync **metadata through a Zotero account and files through their own WebDAV server**.

Deploy it once to Cloudflare Workers and every device and agent you use — Claude Code, Claude
Desktop, Cursor, anything that speaks MCP — can read and write the same library over HTTPS.

## Features

- 📚 **Full read/write, including files** — search, read and edit items, collections, tags,
  notes and annotations, *and* download, upload, replace, rename and delete the PDFs themselves.
- 🗄️ **WebDAV-native** — writes the `{key}.zip` / `{key}.prop` pair to your WebDAV server the
  way Zotero Desktop does, so file uploads work without a Zotero File Storage subscription.
- 📖 **Reads PDFs** — whole-document reads come from Zotero's full-text index when it has one;
  page ranges and outlines are extracted from the real file.
- 🔍 **Two searches** — `zotero_search` for literal text and fields, `zotero_semantic_search`
  for meaning, over Cloudflare AI Search (hybrid BM25 + vector, reranked, cron-synced).
- 📥 **Imports references** — resolve a DOI, arXiv id or ISBN to full metadata and attach an
  open-access PDF in one call.
- 🔐 **MCP 2026-07-28** — stateless Streamable HTTP, OAuth 2.1 with Client ID Metadata
  Documents, structured tool output, cache hints.

## Requirements

- A **Workers Paid** plan — PDF parsing needs more CPU time than the free plan's 10 ms budget.
- A Zotero account with an API key, and a WebDAV server that Zotero Desktop already syncs to.
- AI Search is in **open beta** and free within its limits; the Workers AI embedding and
  reranking calls it makes are billed separately.

## Quick start

```bash
git clone https://github.com/yousiki/cloudflare-zotero-mcp && cd cloudflare-zotero-mcp
bun install

# 1. Secrets
bun x wrangler secret put ZOTERO_API_KEY      # zotero.org/settings/keys, read+write
bun x wrangler secret put WEBDAV_URL          # the URL you gave Zotero; "/zotero" is appended
bun x wrangler secret put WEBDAV_USERNAME
bun x wrangler secret put WEBDAV_PASSWORD
bun x wrangler secret put AUTH_PASSWORD       # gates the OAuth login page — make it long

# 2. Ship. ZOTERO_MCP_DOMAIN is any hostname in a zone on this Cloudflare account;
#    the Custom Domain, KV namespaces and AI Search namespace are created for you.
export ZOTERO_MCP_DOMAIN=zotero-mcp.example.com
bun run deploy

# 3. Build the semantic index (the cron job would get there eventually).
bun run scripts/get-token.ts "https://$ZOTERO_MCP_DOMAIN" --out .token
bun run scripts/reindex.ts "https://$ZOTERO_MCP_DOMAIN/mcp" "$(cat .token)" --full
```

Then connect a client — the server is a normal OAuth-protected MCP endpoint at
`https://<your-domain>/mcp`:

```bash
claude mcp add --transport http zotero https://zotero-mcp.example.com/mcp
```

Your client opens the login page, you type the `AUTH_PASSWORD`, choose whether to grant
`zotero:write`, and it stores the token.

No custom domain, GitHub Actions deploys, static tokens for headless clients, optional
variables — see the **[deployment guide](docs/deployment.md)**.

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

## Documentation

| Document | Contents |
|---|---|
| [Deployment guide](docs/deployment.md) | Origins and domains, provisioning, optional variables, GitHub Actions CD, how WebDAV writes work |
| [Search guide](docs/search.md) | Choosing between the two search tools, asynchronous indexing, reading semantic scores, filters and limits |
| [AGENTS.md](AGENTS.md) | Architecture, layout, and the mistakes this codebase has already made |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Setup, checks to run, and scope |
| [SECURITY.md](SECURITY.md) | Trust model and how to report a vulnerability |

## Development

```bash
bun test                      # unit + protocol tests, no network
bun run typecheck && bun run lint
cp .dev.vars.example .dev.vars && bun run dev
```

AI Search has no local emulation, so `zotero_semantic_search` errors under `wrangler dev`; add
`"remote": true` to the `ai_search_namespaces` binding to use the real instance, or use
`zotero_search`. The decisive check for anything touching files is syncing Zotero Desktop and
confirming the item, the file and the filename all landed.

## Security

`AUTH_PASSWORD` is the only thing between the public internet and full read/write access to
your library, so make it long and random. [SECURITY.md](SECURITY.md) covers the trust model,
how to report a vulnerability, and the limits of the login throttling.

## License

[MIT](LICENSE) © yousiki (Siqi Yang)
