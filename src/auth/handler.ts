import {
  AuthorizationError,
  type AuthRequest,
  type ClientInfo,
} from '@cloudflare/workers-oauth-provider';
import { ALL_SCOPES, SCOPE_READ, SCOPE_WRITE } from '../context.js';
import type { Env } from '../env.js';

/** Props carried on every access token and surfaced to the MCP handler. */
export interface AuthProps {
  userId: string;
  scopes: string[];
}

const LOGIN_WINDOW_SECONDS = 900;
const MAX_ATTEMPTS = 8;

/**
 * Everything that is not the MCP API: the landing page, a health probe, and the
 * password-gated authorization screen.
 *
 * This is a single-tenant server — the operator's own Zotero credentials live in
 * Worker secrets — so "logging in" only proves you are the operator.
 */
export const authorizationHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '') return htmlResponse(landingPage(url));
    if (url.pathname === '/health') return healthPage(env);
    if (url.pathname !== '/authorize') return new Response('Not found', { status: 404 });

    let oauthRequest: AuthRequest;
    try {
      oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    } catch (error) {
      return authorizationErrorResponse(error);
    }

    const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
    if (!client) return htmlResponse(errorPage('Unknown OAuth client.'), 400);

    if (request.method === 'GET') {
      return htmlResponse(loginPage(client, oauthRequest, url, null));
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });
    }

    if (!env.AUTH_PASSWORD) {
      return htmlResponse(
        errorPage('AUTH_PASSWORD is not configured. Run: wrangler secret put AUTH_PASSWORD'),
        500,
      );
    }

    const form = await request.formData();
    const attemptKey = `login-attempts:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}`;
    const attempts = Number((await env.CACHE_KV.get(attemptKey)) ?? 0);
    if (attempts >= MAX_ATTEMPTS) {
      return htmlResponse(errorPage('Too many failed sign-in attempts. Try again later.'), 429);
    }

    const password = String(form.get('password') ?? '');
    if (!(await constantTimeEqual(password, env.AUTH_PASSWORD))) {
      await env.CACHE_KV.put(attemptKey, String(attempts + 1), {
        expirationTtl: LOGIN_WINDOW_SECONDS,
      });
      // Slow brute force down without holding the isolate for long.
      await new Promise((resolve) => setTimeout(resolve, 400 + attempts * 300));
      return htmlResponse(loginPage(client, oauthRequest, url, 'Incorrect password.'), 401);
    }
    await env.CACHE_KV.delete(attemptKey);

    const granted = grantedScopes(oauthRequest, form.getAll('scope').map(String));
    const props: AuthProps = { userId: env.AUTH_USERNAME || 'owner', scopes: granted };

    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthRequest,
      userId: props.userId,
      metadata: { clientName: client.clientName ?? oauthRequest.clientId },
      scope: granted,
      props,
    });

    // 303 so the browser follows with GET; 302 after a POST is only GET by
    // convention, not by spec.
    return Response.redirect(redirectTo, 303);
  },
};

/**
 * What this authorization may cover at most: what the client asked for, narrowed
 * to what we implement.
 *
 * A client that omits `scope` has not asked for read-only — it has asked for the
 * server's default (RFC 6749 §3.3). Treating that as read-only made every write
 * tool permanently unreachable for such clients, because the consent page only
 * offers what was requested: Claude Code sends no `scope`, so its tokens came
 * back `zotero:read` and nothing on the page could opt in. So an absent `scope`
 * offers everything and the checkboxes decide.
 */
function offeredScopes(oauthRequest: AuthRequest): string[] {
  if (oauthRequest.scope.length === 0) return [...ALL_SCOPES];
  return oauthRequest.scope.filter((scope) => (ALL_SCOPES as readonly string[]).includes(scope));
}

/** Never grant more than is on offer, and never more than was ticked. */
function grantedScopes(oauthRequest: AuthRequest, checked: string[]): string[] {
  const offered = offeredScopes(oauthRequest);
  // Every offered scope gets a checkbox, so nothing ticked means the operator
  // unticked them all. Honour that as least privilege rather than as "default".
  const chosen = offered.filter((scope) => checked.includes(scope));
  return chosen.length > 0 ? chosen : [SCOPE_READ];
}

async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  // Hashing first makes the comparison length-independent as well as timing-safe.
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  const x = new Uint8Array(left);
  const y = new Uint8Array(right);
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= (x[i] as number) ^ (y[i] as number);
  return difference === 0;
}

function authorizationErrorResponse(error: unknown): Response {
  if (!(error instanceof AuthorizationError)) throw error;
  if (!error.redirectUri) {
    return htmlResponse(errorPage(error.description ?? 'Invalid authorization request.'), 400);
  }
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set('error', error.code);
  if (error.description) redirect.searchParams.set('error_description', error.description);
  if (error.state) redirect.searchParams.set('state', error.state);
  if (error.issuer) redirect.searchParams.set('iss', error.issuer);
  return Response.redirect(redirect.toString(), 303);
}

