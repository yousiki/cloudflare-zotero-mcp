import type { ZoteroCreator, ZoteroItemData } from '../zotero/types.js';

/** Zotero 7's out-of-the-box attachment filename template. */
export const DEFAULT_RENAME_TEMPLATE =
  '{{ firstCreator suffix=" - " }}{{ year suffix=" - " }}{{ title truncate="100" }}';

/**
 * A pragmatic implementation of Zotero's attachment-renaming template syntax:
 * `{{ variable attr="value" … }}` interpolation with the attributes Zotero
 * documents (prefix, suffix, truncate, case, start, join, match).
 *
 * Not supported: `{{ if }}` conditional blocks. Templates using them render the
 * inner variables unconditionally rather than failing.
 */
export function renderTemplate(
  template: string,
  item: ZoteroItemData,
  context: RenderContext = {},
): string {
  return template.replace(/\{\{(.+?)\}\}/g, (_match, body: string) => {
    const token = parseToken(body);
    if (!token) return '';
    const value = resolveVariable(token.name, token.attrs, item, context);
    return decorate(value, token.attrs);
  });
}

export interface RenderContext {
  /**
   * The parent item's `meta.creatorSummary`. Zotero computes it server-side and
   * it is authoritative for `firstCreator`, so pass it whenever the full item is
   * at hand rather than letting us recompute it.
   */
  creatorSummary?: string;
}

/** Full filename for an attachment: rendered template + original extension. */
export function buildRenamedFilename(
  parent: ZoteroItemData,
  currentFilename: string,
  template = DEFAULT_RENAME_TEMPLATE,
  context: RenderContext = {},
): string {
  const extension = extensionOf(currentFilename);
  const base = getValidFileName(renderTemplate(template, parent, context).trim());
  return extension ? `${base}.${extension}` : base;
}

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return '';
  const extension = filename.slice(dot + 1);
  return /^[A-Za-z0-9]{1,8}$/.test(extension) ? extension : '';
}

/** Mirrors Zotero's `Zotero.File.getValidFileName`. */
export function getValidFileName(name: string): string {
  let cleaned = '';
  for (const char of name) {
    const code = char.codePointAt(0) as number;
    if ('/\\?*:|"<>'.includes(char)) continue;
    if (char === '\r' || char === '\n' || char === '\t') {
      cleaned += ' ';
      continue;
    }
    if (code >= 0x2000 && code <= 0x200a) {
      cleaned += ' ';
      continue;
    }
    if ((code >= 0x200b && code <= 0x200e) || code === 0x2028 || code === 0x2029) continue;
    if (code === 0x2068 || code === 0x2069) continue;
    if (code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f)) continue;
    if (code === 0xfffe || code === 0xffff) continue;
    cleaned += char;
  }

  cleaned = cleaned.replace(/^\.+/, '').replace(/\s+/g, ' ').trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return '_';
  // Keep well under filesystem and WebDAV path limits.
  return cleaned.slice(0, 200);
}

/* -------------------------------------------------------------------------- */

interface Token {
  name: string;
  attrs: Record<string, string>;
}

function parseToken(body: string): Token | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  const nameMatch = trimmed.match(/^[A-Za-z_][A-Za-z0-9_-]*/);
  if (!nameMatch) return null;

  const attrs: Record<string, string> = {};
  const attrPattern = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  for (const match of trimmed.slice(nameMatch[0].length).matchAll(attrPattern)) {
    attrs[match[1] as string] = (match[2] as string).replace(/\\(.)/g, '$1');
  }
  return { name: hyphenToCamel(nameMatch[0]), attrs };
}

