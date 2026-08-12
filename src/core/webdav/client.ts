import { basicAuthHeader, type FetchLike, Limiter, parseRetryAfter, sleep } from '../http.js';
import { type AttachmentProps, parseProp, renderProp } from './prop.js';

export class WebDavError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly url: string,
    body: string,
  ) {
    super(`WebDAV ${method} ${url} failed with ${status}${body ? `: ${body.slice(0, 300)}` : ''}`);
    this.name = 'WebDavError';
  }
}

export interface WebDavClientOptions {
  /** The WebDAV root as configured in Zotero; `/zotero` is appended if missing. */
  url: string;
  username: string;
  password: string;
  fetch?: FetchLike;
  maxRetries?: number;
  /** Refuse to buffer archives larger than this (default 64 MiB). */
  maxDownloadBytes?: number;
}

export class WebDavClient {
  readonly baseUrl: string;
  private readonly auth: string;
  private readonly doFetch: FetchLike;
  private readonly limiter = new Limiter(3);
  private readonly maxRetries: number;
  private readonly maxDownloadBytes: number;

  constructor(options: WebDavClientOptions) {
    const trimmed = options.url.trim().replace(/\/+$/, '');
    // Zotero Desktop appends "/zotero" to the configured URL; mirror that so the
    // files land where the desktop client looks for them.
    this.baseUrl = trimmed.endsWith('/zotero') ? trimmed : `${trimmed}/zotero`;
    this.auth = basicAuthHeader(options.username, options.password);
    this.doFetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.maxRetries = options.maxRetries ?? 3;
    this.maxDownloadBytes = options.maxDownloadBytes ?? 64 * 1024 * 1024;
  }

  private url(name: string): string {
    return `${this.baseUrl}/${encodeURIComponent(name)}`;
  }

  private async send(
    url: string,
    init: RequestInit & { method: string },
    allowedStatuses: number[] = [],
  ): Promise<Response> {
    let attempt = 0;
    for (;;) {
      const headers = new Headers(init.headers);
      headers.set('Authorization', this.auth);
      const response = await this.limiter.run(() => this.doFetch(url, { ...init, headers }));

      const retryable =
        response.status === 429 || (response.status >= 500 && response.status < 600);
      if (retryable && attempt < this.maxRetries) {
        const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
        await sleep(retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 400);
        attempt++;
        continue;
      }

      if (!response.ok && !allowedStatuses.includes(response.status)) {
        throw new WebDavError(
          response.status,
          init.method,
          url,
          await response.text().catch(() => ''),
        );
      }
      return response;
    }
  }

  /** Cheap reachability + credentials check. */
  async verify(): Promise<{ ok: boolean; status: number }> {
    const response = await this.send(
      `${this.baseUrl}/`,
      { method: 'OPTIONS' },
      [401, 403, 404, 405],
    );
    return { ok: response.ok, status: response.status };
  }

  async exists(key: string): Promise<boolean> {
    const response = await this.send(this.url(`${key}.zip`), { method: 'HEAD' }, [404]);
    return response.status !== 404;
  }

  /** Returns the raw zip bytes, or null when the attachment is not on the server. */
  async getZip(key: string): Promise<Uint8Array | null> {
    const response = await this.send(this.url(`${key}.zip`), { method: 'GET' }, [404]);
    if (response.status === 404) return null;

    const declared = Number(response.headers.get('Content-Length') ?? Number.NaN);
    if (Number.isFinite(declared) && declared > this.maxDownloadBytes) {
      throw new WebDavError(
        413,
        'GET',
        this.url(`${key}.zip`),
        `archive is ${declared} bytes, over the ${this.maxDownloadBytes} byte limit`,
      );
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > this.maxDownloadBytes) {
      throw new WebDavError(
        413,
        'GET',
        this.url(`${key}.zip`),
        `archive is ${buffer.byteLength} bytes, over the ${this.maxDownloadBytes} byte limit`,
      );
    }
    return new Uint8Array(buffer);
  }

  async getProp(key: string): Promise<AttachmentProps | null> {
    const response = await this.send(this.url(`${key}.prop`), { method: 'GET' }, [404]);
    if (response.status === 404) return null;
    return parseProp(await response.text());
  }

  async putZip(key: string, zipped: Uint8Array): Promise<void> {
    await this.send(this.url(`${key}.zip`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/zip' },
      body: zipped as unknown as BodyInit,
    });
  }

  async putProp(key: string, props: AttachmentProps): Promise<void> {
    await this.send(this.url(`${key}.prop`), {
      method: 'PUT',
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
      body: renderProp(props),
    });
  }

  /** Removes both halves of the pair. Missing files are not an error. */
  async remove(key: string): Promise<void> {
    for (const suffix of ['.zip', '.prop']) {
      await this.send(this.url(`${key}${suffix}`), { method: 'DELETE' }, [404]);
    }
  }
}
