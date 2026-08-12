import { md5Hex } from '../http.js';
import type { WebDavClient } from '../webdav/client.js';
import { zipAttachment } from '../webdav/zip.js';
import type { ZoteroClient } from '../zotero/client.js';
import type { ZoteroItem, ZoteroTag } from '../zotero/types.js';
import { AttachmentError, guessContentType } from './read.js';
import { buildRenamedFilename, extensionOf, getValidFileName } from './rename.js';

export interface CreateAttachmentInput {
  parentItemKey?: string;
  filename: string;
  data: Uint8Array;
  contentType?: string;
  title?: string;
  url?: string;
  tags?: ZoteroTag[];
  collections?: string[];
}

export interface AttachmentWriteResult {
  attachmentKey: string;
  filename: string;
  md5: string;
  mtime: number;
  bytes: number;
}

/**
 * Attachment writes for WebDAV libraries.
 *
 * Zotero's `POST /items/<key>/file` upload-authorization dance only applies to
 * Zotero File Storage. WebDAV libraries instead push the file to their own
 * server and then write `md5`/`mtime` onto the item — which the Web API
 * explicitly permits for personal libraries.
 *
 * Order matters: create the item first (we need its key for the WebDAV
 * filename), upload the pair, and only then record the hash. If the upload
 * fails the item is left without md5/mtime, which Zotero treats as "file not
 * yet uploaded" rather than as corruption.
 */
export class AttachmentWriter {
  constructor(
    private readonly zotero: ZoteroClient,
    private readonly webdav: WebDavClient | null,
  ) {}

  private requireWebdav(): WebDavClient {
    if (!this.webdav) {
      throw new AttachmentError(
        'WebDAV is not configured, so attachments cannot be written. Set WEBDAV_URL, WEBDAV_USERNAME and WEBDAV_PASSWORD.',
      );
    }
    return this.webdav;
  }

  async create(input: CreateAttachmentInput): Promise<AttachmentWriteResult> {
    const webdav = this.requireWebdav();
    const filename = getValidFileName(input.filename);
    const contentType = input.contentType ?? guessContentType(filename);

    const template = await this.zotero.getTemplate('attachment', 'imported_file');
    const payload: Record<string, unknown> = {
      ...template,
      itemType: 'attachment',
      linkMode: 'imported_file',
      title: input.title ?? filename,
      filename,
      contentType,
      tags: input.tags ?? [],
      collections: input.collections ?? [],
    };
    if (input.parentItemKey) payload.parentItem = input.parentItemKey;
    if (input.url) payload.url = input.url;
    // md5/mtime are written after the file lands on WebDAV.
    delete payload.md5;
    delete payload.mtime;

    const response = await this.zotero.writeObjects('items', [payload]);
    const attachmentKey = response.success['0'];
    if (!attachmentKey) {
      const failure = response.failed['0'];
      throw new AttachmentError(
        `Zotero refused to create the attachment item: ${failure?.message ?? JSON.stringify(response)}`,
      );
    }

    const uploaded = await this.uploadFile(webdav, attachmentKey, filename, input.data);
    await this.recordFile(attachmentKey, { filename, ...uploaded });

    return { attachmentKey, filename, bytes: input.data.length, ...uploaded };
  }

  /** Swaps the bytes behind an existing attachment, keeping its item and key. */
  async replace(
    attachmentKey: string,
    data: Uint8Array,
    filename?: string,
  ): Promise<AttachmentWriteResult> {
    const webdav = this.requireWebdav();
    const attachment = await this.zotero.getItem(attachmentKey);
    assertStoredFile(attachment);

    const targetName = getValidFileName(
      filename ?? attachment.data.filename ?? `${attachmentKey}.pdf`,
    );
    const uploaded = await this.uploadFile(webdav, attachmentKey, targetName, data);
    await this.recordFile(attachmentKey, { filename: targetName, ...uploaded }, attachment.version);

    return { attachmentKey, filename: targetName, bytes: data.length, ...uploaded };
  }

  /**
   * Renames an attachment on both sides. The zip entry carries the filename, so
   * the archive has to be rewritten even though the bytes are unchanged.
   */
  async rename(
    attachmentKey: string,
    newFilename: string,
    data: Uint8Array,
    options: { updateTitle?: boolean } = {},
  ): Promise<AttachmentWriteResult> {
    const webdav = this.requireWebdav();
    const attachment = await this.zotero.getItem(attachmentKey);
    assertStoredFile(attachment);

    const filename = getValidFileName(newFilename);
    if (filename === attachment.data.filename) {
      return {
        attachmentKey,
        filename,
        md5: attachment.data.md5 ?? '',
        mtime: attachment.data.mtime ?? 0,
        bytes: data.length,
      };
    }

    const uploaded = await this.uploadFile(webdav, attachmentKey, filename, data);
    const patch: Record<string, unknown> = { filename, md5: uploaded.md5, mtime: uploaded.mtime };
    if (options.updateTitle !== false) patch.title = filename;
    await this.zotero.patchItem(attachmentKey, patch, attachment.version);

    return { attachmentKey, filename, bytes: data.length, ...uploaded };
  }

  /** Computes the new filename for an attachment from its parent's metadata. */
  async plannedName(attachment: ZoteroItem, template?: string): Promise<string | null> {
    const parentKey = attachment.data.parentItem;
    if (!parentKey || typeof parentKey !== 'string') return null;
    const parent = await this.zotero.getItem(parentKey);
    const current = attachment.data.filename ?? '';
    const proposed = buildRenamedFilename(parent.data, current, template, {
      creatorSummary: parent.meta?.creatorSummary,
    });
    // A template that renders to nothing but an extension is a bad rename.
    return extensionOf(proposed) && proposed.startsWith('_.') ? null : proposed;
  }

  async remove(attachmentKey: string): Promise<void> {
    const attachment = await this.zotero.getItem(attachmentKey);
    await this.zotero.deleteItem(attachmentKey, attachment.version);
    if (this.webdav && attachment.data.linkMode?.startsWith('imported')) {
      await this.webdav.remove(attachmentKey).catch(() => undefined);
    }
  }

  private async uploadFile(
    webdav: WebDavClient,
    key: string,
    filename: string,
    data: Uint8Array,
  ): Promise<{ md5: string; mtime: number }> {
    const md5 = await md5Hex(data);
    const mtime = Date.now();
    await webdav.putZip(key, zipAttachment(filename, data));
    await webdav.putProp(key, { mtime, hash: md5 });
    return { md5, mtime };
  }

  private async recordFile(
    key: string,
    file: { filename: string; md5: string; mtime: number },
    knownVersion?: number,
  ): Promise<void> {
    const version = knownVersion ?? (await this.zotero.getItem(key)).version;
    await this.zotero.patchItem(
      key,
      { filename: file.filename, md5: file.md5, mtime: file.mtime },
      version,
    );
  }
}

function assertStoredFile(attachment: ZoteroItem): void {
  if (attachment.data.itemType !== 'attachment') {
    throw new AttachmentError(`Item ${attachment.key} is not an attachment`);
  }
  if (!attachment.data.linkMode?.startsWith('imported')) {
    throw new AttachmentError(
      `Attachment ${attachment.key} is a ${attachment.data.linkMode} link and has no stored file`,
    );
  }
}
