import { md5Hex } from '../http.js';
import { extractPdfOutline, extractPdfText, type PdfOutlineEntry } from '../pdf/extract.js';
import type { WebDavClient } from '../webdav/client.js';
import { unzipAttachment } from '../webdav/zip.js';
import type { ZoteroClient } from '../zotero/client.js';
import type { ZoteroItem } from '../zotero/types.js';

/** Anything durable enough to memoize extracted text between requests. */
export interface TextCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSeconds?: number): Promise<void>;
}

export class AttachmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentError';
  }
}

export interface AttachmentFile {
  attachment: ZoteroItem;
  filename: string;
  contentType: string;
  data: Uint8Array;
  /** True when the file's MD5 disagrees with the Zotero item's recorded hash. */
  hashMismatch: boolean;
}

export interface ReadTextOptions {
  fromPage?: number;
  toPage?: number;
  maxPages?: number;
  /** Skip Zotero's server-side index and always read the real file. */
  forceFile?: boolean;
  /** Push extracted text back to Zotero's index so other clients benefit. */
  writeBackIndex?: boolean;
}

export interface AttachmentText {
  attachmentKey: string;
  source: 'zotero-index' | 'webdav';
  text: string;
  totalPages?: number;
  pages?: number[];
  truncated?: boolean;
}

const TEXT_ATTACHMENT_TYPES = new Set([
  'application/pdf',
  'application/epub+zip',
  'text/plain',
  'text/html',
  'text/markdown',
]);

export class AttachmentReader {
  constructor(
    private readonly zotero: ZoteroClient,
    private readonly webdav: WebDavClient | null,
    private readonly cache?: TextCache,
  ) {}

  /**
   * Accepts either an attachment key or a regular item key, returning the
   * attachment to operate on. PDFs win, then EPUBs, then any stored file.
   */
  async resolveAttachment(itemKey: string): Promise<ZoteroItem> {
    const item = await this.zotero.getItem(itemKey);
    if (item.data.itemType === 'attachment') return item;

    const children = await this.zotero.getItemChildren(itemKey);
    const attachments = children.filter(
      (child) =>
        child.data.itemType === 'attachment' &&
        (child.data.linkMode === 'imported_file' || child.data.linkMode === 'imported_url'),
    );
    if (attachments.length === 0) {
      throw new AttachmentError(`Item ${itemKey} has no stored file attachment`);
    }

    const score = (candidate: ZoteroItem): number => {
      const type = candidate.data.contentType ?? '';
      if (type === 'application/pdf') return 0;
      if (type === 'application/epub+zip') return 1;
      return TEXT_ATTACHMENT_TYPES.has(type) ? 2 : 3;
    };
    attachments.sort((a, b) => score(a) - score(b));
    return attachments[0] as ZoteroItem;
  }

  /** Downloads and unpacks the file behind an attachment item from WebDAV. */
  async download(attachmentKeyOrItem: string | ZoteroItem): Promise<AttachmentFile> {
    if (!this.webdav) {
      throw new AttachmentError(
        'WebDAV is not configured, so attachment files cannot be read. Set WEBDAV_URL, WEBDAV_USERNAME and WEBDAV_PASSWORD.',
      );
    }

    const attachment =
      typeof attachmentKeyOrItem === 'string'
        ? await this.zotero.getItem(attachmentKeyOrItem)
        : attachmentKeyOrItem;

    if (attachment.data.itemType !== 'attachment') {
      throw new AttachmentError(`Item ${attachment.key} is not an attachment`);
    }
    if (attachment.data.linkMode === 'linked_url' || attachment.data.linkMode === 'linked_file') {
      throw new AttachmentError(
        `Attachment ${attachment.key} is a ${attachment.data.linkMode} link, so no file is stored on WebDAV`,
      );
    }

    const zipped = await this.webdav.getZip(attachment.key);
    if (!zipped) {
      throw new AttachmentError(
        `No file for attachment ${attachment.key} on WebDAV. Sync Zotero Desktop so it uploads the file, then retry.`,
      );
    }

    const { filename, data } = unzipAttachment(zipped, attachment.data.filename);
    const actualMd5 = await md5Hex(data);
    const expected = attachment.data.md5;

    return {
      attachment,
      filename: attachment.data.filename ?? filename,
      contentType: attachment.data.contentType ?? guessContentType(filename),
      data,
      hashMismatch: Boolean(expected) && expected !== actualMd5,
    };
  }

