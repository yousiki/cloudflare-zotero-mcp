import { PdfExtractionError } from './extract.js';

/**
 * Locating text inside a PDF so annotations can be anchored to it.
 *
 * Zotero stores a highlight's geometry in `annotationPosition`
 * (`{"pageIndex":N,"rects":[[x1,y1,x2,y2],…]}`, PDF user space with the origin
 * at the bottom-left) and its ordering in `annotationSortIndex`
 * (`pppppddddddttttt`: page index, character offset, distance from the page top).
 * Both have to be computed from the real document — there is no server-side
 * "highlight this string" API.
 */

export interface TextLocation {
  pageIndex: number;
  rects: Array<[number, number, number, number]>;
  sortIndex: string;
  /** The text actually covered, which may differ in whitespace from the needle. */
  matchedText: string;
}

interface TextItemLike {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
}

interface ViewportLike {
  height: number;
}

interface PageLike {
  getTextContent(): Promise<{ items: TextItemLike[] }>;
  getViewport(options: { scale: number }): ViewportLike;
}

interface DocumentLike {
  numPages: number;
  getPage(page: number): Promise<PageLike>;
}

/** Normalizes whitespace so a quote copied from a paper still matches the PDF. */
function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

export async function locateText(
  bytes: Uint8Array,
  pageNumber: number,
  needle: string,
): Promise<TextLocation> {
  const { getDocumentProxy } = await import('unpdf');
  const doc = (await getDocumentProxy(new Uint8Array(bytes))) as unknown as DocumentLike;

  if (pageNumber < 1 || pageNumber > doc.numPages) {
    throw new PdfExtractionError(
      `Page ${pageNumber} is out of range for a ${doc.numPages}-page document`,
    );
  }

  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();

  // Build the page's text while remembering which item each character came from.
  let haystack = '';
  const owners: number[] = [];
  const items = content.items;
  items.forEach((item, index) => {
    const piece = normalize(typeof item.str === 'string' ? item.str : '');
    for (let i = 0; i < piece.length; i++) owners.push(index);
    haystack += piece;
    if (item.hasEOL) {
      haystack += ' ';
      owners.push(index);
    }
  });

  const target = normalize(needle).trim();
  if (!target) throw new PdfExtractionError('The text to highlight is empty');

  const start = haystack.toLowerCase().indexOf(target.toLowerCase());
  if (start === -1) {
    throw new PdfExtractionError(
      `Could not find that text on page ${pageNumber}. Read the page with zotero_read_attachment first and quote it exactly.`,
    );
  }

  const touched = new Set(owners.slice(start, start + target.length));
  const rects: Array<[number, number, number, number]> = [];
  for (const index of touched) {
    const item = items[index];
    if (!item?.transform) continue;
    const x = item.transform[4] as number;
    const y = item.transform[5] as number;
    const width = item.width ?? 0;
    const height = item.height ?? 0;
    if (width <= 0 || height <= 0) continue;
    rects.push([round(x), round(y), round(x + width), round(y + height)]);
  }

  if (rects.length === 0) {
    throw new PdfExtractionError(
      `Found the text on page ${pageNumber} but it carries no usable geometry (likely a scanned page).`,
    );
  }

  const topMost = Math.max(...rects.map((rect) => rect[3]));
  const pageIndex = pageNumber - 1;
  const sortIndex = buildSortIndex(pageIndex, start, Math.round(viewport.height - topMost));

  return {
    pageIndex,
    rects: mergeRects(rects),
    sortIndex,
    matchedText: haystack.slice(start, start + target.length),
  };
}

/** Position for an annotation that is not anchored to text (a sticky note). */
export async function pagePoint(
  bytes: Uint8Array,
  pageNumber: number,
): Promise<{
  pageIndex: number;
  rects: Array<[number, number, number, number]>;
  sortIndex: string;
}> {
  const { getDocumentProxy } = await import('unpdf');
  const doc = (await getDocumentProxy(new Uint8Array(bytes))) as unknown as DocumentLike;
  if (pageNumber < 1 || pageNumber > doc.numPages) {
    throw new PdfExtractionError(
      `Page ${pageNumber} is out of range for a ${doc.numPages}-page document`,
    );
  }
  const viewport = (await doc.getPage(pageNumber)).getViewport({ scale: 1 });
  // Zotero renders note annotations as a small square; place it in the margin.
  const top = viewport.height - 60;
  return {
    pageIndex: pageNumber - 1,
    rects: [[24, round(top), 48, round(top + 24)]],
    sortIndex: buildSortIndex(pageNumber - 1, 0, 60),
  };
}

export function buildSortIndex(pageIndex: number, offset: number, top: number): string {
  const clamp = (value: number, digits: number): string =>
    String(Math.max(0, Math.min(value, 10 ** digits - 1))).padStart(digits, '0');
  return `${clamp(pageIndex, 5)}|${clamp(offset, 6)}|${clamp(top, 5)}`;
}

/** Joins rects that sit on the same line so a highlight is a few bars, not many. */
function mergeRects(
  rects: Array<[number, number, number, number]>,
): Array<[number, number, number, number]> {
  const sorted = [...rects].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const merged: Array<[number, number, number, number]> = [];

  for (const rect of sorted) {
    const previous = merged[merged.length - 1];
    const sameLine = previous && Math.abs(previous[1] - rect[1]) < 2;
    const adjacent = previous && rect[0] - previous[2] < 12;
    if (previous && sameLine && adjacent) {
      previous[0] = Math.min(previous[0], rect[0]);
      previous[1] = Math.min(previous[1], rect[1]);
      previous[2] = Math.max(previous[2], rect[2]);
      previous[3] = Math.max(previous[3], rect[3]);
    } else {
      merged.push([...rect] as [number, number, number, number]);
    }
  }

  return merged;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
