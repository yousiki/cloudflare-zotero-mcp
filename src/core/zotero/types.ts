/**
 * Types for the Zotero Web API v3.
 *
 * Item data is intentionally loose: Zotero has ~35 item types with different
 * field sets and the server is the authority on which fields are valid. We type
 * the fields we actually reason about and keep the rest as an index signature.
 */

export type LibraryType = 'user' | 'group';

export interface ZoteroCreator {
  creatorType: string;
  firstName?: string;
  lastName?: string;
  /** Single-field mode, used for institutional authors. */
  name?: string;
}

export interface ZoteroTag {
  tag: string;
  /** 0 = manual (default), 1 = automatic. */
  type?: 0 | 1;
}

export type LinkMode = 'imported_file' | 'imported_url' | 'linked_file' | 'linked_url';

export interface ZoteroItemData {
  key: string;
  version: number;
  itemType: string;
  parentItem?: string | false;
  title?: string;
  creators?: ZoteroCreator[];
  tags?: ZoteroTag[];
  collections?: string[];
  relations?: Record<string, string | string[]>;
  date?: string;
  dateAdded?: string;
  dateModified?: string;
  abstractNote?: string;
  publicationTitle?: string;
  DOI?: string;
  ISBN?: string;
  url?: string;
  extra?: string;
  note?: string;
  deleted?: 0 | 1;

  // Attachment-specific.
  linkMode?: LinkMode;
  filename?: string;
  contentType?: string;
  charset?: string;
  md5?: string | null;
  mtime?: number | null;

  // Annotation-specific.
  annotationType?: 'highlight' | 'note' | 'image' | 'ink' | 'underline' | 'text';
  annotationText?: string;
  annotationComment?: string;
  annotationColor?: string;
  annotationPageLabel?: string;
  annotationSortIndex?: string;
  annotationPosition?: string;

  [field: string]: unknown;
}

export interface ZoteroItemMeta {
  creatorSummary?: string;
  parsedDate?: string;
  numChildren?: number;
}

export interface ZoteroItem {
  key: string;
  version: number;
  library: { type: LibraryType; id: number; name: string };
  links?: Record<string, { href: string; type: string }>;
  meta?: ZoteroItemMeta;
  data: ZoteroItemData;
  /** Present when requested via `include=bib`. */
  bib?: string;
  /** Present when requested via `include=citation`. */
  citation?: string;
  /** Present when requested via `include=csljson`. */
  csljson?: Record<string, unknown>;
}

export interface ZoteroCollectionData {
  key: string;
  version: number;
  name: string;
  parentCollection: string | false;
  relations?: Record<string, string | string[]>;
}

export interface ZoteroCollection {
  key: string;
  version: number;
  library: { type: LibraryType; id: number; name: string };
  meta?: { numCollections?: number; numItems?: number };
  data: ZoteroCollectionData;
}

export interface ZoteroTagEntry {
  tag: string;
  links?: Record<string, unknown>;
  meta?: { type?: number; numItems?: number };
}

export interface ZoteroFulltext {
  content: string;
  indexedPages?: number;
  totalPages?: number;
  indexedChars?: number;
  totalChars?: number;
}

/** Response body shared by all multi-object write requests. */
export interface ZoteroWriteResponse {
  /** index -> item key, for newly created objects. */
  success: Record<string, string>;
  /** index -> item key, for objects the server considered unchanged. */
  unchanged: Record<string, string>;
  /** index -> failure detail. */
  failed: Record<string, { code: number; message: string }>;
  /** Full objects, returned by some endpoints. */
  successful?: Record<string, ZoteroItem>;
}

export interface ZoteroPage<T> {
  items: T[];
  /** Value of the `Last-Modified-Version` response header. */
  lastModifiedVersion: number;
  /** Total result count from the `Total-Results` header, when present. */
  totalResults?: number;
}

export type QueryValue = string | number | boolean | undefined | null | string[];
export type QueryParams = Record<string, QueryValue>;
