/**
 * PDF text/outline extraction on top of unpdf (a serverless build of PDF.js).
 *
 * unpdf is imported lazily: the bundle is ~1.6 MB and most tool calls never
 * touch a PDF, so we keep it out of the cold-start path.
 */

export interface PdfTextResult {
  totalPages: number;
  /** Pages actually read, as 1-indexed numbers. */
  pages: number[];
  text: string;
  /** True when a page limit stopped us short of the whole document. */
  truncated: boolean;
}

export interface PdfOutlineEntry {
  title: string;
  level: number;
  page?: number;
}

export interface ExtractOptions {
  /** 1-indexed, inclusive. Defaults to the whole document. */
  fromPage?: number;
  toPage?: number;
  /** Hard ceiling on pages read in one call. */
  maxPages?: number;
  /** Abort if extraction takes longer than this (default 20s). */
  timeoutMs?: number;
}

export class PdfExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfExtractionError';
  }
}

// Minimal structural types — unpdf re-exports PDF.js types that pull in DOM and
// @napi-rs/canvas declarations we do not want in a Workers tsconfig.
interface TextItemLike {
  str?: string;
  hasEOL?: boolean;
}
interface PageLike {
  getTextContent(): Promise<{ items: TextItemLike[] }>;
}
interface OutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items?: OutlineNode[];
}
interface DocumentLike {
  numPages: number;
  getPage(page: number): Promise<PageLike>;
  getOutline(): Promise<OutlineNode[] | null>;
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
}

async function openDocument(bytes: Uint8Array): Promise<DocumentLike> {
  const { getDocumentProxy } = await import('unpdf');
  // PDF.js takes ownership of the buffer it is handed, so pass a copy.
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  return doc as unknown as DocumentLike;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new PdfExtractionError(`${what} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function extractPdfText(
  bytes: Uint8Array,
  options: ExtractOptions = {},
): Promise<PdfTextResult> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  return withTimeout(runExtractText(bytes, options), timeoutMs, 'PDF text extraction');
}

async function runExtractText(bytes: Uint8Array, options: ExtractOptions): Promise<PdfTextResult> {
  const doc = await openDocument(bytes);
  const totalPages = doc.numPages;

  const from = Math.max(1, options.fromPage ?? 1);
  const requestedTo = Math.min(totalPages, options.toPage ?? totalPages);
  if (from > totalPages) {
    throw new PdfExtractionError(`Page ${from} is past the end of a ${totalPages}-page document`);
  }

  const maxPages = options.maxPages ?? 60;
  const to = Math.min(requestedTo, from + maxPages - 1);

  const parts: string[] = [];
  const pages: number[] = [];
  for (let pageNumber = from; pageNumber <= to; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    let pageText = '';
    for (const item of content.items) {
      if (typeof item.str !== 'string') continue;
      pageText += item.str;
      if (item.hasEOL) pageText += '\n';
    }
    parts.push(pageText.trim());
    pages.push(pageNumber);
  }

  return {
    totalPages,
    pages,
    text: parts.join('\n\n'),
    truncated: to < requestedTo,
  };
}

export async function extractPdfOutline(
  bytes: Uint8Array,
  timeoutMs = 15_000,
): Promise<PdfOutlineEntry[]> {
  return withTimeout(runExtractOutline(bytes), timeoutMs, 'PDF outline extraction');
}

async function runExtractOutline(bytes: Uint8Array): Promise<PdfOutlineEntry[]> {
  const doc = await openDocument(bytes);
  const outline = await doc.getOutline();
  if (!outline?.length) return [];

  const entries: PdfOutlineEntry[] = [];

  const resolvePage = async (dest: OutlineNode['dest']): Promise<number | undefined> => {
    try {
      const resolved = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
      const ref = Array.isArray(resolved) ? resolved[0] : undefined;
      if (ref === undefined) return undefined;
      return (await doc.getPageIndex(ref)) + 1;
    } catch {
      // Broken destinations are common in the wild; the title alone is useful.
      return undefined;
    }
  };

  const walk = async (nodes: OutlineNode[], level: number): Promise<void> => {
    for (const node of nodes) {
      entries.push({ title: node.title, level, page: await resolvePage(node.dest) });
      if (node.items?.length) await walk(node.items, level + 1);
    }
  };

  await walk(outline, 0);
  return entries;
}

export async function getPdfPageCount(bytes: Uint8Array): Promise<number> {
  const doc = await openDocument(bytes);
  return doc.numPages;
}
