import type { TextCache } from '../core/attachment/read.js';
import { isIndexable } from '../core/search/document.js';
import type { SemanticIndex } from '../core/search/types.js';
import type { ZoteroClient } from '../core/zotero/client.js';

/**
 * Namespaced per backend *and* per index: a cursor left by a different index
 * would claim the library is already covered by documents that were never
 * written there.
 */
const STATE_PREFIX = 'aisearch:sync-state';

/**
 * Each item is one upload and every upload is a subrequest, so this is far lower
 * than the batched-embedding era's 400. The leftovers resume on the next run.
 */
const DEFAULT_BATCH = 100;

/** Zotero accepts at most 50 keys per itemKey lookup. */
const KEY_CHUNK = 50;

/**
 * Where the incremental sync left off.
 *
 * `since` only advances once `pending` drains, so a run that is cut short by
 * CPU or subrequest limits resumes exactly where it stopped instead of skipping
 * items or re-submitting the whole library.
 */
interface SyncState {
  since: number;
  target: number;
  pending: string[];
}

export interface SyncReport {
  /**
   * Documents the backend accepted in this run — not documents it has finished
   * indexing. `upload` queues the work and returns, so `backlog` is what says
   * whether the index has caught up.
   */
  submitted: number;
  removed: number;
  /** Changed items this run did not reach, waiting for the next one. */
  remaining: number;
  /**
   * Documents accepted but not yet searchable, or null when the backend could
   * not be asked. Null is not zero: reporting "nothing pending" for "I do not
   * know" is the same lie as calling a submitted index a current one.
   */
  backlog: number | null;
  /** Documents the backend failed to index, or null when unknown. */
  failed: number | null;
  fromVersion: number;
  toVersion: number;
  /** True when every change has been *submitted*, not when indexing is done. */
  complete: boolean;
  /**
   * A configuration problem the run could not fix on its own, or null when there
   * is none. Separate from `message`, which describes what this run did: the sync
   * can succeed completely and still be writing into a misconfigured index.
   */
  warning: string | null;
  message: string;
}

export interface SyncOptions {
  zotero: ZoteroClient;
  /** Null when AI Search is unbound. */
  index: SemanticIndex | null;
  /** Holds the resume cursor between runs. */
  store: TextCache;
  /** Maximum items submitted in this run. */
  limit?: number;
  /** Discard the cursor and re-submit the whole library. */
  full?: boolean;
}

export async function syncSemanticIndex(options: SyncOptions): Promise<SyncReport> {
  const { zotero, index, store } = options;
  if (!index) {
    return emptyReport('AI Search is not bound, so semantic search is disabled.');
  }

  const limit = options.limit ?? DEFAULT_BATCH;
  const stateKey = `${STATE_PREFIX}:${index.id}`;
  // A just-created index is empty no matter what the cursor says, so it gets the
  // same treatment as an explicit full run. Skipping this is how an index that
  // was deleted and recreated stays empty for good: the library has not changed
  // since the cursor was written, so an incremental run finds nothing to do.
  const { created, mismatch } = await index.ensure();
  const full = options.full || created;
  const warning = mismatch ?? null;

  const saved = full ? null : await readState(store, stateKey);

  // A saved state with a non-empty queue is resumed; otherwise start a new cycle.
  let state = saved && saved.pending.length > 0 ? saved : null;
  let removed = 0;

  if (!state) {
    const since = full ? 0 : (saved?.since ?? 0);
    const { versions, library } = await zotero.getItemVersions(since);
    const pending = Object.keys(versions);

    // Deletions are idempotent, so handle them up front.
    if (since > 0) {
      const deleted = await zotero.getDeleted(since);
      if (deleted.items.length > 0) {
        await index.removeItems(deleted.items);
        removed = deleted.items.length;
      }
    }

    state = { since, target: library, pending };
    if (pending.length === 0) {
      await writeState(store, stateKey, { since: library, target: library, pending: [] });
      const idle = await backlogOf(index);
      return {
        submitted: 0,
        removed,
        remaining: 0,
        backlog: idle.backlog,
        failed: idle.failed,
        fromVersion: since,
        toVersion: library,
        complete: true,
        warning,
        message: `Nothing changed since library version ${since}.`,
      };
    }
  }

  const batch = state.pending.slice(0, limit);
  const submitted = await submitKeys(zotero, index, batch);
  const remaining = state.pending.slice(batch.length);

  const complete = remaining.length === 0;
  await writeState(store, stateKey, {
    since: complete ? state.target : state.since,
    target: state.target,
    pending: remaining,
  });

  const { backlog, failed } = await backlogOf(index);
  return {
    submitted,
    removed,
    remaining: remaining.length,
    backlog,
    failed,
    fromVersion: state.since,
    toVersion: state.target,
    complete,
    warning,
    message: complete
      ? `Submitted ${submitted} item(s). Every change up to library version ${state.target} has been sent; ${describeBacklog(backlog)}.`
      : `Submitted ${submitted} item(s); ${remaining.length} still queued for the next run.`,
  };
}

/**
 * What the backend still owes us. Read after submitting so a caller polling
 * `zotero_reindex` can tell "everything sent" from "everything searchable".
 */
async function backlogOf(
  index: SemanticIndex,
): Promise<{ backlog: number | null; failed: number | null }> {
  try {
    const stats = await index.stats();
    return { backlog: stats.queued + stats.running, failed: stats.failed };
  } catch {
    // Statistics are a progress report, not the job: a failure here must not
    // discard a run's worth of work. It must not be mistaken for a clean bill of
    // health either, so it comes back unknown rather than zero.
    return { backlog: null, failed: null };
  }
}

function describeBacklog(backlog: number | null): string {
  if (backlog === null) return 'how much is still being indexed could not be read';
  if (backlog === 0) return 'nothing is left to index';
  return `${backlog} document(s) are still being indexed`;
}

async function submitKeys(
  zotero: ZoteroClient,
  index: SemanticIndex,
  keys: string[],
): Promise<number> {
  let submitted = 0;
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

    submitted += await index.upsertItems(page.items);
  }

  if (gone.length > 0) await index.removeItems(gone);
  return submitted;
}

async function readState(store: TextCache, key: string): Promise<SyncState | null> {
  const raw = await store.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SyncState;
    return { since: parsed.since ?? 0, target: parsed.target ?? 0, pending: parsed.pending ?? [] };
  } catch {
    return null;
  }
}

async function writeState(store: TextCache, key: string, state: SyncState): Promise<void> {
  await store.put(key, JSON.stringify(state));
}

function emptyReport(message: string): SyncReport {
  return {
    submitted: 0,
    removed: 0,
    remaining: 0,
    backlog: 0,
    failed: 0,
    fromVersion: 0,
    toVersion: 0,
    complete: true,
    warning: null,
    message,
  };
}