function resolveVariable(
  name: string,
  attrs: Record<string, string>,
  item: ZoteroItemData,
  context: RenderContext,
): string {
  switch (name) {
    case 'firstCreator':
      return context.creatorSummary?.trim() || firstCreatorSummary(item);
    case 'authors':
      return joinCreators(creatorNames(item, 'author'), attrs);
    case 'editors':
      return joinCreators(creatorNames(item, 'editor'), attrs);
    case 'creators':
      return joinCreators(creatorNames(item), attrs);
    case 'year':
      return String(item.date ?? '').match(/\b(\d{4})\b/)?.[1] ?? '';
    case 'title':
      return stripHtml(String(item.title ?? ''));
    case 'itemType':
      return String(item.itemType ?? '');
    case 'citationKey':
      return String(item.extra ?? '').match(/^\s*Citation Key:\s*(\S+)/im)?.[1] ?? '';
    default: {
      const value = item[name];
      return value === undefined || value === null ? '' : stripHtml(String(value));
    }
  }
}

/**
 * `firstCreator` is not the first creator's name — it is the summary Zotero
 * shows in the items list: "Smith", "Smith and Jones", "Smith et al.". Emitting
 * the bare first surname made every proposed rename disagree with the filenames
 * Zotero Desktop had already written, so a bulk rename would have rewritten the
 * whole library for nothing.
 */
export function firstCreatorSummary(item: ZoteroItemData): string {
  const names = summaryCreators(item);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0] as string;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} et al.`;
}

/**
 * Zotero summarises the item type's primary creators, falling back to editors.
 * We cannot read the type schema here, so types whose primary creator is
 * something else (director, presenter, …) land on the every-creator fallback.
 */
function summaryCreators(item: ZoteroItemData): string[] {
  const authors = creatorNames(item, 'author');
  if (authors.length > 0) return authors;
  const editors = creatorNames(item, 'editor');
  if (editors.length > 0) return editors;
  return creatorNames(item);
}

function creatorNames(item: ZoteroItemData, type?: string): string[] {
  const creators: ZoteroCreator[] = Array.isArray(item.creators) ? item.creators : [];
  return creators
    .filter((creator) => !type || creator.creatorType === type)
    .map((creator) => creator.lastName?.trim() || creator.name?.trim() || '')
    .filter((name) => name.length > 0);
}

function joinCreators(names: string[], attrs: Record<string, string>): string {
  const start = Math.max(0, Number(attrs.start ?? 0) || 0);
  const max = Number(attrs.max ?? 0) || undefined;
  const selected = names.slice(start, max ? start + max : undefined);
  return selected.join(attrs.join ?? ', ');
}

function decorate(rawValue: string, attrs: Record<string, string>): string {
  let value = rawValue;
  if (!value) return '';

  if (attrs.match) {
    try {
      value = value.match(new RegExp(attrs.match))?.[0] ?? '';
    } catch {
      // An invalid pattern should not blow up a rename; treat it as no match.
      value = '';
    }
    if (!value) return '';
  }

  if (attrs.case) value = applyCase(value, attrs.case);

  const truncate = Number(attrs.truncate);
  if (Number.isFinite(truncate) && truncate > 0 && value.length > truncate) {
    value = value.slice(0, truncate).trimEnd();
  }

  return `${attrs.prefix ?? ''}${value}${attrs.suffix ?? ''}`;
}

function applyCase(value: string, mode: string): string {
  switch (mode) {
    case 'upper':
      return value.toUpperCase();
    case 'lower':
      return value.toLowerCase();
    case 'sentence':
      return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
    case 'title':
      return value.replace(
        /\b\p{L}[\p{L}'’]*/gu,
        (word) => word.charAt(0).toUpperCase() + word.slice(1),
      );
    case 'hyphen':
      return value.trim().replace(/\s+/g, '-');
    case 'snake':
      return value.trim().replace(/\s+/g, '_');
    case 'camel':
      return value
        .trim()
        .split(/\s+/)
        .map((word, index) =>
          index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1),
        )
        .join('');
    default:
      return value;
  }
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, '');
}

function hyphenToCamel(value: string): string {
  return value.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
}
