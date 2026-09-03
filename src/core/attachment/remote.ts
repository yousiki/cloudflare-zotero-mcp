import type { FetchLike } from '../http.js';
import { Md5Hasher } from '../md5.js';
import { storedZipSize } from '../webdav/zip.js';

/** Under the 100 MB Worker request-body cap once zip headers are added. */
export const MAX_REMOTE_FILE_BYTES = 95 * 1024 * 1024;

export const FETCH_UA = 'cloudflare-zotero-mcp (+https://github.com/yousiki/cloudflare-zotero-mcp)';

export class RemoteFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteFileError';
  }
}

export interface OpenRemoteFile {
  stream: ReadableStream<Uint8Array>;
  byteLength?: number;
}

export async function openRemotePdf(
  url: string,
  options: { fetch?: FetchLike; maxBytes?: number } = {},
): Promise<OpenRemoteFile> {
  return openRemoteFile(url, { ...options, requirePdf: true });
}

/**
 * Opens a remote file as a byte stream. Enforces `maxBytes` as bytes pass
 * through and never buffers the body.
 */
export async function openRemoteFile(
  url: string,
  options: { fetch?: FetchLike; maxBytes?: number; requirePdf?: boolean } = {},
): Promise<OpenRemoteFile> {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const maxBytes = options.maxBytes ?? MAX_REMOTE_FILE_BYTES;
  const response = await doFetch(url, {
    headers: { 'User-Agent': FETCH_UA },
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new RemoteFileError(`the server returned ${response.status}`);
  }
  if (!response.body) {
    throw new RemoteFileError('the response had no body');
  }

  const declared = Number(response.headers.get('Content-Length') ?? Number.NaN);
  const byteLength = Number.isFinite(declared) && declared > 0 ? declared : undefined;
  if (byteLength !== undefined && byteLength > maxBytes) {
    await response.body.cancel().catch(() => undefined);
    throw new RemoteFileError(`the file is ${byteLength} bytes, over the ${maxBytes} byte limit`);
  }

  let stream: ReadableStream<Uint8Array> = response.body;
  if (options.requirePdf) {
    const contentType = (response.headers.get('Content-Type') ?? '').split(';')[0]?.trim() ?? '';
    stream = await peekPdf(stream, contentType);
  }
  return { stream: limitBytes(stream, maxBytes), byteLength };
}

export function hashAndCount(source: ReadableStream<Uint8Array>): {
  stream: ReadableStream<Uint8Array>;
  hasher: Md5Hasher;
  bytes: () => number;
} {
  const hasher = new Md5Hasher();
  let seen = 0;
  const stream = source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        hasher.update(chunk);
        controller.enqueue(chunk);
      },
    }),
  );
  return { stream, hasher, bytes: () => seen };
}

export function zipLengthFor(filename: string, dataLength: number | undefined): number | undefined {
  return dataLength === undefined ? undefined : storedZipSize(filename, dataLength);
}

async function peekPdf(
  body: ReadableStream<Uint8Array>,
  contentType: string,
): Promise<ReadableStream<Uint8Array>> {
  const reader = body.getReader();
  const prefix: Uint8Array[] = [];
  let total = 0;
  while (total < 4) {
    const { done, value } = await reader.read();
    if (done) break;
    prefix.push(value);
    total += value.byteLength;
  }
  const head = concat(prefix);
  const looksLikePdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
  if (!looksLikePdf) {
    await reader.cancel().catch(() => undefined);
    throw new RemoteFileError(`the response was ${contentType || 'not a PDF'} rather than a PDF`);
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.byteLength > 0) controller.enqueue(head);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function limitBytes(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  let seen = 0;
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          throw new RemoteFileError(`the file is ${seen} bytes, over the ${maxBytes} byte limit`);
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
