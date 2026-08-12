import type { AttachmentReader, TextCache } from './core/attachment/read.js';
import type { AttachmentWriter } from './core/attachment/write.js';
import type { SemanticIndex } from './core/search/types.js';
import type { WebDavClient } from './core/webdav/client.js';
import type { ZoteroClient } from './core/zotero/client.js';

export const SCOPE_READ = 'zotero:read';
export const SCOPE_WRITE = 'zotero:write';
export const ALL_SCOPES = [SCOPE_READ, SCOPE_WRITE] as const;

/** Everything a tool handler needs, assembled once per request. */
export interface ZoteroMcpContext {
  zotero: ZoteroClient;
  webdav: WebDavClient | null;
  reader: AttachmentReader;
  writer: AttachmentWriter;
  semantic: SemanticIndex | null;
  /** Durable key/value used for extracted text and the semantic sync cursor. */
  store: TextCache;
  /** Scopes granted by the access token backing this request. */
  scopes: string[];
  /** Sent to CrossRef/OpenAlex for polite-pool access. Optional. */
  contactEmail?: string;
}

export class ScopeError extends Error {
  constructor(required: string) {
    super(
      `This tool needs the "${required}" scope, which the current access token does not grant. Re-authorize and approve write access.`,
    );
    this.name = 'ScopeError';
  }
}

export function assertWritable(context: ZoteroMcpContext): void {
  if (!context.scopes.includes(SCOPE_WRITE)) throw new ScopeError(SCOPE_WRITE);
}
