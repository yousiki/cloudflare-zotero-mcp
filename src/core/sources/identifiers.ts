export type IdentifierKind = 'doi' | 'arxiv' | 'isbn' | 'url';

export interface Identifier {
  kind: IdentifierKind;
  value: string;
}

const DOI_PATTERN = /\b(10\.\d{4,9}\/[-._;()/:a-z0-9<>+[\]]+)\b/i;
const ARXIV_NEW = /\b(?:arxiv[:\s/]*)?(\d{4}\.\d{4,5})(v\d+)?\b/i;
const ARXIV_OLD = /\b(?:arxiv[:\s/]*)?([a-z-]+(?:\.[a-z]{2})?\/\d{7})(v\d+)?\b/i;

/**
 * Works out what the user handed us. Order matters: a DOI can appear inside an
 * arXiv URL and an arXiv id can appear inside a DOI, so the most specific
 * container (a URL we recognise) is checked first.
 */
export function detectIdentifier(raw: string): Identifier | null {
  const input = raw.trim();
  if (!input) return null;

  if (/^https?:\/\//i.test(input)) {
    const url = new URL(input);
    if (/(^|\.)arxiv\.org$/i.test(url.hostname)) {
      const fromPath = url.pathname.replace(/^\/(abs|pdf)\//i, '').replace(/\.pdf$/i, '');
      const arxiv = matchArxiv(fromPath);
      if (arxiv) return arxiv;
    }
    if (/(^|\.)doi\.org$/i.test(url.hostname)) {
      const doi = url.pathname.slice(1);
      if (DOI_PATTERN.test(doi)) return { kind: 'doi', value: normalizeDoi(doi) };
    }
    const embedded = input.match(DOI_PATTERN);
    if (embedded) return { kind: 'doi', value: normalizeDoi(embedded[1] as string) };
    return { kind: 'url', value: input };
  }

  if (/^doi:/i.test(input)) {
    const doi = input.replace(/^doi:/i, '');
    if (DOI_PATTERN.test(doi)) return { kind: 'doi', value: normalizeDoi(doi) };
  }

  if (/^arxiv/i.test(input)) {
    const arxiv = matchArxiv(input);
    if (arxiv) return arxiv;
  }

  const doi = input.match(DOI_PATTERN);
  if (doi) return { kind: 'doi', value: normalizeDoi(doi[1] as string) };

  const isbn = normalizeIsbn(input);
  if (isbn) return { kind: 'isbn', value: isbn };

  const arxiv = matchArxiv(input);
  if (arxiv) return arxiv;

  return null;
}

function matchArxiv(value: string): Identifier | null {
  const match = value.match(ARXIV_NEW) ?? value.match(ARXIV_OLD);
  // The version suffix is dropped: Zotero stores the canonical id.
  return match ? { kind: 'arxiv', value: match[1] as string } : null;
}

export function normalizeDoi(doi: string): string {
  return doi.replace(/[.,;)\]]+$/, '').toLowerCase();
}

/** Returns the digits-only ISBN when the checksum is valid, else null. */
export function normalizeIsbn(raw: string): string | null {
  const candidate = raw.replace(/[\s-]/g, '').toUpperCase();
  if (/^\d{9}[\dX]$/.test(candidate) && isbn10Valid(candidate)) return candidate;
  if (/^\d{13}$/.test(candidate) && isbn13Valid(candidate)) return candidate;
  return null;
}

function isbn10Valid(isbn: string): boolean {
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const char = isbn[i] as string;
    const digit = char === 'X' ? 10 : Number(char);
    sum += digit * (10 - i);
  }
  return sum % 11 === 0;
}

function isbn13Valid(isbn: string): boolean {
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    sum += Number(isbn[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return sum % 10 === 0;
}
