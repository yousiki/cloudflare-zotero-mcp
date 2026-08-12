import type { FetchLike } from '../http.js';
import type { ZoteroCreator } from '../zotero/types.js';
import { type Identifier, normalizeDoi } from './identifiers.js';

const USER_AGENT = 'cloudflare-zotero-mcp (https://github.com/yousiki/cloudflare-zotero-mcp)';

/** A resolved reference, in Zotero's field vocabulary. */
export interface ResolvedReference {
  itemType: string;
  title: string;
  creators: ZoteroCreator[];
  fields: Record<string, string>;
  /** Direct link to an openly available PDF, when one is known. */
  pdfUrl?: string;
  source: string;
}

export class MetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetadataError';
  }
}

export interface ResolverOptions {
  fetch?: FetchLike;
  /** Sent to CrossRef/OpenAlex for polite-pool access. */
  contactEmail?: string;
}

export async function resolveReference(
  identifier: Identifier,
  options: ResolverOptions = {},
): Promise<ResolvedReference> {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));

  switch (identifier.kind) {
    case 'doi':
      return resolveDoi(identifier.value, doFetch, options.contactEmail);
    case 'arxiv':
      return resolveArxiv(identifier.value, doFetch);
    case 'isbn':
      return resolveIsbn(identifier.value, doFetch);
    case 'url':
      throw new MetadataError(
        'Plain URLs cannot be resolved to metadata. Provide a DOI, arXiv id or ISBN, or create the item manually with zotero_create_items.',
      );
  }
}

/* -------------------------------------------------------------------------- */
/* CrossRef                                                                    */
/* -------------------------------------------------------------------------- */

interface CrossrefAuthor {
  given?: string;
  family?: string;
  name?: string;
  sequence?: string;
}

interface CrossrefWork {
  type?: string;
  title?: string[];
  'container-title'?: string[];
  author?: CrossrefAuthor[];
  editor?: CrossrefAuthor[];
  issued?: { 'date-parts'?: number[][] };
  volume?: string;
  issue?: string;
  page?: string;
  publisher?: string;
  DOI?: string;
  ISBN?: string[];
  ISSN?: string[];
  abstract?: string;
  URL?: string;
  language?: string;
  event?: { name?: string };
}

const CROSSREF_TYPES: Record<string, string> = {
  'journal-article': 'journalArticle',
  'proceedings-article': 'conferencePaper',
  'book-chapter': 'bookSection',
  'book-section': 'bookSection',
  book: 'book',
  monograph: 'book',
  'posted-content': 'preprint',
  dataset: 'dataset',
  report: 'report',
  dissertation: 'thesis',
  'reference-entry': 'encyclopediaArticle',
};

