import type { ZoteroItem } from '../zotero/types.js';

export interface SemanticMatch {
  itemKey: string;
  /**
   * Cosine similarity, when the backend reports one. Hybrid retrieval does not
   * report a distance for every result, so this is absent rather than zero when
   * none came back — zero would read as the worst match on the page.
   */
  score?: number;
}

export interface SemanticQueryOptions {
  /** Wanted number of items, not chunks. */
  topK?: number;
  itemType?: string;
  /** Inclusive publication-year bounds. */
  fromYear?: number;
  toYear?: number;
}

export interface IndexStats {
  /** Indexed chunks. Tells "no matches" from "not indexed yet". */
  vectors: number;
  /** Documents accepted but not yet indexed. */
  queued: number;
  running: number;
  failed: number;
}

/** The backend behind `zotero_semantic_search`, absent when AI Search is unbound. */
export interface SemanticIndex {
  /**
   * Identifies the backing index. The sync cursor is namespaced by this, so
   * pointing the worker at a different index starts from scratch instead of
   * inheriting a cursor that describes documents it does not have.
   */
  readonly id: string;
  query(text: string, options?: SemanticQueryOptions): Promise<SemanticMatch[]>;
  stats(): Promise<IndexStats>;
  /**
   * Creates the backing index if it does not exist yet. `created` is true only
   * when this call made it: an index that has just come into existence is empty,
   * whatever a stored cursor claims.
   */
  ensure(): Promise<{ created: boolean }>;
  /**
   * Submits items for indexing, skipping the ones that are not indexable.
   * Returns how many were accepted — indexing itself completes afterwards.
   */
  upsertItems(items: ZoteroItem[]): Promise<number>;
  removeItems(keys: string[]): Promise<void>;
}
