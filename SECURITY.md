# Security

## Reporting a vulnerability

Report privately through GitHub's
[security advisory form](https://github.com/yousiki/cloudflare-zotero-mcp/security/advisories/new)
rather than in a public issue. I aim to acknowledge within a week.

Include what an attacker gains, the version or commit you tested, and enough detail to
reproduce it. If it needs a deployed server, describe the setup rather than pointing me at
your own — I do not want access to anyone's library.

## What this software is

A **single-tenant** server: it holds one operator's Zotero API key and WebDAV credentials in
Worker secrets, and the `/authorize` password proves you are that operator. It is not built
to serve multiple users, and `AUTH_PASSWORD` is the only thing between the public internet
and full read/write access to your library and its files. Make it long and random.

Everyone deploys their own instance, so a fix ships as a commit you redeploy — there is no
central instance to patch on your behalf. Watch releases if you run this.

## Known limits, by design

**Login throttling is best-effort.** Failed `/authorize` attempts are counted per
`CF-Connecting-IP` in KV, which is eventually consistent, so concurrent requests can exceed
the 8-attempt ceiling before the counter catches up. It slows a brute force; it does not
stop one. Password strength is the real control.

**A token is as strong as the password.** Anyone who can complete the OAuth flow can mint a
token, and `scripts/get-token.ts` writes one to `.token` in plain text. That file is
gitignored — keep it that way, and treat it like a password.

**`zotero:write` is destructive.** It covers `zotero_delete_items` (with `permanent: true`,
bypassing the trash) and `zotero_delete_attachment`, which removes files from WebDAV. Untick
the scope at the consent screen for clients that only need to read.

**Rotating credentials.** `wrangler secret put <NAME>` then redeploy. Rotating
`AUTH_PASSWORD` does not invalidate tokens already issued — to cut those off, delete the
grants from the `OAUTH_KV` namespace.

## Out of scope

Vulnerabilities in Zotero, in a WebDAV server, or in Cloudflare's platform. Report those
upstream. Reports that amount to "the server trusts its own operator" are also out of scope —
that is the trust model.