  async readText(itemKey: string, options: ReadTextOptions = {}): Promise<AttachmentText> {
    const attachment = await this.resolveAttachment(itemKey);
    const wantsWholeDocument = options.fromPage === undefined && options.toPage === undefined;

    // Zotero's own index is free and costs no CPU, but it has no page structure.
    if (!options.forceFile && wantsWholeDocument) {
      const indexed = await this.zotero.getFulltext(attachment.key);
      if (indexed?.content) {
        return {
          attachmentKey: attachment.key,
          source: 'zotero-index',
          text: indexed.content,
          totalPages: indexed.totalPages,
        };
      }
    }

    const cacheKey = `text:${attachment.key}:${attachment.data.md5 ?? attachment.version}:${
      options.fromPage ?? 1
    }-${options.toPage ?? 'end'}:${options.maxPages ?? 'default'}`;
    const cached = await this.cache?.get(cacheKey);
    if (cached) {
      return { ...(JSON.parse(cached) as AttachmentText), attachmentKey: attachment.key };
    }

    const file = await this.download(attachment);
    const result = await this.extractText(file, options);

    await this.cache?.put(cacheKey, JSON.stringify(result), 60 * 60 * 24 * 30);

    if (options.writeBackIndex && wantsWholeDocument && result.text && result.totalPages) {
      // Best effort: a failure here must not fail the read.
      await this.zotero
        .putFulltext(attachment.key, {
          content: result.text,
          indexedPages: result.pages?.length ?? result.totalPages,
          totalPages: result.totalPages,
        })
        .catch(() => undefined);
    }

    return result;
  }

  private async extractText(
    file: AttachmentFile,
    options: ReadTextOptions,
  ): Promise<AttachmentText> {
    const base = { attachmentKey: file.attachment.key, source: 'webdav' as const };

    if (file.contentType === 'application/pdf') {
      const extracted = await extractPdfText(file.data, {
        fromPage: options.fromPage,
        toPage: options.toPage,
        maxPages: options.maxPages,
      });
      return {
        ...base,
        text: extracted.text,
        totalPages: extracted.totalPages,
        pages: extracted.pages,
        truncated: extracted.truncated,
      };
    }

    if (
      file.contentType.startsWith('text/') ||
      file.contentType === 'application/json' ||
      file.contentType === 'application/xml'
    ) {
      const text = new TextDecoder().decode(file.data);
      return { ...base, text: file.contentType === 'text/html' ? stripHtml(text) : text };
    }

    throw new AttachmentError(
      `Cannot extract text from ${file.contentType} (attachment ${file.attachment.key}). Only PDFs and text formats are supported.`,
    );
  }

  async readOutline(
    itemKey: string,
  ): Promise<{ attachmentKey: string; outline: PdfOutlineEntry[] }> {
    const attachment = await this.resolveAttachment(itemKey);
    const file = await this.download(attachment);
    if (file.contentType !== 'application/pdf') {
      throw new AttachmentError(`Attachment ${attachment.key} is not a PDF, so it has no outline`);
    }
    return { attachmentKey: attachment.key, outline: await extractPdfOutline(file.data) };
  }
}

export function guessContentType(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  switch (extension) {
    case 'pdf':
      return 'application/pdf';
    case 'epub':
      return 'application/epub+zip';
    case 'html':
    case 'htm':
      return 'text/html';
    case 'txt':
      return 'text/plain';
    case 'md':
      return 'text/markdown';
    case 'json':
      return 'application/json';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    default:
      return 'application/octet-stream';
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
