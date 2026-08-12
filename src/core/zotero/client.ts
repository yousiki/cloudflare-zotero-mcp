import { BackoffGate, type FetchLike, Limiter, parseRetryAfter, sleep } from '../http.js';
import type {
  LibraryType,
  QueryParams,
  ZoteroCollection,
  ZoteroFulltext,
  ZoteroItem,
  ZoteroItemData,
  ZoteroPage,
  ZoteroTagEntry,
  ZoteroWriteResponse,
} from './types.js';

const API_BASE = 'https://api.zotero.org';
const API_VERSION = '3';
/** Zotero rejects write requests carrying more than 50 objects. */
export const WRITE_BATCH_SIZE = 50;
/** Server-side maximum for `limit`. */
export const MAX_PAGE_SIZE = 100;

export class ZoteroApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Zotero API ${method} ${path} failed with ${status}: ${body.slice(0, 500)}`);
    this.name = 'ZoteroApiError';
  }
}

/**
 * Raised on 412, meaning the library or object changed since the version we
 * based the write on. Callers should re-read and decide, never blindly retry.
 */
export class ZoteroConflictError extends ZoteroApiError {
  constructor(method: string, path: string, body: string) {
    super(412, method, path, body);
    this.name = 'ZoteroConflictError';
  }
}

export interface ZoteroClientOptions {
  apiKey: string;
  /** Numeric user or group id. Auto-detected from the API key when omitted. */
  libraryId?: string | number;
  libraryType?: LibraryType;
  fetch?: FetchLike;
  /** Override for tests. */
  baseUrl?: string;
  maxRetries?: number;
}

interface RequestOptions {
  method?: string;
  query?: QueryParams;
  body?: string;
  contentType?: string;
  /** Optimistic-lock header for writes. */
  ifUnmodifiedSinceVersion?: number;
  /** Conditional-GET header for syncing. */
  ifModifiedSinceVersion?: number;
  writeToken?: string;
  accept?: string;
}

export interface ZoteroResponse {
  response: Response;
  lastModifiedVersion: number;
  totalResults?: number;
}

export class ZoteroClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly doFetch: FetchLike;
  private readonly limiter = new Limiter(4);
  private readonly backoff = new BackoffGate();
  private readonly maxRetries: number;
  private libraryType: LibraryType;
  private libraryId?: string;
  private resolving?: Promise<string>;

  constructor(options: ZoteroClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? API_BASE;
    this.doFetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.maxRetries = options.maxRetries ?? 4;
    this.libraryType = options.libraryType ?? 'user';
    this.libraryId = options.libraryId !== undefined ? String(options.libraryId) : undefined;
  }

  /** `/users/<id>` or `/groups/<id>`, resolving the id from the key if needed. */
  async prefix(): Promise<string> {
    const id = await this.resolveLibraryId();
    return `/${this.libraryType === 'group' ? 'groups' : 'users'}/${id}`;
  }

  async resolveLibraryId(): Promise<string> {
    if (this.libraryId) return this.libraryId;
    this.resolving ??= this.fetchCurrentKey();
    this.libraryId = await this.resolving;
    return this.libraryId;
  }

  private async fetchCurrentKey(): Promise<string> {
    const { response } = await this.request('/keys/current');
    const info = (await response.json()) as { userID?: number };
    if (!info.userID) {
      throw new Error('Could not determine the Zotero library id from the API key');
    }
    return String(info.userID);
  }

  /* ---------------------------------------------------------------------- */
  /* Transport                                                               */
  /* ---------------------------------------------------------------------- */

  async request(path: string, options: RequestOptions = {}): Promise<ZoteroResponse> {
    const url = this.baseUrl + path + buildQuery(options.query);
    const method = options.method ?? 'GET';

    const headers: Record<string, string> = {
      'Zotero-API-Version': API_VERSION,
      'Zotero-API-Key': this.apiKey,
    };
    if (options.contentType) headers['Content-Type'] = options.contentType;
    if (options.accept) headers.Accept = options.accept;
    if (options.writeToken) headers['Zotero-Write-Token'] = options.writeToken;
    if (options.ifUnmodifiedSinceVersion !== undefined) {
      headers['If-Unmodified-Since-Version'] = String(options.ifUnmodifiedSinceVersion);
    }
    if (options.ifModifiedSinceVersion !== undefined) {
      headers['If-Modified-Since-Version'] = String(options.ifModifiedSinceVersion);
    }

    let attempt = 0;
    for (;;) {
      await this.backoff.wait();
      const response = await this.limiter.run(() =>
        this.doFetch(url, { method, headers, body: options.body }),
      );
      this.backoff.noteResponse(response);

      if (response.status === 429 || response.status === 503) {
        if (attempt >= this.maxRetries) {
          throw new ZoteroApiError(response.status, method, path, await safeText(response));
        }
        const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
        await sleep(retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 500);
        attempt++;
        continue;
      }

      if (response.status === 412) {
        throw new ZoteroConflictError(method, path, await safeText(response));
      }

      if (!response.ok && response.status !== 304) {
        throw new ZoteroApiError(response.status, method, path, await safeText(response));
      }

      return {
        response,
        lastModifiedVersion: Number(response.headers.get('Last-Modified-Version') ?? 0),
        totalResults: numberOrUndefined(response.headers.get('Total-Results')),
      };
    }
  }

  private async getJson<T>(path: string, query?: QueryParams): Promise<ZoteroPage<T>> {
    const { response, lastModifiedVersion, totalResults } = await this.request(path, { query });
    const items = (await response.json()) as T[];
    return { items, lastModifiedVersion, totalResults };
  }

  /** Walks `start`/`limit` pagination until `max` results or the library ends. */
  private async getAll<T>(path: string, query: QueryParams, max: number): Promise<ZoteroPage<T>> {
    const collected: T[] = [];
    let lastModifiedVersion = 0;
    let totalResults: number | undefined;
    let start = 0;

    while (collected.length < max) {
      const pageSize = Math.min(MAX_PAGE_SIZE, max - collected.length);
      const page = await this.getJson<T>(path, { ...query, start, limit: pageSize });
      lastModifiedVersion = page.lastModifiedVersion;
      totalResults ??= page.totalResults;
      collected.push(...page.items);
      if (page.items.length < pageSize) break;
      start += page.items.length;
    }

    return { items: collected, lastModifiedVersion, totalResults };
  }

  /* ---------------------------------------------------------------------- */
  /* Reads                                                                   */
  /* ---------------------------------------------------------------------- */

  async getItems(query: QueryParams = {}, max = 50): Promise<ZoteroPage<ZoteroItem>> {
    return this.getAll<ZoteroItem>(`${await this.prefix()}/items`, query, max);
  }

  async getTopItems(query: QueryParams = {}, max = 50): Promise<ZoteroPage<ZoteroItem>> {
    return this.getAll<ZoteroItem>(`${await this.prefix()}/items/top`, query, max);
  }

  async getTrashItems(query: QueryParams = {}, max = 50): Promise<ZoteroPage<ZoteroItem>> {
    return this.getAll<ZoteroItem>(`${await this.prefix()}/items/trash`, query, max);
  }

  async getCollectionItems(
    collectionKey: string,
    query: QueryParams = {},
    max = 50,
    topOnly = false,
  ): Promise<ZoteroPage<ZoteroItem>> {
    const suffix = topOnly ? '/items/top' : '/items';
    return this.getAll<ZoteroItem>(
      `${await this.prefix()}/collections/${collectionKey}${suffix}`,
      query,
      max,
    );
  }

  async getItem(key: string, query: QueryParams = {}): Promise<ZoteroItem> {
    const { response } = await this.request(`${await this.prefix()}/items/${key}`, { query });
    return (await response.json()) as ZoteroItem;
  }

  async getItemChildren(key: string, query: QueryParams = {}): Promise<ZoteroItem[]> {
    const page = await this.getAll<ZoteroItem>(
      `${await this.prefix()}/items/${key}/children`,
      query,
      MAX_PAGE_SIZE,
    );
    return page.items;
  }

  /** Raw export formats (`bibtex`, `csljson`, `ris`, …). */
  async exportItems(keys: string[], format: string, style?: string): Promise<string> {
    const { response } = await this.request(`${await this.prefix()}/items`, {
      query: { itemKey: keys.join(','), format, style },
    });
    return response.text();
  }

  /**
   * Server-side full-text index for an attachment. Present for WebDAV users too,
   * because full-text content syncs independently of file storage — but only if
   * the desktop client has indexed the file at least once.
   */
  async getFulltext(attachmentKey: string): Promise<ZoteroFulltext | null> {
    try {
      const { response } = await this.request(
        `${await this.prefix()}/items/${attachmentKey}/fulltext`,
      );
      return (await response.json()) as ZoteroFulltext;
    } catch (error) {
      if (error instanceof ZoteroApiError && error.status === 404) return null;
      throw error;
    }
  }

  async putFulltext(attachmentKey: string, fulltext: ZoteroFulltext): Promise<void> {
    await this.request(`${await this.prefix()}/items/${attachmentKey}/fulltext`, {
      method: 'PUT',
      contentType: 'application/json',
      body: JSON.stringify(fulltext),
    });
  }

  async getCollections(query: QueryParams = {}, max = 200): Promise<ZoteroPage<ZoteroCollection>> {
    return this.getAll<ZoteroCollection>(`${await this.prefix()}/collections`, query, max);
  }

  async getCollection(key: string): Promise<ZoteroCollection> {
    const { response } = await this.request(`${await this.prefix()}/collections/${key}`);
    return (await response.json()) as ZoteroCollection;
  }

  async getTags(query: QueryParams = {}, max = 200): Promise<ZoteroPage<ZoteroTagEntry>> {
    return this.getAll<ZoteroTagEntry>(`${await this.prefix()}/tags`, query, max);
  }

  /** Blank item shell for a type, so writes carry every field the server expects. */
  async getTemplate(itemType: string, linkMode?: string): Promise<ZoteroItemData> {
    const { response } = await this.request('/items/new', {
      query: { itemType, linkMode },
    });
    return (await response.json()) as ZoteroItemData;
  }

  /** Item keys changed since `version`, for incremental syncing. */
  async getItemVersions(
    since: number,
  ): Promise<{ versions: Record<string, number>; library: number }> {
    const { response, lastModifiedVersion } = await this.request(`${await this.prefix()}/items`, {
      query: { since, format: 'versions', includeTrashed: 1 },
    });
    return {
      versions: (await response.json()) as Record<string, number>,
      library: lastModifiedVersion,
    };
  }

  async getDeleted(since: number): Promise<{ items: string[]; collections: string[] }> {
    const { response } = await this.request(`${await this.prefix()}/deleted`, { query: { since } });
    const body = (await response.json()) as { items?: string[]; collections?: string[] };
    return { items: body.items ?? [], collections: body.collections ?? [] };
  }

  /* ---------------------------------------------------------------------- */
  /* Writes                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Creates or updates objects in batches of 50. `objects` carrying a `key` and
   * `version` are updated; the rest are created.
   */
  async writeObjects(
    kind: 'items' | 'collections',
    objects: Array<Record<string, unknown>>,
    options: { ifUnmodifiedSinceVersion?: number } = {},
  ): Promise<ZoteroWriteResponse> {
    const merged: ZoteroWriteResponse = { success: {}, unchanged: {}, failed: {}, successful: {} };
    const prefix = await this.prefix();

    for (let offset = 0; offset < objects.length; offset += WRITE_BATCH_SIZE) {
      const batch = objects.slice(offset, offset + WRITE_BATCH_SIZE);
      const { response } = await this.request(`${prefix}/${kind}`, {
        method: 'POST',
        contentType: 'application/json',
        body: JSON.stringify(batch),
        writeToken: crypto.randomUUID().replace(/-/g, ''),
        ifUnmodifiedSinceVersion: options.ifUnmodifiedSinceVersion,
      });
      const result = (await response.json()) as ZoteroWriteResponse;
      // Re-index into the caller's coordinate space so indexes stay meaningful
      // across batches.
      for (const [index, value] of Object.entries(result.success ?? {})) {
        merged.success[String(offset + Number(index))] = value;
      }
      for (const [index, value] of Object.entries(result.unchanged ?? {})) {
        merged.unchanged[String(offset + Number(index))] = value;
      }
      for (const [index, value] of Object.entries(result.failed ?? {})) {
        merged.failed[String(offset + Number(index))] = value;
      }
      for (const [index, value] of Object.entries(result.successful ?? {})) {
        (merged.successful as Record<string, ZoteroItem>)[String(offset + Number(index))] = value;
      }
    }

    return merged;
  }

  /** Partial update of a single item. `version` guards against lost updates. */
  async patchItem(key: string, patch: Record<string, unknown>, version: number): Promise<void> {
    await this.request(`${await this.prefix()}/items/${key}`, {
      method: 'PATCH',
      contentType: 'application/json',
      body: JSON.stringify(patch),
      ifUnmodifiedSinceVersion: version,
    });
  }

  async patchCollection(
    key: string,
    patch: Record<string, unknown>,
    version: number,
  ): Promise<void> {
    await this.request(`${await this.prefix()}/collections/${key}`, {
      method: 'PATCH',
      contentType: 'application/json',
      body: JSON.stringify(patch),
      ifUnmodifiedSinceVersion: version,
    });
  }

  /**
   * Permanently removes one item, locked against that item's own version.
   *
   * The multi-key endpoint can only be locked against the *library* version, so
   * anything else writing to the library — Zotero Desktop syncing, a second
   * agent, our own previous delete — turns the request into a 412. Deleting one
   * key at a time avoids that entirely.
   */
  async deleteItem(key: string, version: number): Promise<void> {
    await this.request(`${await this.prefix()}/items/${key}`, {
      method: 'DELETE',
      ifUnmodifiedSinceVersion: version,
    });
  }

  async deleteCollection(key: string, version: number): Promise<void> {
    await this.request(`${await this.prefix()}/collections/${key}`, {
      method: 'DELETE',
      ifUnmodifiedSinceVersion: version,
    });
  }
}

function buildQuery(params?: QueryParams): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      // Repeated params mean AND in Zotero's tag/itemType syntax.
      for (const entry of value) search.append(key, entry);
    } else {
      search.set(key, String(value));
    }
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function numberOrUndefined(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
