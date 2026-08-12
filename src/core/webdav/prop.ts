/**
 * Zotero writes a `<key>.prop` sidecar next to every `<key>.zip` on WebDAV.
 * It is a fixed, tiny XML document, so a parser dependency would be overkill —
 * and Workers has no DOMParser anyway.
 *
 *   <properties version="1">
 *     <mtime>1712345678901</mtime>
 *     <hash>5eb63bbbe01eeed093cb22bb8f5acdc3</hash>
 *   </properties>
 */

export interface AttachmentProps {
  /** File modification time in milliseconds since the epoch. */
  mtime: number;
  /** Lowercase hex MD5 of the *uncompressed* file. */
  hash: string;
}

export function renderProp({ mtime, hash }: AttachmentProps): string {
  return `<properties version="1">\n  <mtime>${mtime}</mtime>\n  <hash>${hash}</hash>\n</properties>`;
}

export function parseProp(xml: string): AttachmentProps | null {
  const mtime = Number(xml.match(/<mtime>\s*(\d+)\s*<\/mtime>/)?.[1]);
  const hash = xml.match(/<hash>\s*([0-9a-fA-F]{32})\s*<\/hash>/)?.[1];
  if (!Number.isFinite(mtime) || !hash) return null;
  return { mtime, hash: hash.toLowerCase() };
}
