import { unzipSync, zipSync } from 'fflate';

/**
 * Zotero stores each attachment as a zip holding the file itself plus, often,
 * the desktop client's full-text cache (`.zotero-ft-cache`, `.zotero-ft-info`).
 * Anything starting with a dot is bookkeeping, never the attachment.
 */
const isBookkeeping = (name: string): boolean => {
  const base = name.split('/').pop() ?? name;
  return base.startsWith('.') || base === '';
};

export interface UnzippedAttachment {
  filename: string;
  data: Uint8Array;
}

export class AttachmentZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentZipError';
  }
}

export function zipAttachment(filename: string, data: Uint8Array): Uint8Array {
  // Level 6 keeps CPU sane on large PDFs; PDFs are mostly incompressible anyway.
  return zipSync({ [filename]: data }, { level: 6, mtime: new Date() });
}

/**
 * Extracts the attachment payload from a Zotero WebDAV zip.
 *
 * @param preferredFilename the `filename` recorded on the Zotero attachment item;
 *        used to disambiguate when a zip holds several real files.
 */
export function unzipAttachment(
  zipped: Uint8Array,
  preferredFilename?: string,
): UnzippedAttachment {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zipped);
  } catch (error) {
    throw new AttachmentZipError(
      `Could not read the WebDAV zip: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const candidates = Object.entries(entries).filter(([name]) => !isBookkeeping(name));
  if (candidates.length === 0) {
    const seen = Object.keys(entries).join(', ') || '(empty archive)';
    throw new AttachmentZipError(
      `The WebDAV zip contains no attachment file, only bookkeeping entries: ${seen}`,
    );
  }

  const exact = preferredFilename
    ? candidates.find(([name]) => (name.split('/').pop() ?? name) === preferredFilename)
    : undefined;
  const [filename, data] = exact ?? (candidates[0] as [string, Uint8Array]);
  return { filename: filename.split('/').pop() ?? filename, data };
}
