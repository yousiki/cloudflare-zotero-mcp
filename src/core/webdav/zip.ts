import { unzipSync, Zip, ZipPassThrough, zipSync } from 'fflate';

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

/**
 * Byte length of a stored (method 0) zip that fflate's `ZipPassThrough` emits
 * for one entry. PDFs barely deflate, so storing avoids a second copy of the
 * file in isolate memory. Overhead is 114 bytes plus twice the UTF-8 filename.
 */
export function storedZipSize(filename: string, dataLength: number): number {
  return dataLength + 114 + 2 * new TextEncoder().encode(filename).byteLength;
}

/** Streams a stored zip of one file. Never holds the payload. */
export function zipStoredStream(
  filename: string,
  source: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const zip = new Zip((error, chunk, final) => {
        if (error) {
          controller.error(error);
          return;
        }
        if (chunk.byteLength > 0) controller.enqueue(chunk);
        if (final) controller.close();
      });
      const file = new ZipPassThrough(filename);
      zip.add(file);
      const reader = source.getReader();
      void (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              file.push(new Uint8Array(0), true);
              zip.end();
              return;
            }
            file.push(value);
          }
        } catch (error) {
          controller.error(error);
        }
      })();
    },
  });
}
