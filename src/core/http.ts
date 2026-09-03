import { md5Fallback } from './md5.js';

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
