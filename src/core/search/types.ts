import type { ZoteroItem } from '../zotero/types.js';

export interface SemanticMatch {
  itemKey: string;
  score: number;
  title?: string;
  creators?: string;
  year?: string;
  itemType?: string;
}

export interface SemanticQueryOptions {
  topK?: number;
  itemType?: string;
  /** Inclusive publication-year bounds. */
  fromYear?: number;
  toYear?: number;
}

/** The vector index behind `zotero_search`, absent when Vectorize is unbound. */
export interface SemanticIndex {
  query(text: string, options?: SemanticQueryOptions): Promise<SemanticMatch[]>;
  /** Rough vector count, used to tell "no matches" from "not indexed yet". */
  size(): Promise<number>;
  /** Embeds and stores items, skipping the ones that are not indexable. */
  upsertItems(items: ZoteroItem[]): Promise<number>;
  removeItems(keys: string[]): Promise<void>;
}