/* -------------------------------------------------------------------------- */
/* Pages                                                                       */
/* -------------------------------------------------------------------------- */

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      // No form-action: browsers apply it to the *redirect* that follows a form
      // submission, and OAuth redirect URIs are cross-origin by definition
      // (Claude Code listens on http://localhost:<port>/callback). Including it
      // silently strands the user on the approval page.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}

const STYLE = `
  :root { color-scheme: light dark; --fg: #16181d; --bg: #fbfbfd; --muted: #667; --line: #d8d8e0; --accent: #3b5bdb; }
  @media (prefers-color-scheme: dark) {
    :root { --fg: #e8e8ed; --bg: #14161a; --muted: #99a; --line: #2c2f36; --accent: #748ffc; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 3rem 1.25rem; background: var(--bg); color: var(--fg);
         font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 34rem; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  p.sub { color: var(--muted); margin: 0 0 1.75rem; }
  .card { border: 1px solid var(--line); border-radius: 12px; padding: 1.5rem; background: color-mix(in srgb, var(--bg) 92%, var(--fg)); }
  label { display: block; font-weight: 600; margin: 0 0 .4rem; }
  input[type=password] { width: 100%; padding: .65rem .75rem; font-size: 1rem; border-radius: 8px;
    border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
  .scopes { margin: 1.25rem 0; display: grid; gap: .5rem; }
  .scopes label { font-weight: 400; display: flex; gap: .55rem; align-items: flex-start; }
  button { margin-top: .5rem; width: 100%; padding: .7rem 1rem; font-size: 1rem; font-weight: 600;
    border: 0; border-radius: 8px; background: var(--accent); color: #fff; cursor: pointer; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
  .err { color: #c92a2a; margin: 0 0 1rem; font-weight: 600; }
  .meta { color: var(--muted); font-size: .875rem; margin-top: 1.5rem; }
`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

function loginPage(
  client: ClientInfo,
  oauthRequest: AuthRequest,
  url: URL,
  error: string | null,
): string {
  const clientName = escapeHtml(client.clientName ?? oauthRequest.clientId);
  const offered = offeredScopes(oauthRequest);
  const scopeRow = (scope: string, description: string): string =>
    offered.includes(scope)
      ? `<label><input type="checkbox" name="scope" value="${scope}" checked><span><code>${scope}</code> — ${description}</span></label>`
      : '';
  const note =
    oauthRequest.scope.length === 0
      ? `<p class="meta">${clientName} did not name the access it wants, so both are offered.
           Untick <code>${SCOPE_WRITE}</code> to keep this token read-only.</p>`
      : '';

  return page(
    'Authorize access to your Zotero library',
    `<h1>Authorize <em>${clientName}</em></h1>
     <p class="sub">It is asking to connect to your Zotero library through this server.</p>
     <div class="card">
       ${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
       <form method="post" action="${escapeHtml(url.pathname + url.search)}">
         <label for="password">Server password</label>
         <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
         <div class="scopes">
           ${scopeRow(SCOPE_READ, 'read items, collections, notes and attachment text')}
           ${scopeRow(SCOPE_WRITE, 'create, edit and delete items and attachment files')}
         </div>
         ${note}
         <button type="submit">Approve</button>
       </form>
       <p class="meta">Redirects to <code>${escapeHtml(oauthRequest.redirectUri)}</code></p>
     </div>`,
  );
}

function errorPage(message: string): string {
  return page(
    'Authorization error',
    `<h1>Authorization error</h1><p class="err">${escapeHtml(message)}</p>`,
  );
}

function landingPage(url: URL): string {
  const endpoint = `${url.origin}/mcp`;
  return page(
    'Zotero MCP server',
    `<h1>Zotero MCP server</h1>
     <p class="sub">A remote Model Context Protocol server for a Zotero library with WebDAV file storage.</p>
     <div class="card">
       <p>Add this endpoint to your MCP client:</p>
       <p><code>${escapeHtml(endpoint)}</code></p>
       <p class="meta">The client will walk you through OAuth. Connecting needs the server password.</p>
     </div>`,
  );
}

async function healthPage(env: Env): Promise<Response> {
  const checks = {
    zoteroApiKey: Boolean(env.ZOTERO_API_KEY),
    webdav: Boolean(env.WEBDAV_URL && env.WEBDAV_USERNAME && env.WEBDAV_PASSWORD),
    authPassword: Boolean(env.AUTH_PASSWORD),
    vectorize: Boolean(env.VECTORIZE && env.AI),
  };
  const ok = checks.zoteroApiKey && checks.authPassword;
  return Response.json(
    { ok, checks },
    { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
