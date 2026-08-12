#!/usr/bin/env bun
/**
 * Drives `zotero_reindex` until the semantic index has caught up, since one
 * call only embeds a batch.
 *
 *   bun run scripts/reindex.ts <mcp-url> <token> [--full]
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const [endpoint, token] = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
const full = process.argv.includes('--full');

if (!endpoint || !token) {
  console.error('usage: bun run scripts/reindex.ts <mcp-url> <token> [--full]');
  process.exit(2);
}

const client = new Client({ name: 'zotero-mcp-reindex', version: '0.1.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
);

let round = 0;
let totalIndexed = 0;
for (;;) {
  round++;
  const result = await client.callTool({
    name: 'zotero_reindex',
    // Only the first round may reset the cursor; later rounds must resume.
    arguments: { full: full && round === 1 },
  });

  if (result.isError) {
    console.error(JSON.stringify(result.content));
    process.exit(1);
  }

  const report = result.structuredContent as {
    indexed: number;
    removed: number;
    remaining: number;
    complete: boolean;
    message: string;
  };
  totalIndexed += report.indexed;
  console.log(
    `round ${round}: +${report.indexed} embedded, ${report.removed} removed, ${report.remaining} queued`,
  );

  if (report.complete) {
    console.log(`\n${report.message}\nEmbedded ${totalIndexed} item(s) across ${round} round(s).`);
    break;
  }
  if (round >= 50) {
    console.error('\nStopping after 50 rounds; run again to continue.');
    break;
  }
}

await client.close();
