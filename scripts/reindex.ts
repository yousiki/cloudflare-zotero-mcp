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

/** Rounds spent submitting, and then rounds spent waiting for indexing to finish. */
const MAX_SUBMIT_ROUNDS = 50;
const MAX_DRAIN_ROUNDS = 60;
const DRAIN_INTERVAL_MS = 10_000;

interface Report {
  submitted: number;
  removed: number;
  remaining: number;
  backlog: number | null;
  failed: number | null;
  complete: boolean;
  warning: string | null;
  message: string;
}

async function reindex(reset: boolean): Promise<Report> {
  const result = await client.callTool({ name: 'zotero_reindex', arguments: { full: reset } });
  if (result.isError) {
    console.error(JSON.stringify(result.content));
    process.exit(1);
  }
  return result.structuredContent as Report;
}

let round = 0;
let totalSubmitted = 0;
let last: Report | null = null;

for (;;) {
  round++;
  // Only the first round may reset the cursor; later rounds must resume.
  const report = await reindex(full && round === 1);
  last = report;
  totalSubmitted += report.submitted;
  console.log(
    `round ${round}: +${report.submitted} submitted, ${report.removed} removed, ${report.remaining} queued locally, ${report.backlog ?? 'unknown'} indexing`,
  );
  // Once, not per round: this is the script you run after rebuilding the
  // instance, so it is where a chunk_size that did not take gets noticed.
  if (round === 1 && report.warning) console.warn(`\n! ${report.warning}\n`);

  if (report.complete) break;
  if (round >= MAX_SUBMIT_ROUNDS) {
    console.error(`\nStopping after ${MAX_SUBMIT_ROUNDS} rounds; run again to continue.`);
    process.exit(1);
  }
}

console.log(`\n${last.message}\nSubmitted ${totalSubmitted} item(s) across ${round} round(s).`);

// Submitting is not indexing. The whole point of this script is "the index has
// caught up", so exiting on `complete` would report success while the library is
// still only half searchable.
let drained = 0;
while (last.backlog !== 0) {
  if (last.backlog === null) {
    console.error('\nAI Search could not be asked how much is left to index; state unknown.');
    process.exit(1);
  }
  if (drained >= MAX_DRAIN_ROUNDS) {
    console.error(
      `\n${last.backlog} document(s) still indexing after waiting; run again to check.`,
    );
    process.exit(1);
  }
  drained++;
  console.log(`waiting: ${last.backlog} document(s) still indexing`);
  const wait = Promise.withResolvers<void>();
  setTimeout(wait.resolve, DRAIN_INTERVAL_MS);
  await wait.promise;
  last = await reindex(false);
}

if (last.failed === null || last.failed > 0) {
  console.error(`\n${last.failed ?? 'An unknown number of'} document(s) failed to index.`);
  await client.close();
  process.exit(1);
}

console.log('\nThe index has caught up.');
await client.close();
