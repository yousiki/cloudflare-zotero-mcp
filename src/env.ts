import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { ZoteroMcpContext } from './context.js';
import { AttachmentReader, type TextCache } from './core/attachment/read.js';
import { AttachmentWriter } from './core/attachment/write.js';
import {
  AiSearchSemanticIndex,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_RERANKING_MODEL,
} from './core/search/aisearch.js';
import { WebDavClient } from './core/webdav/client.js';
import { ZoteroClient } from './core/zotero/client.js';

export interface Env {
  // Bindings
  OAUTH_KV: KVNamespace;
  CACHE_KV: KVNamespace;
  AI_SEARCH?: AiSearchNamespace;
  OAUTH_PROVIDER: OAuthHelpers;

  // Secrets
  ZOTERO_API_KEY: string;
  ZOTERO_LIBRARY_ID?: string;
  WEBDAV_URL?: string;
  WEBDAV_USERNAME?: string;
  WEBDAV_PASSWORD?: string;
  AUTH_PASSWORD: string;

  // Vars
  ZOTERO_LIBRARY_TYPE?: string;
  AUTH_USERNAME?: string;
  CONTACT_EMAIL?: string;
  EMBEDDING_MODEL?: string;
  RERANKING_MODEL?: string;
  AI_SEARCH_INSTANCE?: string;
  SYNC_BATCH_LIMIT?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function zoteroClient(env: Env): ZoteroClient {
  if (!env.ZOTERO_API_KEY) {
    throw new ConfigError('ZOTERO_API_KEY is not set. Run: wrangler secret put ZOTERO_API_KEY');
  }
  return new ZoteroClient({
    apiKey: env.ZOTERO_API_KEY,
    libraryId: env.ZOTERO_LIBRARY_ID || undefined,
    libraryType: env.ZOTERO_LIBRARY_TYPE === 'group' ? 'group' : 'user',
  });
}

export function webdavClient(env: Env): WebDavClient | null {
  if (!env.WEBDAV_URL || !env.WEBDAV_USERNAME || !env.WEBDAV_PASSWORD) return null;
  return new WebDavClient({
    url: env.WEBDAV_URL,
    username: env.WEBDAV_USERNAME,
    password: env.WEBDAV_PASSWORD,
  });
}

export function semanticIndex(env: Env): AiSearchSemanticIndex | null {
  if (!env.AI_SEARCH) return null;
  return new AiSearchSemanticIndex(env.AI_SEARCH, {
    instance: env.AI_SEARCH_INSTANCE || 'zotero-items',
    embeddingModel: env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL,
    rerankingModel: env.RERANKING_MODEL || DEFAULT_RERANKING_MODEL,
  });
}

/** KV-backed cache for extracted PDF text, keyed by attachment key + md5. */
export function textCache(env: Env): TextCache {
  return {
    get: (key) => env.CACHE_KV.get(key),
    put: (key, value, ttlSeconds) =>
      env.CACHE_KV.put(key, value, ttlSeconds ? { expirationTtl: ttlSeconds } : undefined),
  };
}

export function buildContext(env: Env, scopes: string[]): ZoteroMcpContext {
  const zotero = zoteroClient(env);
  const webdav = webdavClient(env);
  const store = textCache(env);
  return {
    zotero,
    webdav,
    reader: new AttachmentReader(zotero, webdav, store),
    writer: new AttachmentWriter(zotero, webdav),
    semantic: semanticIndex(env),
    store,
    scopes,
    contactEmail: env.CONTACT_EMAIL,
  };
}
/** How many items one sync run may submit before deferring the rest. */
export function syncBatchLimit(env: Env): number {
  const configured = Number(env.SYNC_BATCH_LIMIT);
  // Matches DEFAULT_BATCH in jobs/index-sync.ts: one upload per item, and every
  // upload is a subrequest.
  return Number.isFinite(configured) && configured > 0 ? configured : 100;
}
