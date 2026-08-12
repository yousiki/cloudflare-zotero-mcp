import type { TextCache } from '../core/attachment/read.js';
import { isIndexable } from '../core/search/semantic.js';
import type { SemanticIndex } from '../core/search/types.js';
import type { ZoteroClient } from '../core/zotero/client.js';

const STATE_KEY = 'vectorize:sync-state';
const DEFAULT_BATCH = 400;
/** Zotero accepts at most 50 keys per itemKey lookup. */
const KEY_CHUNK = 50;

/**
 * Where the incremental sync left off.
 *
 * `since` only advances once `pending` drains, so a run that is cut short by
 * CPU or neuron limits resumes exactly where it stopped instead of skipping
 * items or re-embedding the whole library.
 */
interface SyncState {
  since: number;
  target: number;
  pending: string[];
}

export interface SyncReport {
  indexed: number;
  removed: number;
  remaining: number;
  fromVersion: number;
  toVersion: number;
  complete: boolean;
  message: string;
}

export interface SyncOptions {
  zotero: ZoteroClient;
  /** Null when Vectorize or Workers AI is unbound. */
  index: SemanticIndex | null;
  /** Holds the resume cursor between runs. */
  store: TextCache;
  /** Maximum items embedded in this run. */
  limit?: number;
  /** Discard the cursor and re-embed the whole library. */
  full?: boolean;
}

export async function syncVectorIndex(options: SyncOptions): Promise<SyncReport> {
  const { zotero, index, store } = options;
  if (!index) {
    return emptyReport('Vectorize or Workers AI is not bound, so semantic search is disabled.');
  }

  const limit = options.limit ?? DEFAULT_BATCH;

  const saved = options.full ? null : await readState(store);
  // A saved state with a non-empty queue is resumed; otherwise start a new cycle.
  let state = saved && saved.pending.length > 0 ? saved : null;
  let removed = 0;

  if (!state) {
    const since = options.full ? 0 : (saved?.since ?? 0);
    const { versions, library } = await zotero.getItemVersions(since);
    const pending = Object.keys(versions);

    // Deletions are cheap and idempotent, so handle them up front.
    if (since > 0) {
      const deleted = await zotero.getDeleted(since);
      if (deleted.items.length > 0) {
        await index.removeItems(deleted.items);
        removed = deleted.items.length;
      }
    }

    state = { since, target: library, pending };
    if (pending.length === 0) {
      await writeState(store, { since: library, target: library, pending: [] });
      return {
        indexed: 0,
        removed,
        remaining: 0,
        fromVersion: since,
        toVersion: library,
        complete: true,
        message: `Nothing changed since library version ${since}.`,
      };
    }
  }

  const batch = state.pending.slice(0, limit);
  const indexed = await indexKeys(zotero, index, batch);
  const remaining = state.pending.slice(batch.length);

  const complete = remaining.length === 0;
  await writeState(store, {
    since: complete ? state.target : state.since,
    target: state.target,
    pending: remaining,
  });

  return {
    indexed,
    removed,
    remaining: remaining.length,
    fromVersion: state.since,
    toVersion: state.target,
    complete,
    message: complete
      ? `Indexed ${indexed} item(s); the index is current at library version ${state.target}.`
      : `Indexed ${indexed} item(s); ${remaining.length} still queued for the next run.`,
  };
}

async function indexKeys(
  zotero: ZoteroClient,
  index: SemanticIndex,
  keys: string[],
): Promise<number> {
  let indexed = 0;
  const gone: string[] = [];

  for (let offset = 0; offset < keys.length; offset += KEY_CHUNK) {
    const chunk = keys.slice(offset, offset + KEY_CHUNK);
    const page = await zotero.getItems(
      { itemKey: chunk.join(','), includeTrashed: 1 },
      chunk.length,
    );

    const found = new Set(page.items.map((item) => item.key));
    // Keys the API no longer returns were deleted between the version scan and now.
    gone.push(...chunk.filter((key) => !found.has(key)));
    // Trashed items and child objects stay out of the index.
    gone.push(...page.items.filter((item) => !isIndexable(item)).map((item) => item.key));

    indexed += await index.upsertItems(page.items);
  }

  if (gone.length > 0) await index.removeItems(gone);
  return indexed;
}

async function readState(store: TextCache): Promise<SyncState | null> {
  const raw = await store.get(STATE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SyncState;
    return { since: parsed.since ?? 0, target: parsed.target ?? 0, pending: parsed.pending ?? [] };
  } catch {
    return null;
  }
}

async function writeState(store: TextCache, state: SyncState): Promise<void> {
  await store.put(STATE_KEY, JSON.stringify(state));
}

function emptyReport(message: string): SyncReport {
  return {
    indexed: 0,
    removed: 0,
    remaining: 0,
    fromVersion: 0,
    toVersion: 0,
    complete: true,
    message,
  };
}
