import { describe, expect, mock, test } from 'bun:test';
import type { Env } from '../src/env.js';

// The OAuth provider package reaches for the workerd-only `cloudflare:workers`
// module at import time, which bun cannot resolve. The handler itself only
// needs the runtime to exist, not to work.
mock.module('cloudflare:workers', () => ({ WorkerEntrypoint: class {} }));
const { authorizationHandler } = await import('../src/auth/handler.js');

const CLIENT_REDIRECT = 'http://localhost:57321/callback';

const AUTH_REQUEST = {
  responseType: 'code',
  clientId: 'client-123',
  redirectUri: CLIENT_REDIRECT,
  scope: ['zotero:read', 'zotero:write'],
  state: 'xyz',
};

/** A client that sends no `scope` parameter, the way Claude Code does. */
const noScopeProvider = {
  parseAuthRequest: async () => ({ ...AUTH_REQUEST, scope: [] }),
  lookupClient: async () => ({ clientId: 'client-123', clientName: 'Claude Code' }),
};

class FakeKv {
  readonly store = new Map<string, string>();
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.store.set(key, value);
  }
  async delete(key: string) {
    this.store.delete(key);
  }
}

function fakeEnv(overrides: Partial<Env> = {}): {
  env: Env;
  granted: { scope?: string[] };
  kv: FakeKv;
} {
  const granted: { scope?: string[] } = {};
  const kv = new FakeKv();
  const env = {
    AUTH_PASSWORD: 'correct horse battery staple',
    CACHE_KV: kv as unknown as KVNamespace,
    ZOTERO_API_KEY: 'k',
    OAUTH_PROVIDER: {
      parseAuthRequest: async () => AUTH_REQUEST,
      lookupClient: async () => ({ clientId: 'client-123', clientName: 'Claude Code' }),
      completeAuthorization: async (options: { scope: string[] }) => {
        granted.scope = options.scope;
        return { redirectTo: `${CLIENT_REDIRECT}?code=abc&state=xyz` };
      },
    },
    ...overrides,
  } as unknown as Env;
  return { env, granted, kv };
}

const authorizeUrl =
  'https://zotero-mcp.example.com/authorize?response_type=code&client_id=client-123';

function approvalRequest(password: string, scopes: string[] = ['zotero:read', 'zotero:write']) {
  const form = new URLSearchParams({ password });
  for (const scope of scopes) form.append('scope', scope);
  return new Request(authorizeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'CF-Connecting-IP': '203.0.113.1',
    },
    body: form,
  });
}

const handle = (request: Request, env: Env) =>
  (authorizationHandler.fetch as (r: Request, e: Env, c: ExecutionContext) => Promise<Response>)(
    request,
    env,
    {} as ExecutionContext,
  );

describe('authorization page', () => {
  test('renders a login form for GET', async () => {
    const { env } = fakeEnv();
    const response = await handle(new Request(authorizeUrl), env);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('type="password"');
    expect(body).toContain('Claude Code');
    expect(body).toContain('zotero:write');
  });

  test('never sets form-action, which would block the OAuth redirect', async () => {
    const { env } = fakeEnv();
    const response = await handle(new Request(authorizeUrl), env);

    // Browsers apply form-action to the redirect that follows a form POST, so
    // including it strands the user on this page instead of returning the code.
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    expect(csp).not.toContain('form-action');
    expect(csp).toContain("default-src 'none'");
  });

  test('redirects to the client with 303 once the password checks out', async () => {
    const { env, granted } = fakeEnv();
    const response = await handle(approvalRequest('correct horse battery staple'), env);

    // 303 makes the browser follow with GET; 302 after POST is convention only.
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe(`${CLIENT_REDIRECT}?code=abc&state=xyz`);
    expect(granted.scope).toEqual(['zotero:read', 'zotero:write']);
  });

  test('grants only the scopes left ticked', async () => {
    const { env, granted } = fakeEnv();
    await handle(approvalRequest('correct horse battery staple', ['zotero:read']), env);
    expect(granted.scope).toEqual(['zotero:read']);
  });

  test('offers write when the client names no scope at all', async () => {
    // Claude Code omits `scope`. Reading that as "read-only" left every write
    // tool unreachable, with no checkbox on the page to opt in.
    const { env, granted } = fakeEnv({
      OAUTH_PROVIDER: {
        ...noScopeProvider,
        completeAuthorization: async (options: { scope: string[] }) => {
          granted.scope = options.scope;
          return { redirectTo: `${CLIENT_REDIRECT}?code=abc` };
        },
      },
    } as unknown as Partial<Env>);

    const page = await (await handle(new Request(authorizeUrl), env)).text();
    expect(page).toContain('value="zotero:write"');
    expect(page).toContain('did not name the access it wants');

    await handle(approvalRequest('correct horse battery staple'), env);
    expect(granted.scope).toEqual(['zotero:read', 'zotero:write']);
  });

  test('unticking everything yields read-only, not the default', async () => {
    const { env, granted } = fakeEnv();
    await handle(approvalRequest('correct horse battery staple', []), env);
    expect(granted.scope).toEqual(['zotero:read']);
  });

  test('never grants a scope the client did not request', async () => {
    const { env, granted } = fakeEnv();
    await handle(
      approvalRequest('correct horse battery staple', ['zotero:read', 'zotero:admin']),
      env,
    );
    expect(granted.scope).toEqual(['zotero:read']);
  });

  test('rejects a wrong password without redirecting', async () => {
    const { env, granted } = fakeEnv();
    const response = await handle(approvalRequest('hunter2'), env);

    expect(response.status).toBe(401);
    expect(await response.text()).toContain('Incorrect password');
    expect(granted.scope).toBeUndefined();
  });

  test('locks out once the failure count is spent', async () => {
    // Seeded rather than driven through eight real attempts: each failure
    // deliberately sleeps longer than the last, which is the point of the
    // counter but would make this test take ~12s.
    const { env, kv, granted } = fakeEnv();
    kv.store.set('login-attempts:203.0.113.1', '8');

    const response = await handle(approvalRequest('correct horse battery staple'), env);

    expect(response.status).toBe(429);
    expect(await response.text()).toContain('Too many failed sign-in attempts');
    // Even the right password must not get through while locked out.
    expect(granted.scope).toBeUndefined();
  });

  test('clears the failure count after a successful sign-in', async () => {
    const { env, kv } = fakeEnv();
    kv.store.set('login-attempts:203.0.113.1', '3');

    await handle(approvalRequest('correct horse battery staple'), env);

    expect(kv.store.has('login-attempts:203.0.113.1')).toBe(false);
  });

  test('serves health without leaking secret values', async () => {
    const { env } = fakeEnv();
    const response = await handle(new Request('https://zotero-mcp.example.com/health'), env);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('"authPassword":true');
    expect(body).not.toContain('correct horse battery staple');
  });
});
