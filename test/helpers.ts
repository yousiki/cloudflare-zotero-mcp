import type { FetchLike } from '../src/core/http.js';

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  /** Binary request bodies, kept intact for archive assertions. */
  binaryBody?: Uint8Array;
}

export interface StubRoute {
  /** Matched against `METHOD path?query` (the origin is stripped). */
  match: (request: RecordedRequest) => boolean;
  respond: (request: RecordedRequest) => Response | Promise<Response>;
}

export interface FetchStub {
  fetch: FetchLike;
  requests: RecordedRequest[];
}

/** Builds a `fetch` that answers from `routes` and records every call. */
export function stubFetch(routes: StubRoute[]): FetchStub {
  const requests: RecordedRequest[] = [];

  const fetchImpl: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const binaryBody = init?.body instanceof Uint8Array ? init.body : undefined;
    const body = typeof init?.body === 'string' ? init.body : undefined;

    const request: RecordedRequest = {
      url: input,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers,
      body,
      binaryBody,
    };
    requests.push(request);

    const route = routes.find((candidate) => candidate.match(request));
    if (!route) {
      return new Response(`no stub for ${request.method} ${request.url}`, { status: 501 });
    }
    return route.respond(request);
  };

  return { fetch: fetchImpl, requests };
}

export function pathOf(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname + parsed.search;
}

export function route(
  method: string,
  pathPrefix: string,
  respond: StubRoute['respond'],
): StubRoute {
  return {
    match: (request) => request.method === method && pathOf(request.url).startsWith(pathPrefix),
    respond,
  };
}

export function jsonResponse(
  body: unknown,
  init: ResponseInit & { version?: number } = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (init.version !== undefined) headers.set('Last-Modified-Version', String(init.version));
  return new Response(JSON.stringify(body), { ...init, headers });
}
