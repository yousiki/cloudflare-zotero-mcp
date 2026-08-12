import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { ZoteroMcpContext } from './context.js';
import { formatCollectionTree, formatItemDetail, itemSummary } from './core/format/items.js';
import { base64Encode } from './core/http.js';
import { registerAttachmentTools } from './tools/attachments.js';
import { registerCollectionTools } from './tools/collections.js';
import { registerImportTools } from './tools/import.js';
import { registerItemTools } from './tools/items.js';
import { registerMaintenanceTools } from './tools/maintenance.js';
import { registerNoteTools } from './tools/notes.js';
import { registerSearchTools } from './tools/search.js';

export const SERVER_NAME = 'zotero-mcp';
export const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = `Read/write access to a Zotero library whose files live on WebDAV.

Start with zotero_search to find items, then zotero_get_item for full metadata and
zotero_read_attachment for the text of a PDF. Attachment reads accept a parent item key
and pick the right PDF themselves.

Files are stored on the user's own WebDAV server, not Zotero's. Uploads land there
immediately, but they only appear in Zotero Desktop after its next sync.`;

/**
 * Builds a fresh server for one request. The MCP 2026-07-28 protocol is
 * stateless, so nothing here may outlive the request that created it.
 */
export function createServer(context: ZoteroMcpContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: 'Zotero (WebDAV)' },
    {
      instructions: INSTRUCTIONS,
      // The tool catalogue is static, so clients can hold it across reconnects
      // and keep their prompt caches warm.
      cacheHints: {
        'tools/list': { ttlMs: 3_600_000, cacheScope: 'public' },
        'prompts/list': { ttlMs: 3_600_000, cacheScope: 'public' },
      },
    },
  );

  registerSearchTools(server, context);
  registerItemTools(server, context);
  registerCollectionTools(server, context);
  registerNoteTools(server, context);
  registerAttachmentTools(server, context);
  registerImportTools(server, context);
  registerMaintenanceTools(server, context);
  registerResources(server, context);
  registerPrompts(server);

  return server;
}

function registerResources(server: McpServer, context: ZoteroMcpContext): void {
  server.registerResource(
    'zotero-item',
    new ResourceTemplate('zotero://item/{key}', { list: undefined }),
    {
      title: 'Zotero item',
      description: 'Full metadata for one item, as Markdown.',
      mimeType: 'text/markdown',
    },
    async (uri, variables) => {
      const key = String(variables.key);
      const item = await context.zotero.getItem(key);
      const children = await context.zotero.getItemChildren(key);
      return {
        contents: [
          { uri: uri.href, mimeType: 'text/markdown', text: formatItemDetail(item, children) },
        ],
      };
    },
  );

  server.registerResource(
    'zotero-attachment',
    new ResourceTemplate('zotero://attachment/{key}', { list: undefined }),
    {
      title: 'Zotero attachment file',
      description:
        'The raw attachment file from WebDAV, base64 encoded. Hosts that render PDFs can read it directly; otherwise use zotero_read_attachment.',
      mimeType: 'application/pdf',
    },
    async (uri, variables) => {
      const file = await context.reader.download(String(variables.key));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: file.contentType,
            blob: base64Encode(file.data),
          },
        ],
      };
    },
  );

  server.registerResource(
    'zotero-collections',
    'zotero://collections',
    {
      title: 'Collection tree',
      description: 'Every collection in the library, as an indented tree.',
      mimeType: 'text/markdown',
      cacheHint: { ttlMs: 300_000, cacheScope: 'private' },
    },
    async (uri) => {
      const page = await context.zotero.getCollections({}, 500);
      return {
        contents: [
          { uri: uri.href, mimeType: 'text/markdown', text: formatCollectionTree(page.items) },
        ],
      };
    },
  );

  server.registerResource(
    'zotero-recent',
    'zotero://recent',
    {
      title: 'Recently added items',
      description: 'The 25 most recently added items.',
      mimeType: 'application/json',
      cacheHint: { ttlMs: 60_000, cacheScope: 'private' },
    },
    async (uri) => {
      const page = await context.zotero.getItems({ sort: 'dateAdded', direction: 'desc' }, 25);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(page.items.map(itemSummary), null, 2),
          },
        ],
      };
    },
  );
}

function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'literature-review',
    {
      title: 'Literature review from a collection',
      description:
        'Draft a thematic review of a Zotero collection, grounded in the items and their annotations.',
      argsSchema: z.object({
        collectionKey: z.string().describe('Collection key, e.g. MT53KB66'),
        focus: z.string().optional().describe('Optional angle to emphasise'),
      }),
    },
    ({ collectionKey, focus }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Review the Zotero collection ${collectionKey}.`,
              '',
              '1. Call zotero_list_collections with this collectionKey to list its items.',
              '2. For the ones that matter, call zotero_get_item and zotero_read_attachment.',
              '3. Call zotero_annotations to pick up existing highlights.',
              '',
              focus ? `Focus on: ${focus}.` : '',
              'Group the writeup by theme rather than by paper, cite every claim with the item key,',
              'and call out disagreements between sources instead of smoothing them over.',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        },
      ],
    }),
  );
}
