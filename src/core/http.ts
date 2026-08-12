/** Small runtime-agnostic HTTP helpers shared by the Zotero and WebDAV clients. */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Caps how many requests run at once. Zotero asks clients to stay around four
 * concurrent requests, and WebDAV servers are usually much weaker than that.
 */
export class Limiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

/**
 * A shared "do not send requests before this timestamp" gate. Zotero can return
 * a `Backoff` header on *any* response — including successful ones — and expects
 * every subsequent request to be delayed, not just a retry of the same one.
 */
export class BackoffGate {
  private until = 0;

  noteResponse(response: Response): void {
    const header = response.headers.get('Backoff') ?? response.headers.get('backoff');
    if (header) this.pause(parseRetryAfter(header));
  }

  pause(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    this.until = Math.max(this.until, Date.now() + seconds * 1000);
  }

  async wait(): Promise<void> {
    const remaining = this.until - Date.now();
    if (remaining > 0) await sleep(remaining);
  }
}

/** Parses a `Retry-After` / `Backoff` value, which may be seconds or an HTTP date. */
export function parseRetryAfter(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  return Number.isNaN(date) ? 0 : Math.max(0, (date - Date.now()) / 1000);
}

export function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64Decode(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${base64Encode(new TextEncoder().encode(`${username}:${password}`))}`;
}

/** Lowercase hex MD5. Zotero stores attachment hashes in this form. */
export async function md5Hex(data: Uint8Array): Promise<string> {
  // Workers' WebCrypto exposes MD5 for digest (non-standard but supported);
  // fall back to a tiny pure-JS implementation elsewhere (e.g. bun test).
  const subtle =
    typeof crypto === 'undefined'
      ? undefined
      : (crypto.subtle as unknown as
          | { digest(alg: string, data: BufferSource): Promise<ArrayBuffer> }
          | undefined);
  if (subtle) {
    try {
      const digest = await subtle.digest('MD5', data as unknown as BufferSource);
      return toHex(new Uint8Array(digest));
    } catch {
      // Not supported on this runtime; use the fallback below.
    }
  }
  return md5Fallback(data);
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/* -------------------------------------------------------------------------- */
/* Pure-JS MD5 (RFC 1321). Only used when WebCrypto refuses the MD5 algorithm.  */
/* -------------------------------------------------------------------------- */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const K = Array.from(
  { length: 64 },
  (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0,
);

function md5Fallback(input: Uint8Array): string {
  const originalBits = input.length * 8;
  const paddedLength = (((input.length + 8) >> 6) + 1) << 6;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, originalBits >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(originalBits / 2 ** 32), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < paddedLength; offset += 64) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(offset + i * 4, true);

    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + (K[i] as number) + (M[g] as number)) >>> 0;
      A = D;
      D = C;
      C = B;
      const shift = S[i] as number;
      B = (B + (((F << shift) | (F >>> (32 - shift))) >>> 0)) >>> 0;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return toHex(out);
}
