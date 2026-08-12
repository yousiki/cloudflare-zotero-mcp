#!/usr/bin/env bun
/**
 * Deploys the Worker to its one public origin.
 *
 *   ZOTERO_MCP_DOMAIN=zotero-mcp.example.com bun run deploy
 *   bun run deploy zotero-mcp.example.com --dry-run
 *
 * The hostname lives here rather than in wrangler.jsonc because wrangler does
 * not expand environment variables in its config file, and a fork should not
 * have to edit a tracked file to deploy. Extra flags are passed through to
 * `wrangler deploy`.
 *
 * Serving from workers.dev instead is a wrangler.jsonc change ("workers_dev":
 * true) plus a plain `bun x wrangler deploy`; see the comment in that file.
 */

const args = process.argv.slice(2);
// A bare "--" survives `bun run` in some argument positions, and wrangler reads
// everything after it as positional — which silently demotes a passed-through
// --dry-run into a real deploy. Drop it.
const forwarded = args.filter((argument) => argument !== '--');
const positional = forwarded.filter((argument) => !argument.startsWith('-'));
const passthrough = forwarded.filter((argument) => argument.startsWith('-'));

const domain = positional[0] ?? process.env.ZOTERO_MCP_DOMAIN;
if (!domain) {
  console.error(
    'No deploy domain. Set ZOTERO_MCP_DOMAIN or pass the hostname:\n' +
      '  ZOTERO_MCP_DOMAIN=zotero-mcp.example.com bun run deploy\n\n' +
      'It must be a hostname in a zone on this Cloudflare account. To use the\n' +
      'workers.dev origin instead, see the routing comment in wrangler.jsonc.',
  );
  process.exit(2);
}

// Custom Domain patterns are bare hostnames — no scheme, port, path or "/*".
// Wrangler's own error for these is opaque, so reject them up front.
if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(domain)) {
  console.error(`Not a bare hostname: ${domain}\nExpected e.g. zotero-mcp.example.com`);
  process.exit(2);
}

const { exitCode } = Bun.spawnSync({
  cmd: ['bun', 'x', 'wrangler', 'deploy', '--domain', domain, ...passthrough],
  stdio: ['inherit', 'inherit', 'inherit'],
});
process.exit(exitCode);