async function resolveDoi(
  doi: string,
  doFetch: FetchLike,
  contactEmail?: string,
): Promise<ResolvedReference> {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}${
    contactEmail ? `?mailto=${encodeURIComponent(contactEmail)}` : ''
  }`;
  const response = await doFetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (response.status === 404) throw new MetadataError(`CrossRef has no record for DOI ${doi}.`);
  if (!response.ok) throw new MetadataError(`CrossRef returned ${response.status} for DOI ${doi}.`);

  const work = ((await response.json()) as { message: CrossrefWork }).message;
  const itemType = CROSSREF_TYPES[work.type ?? ''] ?? 'journalArticle';
  const fields: Record<string, string> = {};

  const container = work['container-title']?.[0];
  if (container) {
    fields[containerFieldFor(itemType)] = container;
  }
  const issued = work.issued?.['date-parts']?.[0];
  if (issued?.length) fields.date = issued.filter(Boolean).join('-');
  if (work.volume) fields.volume = work.volume;
  if (work.issue) fields.issue = work.issue;
  if (work.page) fields.pages = work.page;
  if (work.publisher) fields.publisher = work.publisher;
  if (work.DOI) fields.DOI = normalizeDoi(work.DOI);
  if (work.ISBN?.[0]) fields.ISBN = work.ISBN[0];
  if (work.ISSN?.[0]) fields.ISSN = work.ISSN[0];
  if (work.URL) fields.url = work.URL;
  if (work.language) fields.language = work.language;
  if (work.abstract) fields.abstractNote = stripJats(work.abstract);
  if (itemType === 'conferencePaper' && work.event?.name) fields.conferenceName = work.event.name;

  const pdfUrl = work.DOI ? await findOpenAccessPdf(work.DOI, doFetch, contactEmail) : undefined;

  return {
    itemType,
    title: work.title?.[0] ?? '(untitled)',
    creators: [
      ...(work.author ?? []).map((author) => toCreator(author, 'author')),
      ...(work.editor ?? []).map((editor) => toCreator(editor, 'editor')),
    ],
    fields,
    pdfUrl,
    source: 'CrossRef',
  };
}

function containerFieldFor(itemType: string): string {
  switch (itemType) {
    case 'conferencePaper':
      return 'proceedingsTitle';
    case 'bookSection':
      return 'bookTitle';
    case 'preprint':
      return 'repository';
    default:
      return 'publicationTitle';
  }
}

function toCreator(author: CrossrefAuthor, creatorType: string): ZoteroCreator {
  if (author.family || author.given) {
    return { creatorType, firstName: author.given ?? '', lastName: author.family ?? '' };
  }
  return { creatorType, name: author.name ?? '' };
}

/** CrossRef abstracts arrive as JATS XML. */
function stripJats(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* -------------------------------------------------------------------------- */
/* OpenAlex (open-access PDF discovery)                                        */
/* -------------------------------------------------------------------------- */

async function findOpenAccessPdf(
  doi: string,
  doFetch: FetchLike,
  contactEmail?: string,
): Promise<string | undefined> {
  try {
    const url = `https://api.openalex.org/works/doi:${encodeURIComponent(normalizeDoi(doi))}${
      contactEmail ? `?mailto=${encodeURIComponent(contactEmail)}` : ''
    }`;
    const response = await doFetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!response.ok) return undefined;
    const work = (await response.json()) as {
      best_oa_location?: { pdf_url?: string | null };
      open_access?: { oa_url?: string | null };
    };
    return work.best_oa_location?.pdf_url ?? work.open_access?.oa_url ?? undefined;
  } catch {
    // PDF discovery is a bonus; never let it fail the import.
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* arXiv                                                                       */
/* -------------------------------------------------------------------------- */

async function resolveArxiv(id: string, doFetch: FetchLike): Promise<ResolvedReference> {
  const response = await doFetch(
    `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}&max_results=1`,
    { headers: { 'User-Agent': USER_AGENT } },
  );
  if (!response.ok) throw new MetadataError(`arXiv returned ${response.status} for ${id}.`);

  const xml = await response.text();
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1];
  if (!entry) throw new MetadataError(`arXiv has no record for ${id}.`);

  // The Atom feed is small and regular; a regex reader avoids shipping an XML
  // parser to a runtime that has no DOMParser.
  const tag = (name: string): string | undefined =>
    decodeXml(entry.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1]?.trim());

  const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((match) =>
    splitName(decodeXml(match[1]?.trim()) ?? ''),
  );

  const published = tag('published');
  const doi = tag('arxiv:doi');
  const categories = [...entry.matchAll(/<category[^>]*term="([^"]+)"/g)].map((match) => match[1]);

  const fields: Record<string, string> = {
    repository: 'arXiv',
    archiveID: `arXiv:${id}`,
    url: `https://arxiv.org/abs/${id}`,
    extra: `arXiv:${id}${categories[0] ? ` [${categories[0]}]` : ''}`,
  };
  if (published) fields.date = published.slice(0, 10);
  const summary = tag('summary');
  if (summary) fields.abstractNote = summary.replace(/\s+/g, ' ').trim();
  if (doi) fields.DOI = normalizeDoi(doi);

  return {
    itemType: 'preprint',
    title: (tag('title') ?? '(untitled)').replace(/\s+/g, ' ').trim(),
    creators: authors.map((name) => ({ creatorType: 'author', ...name })),
    fields,
    pdfUrl: `https://arxiv.org/pdf/${id}`,
    source: 'arXiv',
  };
}

function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: '', lastName: parts[0] as string };
  return { lastName: parts.pop() as string, firstName: parts.join(' ') };
}

function decodeXml(value: string | undefined): string | undefined {
  return value
    ?.replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/* -------------------------------------------------------------------------- */
/* Open Library (ISBN)                                                         */
/* -------------------------------------------------------------------------- */

async function resolveIsbn(isbn: string, doFetch: FetchLike): Promise<ResolvedReference> {
  const response = await doFetch(
    `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`,
    { headers: { 'User-Agent': USER_AGENT } },
  );
  if (!response.ok)
    throw new MetadataError(`Open Library returned ${response.status} for ISBN ${isbn}.`);

  const body = (await response.json()) as Record<
    string,
    {
      title?: string;
      subtitle?: string;
      authors?: Array<{ name?: string }>;
      publishers?: Array<{ name?: string }>;
      publish_date?: string;
      number_of_pages?: number;
      publish_places?: Array<{ name?: string }>;
      url?: string;
    }
  >;
  const book = body[`ISBN:${isbn}`];
  if (!book) throw new MetadataError(`Open Library has no record for ISBN ${isbn}.`);

  const fields: Record<string, string> = { ISBN: isbn };
  if (book.publishers?.[0]?.name) fields.publisher = book.publishers[0].name as string;
  if (book.publish_date) fields.date = book.publish_date;
  if (book.number_of_pages) fields.numPages = String(book.number_of_pages);
  if (book.publish_places?.[0]?.name) fields.place = book.publish_places[0].name as string;
  if (book.url) fields.url = book.url;

  return {
    itemType: 'book',
    title: [book.title, book.subtitle].filter(Boolean).join(': ') || '(untitled)',
    creators: (book.authors ?? []).map((author) => ({
      creatorType: 'author',
      ...splitName(author.name ?? ''),
    })),
    fields,
    source: 'Open Library',
  };
}
