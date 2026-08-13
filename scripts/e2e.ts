#!/usr/bin/env bun
/**
 * End-to-end smoke test against a running server (local `wrangler dev` or a
 * deployment), using a real MCP client over Streamable HTTP.
 *
 *   bun run scripts/e2e.ts http://localhost:8787/mcp [access-token]
 *
 * Read-only by default. Pass --write to exercise the full write path:
 * create an item, attach a small PDF, read it back, rename it, then clean up.
 * That leaves nothing behind, but it does touch the real library and WebDAV.
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const [endpoint, token] = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
const withWrites = process.argv.includes('--write');

if (!endpoint) {
  console.error('usage: bun run scripts/e2e.ts <url> [token] [--write]');
  process.exit(2);
}

/** A minimal but structurally valid one-page PDF. */
const TINY_PDF = [
  '%PDF-1.4',
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj',
  'trailer<</Root 1 0 R>>',
  '%%EOF',
].join('\n');

let failures = 0;

async function step<T>(name: string, run: () => Promise<T>): Promise<T | undefined> {
  const started = Date.now();
  try {
    const result = await run();
    console.log(`  ok   ${name} (${Date.now() - started}ms)`);
    return result;
  } catch (error) {
    failures++;
    console.error(`  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function textOf(result: { content?: unknown }): string {
  const blocks = (result.content ?? []) as Array<{ type?: string; text?: string }>;
  return blocks
    .map((block) => block.text ?? '')
    .join('\n')
    .trim();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
  requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
});
const client = new Client({ name: 'zotero-mcp-e2e', version: '0.1.0' });

console.log(`\nConnecting to ${endpoint}`);
await client.connect(transport);

console.log('\nRead-only checks');

await step('tools/list exposes the full catalogue', async () => {
  const { tools } = await client.listTools();
  assert(tools.length >= 16, `expected at least 16 tools, saw ${tools.length}`);
  assert(
    tools.some((tool) => tool.name === 'zotero_read_attachment'),
    'zotero_read_attachment is missing',
  );
  for (const name of ['zotero_search', 'zotero_semantic_search']) {
    assert(
      tools.some((tool) => tool.name === name),
      `${name} is missing`,
    );
  }
});

const someKey = await step('zotero_search finds something', async () => {
  const result = await client.callTool({ name: 'zotero_search', arguments: { limit: 5 } });
  assert(!result.isError, textOf(result));
  const items = (result.structuredContent as { items?: Array<{ key: string }> })?.items ?? [];
  assert(items.length > 0, 'the library returned no items');
  return items[0]?.key;
});

await step('zotero_semantic_search ranks by meaning', async () => {
  let failure: string | undefined;
  const result = await client
    .callTool({
      name: 'zotero_semantic_search',
      arguments: { query: 'machine learning', limit: 5 },
    })
    .catch((error: unknown) => {
      failure = error instanceof Error ? error.message : String(error);
      return undefined;
    });
  const refusal = failure ?? (result?.isError ? textOf(result) : undefined);
  if (refusal !== undefined) {
    // AI Search is an optional binding. Without it the tool refuses by design and
    // names the fallback, which is a deployment shape rather than a failure.
    assert(
      refusal.includes('AI Search is not bound') && refusal.includes('zotero_search'),
      refusal,
    );
    console.log('  note AI Search is unbound on this deployment; semantic search skipped');
    return;
  }
  const body = result?.structuredContent as
    | {
        items: Array<{ key: string; score?: number }>;
        minScore: number;
        scored: number;
        belowThreshold: number;
        unscored: number;
      }
    | undefined;
  assert(body !== undefined, 'the result carried no structured content');
  const items = body.items ?? [];
  assert(typeof body.minScore === 'number', 'minScore is missing from the result');
  // Hybrid retrieval leaves some rows without a score, so the counts have to
  // account for every item instead of every item carrying a number.
  assert(
    body.scored + body.unscored === items.length,
    `scored (${body.scored}) + unscored (${body.unscored}) should cover ${items.length} item(s)`,
  );
  assert(
    body.belowThreshold <= body.scored,
    `belowThreshold (${body.belowThreshold}) should only count scored items (${body.scored})`,
  );
  assert(
    items.every((item) => item.score === undefined || (item.score >= 0 && item.score <= 1)),
    'a score fell outside 0-1',
  );
});

await step('zotero_list_collections returns the tree', async () => {
  const result = await client.callTool({ name: 'zotero_list_collections', arguments: {} });
  assert(!result.isError, textOf(result));
});

if (someKey) {
  await step(`zotero_get_item reads ${someKey}`, async () => {
    const result = await client.callTool({
      name: 'zotero_get_item',
      arguments: { key: someKey, includeChildren: true },
    });
    assert(!result.isError, textOf(result));
  });
}

if (withWrites) {
  console.log('\nWrite checks');

  const itemKey = await step('zotero_create_items creates a scratch item', async () => {
    const result = await client.callTool({
      name: 'zotero_create_items',
      arguments: {
        items: [
          {
            itemType: 'journalArticle',
            title: 'zotero-mcp end-to-end scratch item',
            creators: [{ creatorType: 'author', lastName: 'Testerson', firstName: 'Testy' }],
            fields: { date: '2020-01-01' },
            tags: [{ tag: 'zotero-mcp-e2e' }],
          },
        ],
      },
    });
    assert(!result.isError, textOf(result));
    const created = (result.structuredContent as { created: string[] }).created;
    assert(created.length === 1, 'no item was created');
    return created[0] as string;
  });

  const attachmentKey = itemKey
    ? await step('zotero_put_attachment uploads a PDF to WebDAV', async () => {
        const result = await client.callTool({
          name: 'zotero_put_attachment',
          arguments: {
            parentItemKey: itemKey,
            filename: 'scratch.pdf',
            contentType: 'application/pdf',
            base64Data: Buffer.from(TINY_PDF, 'utf8').toString('base64'),
          },
        });
        assert(!result.isError, textOf(result));
        return (result.structuredContent as { attachmentKey: string }).attachmentKey;
      })
    : undefined;

  if (attachmentKey) {
    await step('zotero_read_attachment reads it back off WebDAV', async () => {
      const result = await client.callTool({
        name: 'zotero_read_attachment',
        arguments: { itemKey: attachmentKey, mode: 'info', forceFile: true },
      });
      assert(!result.isError, textOf(result));
      assert(textOf(result).includes('on WebDAV: yes'), 'the file is not on WebDAV');
    });

    await step('zotero_rename_attachments plans a rename', async () => {
      const result = await client.callTool({
        name: 'zotero_rename_attachments',
        arguments: { itemKeys: [itemKey], apply: false },
      });
      assert(!result.isError, textOf(result));
      assert(
        textOf(result).includes('Testerson - 2020 - zotero-mcp end-to-end scratch item.pdf'),
        `unexpected rename plan:\n${textOf(result)}`,
      );
    });

    await step('zotero_delete_attachment removes the file and item', async () => {
      const result = await client.callTool({
        name: 'zotero_delete_attachment',
        arguments: { attachmentKey },
      });
      assert(!result.isError, textOf(result));
    });
  }

  if (itemKey) {
    await step('zotero_delete_items cleans up the scratch item', async () => {
      const result = await client.callTool({
        name: 'zotero_delete_items',
        arguments: { keys: [itemKey], permanent: true },
      });
      assert(!result.isError, textOf(result));
    });
  }
}

await client.close();

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
